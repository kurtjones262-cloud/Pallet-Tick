/**
 * Cloudflare Pages Function: POST /api/extract-docket
 *
 * Secure server-side Gemini AI Vision invoice & docket extraction with:
 * - Primary model: gemini-4-hydrogen (ThinkingLevel LOW), secondary fallback: gemini-3.1-flash-lite
 * - Per-request 22s AbortController timeout, max 1 retry on transient 503/502/429 errors
 * - Fast failover on 404 invalid model, daily quota exhaustion, or timeout; immediate abort on 401/403/400
 * - Multi-docket segmentation via pageHeaders & startsNewDocket
 * - Rich structured item fields (rev, unit, originalText, confidence, validationWarnings)
 */

interface CloudflareEnv {
  GEMINI_API_KEY?: string;
  GEMINI_PRIMARY_MODEL?: string;
  GEMINI_FALLBACK_MODEL?: string;
  GEMINI_FALLBACK_MODELS?: string;
  [key: string]: unknown;
}

interface EventContext {
  request: Request;
  env: CloudflareEnv;
}

const DEFAULT_PRIMARY_MODEL = 'gemini-4-hydrogen';
const DEFAULT_FALLBACK_MODELS = ['gemini-3.1-flash-lite'] as const;
const GEMINI_REQUEST_TIMEOUT_MS = 22000;
const MAX_AUTOMATIC_RETRIES = 1;
const INITIAL_BACKOFF_MS = 1800;

const GCI_MISSING_JOB_NO_WARNING =
  'GCI Job No is missing or unreadable — verify and enter the printed Job No into Docket / Ref # manually (Client Order No was not substituted).';

function isGciSupplierHint(supplierHint?: string): boolean {
  return typeof supplierHint === 'string' && supplierHint.trim().toLowerCase() === 'gci';
}

function cleanGciRefToken(raw?: string): string {
  return String(raw || '')
    .replace(/^(?:client\s*order\s*(?:no|num|number|#)|job\s*(?:no|num|number|#)|docket\s*(?:no|num|number|#)|order\s*(?:no|num|number|#)|po\s*(?:no|num|number|#)?)\s*[:#.\-]?\s*/i, '')
    .trim();
}

function isSyntheticDocketPlaceholder(raw?: string): boolean {
  return /^DK-(?:REVIEW-)?(?:P?\d+-)?\d+$/i.test(String(raw || '').trim());
}

function normalizeGciDispatchDate(rawDate?: string): string | undefined {
  const s = String(rawDate || '').trim();
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

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
  return undefined;
}

function extractGciFieldsFromSelectableText(selectableText?: string): {
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
  return { jobNo, clientOrderNo, dispatchDate };
}

function resolveGciPageHeaderFields(
  input: {
    docketNumber?: string;
    jobNumber?: string;
    orderNumber?: string;
    deliveryDate?: string;
    supplier?: string;
    validationWarnings?: string[];
  },
  options?: { selectableText?: string; isContinuationWithoutHeader?: boolean }
) {
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

  const resolvedDate = normalizeGciDispatchDate(input.deliveryDate) || textHints.dispatchDate;
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

const pagesModelCooldownUntil = new Map<string, number>();
const MODEL_COOLDOWN_MS = 5 * 60 * 1000;
const TRANSIENT_COOLDOWN_MS = 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeExponentialBackoffWithJitter(retryAttempt: number, baseMs: number = INITIAL_BACKOFF_MS): number {
  const exp = Math.max(0, retryAttempt - 1);
  return Math.min(8000, baseMs * Math.pow(2, exp) + Math.floor(Math.random() * 450));
}

function logPagesOcrEvent(level: 'info' | 'warn' | 'error', event: string, meta: Record<string, unknown> = {}) {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (/key|token|secret|image|base64|dataurl|text/i.test(k)) continue;
    safe[k] = typeof v === 'string' ? v.replace(/key=[A-Za-z0-9_\-]+/gi, 'key=[REDACTED]').slice(0, 300) : v;
  }
  const msg = JSON.stringify({ timestamp: new Date().toISOString(), component: 'PartTrack-Pages-OCR', event, ...safe });
  if (level === 'error') console.error(msg);
  else if (level === 'warn') console.warn(msg);
  else console.log(msg);
}

function resolveConfiguredModels(env: CloudflareEnv): { primaryModel: string; fallbackModels: string[] } {
  const procEnv = typeof process !== 'undefined' && process.env ? process.env : {};
  const obsolete = new Set([
    'gemini-3.8-flash',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite-preview',
    'gemini-flash-latest',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
    'gemini-2.0-flash',
  ]);
  const rawPrimary =
    (typeof env?.GEMINI_PRIMARY_MODEL === 'string' && env.GEMINI_PRIMARY_MODEL.trim()) ||
    (typeof procEnv.GEMINI_PRIMARY_MODEL === 'string' && procEnv.GEMINI_PRIMARY_MODEL.trim()) ||
    DEFAULT_PRIMARY_MODEL;
  const primaryModel = obsolete.has(rawPrimary.toLowerCase()) ? DEFAULT_PRIMARY_MODEL : rawPrimary;

  const rawFallbacks =
    (typeof env?.GEMINI_FALLBACK_MODEL === 'string' && env.GEMINI_FALLBACK_MODEL.trim()) ||
    (typeof env?.GEMINI_FALLBACK_MODELS === 'string' && env.GEMINI_FALLBACK_MODELS.trim()) ||
    (typeof procEnv.GEMINI_FALLBACK_MODEL === 'string' && procEnv.GEMINI_FALLBACK_MODEL.trim()) ||
    (typeof procEnv.GEMINI_FALLBACK_MODELS === 'string' && procEnv.GEMINI_FALLBACK_MODELS.trim()) ||
    DEFAULT_FALLBACK_MODELS.join(',');

  const seen = new Set<string>([primaryModel]);
  const fallbackModels: string[] = [];
  for (const token of rawFallbacks.split(',')) {
    const cleaned = token.trim();
    const resolved = cleaned && !obsolete.has(cleaned.toLowerCase()) ? cleaned : DEFAULT_FALLBACK_MODELS[0];
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      fallbackModels.push(resolved);
    }
  }

  return {
    primaryModel,
    fallbackModels:
      fallbackModels.length > 0
        ? fallbackModels
        : DEFAULT_FALLBACK_MODELS.filter((m) => m !== primaryModel),
  };
}

function classifyGeminiError(err: any) {
  const rawMessage = String(err?.message || err || 'Unknown Gemini API error').replace(
    /key=[A-Za-z0-9_\-]+/gi,
    'key=[REDACTED]'
  );
  let statusCode = Number(err?.status || err?.statusCode || 0);
  if (!statusCode) {
    const m = rawMessage.match(/\b(400|401|403|404|429|500|502|503|504)\b/);
    if (m) statusCode = parseInt(m[1], 10);
  }
  const isTimeout =
    Boolean(err?.isTimeout) ||
    err?.name === 'AbortError' ||
    statusCode === 504 ||
    /504|DEADLINE_EXCEEDED|timed out|AbortError/i.test(rawMessage);
  const isAuthError =
    statusCode === 401 ||
    statusCode === 403 ||
    /401|403|UNAUTHENTICATED|PERMISSION_DENIED|API_KEY_INVALID|invalid api key/i.test(rawMessage);
  const isInvalidModel =
    statusCode === 404 ||
    /404|NOT_FOUND|is not found|not supported for generateContent|model not found/i.test(rawMessage);
  const isHighDemand503 =
    !isTimeout &&
    (statusCode === 503 || statusCode === 502 || /503|502|UNAVAILABLE|high demand|overloaded/i.test(rawMessage));
  const isRateLimit =
    statusCode === 429 || /429|RESOURCE_EXHAUSTED|rate limit|quota|too many requests/i.test(rawMessage);
  const isModelDailyQuotaExhausted =
    isRateLimit &&
    /GenerateRequestsPerDay|free_tier_requests|daily quota|exceeded your current quota|limit:\s*0\b/i.test(rawMessage);

  if (!statusCode) {
    if (isTimeout) statusCode = 504;
    else if (isAuthError) statusCode = 401;
    else if (isInvalidModel) statusCode = 404;
    else if (isHighDemand503) statusCode = 503;
    else if (isRateLimit) statusCode = 429;
    else statusCode = 500;
  }

  let errorCode = 'AI_EXTRACTION_FAILED';
  if (isAuthError) errorCode = 'GEMINI_AUTH_ERROR';
  else if (isInvalidModel) errorCode = 'GEMINI_INVALID_MODEL';
  else if (statusCode === 400) errorCode = 'GEMINI_BAD_REQUEST';
  else if (isModelDailyQuotaExhausted) errorCode = 'GEMINI_QUOTA_EXHAUSTED';
  else if (isRateLimit) errorCode = 'GEMINI_RATE_LIMIT_429';
  else if (isTimeout) errorCode = 'GEMINI_TIMEOUT';
  else if (isHighDemand503) errorCode = 'GEMINI_HIGH_DEMAND_503';

  return {
    statusCode,
    errorCode,
    isTimeout,
    isAuthError,
    isInvalidModel,
    isHighDemand503,
    isRateLimit,
    isModelDailyQuotaExhausted,
    isRetryableAvailabilityError:
      !isAuthError &&
      !isInvalidModel &&
      !isModelDailyQuotaExhausted &&
      !isTimeout &&
      statusCode !== 400 &&
      (isHighDemand503 || isRateLimit || statusCode === 500),
    cleanMessage: rawMessage.slice(0, 260),
  };
}

function validateOcrPayload(rawText: string): any {
  const trimmed = (rawText || '').trim();
  if (!trimmed) throw new Error('Malformed OCR response: empty body.');
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e: any) {
    throw new Error(`Malformed OCR JSON response: ${e?.message || 'parse error'}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.items)) {
    throw new Error('Incomplete OCR response: missing items array.');
  }
  for (let i = 0; i < parsed.items.length; i++) {
    const it = parsed.items[i];
    if (!it || typeof it !== 'object') throw new Error(`Malformed OCR item at index ${i}.`);
    const hasPartOrDesc =
      (typeof it.part === 'string' && it.part.trim().length > 0) ||
      (typeof it.desc === 'string' && it.desc.trim().length > 0);
    if (!hasPartOrDesc) throw new Error(`Incomplete OCR item at index ${i}.`);
    const q = Number(it.qty);
    if (Number.isNaN(q) || q < 0) throw new Error(`Invalid OCR item quantity at index ${i}.`);
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

function parseCleanRowNo(raw: unknown): string {
  const str = String(raw ?? '').trim();
  if (!str) return '';

  const dashMatch = str.match(/^\d{3,10}\s*[-–—]\s*0*(\d{1,4})$/);
  if (dashMatch) return dashMatch[1];

  const clean = str
    .replace(/^(?:ITM|ITEM|LINE|POS|NO\.?|SR\.?\s*NO\.?|#)\s*[-:]?\s*/i, '')
    .replace(/^0+(?=\d)/, '')
    .trim();

  if (/^\d{1,4}$/.test(clean)) {
    const num = parseInt(clean, 10);
    if (num >= 1 && num <= 2500) return String(num);
  }
  return '';
}

function normalizePageItem(it: any, defaultPage: number) {
  const rawPart = String(it.part || '').replace(/\s+/g, ' ').trim();
  const rawDesc = String(it.desc || '').replace(/\s+/g, ' ').trim();
  const combined = `${rawPart} ${rawDesc}`.trim();

  if (
    /^(?:freight|delivery\s*(?:fee|charge)|gst|subtotal|sub-total|total\s*(?:inc|ex)?|balance\s*due|amount\s*due|admin\s*fee|setup\s*fee|pallet\s*fee|abn|acn|phone|fax)\b/i.test(
      rawPart
    ) ||
    (/^(?:freight|gst|subtotal|total|balance\s*due|amount\s*due|surcharge|delivery\s*charge)$/i.test(rawDesc) &&
      !rawPart)
  ) {
    return null;
  }

  if (/^(?:\+?61|0[23478])\s*\d{4}\s*\d{4}$/.test(rawPart) || /^ABN\s*\d{2}/i.test(combined)) {
    return null;
  }

  const cleanNo = parseCleanRowNo(it.no);
  const rawQty = Number(it.qty);
  const hasInvalidQty = Number.isNaN(rawQty) || rawQty < 1;
  const qty = !hasInvalidQty ? Math.round(rawQty) : 1;
  const partNumber = (rawPart || rawDesc.slice(0, 24) || 'PART').trim().toUpperCase();
  const description = (rawDesc || rawPart || '').trim();
  const revision = it.rev && String(it.rev).trim() ? String(it.rev).trim().toUpperCase() : undefined;
  const material = it.mat && String(it.mat).trim() ? String(it.mat).trim() : undefined;
  const thickness = it.thk && String(it.thk).trim() ? String(it.thk).trim() : undefined;
  const dimensions = it.dim && String(it.dim).trim() ? String(it.dim).trim() : undefined;
  const weight = it.wt && String(it.wt).trim() ? String(it.wt).trim() : undefined;
  const unit = it.unit && String(it.unit).trim() ? String(it.unit).trim().toUpperCase() : undefined;
  const originalText = it.originalText && String(it.originalText).trim() ? String(it.originalText).trim() : undefined;

  const warnings: string[] = Array.isArray(it.validationWarnings)
    ? it.validationWarnings.map((w: any) => String(w || '').trim()).filter(Boolean)
    : [];
  if (hasInvalidQty) warnings.push('Quantity unclear or missing on source row');
  if (!rawPart || rawPart === 'PART' || rawPart === 'UNKNOWN') {
    warnings.push('Part number unclear on source row');
  }

  const rawConf = String(it.confidence || '').toLowerCase();
  const confidence: 'high' | 'medium' | 'low' =
    warnings.length > 0 || rawConf === 'low' ? 'low' : rawConf === 'medium' ? 'medium' : 'high';

  return {
    cleanNo,
    pageNumber: Number(it.page) || defaultPage,
    item: {
      partNumber,
      itemNumber: cleanNo || '1',
      description,
      revision,
      rev: revision,
      material,
      thickness,
      dimensions,
      weight,
      unit,
      quantity: qty,
      palletNumber: 'Pallet 1',
      pageNumber: Number(it.page) || defaultPage,
      originalText,
      confidence,
      notes: warnings.length > 0 ? warnings.join('; ') : undefined,
      validationWarnings: warnings.length > 0 ? warnings : undefined,
      originalOcrValues: {
        partNumber,
        itemNumber: cleanNo || '1',
        description,
        revision,
        rev: revision,
        quantity: qty,
        material,
        thickness,
      },
    },
  };
}

async function callGeminiRestSingleAttempt(
  apiKey: string,
  model: string,
  systemInstruction: string,
  parts: Array<Record<string, unknown>>,
  responseSchema: Record<string, unknown>
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
    responseSchema,
  };
  if (model.includes('gemini-4-hydrogen')) {
    generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
  }

  const requestBody = {
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    contents: [{ parts }],
    generationConfig,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (fetchErr: any) {
    if (controller.signal.aborted || fetchErr?.name === 'AbortError') {
      const timeoutErr: any = new Error(
        `Gemini API request to ${model} timed out after ${Math.round(GEMINI_REQUEST_TIMEOUT_MS / 1000)}s (HTTP 504).`
      );
      timeoutErr.status = 504;
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    throw fetchErr;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errText = await response.text();
    const err: any = new Error(`Gemini API error (${response.status}): ${errText.slice(0, 260)}`);
    err.status = response.status;
    throw err;
  }

  const result: any = await response.json();
  const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Malformed OCR response: Empty response received from Gemini AI model.');
  }
  return text;
}

export const onRequestOptions = async (): Promise<Response> => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
};

export const onRequestPost = async (context: EventContext): Promise<Response> => {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  try {
    const apiKey =
      (typeof context.env?.GEMINI_API_KEY === 'string' && context.env.GEMINI_API_KEY.trim()) ||
      (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) ||
      '';

    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error:
            'Gemini AI API key is not configured in Cloudflare Pages. Please set the GEMINI_API_KEY environment variable in your Cloudflare Pages dashboard under Settings > Environment variables.',
          code: 'MISSING_GEMINI_API_KEY',
        }),
        { status: 503, headers: corsHeaders }
      );
    }

    const body: any = await context.request.json().catch(() => ({}));
    const { images, pageSlices, supplierHint } = body || {};
    const isGci = isGciSupplierHint(typeof supplierHint === 'string' ? supplierHint : undefined);

    if (
      (!Array.isArray(images) || images.length === 0) &&
      (!Array.isArray(pageSlices) || pageSlices.length === 0)
    ) {
      return new Response(JSON.stringify({ error: 'No docket images provided.' }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const resolvedPayloads: Array<{
      fullDataUrl: string;
      upperDataUrl?: string;
      lowerDataUrl?: string;
      pdfSelectableText?: string;
    }> =
      Array.isArray(pageSlices) && pageSlices.length > 0
        ? pageSlices
        : (images as string[]).map((img) => ({ fullDataUrl: img }));

    const totalPages = resolvedPayloads.length;
    const parts: Array<Record<string, unknown>> = [];
    const pageDescriptions: string[] = [];

    for (let i = 0; i < totalPages; i++) {
      const pNum = i + 1;
      const payload = resolvedPayloads[i];
      if (payload.upperDataUrl && payload.lowerDataUrl) {
        const up = parseDataUrl(payload.upperDataUrl);
        const low = parseDataUrl(payload.lowerDataUrl);
        parts.push({ inlineData: { mimeType: up.mimeType, data: up.base64Data } });
        parts.push({ inlineData: { mimeType: low.mimeType, data: low.base64Data } });
        pageDescriptions.push(`Page ${pNum} (Upper & Lower zoomed slices)`);
      } else {
        const full = parseDataUrl(payload.fullDataUrl);
        parts.push({ inlineData: { mimeType: full.mimeType, data: full.base64Data } });
        pageDescriptions.push(`Page ${pNum}`);
      }
      if (payload.pdfSelectableText && payload.pdfSelectableText.trim()) {
        parts.push({
          text: `[SELECTABLE TEXT FROM PDF PAGE ${pNum}]:\n${payload.pdfSelectableText.slice(0, 18000)}`,
        });
      }
    }

    const systemInstruction = `You are a 100%-recall industrial delivery docket, tax invoice, and laser-cutting manifest extraction engine.
Transcribe EVERY physical part row literally visible across the document into the JSON 'items' array without skipping or merging rows.
Preserve original part numbers (Laser Central, GCI, J-series), join wrapped multi-line part numbers cleanly, separate supplier from customer/recipient, never invent missing rows, and mark uncertain rows with confidence='low' and validationWarnings.`;

    const pageNumbers = Array.from({ length: totalPages }, (_, idx) => idx + 1);
    const basePromptText = `Examine ${pageDescriptions.join(' and ')} (${totalPages} total pages) and extract EVERY physical part row literally visible in top-to-bottom order.
Rules:
1. Extract every physical part row without duplicating overlap slices or skipping seam rows.
2. Record 'pageHeaders' for pages [${pageNumbers.join(', ')}] with: page, docketNumber, supplier, customerName, deliveryDate, orderNumber, jobNumber, carrier, palletCount, startsNewDocket.
3. For each row: page, no (exact printed row number), part, desc, rev, mat, thk, dim, wt, unit (EA/PC/PCS/SET/M), qty (dispatched integer quantity, never price $), originalText, confidence ('high'|'medium'|'low'), validationWarnings.
4. Exclude phone/fax numbers, ABN numbers, postcodes, header consignment barcodes, and charge/tax summary lines (Freight, GST, Subtotal, Total, Balance Due).`;

    const promptText = isGci
      ? `${basePromptText}
5. GCI SUPPLIER-SPECIFIC HEADER MAPPING (CRITICAL — DO NOT SWAP):
   - Selected supplier is GCI. GCI dockets show "Client Order No", "Job No", "Despatch Date" / "Dispatch Date", and "Despatched By".
   - "Job No" (e.g. 194322) IS the primary Docket / Ref # -> populate BOTH 'docketNumber' and 'jobNumber' with Job No.
   - "Client Order No" (e.g. 72018) IS the customer PO / Order # -> populate 'orderNumber' ONLY (NEVER 'docketNumber' or 'jobNumber').
   - "Despatch Date" / "Dispatch Date" (DD/MM/YYYY, e.g. 12/11/2026 -> 2026-11-12) -> populate 'deliveryDate' formatted as YYYY-MM-DD.
   - Set 'supplier' to "GCI". Use "Job No" as primary docket identifier for multi-docket grouping; if "Job No" is missing/unreadable, leave 'docketNumber' and 'jobNumber' empty "" and note in 'validationWarnings' (never substitute "Client Order No").`
      : basePromptText;

    parts.push({ text: promptText });

    const responseSchema = {
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

    const { primaryModel, fallbackModels } = resolveConfiguredModels(context.env);
    const allModels = [primaryModel, ...fallbackModels];
    const nowMs = Date.now();
    const candidateModels = [
      ...allModels.filter((m) => (pagesModelCooldownUntil.get(m) || 0) <= nowMs),
      ...allModels.filter((m) => (pagesModelCooldownUntil.get(m) || 0) > nowMs),
    ];

    let parsed: any = null;
    let lastError: any = null;
    let modelUsed: string = primaryModel;
    let fallbackUsed = false;
    let totalRetryAttempts = 0;

    for (let mIdx = 0; mIdx < candidateModels.length && !parsed; mIdx++) {
      const model = candidateModels[mIdx];
      const isFallback = model !== primaryModel;

      logPagesOcrEvent('info', isFallback ? 'model_fallback_selected' : 'model_selected', {
        model,
        isFallback,
      });

      for (let retry = 0; retry <= MAX_AUTOMATIC_RETRIES; retry++) {
        try {
          const rawJsonText = await callGeminiRestSingleAttempt(
            apiKey,
            model,
            systemInstruction,
            parts,
            responseSchema
          );
          parsed = validateOcrPayload(rawJsonText);
          modelUsed = model;
          fallbackUsed = isFallback;
          logPagesOcrEvent('info', 'extraction_succeeded', {
            model,
            isFallback,
            retryAttempts: totalRetryAttempts,
            statusCode: 200,
            itemsExtracted: parsed.items.length,
          });
          break;
        } catch (err: any) {
          lastError = err;
          const classification = classifyGeminiError(err);
          const msg = String(err?.message || '');
          const isValidationFailure = /Malformed|Incomplete OCR|Invalid OCR item/i.test(msg);

          logPagesOcrEvent('warn', 'extraction_attempt_failed', {
            model,
            isFallback,
            attempt: retry + 1,
            maxAttempts: MAX_AUTOMATIC_RETRIES + 1,
            statusCode: classification.statusCode,
            errorCode: classification.errorCode,
            isRetryable: classification.isRetryableAvailabilityError || isValidationFailure,
            reason: classification.cleanMessage,
          });

          if (!isValidationFailure && (classification.isAuthError || classification.statusCode === 400)) {
            const permErr: any = new Error(classification.cleanMessage);
            permErr.status = classification.statusCode;
            permErr.code = classification.errorCode;
            throw permErr;
          }

          if (
            !isValidationFailure &&
            (classification.isInvalidModel ||
              classification.isModelDailyQuotaExhausted ||
              classification.isTimeout)
          ) {
            pagesModelCooldownUntil.set(
              model,
              Date.now() + (classification.isTimeout ? TRANSIENT_COOLDOWN_MS : MODEL_COOLDOWN_MS)
            );
            break;
          }

          if ((classification.isRetryableAvailabilityError || isValidationFailure) && retry < MAX_AUTOMATIC_RETRIES) {
            totalRetryAttempts++;
            const waitMs = computeExponentialBackoffWithJitter(retry + 1, INITIAL_BACKOFF_MS);
            await sleep(waitMs);
            continue;
          }

          if (classification.isHighDemand503 || classification.isRateLimit) {
            pagesModelCooldownUntil.set(model, Date.now() + TRANSIENT_COOLDOWN_MS);
          }
        }
      }
    }

    if (!parsed) {
      throw lastError || new Error('Could not extract parts from docket images.');
    }

    const rawItems: any[] = Array.isArray(parsed.items) ? parsed.items : [];
    const rawPageHeaders: any[] = Array.isArray(parsed.pageHeaders) ? parsed.pageHeaders : [];
    const topWarnings: string[] = Array.isArray(parsed.validationWarnings)
      ? parsed.validationWarnings.map((w: any) => String(w || '').trim()).filter(Boolean)
      : [];

    const pageHeaderMap = new Map<number, any>();
    for (const ph of rawPageHeaders) {
      const pNo = Number(ph?.page);
      if (pNo >= 1 && pNo <= totalPages && !pageHeaderMap.has(pNo)) {
        const rawDate = ph.deliveryDate ? String(ph.deliveryDate).trim() : '';
        pageHeaderMap.set(pNo, {
          docketNumber: ph.docketNumber ? String(ph.docketNumber).trim() : '',
          supplier: ph.supplier ? String(ph.supplier).trim() : '',
          customerName: ph.customerName ? String(ph.customerName).trim() : '',
          deliveryDate: isGci ? (normalizeGciDispatchDate(rawDate) || '') : rawDate,
          carrier: ph.carrier ? String(ph.carrier).trim() : undefined,
          orderNumber: ph.orderNumber ? String(ph.orderNumber).trim() : undefined,
          jobNumber: ph.jobNumber ? String(ph.jobNumber).trim() : undefined,
          palletCount: ph.palletCount ? Math.max(1, Number(ph.palletCount) || 1) : 1,
          startsNewDocket: Boolean(ph.startsNewDocket),
        });
      }
    }

    // Apply GCI-specific header resolution per page BEFORE docket segmentation
    const gciWarningsExtra: string[] = [];
    if (isGci) {
      for (let pNo = 1; pNo <= totalPages; pNo++) {
        const ph = pageHeaderMap.get(pNo) || {};
        const mergedInput =
          pNo === 1
            ? {
                docketNumber: ph.docketNumber || parsed.docketNumber,
                jobNumber: ph.jobNumber || parsed.jobNumber,
                orderNumber: ph.orderNumber || parsed.orderNumber,
                deliveryDate: ph.deliveryDate || parsed.deliveryDate,
                supplier: ph.supplier || parsed.supplier,
              }
            : ph;
        const resolved = resolveGciPageHeaderFields(mergedInput, {
          selectableText: resolvedPayloads[pNo - 1]?.pdfSelectableText,
          isContinuationWithoutHeader: pNo > 1,
        });
        pageHeaderMap.set(pNo, {
          ...ph,
          docketNumber: resolved.docketNumber,
          jobNumber: resolved.jobNumber,
          orderNumber: resolved.orderNumber,
          deliveryDate: resolved.deliveryDate || '',
          supplier: 'GCI',
        });
        if (resolved.missingJobNo) {
          gciWarningsExtra.push(GCI_MISSING_JOB_NO_WARNING);
        }
      }
    }

    const segmentMap = new Map<string, {
      docketNumber: string;
      hasExplicitDocketNumber: boolean;
      supplier: string;
      customerName?: string;
      deliveryDate: string;
      carrier?: string;
      orderNumber?: string;
      jobNumber?: string;
      palletCount: number;
      pageNumbers: number[];
      separationUncertain: boolean;
      separationReason?: string;
      rawRows: any[];
    }>();
    const segmentOrder: string[] = [];
    let currentKey = '';

    for (let pNo = 1; pNo <= totalPages; pNo++) {
      const ph = pageHeaderMap.get(pNo);
      const dk = (ph?.docketNumber || (!isGci && pNo === 1 ? String(parsed.docketNumber || '').trim() : '')).trim();
      const normalizedKey = dk ? dk.replace(/[\s_]+/g, '').toUpperCase() : '';
      const startsNew = Boolean(ph?.startsNewDocket);
      const prevSeg = currentKey ? segmentMap.get(currentKey) : undefined;
      const gciOrderChanged = Boolean(
        isGci && prevSeg && ph?.orderNumber && prevSeg.orderNumber && ph.orderNumber !== prevSeg.orderNumber
      );

      if (normalizedKey) {
        if (!segmentMap.has(normalizedKey)) {
          const parsedDateNorm = isGci
            ? normalizeGciDispatchDate(parsed.deliveryDate ? String(parsed.deliveryDate).trim() : '')
            : (parsed.deliveryDate ? String(parsed.deliveryDate).trim() : '');
          segmentMap.set(normalizedKey, {
            docketNumber: dk,
            hasExplicitDocketNumber: true,
            supplier: isGci ? 'GCI' : (ph?.supplier || String(parsed.supplier || 'Steel Fabrication Supplier').trim()),
            customerName: ph?.customerName || (parsed.customerName ? String(parsed.customerName).trim() : undefined),
            deliveryDate: ph?.deliveryDate || parsedDateNorm || new Date().toISOString().slice(0, 10),
            carrier: ph?.carrier || (parsed.carrier ? String(parsed.carrier).trim() : undefined),
            orderNumber: ph?.orderNumber || (!isGci && parsed.orderNumber ? String(parsed.orderNumber).trim() : undefined),
            jobNumber: ph?.jobNumber || (parsed.jobNumber ? String(parsed.jobNumber).trim() : undefined),
            palletCount: ph?.palletCount || Math.max(1, Number(parsed.palletCount) || 1),
            pageNumbers: [pNo],
            separationUncertain: false,
            rawRows: [],
          });
          segmentOrder.push(normalizedKey);
        } else {
          segmentMap.get(normalizedKey)!.pageNumbers.push(pNo);
        }
        currentKey = normalizedKey;
      } else if (!currentKey || startsNew || gciOrderChanged) {
        if (isGci) {
          const fallbackKey = `GCI-MISSING-P${pNo}-${Math.floor(100 + Math.random() * 900)}`;
          const parsedDateNorm = normalizeGciDispatchDate(parsed.deliveryDate ? String(parsed.deliveryDate).trim() : '');
          segmentMap.set(fallbackKey, {
            docketNumber: '',
            hasExplicitDocketNumber: false,
            supplier: 'GCI',
            customerName: ph?.customerName || (parsed.customerName ? String(parsed.customerName).trim() : undefined),
            deliveryDate: ph?.deliveryDate || parsedDateNorm || new Date().toISOString().slice(0, 10),
            carrier: ph?.carrier || (parsed.carrier ? String(parsed.carrier).trim() : undefined),
            orderNumber: ph?.orderNumber || (pNo === 1 && parsed.orderNumber ? String(parsed.orderNumber).trim() : undefined),
            jobNumber: undefined,
            palletCount: ph?.palletCount || Math.max(1, Number(parsed.palletCount) || 1),
            pageNumbers: [pNo],
            separationUncertain: true,
            separationReason: GCI_MISSING_JOB_NO_WARNING,
            rawRows: [],
          });
          gciWarningsExtra.push(GCI_MISSING_JOB_NO_WARNING);
          segmentOrder.push(fallbackKey);
          currentKey = fallbackKey;
        } else {
          const uncertain = totalPages > 1;
          const fallbackKey = uncertain ? `REVIEW-P${pNo}` : 'SINGLE';
          const fallbackDk = uncertain
            ? `DK-REVIEW-P${pNo}-${Math.floor(100 + Math.random() * 900)}`
            : `DK-${Math.floor(10000 + Math.random() * 90000)}`;
          segmentMap.set(fallbackKey, {
            docketNumber: fallbackDk,
            hasExplicitDocketNumber: false,
            supplier: ph?.supplier || String(parsed.supplier || 'Steel Fabrication Supplier').trim(),
            customerName: ph?.customerName || (parsed.customerName ? String(parsed.customerName).trim() : undefined),
            deliveryDate: ph?.deliveryDate || String(parsed.deliveryDate || new Date().toISOString().slice(0, 10)).trim(),
            carrier: ph?.carrier || (parsed.carrier ? String(parsed.carrier).trim() : undefined),
            orderNumber: ph?.orderNumber || (parsed.orderNumber ? String(parsed.orderNumber).trim() : undefined),
            jobNumber: ph?.jobNumber || (parsed.jobNumber ? String(parsed.jobNumber).trim() : undefined),
            palletCount: ph?.palletCount || Math.max(1, Number(parsed.palletCount) || 1),
            pageNumbers: [pNo],
            separationUncertain: uncertain,
            separationReason: uncertain
              ? `Page ${pNo} could not be tied to an explicit docket number with certainty. Please confirm.`
              : undefined,
            rawRows: [],
          });
          segmentOrder.push(fallbackKey);
          currentKey = fallbackKey;
        }
      } else {
        segmentMap.get(currentKey)!.pageNumbers.push(pNo);
      }
    }

    for (const raw of rawItems) {
      const rowPage = Math.max(1, Math.min(totalPages, Number(raw.page) || 1));
      const targetKey =
        segmentOrder.find((k) => segmentMap.get(k)!.pageNumbers.includes(rowPage)) || segmentOrder[0];
      if (targetKey) {
        segmentMap.get(targetKey)!.rawRows.push(raw);
      }
    }

    const combinedWarnings = Array.from(new Set([...topWarnings, ...gciWarningsExtra]));
    const builtDockets = segmentOrder.map((segKey) => {
      const seg = segmentMap.get(segKey)!;
      const items = seg.rawRows
        .map((r, idx) => {
          const norm = normalizePageItem(r, seg.pageNumbers[0] || 1);
          if (!norm) return null;
          return {
            ...norm.item,
            itemNumber: norm.cleanNo || String(idx + 1),
          };
        })
        .filter((it): it is NonNullable<typeof it> => it !== null);
      const flaggedRowCount = items.filter((it) => it.confidence === 'low').length;

      return {
        docketNumber: seg.docketNumber,
        supplier: isGci ? 'GCI' : seg.supplier,
        customerName: seg.customerName,
        deliveryDate: seg.deliveryDate,
        carrier: seg.carrier,
        orderNumber: seg.orderNumber,
        jobNumber: seg.jobNumber,
        palletCount: seg.palletCount,
        items,
        confidenceScore: items.length > 0 ? (seg.separationUncertain || flaggedRowCount > 0 || (isGci && !seg.hasExplicitDocketNumber) ? 80 : 100) : 0,
        needsManualReview: items.length === 0 || seg.separationUncertain || flaggedRowCount > 0 || (isGci && !seg.hasExplicitDocketNumber),
        separationUncertain: seg.separationUncertain,
        separationReason: seg.separationReason,
        sourcePageNumbers: seg.pageNumbers,
        extractionMethod: 'gemini-vision' as const,
        extractionEngineLabel: `Gemini (${modelUsed})`,
        aiModelUsed: modelUsed,
        fallbackUsed,
        retryAttempts: totalRetryAttempts,
        pagesScanned: seg.pageNumbers.length,
        flaggedRowCount,
        validationFlags: combinedWarnings.length > 0 ? combinedWarnings : undefined,
        validationWarnings: combinedWarnings.length > 0 ? combinedWarnings : undefined,
      };
    });

    const primary = builtDockets[0];
    const responsePayload = {
      ...primary,
      pagesScanned: totalPages,
      separatedDockets: builtDockets,
    };

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (err: any) {
    const classification = classifyGeminiError(err);
    const isMissingKey = String(err?.message || '').includes('GEMINI_API_KEY') || err?.code === 'MISSING_GEMINI_API_KEY';
    const status = isMissingKey ? 503 : classification.statusCode || 500;
    const code = isMissingKey ? 'MISSING_GEMINI_API_KEY' : classification.errorCode;
    return new Response(
      JSON.stringify({
        error: isMissingKey
          ? 'Gemini AI API key is not configured in Cloudflare Pages. Please set the GEMINI_API_KEY environment variable in your Cloudflare Pages dashboard.'
          : classification.cleanMessage || 'Gemini AI invoice extraction failed.',
        code,
        retryable: classification.isRetryableAvailabilityError || classification.isTimeout,
      }),
      {
        status,
        headers: corsHeaders,
      }
    );
  }
};
