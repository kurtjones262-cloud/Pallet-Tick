import {
  ExtractedDocketResult,
  PageSlicePayload,
} from '../server/docketOcr';
import { SupplierRuleId } from '../types/delivery';
import { RawOcrLine } from './docketParser';
import {
  extractDocketWithTesseractFirst,
  TesseractDocketExtractionResult,
} from './tesseractDocketOcr';
import { resolveApiUrl } from './apiConfig';

export { resolveApiUrl };

export interface OcrProgressUpdate {
  currentPage: number;
  totalPages: number;
  stage: 'preparing' | 'recognizing' | 'parsing' | 'complete';
  percent: number; // 0 - 100
  statusText: string;
}

export interface PageTextHint {
  selectableLines?: RawOcrLine[];
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

export interface SmartDocketExtractionOptions {
  supplierHint?: SupplierRuleId;
  forceGemini?: boolean;
  fetchImpl?: typeof fetch;
  clientBaseBackoffMs?: number;
}

const CLIENT_MAX_AUTOMATIC_RETRIES = 3;
const CLIENT_INITIAL_BACKOFF_MS = 2000;

function computeClientBackoffWithJitter(
  attemptIndex: number,
  baseBackoffMs: number = CLIENT_INITIAL_BACKOFF_MS
): number {
  const exponentialDelay = baseBackoffMs * Math.pow(2, attemptIndex);
  const jitterFactor = 0.85 + Math.random() * 0.3;
  return Math.round(exponentialDelay * jitterFactor);
}

/**
 * Validates that the extracted docket payload returned from the server or local parser is well-formed
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
    const qty = Number(item.quantity ?? 1);
    if (!Number.isFinite(qty) || qty < 1) {
      throw new Error(`Invalid OCR item quantity at row ${i + 1}: quantity must be >= 1.`);
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
  if (typeof window === 'undefined' || typeof Image === 'undefined') {
    return {
      dataUrl: typeof source === 'string' ? source : '',
      width: 1600,
      height: 2200,
    };
  }

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
 * - upperDataUrl: top 0% to 58% of the page
 * - lowerDataUrl: bottom 42% to 100% of the page
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
  if (typeof window === 'undefined' || typeof Image === 'undefined') {
    const fallback = typeof source === 'string' ? source : '';
    return {
      fullDataUrl: fallback,
      upperDataUrl: fallback,
      lowerDataUrl: fallback,
      width: 1600,
      height: 2200,
    };
  }

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
 * Executes the server-side Gemini AI Vision extraction pipeline (used as automatic fallback
 * when Tesseract cannot confidently interpret a docket or when explicitly requested).
 */
export async function executeGeminiFallbackExtraction(
  images: Array<string | File>,
  onProgress?: (update: OcrProgressUpdate) => void,
  pageTextHints?: PageTextHint[],
  fallbackReason?: string,
  options?: SmartDocketExtractionOptions
): Promise<OfflineDocketExtractionOutput> {
  const totalPages = images.length;
  const fetchFn = options?.fetchImpl || fetch;
  const baseBackoffMs = options?.clientBaseBackoffMs ?? CLIENT_INITIAL_BACKOFF_MS;
  const startMs = performance.now();

  onProgress?.({
    currentPage: 1,
    totalPages,
    stage: 'preparing',
    percent: 20,
    statusText: fallbackReason
      ? `Tesseract flagged uncertainty — falling back to Gemini AI...`
      : totalPages > 1
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
      let simulatedPercent = retryAttempt === 0 ? 35 : 45;
      let tickCount = 0;

      onProgress?.({
        currentPage: 1,
        totalPages,
        stage: 'recognizing',
        percent: simulatedPercent,
        statusText:
          retryAttempt > 0
            ? `Gemini busy – retrying extraction (Attempt ${retryAttempt} of ${CLIENT_MAX_AUTOMATIC_RETRIES})...`
            : fallbackReason
            ? `Running Gemini AI fallback extraction...`
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
        response = await fetchFn(extractApiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody,
        });
      } catch (networkErr: any) {
        const netMsg = networkErr?.message || String(networkErr || '');
        if (retryAttempt < CLIENT_MAX_AUTOMATIC_RETRIES) {
          const delayMs = computeClientBackoffWithJitter(retryAttempt, baseBackoffMs);
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
          const delayMs = computeClientBackoffWithJitter(retryAttempt, baseBackoffMs);
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
      const elapsedMs = Math.max(1, Math.round(performance.now() - startMs));

      const enrichedResult: ExtractedDocketResult = {
        ...extractedResult,
        extractionMethod: 'ai-vision',
        extractionEngineLabel: fallbackReason
          ? `Gemini AI Fallback (${extractedResult.aiModelUsed || 'gemini-3.8-flash'})`
          : `Gemini AI (${extractedResult.aiModelUsed || 'gemini-3.8-flash'})`,
        fallbackUsed: Boolean(fallbackReason) || Boolean(extractedResult.fallbackUsed),
        geminiFallbackReason: fallbackReason,
        processingTimeMs: elapsedMs,
      };

      onProgress?.({
        currentPage: totalPages,
        totalPages,
        stage: 'complete',
        percent: 100,
        statusText: `Compiled ${enrichedResult.items.length} parts across ${totalPages} ${
          totalPages === 1 ? 'page' : 'pages'
        } via Gemini AI.`,
      });

      return {
        extractedData: enrichedResult,
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
        msg.startsWith('Malformed OCR') ||
        msg.startsWith('Incomplete OCR') ||
        msg.startsWith('Invalid OCR item');

      if (isMalformedResponse && retryAttempt < CLIENT_MAX_AUTOMATIC_RETRIES) {
        const delayMs = computeClientBackoffWithJitter(retryAttempt, baseBackoffMs);
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

/**
 * Tesseract-First Docket & Invoice Extraction Pipeline with Automatic Gemini Fallback:
 * 1. Runs on-device / local Tesseract.js OCR + supplier-specific positional parsing (Laser Central & GCI).
 * 2. Validates every extracted row for missing part numbers, invalid quantities, uncertain text,
 *    incomplete rows, missed line items, and duplicates.
 * 3. If Tesseract extraction is complete and confident, returns immediately with 0 Gemini API requests.
 * 4. If Tesseract cannot confidently interpret the docket (or `options.forceGemini` is true),
 *    automatically falls back to the Gemini AI Vision pipeline (preserving retry, backoff, and secondary model failover).
 */
export async function performSmartDocketExtraction(
  images: Array<string | File>,
  onProgress?: (update: OcrProgressUpdate) => void,
  forceOffline: boolean = false,
  pageTextHints?: PageTextHint[],
  options?: SmartDocketExtractionOptions
): Promise<OfflineDocketExtractionOutput> {
  const totalPages = images.length;
  if (totalPages === 0) {
    throw new Error('No docket pages provided for extraction.');
  }

  const overallStartMs = performance.now();

  // If caller explicitly requested Gemini AI Vision directly, bypass Tesseract primary stage
  if (options?.forceGemini && !forceOffline) {
    return executeGeminiFallbackExtraction(
      images,
      onProgress,
      pageTextHints,
      undefined,
      options
    );
  }

  // Stage 1: Primary Tesseract.js Docket Extraction
  let tesseractResult: TesseractDocketExtractionResult | null = null;
  let tesseractError: Error | null = null;

  try {
    tesseractResult = await extractDocketWithTesseractFirst(images, {
      pageTextHints,
      supplierHint: options?.supplierHint,
      onProgress,
    });
  } catch (err: any) {
    tesseractError = err instanceof Error ? err : new Error(String(err || 'Tesseract OCR error'));
    console.warn('[PalletTrack OCR] Primary Tesseract extraction error:', tesseractError.message);
  }

  // Check if Tesseract extraction passed strict completeness and confidence validation
  if (
    tesseractResult &&
    (!tesseractResult.validationReport.shouldFallbackToGemini || forceOffline) &&
    tesseractResult.extractedData.items.length > 0
  ) {
    const validatedTesseractData = validateClientExtractedDocketResult(
      tesseractResult.extractedData
    );

    onProgress?.({
      currentPage: totalPages,
      totalPages,
      stage: 'complete',
      percent: 100,
      statusText: `Compiled ${validatedTesseractData.items.length} parts across ${totalPages} ${
        totalPages === 1 ? 'page' : 'pages'
      } with Tesseract OCR (${tesseractResult.metrics.totalTimeMs}ms).`,
    });

    return {
      extractedData: validatedTesseractData,
      processedPages: tesseractResult.processedPages.map((p) => ({
        pageNumber: p.pageNumber,
        originalDataUrl: p.originalDataUrl,
        preprocessedDataUrl: p.preprocessedDataUrl,
        width: p.width,
        height: p.height,
      })),
    };
  }

  // Stage 2: Automatic Fallback to Gemini AI Vision
  const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  const fallbackReason =
    tesseractResult?.validationReport.fallbackReason ||
    tesseractError?.message ||
    'Tesseract confidence below threshold';

  console.info(
    `[PalletTrack OCR] Triggering Gemini fallback (${fallbackReason})`
  );

  if (!isOnline || forceOffline) {
    if (tesseractResult && tesseractResult.extractedData.items.length > 0) {
      return {
        extractedData: {
          ...tesseractResult.extractedData,
          needsManualReview: true,
        },
        processedPages: tesseractResult.processedPages.map((p) => ({
          pageNumber: p.pageNumber,
          originalDataUrl: p.originalDataUrl,
          preprocessedDataUrl: p.preprocessedDataUrl,
          width: p.width,
          height: p.height,
        })),
      };
    }
    throw new Error(
      `On-device Tesseract OCR could not confidently extract parts from this document (${fallbackReason}), and the device is currently offline for Gemini AI fallback.`
    );
  }

  const geminiOutput = await executeGeminiFallbackExtraction(
    images,
    onProgress,
    pageTextHints,
    fallbackReason,
    options
  );

  geminiOutput.extractedData.processingTimeMs = Math.max(
    1,
    Math.round(performance.now() - overallStartMs)
  );

  return geminiOutput;
}
