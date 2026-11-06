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
  let targetWidth = img.naturalWidth || img.width;
  let targetHeight = img.naturalHeight || img.height;

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

  // 2. Find 2nd and 98th percentiles so a dark barcode doesn't crush table text contrast
  const lowTargetCount = Math.floor(numPixels * 0.02);
  const highTargetCount = Math.floor(numPixels * 0.98);
  let cumulative = 0;
  let pLow = 0;
  let pHigh = 255;

  for (let v = 0; v < 256; v++) {
    cumulative += hist[v];
    if (cumulative <= lowTargetCount) pLow = v;
    if (cumulative <= highTargetCount) pHigh = v;
  }

  const range = Math.max(40, pHigh - pLow);

  // 3. Apply smooth gamma-assisted contrast stretch that darkens mid-tone table text
  // while keeping paper background clean white for Tesseract's internal adaptive thresholding
  for (let i = 0; i < numPixels; i++) {
    const idx = i * 4;
    const lum = luminances[i];
    const normalized = Math.min(1, Math.max(0, (lum - pLow) / range));
    // Slight gamma > 1 on inverted darkness boosts faint gray text visibility
    const gammaAdjusted = Math.pow(normalized, 1.15);
    const finalVal = Math.round(gammaAdjusted * 255);

    data[idx] = finalVal;
    data[idx + 1] = finalVal;
    data[idx + 2] = finalVal;
  }

  ctx.putImageData(imageData, 0, 0);

  const ocrDataUrl = canvas.toDataURL('image/jpeg', 0.92);

  return {
    ocrDataUrl,
    displayDataUrl,
    width: targetWidth,
    height: targetHeight,
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
