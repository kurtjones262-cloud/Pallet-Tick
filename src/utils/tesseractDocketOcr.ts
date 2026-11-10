import { createWorker, OEM, PSM } from 'tesseract.js';
import { ExtractedDocketResult } from '../server/docketOcr';
import { SupplierRuleId } from '../types/delivery';
import {
  RawOcrLine,
  RawOcrWord,
  DocketValidationReport,
  groupPositionedWordsIntoLines,
  parseIndustrialDocketText,
  combineMultiPageDocketResults,
} from './docketParser';
import { preprocessDocketImage } from './imagePreprocessing';
import type { OcrProgressUpdate, PageTextHint } from './offlineOcr';

export interface CachedTesseractPageOcr {
  pageHash: string;
  lines: RawOcrLine[];
  rawText: string;
  meanConfidence: number;
  ocrDurationMs: number;
  sourceKind: 'tesseract-image' | 'tesseract-plus-pdf-layout';
}

export interface TesseractDocketExtractionResult {
  extractedData: ExtractedDocketResult;
  validationReport: DocketValidationReport;
  processedPages: Array<{
    pageNumber: number;
    originalDataUrl: string;
    preprocessedDataUrl: string;
    width: number;
    height: number;
    fromCache: boolean;
    ocrDurationMs: number;
    meanConfidence: number;
    lineCount: number;
  }>;
  metrics: {
    totalTimeMs: number;
    ocrTimeMs: number;
    parseTimeMs: number;
    pagesProcessed: number;
    pagesFromCache: number;
  };
}

const MAX_PAGE_CACHE_ENTRIES = 64;
const pageOcrCache = new Map<string, CachedTesseractPageOcr>();

let warmDocketTesseractWorkerPromise: Promise<any> | null = null;
let activeDocketProgressHook: ((progressRatio: number) => void) | null = null;

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
    // Sample length + head + middle + tail segments for O(1) hashing of large base64 strings
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
  }

  // 64-bit FNV-1a style dual 32-bit hash
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
 * Initializes or returns the warm Tesseract.js LSTM worker for docket extraction.
 * Works in both Browser (using bundled /tesseract/* assets) and Node.js (using local public/tesseract/lang-data).
 */
export async function getOrInitDocketTesseractWorker(): Promise<any> {
  if (warmDocketTesseractWorkerPromise) {
    return warmDocketTesseractWorkerPromise;
  }

  warmDocketTesseractWorkerPromise = (async () => {
    const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';

    const loggerFn = (m: any) => {
      if (m && m.status === 'recognizing text' && activeDocketProgressHook) {
        activeDocketProgressHook(Number(m.progress) || 0);
      }
    };

    if (isBrowser) {
      const origin = window.location?.origin || '';
      try {
        const worker = await createWorker('eng', OEM.LSTM_ONLY, {
          workerPath: `${origin}/tesseract/worker.min.js`,
          workerBlobURL: false,
          corePath: `${origin}/tesseract/core`,
          langPath: `${origin}/tesseract/lang-data`,
          gzip: true,
          cacheMethod: 'none',
          logger: loggerFn,
          errorHandler: (err: any) => {
            console.warn('[PalletTrack Docket Tesseract] Worker warning:', err);
          },
        });
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
          preserve_interword_spaces: '1',
        });
        return worker;
      } catch (firstErr) {
        console.warn('[PalletTrack Docket Tesseract] Retrying worker init with blob fallback:', firstErr);
        const fallbackWorker = await createWorker('eng', OEM.LSTM_ONLY, {
          workerPath: '/tesseract/worker.min.js',
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
        return fallbackWorker;
      }
    } else {
      // Node.js runtime (for automated verification and CLI testing)
      const pathMod = await import('path');
      const localLangPath = pathMod.resolve(process.cwd(), 'public/tesseract/lang-data');
      const nodeWorker = await createWorker('eng', OEM.LSTM_ONLY, {
        langPath: localLangPath,
        gzip: true,
        cacheMethod: 'none',
        logger: loggerFn,
      });
      await nodeWorker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        preserve_interword_spaces: '1',
      });
      return nodeWorker;
    }
  })().catch((err) => {
    warmDocketTesseractWorkerPromise = null;
    throw err;
  });

  return warmDocketTesseractWorkerPromise;
}

/**
 * Terminates the warm docket Tesseract worker (used when shutting down Node test processes).
 */
export async function terminateDocketTesseractWorker(): Promise<void> {
  if (!warmDocketTesseractWorkerPromise) return;
  try {
    const worker = await warmDocketTesseractWorkerPromise;
    await worker.terminate();
  } catch {
    // Ignore termination errors
  } finally {
    warmDocketTesseractWorkerPromise = null;
  }
}

/**
 * Extracts positioned lines and word bounding boxes from a single docket page using Tesseract.js,
 * utilizing the page cache to avoid repeated OCR of identical pages.
 */
export async function recognizeDocketPageWithTesseract(
  imageSource: string | File | Buffer | Uint8Array,
  pageNumber: number,
  textHint?: PageTextHint,
  onRecognizeProgress?: (ratio: number) => void
): Promise<{
  cachedResult: CachedTesseractPageOcr;
  fromCache: boolean;
  originalDataUrl: string;
  preprocessedDataUrl: string;
  width: number;
  height: number;
}> {
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

  let originalDataUrl = '';
  let preprocessedDataUrl = '';
  let width = 1600;
  let height = 2200;
  let hashInput: string | Uint8Array | Buffer = '';

  if (isBrowser && (typeof imageSource === 'string' || imageSource instanceof File)) {
    const prep = await preprocessDocketImage(imageSource);
    originalDataUrl = prep.displayDataUrl;
    preprocessedDataUrl = prep.ocrDataUrl;
    width = prep.width;
    height = prep.height;
    hashInput = preprocessedDataUrl;
  } else if (typeof imageSource === 'string') {
    originalDataUrl = imageSource;
    preprocessedDataUrl = imageSource;
    hashInput = imageSource;
  } else if (imageSource instanceof Uint8Array || Buffer.isBuffer(imageSource)) {
    hashInput = imageSource;
    const base64 = Buffer.from(imageSource).toString('base64');
    originalDataUrl = `data:image/png;base64,${base64}`;
    preprocessedDataUrl = originalDataUrl;
  }

  const pageHash = computeDocketPageHash(hashInput, textHint);
  const existingCached = pageOcrCache.get(pageHash);
  if (existingCached) {
    onRecognizeProgress?.(1);
    // Refresh pageNumber on cloned lines for current page index
    const linesForPage = existingCached.lines.map((l) => ({
      ...l,
      pageNumber,
    }));
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
    };
  }

  const startOcrMs = performance.now();
  let extractedLines: RawOcrLine[] = [];
  let sourceKind: CachedTesseractPageOcr['sourceKind'] = 'tesseract-image';
  let defaultDataConfidence = 80;

  // Fast-path for digitally generated PDFs that already contain positioned selectable text lines.
  // Only convert/OCR the rasterized PDF page image with Tesseract when selectable text is absent or incomplete.
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
    const pdfParsed = parseIndustrialDocketText(pdfLines, pageNumber);
    if (pdfParsed.items.length > 0) {
      extractedLines = pdfLines;
      sourceKind = 'tesseract-plus-pdf-layout';
      defaultDataConfidence = 98;
      onRecognizeProgress?.(1);
    }
  }

  // Run full Tesseract.js LSTM OCR whenever extractedLines wasn't satisfied by digital PDF selectable text
  if (extractedLines.length === 0) {
    const worker = await getOrInitDocketTesseractWorker();
    activeDocketProgressHook = onRecognizeProgress || null;
    let recognitionOutput: any = null;
    try {
      const targetForTesseract =
        typeof imageSource === 'string' || isBrowser ? preprocessedDataUrl : imageSource;
      recognitionOutput = await worker.recognize(
        targetForTesseract,
        {},
        { text: true, blocks: true }
      );
    } catch (ocrErr) {
      console.warn(`[TesseractDocketOCR] Page ${pageNumber} image recognition warning:`, ocrErr);
    } finally {
      activeDocketProgressHook = null;
    }

    const data = recognitionOutput?.data || {};
    if (typeof data.confidence === 'number') {
      defaultDataConfidence = data.confidence;
    }

    // 1. Extract positioned words with bounding boxes from Tesseract v5 data.blocks (and data.words if present)
    const rawWords: RawOcrWord[] = [];
    if (Array.isArray(data.blocks)) {
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
    } else if (Array.isArray(data.words)) {
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

    // 2. Reconstruct horizontal lines with column spacing from positioned words
    if (rawWords.length > 0) {
      extractedLines = groupPositionedWordsIntoLines(rawWords, pageNumber);
    }

    // 3. Fallback to data.lines or data.text if data.words was empty
    if (extractedLines.length === 0 && Array.isArray(data.lines) && data.lines.length > 0) {
      for (const ln of data.lines) {
        const txt = String(ln?.text || '').trim();
        if (!txt) continue;
        const lineWords: RawOcrWord[] = Array.isArray(ln.words)
          ? ln.words
              .filter((w: any) => String(w?.text || '').trim())
              .map((w: any) => ({
                text: String(w.text).trim(),
                confidence: typeof w.confidence === 'number' ? w.confidence : 80,
                bbox: {
                  x0: Number(w.bbox?.x0) || 0,
                  y0: Number(w.bbox?.y0) || 0,
                  x1: Number(w.bbox?.x1) || 0,
                  y1: Number(w.bbox?.y1) || 0,
                },
              }))
          : [];
        extractedLines.push({
          text: txt,
          confidence: typeof ln.confidence === 'number' ? ln.confidence : 80,
          pageNumber,
          bbox: ln.bbox
            ? {
                x0: Number(ln.bbox.x0) || 0,
                y0: Number(ln.bbox.y0) || 0,
                x1: Number(ln.bbox.x1) || 0,
                y1: Number(ln.bbox.y1) || 0,
              }
            : undefined,
          words: lineWords.length > 0 ? lineWords : undefined,
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

    // 4. If PDF selectable lines existed but didn't parse into items earlier, still keep them if Tesseract found nothing
    if (
      extractedLines.length === 0 &&
      textHint?.hasSelectableText &&
      Array.isArray(textHint.selectableLines) &&
      textHint.selectableLines.length > 0
    ) {
      extractedLines = textHint.selectableLines.map((l: any) => ({
        text: l.text,
        confidence: typeof l.confidence === 'number' ? l.confidence : 95,
        pageNumber,
        bbox: l.bbox,
        words: l.words,
      }));
      sourceKind = 'tesseract-plus-pdf-layout';
    }
  }

  const ocrDurationMs = Math.round(performance.now() - startOcrMs);

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
    rawText,
    meanConfidence,
    ocrDurationMs,
    sourceKind,
  };

  if (pageOcrCache.size >= MAX_PAGE_CACHE_ENTRIES) {
    const oldestKey = pageOcrCache.keys().next().value;
    if (oldestKey) pageOcrCache.delete(oldestKey);
  }
  pageOcrCache.set(pageHash, cachedResult);

  return {
    cachedResult,
    fromCache: false,
    originalDataUrl,
    preprocessedDataUrl,
    width,
    height,
  };
}

/**
 * Primary Tesseract-first docket extraction pipeline across 1 or more pages (images or PDF pages).
 * - Preserves page numbers and word/line bounding boxes.
 * - Uses deterministic Laser Central and GCI supplier parsing rules.
 * - Validates extracted rows for missing part numbers, invalid quantities, uncertain text,
 *   incomplete rows, missed line items, and duplicates.
 * - Avoids repeated OCR via per-page content caching.
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
  if (totalPages === 0) {
    throw new Error('No docket pages provided for Tesseract extraction.');
  }

  const pipelineStartMs = performance.now();
  let totalOcrTimeMs = 0;
  let pagesFromCache = 0;

  const processedPages: TesseractDocketExtractionResult['processedPages'] = [];
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
      }
    );

    if (pageRecognition.fromCache) {
      pagesFromCache++;
    } else {
      totalOcrTimeMs += pageRecognition.cachedResult.ocrDurationMs;
    }

    if (pageRecognition.cachedResult.sourceKind === 'tesseract-plus-pdf-layout') {
      usedPdfLayoutEnrichment = true;
    }

    processedPages.push({
      pageNumber: pageNum,
      originalDataUrl: pageRecognition.originalDataUrl,
      preprocessedDataUrl: pageRecognition.preprocessedDataUrl,
      width: pageRecognition.width,
      height: pageRecognition.height,
      fromCache: pageRecognition.fromCache,
      ocrDurationMs: pageRecognition.fromCache ? 0 : pageRecognition.cachedResult.ocrDurationMs,
      meanConfidence: pageRecognition.cachedResult.meanConfidence,
      lineCount: pageRecognition.cachedResult.lines.length,
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
  for (let idx = 0; idx < totalPages; idx++) {
    const pageNum = idx + 1;
    const cachedPage = pageOcrCache.get(
      computeDocketPageHash(
        processedPages[idx].preprocessedDataUrl || (pages[idx] as any),
        options?.pageTextHints?.[idx]
      )
    );
    const lines = cachedPage?.lines || [];
    const parsedPage = parseIndustrialDocketText(
      lines,
      pageNum,
      options?.supplierHint
    );
    pageParseResults.push(parsedPage);
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

  return {
    extractedData,
    validationReport,
    processedPages,
    metrics: {
      totalTimeMs,
      ocrTimeMs: totalOcrTimeMs,
      parseTimeMs,
      pagesProcessed: totalPages,
      pagesFromCache,
    },
  };
}
