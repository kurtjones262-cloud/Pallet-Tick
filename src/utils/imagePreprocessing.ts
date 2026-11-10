/**
 * Image preprocessing for industrial laser cutting and fabrication delivery dockets.
 * Optimizes photos taken under warehouse lighting for on-device Tesseract OCR
 * without washing out fine 8pt-10pt table text when dark header barcodes are present.
 */

export interface PreprocessedImageResult {
  ocrDataUrl: string;       // Clean grayscale, contrast-normalized image for Tesseract LSTM
  displayDataUrl: string;   // Clean original photo for UI review and IndexedDB storage
  width: number;
  height: number;
  diagnostics?: {
    pLow: number;
    pHigh: number;
    meanLuminanceAfter: number;
    whitePixelRatioAfter: number;
    darkPixelRatioAfter: number;
  };
}

/**
 * Normalizes grayscale luminance values for document OCR:
 * - Anchors `pLow` to dark ink strokes (0.15th percentile, strictly clamped <= 90 so sparse text on a
 *   99% white page can never pull `pLow` up into the white background).
 * - Anchors `pHigh` to the paper background (85th percentile, strictly clamped >= 170).
 * - Maps paper background cleanly to 255 (white) and ink strokes to 0 (black).
 */
export function normalizeDocumentLuminances(
  luminances: Uint8Array,
  hist: Uint32Array
): {
  output: Uint8Array;
  pLow: number;
  pHigh: number;
  meanLuminanceAfter: number;
  whitePixelRatioAfter: number;
  darkPixelRatioAfter: number;
} {
  const numPixels = luminances.length;
  if (numPixels === 0) {
    return {
      output: new Uint8Array(0),
      pLow: 0,
      pHigh: 255,
      meanLuminanceAfter: 255,
      whitePixelRatioAfter: 1,
      darkPixelRatioAfter: 0,
    };
  }

  // 0.15% percentile for dark text ink; 85% percentile for paper background
  const lowTargetCount = Math.max(1, Math.floor(numPixels * 0.0015));
  const highTargetCount = Math.floor(numPixels * 0.85);

  let cumulative = 0;
  let rawLow: number | null = null;
  let rawHigh: number | null = null;

  for (let v = 0; v < 256; v++) {
    cumulative += hist[v];
    if (rawLow === null && cumulative >= lowTargetCount) {
      rawLow = v;
    }
    if (rawHigh === null && cumulative >= highTargetCount) {
      rawHigh = v;
    }
  }

  // Clamp pLow <= 90 so sparse text (<2% area) on a white page never shifts pLow into white paper!
  const pLow = Math.min(90, Math.max(0, rawLow ?? 0));
  // Clamp pHigh >= 170 so paper background always maps to clean white
  const pHigh = Math.max(pLow + 80, Math.min(255, Math.max(170, rawHigh ?? 245)));
  const range = Math.max(80, pHigh - pLow);

  const output = new Uint8Array(numPixels);
  let sumLum = 0;
  let whiteCount = 0;
  let darkCount = 0;

  for (let i = 0; i < numPixels; i++) {
    const lum = luminances[i];
    let finalVal: number;
    if (lum <= pLow) {
      finalVal = 0;
    } else if (lum >= pHigh) {
      finalVal = 255;
    } else {
      const normalized = (lum - pLow) / range;
      finalVal = Math.round(Math.pow(normalized, 1.12) * 255);
    }
    output[i] = finalVal;
    sumLum += finalVal;
    if (finalVal >= 220) whiteCount++;
    if (finalVal <= 80) darkCount++;
  }

  return {
    output,
    pLow,
    pHigh,
    meanLuminanceAfter: Math.round(sumLum / numPixels),
    whitePixelRatioAfter: Number((whiteCount / numPixels).toFixed(4)),
    darkPixelRatioAfter: Number((darkCount / numPixels).toFixed(4)),
  };
}

/**
 * Loads an image from a base64 DataURL or File and applies non-destructive
 * grayscale normalization that preserves fine table characters and part details.
 */
export async function preprocessDocketImage(
  source: string | File
): Promise<PreprocessedImageResult> {
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
    };
  }

  // Fill white background first in case source is a transparent PNG
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

  const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
  const data = imageData.data;
  const numPixels = targetWidth * targetHeight;

  // 1. Convert to perceptual grayscale and build luminance histogram
  const luminances = new Uint8Array(numPixels);
  const hist = new Uint32Array(256);

  for (let i = 0; i < numPixels; i++) {
    const idx = i * 4;
    const lum = Math.round(0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]);
    luminances[i] = lum;
    hist[lum]++;
  }

  // 2. Apply document-safe contrast normalization (guaranteed white background & dark ink)
  const norm = normalizeDocumentLuminances(luminances, hist);

  for (let i = 0; i < numPixels; i++) {
    const idx = i * 4;
    const finalVal = norm.output[i];
    data[idx] = finalVal;
    data[idx + 1] = finalVal;
    data[idx + 2] = finalVal;
    data[idx + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);

  const ocrDataUrl = canvas.toDataURL('image/jpeg', 0.92);

  return {
    ocrDataUrl,
    displayDataUrl,
    width: targetWidth,
    height: targetHeight,
    diagnostics: {
      pLow: norm.pLow,
      pHigh: norm.pHigh,
      meanLuminanceAfter: norm.meanLuminanceAfter,
      whitePixelRatioAfter: norm.whitePixelRatioAfter,
      darkPixelRatioAfter: norm.darkPixelRatioAfter,
    },
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
