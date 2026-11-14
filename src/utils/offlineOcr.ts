import {
  DEFAULT_PRIMARY_VISION_MODEL,
  ExtractedDocketItem,
  ExtractedDocketResult,
  PageSlicePayload,
} from '../server/docketOcr';
import { SupplierRuleId } from '../types/delivery';
import { getAuthToken } from '../services/palletTrackApi';
import {
  RawOcrLine,
  detectTableColumnLayout,
  mergeComplementaryParsedItems,
  preserveManualEditsDuringReprocess,
  validateAndNormalizeGeminiDocket,
} from './docketParser';
import { resolveApiUrl } from './apiConfig';

export {
  resolveApiUrl,
  detectTableColumnLayout,
  mergeComplementaryParsedItems,
  preserveManualEditsDuringReprocess,
  validateAndNormalizeGeminiDocket,
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
  enableTargetedRecovery?: boolean;
}

export class DocketOfflineError extends Error {
  public readonly code = 'DOCKET_OFFLINE_QUEUED';
  constructor(
    message: string = 'Device is offline. Docket pages have been saved locally and queued for Gemini 4 Hydrogen extraction upon reconnection.'
  ) {
    super(message);
    this.name = 'DocketOfflineError';
  }
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
 * Validates that the extracted docket payload returned from Gemini Vision is well-formed
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
 * Resizes/compresses a docket photo in full color while preserving high source resolution
 * (default up to 2400px) so Gemini 4 Hydrogen Vision receives sharp small characters & table grids.
 */
export async function prepareColorImageForGemini(
  source: string | File,
  maxDimension: number = 2400,
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
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
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
 * Creates a full-page image PLUS two overlapping high-resolution horizontal slices
 * (upper 0%-58%, lower 42%-100%) so Gemini Vision captures dense multi-column industrial tables accurately.
 */
export async function preparePageSlicesForGemini(
  source: string | File,
  maxDimension: number = 2200
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
      fullCtx.imageSmoothingEnabled = true;
      fullCtx.imageSmoothingQuality = 'high';
      fullCtx.drawImage(img, 0, 0, width, height);
      const fullDataUrl = fullCanvas.toDataURL('image/jpeg', 0.88);

      const upperH = Math.max(1, Math.round(height * 0.58));
      const upperCanvas = document.createElement('canvas');
      upperCanvas.width = width;
      upperCanvas.height = upperH;
      const upperCtx = upperCanvas.getContext('2d');
      let upperDataUrl = fullDataUrl;
      if (upperCtx) {
        upperCtx.drawImage(fullCanvas, 0, 0, width, upperH, 0, 0, width, upperH);
        upperDataUrl = upperCanvas.toDataURL('image/jpeg', 0.9);
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
        lowerDataUrl = lowerCanvas.toDataURL('image/jpeg', 0.9);
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

function buildApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const token = getAuthToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  } catch {
    // Ignore storage unavailability in non-browser tests
  }
  return headers;
}

/**
 * Targeted row recovery using Gemini 4 Hydrogen (/api/recover-docket-items) for dockets where
 * Gemini extracted the majority of rows cleanly and a small subset of printed sequence numbers
 * are missing or flagged low-confidence. Strictly preserves all valid existing rows.
 */
async function attemptTargetedUnresolvedRowRecovery(
  docket: ExtractedDocketResult,
  processedPages: OfflineDocketExtractionOutput['processedPages'],
  unresolvedRowNos: number[],
  options?: SmartDocketExtractionOptions
): Promise<ExtractedDocketResult | null> {
  if (unresolvedRowNos.length === 0 || unresolvedRowNos.length > 10) return null;
  if (processedPages.length === 0) return null;

  const fetchFn = options?.fetchImpl || fetch;
  const recoverUrl = resolveApiUrl('/api/recover-docket-items');

  try {
    // Target the page most likely containing missing rows (or page 1)
    const targetPage = processedPages[0];
    const sp = targetPage.slicePayload || {
      fullDataUrl: targetPage.originalDataUrl,
      upperDataUrl: targetPage.originalDataUrl,
      lowerDataUrl: targetPage.originalDataUrl,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 22000);

    let response: Response;
    try {
      response = await fetchFn(recoverUrl, {
        method: 'POST',
        headers: buildApiHeaders(),
        body: JSON.stringify({
          slicePayload: {
            fullDataUrl: sp.fullDataUrl || targetPage.originalDataUrl,
            upperDataUrl: sp.upperDataUrl,
            lowerDataUrl: sp.lowerDataUrl,
            pdfSelectableText: sp.pdfSelectableText,
          },
          pageNumber: targetPage.pageNumber || 1,
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
    for (const item of docket.items) {
      const no = parseInt(String(item.itemNumber || '').trim(), 10);
      if (!Number.isNaN(no) && no > 0 && !byNo.has(no)) {
        byNo.set(no, item);
      } else {
        unnumbered.push(item);
      }
    }

    let mergedCount = 0;
    for (const rec of recoveredItems) {
      const no = parseInt(String(rec.itemNumber || '').trim(), 10);
      const partNo = String(rec.partNumber || '').trim();
      if (!Number.isNaN(no) && no > 0 && partNo && !/^(?:PART|UNKNOWN)$/i.test(partNo)) {
        const existing = byNo.get(no);
        if (!existing || existing.confidence === 'low' || (existing.validationFlags || []).length > 0) {
          byNo.set(no, {
            ...rec,
            itemNumber: String(no),
            confidence: 'high',
            notes: 'Recovered via targeted row pass',
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

    const normalized = validateAndNormalizeGeminiDocket({
      ...docket,
      items: mergedItems,
      extractionEngineLabel: `${docket.extractionEngineLabel || `Gemini Vision (${docket.aiModelUsed || DEFAULT_PRIMARY_VISION_MODEL})`} + ${mergedCount} row${
        mergedCount === 1 ? '' : 's'
      } recovered`,
    }, options?.supplierHint);

    return normalized;
  } catch {
    return null;
  }
}

/**
 * Primary Gemini-First Docket & Invoice Extraction Pipeline (`gemini-4-hydrogen` -> `gemini-3.1-flash-lite` fallback):
 * - Prepares high-resolution images + overlapping upper/lower horizontal slices + PDF selectable text hints.
 * - Enforces an overall 50s client timeout (45-60s range).
 * - Allows at most 1 automatic client retry on transient errors (503, 502, 429, network drop).
 * - Never retries permanent errors (400, 401, 403, 404, quota exceeded) or Cloudflare 524 / 504 timeouts.
 * - Never displays "Gemini busy" unless an actual retry is occurring.
 * - Runs post-Gemini industrial validation + optional targeted row recovery for unresolved rows.
 */
export async function executeGeminiDocketExtraction(
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
    percent: 15,
    statusText:
      totalPages > 1
        ? `Preparing ${totalPages} high-resolution docket pages for Gemini 4 Hydrogen...`
        : 'Preparing high-resolution docket image for Gemini 4 Hydrogen...',
  });

  const preparedList = await Promise.all(
    images.map((img) => preparePageSlicesForGemini(img, 2200))
  );

  const processedPages: OfflineDocketExtractionOutput['processedPages'] = preparedList.map(
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

  const wireSlices: PageSlicePayload[] = processedPages.map((p) => {
    const sp = p.slicePayload!;
    const distinctUpper =
      sp.upperDataUrl && sp.upperDataUrl !== sp.fullDataUrl ? sp.upperDataUrl : undefined;
    const distinctLower =
      sp.lowerDataUrl &&
      sp.lowerDataUrl !== sp.fullDataUrl &&
      sp.lowerDataUrl !== sp.upperDataUrl
        ? sp.lowerDataUrl
        : undefined;
    return {
      fullDataUrl: sp.fullDataUrl,
      upperDataUrl: distinctUpper,
      lowerDataUrl: distinctLower,
      pdfSelectableText: sp.pdfSelectableText,
    };
  });

  const extractApiUrl = resolveApiUrl('/api/extract-docket');
  const requestBody = JSON.stringify({
    images: wireSlices.length > 0 ? [] : processedPages.map((p) => p.originalDataUrl),
    pageSlices: wireSlices,
    startItemIndex: 1,
    supplierHint: options?.supplierHint,
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
      let simulatedPercent = retryAttempt === 0 ? 30 : 45;

      onProgress?.({
        currentPage: 1,
        totalPages,
        stage: 'recognizing',
        percent: simulatedPercent,
        statusText:
          retryAttempt > 0
            ? `Gemini busy – retrying extraction (Attempt ${retryAttempt} of ${CLIENT_MAX_AUTOMATIC_RETRIES})...`
            : totalPages > 1
            ? `Extracting parts across ${totalPages} pages with Gemini 4 Hydrogen...`
            : 'Extracting parts with Gemini 4 Hydrogen...',
      });

      progressTimer = setInterval(() => {
        simulatedPercent = Math.min(90, simulatedPercent + 5);
        const estPage = Math.min(
          totalPages,
          Math.max(1, Math.ceil(((simulatedPercent - 25) / 68) * totalPages))
        );
        const isActuallyRetrying = retryAttempt > 0;
        onProgress?.({
          currentPage: estPage,
          totalPages,
          stage: simulatedPercent >= 82 && !isActuallyRetrying ? 'parsing' : 'recognizing',
          percent: simulatedPercent,
          statusText: isActuallyRetrying
            ? `Gemini busy – retrying extraction (Attempt ${retryAttempt} of ${CLIENT_MAX_AUTOMATIC_RETRIES})...`
            : simulatedPercent >= 82
            ? 'Validating part codes, quantities, and docket boundaries...'
            : totalPages > 1
            ? `Scanning Page ${estPage} of ${totalPages} with Gemini 4 Hydrogen...`
            : 'Reading docket table rows with Gemini 4 Hydrogen...',
        });
      }, 900);

      let response: Response;
      try {
        response = await fetchFn(extractApiUrl, {
          method: 'POST',
          headers: buildApiHeaders(),
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
          `Unable to reach the Gemini extraction service at ${extractApiUrl}. Please verify your server or internet connection: ${netMsg}`
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
            rawMsg || `Designated Gemini model is unavailable or unsupported (HTTP 404).`
          );
        }

        if (code === 'GEMINI_QUOTA_EXHAUSTED') {
          throw new Error(
            rawMsg || 'Gemini API quota exceeded (HTTP 429). Please check project quota or billing settings.'
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
          rawMsg || `Gemini AI docket extraction failed (HTTP status ${response.status}).`
        );
      }

      const rawJson = await response.json();
      const validatedRaw = validateClientExtractedDocketResult(rawJson);
      let normalizedResult = validateAndNormalizeGeminiDocket(validatedRaw, options?.supplierHint);

      // Run targeted row recovery if small number of missing or low-confidence numbered rows remain
      const shouldAttemptRecovery =
        options?.enableTargetedRecovery !== false &&
        !options?.fetchImpl &&
        !normalizedResult.separatedDockets?.length &&
        normalizedResult.items.length >= 3;

      if (shouldAttemptRecovery) {
        const missingNos = normalizedResult.missingRowNumbers || [];
        const lowConfNos = normalizedResult.items
          .filter((it) => it.confidence === 'low' && /^\d+$/.test(String(it.itemNumber || '')))
          .map((it) => parseInt(String(it.itemNumber), 10));
        const unresolvedNos = Array.from(new Set([...missingNos, ...lowConfNos])).sort((a, b) => a - b);

        if (
          unresolvedNos.length > 0 &&
          unresolvedNos.length <= 10 &&
          unresolvedNos.length <= Math.ceil(normalizedResult.items.length * 0.4)
        ) {
          onProgress?.({
            currentPage: totalPages,
            totalPages,
            stage: 'parsing',
            percent: 93,
            statusText: `Recovering ${unresolvedNos.length} flagged row(s) with Gemini 4 Hydrogen...`,
          });
          const recovered = await attemptTargetedUnresolvedRowRecovery(
            normalizedResult,
            processedPages,
            unresolvedNos,
            options
          );
          if (recovered) {
            normalizedResult = recovered;
          }
        }
      }

      const elapsedMs = Math.max(1, Math.round(performance.now() - startMs));
      const resolvedModelName = normalizedResult.aiModelUsed || DEFAULT_PRIMARY_VISION_MODEL;

      const enrichedResult: ExtractedDocketResult = {
        ...normalizedResult,
        aiModelUsed: resolvedModelName,
        extractionMethod: 'gemini-vision',
        extractionEngineLabel:
          normalizedResult.extractionEngineLabel ||
          `Gemini Vision (${resolvedModelName})`,
        fallbackUsed: Boolean(normalizedResult.fallbackUsed),
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
        } via Gemini Vision (${resolvedModelName}).`,
      });

      return {
        extractedData: enrichedResult,
        processedPages,
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
 * Legacy-named export preserved for downstream test and caller compatibility;
 * routes directly through the Gemini-first extraction engine.
 */
export const executeGeminiFallbackExtraction = executeGeminiDocketExtraction;

/**
 * Gemini-First Delivery Docket & Invoice Extraction Entrypoint:
 * 1. When offline (and no test `fetchImpl` is injected), throws `DocketOfflineError` so callers
 *    safely queue original docket images in IndexedDB without faking OCR.
 * 2. When online, executes Gemini 4 Hydrogen extraction (`gemini-3.1-flash-lite` automatic fallback)
 *    with post-Gemini industrial validation and optional targeted row recovery.
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

  const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  if (forceOffline || (!isOnline && !options?.fetchImpl)) {
    throw new DocketOfflineError(
      'You are offline. Uploaded docket images have been queued locally for automatic Gemini 4 Hydrogen extraction when reconnected.'
    );
  }

  return executeGeminiDocketExtraction(images, onProgress, pageTextHints, undefined, options);
}
