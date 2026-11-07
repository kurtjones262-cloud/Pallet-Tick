import {
  ExtractedDocketResult,
  PageSlicePayload,
} from '../server/docketOcr';

export interface OcrProgressUpdate {
  currentPage: number;
  totalPages: number;
  stage: 'preparing' | 'recognizing' | 'parsing' | 'complete';
  percent: number; // 0 - 100
  statusText: string;
}

export interface PageTextHint {
  selectableLines?: Array<{ text: string; confidence?: number }>;
  rawText?: string;
  hasSelectableText?: boolean;
}

export interface OfflineDocketExtractionOutput {
  extractedData: ExtractedDocketResult;
  processedPages: Array<{
    pageNumber: number;
    originalDataUrl: string;
    preprocessedDataUrl: string;
    width: number;
    height: number;
    slicePayload?: PageSlicePayload;
  }>;
}

import { resolveApiUrl } from './apiConfig';
export { resolveApiUrl };

/**
 * Quickly resizes/compresses a photo in full color for Gemini AI Vision
 * without applying grayscale OCR thresholding.
 */
export async function prepareColorImageForGemini(
  source: string | File,
  maxDimension: number = 2000
): Promise<{ dataUrl: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let objectUrl: string | null = null;

    img.onload = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      const origW = img.naturalWidth || img.width || 1200;
      const origH = img.naturalHeight || img.height || 1600;
      const scale =
        Math.max(origW, origH) > maxDimension ? maxDimension / Math.max(origW, origH) : 1;
      const width = Math.max(1, Math.round(origW * scale));
      const height = Math.max(1, Math.round(origH * scale));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve({
          dataUrl: typeof source === 'string' ? source : '',
          width: origW,
          height: origH,
        });
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
      resolve({ dataUrl, width, height });
    };

    img.onerror = (err) => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      reject(err);
    };

    if (typeof source === 'string') {
      img.src = source;
    } else {
      objectUrl = URL.createObjectURL(source);
      img.src = objectUrl;
    }
  });
}

/**
 * Creates a full-page image PLUS two overlapping high-resolution horizontal slices:
 * - upperDataUrl: top 0% to 58% of the page (at 2x vertical detail)
 * - lowerDataUrl: bottom 42% to 100% of the page (at 2x vertical detail)
 * Both slices are sent inside a single Gemini API call per page/batch so we achieve
 * 100% row recall without exceeding the 15-RPM Free Tier rate limit.
 */
async function preparePageSlicesForGemini(
  source: string | File,
  maxDimension: number = 2100
): Promise<{
  fullDataUrl: string;
  upperDataUrl: string;
  lowerDataUrl: string;
  width: number;
  height: number;
}> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let objectUrl: string | null = null;

    img.onload = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      const origW = img.naturalWidth || img.width || 1200;
      const origH = img.naturalHeight || img.height || 1600;
      const scale =
        Math.max(origW, origH) > maxDimension ? maxDimension / Math.max(origW, origH) : 1;
      const width = Math.max(1, Math.round(origW * scale));
      const height = Math.max(1, Math.round(origH * scale));

      // 1. Full page canvas
      const fullCanvas = document.createElement('canvas');
      fullCanvas.width = width;
      fullCanvas.height = height;
      const fullCtx = fullCanvas.getContext('2d');
      if (!fullCtx) {
        const fallback = typeof source === 'string' ? source : '';
        resolve({
          fullDataUrl: fallback,
          upperDataUrl: fallback,
          lowerDataUrl: fallback,
          width: origW,
          height: origH,
        });
        return;
      }
      fullCtx.drawImage(img, 0, 0, width, height);
      const fullDataUrl = fullCanvas.toDataURL('image/jpeg', 0.84);

      // 2. Upper 58% slice (0% -> 58%)
      const upperH = Math.max(1, Math.round(height * 0.58));
      const upperCanvas = document.createElement('canvas');
      upperCanvas.width = width;
      upperCanvas.height = upperH;
      const upperCtx = upperCanvas.getContext('2d');
      let upperDataUrl = fullDataUrl;
      if (upperCtx) {
        upperCtx.drawImage(fullCanvas, 0, 0, width, upperH, 0, 0, width, upperH);
        upperDataUrl = upperCanvas.toDataURL('image/jpeg', 0.88);
      }

      // 3. Lower 58% slice (42% -> 100%)
      const lowerStartY = Math.floor(height * 0.42);
      const lowerH = Math.max(1, height - lowerStartY);
      const lowerCanvas = document.createElement('canvas');
      lowerCanvas.width = width;
      lowerCanvas.height = lowerH;
      const lowerCtx = lowerCanvas.getContext('2d');
      let lowerDataUrl = fullDataUrl;
      if (lowerCtx) {
        lowerCtx.drawImage(fullCanvas, 0, lowerStartY, width, lowerH, 0, 0, width, lowerH);
        lowerDataUrl = lowerCanvas.toDataURL('image/jpeg', 0.88);
      }

      resolve({
        fullDataUrl,
        upperDataUrl,
        lowerDataUrl,
        width,
        height,
      });
    };

    img.onerror = (err) => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      reject(err);
    };

    if (typeof source === 'string') {
      img.src = source;
    } else {
      objectUrl = URL.createObjectURL(source);
      img.src = objectUrl;
    }
  });
}

/**
 * Dedicated Invoice & Delivery Docket Parts Extraction:
 * - Uses Gemini AI Vision exclusively on the server to identify individual parts, descriptions, and quantities.
 * - Does NOT invoke on-device OCR under any circumstances.
 * - If Gemini is unconfigured or unavailable, cleanly reports the error to the user without silent OCR fallback.
 */
export async function performSmartDocketExtraction(
  images: Array<string | File>,
  onProgress?: (update: OcrProgressUpdate) => void,
  _forceOffline: boolean = false,
  pageTextHints?: PageTextHint[]
): Promise<OfflineDocketExtractionOutput> {
  const totalPages = images.length;
  if (totalPages === 0) {
    throw new Error('No docket pages provided for extraction.');
  }

  // Device-based OCR is completely removed from invoice importing.
  // Gemini AI is used exclusively for extracting invoice parts.
  const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  if (!isOnline) {
    throw new Error(
      'Invoice importing requires Gemini AI and an active internet connection. On-device OCR has been disabled for invoices. Please reconnect to the internet to compile invoices.'
    );
  }

  onProgress?.({
    currentPage: 1,
    totalPages,
    stage: 'preparing',
    percent: 15,
    statusText:
      totalPages > 1
        ? `Preparing ${totalPages} document pages for Gemini AI extraction...`
        : 'Preparing document for Gemini AI extraction...',
  });

  const preparedList = await Promise.all(
    images.map((img) => preparePageSlicesForGemini(img, 2100))
  );

  const colorPages: OfflineDocketExtractionOutput['processedPages'] = preparedList.map(
    (prepared, idx) => ({
      pageNumber: idx + 1,
      originalDataUrl: prepared.fullDataUrl,
      preprocessedDataUrl: prepared.fullDataUrl,
      width: prepared.width,
      height: prepared.height,
      slicePayload: {
        fullDataUrl: prepared.fullDataUrl,
        upperDataUrl: prepared.upperDataUrl,
        lowerDataUrl: prepared.lowerDataUrl,
        pdfSelectableText: pageTextHints?.[idx]?.rawText || undefined,
      },
    })
  );

  let progressTimer: ReturnType<typeof setInterval> | null = null;

  try {
    let simulatedPercent = 30;
    onProgress?.({
      currentPage: 1,
      totalPages,
      stage: 'recognizing',
      percent: simulatedPercent,
      statusText:
        totalPages > 1
          ? `Extracting parts across ${totalPages} pages with Gemini AI...`
          : 'Extracting parts with Gemini AI...',
    });

    progressTimer = setInterval(() => {
      simulatedPercent = Math.min(92, simulatedPercent + 6);
      const estPage = Math.min(
        totalPages,
        Math.max(1, Math.ceil(((simulatedPercent - 25) / 68) * totalPages))
      );
      onProgress?.({
        currentPage: estPage,
        totalPages,
        stage: simulatedPercent >= 82 ? 'parsing' : 'recognizing',
        percent: simulatedPercent,
        statusText:
          simulatedPercent >= 82
            ? 'Structuring parts checklist and verifying sequence...'
            : totalPages > 1
            ? `Scanning Page ${estPage} of ${totalPages} with Gemini AI...`
            : 'Extracting part numbers, descriptions, and quantities...',
      });
    }, 900);

    const extractApiUrl = resolveApiUrl('/api/extract-docket');

    let response: Response;
    try {
      response = await fetch(extractApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: colorPages.map((p) => p.originalDataUrl),
          pageSlices: colorPages.map((p) => p.slicePayload!),
          startItemIndex: 1,
        }),
      });
    } catch (networkErr: any) {
      throw new Error(
        `Unable to reach the Gemini invoice extraction service at ${extractApiUrl}. Please verify your server or internet connection: ${
          networkErr?.message || networkErr
        }`
      );
    } finally {
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
    }

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const code = errBody?.code || '';
      const rawMsg = errBody?.error || '';

      if (
        response.status === 503 ||
        code === 'MISSING_GEMINI_API_KEY' ||
        rawMsg.includes('GEMINI_API_KEY') ||
        rawMsg.toLowerCase().includes('api key')
      ) {
        throw new Error(
          'Gemini AI API key is not configured on the server. Please configure the GEMINI_API_KEY secret in your server environment or Cloudflare Pages project settings (Settings > Environment variables).'
        );
      }

      if (response.status === 429 || rawMsg.includes('429') || rawMsg.includes('RESOURCE_EXHAUSTED')) {
        throw new Error(
          'Gemini AI rate limit reached. Please wait a few moments and click Retry Extraction.'
        );
      }

      throw new Error(
        rawMsg || `Gemini AI invoice extraction failed (HTTP status ${response.status}).`
      );
    }

    const extractedResult: ExtractedDocketResult = await response.json();

    onProgress?.({
      currentPage: totalPages,
      totalPages,
      stage: 'complete',
      percent: 100,
      statusText: `Compiled ${extractedResult.items.length} parts across ${totalPages} ${
        totalPages === 1 ? 'page' : 'pages'
      }.`,
    });

    return {
      extractedData: extractedResult,
      processedPages: colorPages,
    };
  } finally {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }
}
