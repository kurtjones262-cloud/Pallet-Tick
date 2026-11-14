/**
 * Cloudflare Pages Function: POST /api/extract-docket
 *
 * Secure server-side Gemini AI Vision invoice & docket extraction with:
 * - Primary model: gemini-4-hydrogen (ThinkingLevel LOW), secondary fallback: gemini-3.1-flash-lite
 * - Per-request 45s AbortController timeout, max 1 retry on transient 503/502/429 errors
 * - Fast failover on 404 invalid model, daily quota exhaustion, or timeout; immediate abort on 401/403/400
 * - Multi-docket segmentation via pageHeaders & startsNewDocket
 * - Rich structured item fields (rev, unit, originalText, confidence, validationWarnings)
 */

import {
  DEFAULT_PRIMARY_VISION_MODEL,
  DEFAULT_FALLBACK_VISION_MODELS,
  GEMINI_REQUEST_TIMEOUT_MS,
  GEMINI_MULTI_PAGE_REQUEST_TIMEOUT_MS,
  MAX_AUTOMATIC_RETRIES,
  INITIAL_BACKOFF_MS,
  DOCKET_EXTRACTION_SYSTEM_INSTRUCTION,
  GCI_MISSING_JOB_NO_WARNING,
  isGciSupplierHint,
  normalizeGciDispatchDate,
  resolveGciPageHeaderFields,
  isGciExcludedNonPartItem,
  appendPagePayloadParts,
  buildDocketExtractionPrompt,
  buildRestDocketResponseSchema,
  summarizePartsForDiagnostics,
  OcrAttemptDiagnostics,
  OcrDiagnosticsSummary,
} from '../../src/server/docketOcr.ts';

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

const DEFAULT_PRIMARY_MODEL = DEFAULT_PRIMARY_VISION_MODEL;
const DEFAULT_FALLBACK_MODELS = DEFAULT_FALLBACK_VISION_MODELS;

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

const SAFE_PAGES_LOG_KEYS = new Set([
  'imageCount',
  'approxPayloadBytes',
  'requestStartedAt',
  'requestCompletedAt',
  'durationMs',
  'statusCode',
  'providerErrorMessage',
  'model',
]);

function logPagesOcrEvent(level: 'info' | 'warn' | 'error', event: string, meta: Record<string, unknown> = {}) {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!SAFE_PAGES_LOG_KEYS.has(k) && /key|token|secret|image|base64|dataurl|text/i.test(k)) continue;
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
  responseSchema: Record<string, unknown>,
  timeoutMs: number = GEMINI_REQUEST_TIMEOUT_MS
): Promise<{ text: string; statusCode: number }> {
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
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
        `Gemini API request to ${model} timed out after ${Math.round(timeoutMs / 1000)}s (HTTP 504).`
      );
      timeoutErr.status = 504;
      timeoutErr.code = 'GEMINI_TIMEOUT';
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
    const emptyErr: any = new Error('Malformed OCR response: Empty response received from Gemini AI model.');
    emptyErr.status = response.status || 502;
    throw emptyErr;
  }
  return { text, statusCode: response.status || 200 };
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
      const desc = appendPagePayloadParts(parts, pNum, resolvedPayloads[i]);
      pageDescriptions.push(desc);
    }

    const systemInstruction = DOCKET_EXTRACTION_SYSTEM_INSTRUCTION;

    const pageNumbers = Array.from({ length: totalPages }, (_, idx) => idx + 1);
    const promptText = buildDocketExtractionPrompt(
      pageDescriptions,
      pageNumbers,
      totalPages,
      typeof supplierHint === 'string' ? supplierHint : undefined
    );

    parts.push({ text: promptText });

    const responseSchema = buildRestDocketResponseSchema();

    const { primaryModel, fallbackModels } = resolveConfiguredModels(context.env);
    const allModels = [primaryModel, ...fallbackModels];
    const nowMs = Date.now();
    const candidateModels = [
      ...allModels.filter((m) => (pagesModelCooldownUntil.get(m) || 0) <= nowMs),
      ...allModels.filter((m) => (pagesModelCooldownUntil.get(m) || 0) > nowMs),
    ];

    const { imageCount, approxPayloadBytes } = summarizePartsForDiagnostics(parts);
    const overallStartMs = Date.now();
    const overallStartedAt = new Date(overallStartMs).toISOString();
    const attemptDiagnostics: OcrAttemptDiagnostics[] = [];
    let finalDiagnostics: OcrDiagnosticsSummary | undefined;

    const pagesTimeoutMs =
      totalPages > 1 ? GEMINI_MULTI_PAGE_REQUEST_TIMEOUT_MS : GEMINI_REQUEST_TIMEOUT_MS;
    const maxTotalBudgetMs = totalPages > 1 ? 85000 : 80000;

    let parsed: any = null;
    let lastError: any = null;
    let modelUsed: string = primaryModel;
    let fallbackUsed = false;
    let totalRetryAttempts = 0;

    for (let mIdx = 0; mIdx < candidateModels.length && !parsed; mIdx++) {
      const model = candidateModels[mIdx];
      const isFallback = model !== primaryModel;

      const remainingBeforeModelMs = maxTotalBudgetMs - (Date.now() - overallStartMs);
      if (remainingBeforeModelMs < 4000) {
        break;
      }

      logPagesOcrEvent('info', isFallback ? 'model_fallback_selected' : 'model_selected', {
        model,
        isFallback,
        imageCount,
        approxPayloadBytes,
      });

      for (let retry = 0; retry <= MAX_AUTOMATIC_RETRIES; retry++) {
        const remainingBudgetMs = maxTotalBudgetMs - (Date.now() - overallStartMs);
        if (remainingBudgetMs < 4000) {
          break;
        }
        const attemptTimeoutMs = Math.min(pagesTimeoutMs, remainingBudgetMs);
        const attemptStartMs = Date.now();
        const requestStartedAt = new Date(attemptStartMs).toISOString();
        try {
          const { text: rawJsonText, statusCode } = await callGeminiRestSingleAttempt(
            apiKey,
            model,
            systemInstruction,
            parts,
            responseSchema,
            attemptTimeoutMs
          );
          parsed = validateOcrPayload(rawJsonText);
          modelUsed = model;
          fallbackUsed = isFallback;
          const attemptEndMs = Date.now();
          const requestCompletedAt = new Date(attemptEndMs).toISOString();
          const durationMs = Math.max(1, attemptEndMs - attemptStartMs);

          attemptDiagnostics.push({
            model,
            attempt: retry + 1,
            requestStartedAt,
            requestCompletedAt,
            durationMs,
            statusCode,
            imageCount,
            approxPayloadBytes,
          });
          finalDiagnostics = {
            model,
            requestStartedAt: overallStartedAt,
            requestCompletedAt,
            durationMs: Math.max(1, attemptEndMs - overallStartMs),
            statusCode,
            imageCount,
            approxPayloadBytes,
            attempts: attemptDiagnostics,
          };

          logPagesOcrEvent('info', 'extraction_succeeded', {
            model,
            isFallback,
            retryAttempts: totalRetryAttempts,
            requestStartedAt,
            requestCompletedAt,
            durationMs,
            statusCode,
            imageCount,
            approxPayloadBytes,
            itemsExtracted: parsed.items.length,
          });
          break;
        } catch (err: any) {
          const attemptEndMs = Date.now();
          const requestCompletedAt = new Date(attemptEndMs).toISOString();
          const durationMs = Math.max(1, attemptEndMs - attemptStartMs);
          lastError = err;
          const classification = classifyGeminiError(err);
          const msg = String(err?.message || '');
          const isValidationFailure = /Malformed|Incomplete OCR|Invalid OCR item/i.test(msg);

          attemptDiagnostics.push({
            model,
            attempt: retry + 1,
            requestStartedAt,
            requestCompletedAt,
            durationMs,
            statusCode: classification.statusCode,
            providerErrorMessage: classification.cleanMessage,
            imageCount,
            approxPayloadBytes,
          });

          logPagesOcrEvent('warn', 'extraction_attempt_failed', {
            model,
            isFallback,
            attempt: retry + 1,
            maxAttempts: MAX_AUTOMATIC_RETRIES + 1,
            requestStartedAt,
            requestCompletedAt,
            durationMs,
            statusCode: classification.statusCode,
            errorCode: classification.errorCode,
            providerErrorMessage: classification.cleanMessage,
            imageCount,
            approxPayloadBytes,
            isRetryable: classification.isRetryableAvailabilityError || isValidationFailure,
            reason: classification.cleanMessage,
          });

          if (!isValidationFailure && (classification.isAuthError || classification.statusCode === 400)) {
            const permErr: any = new Error(classification.cleanMessage);
            permErr.status = classification.statusCode;
            permErr.code = classification.errorCode;
            permErr.diagnostics = {
              model,
              requestStartedAt: overallStartedAt,
              requestCompletedAt,
              durationMs: Math.max(1, attemptEndMs - overallStartMs),
              statusCode: classification.statusCode,
              providerErrorMessage: classification.cleanMessage,
              imageCount,
              approxPayloadBytes,
              attempts: attemptDiagnostics,
            } satisfies OcrDiagnosticsSummary;
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
      const errToThrow: any = lastError || new Error('Could not extract parts from docket images.');
      const lastClassification = classifyGeminiError(errToThrow);
      const overallEndMs = Date.now();
      errToThrow.diagnostics = errToThrow.diagnostics || {
        model: attemptDiagnostics[attemptDiagnostics.length - 1]?.model || primaryModel,
        requestStartedAt: overallStartedAt,
        requestCompletedAt: new Date(overallEndMs).toISOString(),
        durationMs: Math.max(1, overallEndMs - overallStartMs),
        statusCode: lastClassification.statusCode,
        providerErrorMessage: lastClassification.cleanMessage,
        imageCount,
        approxPayloadBytes,
        attempts: attemptDiagnostics,
      };
      throw errToThrow;
    }

    const rawItems: any[] = Array.isArray(parsed.items) ? parsed.items : [];
    const rawPageHeaders: any[] = Array.isArray(parsed.pageHeaders) ? parsed.pageHeaders : [];
    const topWarnings: string[] = Array.isArray(parsed.validationWarnings)
      ? parsed.validationWarnings.map((w: any) => String(w || '').trim()).filter(Boolean)
      : [];

    const pageRowBounds = new Map<number, { min?: number; max?: number }>();
    for (const raw of rawItems) {
      const pNo = Math.max(1, Math.min(totalPages, Number(raw?.page ?? raw?.pageNumber) || 1));
      const nVal = parseInt(parseCleanRowNo(raw?.no), 10);
      if (!Number.isNaN(nVal) && nVal > 0 && nVal <= 1500) {
        const cur = pageRowBounds.get(pNo) || {};
        pageRowBounds.set(pNo, {
          min: cur.min === undefined ? nVal : Math.min(cur.min, nVal),
          max: cur.max === undefined ? nVal : Math.max(cur.max, nVal),
        });
      }
    }

    const pageHeaderMap = new Map<number, any>();
    for (const ph of rawPageHeaders) {
      const pNo = Math.min(totalPages, Math.max(1, Number(ph?.page ?? ph?.pageNumber) || 1));
      if (!pageHeaderMap.has(pNo)) {
        const rawDate = ph.deliveryDate ? String(ph.deliveryDate).trim() : '';
        const dn = String(ph?.docketNumber ?? ph?.referenceNumber ?? '').trim();
        const jn = String(ph?.jobNumber ?? ph?.jobNo ?? ph?.job_no ?? '').trim();
        const on = String(ph?.orderNumber ?? ph?.clientOrderNo ?? ph?.client_order_no ?? '').trim();
        pageHeaderMap.set(pNo, {
          docketNumber: dn,
          supplier: ph.supplier ? String(ph.supplier).trim() : '',
          customerName: ph.customerName ? String(ph.customerName).trim() : '',
          deliveryDate: isGci ? (normalizeGciDispatchDate(rawDate) || '') : rawDate,
          carrier: ph.carrier ? String(ph.carrier).trim() : undefined,
          orderNumber: on || undefined,
          jobNumber: jn || undefined,
          palletCount: ph.palletCount ? Math.max(1, Number(ph.palletCount) || 1) : 1,
          startsNewDocket: Boolean(ph.startsNewDocket),
          validationWarnings: [] as string[],
        });
      }
    }

    const otherPageIds = new Set<string>();
    for (let pNo = 2; pNo <= totalPages; pNo++) {
      const m = pageHeaderMap.get(pNo);
      if (m?.docketNumber) otherPageIds.add(m.docketNumber);
      if (m?.jobNumber) otherPageIds.add(m.jobNumber);
      if (m?.orderNumber) otherPageIds.add(m.orderNumber);
    }
    const canBackfillPage1 = totalPages === 1 || rawPageHeaders.length === 0;
    const topDocket = String(parsed.docketNumber ?? parsed.referenceNumber ?? '').trim();
    const topJob = String(parsed.jobNumber ?? parsed.jobNo ?? parsed.job_no ?? '').trim();
    const topOrder = String(parsed.orderNumber ?? parsed.clientOrderNo ?? parsed.client_order_no ?? '').trim();

    if (!pageHeaderMap.has(1)) {
      pageHeaderMap.set(1, {
        docketNumber: '',
        supplier: '',
        customerName: '',
        deliveryDate: '',
        palletCount: 1,
        startsNewDocket: false,
        validationWarnings: [] as string[],
      });
    }
    const page1Meta = pageHeaderMap.get(1)!;
    if (!page1Meta.docketNumber && topDocket && (canBackfillPage1 || !otherPageIds.has(topDocket))) {
      page1Meta.docketNumber = topDocket;
    }
    if (!page1Meta.jobNumber && topJob && (canBackfillPage1 || !otherPageIds.has(topJob))) {
      page1Meta.jobNumber = topJob;
    }
    if (!page1Meta.orderNumber && topOrder && (canBackfillPage1 || !otherPageIds.has(topOrder))) {
      page1Meta.orderNumber = topOrder;
    }
    if (!page1Meta.deliveryDate && parsed.deliveryDate) {
      const rawTopDate = String(parsed.deliveryDate).trim();
      page1Meta.deliveryDate = isGci ? (normalizeGciDispatchDate(rawTopDate) || '') : rawTopDate;
    }
    if (!page1Meta.supplier && parsed.supplier) {
      page1Meta.supplier = String(parsed.supplier).trim();
    }
    if (!page1Meta.customerName && parsed.customerName) {
      page1Meta.customerName = String(parsed.customerName).trim();
    }
    if (!page1Meta.carrier && parsed.carrier) {
      page1Meta.carrier = String(parsed.carrier).trim();
    }
    if (topWarnings.length > 0 && totalPages === 1) {
      page1Meta.validationWarnings.push(...topWarnings);
    }

    // Apply GCI-specific header resolution per page BEFORE docket segmentation
    if (isGci) {
      for (let pNo = 1; pNo <= totalPages; pNo++) {
        const ph = pageHeaderMap.get(pNo) || { validationWarnings: [] };
        const resolved = resolveGciPageHeaderFields(
          {
            docketNumber: ph.docketNumber,
            jobNumber: ph.jobNumber,
            orderNumber: ph.orderNumber,
            deliveryDate: ph.deliveryDate,
            supplier: ph.supplier,
            validationWarnings: ph.validationWarnings,
          },
          {
            selectableText: resolvedPayloads[pNo - 1]?.pdfSelectableText,
            isContinuationWithoutHeader: pNo > 1,
          }
        );
        pageHeaderMap.set(pNo, {
          ...ph,
          docketNumber: resolved.docketNumber,
          jobNumber: resolved.jobNumber,
          orderNumber: resolved.orderNumber,
          deliveryDate: resolved.deliveryDate || '',
          supplier: 'GCI',
          validationWarnings: resolved.validationWarnings,
        });
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
      maxRowSeen: number;
      validationWarnings: string[];
      separationUncertain: boolean;
      separationReason?: string;
      rawRows: any[];
    }>();
    const segmentOrder: string[] = [];
    let currentKey = '';

    for (let pNo = 1; pNo <= totalPages; pNo++) {
      const ph = pageHeaderMap.get(pNo) || { validationWarnings: [] };
      const dk = (ph?.docketNumber || (!isGci && pNo === 1 ? topDocket : '')).trim();
      const normalizedKey = dk ? dk.replace(/[\s_]+/g, '').toUpperCase() : '';
      const startsNew = Boolean(ph?.startsNewDocket);
      const prevSeg = currentKey ? segmentMap.get(currentKey) : undefined;
      const bounds = pageRowBounds.get(pNo) || {};
      const rowResetDetected = Boolean(
        prevSeg && bounds.min !== undefined && bounds.min <= 2 && prevSeg.maxRowSeen >= 3
      );
      const orderChanged = Boolean(
        prevSeg && ph?.orderNumber && prevSeg.orderNumber && ph.orderNumber !== prevSeg.orderNumber
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
            orderNumber: ph?.orderNumber || (!isGci && topOrder ? topOrder : undefined),
            jobNumber: ph?.jobNumber || (!isGci && topJob ? topJob : undefined),
            palletCount: ph?.palletCount || Math.max(1, Number(parsed.palletCount) || 1),
            pageNumbers: [pNo],
            maxRowSeen: bounds.max || 0,
            validationWarnings: [...(ph.validationWarnings || [])],
            separationUncertain: false,
            rawRows: [],
          });
          segmentOrder.push(normalizedKey);
        } else {
          const existing = segmentMap.get(normalizedKey)!;
          existing.pageNumbers.push(pNo);
          existing.validationWarnings.push(...(ph.validationWarnings || []));
          existing.maxRowSeen = Math.max(existing.maxRowSeen, bounds.max || 0);
        }
        currentKey = normalizedKey;
      } else if (!currentKey || startsNew || orderChanged || rowResetDetected) {
        if (isGci) {
          const fallbackKey = `GCI-MISSING-P${pNo}-${Math.floor(100 + Math.random() * 900)}`;
          const parsedDateNorm = normalizeGciDispatchDate(parsed.deliveryDate ? String(parsed.deliveryDate).trim() : '');
          if (prevSeg && (!prevSeg.hasExplicitDocketNumber || (!orderChanged && !startsNew))) {
            prevSeg.separationUncertain = true;
            prevSeg.separationReason =
              prevSeg.separationReason || 'Verify multi-page boundary against adjoining pages.';
          }
          const splitReason =
            prevSeg
              ? `Page ${pNo} appears to start a new GCI docket (${
                  orderChanged ? 'Client Order No changed' : rowResetDetected ? 'row numbering restarted at 1' : 'new header detected'
                }), but Job No is missing or unreadable. Enter the printed Job No into Docket / Ref # manually (Client Order No was not substituted).`
              : GCI_MISSING_JOB_NO_WARNING;
          segmentMap.set(fallbackKey, {
            docketNumber: '',
            hasExplicitDocketNumber: false,
            supplier: 'GCI',
            customerName: ph?.customerName || prevSeg?.customerName || (parsed.customerName ? String(parsed.customerName).trim() : undefined),
            deliveryDate: ph?.deliveryDate || prevSeg?.deliveryDate || parsedDateNorm || new Date().toISOString().slice(0, 10),
            carrier: ph?.carrier || (parsed.carrier ? String(parsed.carrier).trim() : undefined),
            orderNumber: ph?.orderNumber || (pNo === 1 && topOrder ? topOrder : undefined),
            jobNumber: undefined,
            palletCount: ph?.palletCount || Math.max(1, Number(parsed.palletCount) || 1),
            pageNumbers: [pNo],
            maxRowSeen: bounds.max || 0,
            validationWarnings: Array.from(new Set([...(ph.validationWarnings || []), GCI_MISSING_JOB_NO_WARNING])),
            separationUncertain: true,
            separationReason: splitReason,
            rawRows: [],
          });
          segmentOrder.push(fallbackKey);
          currentKey = fallbackKey;
        } else {
          const uncertain = totalPages > 1;
          const fallbackKey = uncertain ? `REVIEW-P${pNo}` : 'SINGLE';
          const fallbackDk = uncertain
            ? `DK-REVIEW-P${pNo}-${Math.floor(100 + Math.random() * 900)}`
            : `DK-${Math.floor(10000 + Math.random() * 90000)}`;
          if (prevSeg) {
            prevSeg.separationUncertain = true;
            prevSeg.separationReason =
              prevSeg.separationReason || 'Verify multi-page boundary against adjoining pages.';
          }
          segmentMap.set(fallbackKey, {
            docketNumber: fallbackDk,
            hasExplicitDocketNumber: false,
            supplier: ph?.supplier || prevSeg?.supplier || String(parsed.supplier || 'Steel Fabrication Supplier').trim(),
            customerName: ph?.customerName || prevSeg?.customerName || (parsed.customerName ? String(parsed.customerName).trim() : undefined),
            deliveryDate: ph?.deliveryDate || prevSeg?.deliveryDate || String(parsed.deliveryDate || new Date().toISOString().slice(0, 10)).trim(),
            carrier: ph?.carrier || (parsed.carrier ? String(parsed.carrier).trim() : undefined),
            orderNumber: ph?.orderNumber || (pNo === 1 && topOrder ? topOrder : undefined),
            jobNumber: ph?.jobNumber || (pNo === 1 && topJob ? topJob : undefined),
            palletCount: ph?.palletCount || Math.max(1, Number(parsed.palletCount) || 1),
            pageNumbers: [pNo],
            maxRowSeen: bounds.max || 0,
            validationWarnings: [...(ph.validationWarnings || [])],
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
        const cur = segmentMap.get(currentKey)!;
        cur.pageNumbers.push(pNo);
        cur.validationWarnings.push(...(ph.validationWarnings || []));
        cur.maxRowSeen = Math.max(cur.maxRowSeen, bounds.max || 0);
      }
    }

    for (const raw of rawItems) {
      const rowPage = Math.max(1, Math.min(totalPages, Number(raw?.page ?? raw?.pageNumber) || 1));
      const targetKey =
        segmentOrder.find((k) => segmentMap.get(k)!.pageNumbers.includes(rowPage)) || segmentOrder[0];
      if (targetKey) {
        segmentMap.get(targetKey)!.rawRows.push(raw);
      }
    }

    const builtDockets = segmentOrder.map((segKey) => {
      const seg = segmentMap.get(segKey)!;
      const excludedRowNos = new Set<number>();
      let autoSeq = 1;
      const items: Array<NonNullable<ReturnType<typeof normalizePageItem>>['item']> = [];
      for (const r of seg.rawRows) {
        if (isGci && isGciExcludedNonPartItem(r?.part, r?.desc)) {
          const exNo = parseInt(parseCleanRowNo(r?.no), 10);
          if (!Number.isNaN(exNo) && exNo > 0) excludedRowNos.add(exNo);
          continue;
        }
        const norm = normalizePageItem(r, seg.pageNumbers[0] || 1);
        if (!norm) continue;
        if (isGci && isGciExcludedNonPartItem(norm.item.partNumber, norm.item.description)) {
          const exNo = parseInt(norm.cleanNo, 10);
          if (!Number.isNaN(exNo) && exNo > 0) excludedRowNos.add(exNo);
          continue;
        }
        items.push({
          ...norm.item,
          itemNumber: norm.cleanNo || String(autoSeq++),
        });
      }
      const flaggedRowCount = items.filter((it) => it.confidence === 'low').length;
      const dedupWarnings = Array.from(new Set(seg.validationWarnings.filter(Boolean)));
      const segRawText = seg.pageNumbers
        .map((pNum) => resolvedPayloads[pNum - 1]?.pdfSelectableText?.trim())
        .filter(Boolean)
        .join('\n')
        .trim();

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
        rawTextSummary: segRawText || undefined,
        excludedRowNumbers: excludedRowNos.size > 0 ? Array.from(excludedRowNos).sort((a, b) => a - b) : undefined,
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
        hasPrintedNoColumn: parsed.hasPrintedNoColumn !== false,
        flaggedRowCount,
        validationFlags: dedupWarnings.length > 0 ? dedupWarnings : undefined,
        validationWarnings: dedupWarnings.length > 0 ? dedupWarnings : undefined,
      };
    });

    const primary = builtDockets[0];
    const responsePayload = {
      ...primary,
      pagesScanned: totalPages,
      processingTimeMs: finalDiagnostics?.durationMs,
      ocrDiagnostics: finalDiagnostics,
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
        diagnostics: err?.diagnostics,
      }),
      {
        status,
        headers: corsHeaders,
      }
    );
  }
};
