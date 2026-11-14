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
  unit?: string;
  palletNumber?: string;
  pageNumber?: number;
  originalText?: string;
  confidence: 'high' | 'medium' | 'low';
  notes?: string;
  validationFlags?: string[];
  validationWarnings?: string[];
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

export interface ExtractedDocketResult {
  docketNumber: string;
  supplier: string;
  customerName?: string;
  deliveryDate: string;
  carrier?: string;
  palletCount?: number;
  orderNumber?: string;
  jobNumber?: string;
  notes?: string;
  items: ExtractedDocketItem[];
  rawTextSummary?: string;
  confidenceScore: number; // 0 - 100
  needsManualReview: boolean;
  extractionMethod?: 'gemini-vision' | 'ai-vision' | 'pdf-text';
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
  validationWarnings?: string[];
  missingRowNumbers?: number[];
  flaggedRowCount?: number;
  hasPrintedNoColumn?: boolean;
  firstVisibleRowNo?: number;
  lastVisibleRowNo?: number;
  separationUncertain?: boolean;
  separationReason?: string;
  sourcePageNumbers?: number[];
  separatedDockets?: ExtractedDocketResult[];
  ocrConfidence?: number;
  parserConfidence?: number;
}

export const DEFAULT_PRIMARY_VISION_MODEL = 'gemini-4-hydrogen';
export const DEFAULT_FALLBACK_VISION_MODELS = ['gemini-3.1-flash-lite'] as const;

export const GEMINI_REQUEST_TIMEOUT_MS = 22000;
export const MAX_AUTOMATIC_RETRIES = 1;
export const INITIAL_BACKOFF_MS = 1800;

const OBSOLETE_PRIMARY_MODELS = new Set([
  'gemini-3.8-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-2.0-flash',
  'gemini-pro-vision',
]);

const OBSOLETE_FALLBACK_MODELS = new Set([
  'gemini-3.8-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-flash-latest',
  'gemini-1.5-flash',
  'gemini-2.0-flash',
]);

export function sanitizeVisionModelIdentifier(
  rawModel: string,
  role: 'primary' | 'fallback' = 'primary'
): string {
  const trimmed = (rawModel || '').trim();
  if (!trimmed) {
    return role === 'primary' ? DEFAULT_PRIMARY_VISION_MODEL : DEFAULT_FALLBACK_VISION_MODELS[0];
  }
  const lower = trimmed.toLowerCase();
  if (role === 'primary' && OBSOLETE_PRIMARY_MODELS.has(lower)) {
    return DEFAULT_PRIMARY_VISION_MODEL;
  }
  if (role === 'fallback' && OBSOLETE_FALLBACK_MODELS.has(lower)) {
    return DEFAULT_FALLBACK_VISION_MODELS[0];
  }
  return trimmed;
}

/**
 * Resolves the configured primary and fallback Gemini vision models from environment variables
 * or falls back to verified supported defaults (gemini-4-hydrogen primary, gemini-3.1-flash-lite fallback).
 */
export function resolveConfiguredVisionModels(envOverride?: Record<string, unknown>): {
  primaryModel: string;
  fallbackModels: string[];
} {
  const procEnv = typeof process !== 'undefined' && process.env ? process.env : {};
  const rawPrimaryInput =
    (typeof envOverride?.GEMINI_PRIMARY_MODEL === 'string' && envOverride.GEMINI_PRIMARY_MODEL.trim()) ||
    (typeof procEnv.GEMINI_PRIMARY_MODEL === 'string' && procEnv.GEMINI_PRIMARY_MODEL.trim()) ||
    DEFAULT_PRIMARY_VISION_MODEL;

  const primaryModel = sanitizeVisionModelIdentifier(rawPrimaryInput, 'primary');

  const rawFallbacks =
    (typeof envOverride?.GEMINI_FALLBACK_MODEL === 'string' && envOverride.GEMINI_FALLBACK_MODEL.trim()) ||
    (typeof envOverride?.GEMINI_FALLBACK_MODELS === 'string' && envOverride.GEMINI_FALLBACK_MODELS.trim()) ||
    (typeof procEnv.GEMINI_FALLBACK_MODEL === 'string' && procEnv.GEMINI_FALLBACK_MODEL.trim()) ||
    (typeof procEnv.GEMINI_FALLBACK_MODELS === 'string' && procEnv.GEMINI_FALLBACK_MODELS.trim()) ||
    DEFAULT_FALLBACK_VISION_MODELS.join(',');

  const seen = new Set<string>([primaryModel]);
  const fallbackModels: string[] = [];
  for (const token of rawFallbacks.split(',')) {
    const cleaned = sanitizeVisionModelIdentifier(token, 'fallback');
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      fallbackModels.push(cleaned);
    }
  }

  return {
    primaryModel,
    fallbackModels:
      fallbackModels.length > 0
        ? fallbackModels
        : DEFAULT_FALLBACK_VISION_MODELS.filter((m) => m !== primaryModel),
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
 * Computes exponential backoff with random jitter starting around 1.8 seconds.
 */
export function computeExponentialBackoffWithJitter(
  retryAttempt: number,
  baseDelayMs: number = INITIAL_BACKOFF_MS
): number {
  const exponent = Math.max(0, retryAttempt - 1);
  const exponentialDelay = baseDelayMs * Math.pow(2, exponent);
  const jitter = Math.floor(Math.random() * 450);
  return Math.min(8000, exponentialDelay + jitter);
}

// In-memory cooldown map for models that hit quota exhaustion, 404, or persistent 503 unavailability
const modelQuotaCooldownUntil = new Map<string, number>();
const MODEL_COOLDOWN_DURATION_MS = 5 * 60 * 1000; // 5 minutes for quota/404
const MODEL_TRANSIENT_COOLDOWN_MS = 60 * 1000; // 60 seconds after exhausted 503

export function clearGeminiModelCooldownsForTesting(): void {
  modelQuotaCooldownUntil.clear();
}

export type GeminiErrorCode =
  | 'MISSING_GEMINI_API_KEY'
  | 'GEMINI_AUTH_ERROR'
  | 'GEMINI_BAD_REQUEST'
  | 'GEMINI_INVALID_MODEL'
  | 'GEMINI_QUOTA_EXHAUSTED'
  | 'GEMINI_RATE_LIMIT_429'
  | 'GEMINI_TIMEOUT'
  | 'GEMINI_HIGH_DEMAND_503'
  | 'AI_EXTRACTION_FAILED';

/**
 * Extracts HTTP status code and classifies Gemini API errors into distinct operational categories:
 * - missing API key
 * - invalid API key / permission error (401/403 or API_KEY_INVALID)
 * - malformed request (400)
 * - invalid model (404)
 * - quota exceeded (429 daily/project/billing quota)
 * - transient rate limit (429 per-minute RPM/TPM)
 * - request timeout (504 / AbortError)
 * - temporary service unavailability (503 / 502)
 */
export function classifyGeminiError(err: any): {
  statusCode: number;
  errorCode: GeminiErrorCode;
  isRetryableAvailabilityError: boolean;
  isRateLimit: boolean;
  isHighDemand503: boolean;
  isTimeout: boolean;
  isAuthError: boolean;
  isInvalidModel: boolean;
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

  const isTimeout =
    Boolean(err?.isTimeout) ||
    err?.name === 'AbortError' ||
    statusCode === 504 ||
    /504|DEADLINE_EXCEEDED|gateway timeout|timed out|AbortError|The operation was aborted|request timed out/i.test(
      rawMessage
    );

  const isAuthError =
    statusCode === 401 ||
    statusCode === 403 ||
    /401|403|UNAUTHENTICATED|PERMISSION_DENIED|API_KEY_INVALID|API key not valid|invalid api key|unauthorized|forbidden/i.test(
      rawMessage
    );

  const isInvalidModel =
    statusCode === 404 ||
    /404|NOT_FOUND|models\/[^\s]+ is not found|not supported for generateContent|model not found/i.test(
      rawMessage
    );

  const isHighDemand503 =
    !isTimeout &&
    (statusCode === 503 ||
      statusCode === 502 ||
      /503|502|UNAVAILABLE|high demand|overloaded|service unavailable|temporarily unavailable|capacity|bad gateway/i.test(
        rawMessage
      ));

  const isRateLimit =
    statusCode === 429 ||
    /429|RESOURCE_EXHAUSTED|rate limit|quota|too many requests/i.test(rawMessage);

  const isModelDailyQuotaExhausted =
    isRateLimit &&
    /GenerateRequestsPerDayPerProjectPerModel|free_tier_requests|requests per day|daily quota|exceeded your current quota|billing|plan and billing|limit:\s*0\b|Please retry in \d+h/i.test(
      rawMessage
    );

  const isTemporary500 =
    !isTimeout &&
    !isAuthError &&
    !isInvalidModel &&
    (statusCode === 500 || /\b500\b|INTERNAL|fetch failed/i.test(rawMessage));

  if (!statusCode) {
    if (isTimeout) statusCode = 504;
    else if (isAuthError) statusCode = 401;
    else if (isInvalidModel) statusCode = 404;
    else if (isHighDemand503) statusCode = 503;
    else if (isRateLimit) statusCode = 429;
    else if (isTemporary500) statusCode = 502;
    else statusCode = 500;
  }

  let errorCode: GeminiErrorCode = 'AI_EXTRACTION_FAILED';
  if (err?.code === 'MISSING_GEMINI_API_KEY' || /GEMINI_API_KEY/i.test(rawMessage)) {
    errorCode = 'MISSING_GEMINI_API_KEY';
    statusCode = 503;
  } else if (isAuthError) {
    errorCode = 'GEMINI_AUTH_ERROR';
  } else if (isInvalidModel) {
    errorCode = 'GEMINI_INVALID_MODEL';
  } else if (statusCode === 400) {
    errorCode = 'GEMINI_BAD_REQUEST';
  } else if (isModelDailyQuotaExhausted) {
    errorCode = 'GEMINI_QUOTA_EXHAUSTED';
  } else if (isRateLimit) {
    errorCode = 'GEMINI_RATE_LIMIT_429';
  } else if (isTimeout) {
    errorCode = 'GEMINI_TIMEOUT';
  } else if (isHighDemand503) {
    errorCode = 'GEMINI_HIGH_DEMAND_503';
  }

  // Only retry transient 503/502/500 or transient per-minute 429 rate-limits.
  // Never retry 404 invalid model, 401/403 auth, 400 bad request, daily quota exhaustion, or 22s request timeouts.
  const isRetryableAvailabilityError =
    !isAuthError &&
    !isInvalidModel &&
    !isModelDailyQuotaExhausted &&
    !isTimeout &&
    statusCode !== 400 &&
    (isHighDemand503 || isRateLimit || isTemporary500);

  return {
    statusCode,
    errorCode,
    isRetryableAvailabilityError,
    isRateLimit,
    isHighDemand503,
    isTimeout,
    isAuthError,
    isInvalidModel,
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
    const hasCode =
      typeof parsed.detectedCode === 'string' ||
      typeof parsed.partNumber === 'string' ||
      typeof parsed.rawText === 'string';
    if (!hasCode) {
      throw new Error(
        'Malformed label OCR response: missing detectedCode, partNumber, or rawText string field.'
      );
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

export interface RawBatchItem {
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
  unit?: string;
  originalText?: string;
  confidence?: 'high' | 'medium' | 'low';
  validationWarnings?: string[];
}

export interface RawPageHeader {
  page: number;
  docketNumber?: string;
  supplier?: string;
  customerName?: string;
  deliveryDate?: string;
  carrier?: string;
  orderNumber?: string;
  jobNumber?: string;
  palletCount?: number;
  startsNewDocket?: boolean;
}

export interface BatchExtractionResponse {
  docketNumber?: string;
  supplier?: string;
  customerName?: string;
  deliveryDate?: string;
  carrier?: string;
  orderNumber?: string;
  jobNumber?: string;
  palletCount?: number;
  hasPrintedNoColumn?: boolean;
  firstVisibleRowNo?: string;
  lastVisibleRowNo?: string;
  pageHeaders?: RawPageHeader[];
  validationWarnings?: string[];
  items: RawBatchItem[];
  modelUsed: string;
  fallbackUsed: boolean;
  retryAttempts: number;
}

export const DOCKET_EXTRACTION_SYSTEM_INSTRUCTION = `You are a 100%-recall industrial delivery docket, tax invoice, and steel/laser-cutting manifest extraction engine.
Your job is to transcribe EVERY physical part row literally visible across the provided page image(s) and/or extracted PDF text into the JSON 'items' array without skipping or merging any rows.
INDUSTRIAL DOCKET & ANTI-HALLUCINATION RULES:
- Preserve original part numbers (including Laser Central, GCI, and J-series formats), revisions, units, and quantities exactly as printed.
- If a part number wraps across two visual lines inside a narrow column cell, join the continuation text cleanly without adding extra words.
- Never confuse contact phone/fax numbers, ABN numbers, postcodes, dates, bank details, weights (kg), dimensions (mm), or unit prices ($) with part numbers or quantities.
- If a character or digit in a smudged/skewed area is uncertain, record your best literal reading, include the exact raw row snippet in 'originalText', set confidence='low', and explain the uncertainty in 'validationWarnings'. NEVER invent missing rows or guess fabricated codes.
- Only extract physical part rows literally present in the document. If a document is blank or contains no physical part rows, return items: [].`;

export const GCI_MISSING_JOB_NO_WARNING =
  'GCI Job No is missing or unreadable — verify and enter the printed Job No into Docket / Ref # manually (Client Order No was not substituted).';

export function isGciSupplierHint(supplierHint?: string): boolean {
  return typeof supplierHint === 'string' && supplierHint.trim().toLowerCase() === 'gci';
}

export function cleanGciRefToken(raw?: string): string {
  const s = String(raw || '')
    .replace(/^(?:client\s*order\s*(?:no|num|number|#)|job\s*(?:no|num|number|#)|docket\s*(?:no|num|number|#)|order\s*(?:no|num|number|#)|po\s*(?:no|num|number|#)?)\s*[:#.\-]?\s*/i, '')
    .trim();
  return s;
}

export function isSyntheticDocketPlaceholder(raw?: string): boolean {
  return /^DK-(?:REVIEW-)?(?:P?\d+-)?\d+$/i.test(String(raw || '').trim());
}

export function normalizeGciDispatchDate(rawDate?: string): string | undefined {
  const s = String(rawDate || '').trim();
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Australian DD/MM/YYYY or DD-MM-YYYY (e.g. 12/11/2026 -> 2026-11-12)
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmy) {
    let day = parseInt(dmy[1], 10);
    let month = parseInt(dmy[2], 10);
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    if (month > 12 && day >= 1 && day <= 12) {
      const swap = day;
      day = month;
      month = swap;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // e.g. "12 Nov 2026" or "12 November 2026"
  const named = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (named) {
    const months: Record<string, string> = {
      jan: '01', january: '01',
      feb: '02', february: '02',
      mar: '03', march: '03',
      apr: '04', april: '04',
      may: '05',
      jun: '06', june: '06',
      jul: '07', july: '07',
      aug: '08', august: '08',
      sep: '09', sept: '09', september: '09',
      oct: '10', october: '10',
      nov: '11', november: '11',
      dec: '12', december: '12',
    };
    const mCode = months[named[2].toLowerCase()];
    const day = parseInt(named[1], 10);
    if (mCode && day >= 1 && day <= 31) {
      return `${named[3]}-${mCode}-${String(day).padStart(2, '0')}`;
    }
  }

  return undefined;
}

export function extractGciFieldsFromSelectableText(selectableText?: string): {
  jobNo?: string;
  clientOrderNo?: string;
  dispatchDate?: string;
} {
  const text = String(selectableText || '').trim();
  if (!text) return {};

  let jobNo: string | undefined;
  let clientOrderNo: string | undefined;
  let dispatchDate: string | undefined;

  const clientOrderMatch = text.match(/Client\s*Order\s*(?:No|Num|Number|#)?\s*[:#.\-|\s]+\s*([A-Z0-9][A-Z0-9\-_/]{2,18})/i);
  if (clientOrderMatch?.[1] && !/^(?:JOB|NO|DATE|DESPATCH|DISPATCH)$/i.test(clientOrderMatch[1])) {
    clientOrderNo = clientOrderMatch[1].trim();
  }

  const jobMatch = text.match(/Job\s*(?:No|Num|Number|#)\s*[:#.\-|\s]+\s*([A-Z0-9][A-Z0-9\-_/]{2,18})/i);
  if (jobMatch?.[1] && !/^(?:NO|DATE|DESPATCH|DISPATCH|BY)$/i.test(jobMatch[1])) {
    jobNo = jobMatch[1].trim();
  }

  const dateMatch = text.match(/(?:Despatch|Dispatch)\s*Date\s*[:#.\-|\s]+\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})/i);
  if (dateMatch?.[1]) {
    dispatchDate = normalizeGciDispatchDate(dateMatch[1].trim());
  }

  // Fallback for two-line tabular header: "Client Order No | Job No | Despatch Date" -> "72018 | 194322 | 12/11/2026"
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length - 1; i++) {
    if (/\bclient\s*order\b/i.test(lines[i]) && /\bjob\s*no\b/i.test(lines[i])) {
      const valLine = lines[i + 1];
      const tabular = valLine.match(/([A-Z0-9\-]{3,16})\s*(?:\||\s{2,}|\s)\s*([A-Z0-9\-]{4,16})(?:\s*(?:\||\s)\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2}))?/i);
      if (tabular) {
        if (!clientOrderNo && tabular[1]) clientOrderNo = tabular[1].trim();
        if (!jobNo && tabular[2]) jobNo = tabular[2].trim();
        if (!dispatchDate && tabular[3]) dispatchDate = normalizeGciDispatchDate(tabular[3].trim());
      }
      break;
    }
  }

  return { jobNo, clientOrderNo, dispatchDate };
}

export function resolveGciPageHeaderFields(
  input: {
    docketNumber?: string;
    jobNumber?: string;
    orderNumber?: string;
    deliveryDate?: string;
    supplier?: string;
    validationWarnings?: string[];
  },
  options?: {
    selectableText?: string;
    isContinuationWithoutHeader?: boolean;
  }
): {
  docketNumber: string;
  jobNumber?: string;
  orderNumber?: string;
  deliveryDate?: string;
  supplier: string;
  missingJobNo: boolean;
  validationWarnings: string[];
} {
  const normId = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '');
  const rawDocketClean = cleanGciRefToken(input.docketNumber);
  const rawDocket = isSyntheticDocketPlaceholder(rawDocketClean) ? '' : rawDocketClean;
  const rawJob = cleanGciRefToken(input.jobNumber);
  const rawOrder = cleanGciRefToken(input.orderNumber);
  const textHints = extractGciFieldsFromSelectableText(options?.selectableText);

  const resolvedOrder = rawOrder || textHints.clientOrderNo || '';
  const orderNorm = normId(resolvedOrder);
  const textOrderNorm = normId(textHints.clientOrderNo || '');

  let resolvedJob = '';
  if (rawJob && (!orderNorm || normId(rawJob) !== orderNorm) && (!textOrderNorm || normId(rawJob) !== textOrderNorm)) {
    resolvedJob = rawJob;
  } else if (textHints.jobNo && (!orderNorm || normId(textHints.jobNo) !== orderNorm)) {
    resolvedJob = textHints.jobNo;
  } else if (
    rawDocket &&
    (!orderNorm || normId(rawDocket) !== orderNorm) &&
    (!textOrderNorm || normId(rawDocket) !== textOrderNorm)
  ) {
    resolvedJob = rawDocket;
  }

  const resolvedDate =
    normalizeGciDispatchDate(input.deliveryDate) ||
    textHints.dispatchDate;

  const missingJobNo = !resolvedJob && !options?.isContinuationWithoutHeader;
  const warnings = Array.from(
    new Set((input.validationWarnings || []).map((w) => String(w || '').trim()).filter(Boolean))
  );
  if (missingJobNo && !warnings.some((w) => /GCI Job No/i.test(w))) {
    warnings.push(GCI_MISSING_JOB_NO_WARNING);
  }

  return {
    docketNumber: resolvedJob,
    jobNumber: resolvedJob || undefined,
    orderNumber: resolvedOrder || undefined,
    deliveryDate: resolvedDate,
    supplier: 'GCI',
    missingJobNo,
    validationWarnings: warnings,
  };
}

export function buildDocketExtractionPrompt(
  pageDescriptions: string[],
  pageNumbers: number[],
  totalPages: number,
  supplierHint?: string
): string {
  const basePrompt = `Examine ${pageDescriptions.join(' and ')} (out of ${totalPages} total pages) and extract EVERY physical part row literally visible in top-to-bottom order. If the document is blank or has no part rows, return items: [].

MANDATORY 100%-RECALL EXTRACTION RULES:
1. RECORD FIRST & LAST VISIBLE ROW NUMBERS:
   - Record printed "No" of first visible part row in 'firstVisibleRowNo' and last visible row in 'lastVisibleRowNo' (or "" if none).
2. EXTRACT EVERY SINGLE PART ROW FROM TOP TO BOTTOM:
   - Never skip a numbered row and never merge two separate numbered rows into one item.
   - If a page is presented as an UPPER half and a LOWER half with center overlap, read top-to-bottom without duplicating overlap rows and without skipping rows near the seam.
   - Preserve legitimate separate rows even if the same part number appears multiple times with different revisions, pallets, descriptions, or line numbers.
3. IGNORE NON-PART LINES:
   - Exclude phone/fax numbers, ABN numbers, street/postal codes, delivery instructions, header barcodes, consignment notes, column headers, weights/kg totals, and tax/charge rows (Freight, Delivery, Setup, Pallet Fee, Subtotal, GST, Total, Balance Due).
4. MULTIPLE DOCKETS / PAGE HEADERS:
   - Record one entry in 'pageHeaders' for EVERY page (${pageNumbers.join(', ')}) with: page, docketNumber (exact printed Docket No, Delivery Note, Packing Slip, Tax Invoice No; "" if continuation page has no header), supplier (sender/fabricator e.g. Laser Central, GCI), customerName (Deliver To / Customer / Bill To recipient), deliveryDate (YYYY-MM-DD if visible), orderNumber (Customer PO / Order No), jobNumber (Job # / Work Order # if separate), carrier, palletCount, and startsNewDocket (true if this page clearly starts a new docket/invoice).
5. FIELD MAPPING FOR EACH PART ROW:
   - page: Page number (${pageNumbers.join(' or ')}) where row appears.
   - no: Exact printed "No" / "Item" / "Pos" / "Line" / "#" number (if a NEW docket starts and numbering restarts at 1, keep "1").
   - part: Exact Part Number, Client Part Code, Drawing Number, J-series code, Mark, or Profile Name as printed. Join wrapped multi-line part codes cleanly. Never place row numbers, phone numbers, or quantities into 'part'.
   - desc: Full part description written on the row. If quantity/unit like "4 EA" appears beside description while Qty column is numeric, keep unit ("EA") in 'unit'.
   - rev: Drawing revision / Rev code if shown ("A", "B", "01"), else "".
   - mat: Material grade if printed, else "".
   - thk: Thickness if printed, else "".
   - dim: Dimensions/size if printed, else "".
   - wt: Weight if printed, else "".
   - unit: Unit of measurement (e.g. "EA", "PC", "PCS", "SET", "M", "KG") if shown, else "".
   - qty: Dispatched/delivered numeric quantity (prefer "Desp" / "Despatched" / "Shipped" / "Qty"; never use Unit Price $ or Total $).
   - originalText: Exact raw text string read from this row when helpful for review/verification.
   - confidence: "high", "medium", or "low" (use "low" if smudged, faded, ambiguous, or split awkwardly).
   - validationWarnings: Array of short warnings for this row if uncertain (else []).`;

  if (!isGciSupplierHint(supplierHint)) {
    return basePrompt;
  }

  return `${basePrompt}

6. GCI SUPPLIER-SPECIFIC HEADER MAPPING (CRITICAL — DO NOT SWAP):
   - The user selected supplier = GCI. GCI dockets use header labels: "Client Order No", "Job No", "Despatch Date" / "Dispatch Date", and "Despatched By".
   - "Job No" (e.g. 194322) IS the primary Docket / Ref # -> populate BOTH 'docketNumber' and 'jobNumber' with the exact Job No value in 'pageHeaders' and top-level fields.
   - "Client Order No" (e.g. 72018) IS the customer PO / Order # -> populate 'orderNumber' ONLY. NEVER place "Client Order No" into 'docketNumber' or 'jobNumber'.
   - "Despatch Date" / "Dispatch Date" (Australian DD/MM/YYYY format, e.g. 12/11/2026 -> 2026-11-12) -> populate 'deliveryDate' formatted as YYYY-MM-DD.
   - Set 'supplier' to "GCI".
   - Multi-page & multi-docket GCI grouping: Use "Job No" as the primary identifier for independent GCI dockets. Group continuation pages sharing the same "Job No" together; if a page has a different "Job No", set startsNewDocket=true and keep its corresponding "Client Order No" in 'orderNumber'.
   - Missing or unreadable Job No: If "Job No" is missing or unreadable on a page, leave 'docketNumber' and 'jobNumber' empty "" and note it in 'validationWarnings'. NEVER substitute "Client Order No" into 'docketNumber'.`;
}

export function buildRestDocketResponseSchema(): Record<string, unknown> {
  return {
    type: 'OBJECT',
    properties: {
      docketNumber: { type: 'STRING' },
      supplier: { type: 'STRING' },
      customerName: { type: 'STRING' },
      deliveryDate: { type: 'STRING' },
      orderNumber: { type: 'STRING' },
      jobNumber: { type: 'STRING' },
      carrier: { type: 'STRING' },
      palletCount: { type: 'INTEGER' },
      validationWarnings: { type: 'ARRAY', items: { type: 'STRING' } },
      pageHeaders: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            page: { type: 'INTEGER' },
            docketNumber: { type: 'STRING' },
            supplier: { type: 'STRING' },
            customerName: { type: 'STRING' },
            deliveryDate: { type: 'STRING' },
            orderNumber: { type: 'STRING' },
            jobNumber: { type: 'STRING' },
            carrier: { type: 'STRING' },
            palletCount: { type: 'INTEGER' },
            startsNewDocket: { type: 'BOOLEAN' },
          },
          required: ['page'],
        },
      },
      hasPrintedNoColumn: { type: 'BOOLEAN' },
      firstVisibleRowNo: { type: 'STRING' },
      lastVisibleRowNo: { type: 'STRING' },
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            page: { type: 'INTEGER' },
            no: { type: 'STRING' },
            part: { type: 'STRING' },
            desc: { type: 'STRING' },
            rev: { type: 'STRING' },
            mat: { type: 'STRING' },
            thk: { type: 'STRING' },
            dim: { type: 'STRING' },
            wt: { type: 'STRING' },
            unit: { type: 'STRING' },
            qty: { type: 'NUMBER' },
            originalText: { type: 'STRING' },
            confidence: { type: 'STRING' },
            validationWarnings: { type: 'ARRAY', items: { type: 'STRING' } },
          },
          required: ['no', 'part', 'desc', 'qty'],
        },
      },
    },
    required: ['items'],
  };
}

/**
 * Executes a Gemini generateContent call with:
 * 1. Per-request 22s AbortController timeout
 * 2. At most 1 automatic retry for transient HTTP 503/502 or rate-limit errors
 * 3. Immediate fast failover on 404 invalid model, daily quota exhaustion, or timeout
 * 4. Immediate abort on 401/403 authentication or 400 malformed request errors
 * 5. Cooldown tracking for unavailable or quota-exhausted models
 * 6. Strict validation of extracted JSON data before accepting results
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

  // Place models not in cooldown first so subsequent calls don't re-hit an exhausted/unavailable model
  const candidateModels = useCooldownMemory
    ? [
        ...allConfiguredModels.filter((m) => (modelQuotaCooldownUntil.get(m) || 0) <= nowMs),
        ...allConfiguredModels.filter((m) => (modelQuotaCooldownUntil.get(m) || 0) > nowMs),
      ]
    : allConfiguredModels;

  let totalRetryAttempts = 0;
  let lastError: any = null;
  let lastClassification: ReturnType<typeof classifyGeminiError> | null = null;

  for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
    const currentModel = candidateModels[mIdx];
    const isFallbackModel = currentModel !== primaryModel;
    const maxRetriesForModel = MAX_AUTOMATIC_RETRIES;

    logOcrEvent('info', isFallbackModel ? 'model_fallback_selected' : 'model_selected', {
      model: currentModel,
      isFallback: isFallbackModel,
      mode,
    });

    for (let retry = 0; retry <= maxRetriesForModel; retry++) {
      const controller = new AbortController();
      const timeoutMs = GEMINI_REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const config: Record<string, unknown> = {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema,
          abortSignal: controller.signal,
        };

        // Gemini 4 Hydrogen supports ThinkingLevel.LOW / MEDIUM (never pass temperature/topP/topK/MINIMAL)
        if (ThinkingLevel && currentModel.includes('gemini-4-hydrogen')) {
          config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW || ThinkingLevel.MEDIUM };
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
        if (controller.signal.aborted && !err?.isTimeout) {
          const timeoutErr: any = new Error(
            `Gemini API request to ${currentModel} timed out after ${Math.round(timeoutMs / 1000)}s (HTTP 504).`
          );
          timeoutErr.status = 504;
          timeoutErr.code = 'GEMINI_TIMEOUT';
          timeoutErr.isTimeout = true;
          err = timeoutErr;
        }

        lastError = err;
        const classification = classifyGeminiError(err);
        lastClassification = classification;

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
          errorCode: classification.errorCode,
          isRetryable: classification.isRetryableAvailabilityError || isValidationFailure,
          reason: classification.cleanMessage,
        });

        // Permanent client/credential errors (401/403 Auth or 400 Bad Request) must immediately abort
        if (
          !isValidationFailure &&
          (classification.isAuthError || classification.statusCode === 400)
        ) {
          const permErr: any = new Error(
            classification.isAuthError
              ? `Gemini API authentication/permission error (HTTP ${classification.statusCode}): ${classification.cleanMessage}`
              : `Gemini API malformed request error (HTTP 400): ${classification.cleanMessage}`
          );
          permErr.status = classification.statusCode;
          permErr.code = classification.errorCode;
          permErr.retryable = false;
          throw permErr;
        }

        // Do not retry 404 invalid model, daily quota exhaustion, or 22s request timeout on the same model:
        // record cooldown and immediately advance to the next fallback model if available.
        if (
          !isValidationFailure &&
          (classification.isInvalidModel ||
            classification.isModelDailyQuotaExhausted ||
            classification.isTimeout)
        ) {
          if (useCooldownMemory) {
            const cooldownMs = classification.isTimeout
              ? MODEL_TRANSIENT_COOLDOWN_MS
              : MODEL_COOLDOWN_DURATION_MS;
            modelQuotaCooldownUntil.set(currentModel, Date.now() + cooldownMs);
          }
          logOcrEvent('info', 'model_fast_failover', {
            failedModel: currentModel,
            nextModel: candidateModels[mIdx + 1] || 'none',
            statusCode: classification.statusCode,
            errorCode: classification.errorCode,
          });
          break;
        }

        if (
          (classification.isRetryableAvailabilityError || isValidationFailure) &&
          retry < maxRetriesForModel
        ) {
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

        // Retries exhausted for this model on 503/429 -> put model in brief cooldown before failing over
        if (useCooldownMemory && (classification.isHighDemand503 || classification.isRateLimit)) {
          modelQuotaCooldownUntil.set(currentModel, Date.now() + MODEL_TRANSIENT_COOLDOWN_MS);
        }
      }
    }
  }

  const finalClassification = lastClassification || classifyGeminiError(lastError);

  logOcrEvent('error', 'all_models_and_retries_exhausted', {
    primaryModel,
    fallbackModels: fallbackModels.join(','),
    totalRetryAttempts,
    lastStatusCode: finalClassification.statusCode,
    errorCode: finalClassification.errorCode,
    error: finalClassification.cleanMessage,
  });

  if (finalClassification.isInvalidModel) {
    const modelErr: any = new Error(
      `Gemini model unavailable or invalid (HTTP 404): ${finalClassification.cleanMessage}`
    );
    modelErr.status = 404;
    modelErr.code = 'GEMINI_INVALID_MODEL';
    modelErr.retryable = false;
    throw modelErr;
  }

  if (finalClassification.isModelDailyQuotaExhausted) {
    const quotaErr: any = new Error(
      `Gemini AI quota exceeded (HTTP 429): ${finalClassification.cleanMessage}`
    );
    quotaErr.status = 429;
    quotaErr.code = 'GEMINI_QUOTA_EXHAUSTED';
    quotaErr.retryable = false;
    throw quotaErr;
  }

  if (finalClassification.isTimeout) {
    const timeoutErr: any = new Error(
      `Gemini AI extraction timed out (HTTP 504) after ${Math.round(GEMINI_REQUEST_TIMEOUT_MS / 1000)}s per request. Your uploaded docket has been preserved — please click "Retry Extraction".`
    );
    timeoutErr.status = 504;
    timeoutErr.code = 'GEMINI_TIMEOUT';
    timeoutErr.retryable = true;
    throw timeoutErr;
  }

  if (finalClassification.isHighDemand503) {
    const busyErr: any = new Error(
      `Gemini AI is currently experiencing high demand (HTTP 503) after ${totalRetryAttempts} automatic retry and fallback to ${fallbackModels[0] || 'secondary model'}. Your uploaded docket has been preserved — please click "Retry Extraction" in a moment.`
    );
    busyErr.status = 503;
    busyErr.code = 'GEMINI_HIGH_DEMAND_503';
    busyErr.retryable = true;
    throw busyErr;
  }

  if (finalClassification.isRateLimit) {
    const rateErr: any = new Error(
      `Gemini AI rate limit reached (HTTP 429) after ${totalRetryAttempts} automatic retry. Your uploaded docket has been preserved — please wait a few seconds and click "Retry Extraction".`
    );
    rateErr.status = 429;
    rateErr.code = 'GEMINI_RATE_LIMIT_429';
    rateErr.retryable = true;
    throw rateErr;
  }

  const genericErr: any = new Error(
    finalClassification.cleanMessage ||
      'Gemini AI could not extract the docket after automatic retries. Please click "Retry Extraction".'
  );
  genericErr.status = finalClassification.statusCode || 500;
  genericErr.code = finalClassification.errorCode || 'AI_EXTRACTION_FAILED';
  throw genericErr;
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
  totalPages: number,
  supplierHint?: string
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

  const systemInstruction = DOCKET_EXTRACTION_SYSTEM_INSTRUCTION;

  const promptText = buildDocketExtractionPrompt(
    pageDescriptions,
    batchPages.map((b) => b.pageNumber),
    totalPages,
    supplierHint
  );

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      docketNumber: { type: Type.STRING },
      supplier: { type: Type.STRING },
      customerName: { type: Type.STRING },
      deliveryDate: { type: Type.STRING },
      orderNumber: { type: Type.STRING },
      jobNumber: { type: Type.STRING },
      carrier: { type: Type.STRING },
      palletCount: { type: Type.INTEGER },
      validationWarnings: { type: Type.ARRAY, items: { type: Type.STRING } },
      pageHeaders: {
        type: Type.ARRAY,
        description: 'Per-page docket header metadata used to keep multi-page dockets together and separate distinct dockets.',
        items: {
          type: Type.OBJECT,
          properties: {
            page: { type: Type.INTEGER },
            docketNumber: { type: Type.STRING },
            supplier: { type: Type.STRING },
            customerName: { type: Type.STRING },
            deliveryDate: { type: Type.STRING },
            orderNumber: { type: Type.STRING },
            jobNumber: { type: Type.STRING },
            carrier: { type: Type.STRING },
            palletCount: { type: Type.INTEGER },
            startsNewDocket: { type: Type.BOOLEAN },
          },
          required: ['page'],
        },
      },
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
            unit: { type: Type.STRING, description: 'Unit of measurement (e.g. EA, PCS, SET).' },
            qty: { type: Type.NUMBER, description: 'Quantity of this part (never price).' },
            originalText: { type: Type.STRING, description: 'Raw row text snippet if uncertain.' },
            confidence: { type: Type.STRING, description: 'high, medium, or low.' },
            validationWarnings: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ['no', 'part', 'desc', 'qty'],
          propertyOrdering: [
            'page',
            'no',
            'part',
            'desc',
            'rev',
            'mat',
            'thk',
            'dim',
            'wt',
            'unit',
            'qty',
            'originalText',
            'confidence',
            'validationWarnings',
          ],
        },
      },
    },
    required: ['items'],
    propertyOrdering: [
      'docketNumber',
      'supplier',
      'customerName',
      'deliveryDate',
      'orderNumber',
      'jobNumber',
      'carrier',
      'palletCount',
      'validationWarnings',
      'pageHeaders',
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
    customerName: parsed.customerName,
    deliveryDate: parsed.deliveryDate,
    carrier: parsed.carrier,
    orderNumber: parsed.orderNumber,
    jobNumber: parsed.jobNumber,
    palletCount: parsed.palletCount,
    validationWarnings: Array.isArray(parsed.validationWarnings) ? parsed.validationWarnings : [],
    pageHeaders: Array.isArray(parsed.pageHeaders) ? parsed.pageHeaders : [],
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
export function normalizeRawBatchItem(
  it: RawBatchItem,
  defaultPageNumber: number
): { cleanNo: string; item: ExtractedDocketItem } | null {
  let pn = String(it.part || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const desc = String(it.desc || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!pn && !desc) return null;

  // Exclude non-item commercial, tax, contact, ABN, and header/footer lines
  if (
    /^(?:subtotal|sub-total|total|gst|tax|freight|delivery\s*charge|cartage|balance\s*due|amount\s*due|discount|abn|acn|phone|ph:|fax|email|web|bsb|account|page\s*\d+\s*of\s*\d+)$/i.test(
      pn
    ) ||
    /^(?:subtotal|sub-total|gst\s*10%?|total\s*incl|total\s*excl|amount\s*due|balance\s*due|freight\s*charge|bank\s*details|remittance\s*advice|terms\s*and\s*conditions)$/i.test(
      desc
    ) ||
    /^(?:0[2378]\s*\d{4}\s*\d{4}|\(\s*0[2378]\s*\)\s*\d{4}\s*\d{4}|\+61\s*\d[\s\d]{7,10})$/.test(pn) ||
    /^(?:ABN|ACN)\s*[:#]?\s*[\d\s]{9,14}$/i.test(pn)
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
  const cleanUnit = it.unit && String(it.unit).trim() ? String(it.unit).trim().toUpperCase() : undefined;
  const rawWarnings = Array.isArray(it.validationWarnings)
    ? it.validationWarnings.map((w) => String(w || '').trim()).filter(Boolean)
    : [];
  const rawConf = String(it.confidence || '').toLowerCase();
  const confidence: 'high' | 'medium' | 'low' =
    rawConf === 'low' ? 'low' : rawConf === 'medium' ? 'medium' : 'high';

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
      unit: cleanUnit,
      palletNumber: 'Pallet 1',
      pageNumber: resolvedPage,
      originalText: it.originalText && String(it.originalText).trim() ? String(it.originalText).trim() : undefined,
      confidence,
      validationFlags: rawWarnings.length > 0 ? rawWarnings : undefined,
      validationWarnings: rawWarnings.length > 0 ? rawWarnings : undefined,
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
  overrideApiKey?: string,
  supplierHint?: string
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
  const isGci = isGciSupplierHint(supplierHint);

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
      pair.map((b) => extractPageBatchInOneCall(ai, Type, ThinkingLevel, b, totalPages, supplierHint))
    );
    batchResponses.push(...pairRes);
  }

  // Segment pages into independent dockets using pageHeaders and row-numbering continuity
  interface VisionPageMeta {
    pageNumber: number;
    explicitDocketNumber: string;
    supplier?: string;
    customerName?: string;
    deliveryDate?: string;
    orderNumber?: string;
    jobNumber?: string;
    carrier?: string;
    palletCount?: number;
    startsNewDocket?: boolean;
    validationWarnings: string[];
    rawItems: RawBatchItem[];
    minRowNo?: number;
    maxRowNo?: number;
  }

  const pageMetaMap = new Map<number, VisionPageMeta>();
  for (let p = 1; p <= totalPages; p++) {
    pageMetaMap.set(p, {
      pageNumber: p,
      explicitDocketNumber: '',
      validationWarnings: [],
      rawItems: [],
    });
  }

  let anyPrintedNoColumn = false;
  let modelUsed = DEFAULT_PRIMARY_VISION_MODEL;
  let fallbackUsed = false;
  let totalRetries = 0;

  for (let bIdx = 0; bIdx < batchResponses.length; bIdx++) {
    const bRes = batchResponses[bIdx];
    modelUsed = bRes.modelUsed || modelUsed;
    fallbackUsed = fallbackUsed || Boolean(bRes.fallbackUsed);
    totalRetries += bRes.retryAttempts || 0;
    if (bRes.hasPrintedNoColumn !== false) {
      anyPrintedNoColumn = true;
    }

    const batchPageNums = batches[bIdx].map((b) => b.pageNumber);
    const defaultPage = batchPageNums[0];

    for (const ph of bRes.pageHeaders || []) {
      const pNum = Math.min(totalPages, Math.max(1, Number((ph as any).page ?? (ph as any).pageNumber) || defaultPage));
      const meta = pageMetaMap.get(pNum)!;
      const dn = String(ph.docketNumber || '').trim();
      if (dn && !meta.explicitDocketNumber) meta.explicitDocketNumber = dn;
      if (ph.supplier && ph.supplier.trim() && !meta.supplier) meta.supplier = ph.supplier.trim();
      if (ph.customerName && ph.customerName.trim() && !meta.customerName) {
        meta.customerName = ph.customerName.trim();
      }
      if (ph.deliveryDate && !meta.deliveryDate) {
        const trimmedDate = ph.deliveryDate.trim();
        if (isGci) {
          const normDate = normalizeGciDispatchDate(trimmedDate);
          if (normDate) meta.deliveryDate = normDate;
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate)) {
          meta.deliveryDate = trimmedDate;
        }
      }
      if (ph.orderNumber && ph.orderNumber.trim() && !meta.orderNumber) meta.orderNumber = ph.orderNumber.trim();
      if (ph.jobNumber && ph.jobNumber.trim() && !meta.jobNumber) meta.jobNumber = ph.jobNumber.trim();
      if (ph.carrier && ph.carrier.trim() && !meta.carrier) meta.carrier = ph.carrier.trim();
      if (ph.palletCount && ph.palletCount > 0 && !meta.palletCount) meta.palletCount = ph.palletCount;
      if (ph.startsNewDocket) meta.startsNewDocket = true;
    }

    // Backfill page 1 of batch if pageHeaders omitted batch-level header fields
    const firstMeta = pageMetaMap.get(defaultPage)!;
    if (!firstMeta.explicitDocketNumber && bRes.docketNumber?.trim() && (batchPageNums.length === 1 || (bRes.pageHeaders || []).length === 0)) {
      firstMeta.explicitDocketNumber = bRes.docketNumber.trim();
    }
    if (!firstMeta.supplier && bRes.supplier?.trim()) firstMeta.supplier = bRes.supplier.trim();
    if (!firstMeta.customerName && bRes.customerName?.trim()) {
      firstMeta.customerName = bRes.customerName.trim();
    }
    if (!firstMeta.deliveryDate && bRes.deliveryDate) {
      const trimmedDate = bRes.deliveryDate.trim();
      if (isGci) {
        const normDate = normalizeGciDispatchDate(trimmedDate);
        if (normDate) firstMeta.deliveryDate = normDate;
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate)) {
        firstMeta.deliveryDate = trimmedDate;
      }
    }
    if (!firstMeta.orderNumber && bRes.orderNumber?.trim()) firstMeta.orderNumber = bRes.orderNumber.trim();
    if (!firstMeta.jobNumber && bRes.jobNumber?.trim()) firstMeta.jobNumber = bRes.jobNumber.trim();
    if (!firstMeta.carrier && bRes.carrier?.trim()) firstMeta.carrier = bRes.carrier.trim();
    if (Array.isArray(bRes.validationWarnings) && bRes.validationWarnings.length > 0) {
      firstMeta.validationWarnings.push(...bRes.validationWarnings.map((w) => String(w || '').trim()).filter(Boolean));
    }

    for (const rawIt of bRes.items || []) {
      const targetPage = Math.min(totalPages, Math.max(1, Number((rawIt as any).page ?? (rawIt as any).pageNumber) || defaultPage));
      const meta = pageMetaMap.get(targetPage)!;
      meta.rawItems.push({ ...rawIt, page: targetPage });
      const nVal = parseInt(parseCleanRowNo(rawIt.no), 10);
      if (!Number.isNaN(nVal) && nVal > 0 && nVal <= 1500) {
        meta.minRowNo = meta.minRowNo === undefined ? nVal : Math.min(meta.minRowNo, nVal);
        meta.maxRowNo = meta.maxRowNo === undefined ? nVal : Math.max(meta.maxRowNo, nVal);
      }
    }
  }

  // Apply GCI-specific header field resolution per page BEFORE docket segmentation
  if (isGci) {
    for (let p = 1; p <= totalPages; p++) {
      const meta = pageMetaMap.get(p)!;
      const resolved = resolveGciPageHeaderFields(
        {
          docketNumber: meta.explicitDocketNumber,
          jobNumber: meta.jobNumber,
          orderNumber: meta.orderNumber,
          deliveryDate: meta.deliveryDate,
          supplier: meta.supplier,
          validationWarnings: meta.validationWarnings,
        },
        {
          selectableText: resolvedPayloads[p - 1]?.pdfSelectableText,
          // Evaluate missingJobNo accurately later if this page turns out to be a continuation page
          isContinuationWithoutHeader: p > 1,
        }
      );
      meta.explicitDocketNumber = resolved.docketNumber;
      meta.jobNumber = resolved.jobNumber;
      meta.orderNumber = resolved.orderNumber;
      if (resolved.deliveryDate) meta.deliveryDate = resolved.deliveryDate;
      meta.supplier = 'GCI';
      meta.validationWarnings = resolved.validationWarnings;
    }
  }

  // Group pages into independent docket segments
  interface VisionSegment {
    docketKey: string;
    explicitDocketNumber: string;
    hasExplicitDocketNumber: boolean;
    supplier: string;
    customerName?: string;
    deliveryDate: string;
    carrier?: string;
    orderNumber?: string;
    jobNumber?: string;
    palletCount: number;
    pageNumbers: number[];
    maxRowSeen: number;
    rawItems: RawBatchItem[];
    validationWarnings: string[];
    separationUncertain: boolean;
    separationReason?: string;
  }

  const segments: VisionSegment[] = [];
  const normDocketKey = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '');

  for (let p = 1; p <= totalPages; p++) {
    const meta = pageMetaMap.get(p)!;
    const explicitKey = normDocketKey(meta.explicitDocketNumber);
    const hasExplicit = explicitKey.length > 0;

    if (segments.length === 0) {
      if (isGci && !hasExplicit) {
        const missingKey = `GCI-MISSING-JOB-P${p}-${Math.floor(100 + Math.random() * 900)}`;
        const missingWarnings = Array.from(
          new Set([...meta.validationWarnings, GCI_MISSING_JOB_NO_WARNING])
        );
        segments.push({
          docketKey: missingKey,
          explicitDocketNumber: '',
          hasExplicitDocketNumber: false,
          supplier: 'GCI',
          customerName: meta.customerName,
          deliveryDate: meta.deliveryDate || new Date().toISOString().slice(0, 10),
          carrier: meta.carrier,
          orderNumber: meta.orderNumber,
          jobNumber: undefined,
          palletCount: Math.max(1, meta.palletCount || 1),
          pageNumbers: [p],
          maxRowSeen: meta.maxRowNo || 0,
          rawItems: [...meta.rawItems],
          validationWarnings: missingWarnings,
          separationUncertain: true,
          separationReason: GCI_MISSING_JOB_NO_WARNING,
        });
      } else {
        const fallbackDk = `DK-${Math.floor(10000 + Math.random() * 90000)}`;
        segments.push({
          docketKey: hasExplicit ? explicitKey : fallbackDk,
          explicitDocketNumber: meta.explicitDocketNumber || fallbackDk,
          hasExplicitDocketNumber: hasExplicit,
          supplier: meta.supplier || 'Steel Fabrication Supplier',
          customerName: meta.customerName,
          deliveryDate: meta.deliveryDate || new Date().toISOString().slice(0, 10),
          carrier: meta.carrier,
          orderNumber: meta.orderNumber,
          jobNumber: meta.jobNumber,
          palletCount: Math.max(1, meta.palletCount || 1),
          pageNumbers: [p],
          maxRowSeen: meta.maxRowNo || 0,
          rawItems: [...meta.rawItems],
          validationWarnings: [...meta.validationWarnings],
          separationUncertain: !hasExplicit && totalPages > 1,
          separationReason:
            !hasExplicit && totalPages > 1
              ? 'Docket number not detected on page 1 — verify page boundaries.'
              : undefined,
        });
      }
      continue;
    }

    // Never merge pages whose explicit docket numbers differ!
    if (hasExplicit) {
      const existingSameDocket = segments.find(
        (seg) => seg.hasExplicitDocketNumber && seg.docketKey === explicitKey
      );
      if (existingSameDocket) {
        existingSameDocket.pageNumbers.push(p);
        existingSameDocket.rawItems.push(...meta.rawItems);
        existingSameDocket.validationWarnings.push(...meta.validationWarnings);
        existingSameDocket.maxRowSeen = Math.max(existingSameDocket.maxRowSeen, meta.maxRowNo || 0);
        if (!existingSameDocket.carrier && meta.carrier) existingSameDocket.carrier = meta.carrier;
        if (!existingSameDocket.orderNumber && meta.orderNumber) existingSameDocket.orderNumber = meta.orderNumber;
        if (!existingSameDocket.customerName && meta.customerName) existingSameDocket.customerName = meta.customerName;
        if (!existingSameDocket.jobNumber && meta.jobNumber) existingSameDocket.jobNumber = meta.jobNumber;
        existingSameDocket.palletCount = Math.max(existingSameDocket.palletCount, meta.palletCount || 1);
      } else {
        segments.push({
          docketKey: explicitKey,
          explicitDocketNumber: meta.explicitDocketNumber,
          hasExplicitDocketNumber: true,
          supplier: meta.supplier || 'Steel Fabrication Supplier',
          customerName: meta.customerName,
          deliveryDate: meta.deliveryDate || new Date().toISOString().slice(0, 10),
          carrier: meta.carrier,
          orderNumber: meta.orderNumber,
          jobNumber: meta.jobNumber,
          palletCount: Math.max(1, meta.palletCount || 1),
          pageNumbers: [p],
          maxRowSeen: meta.maxRowNo || 0,
          rawItems: [...meta.rawItems],
          validationWarnings: [...meta.validationWarnings],
          separationUncertain: false,
        });
      }
      continue;
    }

    // No explicit docket number on this page: decide continuation vs uncertain boundary split
    const prevSeg = segments[segments.length - 1];
    const rowResetDetected =
      meta.minRowNo !== undefined && meta.minRowNo <= 2 && prevSeg.maxRowSeen >= 3;
    const orderChanged =
      Boolean(meta.orderNumber && prevSeg.orderNumber && meta.orderNumber !== prevSeg.orderNumber);
    const shouldSplitUncertain = Boolean(meta.startsNewDocket || rowResetDetected || orderChanged);

    if (shouldSplitUncertain) {
      if (isGci) {
        const missingKey = `GCI-MISSING-JOB-P${p}-${Math.floor(100 + Math.random() * 900)}`;
        const reason = `Page ${p} appears to start a new GCI docket (${
          orderChanged ? 'Client Order No changed' : rowResetDetected ? 'row numbering restarted at 1' : 'new header detected'
        }), but Job No is missing or unreadable. Enter the printed Job No into Docket / Ref # manually (Client Order No was not substituted).`;
        prevSeg.separationUncertain = true;
        prevSeg.separationReason = prevSeg.separationReason || 'Verify multi-page boundary against adjoining pages.';
        segments.push({
          docketKey: missingKey,
          explicitDocketNumber: '',
          hasExplicitDocketNumber: false,
          supplier: 'GCI',
          customerName: meta.customerName || prevSeg.customerName,
          deliveryDate: meta.deliveryDate || prevSeg.deliveryDate,
          carrier: meta.carrier,
          orderNumber: meta.orderNumber,
          jobNumber: undefined,
          palletCount: Math.max(1, meta.palletCount || 1),
          pageNumbers: [p],
          maxRowSeen: meta.maxRowNo || 0,
          rawItems: [...meta.rawItems],
          validationWarnings: Array.from(new Set([...meta.validationWarnings, GCI_MISSING_JOB_NO_WARNING])),
          separationUncertain: true,
          separationReason: reason,
        });
      } else {
        const fallbackDk = `DK-REVIEW-${p}-${Math.floor(100 + Math.random() * 900)}`;
        const reason = `Page ${p} appears to start a new docket (${
          rowResetDetected ? 'row numbering restarted at 1' : orderChanged ? 'order number changed' : 'new header detected'
        }), but no distinct docket number could be read. Please verify and assign the correct docket number.`;
        prevSeg.separationUncertain = true;
        prevSeg.separationReason = prevSeg.separationReason || 'Verify multi-page boundary against adjoining pages.';
        segments.push({
          docketKey: fallbackDk,
          explicitDocketNumber: fallbackDk,
          hasExplicitDocketNumber: false,
          supplier: meta.supplier || prevSeg.supplier,
          customerName: meta.customerName || prevSeg.customerName,
          deliveryDate: meta.deliveryDate || prevSeg.deliveryDate,
          carrier: meta.carrier,
          orderNumber: meta.orderNumber,
          jobNumber: meta.jobNumber,
          palletCount: Math.max(1, meta.palletCount || 1),
          pageNumbers: [p],
          maxRowSeen: meta.maxRowNo || 0,
          rawItems: [...meta.rawItems],
          validationWarnings: [...meta.validationWarnings],
          separationUncertain: true,
          separationReason: reason,
        });
      }
    } else {
      // Continuation page of previous docket
      prevSeg.pageNumbers.push(p);
      prevSeg.rawItems.push(...meta.rawItems);
      prevSeg.validationWarnings.push(...meta.validationWarnings);
      prevSeg.maxRowSeen = Math.max(prevSeg.maxRowSeen, meta.maxRowNo || 0);
      prevSeg.palletCount = Math.max(prevSeg.palletCount, meta.palletCount || 1);
    }
  }

  // Finalize each segment independently so row numbers in different dockets NEVER collide
  const builtDockets: ExtractedDocketResult[] = [];

  for (const seg of segments) {
    const segByNo = new Map<number, ExtractedDocketItem>();
    const segUnnumbered: ExtractedDocketItem[] = [];
    const segPageMin = new Map<number, number>();
    const segPageMax = new Map<number, number>();
    let segMaxCandidate = 0;

    for (const rawIt of seg.rawItems) {
      const norm = normalizeRawBatchItem(rawIt, seg.pageNumbers[0]);
      if (!norm) continue;
      const numNo = parseInt(norm.cleanNo, 10);
      const itemPage = norm.item.pageNumber || seg.pageNumbers[0];

      if (!Number.isNaN(numNo) && numNo > 0 && numNo <= 1500) {
        if (numNo > segMaxCandidate) segMaxCandidate = numNo;
        segPageMin.set(itemPage, Math.min(segPageMin.get(itemPage) ?? numNo, numNo));
        segPageMax.set(itemPage, Math.max(segPageMax.get(itemPage) ?? numNo, numNo));

        const existing = segByNo.get(numNo);
        if (!existing) {
          segByNo.set(numNo, { ...norm.item, itemNumber: String(numNo) });
        } else if (existing.pageNumber === itemPage) {
          segByNo.set(numNo, {
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
          segUnnumbered.push(norm.item);
        }
      } else {
        segUnnumbered.push(norm.item);
      }
    }

    // Pass 2: Missing row recovery scoped strictly to this segment's pages
    if (
      anyPrintedNoColumn &&
      segMaxCandidate > 1 &&
      segMaxCandidate <= 600 &&
      segUnnumbered.length === 0
    ) {
      const missingNos: number[] = [];
      for (let n = 1; n <= segMaxCandidate; n++) {
        if (!segByNo.has(n)) missingNos.push(n);
      }
      if (missingNos.length > 0 && missingNos.length <= 60) {
        const missingPerPage = new Map<number, Set<number>>();
        for (const mNo of missingNos) {
          let targetP = seg.pageNumbers[0];
          for (const p of seg.pageNumbers) {
            const pMin = segPageMin.get(p) ?? 1;
            const pMax = segPageMax.get(p) ?? segMaxCandidate;
            if (mNo >= pMin && mNo <= pMax) {
              targetP = p;
              break;
            }
          }
          if (!missingPerPage.has(targetP)) missingPerPage.set(targetP, new Set());
          missingPerPage.get(targetP)!.add(mNo);
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
            if (!Number.isNaN(numNo) && numNo > 0 && !segByNo.has(numNo)) {
              segByNo.set(numNo, { ...norm.item, itemNumber: String(numNo) });
            }
          }
        }
      }
    }

    const validItems: ExtractedDocketItem[] = [];
    const sortedNos = Array.from(segByNo.keys()).sort((a, b) => a - b);
    for (const n of sortedNos) {
      validItems.push(segByNo.get(n)!);
    }
    let nextSeq = (sortedNos.length > 0 ? sortedNos[sortedNos.length - 1] : startItemIndex - 1) + 1;
    for (const unnum of segUnnumbered) {
      validItems.push({ ...unnum, itemNumber: String(nextSeq++) });
    }

    const dedupWarnings = Array.from(new Set(seg.validationWarnings.filter(Boolean)));
    const flaggedCount = validItems.filter((it) => it.confidence === 'low').length;

    builtDockets.push({
      docketNumber: seg.explicitDocketNumber,
      supplier: isGci ? 'GCI' : seg.supplier,
      customerName: seg.customerName,
      deliveryDate: seg.deliveryDate,
      carrier: seg.carrier,
      orderNumber: seg.orderNumber,
      jobNumber: seg.jobNumber,
      palletCount: seg.palletCount,
      items: validItems,
      confidenceScore: validItems.length > 0 ? (seg.separationUncertain || flaggedCount > 0 || (isGci && !seg.hasExplicitDocketNumber) ? 80 : 100) : 0,
      needsManualReview: validItems.length === 0 || seg.separationUncertain || flaggedCount > 0 || (isGci && !seg.hasExplicitDocketNumber),
      separationUncertain: seg.separationUncertain,
      separationReason: seg.separationReason,
      sourcePageNumbers: [...seg.pageNumbers],
      extractionMethod: 'gemini-vision',
      extractionEngineLabel: `Gemini (${modelUsed})`,
      aiModelUsed: modelUsed,
      fallbackUsed,
      retryAttempts: totalRetries,
      pagesScanned: seg.pageNumbers.length,
      hasPrintedNoColumn: anyPrintedNoColumn,
      firstVisibleRowNo: sortedNos.length > 0 ? sortedNos[0] : undefined,
      lastVisibleRowNo: sortedNos.length > 0 ? sortedNos[sortedNos.length - 1] : undefined,
      flaggedRowCount: flaggedCount,
      validationFlags: dedupWarnings.length > 0 ? dedupWarnings : undefined,
      validationWarnings: dedupWarnings.length > 0 ? dedupWarnings : undefined,
    });
  }

  const primary = builtDockets[0] || {
    docketNumber: `DK-${Math.floor(10000 + Math.random() * 90000)}`,
    supplier: 'Steel Fabrication Supplier',
    deliveryDate: new Date().toISOString().slice(0, 10),
    palletCount: 1,
    items: [],
    confidenceScore: 0,
    needsManualReview: true,
    extractionMethod: 'ai-vision' as const,
    aiModelUsed: modelUsed,
    fallbackUsed,
    retryAttempts: totalRetries,
    pagesScanned: totalPages,
  };

  return {
    ...primary,
    pagesScanned: totalPages,
    separatedDockets: builtDockets,
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
 * Reads a barcode, QR code, Part Number, Description, Quantity, or full pallet label text
 * from a single part/pallet label photo using Gemini AI Vision.
 */
export async function extractPartCodeWithGeminiVision(
  imageDataUrl: string,
  knownParts?: Array<{ partNumber: string; itemNumber: string; description?: string }>
): Promise<{
  detectedCode: string;
  partNumber: string | null;
  description: string | null;
  quantity: number | null;
  unit: string | null;
  rawText: string;
  confidence: string;
}> {
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
      ? `\nActive Docket Expected Parts (cross-reference part number or docket "######-<No>" code):\n${knownParts
          .slice(0, 120)
          .map((p) => `- Docket No: ${p.itemNumber} | Part#: ${p.partNumber} (${p.description || ''})`)
          .join('\n')}`
      : '';

  const promptText = `Examine this industrial part or pallet label photograph and transcribe the literal label details.${knownContext}
Rules:
1. Preserve printed Part Numbers, barcode values (e.g. "482910-3"), or QR text exactly as printed without guessing blurred digits.
2. Extract:
   - detectedCode: primary barcode value, QR text, or Part Number (or "" if unreadable)
   - partNumber: printed Part Number / Drawing No (or "" if none visible)
   - description: part description line if printed (or "")
   - quantity: numeric pallet/label quantity if printed (0 if not explicitly printed)
   - unit: unit like EA, PCS, SET if shown
   - rawText: literal multi-line text visible on the label
   - confidence: "high", "medium", or "low"`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      detectedCode: { type: Type.STRING },
      partNumber: { type: Type.STRING },
      description: { type: Type.STRING },
      quantity: { type: Type.NUMBER },
      unit: { type: Type.STRING },
      rawText: { type: Type.STRING },
      confidence: { type: Type.STRING },
    },
    required: ['detectedCode', 'rawText', 'confidence'],
  };

  const { parsed } = await generateWithRetryAndFallback(
    ai,
    ThinkingLevel,
    [
      { inlineData: { mimeType, data: base64Data } },
      { text: promptText },
    ],
    'Read the barcode, part code, description, quantity, and literal text from the industrial part/pallet label image without fabricating values.',
    responseSchema,
    'label'
  );

  const detectedCode = String(parsed.detectedCode || parsed.partNumber || '').trim();
  const partNumber = parsed.partNumber && String(parsed.partNumber).trim() ? String(parsed.partNumber).trim().toUpperCase() : (detectedCode || null);
  const rawQty = Number(parsed.quantity);
  const quantity = !Number.isNaN(rawQty) && rawQty > 0 && rawQty <= 99999 ? Math.round(rawQty) : null;

  return {
    detectedCode,
    partNumber,
    description: parsed.description && String(parsed.description).trim() ? String(parsed.description).trim() : null,
    quantity,
    unit: parsed.unit && String(parsed.unit).trim() ? String(parsed.unit).trim().toUpperCase() : null,
    rawText: String(parsed.rawText || '').trim(),
    confidence: String(parsed.confidence || 'high').toLowerCase(),
  };
}
