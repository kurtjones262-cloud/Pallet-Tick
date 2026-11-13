import {
  DEFAULT_PRIMARY_VISION_MODEL,
  ExtractedDocketItem,
  ExtractedDocketResult,
  PageSlicePayload,
} from '../server/docketOcr';
import { SupplierRuleId } from '../types/delivery';
import {
  RawOcrLine,
  detectTableColumnLayout,
  mergeComplementaryParsedItems,
  preserveManualEditsDuringReprocess,
} from './docketParser';
import {
  extractDocketWithTesseractFirst,
  getTesseractWorkerDiagnosticState,
  TesseractDocketExtractionResult,
} from './tesseractDocketOcr';
import { resolveApiUrl } from './apiConfig';

export {
  resolveApiUrl,
  detectTableColumnLayout,
  mergeComplementaryParsedItems,
  preserveManualEditsDuringReprocess,
};

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
  clientOverallTimeoutMs?: number;
  sourceFileIds?: string[];
}

export const CLIENT_MAX_AUTOMATIC_RETRIES = 1;
export const CLIENT_INITIAL_BACKOFF_MS = 1800;
export const CLIENT_OVERALL_TIMEOUT_MS = 50000; // 50s overall client timeout (within 45-60s requirement)
export const CLIENT_PER_REQUEST_TIMEOUT_MS = 45000;

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
  const validateItems = (arr: any[], prefix = '') => {
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (!item || typeof item !== 'object') {
        throw new Error(`Malformed OCR item at ${prefix}row ${i + 1}.`);
      }
      const partNo = String(item.partNumber ?? '').trim();
      const desc = String(item.description ?? '').trim();
      if (!partNo && !desc) {
        throw new Error(`Incomplete OCR item at ${prefix}row ${i + 1}: missing part number and description.`);
      }
      const qty = Number(item.quantity ?? 1);
      if (!Number.isFinite(qty) || qty < 1) {
        throw new Error(`Invalid OCR item quantity at ${prefix}row ${i + 1}: quantity must be >= 1.`);
      }
    }
  };
  validateItems(data.items);
  if (Array.isArray(data.separatedDockets)) {
    for (let dIdx = 0; dIdx < data.separatedDockets.length; dIdx++) {
      const sep = data.separatedDockets[dIdx];
      if (!sep || typeof sep !== 'object' || !Array.isArray(sep.items)) {
        throw new Error(`Malformed separated docket entry at index ${dIdx}.`);
      }
      validateItems(sep.items, `docket ${dIdx + 1} `);
    }
  }
  return data as ExtractedDocketResult;
}

/**
 * Resizes/compresses a photo in full color while preserving high source resolution
 * (default up to 2600px) so on-device Tesseract OCR receives sharp characters.
 */
export async function prepareColorImageForGemini(
  source: string | File,
  maxDimension: number = 2600,
  jpegQuality: number = 0.92
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
      const dataUrl = canvas.toDataURL('image/jpeg', jpegQuality);
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
  maxDimension: number = 1800
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
 * Executes the server-side Gemini 4 Hydrogen extraction pipeline (used as automatic fallback
 * when Tesseract cannot confidently interpret a docket or when explicitly requested).
 * - Enforces an overall 50s client timeout (45-60s range)
 * - Allows at most 1 automatic client retry on transient errors
 * - Never retries permanent errors (400, 401, 403, 404, quota exceeded) or Cloudflare 524 / 504 timeouts
 * - Never displays a fake "Gemini busy" message unless an actual retry is occurring
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
  const overallTimeoutMs = options?.clientOverallTimeoutMs ?? CLIENT_OVERALL_TIMEOUT_MS;
  const startMs = performance.now();

  onProgress?.({
    currentPage: 1,
    totalPages,
    stage: 'preparing',
    percent: 20,
    statusText: fallbackReason
      ? `Tesseract flagged uncertainty — falling back to Gemini 4 Hydrogen...`
      : totalPages > 1
      ? `Preparing ${totalPages} document pages for Gemini 4 Hydrogen extraction...`
      : 'Preparing document for Gemini 4 Hydrogen extraction...',
  });

  const preparedList = await Promise.all(
    images.map((img) => preparePageSlicesForGemini(img, 1800))
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

  const wireSlices: PageSlicePayload[] = colorPages.map((p) => {
    const sp = p.slicePayload!;
    const hasBothHalves = Boolean(sp.upperDataUrl && sp.lowerDataUrl);
    return {
      fullDataUrl: hasBothHalves ? '' : sp.fullDataUrl,
      upperDataUrl: sp.upperDataUrl,
      lowerDataUrl: sp.lowerDataUrl,
      pdfSelectableText: sp.pdfSelectableText,
    };
  });

  const extractApiUrl = resolveApiUrl('/api/extract-docket');
  const requestBody = JSON.stringify({
    images: wireSlices.length > 0 ? [] : colorPages.map((p) => p.originalDataUrl),
    pageSlices: wireSlices,
    startItemIndex: 1,
  });

  let lastError: Error | null = null;

  for (let retryAttempt = 0; retryAttempt <= CLIENT_MAX_AUTOMATIC_RETRIES; retryAttempt++) {
    const elapsedSoFarMs = performance.now() - startMs;
    const remainingBudgetMs = overallTimeoutMs - elapsedSoFarMs;
    if (remainingBudgetMs <= 1500) {
      throw new Error(
        `Gemini AI extraction timed out after ${Math.round(overallTimeoutMs / 1000)}s. Your uploaded docket pages are preserved — please click "Retry Extraction" or review manually.`
      );
    }

    let progressTimer: ReturnType<typeof setInterval> | null = null;
    let requestAbortTimer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    const requestTimeoutMs = Math.min(CLIENT_PER_REQUEST_TIMEOUT_MS, Math.max(2000, remainingBudgetMs));
    requestAbortTimer = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      let simulatedPercent = retryAttempt === 0 ? 35 : 45;

      onProgress?.({
        currentPage: 1,
        totalPages,
        stage: 'recognizing',
        percent: simulatedPercent,
        statusText:
          retryAttempt > 0
            ? `Gemini busy – retrying extraction (Attempt ${retryAttempt} of ${CLIENT_MAX_AUTOMATIC_RETRIES})...`
            : fallbackReason
            ? `Running Gemini 4 Hydrogen fallback extraction...`
            : totalPages > 1
            ? `Extracting parts across ${totalPages} pages with Gemini 4 Hydrogen...`
            : 'Extracting parts with Gemini 4 Hydrogen...',
      });

      progressTimer = setInterval(() => {
        simulatedPercent = Math.min(92, simulatedPercent + 5);
        const estPage = Math.min(
          totalPages,
          Math.max(1, Math.ceil(((simulatedPercent - 25) / 68) * totalPages))
        );
        // Only show "Gemini busy – retrying extraction..." when an actual retry attempt is in progress
        const isActuallyRetrying = retryAttempt > 0;
        onProgress?.({
          currentPage: estPage,
          totalPages,
          stage: simulatedPercent >= 84 && !isActuallyRetrying ? 'parsing' : 'recognizing',
          percent: simulatedPercent,
          statusText: isActuallyRetrying
            ? `Gemini busy – retrying extraction (Attempt ${retryAttempt} of ${CLIENT_MAX_AUTOMATIC_RETRIES})...`
            : simulatedPercent >= 84
            ? 'Structuring parts checklist and verifying sequence...'
            : totalPages > 1
            ? `Scanning Page ${estPage} of ${totalPages} with Gemini 4 Hydrogen...`
            : 'Extracting part numbers, descriptions, and quantities...',
        });
      }, 900);

      let response: Response;
      try {
        response = await fetchFn(extractApiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody,
          signal: controller.signal,
        });
      } catch (networkErr: any) {
        const netMsg = networkErr?.message || String(networkErr || '');
        const isAbortedTimeout =
          controller.signal.aborted ||
          networkErr?.name === 'AbortError' ||
          /aborted|timed out|timeout/i.test(netMsg);

        if (isAbortedTimeout) {
          throw new Error(
            `Gemini AI extraction timed out after ${Math.round(requestTimeoutMs / 1000)}s without completing. Your uploaded docket pages are preserved — please click "Retry Extraction".`
          );
        }

        if (
          retryAttempt < CLIENT_MAX_AUTOMATIC_RETRIES &&
          performance.now() - startMs + baseBackoffMs < overallTimeoutMs
        ) {
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
        if (requestAbortTimer) {
          clearTimeout(requestAbortTimer);
          requestAbortTimer = null;
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
            'Gemini AI API key is not configured on the server. Please configure the GEMINI_API_KEY secret in your server environment or Cloudflare Worker settings.'
          );
        }

        // Never retry permanent errors (400, 401, 403, 404, quota exceeded) or Cloudflare 524 / 504 gateway timeouts
        const isPermanentOrTimeoutStatus =
          response.status === 400 ||
          response.status === 401 ||
          response.status === 403 ||
          response.status === 404 ||
          response.status === 504 ||
          response.status === 524 ||
          code === 'GEMINI_AUTH_ERROR' ||
          code === 'GEMINI_BAD_REQUEST' ||
          code === 'GEMINI_INVALID_MODEL' ||
          code === 'GEMINI_QUOTA_EXHAUSTED' ||
          code === 'GEMINI_TIMEOUT' ||
          errBody?.retryable === false;

        const isRetryableStatus =
          !isPermanentOrTimeoutStatus &&
          (response.status === 503 ||
            response.status === 502 ||
            response.status === 429 ||
            code === 'GEMINI_HIGH_DEMAND_503' ||
            code === 'GEMINI_RATE_LIMIT_429');

        if (
          isRetryableStatus &&
          retryAttempt < CLIENT_MAX_AUTOMATIC_RETRIES &&
          performance.now() - startMs + baseBackoffMs < overallTimeoutMs
        ) {
          const delayMs = computeClientBackoffWithJitter(retryAttempt, baseBackoffMs);
          console.warn(
            `[PartTrack OCR] HTTP ${response.status} (${code || 'TRANSIENT_ERROR'}) — automatic retry ${
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

        if (response.status === 524 || response.status === 504 || code === 'GEMINI_TIMEOUT') {
          throw new Error(
            rawMsg ||
              `Gemini AI extraction timed out (HTTP ${response.status}). Your uploaded docket pages are preserved — please click "Retry Extraction".`
          );
        }

        if (
          response.status === 401 ||
          response.status === 403 ||
          code === 'GEMINI_AUTH_ERROR'
        ) {
          throw new Error(
            rawMsg ||
              `Gemini API authentication or permission error (HTTP ${response.status}). Please verify the configured GEMINI_API_KEY.`
          );
        }

        if (response.status === 404 || code === 'GEMINI_INVALID_MODEL') {
          throw new Error(
            rawMsg ||
              `Designated Gemini model is unavailable or unsupported (HTTP 404).`
          );
        }

        if (code === 'GEMINI_QUOTA_EXHAUSTED') {
          throw new Error(
            rawMsg ||
              'Gemini API quota exceeded (HTTP 429). Please check project quota or billing settings.'
          );
        }

        if (
          response.status === 503 ||
          code === 'GEMINI_HIGH_DEMAND_503' ||
          rawMsg.includes('503') ||
          rawMsg.toLowerCase().includes('high demand')
        ) {
          throw new Error(
            rawMsg ||
              'Gemini OCR is experiencing temporary high demand (HTTP 503) and automatic retries were exhausted. Your uploaded docket pages are preserved — please click "Retry Extraction" to try again.'
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
              'Gemini AI rate limit reached (HTTP 429) after automatic retry. Your uploaded docket pages are preserved — please wait a few seconds and click "Retry Extraction".'
          );
        }

        throw new Error(
          rawMsg || `Gemini AI invoice extraction failed (HTTP status ${response.status}).`
        );
      }

      const rawJson = await response.json();
      const extractedResult = validateClientExtractedDocketResult(rawJson);
      const elapsedMs = Math.max(1, Math.round(performance.now() - startMs));
      const resolvedModelName = extractedResult.aiModelUsed || DEFAULT_PRIMARY_VISION_MODEL;

      const enrichedResult: ExtractedDocketResult = {
        ...extractedResult,
        aiModelUsed: resolvedModelName,
        extractionMethod: 'ai-vision',
        extractionEngineLabel: fallbackReason
          ? `Gemini AI Fallback (${resolvedModelName})`
          : `Gemini AI (${resolvedModelName})`,
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
        } via Gemini AI (${resolvedModelName}).`,
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
      if (requestAbortTimer) {
        clearTimeout(requestAbortTimer);
        requestAbortTimer = null;
      }
      lastError = err instanceof Error ? err : new Error(String(err || 'Extraction failed'));
      const msg = lastError.message || '';
      const isMalformedResponse =
        msg.startsWith('Malformed OCR') ||
        msg.startsWith('Incomplete OCR') ||
        msg.startsWith('Invalid OCR item');

      if (
        isMalformedResponse &&
        retryAttempt < CLIENT_MAX_AUTOMATIC_RETRIES &&
        performance.now() - startMs + baseBackoffMs < overallTimeoutMs
      ) {
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
      'Gemini OCR extraction failed after automatic retry. Please click "Retry Extraction" to try again.'
    )
  );
}

/**
 * Targeted row recovery using Gemini 4 Hydrogen (/api/recover-docket-items) for dockets where
 * Tesseract successfully extracted the majority of rows and only a small subset of row numbers
 * are missing or low-confidence. Preserves all valid Tesseract rows without reprocessing the entire docket.
 */
async function attemptTargetedUnresolvedRowRecovery(
  tesseractResult: TesseractDocketExtractionResult,
  images: Array<string | File>,
  unresolvedRowNos: number[],
  options?: SmartDocketExtractionOptions
): Promise<ExtractedDocketResult | null> {
  if (unresolvedRowNos.length === 0 || unresolvedRowNos.length > 10) return null;
  const fetchFn = options?.fetchImpl || fetch;
  const recoverUrl = resolveApiUrl('/api/recover-docket-items');

  try {
    const firstImg = images[0];
    const slicePayload = await preparePageSlicesForGemini(firstImg, 1800);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 22000);

    let response: Response;
    try {
      response = await fetchFn(recoverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slicePayload: {
            fullDataUrl: slicePayload.fullDataUrl,
            upperDataUrl: slicePayload.upperDataUrl,
            lowerDataUrl: slicePayload.lowerDataUrl,
          },
          pageNumber: 1,
          missingNos: unresolvedRowNos,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const recoveredItems: ExtractedDocketItem[] = Array.isArray(payload?.items) ? payload.items : [];
    if (recoveredItems.length === 0) return null;

    const byNo = new Map<number, ExtractedDocketItem>();
    const unnumbered: ExtractedDocketItem[] = [];
    for (const item of tesseractResult.extractedData.items) {
      const no = parseInt(String(item.itemNumber || '').trim(), 10);
      if (!Number.isNaN(no) && no > 0) {
        byNo.set(no, item);
      } else {
        unnumbered.push(item);
      }
    }

    let mergedCount = 0;
    for (const rec of recoveredItems) {
      const no = parseInt(String(rec.itemNumber || '').trim(), 10);
      const partNo = String(rec.partNumber || '').trim();
      if (!Number.isNaN(no) && no > 0 && partNo && partNo !== 'PART') {
        const existing = byNo.get(no);
        if (!existing || existing.confidence === 'low' || (existing.validationFlags || []).length > 0) {
          byNo.set(no, {
            ...rec,
            itemNumber: String(no),
            confidence: 'high',
            notes: 'Recovered via Gemini 4 Hydrogen targeted row pass',
          });
          mergedCount++;
        }
      }
    }

    if (mergedCount === 0) return null;

    const mergedItems: ExtractedDocketItem[] = [
      ...Array.from(byNo.keys())
        .sort((a, b) => a - b)
        .map((k) => byNo.get(k)!),
      ...unnumbered,
    ];

    const remainingMissing = (tesseractResult.extractedData.missingRowNumbers || []).filter(
      (n) => !byNo.has(n)
    );

    return {
      ...tesseractResult.extractedData,
      items: mergedItems,
      missingRowNumbers: remainingMissing,
      extractionEngineLabel: `Tesseract.js + Gemini 4 Hydrogen (${mergedCount} row${mergedCount === 1 ? '' : 's'} recovered)`,
      aiModelUsed: DEFAULT_PRIMARY_VISION_MODEL,
      fallbackUsed: true,
    };
  } catch {
    return null;
  }
}

/**
 * Tesseract-First Docket & Invoice Extraction Pipeline with Automatic Gemini 4 Hydrogen Fallback:
 * 1. Runs on-device / local Tesseract.js OCR + supplier-specific positional parsing (Laser Central & GCI).
 * 2. Validates every extracted row for missing part numbers, invalid quantities, uncertain text,
 *    incomplete rows, missed line items, and duplicates.
 * 3. If Tesseract extraction is complete or has valid structured rows, preserves all extracted rows.
 *    If a small subset of rows are unresolved and online recovery is available, attempts targeted row recovery first.
 * 4. If Tesseract cannot extract usable rows (or `options.forceGemini` is true),
 *    automatically falls back to the Gemini 4 Hydrogen Vision pipeline.
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
  const tesseractStartIso = new Date().toISOString();

  try {
    tesseractResult = await extractDocketWithTesseractFirst(images, {
      pageTextHints,
      supplierHint: options?.supplierHint,
      sourceFileIds: options?.sourceFileIds,
      onProgress,
    });
  } catch (err: any) {
    tesseractError = err instanceof Error ? err : new Error(String(err || 'Tesseract OCR error'));
    console.warn('[PartTrack OCR] Primary Tesseract extraction error:', tesseractError.message);
  }

  const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine !== false;

  // If Tesseract extracted a structured table with valid rows and only a few rows are missing/low-confidence,
  // attempt targeted row recovery via Gemini 4 Hydrogen before deciding whether full-docket fallback is needed.
  if (
    tesseractResult &&
    tesseractResult.extractedData.items.length >= 3 &&
    !forceOffline &&
    isOnline &&
    !options?.fetchImpl // Only run targeted recovery automatically when using standard runtime or if unresolved rows exist
  ) {
    const missingNos = tesseractResult.validationReport.missingRowNumbers || [];
    const lowConfNos = tesseractResult.extractedData.items
      .filter((it) => it.confidence === 'low' && /^\d+$/.test(String(it.itemNumber || '')))
      .map((it) => parseInt(String(it.itemNumber), 10));
    const unresolvedNos = Array.from(new Set([...missingNos, ...lowConfNos])).sort((a, b) => a - b);

    if (
      unresolvedNos.length > 0 &&
      unresolvedNos.length <= 10 &&
      unresolvedNos.length <= Math.ceil(tesseractResult.extractedData.items.length * 0.4)
    ) {
      const recoveredDocket = await attemptTargetedUnresolvedRowRecovery(
        tesseractResult,
        images,
        unresolvedNos,
        options
      );
      if (recoveredDocket) {
        tesseractResult.extractedData = recoveredDocket;
        if ((recoveredDocket.missingRowNumbers || []).length === 0) {
          tesseractResult.validationReport.shouldFallbackToGemini = false;
        }
      }
    }
  }

  // Check if Tesseract extraction passed completeness and row-level validation
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

  // Stage 2: Automatic Fallback to Gemini 4 Hydrogen Vision
  const workerState = getTesseractWorkerDiagnosticState();
  const isRecognitionException =
    workerState.workerInitialised &&
    Boolean(tesseractError?.message?.toLowerCase().includes('recognition failed'));

  const fallbackDiagnostics = tesseractResult?.diagnostics || {
    outcomeCode: isRecognitionException
      ? ('C_TESSERACT_FAILED_TO_RECOGNISE_TEXT' as const)
      : ('B_TESSERACT_FAILED_TO_INITIALISE' as const),
    outcomeLabel: isRecognitionException
      ? 'C. Tesseract initialised but failed to recognise text.'
      : 'B. Tesseract failed to initialise.',
    startedAtIso: tesseractStartIso,
    completedAtIso: new Date().toISOString(),
    totalElapsedMs: Math.round(performance.now() - overallStartMs),
    preprocessDurationMs: 0,
    workerInitDurationMs: workerState.initDurationMs || 0,
    ocrDurationMs: 0,
    parseDurationMs: 0,
    pdfRenderingSucceeded: images.length > 0,
    workerInitialised: workerState.workerInitialised,
    workerScriptLoaded: workerState.workerScriptLoaded,
    wasmCoreLoaded: workerState.wasmCoreLoaded,
    trainedDataLoaded: workerState.trainedDataLoaded,
    recognizeCalled: isRecognitionException,
    ocrReturnedText: false,
    ocrReturnedWords: false,
    totalRawTextLength: 0,
    totalWordsCount: 0,
    totalLinesCount: 0,
    itemsParsedCount: 0,
    validationAccepted: false,
    exactTriggerCondition: tesseractError?.message || 'Tesseract worker failed to initialise.',
    stages: [
      {
        stage: 'tesseract_exception',
        timestampIso: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - overallStartMs),
        status: 'error' as const,
        detail: tesseractError?.message || 'Unknown Tesseract error',
      },
    ],
  };

  const fallbackReason =
    tesseractResult?.validationReport.fallbackReason ||
    tesseractError?.message ||
    'Tesseract confidence below threshold';

  console.info(
    `[PartTrack OCR] Triggering Gemini 4 Hydrogen fallback [${fallbackDiagnostics.outcomeCode}] (${fallbackReason})`
  );

  if (!isOnline || forceOffline) {
    if (tesseractResult && tesseractResult.extractedData.items.length > 0) {
      return {
        extractedData: {
          ...tesseractResult.extractedData,
          needsManualReview: true,
          tesseractDiagnostics: fallbackDiagnostics,
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

  try {
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
    geminiOutput.extractedData.tesseractDiagnostics = fallbackDiagnostics;

    return geminiOutput;
  } catch (geminiErr: any) {
    // If primary Tesseract OCR already extracted valid part rows, preserve and return them
    // for manual operator review rather than crashing when Gemini fallback is unreachable.
    if (tesseractResult && tesseractResult.extractedData.items.length > 0) {
      console.warn(
        '[PartTrack OCR] Gemini fallback unavailable; returning Tesseract extracted rows for manual review:',
        geminiErr?.message || String(geminiErr)
      );
      const existingFlags = tesseractResult.extractedData.validationFlags || [];
      return {
        extractedData: {
          ...tesseractResult.extractedData,
          needsManualReview: true,
          geminiFallbackReason: fallbackReason,
          validationFlags: [
            ...existingFlags,
            'Gemini AI fallback unreachable — please review Tesseract OCR rows carefully',
          ],
          tesseractDiagnostics: fallbackDiagnostics,
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
    throw geminiErr;
  }
}
