import { createWorker, OEM } from 'tesseract.js';
import { DeliveryPart } from '../types/delivery';

export interface PalletLabelExtractionResult {
  partNumber: string;
  description: string;
  quantity: number | null;
  rawOcrText: string;
  ocrConfidence: 'high' | 'medium' | 'low';
  engineUsed: 'mlkit-native' | 'on-device-bundled';
  croppedPreviewDataUrl: string;
  enhancedOcrDataUrl: string;
  detectedSkewDegrees: number;
}

export interface PalletLabelMatchEvaluation {
  matchStatus: 'exact_match' | 'uncertain' | 'unmatched';
  matchedPart: DeliveryPart | null;
  candidateParts: DeliveryPart[];
  statusColor: 'green' | 'orange' | 'red';
  existingScannedQty: number;
  addedPalletQty: number;
  newTotalScannedQty: number;
  expectedQty: number;
}

/**
 * Persistent warm on-device OCR worker instance so warehouse operators get
 * fast recognition without re-initializing WebAssembly on every label capture.
 */
let warmOcrWorkerPromise: Promise<any> | null = null;
let latestProgressCallback: ((statusText: string, percent: number) => void) | null = null;

async function getOrInitWarmOnDeviceWorker(): Promise<any> {
  if (warmOcrWorkerPromise) {
    return warmOcrWorkerPromise;
  }

  warmOcrWorkerPromise = (async () => {
    const origin =
      typeof window !== 'undefined' && window.location && window.location.origin
        ? window.location.origin
        : '';

    console.info('[PartTrack OCR] Initializing bundled offline Tesseract LSTM worker...');

    // Purge any stale/corrupted tesseract keyval-store IndexedDB cache from earlier sessions
    if (typeof window !== 'undefined' && 'indexedDB' in window) {
      try {
        window.indexedDB.deleteDatabase('keyval-store');
      } catch {
        // Ignore IndexedDB cleanup errors
      }
    }

    const loggerFn = (m: any) => {
      if (m && m.status === 'recognizing text' && latestProgressCallback) {
        const pct = Math.round((m.progress || 0) * 100);
        latestProgressCallback(`Reading label text (${pct}%)...`, pct);
      }
    };

    const LABEL_WORKER_INIT_TIMEOUT_MS = 15000;
    const withWorkerInitTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`[PartTrack OCR] ${label} initialization timed out after ${LABEL_WORKER_INIT_TIMEOUT_MS}ms.`));
        }, LABEL_WORKER_INIT_TIMEOUT_MS);
      });
      try {
        return await Promise.race([promise, timeoutPromise]);
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    };

    try {
      const worker = await withWorkerInitTimeout(
        createWorker('eng', OEM.LSTM_ONLY, {
          workerPath: `${origin}/tesseract/worker.min.js`,
          workerBlobURL: false,
          corePath: `${origin}/tesseract/core`,
          langPath: `${origin}/tesseract/lang-data`,
          gzip: true,
          cacheMethod: 'none',
          logger: loggerFn,
        }),
        'Primary offline LSTM worker'
      );
      console.info('[PartTrack OCR] Bundled offline LSTM worker initialized and ready.');
      return worker;
    } catch (firstErr) {
      console.warn(
        '[PartTrack OCR] Primary non-blob worker init failed, retrying with blob URL fallback:',
        firstErr
      );
      const fallbackWorker = await withWorkerInitTimeout(
        createWorker('eng', OEM.LSTM_ONLY, {
          workerPath: '/tesseract/worker.min.js',
          corePath: `${origin}/tesseract/core`,
          langPath: `${origin}/tesseract/lang-data`,
          gzip: true,
          cacheMethod: 'none',
          logger: loggerFn,
        }),
        'Fallback offline LSTM worker'
      );
      console.info('[PartTrack OCR] Fallback offline LSTM worker initialized.');
      return fallbackWorker;
    }
  })().catch((err) => {
    console.error('[PartTrack OCR] Worker initialization failed:', err);
    warmOcrWorkerPromise = null;
    throw err;
  });

  return warmOcrWorkerPromise;
}

/**
 * Pre-warms the bundled offline OCR worker when the scanner starts or switches to OCR mode.
 */
export function prewarmPalletLabelOcrEngine(): void {
  if (typeof window === 'undefined') return;
  getOrInitWarmOnDeviceWorker().catch((err) => {
    console.warn('[PartTrack OCR] Prewarm note (will retry on capture):', err);
  });
}

/**
 * Computes a lightweight 8x6 luminance signature of the central label region of a live <video> element
 * so continuous/periodic OCR can avoid re-processing identical frames or blurry motion frames.
 */
export function computeVideoFrameSignature(video: HTMLVideoElement): {
  signature: number[];
  edgeContrast: number;
} | null {
  if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
    return null;
  }

  const gridW = 16;
  const gridH = 12;
  const canvas = document.createElement('canvas');
  canvas.width = gridW;
  canvas.height = gridH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  ctx.drawImage(
    video,
    Math.round(vw * 0.1),
    Math.round(vh * 0.2),
    Math.round(vw * 0.8),
    Math.round(vh * 0.6),
    0,
    0,
    gridW,
    gridH
  );

  const data = ctx.getImageData(0, 0, gridW, gridH).data;
  const signature: number[] = [];
  let totalDiff = 0;

  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const idx = (y * gridW + x) * 4;
      const lum = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
      signature.push(lum);
      if (x > 0) {
        totalDiff += Math.abs(lum - signature[signature.length - 2]);
      }
    }
  }

  const edgeContrast = totalDiff / (gridW * gridH);
  return { signature, edgeContrast };
}

/**
 * Compares two frame signatures and returns average absolute luminance difference per cell.
 */
export function computeFrameSignatureDifference(sigA: number[], sigB: number[]): number {
  if (!sigA.length || sigA.length !== sigB.length) return 999;
  let sum = 0;
  for (let i = 0; i < sigA.length; i++) {
    sum += Math.abs(sigA[i] - sigB[i]);
  }
  return sum / sigA.length;
}

/**
 * Normalizes harmless formatting differences in part numbers while strictly preserving
 * leading zeros, hyphens, slashes, and alphanumeric characters.
 */
export function normalizePartNumberForComparison(raw: string): string {
  return (raw || '')
    .trim()
    .toUpperCase()
    .replace(/[–—−]/g, '-') // Normalize unicode dashes to ASCII hyphen
    .replace(/\s*-\s*/g, '-') // Collapse harmless spaces around hyphens
    .replace(/\s*\/\s*/g, '/') // Collapse harmless spaces around slashes
    .replace(/\s+/g, ' ');
}

/**
 * Evaluates how the extracted (or operator-edited) part number and quantity match
 * against the active delivery's compiled parts list.
 * Never auto-accepts a fuzzy or uncertain match.
 */
export function evaluatePalletLabelMatch(
  extractedPartNumber: string,
  extractedQuantity: number | null,
  docketParts: DeliveryPart[],
  ocrConfidence: 'high' | 'medium' | 'low' = 'high'
): PalletLabelMatchEvaluation {
  const normalizedTarget = normalizePartNumberForComparison(extractedPartNumber);
  const addedQty = Math.max(0, Math.round(extractedQuantity ?? 0));

  if (!normalizedTarget) {
    return {
      matchStatus: 'unmatched',
      matchedPart: null,
      candidateParts: [],
      statusColor: 'red',
      existingScannedQty: 0,
      addedPalletQty: addedQty,
      newTotalScannedQty: addedQty,
      expectedQty: 0,
    };
  }

  // 1. Check for strict exact match (preserving leading zeros, hyphens, alphanumeric chars)
  const exactMatches = docketParts.filter(
    (p) => normalizePartNumberForComparison(p.partNumber) === normalizedTarget
  );

  // If multiple lines share the same part number, prefer an outstanding or partially-scanned line first
  const matchedPart =
    exactMatches.find((p) => {
      const req = Math.max(1, p.quantity ?? 1);
      const rec = p.status === 'received' ? (p.receivedQuantity ?? req) : 0;
      return rec < req;
    }) ||
    exactMatches[0] ||
    null;

  if (matchedPart) {
    const expectedQty = Math.max(1, matchedPart.quantity ?? 1);
    const existingScannedQty =
      matchedPart.status === 'received'
        ? typeof matchedPart.receivedQuantity === 'number'
          ? matchedPart.receivedQuantity
          : expectedQty
        : 0;
    const newTotalScannedQty = existingScannedQty + addedQty;

    // If OCR confidence is very low, mark as uncertain so operator double-checks
    const matchStatus = ocrConfidence === 'low' ? 'uncertain' : 'exact_match';
    const isQuantityExact = addedQty > 0 && newTotalScannedQty === expectedQty;

    return {
      matchStatus,
      matchedPart,
      candidateParts: exactMatches,
      statusColor:
        matchStatus === 'uncertain'
          ? 'orange'
          : isQuantityExact
          ? 'green'
          : 'orange',
      existingScannedQty,
      addedPalletQty: addedQty,
      newTotalScannedQty,
      expectedQty,
    };
  }

  // 2. Check for close/candidate matches (e.g., 1-2 character OCR substitution like 0/O or 1/I/L, or substring)
  // NEVER automatically accept these — flag as 'uncertain' / 'unmatched' so operator must manually confirm/select.
  const strippedTarget = normalizedTarget.replace(/[-_\s/]/g, '');
  const candidateParts = docketParts.filter((p) => {
    const normP = normalizePartNumberForComparison(p.partNumber);
    const strippedP = normP.replace(/[-_\s/]/g, '');
    if (!strippedP || strippedTarget.length < 2) return false;
    if (strippedP === strippedTarget) return true;
    if (strippedP.includes(strippedTarget) || strippedTarget.includes(strippedP)) return true;
    // Levenshtein distance <= 2 for similar length strings
    if (Math.abs(strippedP.length - strippedTarget.length) <= 2) {
      return levenshteinDistance(strippedP, strippedTarget) <= 2;
    }
    return false;
  });

  return {
    matchStatus: candidateParts.length > 0 ? 'uncertain' : 'unmatched',
    matchedPart: null,
    candidateParts: candidateParts.slice(0, 5),
    statusColor: 'red',
    existingScannedQty: 0,
    addedPalletQty: addedQty,
    newTotalScannedQty: addedQty,
    expectedQty: 0,
  };
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

/**
 * Captures a frame from the live camera video element (or an uploaded/snapped image file),
 * crops to the pallet label guide box, corrects skew/rotation, and enhances contrast
 * before running completely offline on-device OCR.
 * Includes a multi-pass fallback on the full frame if the cropped pass yields insufficient text.
 */
export async function recognizePalletLabelOffline(
  source: HTMLVideoElement | File | string,
  docketParts: DeliveryPart[] = [],
  cropBoxRatio: { x: number; y: number; width: number; height: number } = {
    x: 0.05,
    y: 0.16,
    width: 0.9,
    height: 0.68,
  },
  onProgress?: (statusText: string, percent: number) => void
): Promise<PalletLabelExtractionResult> {
  const startTime = performance.now();
  latestProgressCallback = onProgress || null;

  try {
    onProgress?.('Capturing & enhancing camera frame...', 12);

    // 1. Capture, deskew, and enhance contrast gently
    const preprocessed = await captureAndPreprocessLabelImage(source, cropBoxRatio);

    // 2. Try Native Google ML Kit Text Recognition (Capacitor Android/iOS bridge) if running natively
    const mlKitResult = await tryNativeMlKitTextRecognition(preprocessed.enhancedOcrDataUrl);
    if (mlKitResult !== null) {
      const parsed = parsePalletLabelOcrText(mlKitResult.text, docketParts, mlKitResult.confidence);
      console.info(
        `[PartTrack OCR] Native ML Kit finished in ${Math.round(performance.now() - startTime)}ms:`,
        { partNumber: parsed.partNumber, quantity: parsed.quantity, description: parsed.description }
      );
      return {
        ...parsed,
        rawOcrText: mlKitResult.text,
        engineUsed: 'mlkit-native',
        croppedPreviewDataUrl: preprocessed.croppedPreviewDataUrl,
        enhancedOcrDataUrl: preprocessed.enhancedOcrDataUrl,
        detectedSkewDegrees: preprocessed.detectedSkewDegrees,
      };
    }

    // 3. Run bundled offline on-device LSTM OCR engine (/public/tesseract/)
    onProgress?.('Initializing offline OCR engine...', 25);
    const worker = await getOrInitWarmOnDeviceWorker();

    onProgress?.('Recognizing printed pallet label text...', 40);
    const ocrResult = await worker.recognize(
      preprocessed.enhancedOcrDataUrl,
      {},
      { text: true }
    );

    let rawText = (ocrResult?.data?.text || '').trim();
    let avgConf = typeof ocrResult?.data?.confidence === 'number' ? ocrResult.data.confidence : 80;
    let parsed = parsePalletLabelOcrText(rawText, docketParts, avgConf);

    // 4. Multi-Pass Fallback: If the cropped/enhanced pass didn't find a part number and we cropped a video frame,
    // run a second pass on the full un-enhanced color/grayscale frame so labels outside the guide box still read!
    if (
      !parsed.partNumber &&
      (cropBoxRatio.width < 0.94 || cropBoxRatio.height < 0.94 || rawText.length < 10)
    ) {
      onProgress?.('Running full-frame secondary OCR pass...', 75);
      const fullPreprocessed = await captureAndPreprocessLabelImage(
        source,
        { x: 0.01, y: 0.04, width: 0.98, height: 0.92 },
        true // raw grayscale without contrast clipping
      );
      const fallbackOcrResult = await worker.recognize(
        fullPreprocessed.enhancedOcrDataUrl,
        {},
        { text: true }
      );
      const fallbackText = (fallbackOcrResult?.data?.text || '').trim();
      const fallbackConf =
        typeof fallbackOcrResult?.data?.confidence === 'number'
          ? fallbackOcrResult.data.confidence
          : 78;
      const fallbackParsed = parsePalletLabelOcrText(fallbackText, docketParts, fallbackConf);

      if (
        fallbackParsed.partNumber ||
        fallbackText.length > rawText.length
      ) {
        rawText = [rawText, fallbackText].filter(Boolean).join('\n');
        avgConf = Math.max(avgConf, fallbackConf);
        parsed = parsePalletLabelOcrText(rawText, docketParts, avgConf);
      }
    }

    console.info(
      `[PartTrack OCR] On-device OCR finished in ${Math.round(performance.now() - startTime)}ms:`,
      {
        partNumber: parsed.partNumber || '(none)',
        description: parsed.description || '(none)',
        quantity: parsed.quantity,
        confidence: parsed.ocrConfidence,
        rawTextPreview: rawText.slice(0, 160).replace(/\n/g, ' | '),
      }
    );

    return {
      ...parsed,
      rawOcrText: rawText,
      engineUsed: 'on-device-bundled',
      croppedPreviewDataUrl: preprocessed.croppedPreviewDataUrl,
      enhancedOcrDataUrl: preprocessed.enhancedOcrDataUrl,
      detectedSkewDegrees: preprocessed.detectedSkewDegrees,
    };
  } finally {
    latestProgressCallback = null;
  }
}

/**
 * Attempts to invoke Google ML Kit Text Recognition on-device via Capacitor plugin or native WebView bridge.
 * Returns null when running in a standard Web browser so the bundled offline WASM engine is used.
 */
async function tryNativeMlKitTextRecognition(
  base64DataUrl: string
): Promise<{ text: string; confidence: number } | null> {
  if (typeof window === 'undefined') return null;

  try {
    const win = window as any;
    const rawBase64 = base64DataUrl.includes(',')
      ? base64DataUrl.split(',')[1]
      : base64DataUrl;

    // Check Capacitor ML Kit Text Recognition plugin
    const capPlugins = win.Capacitor?.Plugins;
    const mlKitPlugin =
      capPlugins?.CapacitorPluginMlKitTextRecognition ||
      capPlugins?.MlKitTextRecognition ||
      capPlugins?.TextRecognition;

    if (mlKitPlugin && typeof mlKitPlugin.detectText === 'function') {
      const res = await mlKitPlugin.detectText({
        base64Image: rawBase64,
        rotation: 0,
      });
      if (res && typeof res.text === 'string' && res.text.trim()) {
        return { text: res.text.trim(), confidence: 92 };
      }
    }

    // Check direct Android JavascriptInterface bridge if present
    if (win.AndroidMlKitOcr && typeof win.AndroidMlKitOcr.recognizeBase64 === 'function') {
      const text = await win.AndroidMlKitOcr.recognizeBase64(rawBase64);
      if (typeof text === 'string' && text.trim()) {
        return { text: text.trim(), confidence: 92 };
      }
    }
  } catch (err) {
    console.warn('[PartTrack OCR] Native ML Kit bridge fallback to bundled offline OCR:', err);
  }

  return null;
}

/**
 * Crops the camera frame or photo to the label region, upscales low-res camera crops smoothly,
 * estimates and corrects small rotation/skew angles, and applies smooth adaptive contrast stretching.
 */
async function captureAndPreprocessLabelImage(
  source: HTMLVideoElement | File | string,
  cropBoxRatio: { x: number; y: number; width: number; height: number },
  gentleMode: boolean = false
): Promise<{
  croppedPreviewDataUrl: string;
  enhancedOcrDataUrl: string;
  detectedSkewDegrees: number;
}> {
  const sourceCanvas = document.createElement('canvas');
  const sCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });

  if (!sCtx) {
    throw new Error('Canvas 2D context unavailable for label preprocessing.');
  }

  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    const vw = source.videoWidth || 1920;
    const vh = source.videoHeight || 1080;
    const sx = Math.max(0, Math.round(vw * cropBoxRatio.x));
    const sy = Math.max(0, Math.round(vh * cropBoxRatio.y));
    const sw = Math.max(64, Math.min(vw - sx, Math.round(vw * cropBoxRatio.width)));
    const sh = Math.max(64, Math.min(vh - sy, Math.round(vh * cropBoxRatio.height)));

    // Upscale smaller video crops to at least 1100px width so Tesseract LSTM character height is optimal
    const minTargetW = 1100;
    const scale = sw < minTargetW ? Math.min(2.2, minTargetW / sw) : 1;
    const tw = Math.round(sw * scale);
    const th = Math.round(sh * scale);

    sourceCanvas.width = tw;
    sourceCanvas.height = th;
    sCtx.imageSmoothingEnabled = true;
    sCtx.imageSmoothingQuality = 'high';
    sCtx.drawImage(source, sx, sy, sw, sh, 0, 0, tw, th);
  } else {
    const imgUrl =
      typeof source === 'string' ? source : await readFileAsDataUrl(source as File);
    const img = await loadImage(imgUrl);
    const iw = img.naturalWidth || img.width || 1200;
    const ih = img.naturalHeight || img.height || 900;

    // Limit max dimension to 1600px for fast on-device processing while preserving crisp label text
    const maxDim = 1600;
    const minDim = 1000;
    let scale = 1;
    if (Math.max(iw, ih) > maxDim) {
      scale = maxDim / Math.max(iw, ih);
    } else if (Math.max(iw, ih) < minDim) {
      scale = Math.min(2.0, minDim / Math.max(iw, ih));
    }
    const tw = Math.max(64, Math.round(iw * scale));
    const th = Math.max(64, Math.round(ih * scale));

    sourceCanvas.width = tw;
    sourceCanvas.height = th;
    sCtx.imageSmoothingEnabled = true;
    sCtx.imageSmoothingQuality = 'high';
    sCtx.drawImage(img, 0, 0, tw, th);
  }

  const croppedPreviewDataUrl = sourceCanvas.toDataURL('image/jpeg', 0.92);

  // Estimate skew angle (-5° to +5°) and deskew if tilted
  const skewDegrees = gentleMode ? 0 : estimateLabelSkewAngle(sourceCanvas);
  const deskewedCanvas =
    Math.abs(skewDegrees) >= 0.8
      ? rotateCanvas(sourceCanvas, -skewDegrees)
      : sourceCanvas;

  // Enhance contrast smoothly without salt-and-pepper noise amplification
  const enhancedCanvas = enhanceLabelContrastSmoothly(deskewedCanvas, gentleMode);
  const enhancedOcrDataUrl = enhancedCanvas.toDataURL('image/jpeg', 0.95);

  return {
    croppedPreviewDataUrl,
    enhancedOcrDataUrl,
    detectedSkewDegrees: skewDegrees,
  };
}

/**
 * Estimates horizontal text line skew angle between -5° and +5° by maximizing
 * horizontal projection profile variance on downsampled dark text edges.
 */
function estimateLabelSkewAngle(canvas: HTMLCanvasElement): number {
  const sampleW = 240;
  const sampleH = Math.max(80, Math.round((canvas.height / canvas.width) * sampleW));
  const temp = document.createElement('canvas');
  temp.width = sampleW;
  temp.height = sampleH;
  const ctx = temp.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;

  ctx.drawImage(canvas, 0, 0, sampleW, sampleH);
  const data = ctx.getImageData(0, 0, sampleW, sampleH).data;

  // Binary horizontal gradient map (highlights text baselines)
  const edges = new Uint8Array(sampleW * sampleH);
  for (let y = 1; y < sampleH - 1; y++) {
    for (let x = 1; x < sampleW - 1; x++) {
      const idx = (y * sampleW + x) * 4;
      const idxAbove = ((y - 1) * sampleW + x) * 4;
      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      const lumAbove =
        0.299 * data[idxAbove] + 0.587 * data[idxAbove + 1] + 0.114 * data[idxAbove + 2];
      if (Math.abs(lum - lumAbove) > 28) {
        edges[y * sampleW + x] = 1;
      }
    }
  }

  let bestAngle = 0;
  let maxVariance = -1;
  const cx = sampleW / 2;

  for (let deg = -5; deg <= 5; deg += 1) {
    const rad = (deg * Math.PI) / 180;
    const tan = Math.tan(rad);
    const hist = new Uint16Array(sampleH);

    for (let y = 4; y < sampleH - 4; y++) {
      const rowOffset = y * sampleW;
      for (let x = 8; x < sampleW - 8; x++) {
        if (edges[rowOffset + x]) {
          const projectedY = Math.round(y + (x - cx) * tan);
          if (projectedY >= 0 && projectedY < sampleH) {
            hist[projectedY]++;
          }
        }
      }
    }

    let sum = 0;
    let sumSq = 0;
    for (let y = 0; y < sampleH; y++) {
      const v = hist[y];
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / sampleH;
    const variance = sumSq / sampleH - mean * mean;
    if (variance > maxVariance) {
      maxVariance = variance;
      bestAngle = deg;
    }
  }

  return bestAngle;
}

function rotateCanvas(canvas: HTMLCanvasElement, degrees: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  if (!ctx) return canvas;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

/**
 * Applies a sparse-text-safe luminance normalization (0.25th-to-96th percentile with black/white point guards),
 * a 3x3 unsharp mask filter for crisp character strokes on small/faded printed labels, and a 16px white quiet-zone border.
 * Kept strictly isolated to OCR label recognition so barcode/QR fast-paths incur zero preprocessing overhead.
 */
export function enhanceLabelContrastSmoothly(
  canvas: HTMLCanvasElement,
  gentleMode: boolean = false
): HTMLCanvasElement {
  const srcW = canvas.width;
  const srcH = canvas.height;
  const pad = 16;
  const w = srcW + pad * 2;
  const h = srcH + pad * 2;

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  if (!ctx) return canvas;

  // Fill clean white quiet-zone border around the image (Tesseract LSTM performs significantly better with a quiet border)
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(canvas, pad, pad);

  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const numPixels = w * h;

  const lum = new Uint8Array(numPixels);
  const hist = new Uint32Array(256);

  for (let i = 0; i < numPixels; i++) {
    const idx = i * 4;
    const v = Math.round(0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]);
    lum[i] = v;
    hist[v]++;
  }

  // Use 0.25th percentile for dark ink so labels with sparse printed text (<1.5% ink coverage) never clip dark strokes
  const lowTarget = Math.max(1, Math.floor(numPixels * (gentleMode ? 0.0015 : 0.0025)));
  const highTarget = Math.floor(numPixels * (gentleMode ? 0.98 : 0.95));
  let cum = 0;
  let pLow = 0;
  let pHigh = 255;

  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (cum <= lowTarget) pLow = v;
    if (cum <= highTarget) pHigh = v;
  }

  // Guard black & white points so a mostly-white label never stretches grey paper grain into black ink
  pLow = Math.min(pLow, 145);
  pHigh = Math.max(pHigh, pLow + 55, 175);
  const range = Math.max(55, pHigh - pLow);

  const normLum = new Uint8Array(numPixels);
  for (let i = 0; i < numPixels; i++) {
    const norm = Math.min(1, Math.max(0, (lum[i] - pLow) / range));
    normLum[i] = Math.round(norm * 255);
  }

  // Apply 3x3 unsharp mask to sharpen character edges, hyphens, and small digits
  const sharpenAmount = gentleMode ? 0.35 : 0.65;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const center = normLum[i];
      // 3x3 box blur approximation around center pixel
      const blur =
        (normLum[i - w - 1] +
          normLum[i - w] +
          normLum[i - w + 1] +
          normLum[i - 1] +
          center +
          normLum[i + 1] +
          normLum[i + w - 1] +
          normLum[i + w] +
          normLum[i + w + 1]) /
        9;
      const sharpened = Math.min(
        255,
        Math.max(0, Math.round(center + (center - blur) * sharpenAmount))
      );
      const idx = i * 4;
      data[idx] = sharpened;
      data[idx + 1] = sharpened;
      data[idx + 2] = sharpened;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return out;
}

/**
 * Intelligent Layout-Aware & Heading-Aware Pallet Label Parser
 * Extracts:
 * - Part Number (treated strictly as string preserving leading zeros & hyphens)
 * - Description
 * - Quantity
 * Ignores order numbers, PO numbers, dates, pallet numbers ("Pallet 1 of 6"), weights, and dimensions.
 */
export function parsePalletLabelOcrText(
  rawText: string,
  docketParts: DeliveryPart[] = [],
  avgConfidenceScore: number = 85
): {
  partNumber: string;
  description: string;
  quantity: number | null;
  ocrConfidence: 'high' | 'medium' | 'low';
} {
  const cleanLines = (rawText || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/[|¦]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);

  let extractedPartNumber = '';
  let extractedDescription = '';
  let extractedQuantity: number | null = null;

  // Regex patterns for irrelevant fields that must NEVER be mistaken for Part Number or Quantity
  const isDateString = (s: string) =>
    /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2})\b/.test(s);
  const isIrrelevantHeadingLine = (s: string) =>
    /^(?:ORDER\s*(?:NO|#|NUMBER)?|P\.?O\.?\s*(?:NO|#)?|PURCHASE\s*ORDER|SALES\s*ORDER|S\.?O\.?\s*#|JOB\s*(?:NO|#)|WORK\s*ORDER|DOCKET\s*(?:NO|#)?|DATE|DELIVERY\s*DATE|PRINTED|CUSTOMER|SUPPLIER|CARRIER|WEIGHT|GROSS|NET|PALLET\s*(?:NO|#|ID)?|SKID)\b/i.test(
      s
    );

  // 1. Check for explicit field headings (Inline or Stacked on next line)
  const partHeadingRegex =
    /^(?:PART\s*(?:NO\.?|NUMBER|#|CODE|ID)?|P\/N|PN|ITEM\s*(?:CODE|NO\.?|NUMBER)|DRAWING\s*(?:NO\.?|NUMBER|#)?|DRG\s*(?:NO\.?|#)?|DWG\s*(?:NO\.?|#)?|MATERIAL\s*(?:NO\.?|CODE)|ARTICLE\s*(?:NO\.?)?)\s*[:#.-]?\s*(.*)$/i;
  const descHeadingRegex =
    /^(?:PART\s*DESCRIPTION|DESCRIPTION|DESC\.?|PART\s*NAME|ITEM\s*DESCRIPTION|COMPONENT|TITLE)\s*[:#.-]?\s*(.*)$/i;
  const qtyHeadingRegex =
    /^(?:PALLET\s*QTY|PACK\s*QTY|BOX\s*QTY|QUANTITY|QTY\.?|Q'TY|PIECES|PCS|COUNT|TOTAL\s*QTY|UNITS)\s*[:#.-]?\s*(.*)$/i;

  for (let i = 0; i < cleanLines.length; i++) {
    const line = cleanLines[i];

    // Check if a single line contains both Part Number and Quantity headings (e.g. "PART NO: 0045-PLT-102   QTY: 24")
    const inlineQtyInLine = line.match(
      /\b(?:PALLET\s*QTY|PACK\s*QTY|QUANTITY|QTY\.?|PCS|PIECES)\s*[:#=-]?\s*(\d{1,5})\b/i
    );
    if (inlineQtyInLine && extractedQuantity === null) {
      const qVal = parseInt(inlineQtyInLine[1], 10);
      if (!Number.isNaN(qVal) && qVal > 0 && qVal < 50000) {
        extractedQuantity = qVal;
      }
    }

    // Remove trailing inline QTY segment before testing Part/Desc headings
    const lineWithoutTrailingQty = line
      .replace(/\b(?:PALLET\s*QTY|PACK\s*QTY|QUANTITY|QTY\.?|PCS|PIECES)\s*[:#=-]?\s*\d+.*$/i, '')
      .trim();

    // A. Part Number Heading
    if (!extractedPartNumber) {
      const partMatch = lineWithoutTrailingQty.match(partHeadingRegex);
      if (partMatch) {
        const inlineVal = cleanCandidatePartToken(partMatch[1]);
        if (isValidPartNumberCandidate(inlineVal)) {
          extractedPartNumber = inlineVal;
          continue;
        } else if (i + 1 < cleanLines.length) {
          const nextLineVal = cleanCandidatePartToken(cleanLines[i + 1]);
          if (
            isValidPartNumberCandidate(nextLineVal) &&
            !descHeadingRegex.test(cleanLines[i + 1]) &&
            !qtyHeadingRegex.test(cleanLines[i + 1])
          ) {
            extractedPartNumber = nextLineVal;
            continue;
          }
        }
      }
    }

    // B. Description Heading
    if (!extractedDescription) {
      const descMatch = lineWithoutTrailingQty.match(descHeadingRegex);
      if (descMatch) {
        const inlineDesc = descMatch[1].trim();
        if (inlineDesc.length >= 2 && !/^(?:QTY|QUANTITY|PART\s*NO)\b/i.test(inlineDesc)) {
          extractedDescription = inlineDesc;
          continue;
        } else if (i + 1 < cleanLines.length) {
          const nextLine = cleanLines[i + 1].trim();
          if (
            nextLine.length >= 2 &&
            !partHeadingRegex.test(nextLine) &&
            !qtyHeadingRegex.test(nextLine) &&
            !isIrrelevantHeadingLine(nextLine)
          ) {
            extractedDescription = nextLine;
            continue;
          }
        }
      }
    }

    // C. Quantity Heading
    if (extractedQuantity === null) {
      const qtyMatch = line.match(qtyHeadingRegex);
      if (qtyMatch) {
        const parsedInlineQty = extractCleanQuantityFromSegment(qtyMatch[1]);
        if (parsedInlineQty !== null) {
          extractedQuantity = parsedInlineQty;
          continue;
        } else if (i + 1 < cleanLines.length) {
          const parsedNextLineQty = extractCleanQuantityFromSegment(cleanLines[i + 1]);
          if (parsedNextLineQty !== null) {
            extractedQuantity = parsedNextLineQty;
            continue;
          }
        }
      }
    }
  }

  // 2. If Part Number wasn't found via explicit heading, check if any token/line matches a known part number on the compiled parts list
  if (!extractedPartNumber && docketParts.length > 0) {
    for (const line of cleanLines) {
      if (isIrrelevantHeadingLine(line)) continue;
      const tokens = line.split(/\s+/);
      for (const p of docketParts) {
        const normDocketPart = normalizePartNumberForComparison(p.partNumber);
        if (!normDocketPart) continue;
        if (normalizePartNumberForComparison(line) === normDocketPart) {
          extractedPartNumber = p.partNumber;
          break;
        }
        for (const tok of tokens) {
          const cleanedTok = cleanCandidatePartToken(tok);
          if (normalizePartNumberForComparison(cleanedTok) === normDocketPart) {
            extractedPartNumber = cleanedTok;
            break;
          }
        }
        if (extractedPartNumber) break;
      }
      if (extractedPartNumber) break;
    }
  }

  // 3. Fallback heuristic for Part Number: look for a distinct alphanumeric part-number code line
  // (excluding dates, order/PO numbers, pallet X of Y, dimensions, weights)
  if (!extractedPartNumber) {
    for (const line of cleanLines) {
      if (isIrrelevantHeadingLine(line) || isDateString(line)) continue;
      if (/\bPALLET\s+\d+\s+OF\s+\d+/i.test(line)) continue;
      if (/\b\d+\s*[X×]\s*\d+/i.test(line)) continue; // Exclude dimensions like 1200 x 800

      const candidate = cleanCandidatePartToken(line);
      if (
        isValidPartNumberCandidate(candidate) &&
        /[A-Z]/i.test(candidate) &&
        /\d/.test(candidate)
      ) {
        extractedPartNumber = candidate;
        break;
      }
    }
  }

  // 4. Fallback heuristic for Quantity: look for patterns like "24 PCS", "24 EA", "QTY 24"
  if (extractedQuantity === null) {
    for (const line of cleanLines) {
      if (isIrrelevantHeadingLine(line) || isDateString(line)) continue;
      if (/\bPALLET\s+\d+\s+OF\s+\d+/i.test(line)) continue;

      const pcsMatch = line.match(/\b(\d{1,5})\s*(?:PCS|PIECES|EA|EACH|UNITS|OFF)\b/i);
      if (pcsMatch) {
        const q = parseInt(pcsMatch[1], 10);
        if (!Number.isNaN(q) && q > 0 && q < 50000) {
          extractedQuantity = q;
          break;
        }
      }
    }
  }

  // 5. Fallback heuristic for Description: pick the cleanest descriptive line that isn't a heading, part number, or metadata
  if (!extractedDescription) {
    for (const line of cleanLines) {
      if (isIrrelevantHeadingLine(line) || isDateString(line)) continue;
      if (partHeadingRegex.test(line) || qtyHeadingRegex.test(line) || descHeadingRegex.test(line)) {
        continue;
      }
      if (
        extractedPartNumber &&
        normalizePartNumberForComparison(line).includes(
          normalizePartNumberForComparison(extractedPartNumber)
        )
      ) {
        continue;
      }
      if (/^(?:LASER\s*CENTRAL|GCI|PALLET\s*LABEL|DELIVERY\s*LABEL)\b/i.test(line)) {
        continue;
      }
      if (/[A-Za-z]{3,}/.test(line) && line.length >= 4 && line.length <= 80) {
        extractedDescription = line;
        break;
      }
    }
  }

  // If matched to a docket part and description wasn't clearly read, populate from docket part
  if (!extractedDescription && extractedPartNumber && docketParts.length > 0) {
    const matched = docketParts.find(
      (p) =>
        normalizePartNumberForComparison(p.partNumber) ===
        normalizePartNumberForComparison(extractedPartNumber)
    );
    if (matched) {
      extractedDescription = matched.description;
    }
  }

  const ocrConfidence: 'high' | 'medium' | 'low' =
    extractedPartNumber && extractedQuantity !== null && avgConfidenceScore >= 70
      ? 'high'
      : extractedPartNumber
      ? 'medium'
      : 'low';

  return {
    partNumber: extractedPartNumber,
    description: extractedDescription,
    quantity: extractedQuantity,
    ocrConfidence,
  };
}

function cleanCandidatePartToken(raw: string): string {
  // Strip surrounding label punctuation while keeping leading zeros, hyphens, underscores, slashes, and dots
  const trimmed = (raw || '')
    .trim()
    .replace(/^[:#=\s]+/, '')
    .replace(/\s+(?:QTY|QUANTITY|DESC|DESCRIPTION)\b.*$/i, '')
    .trim();

  // If single token or hyphenated code with spaces around hyphen ("0045 - PLT - 102")
  const collapsedHyphens = trimmed.replace(/\s*([-\/])\s*/g, '$1');
  const firstToken = collapsedHyphens.split(/\s+/)[0] || '';
  return firstToken.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
}

function isValidPartNumberCandidate(token: string): boolean {
  if (!token || token.length < 2 || token.length > 36) return false;
  if (/^(?:PART|NUMBER|NO|CODE|DESCRIPTION|DESC|QTY|QUANTITY|PALLET|ORDER|DATE|PO|KG|MM)$/i.test(token)) {
    return false;
  }
  // Must not be a date like 06/11/2026
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(token)) return false;
  // Must contain at least one digit or letter
  return /[A-Za-z0-9]/.test(token);
}

function extractCleanQuantityFromSegment(segment: string): number | null {
  const s = (segment || '').trim();
  if (!s) return null;

  // Ignore "1 OF 6" pallet indicators or measurements like "10MM", "120KG"
  const withoutPalletOf = s.replace(/\b\d+\s*OF\s*\d+\b/gi, '');
  const withoutUnits = withoutPalletOf.replace(/\b\d+(?:\.\d+)?\s*(?:MM|CM|M|KG|LB|G)\b/gi, '');

  const match = withoutUnits.match(/(?:^|[^0-9A-Za-z-])(\d{1,5})(?:\s*(?:PCS|PIECES|EA|EACH|UNITS|OFF))?(?:$|[^0-9A-Za-z-])/i);
  if (!match) return null;

  const val = parseInt(match[1], 10);
  if (Number.isNaN(val) || val <= 0 || val > 50000) return null;
  return val;
}

/**
 * Generates a realistic high-resolution printed pallet label image (DataURL)
 * for testing the OCR Label Scanner (including multi-pallet split quantities,
 * irrelevant PO/Date/Pallet metadata to verify intelligent field extraction, and leading zeros).
 */
export function generateSamplePalletLabelDataUrl(options: {
  partNumber: string;
  description: string;
  quantity: number;
  orderNumber?: string;
  palletIndex?: number;
  totalPallets?: number;
  date?: string;
}): string {
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 560;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // Warm industrial pallet background border
  ctx.fillStyle = '#27272A';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // White paper pallet label
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(28, 24, canvas.width - 56, canvas.height - 48);

  // Outer label border & divider lines
  ctx.strokeStyle = '#18181B';
  ctx.lineWidth = 3;
  ctx.strokeRect(44, 40, canvas.width - 88, canvas.height - 80);

  // Header bar (Irrelevant metadata: Order No, Date, Pallet X of Y)
  ctx.fillStyle = '#18181B';
  ctx.font = 'bold 20px monospace';
  ctx.fillText(`ORDER NO: ${options.orderNumber || 'PO-884920'}`, 64, 82);
  ctx.fillText(`DATE: ${options.date || '2026-11-06'}`, 390, 82);
  ctx.fillText(
    `PALLET ${options.palletIndex || 1} OF ${options.totalPallets || 2}`,
    645,
    82
  );

  ctx.beginPath();
  ctx.moveTo(44, 102);
  ctx.lineTo(canvas.width - 44, 102);
  ctx.stroke();

  // Section 1: PART NUMBER
  ctx.font = 'bold 22px sans-serif';
  ctx.fillStyle = '#52525B';
  ctx.fillText('PART NUMBER:', 64, 148);

  ctx.font = 'bold 46px monospace';
  ctx.fillStyle = '#000000';
  ctx.fillText(options.partNumber, 64, 206);

  ctx.beginPath();
  ctx.moveTo(44, 232);
  ctx.lineTo(canvas.width - 44, 232);
  ctx.stroke();

  // Section 2: DESCRIPTION
  ctx.font = 'bold 22px sans-serif';
  ctx.fillStyle = '#52525B';
  ctx.fillText('DESCRIPTION:', 64, 276);

  ctx.font = 'bold 30px sans-serif';
  ctx.fillStyle = '#000000';
  ctx.fillText((options.description || 'LASER CUT STEEL COMPONENT').slice(0, 38), 64, 326);

  ctx.beginPath();
  ctx.moveTo(44, 356);
  ctx.lineTo(canvas.width - 44, 356);
  ctx.stroke();

  // Section 3: QUANTITY + Irrelevant Weight metadata
  ctx.font = 'bold 22px sans-serif';
  ctx.fillStyle = '#52525B';
  ctx.fillText('QUANTITY:', 64, 404);

  ctx.font = 'bold 54px monospace';
  ctx.fillStyle = '#000000';
  ctx.fillText(`${options.quantity} PCS`, 64, 472);

  ctx.font = 'bold 20px monospace';
  ctx.fillStyle = '#52525B';
  ctx.fillText('GROSS WEIGHT: 185 KG', 520, 456);

  return canvas.toDataURL('image/jpeg', 0.95);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (e) => reject(e);
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}
