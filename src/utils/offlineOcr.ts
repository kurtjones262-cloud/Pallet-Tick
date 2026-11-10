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

const CLIENT_MAX_AUTOMATIC_RETRIES = 3;
const CLIENT_INITIAL_BACKOFF_MS = 2000;

function computeClientBackoffWithJitter(attemptIndex: number): number {
  const exponentialDelay = CLIENT_INITIAL_BACKOFF_MS * Math.pow(2, attemptIndex);
  const jitterFactor = 0.85 + Math.random() * 0.3;
  return Math.round(exponentialDelay * jitterFactor);
}

/**
 * Validates that the extracted docket payload returned from the server is well-formed
 * and contains a valid items array with required fields before accepting it.
 */
export function validateClientExtractedDocketResult(data: any): ExtractedDocketResult {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Malformed OCR response: expected a structured JSON object.');
  }
  if (!Array.isArray(data.items)) {
    throw new Error('Incomplete OCR response: missing extracted parts array (items).');
  }
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    if (!item || typeof item !== 'object') {
      throw new Error(`Malformed OCR item at row ${i + 1}.`);
    }
    const partNo = String(item.partNumber ?? '').trim();
    const desc = String(item.description ?? '').trim();
    if (!partNo && !desc) {
      throw new Error(`Incomplete OCR item at row ${i + 1}: missing part number and description.`);
    }
  }
  return data as ExtractedDocketResult;
}

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
 * - Includes automatic exponential backoff + jitter retries (up to 3 retries) for HTTP 503, 429, and transient 5xx errors.
 * - Displays 'Gemini busy – retrying extraction' during high demand or automatic failover.
 * - Validates the extracted data structure before accepting primary or fallback results.
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

  const extractApiUrl = resolveApiUrl('/api/extract-docket');
  const requestBody = JSON.stringify({
    images: colorPages.map((p) => p.originalDataUrl),
    pageSlices: colorPages.map((p) => p.slicePayload!),
    startItemIndex: 1,
  });

  let lastError: Error | null = null;

  for (let retryAttempt = 0; retryAttempt <= CLIENT_MAX_AUTOMATIC_RETRIES; retryAttempt++) {
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    try {
      let simulatedPercent = retryAttempt === 0 ? 30 : 40;
      let tickCount = 0;

      onProgress?.({
        currentPage: 1,
        totalPages,
        stage: 'recognizing',
        percent: simulatedPercent,
        statusText:
          retryAttempt > 0
            ? `Gemini busy – retrying extraction (Attempt ${retryAttempt} of ${CLIENT_MAX_AUTOMATIC_RETRIES})...`
            : totalPages > 1
            ? `Extracting parts across ${totalPages} pages with Gemini AI...`
            : 'Extracting parts with Gemini AI...',
      });

      progressTimer = setInterval(() => {
        tickCount++;
        simulatedPercent = Math.min(92, simulatedPercent + 5);
        const estPage = Math.min(
          totalPages,
          Math.max(1, Math.ceil(((simulatedPercent - 25) / 68) * totalPages))
        );
        // When a single request runs longer than ~4.5s, the server is executing its internal
        // exponential backoff or failing over to the secondary Gemini model.
        const serverRetrying = tickCount >= 5 || retryAttempt > 0;
        onProgress?.({
          currentPage: estPage,
          totalPages,
          stage: simulatedPercent >= 84 && !serverRetrying ? 'parsing' : 'recognizing',
          percent: simulatedPercent,
          statusText: serverRetrying
            ? retryAttempt > 0
              ? `Gemini busy – retrying extraction (Attempt ${retryAttempt} of ${CLIENT_MAX_AUTOMATIC_RETRIES})...`
              : 'Gemini busy – retrying extraction...'
            : simulatedPercent >= 84
            ? 'Structuring parts checklist and verifying sequence...'
            : totalPages > 1
            ? `Scanning Page ${estPage} of ${totalPages} with Gemini AI...`
            : 'Extracting part numbers, descriptions, and quantities...',
        });
      }, 900);

      let response: Response;
      try {
        response = await fetch(extractApiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody,
        });
      } catch (networkErr: any) {
        const netMsg = networkErr?.message || String(networkErr || '');
        if (retryAttempt < CLIENT_MAX_AUTOMATIC_RETRIES) {
          const delayMs = computeClientBackoffWithJitter(retryAttempt);
          onProgress?.({
            currentPage: 1,
            totalPages,
            stage: 'recognizing',
            percent: simulatedPercent,
            statusText: `Gemini busy – retrying extraction in ${(delayMs / 1000).toFixed(1)}s (Attempt ${
              retryAttempt + 1
            } of ${CLIENT_MAX_AUTOMATIC_RETRIES})...`,
          });
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        throw new Error(
          `Unable to reach the Gemini invoice extraction service at ${extractApiUrl}. Please verify your server or internet connection: ${netMsg}`
        );
      } finally {
        if (progressTimer) {
          clearInterval(progressTimer);
          progressTimer = null;
        }
      }

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const code = String(errBody?.code || '');
        const rawMsg = String(errBody?.error || '');

        // Missing API key is non-retryable
        if (
          code === 'MISSING_GEMINI_API_KEY' ||
          rawMsg.includes('GEMINI_API_KEY') ||
          rawMsg.toLowerCase().includes('api key is not configured')
        ) {
          throw new Error(
            'Gemini AI API key is not configured on the server. Please configure the GEMINI_API_KEY secret in your server environment or Cloudflare Pages project settings (Settings > Environment variables).'
          );
        }

        const isRetryableStatus =
          response.status === 503 ||
          response.status === 429 ||
          (response.status >= 500 && response.status < 600) ||
          code === 'GEMINI_HIGH_DEMAND_503' ||
          code === 'GEMINI_RATE_LIMIT_429';

        if (isRetryableStatus && retryAttempt < CLIENT_MAX_AUTOMATIC_RETRIES) {
          const delayMs = computeClientBackoffWithJitter(retryAttempt);
          console.warn(
            `[PalletTrack OCR] HTTP ${response.status} (${code || 'TRANSIENT_ERROR'}) — automatic retry ${
              retryAttempt + 1
            }/${CLIENT_MAX_AUTOMATIC_RETRIES} in ${delayMs}ms`
          );
          onProgress?.({
            currentPage: 1,
            totalPages,
            stage: 'recognizing',
            percent: Math.min(85, simulatedPercent),
            statusText: `Gemini busy – retrying extraction (Attempt ${
              retryAttempt + 1
            } of ${CLIENT_MAX_AUTOMATIC_RETRIES})...`,
          });
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }

        if (
          response.status === 503 ||
          code === 'GEMINI_HIGH_DEMAND_503' ||
          rawMsg.includes('503') ||
          rawMsg.toLowerCase().includes('high demand')
        ) {
          throw new Error(
            rawMsg ||
              'Gemini OCR is experiencing temporary high demand (HTTP 503) and all automatic retries were exhausted. Your uploaded docket pages are preserved — please click "Retry Extraction" to try again.'
          );
        }

        if (
          response.status === 429 ||
          code === 'GEMINI_RATE_LIMIT_429' ||
          rawMsg.includes('429') ||
          rawMsg.includes('RESOURCE_EXHAUSTED')
        ) {
          throw new Error(
            rawMsg ||
              'Gemini AI rate limit reached (HTTP 429) after automatic retries. Your uploaded docket pages are preserved — please wait a few seconds and click "Retry Extraction".'
          );
        }

        throw new Error(
          rawMsg || `Gemini AI invoice extraction failed (HTTP status ${response.status}).`
        );
      }

      const rawJson = await response.json();
      const extractedResult = validateClientExtractedDocketResult(rawJson);

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
    } catch (err: any) {
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
      lastError = err instanceof Error ? err : new Error(String(err || 'Extraction failed'));
      const msg = lastError.message || '';
      const isMalformedResponse =
        msg.startsWith('Malformed OCR') || msg.startsWith('Incomplete OCR');

      if (isMalformedResponse && retryAttempt < CLIENT_MAX_AUTOMATIC_RETRIES) {
        const delayMs = computeClientBackoffWithJitter(retryAttempt);
        onProgress?.({
          currentPage: 1,
          totalPages,
          stage: 'recognizing',
          percent: 50,
          statusText: `Gemini busy – retrying extraction (Attempt ${
            retryAttempt + 1
          } of ${CLIENT_MAX_AUTOMATIC_RETRIES})...`,
        });
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      throw lastError;
    }
  }

  throw (
    lastError ||
    new Error(
      'Gemini OCR extraction failed after automatic retries. Please click "Retry Extraction" to try again.'
    )
  );
}
