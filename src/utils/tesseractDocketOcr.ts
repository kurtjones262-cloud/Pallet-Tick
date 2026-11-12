import { createWorker, OEM, PSM } from 'tesseract.js';
import {
  ExtractedDocketResult,
  TesseractDiagnosticOutcomeCode,
  TesseractDiagnosticStageEvent,
  TesseractPipelineDiagnostics,
} from '../server/docketOcr';
import { SupplierRuleId } from '../types/delivery';
import {
  RawOcrLine,
  RawOcrWord,
  DocketValidationReport,
  groupPositionedWordsIntoLines,
  parseIndustrialDocketText,
  combineMultiPageDocketResults,
  validateDocketExtractionQuality,
  mergeComplementaryParsedItems,
} from './docketParser';
import { preprocessDocketImage, normalizeDocumentLuminances } from './imagePreprocessing';
import type { OcrProgressUpdate, PageTextHint } from './offlineOcr';

export interface CachedTesseractPageOcr {
  pageHash: string;
  lines: RawOcrLine[];
  ocrOnlyLines?: RawOcrLine[];
  pdfSelectableLines?: RawOcrLine[];
  rawText: string;
  meanConfidence: number;
  preprocessDurationMs: number;
  workerInitDurationMs: number;
  ocrDurationMs: number;
  wordsCount: number;
  recognizeCalled: boolean;
  sourceKind: 'tesseract-image' | 'tesseract-plus-pdf-layout';
}

export interface TesseractDocketExtractionResult {
  extractedData: ExtractedDocketResult;
  validationReport: DocketValidationReport;
  diagnostics: TesseractPipelineDiagnostics;
  processedPages: Array<{
    pageNumber: number;
    originalDataUrl: string;
    preprocessedDataUrl: string;
    width: number;
    height: number;
    fromCache: boolean;
    preprocessDurationMs: number;
    workerInitDurationMs: number;
    ocrDurationMs: number;
    meanConfidence: number;
    lineCount: number;
    wordCount: number;
  }>;
  metrics: {
    totalTimeMs: number;
    preprocessTimeMs: number;
    workerInitTimeMs: number;
    ocrTimeMs: number;
    parseTimeMs: number;
    pagesProcessed: number;
    pagesFromCache: number;
  };
}

export interface WorkerAssetDiagnosticState {
  workerInitialised: boolean;
  workerScriptLoaded: boolean;
  wasmCoreLoaded: boolean;
  trainedDataLoaded: boolean;
  initDurationMs: number;
  lastInitError?: string;
}

export type DocketTesseractWorkerFactory = (
  langs: string,
  oem: number,
  options?: any
) => Promise<any>;

const MAX_PAGE_CACHE_ENTRIES = 64;
const pageOcrCache = new Map<string, CachedTesseractPageOcr>();

let warmDocketTesseractWorkerPromise: Promise<any> | null = null;
let customWorkerFactoryForTesting: DocketTesseractWorkerFactory | null = null;
let activeDocketProgressHook: ((progressRatio: number) => void) | null = null;
let workerAssetState: WorkerAssetDiagnosticState = {
  workerInitialised: false,
  workerScriptLoaded: false,
  wasmCoreLoaded: false,
  trainedDataLoaded: false,
  initDurationMs: 0,
};

/**
 * Allows automated regression tests to inject a custom worker factory to simulate
 * worker initialization failures, language traineddata failures, recognition failures,
 * or malformed `GetJSONText` block JSON responses.
 */
export function setDocketTesseractWorkerFactoryForTesting(
  factory: DocketTesseractWorkerFactory | null
): void {
  customWorkerFactoryForTesting = factory;
  warmDocketTesseractWorkerPromise = null;
  workerAssetState = {
    workerInitialised: false,
    workerScriptLoaded: false,
    wasmCoreLoaded: false,
    trainedDataLoaded: false,
    initDurationMs: 0,
  };
}

/**
 * Returns the current diagnostic state of the Tesseract worker and its required static assets.
 */
export function getTesseractWorkerDiagnosticState(): WorkerAssetDiagnosticState {
  return { ...workerAssetState };
}

/**
 * Computes a fast deterministic hash of a page's image dataUrl/Buffer and optional text hint
 * so identical pages are never OCR-processed more than once.
 */
export function computeDocketPageHash(
  imageSource: string | Uint8Array | Buffer,
  textHint?: PageTextHint
): string {
  let str = '';
  if (typeof imageSource === 'string') {
    const len = imageSource.length;
    const step = Math.max(1, Math.floor(len / 512));
    const chars: string[] = [`len:${len}:`];
    for (let i = 0; i < len; i += step) {
      chars.push(imageSource[i]);
    }
    str = chars.join('');
  } else {
    const bytes = imageSource instanceof Uint8Array ? imageSource : new Uint8Array(imageSource);
    const len = bytes.byteLength;
    const step = Math.max(1, Math.floor(len / 512));
    const parts: number[] = [len];
    for (let i = 0; i < len; i += step) {
      parts.push(bytes[i]);
    }
    str = parts.join(',');
  }

  if (textHint?.rawText) {
    str += `|pdf:${textHint.rawText.length}:${textHint.rawText.slice(0, 240)}`;
  } else if (textHint?.selectableLines?.length) {
    str += `|pdflines:${textHint.selectableLines.length}:${textHint.selectableLines[0]?.text?.slice(0, 80) || ''}`;
  }

  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code;
    h2 = Math.imul(h2, 0x811c9dc5);
  }
  return `pg_${(h1 >>> 0).toString(16)}_${(h2 >>> 0).toString(16)}`;
}

/**
 * Clears the in-memory page OCR cache (useful for deterministic benchmark testing).
 */
export function clearDocketOcrPageCache(): void {
  pageOcrCache.clear();
}

/**
 * Returns current number of cached pages in the Tesseract docket cache.
 */
export function getDocketOcrCacheSize(): number {
  return pageOcrCache.size;
}

/**
 * Pre-flight checks that worker.min.js, WASM core files, and eng.traineddata.gz are reachable
 * and not returning an HTML SPA fallback.
 */
async function verifyTesseractAssetsReachable(): Promise<{
  workerScriptLoaded: boolean;
  wasmCoreLoaded: boolean;
  trainedDataLoaded: boolean;
  detail: string;
}> {
  const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';

  if (!isBrowser) {
    try {
      const fsMod = await import('fs');
      const pathMod = await import('path');
      const rootDir = process.cwd();
      const workerOk = fsMod.existsSync(pathMod.resolve(rootDir, 'public/tesseract/worker.min.js'));
      const wasmOk =
        fsMod.existsSync(pathMod.resolve(rootDir, 'public/tesseract/core/tesseract-core-simd-lstm.wasm')) &&
        fsMod.existsSync(pathMod.resolve(rootDir, 'public/tesseract/core/tesseract-core-lstm.wasm')) &&
        fsMod.existsSync(pathMod.resolve(rootDir, 'public/tesseract/core/tesseract-core.wasm'));
      const langOk = fsMod.existsSync(
        pathMod.resolve(rootDir, 'public/tesseract/lang-data/eng.traineddata.gz')
      );
      return {
        workerScriptLoaded: workerOk,
        wasmCoreLoaded: wasmOk,
        trainedDataLoaded: langOk,
        detail: `Node local assets verified (worker.min.js=${workerOk}, wasm=${wasmOk}, eng.traineddata.gz=${langOk})`,
      };
    } catch (err: any) {
      return {
        workerScriptLoaded: false,
        wasmCoreLoaded: false,
        trainedDataLoaded: false,
        detail: `Asset check error: ${err?.message || String(err)}`,
      };
    }
  }

  const origin = window.location?.origin || '';
  const checkAsset = async (path: string): Promise<{ ok: boolean; status: number; contentType: string }> => {
    try {
      const res = await fetch(`${origin}${path}`, { method: 'HEAD', cache: 'no-cache' });
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      // Reject if server returned an HTML SPA fallback for a JS/WASM/GZ asset
      const isHtmlFallback = ct.includes('text/html');
      return {
        ok: res.ok && !isHtmlFallback,
        status: res.status,
        contentType: ct,
      };
    } catch {
      return { ok: false, status: 0, contentType: 'network-error' };
    }
  };

  const [workerCheck, wasmJsCheck, wasmBinCheck, langCheck] = await Promise.all([
    checkAsset('/tesseract/worker.min.js'),
    checkAsset('/tesseract/core/tesseract-core-simd-lstm.wasm.js'),
    checkAsset('/tesseract/core/tesseract-core-simd-lstm.wasm'),
    checkAsset('/tesseract/lang-data/eng.traineddata.gz'),
  ]);

  const workerOk = workerCheck.ok;
  const wasmOk = wasmJsCheck.ok && wasmBinCheck.ok;
  const langOk = langCheck.ok;

  return {
    workerScriptLoaded: workerOk,
    wasmCoreLoaded: wasmOk,
    trainedDataLoaded: langOk,
    detail: `Browser assets verified: worker.min.js=${workerOk} (${workerCheck.status} ${workerCheck.contentType}), wasm=${wasmOk} (${wasmBinCheck.status} ${wasmBinCheck.contentType}), eng.traineddata.gz=${langOk} (${langCheck.status} ${langCheck.contentType})`,
  };
}

/**
 * Initializes or returns the warm Tesseract.js LSTM worker for docket extraction.
 * - Never passes a non-throwing errorHandler to createWorker (which would suppress rejected promises).
 * - Propagates worker initialization and language loading failures properly.
 * - Clears stale IndexedDB worker cache ONLY when recovering from an initialization failure.
 */
export async function getOrInitDocketTesseractWorker(
  onStageEvent?: (event: { status: string; progress: number }) => void
): Promise<any> {
  if (warmDocketTesseractWorkerPromise) {
    return warmDocketTesseractWorkerPromise;
  }

  const initStartMs = performance.now();
  const createWorkerFn: DocketTesseractWorkerFactory =
    customWorkerFactoryForTesting || (createWorker as any);

  warmDocketTesseractWorkerPromise = (async () => {
    const isBrowser =
      typeof window !== 'undefined' &&
      typeof window.document !== 'undefined' &&
      !customWorkerFactoryForTesting;

    const assetCheck = await verifyTesseractAssetsReachable();
    workerAssetState.workerScriptLoaded = assetCheck.workerScriptLoaded;
    workerAssetState.wasmCoreLoaded = assetCheck.wasmCoreLoaded;
    workerAssetState.trainedDataLoaded = assetCheck.trainedDataLoaded;
    workerAssetState.lastInitError = undefined;

    const loggerFn = (m: any) => {
      if (!m || typeof m !== 'object') return;
      const status = String(m.status || '');
      const prog = Number(m.progress) || 0;

      if (status.includes('loading tesseract core')) {
        workerAssetState.workerScriptLoaded = true;
        if (prog >= 1) workerAssetState.wasmCoreLoaded = true;
      } else if (status.includes('initializing tesseract')) {
        if (prog >= 1) workerAssetState.wasmCoreLoaded = true;
      } else if (status.includes('loading language traineddata')) {
        if (prog >= 1) workerAssetState.trainedDataLoaded = true;
      } else if (status.includes('initializing api')) {
        if (prog >= 1) workerAssetState.workerInitialised = true;
      } else if (status === 'recognizing text' && activeDocketProgressHook) {
        activeDocketProgressHook(prog);
      }

      onStageEvent?.({ status, progress: prog });
    };

    if (isBrowser) {
      const origin = window.location?.origin || '';

      try {
        // IMPORTANT: Do NOT pass a non-throwing errorHandler to createWorker in tesseract.js v7,
        // because createWorker.js suppresses promise rejection on loadLanguage/initialize if errorHandler is defined.
        const worker = await createWorkerFn('eng', OEM.LSTM_ONLY, {
          workerPath: assetCheck.workerScriptLoaded
            ? `${origin}/tesseract/worker.min.js`
            : undefined,
          workerBlobURL: false,
          corePath: assetCheck.wasmCoreLoaded ? `${origin}/tesseract/core` : undefined,
          langPath: assetCheck.trainedDataLoaded ? `${origin}/tesseract/lang-data` : undefined,
          gzip: true,
          cacheMethod: 'none',
          logger: loggerFn,
        });
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
          preserve_interword_spaces: '1',
        });
        workerAssetState.workerInitialised = true;
        workerAssetState.workerScriptLoaded = true;
        workerAssetState.wasmCoreLoaded = true;
        workerAssetState.trainedDataLoaded = true;
        workerAssetState.initDurationMs = Math.round(performance.now() - initStartMs);
        return worker;
      } catch (firstErr: any) {
        console.warn(
          '[PartTrack Docket Tesseract] Primary worker init failed, clearing stale IndexedDB cache and retrying with blob URL fallback:',
          firstErr?.message || String(firstErr)
        );
        // Clear stale/corrupted IndexedDB keyval-store entries ONLY when recovering from an init error
        if ('indexedDB' in window) {
          try {
            window.indexedDB.deleteDatabase('keyval-store');
          } catch {
            // Ignore IndexedDB cleanup errors
          }
        }

        const fallbackWorker = await createWorkerFn('eng', OEM.LSTM_ONLY, {
          workerPath: `${origin}/tesseract/worker.min.js`,
          workerBlobURL: true,
          corePath: `${origin}/tesseract/core`,
          langPath: `${origin}/tesseract/lang-data`,
          gzip: true,
          cacheMethod: 'none',
          logger: loggerFn,
        });
        await fallbackWorker.setParameters({
          tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
          preserve_interword_spaces: '1',
        });
        workerAssetState.workerInitialised = true;
        workerAssetState.workerScriptLoaded = true;
        workerAssetState.wasmCoreLoaded = true;
        workerAssetState.trainedDataLoaded = true;
        workerAssetState.initDurationMs = Math.round(performance.now() - initStartMs);
        return fallbackWorker;
      }
    } else {
      // Node.js runtime or injected test factory
      const pathMod = await import('path');
      const localLangPath = pathMod.resolve(process.cwd(), 'public/tesseract/lang-data');
      const nodeWorker = await createWorkerFn('eng', OEM.LSTM_ONLY, {
        langPath: localLangPath,
        gzip: true,
        cacheMethod: 'none',
        logger: loggerFn,
      });
      if (typeof nodeWorker?.setParameters === 'function') {
        await nodeWorker.setParameters({
          tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
          preserve_interword_spaces: '1',
        });
      }
      workerAssetState.workerInitialised = true;
      workerAssetState.workerScriptLoaded = true;
      workerAssetState.wasmCoreLoaded = true;
      workerAssetState.trainedDataLoaded = true;
      workerAssetState.initDurationMs = Math.round(performance.now() - initStartMs);
      return nodeWorker;
    }
  })().catch((err: any) => {
    const errMsg = err?.message || String(err || 'Tesseract worker initialization failed');
    workerAssetState.workerInitialised = false;
    if (errMsg.toLowerCase().includes('traineddata') || errMsg.toLowerCase().includes('lang')) {
      workerAssetState.trainedDataLoaded = false;
    }
    workerAssetState.lastInitError = errMsg;
    workerAssetState.initDurationMs = Math.round(performance.now() - initStartMs);
    warmDocketTesseractWorkerPromise = null;
    throw err instanceof Error ? err : new Error(errMsg);
  });

  return warmDocketTesseractWorkerPromise;
}

/**
 * Terminates the warm docket Tesseract worker safely and resets cached worker state
 * so subsequent calls cleanly reinitialize a fresh worker.
 */
export async function terminateDocketTesseractWorker(): Promise<void> {
  const existingPromise = warmDocketTesseractWorkerPromise;
  warmDocketTesseractWorkerPromise = null;
  workerAssetState.workerInitialised = false;
  if (!existingPromise) return;
  try {
    const worker = await existingPromise;
    if (worker && typeof worker.terminate === 'function') {
      await worker.terminate();
    }
  } catch {
    // Ignore termination errors on already-failed workers
  }
}

/**
 * Parses Tesseract TSV output (`api.GetTSVText()`) into positioned words with bounding boxes.
 * TSV is immune to `JSON.parse(api.GetJSONText())` syntax errors on quotes/backslashes in Tesseract v7.
 */
export function parseTsvToPositionedWords(tsvText: string): RawOcrWord[] {
  if (!tsvText || typeof tsvText !== 'string') return [];
  const words: RawOcrWord[] = [];
  const rows = tsvText.split(/\r?\n/);
  // TSV columns: level(0) page_num(1) block_num(2) par_num(3) line_num(4) word_num(5) left(6) top(7) width(8) height(9) conf(10) text(11)
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i].split('\t');
    if (cols.length < 12) continue;
    const level = parseInt(cols[0], 10);
    if (level !== 5) continue; // level 5 = word
    const txt = cols.slice(11).join(' ').trim();
    if (!txt) continue;
    const left = parseInt(cols[6], 10) || 0;
    const top = parseInt(cols[7], 10) || 0;
    const width = parseInt(cols[8], 10) || txt.length * 8;
    const height = parseInt(cols[9], 10) || 14;
    const conf = parseFloat(cols[10]);
    words.push({
      text: txt,
      confidence: Number.isFinite(conf) && conf >= 0 ? conf : 80,
      bbox: {
        x0: left,
        y0: top,
        x1: left + Math.max(1, width),
        y1: top + Math.max(1, height),
      },
    });
  }
  return words;
}

/**
 * Checks if an imageSource has a real decodable image payload (rather than a short synthetic test stub string).
 */
function hasRealImagePayload(imageSource: string | File | Buffer | Uint8Array): boolean {
  if (typeof imageSource === 'string') {
    const trimmed = imageSource.trim();
    if (trimmed.startsWith('data:image/')) {
      const commaIdx = trimmed.indexOf(',');
      const base64Part = commaIdx >= 0 ? trimmed.slice(commaIdx + 1) : '';
      return base64Part.length >= 120;
    }
    return trimmed.length >= 120;
  }
  if (typeof File !== 'undefined' && imageSource instanceof File) {
    return imageSource.size > 64;
  }
  if (imageSource instanceof Uint8Array || Buffer.isBuffer(imageSource)) {
    return imageSource.byteLength > 64;
  }
  return false;
}

/**
 * Applies the exact same document luminance normalization to uncompressed 24-bit BMP buffers/dataUrls in Node
 * so Node verification tests exercise the exact same pixel preprocessing pipeline as Browser canvas.
 */
function normalizeBmpDataUrlInNodeIfApplicable(dataUrl: string): {
  normalizedDataUrl: string;
  pLow?: number;
  pHigh?: number;
  whiteRatio?: number;
} {
  if (!dataUrl.startsWith('data:image/bmp;base64,')) {
    return { normalizedDataUrl: dataUrl };
  }
  try {
    const b64 = dataUrl.slice('data:image/bmp;base64,'.length);
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 54 || buf.toString('ascii', 0, 2) !== 'BM') {
      return { normalizedDataUrl: dataUrl };
    }
    const pixelOffset = buf.readUInt32LE(10);
    const width = Math.abs(buf.readInt32LE(18));
    const height = Math.abs(buf.readInt32LE(22));
    const bpp = buf.readUInt16LE(28);
    if (bpp !== 24 || width <= 0 || height <= 0) {
      return { normalizedDataUrl: dataUrl };
    }
    const rowStride = Math.ceil((width * 3) / 4) * 4;
    const numPixels = width * height;
    const luminances = new Uint8Array(numPixels);
    const hist = new Uint32Array(256);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const off = pixelOffset + y * rowStride + x * 3;
        if (off + 2 >= buf.length) continue;
        const b = buf[off];
        const g = buf[off + 1];
        const r = buf[off + 2];
        const lum = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
        const idx = y * width + x;
        luminances[idx] = lum;
        hist[lum]++;
      }
    }

    const norm = normalizeDocumentLuminances(luminances, hist);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const off = pixelOffset + y * rowStride + x * 3;
        if (off + 2 >= buf.length) continue;
        const val = norm.output[y * width + x];
        buf[off] = val;
        buf[off + 1] = val;
        buf[off + 2] = val;
      }
    }

    return {
      normalizedDataUrl: `data:image/bmp;base64,${buf.toString('base64')}`,
      pLow: norm.pLow,
      pHigh: norm.pHigh,
      whiteRatio: norm.whitePixelRatioAfter,
    };
  } catch {
    return { normalizedDataUrl: dataUrl };
  }
}

/**
 * Extracts positioned lines and word bounding boxes from a single docket page using Tesseract.js,
 * utilizing the page cache to avoid repeated OCR of identical pages.
 * - Always runs Tesseract on rendered PDF page images (`isRealImage`) even if selectable PDF text is present.
 * - Propagates worker initialization, language loading, and unrecoverable recognition errors.
 */
export async function recognizeDocketPageWithTesseract(
  imageSource: string | File | Buffer | Uint8Array,
  pageNumber: number,
  textHint?: PageTextHint,
  onRecognizeProgress?: (ratio: number) => void,
  recordStage?: (
    stage: string,
    status: 'ok' | 'warn' | 'error',
    detail: string,
    durationMs?: number
  ) => void
): Promise<{
  cachedResult: CachedTesseractPageOcr;
  fromCache: boolean;
  originalDataUrl: string;
  preprocessedDataUrl: string;
  width: number;
  height: number;
  recognizeCalled: boolean;
  recognizeError?: string;
}> {
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
  const prepStartMs = performance.now();

  let originalDataUrl = '';
  let preprocessedDataUrl = '';
  let width = 1600;
  let height = 2200;
  let hashInput: string | Uint8Array | Buffer = '';

  const isRealImage = hasRealImagePayload(imageSource);

  if (isBrowser && isRealImage && (typeof imageSource === 'string' || imageSource instanceof File)) {
    const prep = await preprocessDocketImage(imageSource);
    originalDataUrl = prep.displayDataUrl;
    preprocessedDataUrl = prep.ocrDataUrl;
    width = prep.width;
    height = prep.height;
    hashInput = preprocessedDataUrl;
    recordStage?.(
      `page_${pageNumber}_image_preprocess`,
      'ok',
      `Page ${pageNumber} preprocessed (${width}x${height}, pLow=${prep.diagnostics?.pLow ?? 0}, pHigh=${prep.diagnostics?.pHigh ?? 255}, whiteRatio=${prep.diagnostics?.whitePixelRatioAfter ?? 1})`,
      Math.round(performance.now() - prepStartMs)
    );
  } else if (typeof imageSource === 'string') {
    originalDataUrl = imageSource;
    if (!isBrowser && isRealImage && imageSource.startsWith('data:image/bmp;base64,')) {
      const bmpNorm = normalizeBmpDataUrlInNodeIfApplicable(imageSource);
      preprocessedDataUrl = bmpNorm.normalizedDataUrl;
      recordStage?.(
        `page_${pageNumber}_image_preprocess`,
        'ok',
        `Page ${pageNumber} BMP normalized (pLow=${bmpNorm.pLow}, pHigh=${bmpNorm.pHigh}, whiteRatio=${bmpNorm.whiteRatio})`,
        Math.round(performance.now() - prepStartMs)
      );
    } else {
      preprocessedDataUrl = imageSource;
      recordStage?.(
        `page_${pageNumber}_image_preprocess`,
        isRealImage ? 'ok' : 'warn',
        isRealImage
          ? `Page ${pageNumber} image staged (${imageSource.length} chars)`
          : `Page ${pageNumber} has synthetic stub image (${imageSource.length} chars); textHint selectableLines=${textHint?.selectableLines?.length ?? 0}`,
        Math.round(performance.now() - prepStartMs)
      );
    }
    hashInput = preprocessedDataUrl;
  } else if (imageSource instanceof Uint8Array || Buffer.isBuffer(imageSource)) {
    hashInput = imageSource;
    const base64 = Buffer.from(imageSource).toString('base64');
    originalDataUrl = `data:image/png;base64,${base64}`;
    preprocessedDataUrl = originalDataUrl;

    if (!isBrowser && isRealImage) {
      try {
        const sharpMod = await import('sharp');
        const sharp = (sharpMod.default || sharpMod) as any;
        const buf = Buffer.isBuffer(imageSource) ? imageSource : Buffer.from(imageSource);
        const { data, info } = await sharp(buf).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const clamped = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
        const { preprocessRgbaImageBufferInPlace } = await import('./imagePreprocessing');
        const diag = preprocessRgbaImageBufferInPlace(clamped, info.width, info.height);
        const preprocessedBuf = await sharp(Buffer.from(clamped), {
          raw: { width: info.width, height: info.height, channels: 4 },
        })
          .jpeg({ quality: 92 })
          .toBuffer();
        preprocessedDataUrl = `data:image/jpeg;base64,${preprocessedBuf.toString('base64')}`;
        width = info.width;
        height = info.height;
        hashInput = preprocessedDataUrl;
        recordStage?.(
          `page_${pageNumber}_image_preprocess`,
          'ok',
          `Page ${pageNumber} buffer preprocessed via sharp (${width}x${height}, pLow=${diag.pLow}, pHigh=${diag.pHigh}, whiteRatio=${diag.whitePixelRatioAfter})`,
          Math.round(performance.now() - prepStartMs)
        );
      } catch {
        recordStage?.(
          `page_${pageNumber}_image_preprocess`,
          'ok',
          `Page ${pageNumber} binary buffer staged (${imageSource.byteLength} bytes)`,
          Math.round(performance.now() - prepStartMs)
        );
      }
    } else {
      recordStage?.(
        `page_${pageNumber}_image_preprocess`,
        'ok',
        `Page ${pageNumber} binary buffer staged (${imageSource.byteLength} bytes)`,
        Math.round(performance.now() - prepStartMs)
      );
    }
  }

  const preprocessDurationMs = Math.max(0, Math.round(performance.now() - prepStartMs));

  // If a custom worker factory is active for testing, bypass the page cache so error tests always execute
  const pageHash = computeDocketPageHash(hashInput, textHint);
  const existingCached = !customWorkerFactoryForTesting ? pageOcrCache.get(pageHash) : undefined;
  if (existingCached) {
    onRecognizeProgress?.(1);
    const linesForPage = existingCached.lines.map((l) => ({
      ...l,
      pageNumber,
    }));
    recordStage?.(
      `page_${pageNumber}_cache_hit`,
      'ok',
      `Page ${pageNumber} retrieved from pageOcrCache (${linesForPage.length} lines, ${existingCached.wordsCount} words)`,
      0
    );
    return {
      cachedResult: {
        ...existingCached,
        lines: linesForPage,
      },
      fromCache: true,
      originalDataUrl,
      preprocessedDataUrl,
      width,
      height,
      recognizeCalled: existingCached.recognizeCalled,
    };
  }

  let extractedLines: RawOcrLine[] = [];
  let ocrOnlyLines: RawOcrLine[] = [];
  let pdfSelectableLines: RawOcrLine[] | undefined;
  let sourceKind: CachedTesseractPageOcr['sourceKind'] = 'tesseract-image';
  let defaultDataConfidence = 80;
  let recognizeCalled = false;
  let recognizeError: string | undefined;
  let totalWordsRecognized = 0;
  let workerInitDurationMs = 0;
  let ocrDurationMs = 0;

  // 1. ALWAYS run Tesseract.js LSTM OCR when a real decodable image or rendered PDF page image is present
  // (or when a test worker factory is injected)
  if (isRealImage || customWorkerFactoryForTesting) {
    const workerInitStartMs = performance.now();
    const worker = await getOrInitDocketTesseractWorker();
    workerInitDurationMs = Math.max(0, Math.round(performance.now() - workerInitStartMs));
    recordStage?.(
      `page_${pageNumber}_worker_ready`,
      'ok',
      `Tesseract LSTM worker ready (worker.min.js=${workerAssetState.workerScriptLoaded}, wasm=${workerAssetState.wasmCoreLoaded}, eng.traineddata.gz=${workerAssetState.trainedDataLoaded})`,
      workerInitDurationMs
    );

    activeDocketProgressHook = onRecognizeProgress || null;
    let recognitionOutput: any = null;
    const recStartMs = performance.now();

    try {
      const targetForTesseract = preprocessedDataUrl || imageSource;
      recognizeCalled = true;
      try {
        recognitionOutput = await worker.recognize(
          targetForTesseract,
          {},
          { text: true, tsv: true, blocks: true }
        );
      } catch (blocksErr: any) {
        // In tesseract.js v7, `blocks: true` runs `JSON.parse(api.GetJSONText())` inside the worker,
        // which can throw a SyntaxError if OCR text contains unescaped quotes or backslashes.
        // Report the actual error in diagnostics and retry with `{ text: true, tsv: true }`.
        recordStage?.(
          `page_${pageNumber}_recognize_blocks_retry`,
          'warn',
          `Retrying worker.recognize with TSV+UTF8 output after GetJSONText error: ${blocksErr?.message || String(blocksErr)}`
        );
        recognitionOutput = await worker.recognize(
          targetForTesseract,
          {},
          { text: true, tsv: true }
        );
      }
      ocrDurationMs = Math.max(1, Math.round(performance.now() - recStartMs));
    } catch (ocrErr: any) {
      ocrDurationMs = Math.max(1, Math.round(performance.now() - recStartMs));
      recognizeError = ocrErr?.message || String(ocrErr || 'Unknown Tesseract recognize error');
      recordStage?.(
        `page_${pageNumber}_recognize_error`,
        'error',
        `worker.recognize failed on page ${pageNumber}: ${recognizeError}`,
        ocrDurationMs
      );
      // If no fallback selectable PDF text exists on this page, propagate the recognition failure
      // rather than silently converting it into an empty result without error context.
      const hasFallbackPdfLines =
        textHint?.hasSelectableText &&
        Array.isArray(textHint.selectableLines) &&
        textHint.selectableLines.length > 0;
      if (!hasFallbackPdfLines) {
        throw new Error(`Tesseract recognition failed on page ${pageNumber}: ${recognizeError}`);
      }
    } finally {
      activeDocketProgressHook = null;
    }

    const data = recognitionOutput?.data || {};
    if (typeof data.confidence === 'number') {
      defaultDataConfidence = data.confidence;
    }

    // Extract positioned words from data.blocks, data.tsv, or data.words
    let rawWords: RawOcrWord[] = [];
    if (Array.isArray(data.blocks) && data.blocks.length > 0) {
      for (const block of data.blocks) {
        for (const para of block?.paragraphs || []) {
          for (const ln of para?.lines || []) {
            for (const w of ln?.words || []) {
              const txt = String(w?.text || '').trim();
              if (!txt) continue;
              const b = w.bbox || ln.bbox || { x0: 0, y0: 0, x1: txt.length * 8, y1: 14 };
              rawWords.push({
                text: txt,
                confidence: typeof w.confidence === 'number' ? w.confidence : 80,
                bbox: {
                  x0: Number(b.x0) || 0,
                  y0: Number(b.y0) || 0,
                  x1: Number(b.x1) || 0,
                  y1: Number(b.y1) || 0,
                },
              });
            }
          }
        }
      }
    }

    if (rawWords.length === 0 && typeof data.tsv === 'string' && data.tsv.trim()) {
      rawWords = parseTsvToPositionedWords(data.tsv);
    }

    if (rawWords.length === 0 && Array.isArray(data.words)) {
      for (const w of data.words) {
        const txt = String(w?.text || '').trim();
        if (!txt) continue;
        const b = w.bbox || { x0: 0, y0: 0, x1: txt.length * 8, y1: 14 };
        rawWords.push({
          text: txt,
          confidence: typeof w.confidence === 'number' ? w.confidence : 80,
          bbox: {
            x0: Number(b.x0) || 0,
            y0: Number(b.y0) || 0,
            x1: Number(b.x1) || 0,
            y1: Number(b.y1) || 0,
          },
        });
      }
    }

    totalWordsRecognized = rawWords.length;

    if (rawWords.length > 0) {
      extractedLines = groupPositionedWordsIntoLines(rawWords, pageNumber);
    }

    if (extractedLines.length === 0 && Array.isArray(data.lines) && data.lines.length > 0) {
      for (const ln of data.lines) {
        const txt = String(ln?.text || '').trim();
        if (!txt) continue;
        extractedLines.push({
          text: txt,
          confidence: typeof ln.confidence === 'number' ? ln.confidence : 80,
          pageNumber,
        });
      }
    }

    if (extractedLines.length === 0 && typeof data.text === 'string' && data.text.trim()) {
      const defaultConf = typeof data.confidence === 'number' ? data.confidence : 78;
      extractedLines = data.text
        .split(/\r?\n/)
        .map((l: string) => l.trim())
        .filter(Boolean)
        .map((text: string) => ({
          text,
          confidence: defaultConf,
          pageNumber,
        }));
    }

    ocrOnlyLines = [...extractedLines];

    const rawTextLen = typeof data.text === 'string' ? data.text.trim().length : 0;
    recordStage?.(
      `page_${pageNumber}_recognize_complete`,
      extractedLines.length > 0 ? 'ok' : 'warn',
      `Tesseract.recognize() completed on Page ${pageNumber}: chars=${rawTextLen}, words=${totalWordsRecognized}, lines=${extractedLines.length}, meanConf=${defaultDataConfidence}%`,
      ocrDurationMs
    );
  }

  // 2. If PDF selectable layout lines are also available, preserve them so both Tesseract OCR
  // and native PDF selectable text can be compared and merged without discarding complementary rows.
  if (
    textHint?.hasSelectableText &&
    Array.isArray(textHint.selectableLines) &&
    textHint.selectableLines.length > 0
  ) {
    const pdfLines: RawOcrLine[] = textHint.selectableLines.map((l: any) => ({
      text: l.text,
      confidence: typeof l.confidence === 'number' ? l.confidence : 98,
      pageNumber,
      bbox: l.bbox,
      words: l.words,
    }));
    pdfSelectableLines = pdfLines;

    if (extractedLines.length === 0) {
      extractedLines = pdfLines;
      totalWordsRecognized = pdfLines.reduce(
        (acc, l) => acc + (l.words?.length || l.text.split(/\s+/).length),
        0
      );
      sourceKind = 'tesseract-plus-pdf-layout';
      defaultDataConfidence = 98;
      onRecognizeProgress?.(1);
      recordStage?.(
        `page_${pageNumber}_pdf_layout_enrichment`,
        'ok',
        `Used positioned PDF text layout lines for Page ${pageNumber} (${pdfLines.length} lines)`
      );
    } else {
      sourceKind = 'tesseract-plus-pdf-layout';
      recordStage?.(
        `page_${pageNumber}_pdf_layout_enrichment`,
        'ok',
        `Retained both Tesseract OCR (${ocrOnlyLines.length} lines) and PDF selectable text (${pdfLines.length} lines) for complementary row merging`
      );
    }
  }

  const meanConfidence =
    extractedLines.length > 0
      ? Math.round(
          extractedLines.reduce((acc, l) => acc + (Number(l.confidence) || 80), 0) /
            extractedLines.length
        )
      : defaultDataConfidence || 0;

  const rawText = extractedLines.map((l) => l.text).join('\n');

  const cachedResult: CachedTesseractPageOcr = {
    pageHash,
    lines: extractedLines,
    ocrOnlyLines,
    pdfSelectableLines,
    rawText,
    meanConfidence,
    preprocessDurationMs,
    workerInitDurationMs,
    ocrDurationMs,
    wordsCount: totalWordsRecognized,
    recognizeCalled,
    sourceKind,
  };

  if (!customWorkerFactoryForTesting) {
    if (pageOcrCache.size >= MAX_PAGE_CACHE_ENTRIES) {
      const oldestKey = pageOcrCache.keys().next().value;
      if (oldestKey) pageOcrCache.delete(oldestKey);
    }
    pageOcrCache.set(pageHash, cachedResult);
  }

  return {
    cachedResult,
    fromCache: false,
    originalDataUrl,
    preprocessedDataUrl,
    width,
    height,
    recognizeCalled,
    recognizeError,
  };
}

/**
 * Primary Tesseract-first docket extraction pipeline across 1 or more pages (images or PDF pages).
 * Records full stage-by-stage diagnostic timestamps and asset/recognition/validation verification.
 */
export async function extractDocketWithTesseractFirst(
  pages: Array<string | File | Buffer | Uint8Array>,
  options?: {
    pageTextHints?: PageTextHint[];
    supplierHint?: SupplierRuleId;
    onProgress?: (update: OcrProgressUpdate) => void;
  }
): Promise<TesseractDocketExtractionResult> {
  const totalPages = pages.length;
  const startedAtIso = new Date().toISOString();
  const pipelineStartMs = performance.now();
  const stages: TesseractDiagnosticStageEvent[] = [];

  const recordStage = (
    stage: string,
    status: 'ok' | 'warn' | 'error',
    detail: string,
    durationMs?: number
  ) => {
    stages.push({
      stage,
      timestampIso: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - pipelineStartMs),
      durationMs,
      status,
      detail,
    });
  };

  if (totalPages === 0) {
    recordStage('0_input_check', 'error', 'No docket pages provided for Tesseract extraction.');
    throw new Error('No docket pages provided for Tesseract extraction.');
  }

  recordStage(
    '1_pipeline_start',
    'ok',
    `Starting Tesseract-first extraction across ${totalPages} page(s)`
  );

  let totalPreprocessTimeMs = 0;
  let totalWorkerInitTimeMs = 0;
  let totalOcrTimeMs = 0;
  let pagesFromCache = 0;
  let anyRecognizeCalled = false;
  let anyRecognizeError: string | undefined;

  const processedPages: TesseractDocketExtractionResult['processedPages'] = [];
  const pageCachedResults: CachedTesseractPageOcr[] = [];
  const pageParseResults: Array<ReturnType<typeof parseIndustrialDocketText>> = [];
  let usedPdfLayoutEnrichment = false;

  for (let idx = 0; idx < totalPages; idx++) {
    const pageNum = idx + 1;
    const pageBasePct = Math.round((idx / totalPages) * 80);
    const pageSpanPct = Math.round(80 / totalPages);

    options?.onProgress?.({
      currentPage: pageNum,
      totalPages,
      stage: 'preparing',
      percent: Math.max(5, pageBasePct + 4),
      statusText:
        totalPages > 1
          ? `Preparing Page ${pageNum} of ${totalPages} for Tesseract OCR...`
          : 'Preparing docket image for Tesseract OCR...',
    });

    const pageRecognition = await recognizeDocketPageWithTesseract(
      pages[idx],
      pageNum,
      options?.pageTextHints?.[idx],
      (ratio) => {
        const currentPct = Math.min(
          85,
          Math.max(8, pageBasePct + Math.round(ratio * pageSpanPct))
        );
        options?.onProgress?.({
          currentPage: pageNum,
          totalPages,
          stage: 'recognizing',
          percent: currentPct,
          statusText:
            totalPages > 1
              ? `Tesseract OCR scanning Page ${pageNum} of ${totalPages} (${Math.round(ratio * 100)}%)...`
              : `Tesseract OCR extracting docket text (${Math.round(ratio * 100)}%)...`,
        });
      },
      recordStage
    );

    if (pageRecognition.recognizeCalled) {
      anyRecognizeCalled = true;
    }
    if (pageRecognition.recognizeError && !anyRecognizeError) {
      anyRecognizeError = pageRecognition.recognizeError;
    }

    totalPreprocessTimeMs += pageRecognition.cachedResult.preprocessDurationMs;
    if (pageRecognition.fromCache) {
      pagesFromCache++;
    } else {
      totalWorkerInitTimeMs += pageRecognition.cachedResult.workerInitDurationMs;
      totalOcrTimeMs += pageRecognition.cachedResult.ocrDurationMs;
    }

    if (pageRecognition.cachedResult.sourceKind === 'tesseract-plus-pdf-layout') {
      usedPdfLayoutEnrichment = true;
    }

    pageCachedResults.push(pageRecognition.cachedResult);

    processedPages.push({
      pageNumber: pageNum,
      originalDataUrl: pageRecognition.originalDataUrl,
      preprocessedDataUrl: pageRecognition.preprocessedDataUrl,
      width: pageRecognition.width,
      height: pageRecognition.height,
      fromCache: pageRecognition.fromCache,
      preprocessDurationMs: pageRecognition.cachedResult.preprocessDurationMs,
      workerInitDurationMs: pageRecognition.fromCache
        ? 0
        : pageRecognition.cachedResult.workerInitDurationMs,
      ocrDurationMs: pageRecognition.fromCache ? 0 : pageRecognition.cachedResult.ocrDurationMs,
      meanConfidence: pageRecognition.cachedResult.meanConfidence,
      lineCount: pageRecognition.cachedResult.lines.length,
      wordCount: pageRecognition.cachedResult.wordsCount,
    });
  }

  options?.onProgress?.({
    currentPage: totalPages,
    totalPages,
    stage: 'parsing',
    percent: 90,
    statusText: 'Parsing supplier layout & validating extracted part rows...',
  });

  const parseStartMs = performance.now();
  let totalLinesCount = 0;
  let totalWordsCount = 0;
  let totalRawTextLength = 0;

  for (let idx = 0; idx < totalPages; idx++) {
    const pageNum = idx + 1;
    const cachedPage = pageCachedResults[idx];
    const ocrLines = cachedPage?.ocrOnlyLines?.length ? cachedPage.ocrOnlyLines : cachedPage?.lines || [];
    const pdfLines = cachedPage?.pdfSelectableLines;

    const effectiveLinesCount = Math.max(ocrLines.length, pdfLines?.length || 0);
    totalLinesCount += effectiveLinesCount;
    totalWordsCount += cachedPage?.wordsCount || 0;
    totalRawTextLength += Math.max(
      (cachedPage?.rawText || '').length,
      pdfLines ? pdfLines.map((l) => l.text).join('\n').length : 0
    );

    if (ocrLines.length > 0 && pdfLines && pdfLines.length > 0) {
      // Both Tesseract OCR and PDF selectable text exist for this page:
      // Parse both and merge complementary rows without duplicates!
      const ocrParsed = parseIndustrialDocketText(ocrLines, pageNum, options?.supplierHint);
      const pdfParsed = parseIndustrialDocketText(pdfLines, pageNum, options?.supplierHint);
      const mergedItems = mergeComplementaryParsedItems(pdfParsed.items, ocrParsed.items);
      const minUnparsed = Math.min(
        ocrParsed.unparsedCandidateCount,
        pdfParsed.unparsedCandidateCount
      );
      const usePdfHeader =
        pdfParsed.header.docketNumber && !/^DOC-\d+$/i.test(pdfParsed.header.docketNumber);

      pageParseResults.push({
        header: {
          docketNumber: usePdfHeader
            ? pdfParsed.header.docketNumber
            : ocrParsed.header.docketNumber,
          supplier:
            pdfParsed.header.supplierProfile !== 'ocr_label'
              ? pdfParsed.header.supplier
              : ocrParsed.header.supplier,
          supplierProfile:
            pdfParsed.header.supplierProfile !== 'ocr_label'
              ? pdfParsed.header.supplierProfile
              : ocrParsed.header.supplierProfile,
          deliveryDate: pdfParsed.header.deliveryDate || ocrParsed.header.deliveryDate,
          orderNumber: pdfParsed.header.orderNumber || ocrParsed.header.orderNumber,
          carrier: pdfParsed.header.carrier || ocrParsed.header.carrier,
          palletCount: Math.max(
            pdfParsed.header.palletCount || 1,
            ocrParsed.header.palletCount || 1
          ),
        },
        items: mergedItems,
        rawText: pdfParsed.rawText || ocrParsed.rawText,
        unparsedCandidateCount: minUnparsed,
        columnLayout: pdfParsed.columnLayout || ocrParsed.columnLayout,
      });
    } else {
      const linesToParse = ocrLines.length > 0 ? ocrLines : pdfLines || [];
      const parsedPage = parseIndustrialDocketText(
        linesToParse,
        pageNum,
        options?.supplierHint
      );
      pageParseResults.push(parsedPage);
    }
  }
  const parseTimeMs = Math.max(1, Math.round(performance.now() - parseStartMs));
  const totalTimeMs = Math.max(1, Math.round(performance.now() - pipelineStartMs));

  const engineLabel = usedPdfLayoutEnrichment
    ? 'Tesseract.js OCR + PDF Layout'
    : 'Tesseract.js OCR';

  const combined = combineMultiPageDocketResults(pageParseResults, {
    extractionMethod: 'tesseract-ocr',
    extractionEngineLabel: engineLabel,
    processingTimeMs: totalTimeMs,
    ocrTimeMs: totalOcrTimeMs,
    parseTimeMs,
    pagesFromCache,
  });

  const { validationReport, ...extractedData } = combined;

  recordStage(
    '6_supplier_parsing_complete',
    extractedData.items.length > 0 ? 'ok' : 'warn',
    `Parsed ${extractedData.items.length} part row(s) across ${totalPages} page(s) (supplier=${extractedData.supplier}, unparsedCandidates=${validationReport.unparsedCandidateCount})`,
    parseTimeMs
  );

  // Classify outcome into exact A / B / C / D / E / F diagnostic categories
  let outcomeCode: TesseractDiagnosticOutcomeCode;
  let outcomeLabel: string;
  let exactTriggerCondition: string | undefined;

  if (!workerAssetState.workerInitialised && workerAssetState.lastInitError) {
    outcomeCode = 'B_TESSERACT_FAILED_TO_INITIALISE';
    outcomeLabel = 'B. Tesseract failed to initialise.';
    exactTriggerCondition = workerAssetState.lastInitError;
  } else if (!anyRecognizeCalled && !usedPdfLayoutEnrichment) {
    outcomeCode = 'A_TESSERACT_NEVER_STARTED';
    outcomeLabel = 'A. Tesseract never started.';
    exactTriggerCondition = 'Tesseract.recognize() was not invoked on any page.';
  } else if (totalLinesCount === 0 || totalRawTextLength === 0) {
    outcomeCode = 'C_TESSERACT_FAILED_TO_RECOGNISE_TEXT';
    outcomeLabel = 'C. Tesseract initialised but failed to recognise text.';
    exactTriggerCondition =
      anyRecognizeError || 'Tesseract.recognize() returned 0 text characters and 0 words.';
  } else if (extractedData.items.length === 0) {
    outcomeCode = 'D_TESSERACT_RECOGNISED_TEXT_BUT_PARSING_FAILED';
    outcomeLabel = 'D. Tesseract recognised text but parsing failed.';
    exactTriggerCondition = `Tesseract returned ${totalRawTextLength} chars across ${totalLinesCount} line(s), but 0 structured part rows matched supplier parser rules.`;
  } else if (validationReport.shouldFallbackToGemini) {
    outcomeCode = 'E_PARSING_SUCCEEDED_BUT_VALIDATION_REJECTED';
    outcomeLabel = 'E. Parsing succeeded but validation rejected the results.';
    exactTriggerCondition = validationReport.fallbackReason;
  } else {
    outcomeCode = 'F_TESSERACT_SUCCEEDED';
    outcomeLabel = 'F. Tesseract succeeded — accepted without Gemini fallback.';
  }

  recordStage(
    '7_validation_and_outcome',
    outcomeCode === 'F_TESSERACT_SUCCEEDED' ? 'ok' : 'warn',
    `${outcomeLabel}${exactTriggerCondition ? ` Trigger: ${exactTriggerCondition}` : ` (${extractedData.items.length} items, confidence=${validationReport.overallConfidenceScore}%)`}`
  );

  const diagnostics: TesseractPipelineDiagnostics = {
    outcomeCode,
    outcomeLabel,
    startedAtIso,
    completedAtIso: new Date().toISOString(),
    totalElapsedMs: totalTimeMs,
    preprocessDurationMs: totalPreprocessTimeMs,
    workerInitDurationMs: totalWorkerInitTimeMs || workerAssetState.initDurationMs,
    ocrDurationMs: totalOcrTimeMs,
    parseDurationMs: parseTimeMs,
    pdfRenderingSucceeded: processedPages.every((p) => Boolean(p.originalDataUrl)),
    workerInitialised: workerAssetState.workerInitialised || usedPdfLayoutEnrichment,
    workerScriptLoaded: workerAssetState.workerScriptLoaded || usedPdfLayoutEnrichment,
    wasmCoreLoaded: workerAssetState.wasmCoreLoaded || usedPdfLayoutEnrichment,
    trainedDataLoaded: workerAssetState.trainedDataLoaded || usedPdfLayoutEnrichment,
    recognizeCalled: anyRecognizeCalled,
    ocrReturnedText: totalRawTextLength > 0,
    ocrReturnedWords: totalWordsCount > 0,
    totalRawTextLength,
    totalWordsCount,
    totalLinesCount,
    itemsParsedCount: extractedData.items.length,
    validationAccepted: !validationReport.shouldFallbackToGemini,
    exactTriggerCondition,
    stages,
  };

  extractedData.tesseractDiagnostics = diagnostics;

  // Safe operational telemetry (never logs document contents, API keys, or secrets)
  console.info('[PartTrack Tesseract Diagnostics]', {
    outcomeCode: diagnostics.outcomeCode,
    outcomeLabel: diagnostics.outcomeLabel,
    totalElapsedMs: diagnostics.totalElapsedMs,
    preprocessDurationMs: diagnostics.preprocessDurationMs,
    workerInitDurationMs: diagnostics.workerInitDurationMs,
    ocrDurationMs: diagnostics.ocrDurationMs,
    parseDurationMs: diagnostics.parseDurationMs,
    workerInitialised: diagnostics.workerInitialised,
    workerScriptLoaded: diagnostics.workerScriptLoaded,
    wasmCoreLoaded: diagnostics.wasmCoreLoaded,
    trainedDataLoaded: diagnostics.trainedDataLoaded,
    recognizeCalled: diagnostics.recognizeCalled,
    ocrReturnedText: diagnostics.ocrReturnedText,
    ocrReturnedWords: diagnostics.ocrReturnedWords,
    totalWordsCount: diagnostics.totalWordsCount,
    totalLinesCount: diagnostics.totalLinesCount,
    itemsParsedCount: diagnostics.itemsParsedCount,
    validationAccepted: diagnostics.validationAccepted,
    exactTriggerCondition: diagnostics.exactTriggerCondition,
  });

  return {
    extractedData,
    validationReport,
    diagnostics,
    processedPages,
    metrics: {
      totalTimeMs,
      preprocessTimeMs: totalPreprocessTimeMs,
      workerInitTimeMs: totalWorkerInitTimeMs || workerAssetState.initDurationMs,
      ocrTimeMs: totalOcrTimeMs,
      parseTimeMs,
      pagesProcessed: totalPages,
      pagesFromCache,
    },
  };
}
