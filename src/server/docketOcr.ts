/**
 * Data contracts and resilient Gemini AI Vision extraction engine for delivery dockets & invoices.
 * Includes:
 * - Automatic exponential backoff with jitter (starting at ~2s, max 3 retries) for HTTP 503, 429, and 5xx errors
 * - Configurable secondary Gemini model failover using identical instructions and responseSchema
 * - Strict structural and item-level validation before accepting primary or fallback OCR results
 * - Safe, structured operational logging (never logs API keys or document contents)
 */

export interface ExtractedDocketItem {
  partNumber: string;
  itemNumber: string;
  description: string;
  revision?: string;
  rev?: string;
  material?: string;
  thickness?: string;
  dimensions?: string;
  weight?: string;
  quantity: number;
  palletNumber?: string;
  pageNumber?: number;
  confidence: 'high' | 'medium' | 'low';
  notes?: string;
  validationFlags?: string[];
  bbox?: { x0: number; y0: number; x1: number; y1: number };
  manuallyEdited?: boolean;
  lastEditedBy?: string;
  lastEditedAt?: string;
  originalOcrValues?: {
    partNumber: string;
    itemNumber?: string;
    description: string;
    revision?: string;
    rev?: string;
    quantity: number;
    material?: string;
    thickness?: string;
  };
}

export interface PageSlicePayload {
  fullDataUrl: string;
  upperDataUrl?: string;
  lowerDataUrl?: string;
  pdfSelectableText?: string;
}

export type TesseractDiagnosticOutcomeCode =
  | 'A_TESSERACT_NEVER_STARTED'
  | 'B_TESSERACT_FAILED_TO_INITIALISE'
  | 'C_TESSERACT_FAILED_TO_RECOGNISE_TEXT'
  | 'D_TESSERACT_RECOGNISED_TEXT_BUT_PARSING_FAILED'
  | 'E_PARSING_SUCCEEDED_BUT_VALIDATION_REJECTED'
  | 'F_TESSERACT_SUCCEEDED';

export interface TesseractDiagnosticStageEvent {
  stage: string;
  timestampIso: string;
  elapsedMs: number;
  durationMs?: number;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

export interface TesseractPipelineDiagnostics {
  outcomeCode: TesseractDiagnosticOutcomeCode;
  outcomeLabel: string;
  startedAtIso: string;
  completedAtIso: string;
  totalElapsedMs: number;
  preprocessDurationMs?: number;
  workerInitDurationMs?: number;
  ocrDurationMs?: number;
  parseDurationMs?: number;
  pdfRenderingSucceeded: boolean;
  workerInitialised: boolean;
  workerScriptLoaded: boolean;
  wasmCoreLoaded: boolean;
  trainedDataLoaded: boolean;
  recognizeCalled: boolean;
  ocrReturnedText: boolean;
  ocrReturnedWords: boolean;
  totalRawTextLength: number;
  totalWordsCount: number;
  totalLinesCount: number;
  itemsParsedCount: number;
  validationAccepted: boolean;
  exactTriggerCondition?: string;
  stages: TesseractDiagnosticStageEvent[];
}

export interface ExtractedDocketResult {
  docketNumber: string;
  supplier: string;
  deliveryDate: string;
  carrier?: string;
  palletCount?: number;
  orderNumber?: string;
  notes?: string;
  items: ExtractedDocketItem[];
  rawTextSummary?: string;
  confidenceScore: number; // 0 - 100
  needsManualReview: boolean;
  extractionMethod?: 'tesseract-ocr' | 'ai-vision' | 'offline-ocr' | 'pdf-text';
  extractionEngineLabel?: string;
  aiModelUsed?: string;
  fallbackUsed?: boolean;
  geminiFallbackReason?: string;
  retryAttempts?: number;
  pagesScanned?: number;
  pagesFromCache?: number;
  processingTimeMs?: number;
  ocrTimeMs?: number;
  parseTimeMs?: number;
  validationFlags?: string[];
  missingRowNumbers?: number[];
  flaggedRowCount?: number;
  hasPrintedNoColumn?: boolean;
  firstVisibleRowNo?: number;
  lastVisibleRowNo?: number;
  tesseractDiagnostics?: TesseractPipelineDiagnostics;
}

export const DEFAULT_PRIMARY_VISION_MODEL = 'gemini-3.8-flash';
export const DEFAULT_FALLBACK_VISION_MODELS = [
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-flash-latest',
] as const;

export const MAX_AUTOMATIC_RETRIES = 3;
export const INITIAL_BACKOFF_MS = 2000;

/**
 * Resolves the configured primary and fallback Gemini vision models from environment variables
 * or falls back to verified supported defaults.
 */
export function resolveConfiguredVisionModels(envOverride?: Record<string, unknown>): {
  primaryModel: string;
  fallbackModels: string[];
} {
  const procEnv = typeof process !== 'undefined' && process.env ? process.env : {};
  const rawPrimary =
    (typeof envOverride?.GEMINI_PRIMARY_MODEL === 'string' && envOverride.GEMINI_PRIMARY_MODEL.trim()) ||
    (typeof procEnv.GEMINI_PRIMARY_MODEL === 'string' && procEnv.GEMINI_PRIMARY_MODEL.trim()) ||
    DEFAULT_PRIMARY_VISION_MODEL;

  const rawFallbacks =
    (typeof envOverride?.GEMINI_FALLBACK_MODEL === 'string' && envOverride.GEMINI_FALLBACK_MODEL.trim()) ||
    (typeof envOverride?.GEMINI_FALLBACK_MODELS === 'string' && envOverride.GEMINI_FALLBACK_MODELS.trim()) ||
    (typeof procEnv.GEMINI_FALLBACK_MODEL === 'string' && procEnv.GEMINI_FALLBACK_MODEL.trim()) ||
    (typeof procEnv.GEMINI_FALLBACK_MODELS === 'string' && procEnv.GEMINI_FALLBACK_MODELS.trim()) ||
    DEFAULT_FALLBACK_VISION_MODELS.join(',');

  const fallbackModels = rawFallbacks
    .split(',')
    .map((m) => m.trim())
    .filter((m) => Boolean(m) && m !== rawPrimary);

  return {
    primaryModel: rawPrimary,
    fallbackModels: fallbackModels.length > 0 ? fallbackModels : [...DEFAULT_FALLBACK_VISION_MODELS],
  };
}

/**
 * Safe structured logger for OCR model selection, retries, status codes, and failures.
 * Strictly strips any potential API key query strings and never logs document/image contents.
 */
export function logOcrEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  meta: Record<string, unknown> = {}
): void {
  const sanitizedMeta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (/key|token|secret|image|base64|dataurl|text/i.test(k)) continue;
    if (typeof v === 'string') {
      sanitizedMeta[k] = v.replace(/key=[A-Za-z0-9_\-]+/gi, 'key=[REDACTED]').slice(0, 300);
    } else {
      sanitizedMeta[k] = v;
    }
  }
  const timestamp = new Date().toISOString();
  const payload = JSON.stringify({ timestamp, component: 'PartTrack-OCR', event, ...sanitizedMeta });
  if (level === 'error') {
    console.error(payload);
  } else if (level === 'warn') {
    console.warn(payload);
  } else {
    console.log(payload);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Computes exponential backoff with random jitter starting around 2 seconds:
 * Attempt 1 (first retry): ~2000ms + 0..600ms jitter
 * Attempt 2 (second retry): ~4000ms + 0..600ms jitter
 * Attempt 3 (third retry): ~8000ms + 0..600ms jitter
 */
export function computeExponentialBackoffWithJitter(
  retryAttempt: number,
  baseDelayMs: number = INITIAL_BACKOFF_MS
): number {
  const exponent = Math.max(0, retryAttempt - 1);
  const exponentialDelay = baseDelayMs * Math.pow(2, exponent);
  const jitter = Math.floor(Math.random() * 650);
  return Math.min(20000, exponentialDelay + jitter);
}

// In-memory cooldown map for models that hit daily quota exhaustion or 404 (avoids 15s retry loops on subsequent batches)
const modelQuotaCooldownUntil = new Map<string, number>();
const MODEL_COOLDOWN_DURATION_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Extracts HTTP status code and classifies whether an error is a retryable availability/rate-limit/5xx error
 * or a per-day/model quota exhaustion that should immediately fail over to the secondary model.
 */
export function classifyGeminiError(err: any): {
  statusCode: number;
  isRetryableAvailabilityError: boolean;
  isRateLimit: boolean;
  isHighDemand503: boolean;
  isModelDailyQuotaExhausted: boolean;
  cleanMessage: string;
} {
  const rawMessage = String(err?.message || err || 'Unknown Gemini API error').replace(
    /key=[A-Za-z0-9_\-]+/gi,
    'key=[REDACTED]'
  );

  let statusCode = Number(err?.status || err?.statusCode || err?.httpStatus || 0);
  if (!statusCode) {
    const codeMatch =
      rawMessage.match(/\b(400|401|403|404|429|500|502|503|504)\b/) ||
      rawMessage.match(/"code"\s*:\s*(\d{3})/);
    if (codeMatch) {
      statusCode = parseInt(codeMatch[1], 10);
    }
  }

  const isHighDemand503 =
    statusCode === 503 ||
    /503|UNAVAILABLE|high demand|overloaded|service unavailable|temporarily unavailable|capacity/i.test(
      rawMessage
    );

  const isRateLimit =
    statusCode === 429 ||
    /429|RESOURCE_EXHAUSTED|rate limit|quota|too many requests/i.test(rawMessage);

  // Detect per-day / free-tier model quota exhaustion (where retrying the same model 2s later cannot succeed for hours)
  const isModelDailyQuotaExhausted =
    isRateLimit &&
    /GenerateRequestsPerDayPerProjectPerModel|free_tier_requests|requests per day limit exceeded|limit:\s*0\b|Please retry in \d+h/i.test(
      rawMessage
    );

  const isTemporary5xx =
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 504 ||
    /500|502|504|INTERNAL|DEADLINE_EXCEEDED|bad gateway|gateway timeout|timed out|AbortError|fetch failed/i.test(
      rawMessage
    );

  if (!statusCode) {
    if (isHighDemand503) statusCode = 503;
    else if (isRateLimit) statusCode = 429;
    else if (isTemporary5xx) statusCode = 502;
  }

  return {
    statusCode: statusCode || 500,
    isRetryableAvailabilityError: isHighDemand503 || isRateLimit || isTemporary5xx,
    isRateLimit,
    isHighDemand503,
    isModelDailyQuotaExhausted,
    cleanMessage: rawMessage.slice(0, 260),
  };
}

/**
 * Validates raw JSON text returned by primary or fallback Gemini models before accepting it.
 * Never silently accepts incomplete, truncated, or malformed OCR responses.
 */
export function validateAndParseOcrJsonResponse(
  rawText: string,
  mode: 'batch' | 'recovery' | 'label' = 'batch'
): any {
  const trimmed = (rawText || '').trim();
  if (!trimmed) {
    throw new Error('Malformed OCR response: Gemini returned an empty response body.');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch (parseErr: any) {
    throw new Error(
      `Malformed OCR JSON response: Could not parse JSON output (${parseErr?.message || 'syntax error'}).`
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Malformed OCR response: Root JSON value must be an object.');
  }

  if (mode === 'label') {
    if (typeof parsed.detectedCode !== 'string') {
      throw new Error('Malformed label OCR response: missing detectedCode string field.');
    }
    return parsed;
  }

  if (!Array.isArray(parsed.items)) {
    throw new Error('Incomplete OCR response: Missing required "items" array in JSON output.');
  }

  // Validate each extracted row for structural completeness
  for (let i = 0; i < parsed.items.length; i++) {
    const row = parsed.items[i];
    if (!row || typeof row !== 'object') {
      throw new Error(`Malformed OCR item at index ${i}: item is not an object.`);
    }
    const hasPartOrDesc =
      (typeof row.part === 'string' && row.part.trim().length > 0) ||
      (typeof row.desc === 'string' && row.desc.trim().length > 0);
    if (!hasPartOrDesc) {
      throw new Error(
        `Incomplete OCR item at index ${i}: both part number and description are empty.`
      );
    }
    const qtyNum = Number(row.qty);
    if (Number.isNaN(qtyNum) || qtyNum < 0) {
      throw new Error(`Invalid OCR item quantity at index ${i}: qty="${String(row.qty)}".`);
    }
  }

  return parsed;
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64Data: string } {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  return {
    mimeType: match ? match[1] : 'image/jpeg',
    base64Data: match ? match[2] : dataUrl.replace(/^data:image\/\w+;base64,/, ''),
  };
}

/**
 * Normalizes a raw "No" string (e.g. "1", "01", "No. 14", "482910-14") into a clean integer string ("1", "14"),
 * or returns "" if it is not a valid row number.
 */
function parseCleanRowNo(raw: any): string {
  const str = String(raw ?? '').trim();
  if (!str) return '';

  const dashMatch = str.match(/^\d{3,10}\s*[-–—]\s*0*(\d{1,4})$/);
  if (dashMatch) {
    return dashMatch[1];
  }

  const cleanCandidate = str
    .replace(/^(?:ITM|ITEM|LINE|POS|NO\.?|SR\.?\s*NO\.?|#)\s*[-:]?\s*/i, '')
    .replace(/^0+(?=\d)/, '')
    .trim();

  if (/^\d{1,4}$/.test(cleanCandidate)) {
    const num = parseInt(cleanCandidate, 10);
    if (num >= 1 && num <= 2500) {
      return String(num);
    }
  }

  return '';
}

interface RawBatchItem {
  page?: number;
  no: string;
  part: string;
  desc: string;
  rev?: string;
  mat?: string;
  thk?: string;
  dim?: string;
  wt?: string;
  qty: number;
}

interface BatchExtractionResponse {
  docketNumber?: string;
  supplier?: string;
  deliveryDate?: string;
  carrier?: string;
  orderNumber?: string;
  palletCount?: number;
  hasPrintedNoColumn?: boolean;
  firstVisibleRowNo?: string;
  lastVisibleRowNo?: string;
  items: RawBatchItem[];
  modelUsed: string;
  fallbackUsed: boolean;
  retryAttempts: number;
}

/**
 * Executes a Gemini generateContent call with:
 * 1. Automatic retry handling for HTTP 503, 429, and temporary 5xx errors
 * 2. Exponential backoff with jitter starting at ~2s, maximum of 3 automatic retries
 * 3. Automatic failover to configurable secondary Gemini model(s) using identical instructions & schema
 * 4. Strict validation of extracted JSON data before accepting results
 * 5. Safe operational logging without exposing API keys or document contents
 */
export async function generateWithRetryAndFallback(
  ai: any,
  ThinkingLevel: any,
  parts: any[],
  systemInstruction: string,
  responseSchema: any,
  mode: 'batch' | 'recovery' | 'label' = 'batch',
  envOverride?: Record<string, unknown>,
  baseDelayMs: number = INITIAL_BACKOFF_MS
): Promise<{
  parsed: any;
  modelUsed: string;
  fallbackUsed: boolean;
  retryAttempts: number;
}> {
  const { primaryModel, fallbackModels } = resolveConfiguredVisionModels(envOverride);
  const allConfiguredModels = [primaryModel, ...fallbackModels];
  const nowMs = Date.now();
  const useCooldownMemory = baseDelayMs >= 500;

  // Place models not in daily-quota cooldown first so subsequent batches don't re-hit an exhausted model
  const candidateModels = useCooldownMemory
    ? [
        ...allConfiguredModels.filter((m) => (modelQuotaCooldownUntil.get(m) || 0) <= nowMs),
        ...allConfiguredModels.filter((m) => (modelQuotaCooldownUntil.get(m) || 0) > nowMs),
      ]
    : allConfiguredModels;

  let totalRetryAttempts = 0;
  let lastError: any = null;
  let lastStatusCode = 500;

  for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
    const currentModel = candidateModels[mIdx];
    const isFallbackModel = currentModel !== primaryModel;
    // Maximum of 3 automatic retries per model (initial attempt + up to 3 automatic retries)
    const maxRetriesForModel = MAX_AUTOMATIC_RETRIES;

    logOcrEvent('info', isFallbackModel ? 'model_fallback_selected' : 'model_selected', {
      model: currentModel,
      isFallback: isFallbackModel,
      mode,
    });

    for (let retry = 0; retry <= maxRetriesForModel; retry++) {
      const controller = new AbortController();
      const timeoutMs = isFallbackModel ? 22000 : 26000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const config: Record<string, unknown> = {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema,
          abortSignal: controller.signal,
        };

        // Only attach ThinkingLevel.MEDIUM on Gemini 3.8 / 4 primary models
        if (ThinkingLevel && (currentModel.includes('3.8') || currentModel.includes('argon'))) {
          config.thinkingConfig = { thinkingLevel: ThinkingLevel.MEDIUM };
        }

        const response = await ai.models.generateContent({
          model: currentModel,
          contents: { parts },
          config,
        });
        clearTimeout(timer);

        const rawText = (response?.text ?? '').trim();
        const validated = validateAndParseOcrJsonResponse(rawText, mode);

        logOcrEvent('info', 'extraction_succeeded', {
          model: currentModel,
          isFallback: isFallbackModel,
          retryAttempts: totalRetryAttempts,
          statusCode: 200,
          itemsExtracted: Array.isArray(validated?.items) ? validated.items.length : 1,
        });

        return {
          parsed: validated,
          modelUsed: currentModel,
          fallbackUsed: isFallbackModel,
          retryAttempts: totalRetryAttempts,
        };
      } catch (err: any) {
        clearTimeout(timer);
        lastError = err;
        const classification = classifyGeminiError(err);
        lastStatusCode = classification.statusCode;

        const isValidationFailure =
          String(err?.message || '').includes('Malformed') ||
          String(err?.message || '').includes('Incomplete OCR') ||
          String(err?.message || '').includes('Invalid OCR item');

        logOcrEvent('warn', 'extraction_attempt_failed', {
          model: currentModel,
          isFallback: isFallbackModel,
          attempt: retry + 1,
          maxAttemptsForModel: maxRetriesForModel + 1,
          statusCode: classification.statusCode,
          isRetryable: classification.isRetryableAvailabilityError || isValidationFailure,
          reason: classification.cleanMessage,
        });

        // Permanent client/credential errors (400 Invalid API Key / Malformed Request, 401 Unauthorized, 403 Forbidden)
        // must immediately abort without entering retry loops or calling fallback models with the same bad request/key.
        if (
          !classification.isRetryableAvailabilityError &&
          !isValidationFailure &&
          (classification.statusCode === 400 ||
            classification.statusCode === 401 ||
            classification.statusCode === 403)
        ) {
          const permErr: any = new Error(classification.cleanMessage);
          permErr.status = classification.statusCode;
          permErr.code =
            classification.statusCode === 401 || classification.statusCode === 403
              ? 'GEMINI_AUTH_ERROR'
              : 'GEMINI_BAD_REQUEST';
          throw permErr;
        }

        // Model not found (404) or daily/free-tier quota exhausted for this specific model:
        // do not waste 15s retrying a model whose daily quota is 0; immediately advance to the next fallback model.
        if (
          (classification.statusCode === 404 && !classification.isRetryableAvailabilityError && !isValidationFailure) ||
          (classification.isModelDailyQuotaExhausted && mIdx < candidateModels.length - 1)
        ) {
          if (useCooldownMemory) {
            modelQuotaCooldownUntil.set(currentModel, Date.now() + MODEL_COOLDOWN_DURATION_MS);
          }
          logOcrEvent('info', 'model_daily_quota_or_404_fast_failover', {
            exhaustedModel: currentModel,
            nextModel: candidateModels[mIdx + 1],
            statusCode: classification.statusCode,
          });
          break;
        }

        if (retry < maxRetriesForModel) {
          totalRetryAttempts++;
          const waitMs = computeExponentialBackoffWithJitter(retry + 1, baseDelayMs);
          logOcrEvent('info', 'retrying_after_backoff', {
            model: currentModel,
            retryAttempt: retry + 1,
            maxRetries: maxRetriesForModel,
            waitMs,
            statusCode: classification.statusCode,
          });
          await sleep(waitMs);
          continue;
        }
      }
    }
  }

  logOcrEvent('error', 'all_models_and_retries_exhausted', {
    primaryModel,
    fallbackModels: fallbackModels.join(','),
    totalRetryAttempts,
    lastStatusCode,
    error: String(lastError?.message || lastError || 'Unknown error').slice(0, 240),
  });

  const finalClassification = classifyGeminiError(lastError);
  if (finalClassification.isHighDemand503) {
    const busyErr: any = new Error(
      `Gemini AI is currently experiencing high demand (HTTP 503) after ${totalRetryAttempts} automatic retries and fallback to ${fallbackModels[0] || 'secondary model'}. Your uploaded docket has been preserved — please click "Retry Extraction" in a moment.`
    );
    busyErr.status = 503;
    busyErr.code = 'GEMINI_HIGH_DEMAND_503';
    throw busyErr;
  }

  if (finalClassification.isRateLimit) {
    const rateErr: any = new Error(
      `Gemini AI rate limit reached (HTTP 429) after ${totalRetryAttempts} automatic retries. Your uploaded docket has been preserved — please wait a few seconds and click "Retry Extraction".`
    );
    rateErr.status = 429;
    rateErr.code = 'GEMINI_RATE_LIMIT_429';
    throw rateErr;
  }

  throw new Error(
    finalClassification.cleanMessage ||
      'Gemini AI could not extract the docket after automatic retries. Please click "Retry Extraction".'
  );
}

/**
 * Extracts a batch of 1 or 2 pages in a SINGLE Gemini API call by passing each page's
 * high-resolution Upper (0%-58%) and Lower (42%-100%) slices as separate image parts in one call.
 */
async function extractPageBatchInOneCall(
  ai: any,
  Type: any,
  ThinkingLevel: any,
  batchPages: Array<{ pageNumber: number; payload: PageSlicePayload }>,
  totalPages: number
): Promise<BatchExtractionResponse> {
  const parts: any[] = [];
  const pageDescriptions: string[] = [];

  for (const bp of batchPages) {
    const pNum = bp.pageNumber;
    const payload = bp.payload;
    if (payload.upperDataUrl && payload.lowerDataUrl) {
      const up = parseDataUrl(payload.upperDataUrl);
      const low = parseDataUrl(payload.lowerDataUrl);
      parts.push({ inlineData: { mimeType: up.mimeType, data: up.base64Data } });
      parts.push({ inlineData: { mimeType: low.mimeType, data: low.base64Data } });
      pageDescriptions.push(
        `Page ${pNum} (shown as 2 high-res zoomed halves: UPPER 58% of Page ${pNum} followed by LOWER 58% of Page ${pNum})`
      );
    } else {
      const full = parseDataUrl(payload.fullDataUrl);
      parts.push({ inlineData: { mimeType: full.mimeType, data: full.base64Data } });
      pageDescriptions.push(`Page ${pNum}`);
    }
    if (payload.pdfSelectableText && payload.pdfSelectableText.trim()) {
      parts.push({
        text: `[DIRECT SELECTABLE TEXT EXTRACTED FROM PDF PAGE ${pNum}]:\n${payload.pdfSelectableText.slice(0, 18000)}`,
      });
    }
  }

  const systemInstruction = `You are a 100%-recall industrial delivery docket, tax invoice, and laser-cutting manifest extraction engine.
Your job is to transcribe EVERY single physical part row literally visible across the provided page image(s) and/or extracted PDF text into the JSON 'items' array without skipping or merging any rows.
STRICT ANTI-HALLUCINATION RULE: Only extract rows and text that are literally present in the provided document. Never invent, guess, or fabricate parts, codes, descriptions, materials, thicknesses, dimensions, or quantities. If a document is blank or contains no physical part rows, return an empty items array [].`;

  const promptText = `Examine ${pageDescriptions.join(' and ')} (out of ${totalPages} total pages) and extract EVERY physical part row literally visible in the table in top-to-bottom order. If the image is blank or has no part rows, return items: [].

MANDATORY 100%-RECALL EXTRACTION RULES:
1. RECORD FIRST & LAST VISIBLE ROW NUMBERS:
   - Look at the first visible part row in this batch and record its printed "No" in 'firstVisibleRowNo', and look at the very last visible part row at the bottom of this batch and record its printed "No" in 'lastVisibleRowNo' (or "" if no part rows are visible).
2. EXTRACT EVERY SINGLE PART ROW FROM TOP TO BOTTOM:
   - Do NOT skip any row. Every single numbered row in the table is a distinct part that MUST have its own entry in 'items'.
   - Notice each page is shown as an UPPER half and a LOWER half with a small overlap in the middle so every row is large and clear. Read continuously from the top of the UPPER half to the bottom of the LOWER half without duplicating the overlap rows and without skipping any row.
   - Do NOT merge two separate numbered rows into one item.
3. IGNORE NON-PART LINES:
   - Ignore document header barcodes, consignment notes, and column headers.
   - On Tax Invoices, ignore non-physical charge/summary lines (Freight, Delivery, Setup, Pallet Fee, Subtotal, GST, Tax, Total, Balance Due).
4. FIELD MAPPING FOR EACH PART ROW:
   - page: The page number (${batchPages.map((b) => b.pageNumber).join(' or ')}) this row is on.
   - no: The exact printed number in the "No" / "No." / "Item" / "Pos" / "Line" / "#" column for this row. Never restart numbering at "1" on the lower half or on subsequent pages if printed row numbers continue across the document.
   - part: The Part Number, Drawing Number, Mark, Code, or DXF/Profile Name written on the row. If the table only has ONE text column (e.g. "Description" or "Part / Description"), put the part code/name in 'part' and the full text in 'desc'. NEVER put the row number in 'part'.
   - desc: The full part description or name written on the row.
   - rev: Drawing revision / Rev code if shown on the row (e.g. "A", "01", "Rev B"), else "".
   - mat: Material grade ONLY if written on the row, else "".
   - thk: Thickness ONLY if written on the row, else "".
   - dim: Dimensions/length/size ONLY if written on the row, else "".
   - wt: Weight ONLY if written on the row, else "".
   - qty: Integer quantity for this part row (convert invoice decimals like 4.00 to 4; never use Unit Price $ or Line Total $).`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      docketNumber: { type: Type.STRING },
      supplier: { type: Type.STRING },
      deliveryDate: { type: Type.STRING },
      orderNumber: { type: Type.STRING },
      carrier: { type: Type.STRING },
      palletCount: { type: Type.INTEGER },
      hasPrintedNoColumn: {
        type: Type.BOOLEAN,
        description: 'True if the table has a printed No / Item / Pos / Line number column.',
      },
      firstVisibleRowNo: {
        type: Type.STRING,
        description: 'The printed "No" of the first visible part row in this batch, or "" if none.',
      },
      lastVisibleRowNo: {
        type: Type.STRING,
        description: 'The printed "No" of the last visible part row at the bottom of this batch, or "" if none.',
      },
      items: {
        type: Type.ARRAY,
        description: 'Every physical part row literally visible in the image(s). Empty array [] if no part rows are visible.',
        items: {
          type: Type.OBJECT,
          properties: {
            page: { type: Type.INTEGER, description: 'Page number.' },
            no: { type: Type.STRING, description: 'Exact printed row "No".' },
            part: { type: Type.STRING, description: 'Part Number, Drawing No, or Part Name.' },
            desc: { type: Type.STRING, description: 'Full part description.' },
            rev: { type: Type.STRING, description: 'Part revision if present.' },
            mat: { type: Type.STRING },
            thk: { type: Type.STRING },
            dim: { type: Type.STRING },
            wt: { type: Type.STRING },
            qty: { type: Type.NUMBER, description: 'Quantity of this part (never price).' },
          },
          required: ['no', 'part', 'desc', 'qty'],
          propertyOrdering: ['page', 'no', 'part', 'desc', 'rev', 'mat', 'thk', 'dim', 'wt', 'qty'],
        },
      },
    },
    required: ['items'],
    propertyOrdering: [
      'docketNumber',
      'supplier',
      'deliveryDate',
      'orderNumber',
      'carrier',
      'palletCount',
      'hasPrintedNoColumn',
      'firstVisibleRowNo',
      'lastVisibleRowNo',
      'items',
    ],
  };

  parts.push({ text: promptText });

  const { parsed, modelUsed, fallbackUsed, retryAttempts } = await generateWithRetryAndFallback(
    ai,
    ThinkingLevel,
    parts,
    systemInstruction,
    responseSchema,
    'batch'
  );

  return {
    docketNumber: parsed.docketNumber,
    supplier: parsed.supplier,
    deliveryDate: parsed.deliveryDate,
    carrier: parsed.carrier,
    orderNumber: parsed.orderNumber,
    palletCount: parsed.palletCount,
    hasPrintedNoColumn: parsed.hasPrintedNoColumn !== false,
    firstVisibleRowNo: parsed.firstVisibleRowNo,
    lastVisibleRowNo: parsed.lastVisibleRowNo,
    items: Array.isArray(parsed.items) ? parsed.items : [],
    modelUsed,
    fallbackUsed,
    retryAttempts,
  };
}

/**
 * Single-Call Global Missing Row Recovery
 */
async function recoverMissingRowsBatch(
  ai: any,
  Type: any,
  ThinkingLevel: any,
  pagesToRecover: Array<{ pageNumber: number; payload: PageSlicePayload; missingNos: number[] }>
): Promise<RawBatchItem[]> {
  if (pagesToRecover.length === 0) return [];

  const parts: any[] = [];
  const instructionsPerPage: string[] = [];

  for (const entry of pagesToRecover) {
    const pNum = entry.pageNumber;
    const payload = entry.payload;
    if (payload.upperDataUrl && payload.lowerDataUrl) {
      const up = parseDataUrl(payload.upperDataUrl);
      const low = parseDataUrl(payload.lowerDataUrl);
      parts.push({ inlineData: { mimeType: up.mimeType, data: up.base64Data } });
      parts.push({ inlineData: { mimeType: low.mimeType, data: low.base64Data } });
    } else {
      const full = parseDataUrl(payload.fullDataUrl);
      parts.push({ inlineData: { mimeType: full.mimeType, data: full.base64Data } });
    }
    instructionsPerPage.push(
      `- On Page ${pNum}: find and extract rows with printed "No" = [ ${entry.missingNos.join(', ')} ]`
    );
  }

  const systemInstruction = `You are a precision industrial docket row recovery engine. Locate the exact requested row "No" numbers in the provided page images and transcribe them accurately.`;

  const promptText = `TARGETED MISSING ROW RECOVERY:
During the initial pass, the following row numbers in the "No" / "Item" / "Pos" / "Line" column were missed:
${instructionsPerPage.join('\n')}

Scan the provided page images carefully, locate EVERY row whose printed "No" matches one of the numbers listed above, and return its exact details in 'items'.
STRICT RULE: Only return rows that are actually visible in the images.`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      items: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            page: { type: Type.INTEGER },
            no: { type: Type.STRING, description: 'Exact printed row "No" from the missing list.' },
            part: { type: Type.STRING, description: 'Part Number, Drawing No, or Part Name.' },
            desc: { type: Type.STRING, description: 'Full part description.' },
            rev: { type: Type.STRING },
            mat: { type: Type.STRING },
            thk: { type: Type.STRING },
            dim: { type: Type.STRING },
            wt: { type: Type.STRING },
            qty: { type: Type.NUMBER },
          },
          required: ['no', 'part', 'desc', 'qty'],
          propertyOrdering: ['page', 'no', 'part', 'desc', 'rev', 'mat', 'thk', 'dim', 'wt', 'qty'],
        },
      },
    },
    required: ['items'],
  };

  parts.push({ text: promptText });

  try {
    const { parsed } = await generateWithRetryAndFallback(
      ai,
      ThinkingLevel,
      parts,
      systemInstruction,
      responseSchema,
      'recovery'
    );
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

/**
 * Converts a RawBatchItem into a normalized ExtractedDocketItem.
 */
function normalizeRawBatchItem(
  it: RawBatchItem,
  defaultPageNumber: number
): { cleanNo: string; item: ExtractedDocketItem } | null {
  let pn = String(it.part || '').trim();
  const desc = String(it.desc || '').trim();
  if (!pn && !desc) return null;

  if (
    /^(?:subtotal|sub-total|total|gst|tax|freight|delivery\s*charge|cartage|balance\s*due|amount\s*due|discount)$/i.test(
      pn
    ) ||
    /^(?:subtotal|sub-total|gst\s*10%?|total\s*incl|total\s*excl|amount\s*due|balance\s*due|freight\s*charge)$/i.test(
      desc
    )
  ) {
    return null;
  }

  let cleanNo = parseCleanRowNo(it.no);

  if ((/^\d{1,4}$/.test(pn) && parseCleanRowNo(pn) === cleanNo && desc.length > 0) || !pn) {
    const codeFromDesc = desc.match(/^([A-Z0-9][A-Z0-9\-_./]{2,22})(?:\s+[-–:]\s+|\s+)(.+)$/i);
    if (codeFromDesc && /\d/.test(codeFromDesc[1])) {
      pn = codeFromDesc[1].trim();
    } else {
      pn = desc.slice(0, 32).trim();
    }
  }

  if (!cleanNo) {
    const pnDashMatch = pn.match(/^(\d{4,10})\s*[-–—]\s*0*(\d{1,4})$/);
    if (pnDashMatch) {
      cleanNo = pnDashMatch[2];
    }
  }

  const rawQty = Number(it.qty);
  const cleanQty =
    !Number.isNaN(rawQty) && rawQty >= 1 && rawQty <= 99999 ? Math.round(rawQty) : 1;

  const cleanPn = String(pn || desc.slice(0, 28) || 'PART')
    .trim()
    .toUpperCase();

  const resolvedPage =
    typeof it.page === 'number' && it.page >= 1 ? it.page : defaultPageNumber;

  const cleanRev = it.rev && String(it.rev).trim() ? String(it.rev).trim() : undefined;
  const cleanMat = it.mat && String(it.mat).trim() ? String(it.mat).trim() : undefined;
  const cleanThk = it.thk && String(it.thk).trim() ? String(it.thk).trim() : undefined;

  return {
    cleanNo,
    item: {
      partNumber: cleanPn,
      itemNumber: cleanNo,
      description: String(desc || cleanPn).trim(),
      revision: cleanRev,
      material: cleanMat,
      thickness: cleanThk,
      dimensions: it.dim && String(it.dim).trim() ? String(it.dim).trim() : undefined,
      weight: it.wt && String(it.wt).trim() ? String(it.wt).trim() : undefined,
      quantity: cleanQty,
      palletNumber: 'Pallet 1',
      pageNumber: resolvedPage,
      confidence: 'high',
      originalOcrValues: {
        partNumber: cleanPn,
        itemNumber: cleanNo,
        description: String(desc || cleanPn).trim(),
        revision: cleanRev,
        quantity: cleanQty,
        material: cleanMat,
        thickness: cleanThk,
      },
    },
  };
}

/**
 * Extracts all individual parts across 1 or more pages using Gemini AI Vision
 * with exponential backoff, jitter, and configurable model failover.
 */
export async function extractDocketWithGeminiVision(
  base64Images: string[],
  startItemIndex: number = 1,
  pageSlices?: PageSlicePayload[],
  overrideApiKey?: string
): Promise<ExtractedDocketResult> {
  const apiKey = overrideApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Gemini AI API key is not configured on the server. Please set GEMINI_API_KEY in your server environment settings.'
    );
  }

  const { GoogleGenAI, Type, ThinkingLevel } = await import('@google/genai');

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
      timeout: 28000,
    },
  });

  const resolvedPayloads: PageSlicePayload[] =
    Array.isArray(pageSlices) && pageSlices.length > 0
      ? pageSlices
      : base64Images.map((img) => ({ fullDataUrl: img }));

  const totalPages = resolvedPayloads.length;

  const pagesPerBatch = totalPages >= 5 ? 2 : 1;
  const batches: Array<Array<{ pageNumber: number; payload: PageSlicePayload }>> = [];
  for (let i = 0; i < totalPages; i += pagesPerBatch) {
    const chunk: Array<{ pageNumber: number; payload: PageSlicePayload }> = [];
    for (let j = i; j < Math.min(totalPages, i + pagesPerBatch); j++) {
      chunk.push({ pageNumber: j + 1, payload: resolvedPayloads[j] });
    }
    batches.push(chunk);
  }

  const batchResponses: BatchExtractionResponse[] = [];
  for (let i = 0; i < batches.length; i += 2) {
    const pair = batches.slice(i, i + 2);
    const pairRes = await Promise.all(
      pair.map((b) => extractPageBatchInOneCall(ai, Type, ThinkingLevel, b, totalPages))
    );
    batchResponses.push(...pairRes);
  }

  const globalByNo = new Map<number, ExtractedDocketItem>();
  const unnumberedItems: ExtractedDocketItem[] = [];
  const pageMinNo = new Map<number, number>();
  const pageMaxNo = new Map<number, number>();
  let anyPrintedNoColumn = false;
  let globalMaxCandidate = 0;

  let modelUsed = DEFAULT_PRIMARY_VISION_MODEL;
  let fallbackUsed = false;
  let totalRetries = 0;

  for (let bIdx = 0; bIdx < batchResponses.length; bIdx++) {
    const bRes = batchResponses[bIdx];
    modelUsed = bRes.modelUsed || modelUsed;
    fallbackUsed = fallbackUsed || Boolean(bRes.fallbackUsed);
    totalRetries += bRes.retryAttempts || 0;

    const defaultPage = batches[bIdx][0].pageNumber;
    if (bRes.hasPrintedNoColumn !== false) {
      anyPrintedNoColumn = true;
    }

    const fNo = parseInt(parseCleanRowNo(bRes.firstVisibleRowNo), 10);
    const lNo = parseInt(parseCleanRowNo(bRes.lastVisibleRowNo), 10);
    if (!Number.isNaN(fNo) && fNo > 0) {
      pageMinNo.set(defaultPage, Math.min(pageMinNo.get(defaultPage) ?? fNo, fNo));
      if (fNo > globalMaxCandidate && fNo <= 1500) globalMaxCandidate = fNo;
    }
    if (!Number.isNaN(lNo) && lNo > 0) {
      const lastPageInBatch = batches[bIdx][batches[bIdx].length - 1].pageNumber;
      pageMaxNo.set(lastPageInBatch, Math.max(pageMaxNo.get(lastPageInBatch) ?? lNo, lNo));
      if (lNo > globalMaxCandidate && lNo <= 1500) globalMaxCandidate = lNo;
    }

    for (const rawIt of bRes.items || []) {
      const norm = normalizeRawBatchItem(rawIt, defaultPage);
      if (!norm) continue;
      const numNo = parseInt(norm.cleanNo, 10);
      const itemPage = norm.item.pageNumber || defaultPage;

      if (!Number.isNaN(numNo) && numNo > 0 && numNo <= 1500) {
        if (numNo > globalMaxCandidate) globalMaxCandidate = numNo;
        pageMinNo.set(itemPage, Math.min(pageMinNo.get(itemPage) ?? numNo, numNo));
        pageMaxNo.set(itemPage, Math.max(pageMaxNo.get(itemPage) ?? numNo, numNo));

        const existing = globalByNo.get(numNo);
        if (!existing) {
          globalByNo.set(numNo, { ...norm.item, itemNumber: String(numNo) });
        } else if (existing.pageNumber === itemPage) {
          globalByNo.set(numNo, {
            ...existing,
            partNumber:
              existing.partNumber && existing.partNumber !== 'PART'
                ? existing.partNumber
                : norm.item.partNumber,
            description:
              norm.item.description.length > existing.description.length
                ? norm.item.description
                : existing.description,
            revision: existing.revision || norm.item.revision,
            material: existing.material || norm.item.material,
            thickness: existing.thickness || norm.item.thickness,
            dimensions: existing.dimensions || norm.item.dimensions,
            weight: existing.weight || norm.item.weight,
            quantity: existing.quantity || norm.item.quantity,
          });
        } else {
          unnumberedItems.push(norm.item);
        }
      } else {
        unnumberedItems.push(norm.item);
      }
    }
  }

  // Pass 2: Single-Call Global Missing "No" Recovery
  if (
    anyPrintedNoColumn &&
    globalMaxCandidate > 1 &&
    globalMaxCandidate <= 600 &&
    unnumberedItems.length === 0
  ) {
    const missingNos: number[] = [];
    for (let n = 1; n <= globalMaxCandidate; n++) {
      if (!globalByNo.has(n)) {
        missingNos.push(n);
      }
    }

    if (missingNos.length > 0 && missingNos.length <= 60) {
      const missingPerPage = new Map<number, Set<number>>();
      const assignToPage = (pNum: number, val: number) => {
        if (pNum < 1 || pNum > totalPages) return;
        if (!missingPerPage.has(pNum)) missingPerPage.set(pNum, new Set());
        missingPerPage.get(pNum)!.add(val);
      };

      for (const mNo of missingNos) {
        let matched = false;
        for (let p = 1; p <= totalPages; p++) {
          const pMin = pageMinNo.get(p) ?? 1;
          const pMax = pageMaxNo.get(p) ?? globalMaxCandidate;
          if (mNo >= pMin && mNo <= pMax) {
            assignToPage(p, mNo);
            matched = true;
          }
        }
        if (!matched) {
          for (let p = 1; p < totalPages; p++) {
            const pMax = pageMaxNo.get(p);
            const nextMin = pageMinNo.get(p + 1);
            if (pMax !== undefined && nextMin !== undefined && mNo > pMax && mNo < nextMin) {
              assignToPage(p, mNo);
              assignToPage(p + 1, mNo);
              matched = true;
            }
          }
        }
        if (!matched) {
          assignToPage(mNo <= (pageMaxNo.get(1) ?? 50) ? 1 : totalPages, mNo);
        }
      }

      const recoveryPayloads = Array.from(missingPerPage.entries()).map(([pNum, set]) => ({
        pageNumber: pNum,
        payload: resolvedPayloads[pNum - 1],
        missingNos: Array.from(set).sort((a, b) => a - b),
      }));

      for (let i = 0; i < recoveryPayloads.length; i += 3) {
        const chunk = recoveryPayloads.slice(i, i + 3);
        const recoveredRaw = await recoverMissingRowsBatch(ai, Type, ThinkingLevel, chunk);
        for (const r of recoveredRaw) {
          const norm = normalizeRawBatchItem(r, chunk[0].pageNumber);
          if (!norm) continue;
          const numNo = parseInt(norm.cleanNo, 10);
          if (!Number.isNaN(numNo) && numNo > 0 && !globalByNo.has(numNo)) {
            globalByNo.set(numNo, {
              ...norm.item,
              itemNumber: String(numNo),
            });
          }
        }
      }
    }
  }

  const validItems: ExtractedDocketItem[] = [];
  const sortedNos = Array.from(globalByNo.keys()).sort((a, b) => a - b);
  for (const n of sortedNos) {
    validItems.push(globalByNo.get(n)!);
  }

  let nextSeq = (sortedNos.length > 0 ? sortedNos[sortedNos.length - 1] : startItemIndex - 1) + 1;
  for (const unnum of unnumberedItems) {
    validItems.push({
      ...unnum,
      itemNumber: String(nextSeq++),
    });
  }

  const rawDocketNo =
    batchResponses.find((p) => p.docketNumber && p.docketNumber.trim())?.docketNumber ||
    `DK-${Math.floor(10000 + Math.random() * 90000)}`;
  const cleanedDocketNumber = rawDocketNo.trim();

  const supplier =
    batchResponses.find((p) => p.supplier && p.supplier.trim())?.supplier?.trim() ||
    'Steel Fabrication Supplier';

  const rawDate = batchResponses.find(
    (p) => p.deliveryDate && /^\d{4}-\d{2}-\d{2}$/.test(p.deliveryDate.trim())
  )?.deliveryDate;
  const deliveryDate = rawDate ? rawDate.trim() : new Date().toISOString().slice(0, 10);

  const carrier = batchResponses.find((p) => p.carrier && p.carrier.trim())?.carrier?.trim();
  const orderNumber = batchResponses
    .find((p) => p.orderNumber && p.orderNumber.trim())
    ?.orderNumber?.trim();
  const maxPalletCount = Math.max(
    1,
    ...batchResponses.map((p) => parseInt(String(p.palletCount || 1), 10) || 1)
  );

  return {
    docketNumber: cleanedDocketNumber,
    supplier,
    deliveryDate,
    carrier,
    orderNumber,
    palletCount: maxPalletCount,
    items: validItems,
    confidenceScore: validItems.length > 0 ? 100 : 0,
    needsManualReview: validItems.length === 0,
    extractionMethod: 'ai-vision',
    aiModelUsed: modelUsed,
    fallbackUsed,
    retryAttempts: totalRetries,
    pagesScanned: totalPages,
    hasPrintedNoColumn: anyPrintedNoColumn,
    firstVisibleRowNo: sortedNos.length > 0 ? sortedNos[0] : undefined,
    lastVisibleRowNo: sortedNos.length > 0 ? sortedNos[sortedNos.length - 1] : undefined,
  };
}

/**
 * Dedicated endpoint helper to recover specific missing "No" rows
 * from a page's high-resolution slices.
 */
export async function recoverMissingDocketItems(
  slicePayload: PageSlicePayload,
  pageNumber: number,
  missingNos: number[],
  overrideApiKey?: string
): Promise<ExtractedDocketItem[]> {
  const apiKey = overrideApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey || !Array.isArray(missingNos) || missingNos.length === 0) {
    return [];
  }

  const { GoogleGenAI, Type, ThinkingLevel } = await import('@google/genai');
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
      timeout: 22000,
    },
  });

  const rawRecovered = await recoverMissingRowsBatch(ai, Type, ThinkingLevel, [
    { pageNumber, payload: slicePayload, missingNos },
  ]);

  const valid: ExtractedDocketItem[] = [];
  for (const r of rawRecovered) {
    const norm = normalizeRawBatchItem(r, pageNumber);
    if (!norm) continue;
    const numNo = parseInt(norm.cleanNo, 10);
    if (!Number.isNaN(numNo) && numNo > 0) {
      valid.push({
        ...norm.item,
        itemNumber: String(numNo),
        pageNumber,
      });
    }
  }
  return valid;
}

/**
 * Reads a barcode, QR code, Part Number, or Item Number from a single part label photo
 * using Gemini AI Vision.
 */
export async function extractPartCodeWithGeminiVision(
  imageDataUrl: string,
  knownParts?: Array<{ partNumber: string; itemNumber: string; description?: string }>
): Promise<{ detectedCode: string; confidence: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  const { GoogleGenAI, Type, ThinkingLevel } = await import('@google/genai');

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
      timeout: 15000,
    },
  });

  const { mimeType, base64Data } = parseDataUrl(imageDataUrl);

  const knownContext =
    Array.isArray(knownParts) && knownParts.length > 0
      ? `\nActive Docket Expected Parts (cross-reference the number after "-" against the Docket No):\n${knownParts
          .slice(0, 120)
          .map((p) => `- Docket No: ${p.itemNumber} | Part#: ${p.partNumber} (${p.description || ''})`)
          .join('\n')}`
      : '';

  const promptText = `Read the barcode value (formatted as "######-<No>", e.g. "482910-3" or "123456-02", where the numbers after the "-" is the "No" on the delivery docket), QR code text, or Part Number shown on this part label photo.${knownContext}
Return ONLY the barcode string (e.g. "482910-3") or Part Number in 'detectedCode'.`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      detectedCode: {
        type: Type.STRING,
        description: 'The decoded barcode text, Part Number, or Item Number on the label.',
      },
      confidence: {
        type: Type.STRING,
        description: 'high, medium, or low',
      },
    },
    required: ['detectedCode'],
  };

  try {
    const { parsed } = await generateWithRetryAndFallback(
      ai,
      ThinkingLevel,
      [
        { inlineData: { mimeType, data: base64Data } },
        { text: promptText },
      ],
      'Read the barcode or part code from the image.',
      responseSchema,
      'label'
    );

    return {
      detectedCode: String(parsed.detectedCode || '').trim(),
      confidence: String(parsed.confidence || 'high'),
    };
  } catch {
    return { detectedCode: '', confidence: 'low' };
  }
}
