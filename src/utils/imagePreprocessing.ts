/**
 * Image preprocessing for industrial laser cutting and fabrication delivery dockets.
 * Optimizes photos and scans for on-device Tesseract OCR while guaranteeing:
 * - Accurate first-crossing histogram percentile calculation (never overwriting reached thresholds)
 * - Preservation of sparse dark text (< 1% and 1-2% dark pixels) on white pages
 * - Automatic inversion recovery for predominantly dark documents (white text on dark background)
 * - Contrast recovery for low-contrast scans and shadowed camera photos
 * - Division-by-zero prevention and post-processing safeguards against all-black/all-white output
 */

export interface ImagePreprocessingDiagnostics {
  pLow: number;
  pHigh: number;
  effectiveRange: number;
  inputMinLum: number;
  inputMaxLum: number;
  inputMedianLum: number;
  meanLuminanceAfter: number;
  whitePixelRatioAfter: number;
  darkPixelRatioAfter: number;
  wasInvertedFromDarkBackground: boolean;
  safeguardTriggered: boolean;
  durationMs: number;
}

export interface PreprocessedImageResult {
  ocrDataUrl: string;       // Clean grayscale, contrast-normalized image for Tesseract LSTM
  displayDataUrl: string;   // Clean original photo for UI review and IndexedDB storage
  width: number;
  height: number;
  diagnostics: ImagePreprocessingDiagnostics;
}

/**
 * Computes the exact luminance bin [0..255] at which the cumulative histogram first reaches
 * `quantile` (0..1). Stops immediately once reached so empty bins never overwrite the threshold.
 */
export function computeHistogramPercentile(
  hist: Uint32Array,
  totalPixels: number,
  quantile: number
): number {
  if (totalPixels <= 0) return 0;
  const clampedQ = Math.min(1, Math.max(0, quantile));
  const targetCount = Math.max(1, Math.ceil(totalPixels * clampedQ));
  let cumulative = 0;

  for (let v = 0; v < 256; v++) {
    cumulative += hist[v];
    if (cumulative >= targetCount) {
      return v;
    }
  }
  return 255;
}

/**
 * Normalizes grayscale luminance values for document OCR across:
 * 1. White documents with < 1% dark pixels
 * 2. White documents with 1-2% dark pixels
 * 3. Normal printed documents (2-15% dark pixels)
 * 4. Low-contrast scans (faded gray text on gray background)
 * 5. Photographed documents with shadows
 * 6. Predominantly dark documents (light text on dark background)
 */
export function normalizeDocumentLuminances(
  luminances: Uint8Array,
  providedHist?: Uint32Array
): {
  output: Uint8Array;
  pLow: number;
  pHigh: number;
  effectiveRange: number;
  inputMinLum: number;
  inputMaxLum: number;
  inputMedianLum: number;
  meanLuminanceAfter: number;
  whitePixelRatioAfter: number;
  darkPixelRatioAfter: number;
  wasInvertedFromDarkBackground: boolean;
  safeguardTriggered: boolean;
} {
  const numPixels = luminances.length;
  if (numPixels === 0) {
    return {
      output: new Uint8Array(0),
      pLow: 0,
      pHigh: 255,
      effectiveRange: 255,
      inputMinLum: 255,
      inputMaxLum: 255,
      inputMedianLum: 255,
      meanLuminanceAfter: 255,
      whitePixelRatioAfter: 1,
      darkPixelRatioAfter: 0,
      wasInvertedFromDarkBackground: false,
      safeguardTriggered: false,
    };
  }

  // Build or validate 256-bin histogram
  const rawHist = new Uint32Array(256);
  let histTotal = 0;
  if (providedHist && providedHist.length === 256) {
    for (let v = 0; v < 256; v++) {
      rawHist[v] = providedHist[v];
      histTotal += providedHist[v];
    }
  }
  if (histTotal !== numPixels) {
    rawHist.fill(0);
    for (let i = 0; i < numPixels; i++) {
      rawHist[luminances[i]]++;
    }
  }

  const rawMedian = computeHistogramPercentile(rawHist, numPixels, 0.5);
  let darkPixelsInput = 0;
  let lightPixelsInput = 0;
  for (let v = 0; v < 110; v++) darkPixelsInput += rawHist[v];
  for (let v = 145; v < 256; v++) lightPixelsInput += rawHist[v];

  // Detect predominantly dark documents (e.g. white text on dark background) and invert to dark-on-light
  const wasInvertedFromDarkBackground =
    rawMedian < 105 && darkPixelsInput > lightPixelsInput * 1.5;

  let workingLum = luminances;
  const workingHist = new Uint32Array(256);

  if (wasInvertedFromDarkBackground) {
    workingLum = new Uint8Array(numPixels);
    for (let i = 0; i < numPixels; i++) {
      workingLum[i] = 255 - luminances[i];
    }
    for (let v = 0; v < 256; v++) {
      workingHist[255 - v] = rawHist[v];
    }
  } else {
    workingHist.set(rawHist);
  }

  let inputMinLum = 255;
  let inputMaxLum = 0;
  for (let v = 0; v < 256; v++) {
    if (workingHist[v] > 0) {
      if (v < inputMinLum) inputMinLum = v;
      if (v > inputMaxLum) inputMaxLum = v;
    }
  }
  if (inputMinLum > inputMaxLum) {
    inputMinLum = 255;
    inputMaxLum = 255;
  }

  const p0005 = computeHistogramPercentile(workingHist, numPixels, 0.0005);
  const p002 = computeHistogramPercentile(workingHist, numPixels, 0.002);
  const p005 = computeHistogramPercentile(workingHist, numPixels, 0.005);
  const p01 = computeHistogramPercentile(workingHist, numPixels, 0.01);
  const p02 = computeHistogramPercentile(workingHist, numPixels, 0.02);
  const p35 = computeHistogramPercentile(workingHist, numPixels, 0.35);
  const p50 = computeHistogramPercentile(workingHist, numPixels, 0.5);
  const p85 = computeHistogramPercentile(workingHist, numPixels, 0.85);
  const p98 = computeHistogramPercentile(workingHist, numPixels, 0.98);

  // Determine paper background white threshold (pHigh):
  // - If the page has shadows (e.g. p35 is still light paper >= 135 while p85 is brighter >= 195),
  //   anchor pHigh near the shadowed paper band so shadows normalize to clean white.
  // - Otherwise anchor pHigh to the upper paper luminance (p85..p98).
  let pHigh: number;
  if (p35 >= 130 && p85 - p35 >= 25) {
    // Shadowed document: lift shadowed paper (above p35) into clean white background
    pHigh = Math.max(145, Math.min(p85, Math.round(p35 + (p85 - p35) * 0.35)));
  } else {
    pHigh = Math.max(150, Math.min(255, Math.max(p50, p85)));
  }

  // Determine foreground dark ink threshold (pLow):
  // Never allow pLow to jump into the paper background when dark text is < 1% or 1-2% of pixels.
  const maxAllowedInkThreshold = Math.min(165, pHigh - 16, p50 - 12);
  const candidates = [p02, p01, p005, p002, p0005, inputMinLum];
  let pLow = 0;

  for (const cand of candidates) {
    if (cand <= maxAllowedInkThreshold) {
      pLow = cand;
      break;
    }
  }

  const rawSpread = inputMaxLum - inputMinLum;
  let safeguardTriggered = false;

  // Handle uniform/blank images (prevent division by zero and noise amplification)
  if (rawSpread < 10 || pHigh <= pLow + 8) {
    pLow = 0;
    pHigh = 255;
  }

  const effectiveRange = Math.max(18, pHigh - pLow);
  // Use slightly stronger gamma on low-contrast scans to crisp up faint characters without clipping
  const isLowContrast = rawSpread >= 10 && rawSpread <= 90;
  const gamma = isLowContrast ? 1.35 : 1.12;

  const output = new Uint8Array(numPixels);
  let sumLum = 0;
  let whiteCount = 0;
  let darkCount = 0;

  for (let i = 0; i < numPixels; i++) {
    const lum = workingLum[i];
    let finalVal: number;
    if (rawSpread < 10) {
      finalVal = lum >= 128 ? 255 : lum;
    } else if (lum <= pLow) {
      finalVal = 0;
    } else if (lum >= pHigh) {
      finalVal = 255;
    } else {
      const normalized = (lum - pLow) / effectiveRange;
      finalVal = Math.round(Math.pow(normalized, gamma) * 255);
    }
    output[i] = finalVal;
    sumLum += finalVal;
    if (finalVal >= 215) whiteCount++;
    if (finalVal <= 85) darkCount++;
  }

  let meanLuminanceAfter = Math.round(sumLum / numPixels);
  let whitePixelRatioAfter = Number((whiteCount / numPixels).toFixed(4));
  let darkPixelRatioAfter = Number((darkCount / numPixels).toFixed(4));

  // Safeguard against inverted, completely black, or completely white destroyed output
  const hadReadableContrastInput = rawSpread >= 15 && inputMinLum < p50 - 10;
  const destroyedForeground = hadReadableContrastInput && darkCount === 0;
  const turnedMostlyBlack = whitePixelRatioAfter < 0.35 || darkPixelRatioAfter > 0.65 || meanLuminanceAfter < 115;

  if (turnedMostlyBlack || destroyedForeground) {
    safeguardTriggered = true;
    const safeLow = Math.min(80, inputMinLum);
    const safeHigh = Math.max(safeLow + 80, Math.min(255, Math.max(180, p98)));
    const safeRange = Math.max(50, safeHigh - safeLow);

    sumLum = 0;
    whiteCount = 0;
    darkCount = 0;

    for (let i = 0; i < numPixels; i++) {
      const lum = workingLum[i];
      const finalVal =
        lum <= safeLow
          ? 0
          : lum >= safeHigh
          ? 255
          : Math.round(((lum - safeLow) / safeRange) * 255);
      output[i] = finalVal;
      sumLum += finalVal;
      if (finalVal >= 215) whiteCount++;
      if (finalVal <= 85) darkCount++;
    }

    pLow = safeLow;
    pHigh = safeHigh;
    meanLuminanceAfter = Math.round(sumLum / numPixels);
    whitePixelRatioAfter = Number((whiteCount / numPixels).toFixed(4));
    darkPixelRatioAfter = Number((darkCount / numPixels).toFixed(4));
  }

  return {
    output,
    pLow,
    pHigh,
    effectiveRange,
    inputMinLum,
    inputMaxLum,
    inputMedianLum: p50,
    meanLuminanceAfter,
    whitePixelRatioAfter,
    darkPixelRatioAfter,
    wasInvertedFromDarkBackground,
    safeguardTriggered,
  };
}

/**
 * Processes raw RGBA pixel buffer in-place using `normalizeDocumentLuminances`.
 * Used by both browser Canvas 2D context and headless/automated browser tests.
 */
export function preprocessRgbaImageBufferInPlace(
  rgbaData: Uint8ClampedArray | Uint8Array,
  width?: number,
  height?: number
): ImagePreprocessingDiagnostics & { invertedDarkDocument: boolean } {
  const startMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const maxPixelsFromBuffer = Math.floor(rgbaData.length / 4);
  const numPixels =
    typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
      ? Math.min(width * height, maxPixelsFromBuffer)
      : maxPixelsFromBuffer;
  const luminances = new Uint8Array(numPixels);
  const hist = new Uint32Array(256);

  for (let i = 0; i < numPixels; i++) {
    const idx = i * 4;
    const alpha = rgbaData[idx + 3];
    // Composite transparent pixels over white paper background
    const r = alpha < 255 ? Math.round((rgbaData[idx] * alpha + 255 * (255 - alpha)) / 255) : rgbaData[idx];
    const g = alpha < 255 ? Math.round((rgbaData[idx + 1] * alpha + 255 * (255 - alpha)) / 255) : rgbaData[idx + 1];
    const b = alpha < 255 ? Math.round((rgbaData[idx + 2] * alpha + 255 * (255 - alpha)) / 255) : rgbaData[idx + 2];
    const lum = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    luminances[i] = lum;
    hist[lum]++;
  }

  const norm = normalizeDocumentLuminances(luminances, hist);

  for (let i = 0; i < numPixels; i++) {
    const idx = i * 4;
    const finalVal = norm.output[i];
    rgbaData[idx] = finalVal;
    rgbaData[idx + 1] = finalVal;
    rgbaData[idx + 2] = finalVal;
    rgbaData[idx + 3] = 255;
  }

  const durationMs = Math.max(
    1,
    Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startMs)
  );

  return {
    pLow: norm.pLow,
    pHigh: norm.pHigh,
    effectiveRange: norm.effectiveRange,
    inputMinLum: norm.inputMinLum,
    inputMaxLum: norm.inputMaxLum,
    inputMedianLum: norm.inputMedianLum,
    meanLuminanceAfter: norm.meanLuminanceAfter,
    whitePixelRatioAfter: norm.whitePixelRatioAfter,
    darkPixelRatioAfter: norm.darkPixelRatioAfter,
    wasInvertedFromDarkBackground: norm.wasInvertedFromDarkBackground,
    invertedDarkDocument: norm.wasInvertedFromDarkBackground,
    safeguardTriggered: norm.safeguardTriggered,
    durationMs,
  };
}

/**
 * Loads an image from a base64 DataURL or File and applies non-destructive
 * grayscale normalization that preserves fine table characters and part details.
 */
export async function preprocessDocketImage(
  source: string | File
): Promise<PreprocessedImageResult> {
  const startMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let displayDataUrl = '';
  if (typeof source === 'string') {
    displayDataUrl = source;
  } else {
    displayDataUrl = await readFileAsDataUrl(source);
  }

  const img = await loadImageElement(displayDataUrl);

  // Maximum dimension for OCR (2400px ensures crisp table text)
  const MAX_DIM = 2400;
  let targetWidth = img.naturalWidth || img.width || 1600;
  let targetHeight = img.naturalHeight || img.height || 2200;

  if (targetWidth > MAX_DIM || targetHeight > MAX_DIM) {
    if (targetWidth > targetHeight) {
      targetHeight = Math.round((targetHeight * MAX_DIM) / targetWidth);
      targetWidth = MAX_DIM;
    } else {
      targetWidth = Math.round((targetWidth * MAX_DIM) / targetHeight);
      targetHeight = MAX_DIM;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  if (!ctx) {
    return {
      ocrDataUrl: displayDataUrl,
      displayDataUrl,
      width: targetWidth,
      height: targetHeight,
      diagnostics: {
        pLow: 0,
        pHigh: 255,
        effectiveRange: 255,
        inputMinLum: 0,
        inputMaxLum: 255,
        inputMedianLum: 255,
        meanLuminanceAfter: 255,
        whitePixelRatioAfter: 1,
        darkPixelRatioAfter: 0,
        wasInvertedFromDarkBackground: false,
        safeguardTriggered: false,
        durationMs: Math.max(
          1,
          Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startMs)
        ),
      },
    };
  }

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

  const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
  const diagnostics = preprocessRgbaImageBufferInPlace(
    imageData.data,
    targetWidth,
    targetHeight
  );

  ctx.putImageData(imageData, 0, 0);

  const ocrDataUrl = canvas.toDataURL('image/jpeg', 0.92);
  diagnostics.durationMs = Math.max(
    1,
    Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startMs)
  );

  return {
    ocrDataUrl,
    displayDataUrl,
    width: targetWidth,
    height: targetHeight,
    diagnostics,
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (e) => reject(e);
    reader.readAsDataURL(file);
  });
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = url;
  });
}
