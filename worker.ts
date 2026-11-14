/**
 * Cloudflare Worker: PalletTrack Serverless API
 *
 * Secure server-side endpoint for Gemini multimodal delivery docket & invoice extraction
 * and Cloudflare D1 multi-user database operations.
 * Includes automatic retry handling (HTTP 503, 429, 5xx) with exponential backoff + jitter,
 * configurable secondary Gemini model failover, output validation, and safe operational logging.
 */

import { D1Database } from './src/server/db/types.ts';
import {
  handlePalletTrackApiRequest,
  extractSessionTokenFromRequest,
} from './src/server/api/palletTrackApiRouter.ts';
import { PalletTrackDbService } from './src/server/api/palletTrackDbService.ts';
import {
  realtimeBroker,
  PalletTrackRealtimeBroker,
  HEARTBEAT_INTERVAL_MS,
  RealtimeEvent,
} from './src/server/realtime/realtimeHub.ts';

import {
  DEFAULT_PRIMARY_VISION_MODEL,
  DEFAULT_FALLBACK_VISION_MODELS,
  GEMINI_REQUEST_TIMEOUT_MS,
  GEMINI_MULTI_PAGE_REQUEST_TIMEOUT_MS,
  MAX_AUTOMATIC_RETRIES,
  INITIAL_BACKOFF_MS,
  DOCKET_EXTRACTION_SYSTEM_INSTRUCTION,
  GCI_MISSING_JOB_NO_WARNING,
  resolveConfiguredVisionModels,
  classifyGeminiError,
  validateAndParseOcrJsonResponse,
  buildDocketExtractionPrompt,
  buildRestDocketResponseSchema,
  normalizeRawBatchItem,
  isGciSupplierHint,
  isGciExcludedNonPartItem,
  normalizeGciDispatchDate,
  resolveGciPageHeaderFields,
  appendPagePayloadParts,
  summarizePartsForDiagnostics,
  OcrAttemptDiagnostics,
  OcrDiagnosticsSummary,
} from './src/server/docketOcr.ts';

export interface Env {
  GEMINI_API_KEY?: string;
  GEMINI_PRIMARY_MODEL?: string;
  GEMINI_FALLBACK_MODEL?: string;
  GEMINI_FALLBACK_MODELS?: string;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  DB?: D1Database;
  REALTIME_HUB?: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  [key: string]: unknown;
}

const DEFAULT_PRIMARY_MODEL = DEFAULT_PRIMARY_VISION_MODEL;
const DEFAULT_FALLBACK_MODELS = DEFAULT_FALLBACK_VISION_MODELS;
const workerModelCooldownUntil = new Map<string, number>();
const WORKER_MODEL_COOLDOWN_MS = 5 * 60 * 1000;
const WORKER_TRANSIENT_COOLDOWN_MS = 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeExponentialBackoffWithJitter(retryAttempt: number, baseMs: number = INITIAL_BACKOFF_MS): number {
  const exp = Math.max(0, retryAttempt - 1);
  return Math.min(8000, baseMs * Math.pow(2, exp) + Math.floor(Math.random() * 450));
}

const SAFE_WORKER_LOG_KEYS = new Set([
  'imageCount',
  'approxPayloadBytes',
  'requestStartedAt',
  'requestCompletedAt',
  'durationMs',
  'statusCode',
  'providerErrorMessage',
  'model',
]);

function logWorkerOcrEvent(level: 'info' | 'warn' | 'error', event: string, meta: Record<string, unknown> = {}) {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!SAFE_WORKER_LOG_KEYS.has(k) && /key|token|secret|image|base64|dataurl|text/i.test(k)) continue;
    safe[k] = typeof v === 'string' ? v.replace(/key=[A-Za-z0-9_\-]+/gi, 'key=[REDACTED]').slice(0, 300) : v;
  }
  const msg = JSON.stringify({ timestamp: new Date().toISOString(), component: 'PartTrack-Worker-OCR', event, ...safe });
  if (level === 'error') console.error(msg);
  else if (level === 'warn') console.warn(msg);
  else console.log(msg);
}

function resolveWorkerModels(env: Env): { primaryModel: string; fallbackModels: string[] } {
  return resolveConfiguredVisionModels(env as Record<string, unknown>);
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
    contents: [
      {
        parts,
      },
    ],
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
    clearTimeout(timer);
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

async function callGeminiRestWithRetryAndFallback(
  apiKey: string,
  env: Env,
  systemInstruction: string,
  parts: Array<Record<string, unknown>>,
  responseSchema: Record<string, unknown>,
  mode: 'batch' | 'recovery' | 'label' = 'batch',
  timeoutMs: number = GEMINI_REQUEST_TIMEOUT_MS,
  maxTotalBudgetMs: number = timeoutMs > GEMINI_REQUEST_TIMEOUT_MS ? 85000 : 80000
): Promise<{
  parsed: any;
  modelUsed: string;
  fallbackUsed: boolean;
  retryAttempts: number;
  diagnostics: OcrDiagnosticsSummary;
}> {
  const { primaryModel, fallbackModels } = resolveWorkerModels(env);
  const allConfiguredModels = [primaryModel, ...fallbackModels];
  const nowMs = Date.now();
  const { imageCount, approxPayloadBytes } = summarizePartsForDiagnostics(parts);
  const overallStartMs = Date.now();
  const overallStartedAt = new Date(overallStartMs).toISOString();
  const attemptDiagnostics: OcrAttemptDiagnostics[] = [];

  const candidateModels = [
    ...allConfiguredModels.filter((m) => (workerModelCooldownUntil.get(m) || 0) <= nowMs),
    ...allConfiguredModels.filter((m) => (workerModelCooldownUntil.get(m) || 0) > nowMs),
  ];

  let totalRetryAttempts = 0;
  let lastError: any = null;
  let lastClassification: ReturnType<typeof classifyGeminiError> | null = null;

  for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
    const model = candidateModels[mIdx];
    const isFallback = model !== primaryModel;
    const maxRetries = MAX_AUTOMATIC_RETRIES;

    const remainingBeforeModelMs = maxTotalBudgetMs - (Date.now() - overallStartMs);
    if (remainingBeforeModelMs < 4000) {
      break;
    }

    logWorkerOcrEvent('info', isFallback ? 'model_fallback_selected' : 'model_selected', {
      model,
      isFallback,
      mode,
      imageCount,
      approxPayloadBytes,
    });

    for (let retry = 0; retry <= maxRetries; retry++) {
      const remainingBudgetMs = maxTotalBudgetMs - (Date.now() - overallStartMs);
      if (remainingBudgetMs < 4000) {
        break;
      }
      const attemptTimeoutMs = Math.min(timeoutMs, remainingBudgetMs);
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
        const parsed = validateAndParseOcrJsonResponse(rawJsonText, mode);
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

        logWorkerOcrEvent('info', 'extraction_succeeded', {
          model,
          isFallback,
          retryAttempts: totalRetryAttempts,
          requestStartedAt,
          requestCompletedAt,
          durationMs,
          statusCode,
          imageCount,
          approxPayloadBytes,
          itemsExtracted: Array.isArray(parsed?.items) ? parsed.items.length : 1,
        });

        const diagnostics: OcrDiagnosticsSummary = {
          model,
          requestStartedAt: overallStartedAt,
          requestCompletedAt,
          durationMs: Math.max(1, attemptEndMs - overallStartMs),
          statusCode,
          imageCount,
          approxPayloadBytes,
          attempts: attemptDiagnostics,
        };

        return {
          parsed,
          modelUsed: model,
          fallbackUsed: isFallback,
          retryAttempts: totalRetryAttempts,
          diagnostics,
        };
      } catch (err: any) {
        const attemptEndMs = Date.now();
        const requestCompletedAt = new Date(attemptEndMs).toISOString();
        const durationMs = Math.max(1, attemptEndMs - attemptStartMs);
        lastError = err;
        const classification = classifyGeminiError(err);
        lastClassification = classification;
        const msg = String(err?.message || '');
        const isValidationFailure =
          /Malformed|Incomplete OCR|Invalid OCR item/i.test(msg);

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

        logWorkerOcrEvent('warn', 'extraction_attempt_failed', {
          model,
          isFallback,
          attempt: retry + 1,
          maxAttempts: maxRetries + 1,
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

        // Never retry 401/403 authentication errors or 400 malformed requests
        if (!isValidationFailure && (classification.isAuthError || classification.statusCode === 400)) {
          const permErr: any = new Error(classification.cleanMessage);
          permErr.status = classification.statusCode;
          permErr.code = classification.errorCode;
          permErr.retryable = false;
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

        // Never retry 404 invalid model, daily quota exhaustion, or request timeout on the same model:
        // record cooldown and immediately fail over to the next model.
        if (
          !isValidationFailure &&
          (classification.isInvalidModel ||
            classification.isModelDailyQuotaExhausted ||
            classification.isTimeout)
        ) {
          workerModelCooldownUntil.set(
            model,
            Date.now() + (classification.isTimeout ? WORKER_TRANSIENT_COOLDOWN_MS : WORKER_MODEL_COOLDOWN_MS)
          );
          logWorkerOcrEvent('info', 'model_fast_failover', {
            failedModel: model,
            nextModel: candidateModels[mIdx + 1] || 'none',
            statusCode: classification.statusCode,
            errorCode: classification.errorCode,
          });
          break;
        }

        if ((classification.isRetryableAvailabilityError || isValidationFailure) && retry < maxRetries) {
          totalRetryAttempts++;
          const waitMs = computeExponentialBackoffWithJitter(retry + 1, INITIAL_BACKOFF_MS);
          logWorkerOcrEvent('info', 'retrying_after_backoff', {
            model,
            retryAttempt: retry + 1,
            maxRetries,
            waitMs,
            statusCode: classification.statusCode,
          });
          await sleep(waitMs);
          continue;
        }

        if (classification.isHighDemand503 || classification.isRateLimit) {
          workerModelCooldownUntil.set(model, Date.now() + WORKER_TRANSIENT_COOLDOWN_MS);
        }
      }
    }
  }

  const finalClassification = lastClassification || classifyGeminiError(lastError);
  const overallEndMs = Date.now();
  const overallCompletedAt = new Date(overallEndMs).toISOString();
  const failureDiagnostics: OcrDiagnosticsSummary = {
    model: attemptDiagnostics[attemptDiagnostics.length - 1]?.model || primaryModel,
    requestStartedAt: overallStartedAt,
    requestCompletedAt: overallCompletedAt,
    durationMs: Math.max(1, overallEndMs - overallStartMs),
    statusCode: finalClassification.statusCode,
    providerErrorMessage: finalClassification.cleanMessage,
    imageCount,
    approxPayloadBytes,
    attempts: attemptDiagnostics,
  };

  logWorkerOcrEvent('error', 'all_models_and_retries_exhausted', {
    primaryModel,
    fallbackModels: fallbackModels.join(','),
    totalRetryAttempts,
    requestStartedAt: overallStartedAt,
    requestCompletedAt: overallCompletedAt,
    durationMs: failureDiagnostics.durationMs,
    statusCode: finalClassification.statusCode,
    errorCode: finalClassification.errorCode,
    providerErrorMessage: finalClassification.cleanMessage,
    imageCount,
    approxPayloadBytes,
    error: finalClassification.cleanMessage,
  });

  const finalErr: any = new Error(
    finalClassification.cleanMessage ||
      'Gemini AI could not process the docket after automatic retries and model fallback.'
  );
  finalErr.status = finalClassification.statusCode;
  finalErr.code = finalClassification.errorCode;
  finalErr.retryable = finalClassification.isRetryableAvailabilityError || finalClassification.isTimeout;
  finalErr.diagnostics = failureDiagnostics;
  throw finalErr;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

async function handleExtractDocket(request: Request, env: Env): Promise<Response> {
  const apiKey = (env.GEMINI_API_KEY || '').trim();

  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error:
          'Gemini AI API key is not configured in the Cloudflare Worker. Please set the GEMINI_API_KEY secret in your Cloudflare Worker settings (wrangler secret put GEMINI_API_KEY or Cloudflare Dashboard > Settings > Variables and Secrets).',
        code: 'MISSING_GEMINI_API_KEY',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  const body: any = await request.json().catch(() => ({}));
  const { images, pageSlices, supplierHint } = body || {};
  const isGci = isGciSupplierHint(typeof supplierHint === 'string' ? supplierHint : undefined);

  if (
    (!Array.isArray(images) || images.length === 0) &&
    (!Array.isArray(pageSlices) || pageSlices.length === 0)
  ) {
    return new Response(JSON.stringify({ error: 'No docket images provided.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
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

  const workerTimeoutMs =
    totalPages > 1 ? GEMINI_MULTI_PAGE_REQUEST_TIMEOUT_MS : GEMINI_REQUEST_TIMEOUT_MS;

  const { parsed, modelUsed, fallbackUsed, retryAttempts, diagnostics } =
    await callGeminiRestWithRetryAndFallback(
      apiKey,
      env,
      systemInstruction,
      parts,
      responseSchema,
      'batch',
      workerTimeoutMs,
      totalPages > 1 ? 85000 : 80000
    );

  const rawItems: any[] = Array.isArray(parsed.items) ? parsed.items : [];
  const rawPageHeaders: any[] = Array.isArray(parsed.pageHeaders) ? parsed.pageHeaders : [];
  const topLevelWarnings: string[] = Array.isArray(parsed.validationWarnings)
    ? parsed.validationWarnings.map((w: any) => String(w || '').trim()).filter(Boolean)
    : [];

  interface WorkerPageMeta {
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
    rawItems: any[];
    minRowNo?: number;
    maxRowNo?: number;
  }

  const pageMetaMap = new Map<number, WorkerPageMeta>();
  for (let p = 1; p <= totalPages; p++) {
    pageMetaMap.set(p, {
      pageNumber: p,
      explicitDocketNumber: '',
      validationWarnings: [],
      rawItems: [],
    });
  }

  for (const ph of rawPageHeaders) {
    const pNum = Math.min(totalPages, Math.max(1, Number(ph?.page ?? ph?.pageNumber) || 1));
    const meta = pageMetaMap.get(pNum)!;
    const dn = String(ph?.docketNumber ?? ph?.referenceNumber ?? '').trim();
    const jn = String(ph?.jobNumber ?? ph?.jobNo ?? ph?.job_no ?? '').trim();
    const on = String(ph?.orderNumber ?? ph?.clientOrderNo ?? ph?.client_order_no ?? '').trim();
    if (dn && !meta.explicitDocketNumber) meta.explicitDocketNumber = dn;
    if (ph?.supplier && String(ph.supplier).trim() && !meta.supplier) {
      meta.supplier = String(ph.supplier).trim();
    }
    if (ph?.customerName && String(ph.customerName).trim() && !meta.customerName) {
      meta.customerName = String(ph.customerName).trim();
    }
    if (ph?.deliveryDate && !meta.deliveryDate) {
      const trimmedDate = String(ph.deliveryDate).trim();
      if (isGci) {
        const normDate = normalizeGciDispatchDate(trimmedDate);
        if (normDate) meta.deliveryDate = normDate;
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate)) {
        meta.deliveryDate = trimmedDate;
      }
    }
    if (on && !meta.orderNumber) {
      meta.orderNumber = on;
    }
    if (jn && !meta.jobNumber) {
      meta.jobNumber = jn;
    }
    if (ph?.carrier && String(ph.carrier).trim() && !meta.carrier) {
      meta.carrier = String(ph.carrier).trim();
    }
    if (ph?.palletCount && Number(ph.palletCount) > 0 && !meta.palletCount) {
      meta.palletCount = Number(ph.palletCount);
    }
    if (ph?.startsNewDocket) meta.startsNewDocket = true;
  }

  const firstMeta = pageMetaMap.get(1)!;
  const otherPageIds = new Set<string>();
  for (let p = 2; p <= totalPages; p++) {
    const m = pageMetaMap.get(p);
    if (m?.explicitDocketNumber) otherPageIds.add(m.explicitDocketNumber);
    if (m?.jobNumber) otherPageIds.add(m.jobNumber);
    if (m?.orderNumber) otherPageIds.add(m.orderNumber);
  }
  const canBackfillFromTop = totalPages === 1 || rawPageHeaders.length === 0;
  const topDocket = String(parsed.docketNumber ?? parsed.referenceNumber ?? '').trim();
  const topOrder = String(parsed.orderNumber ?? parsed.clientOrderNo ?? parsed.client_order_no ?? '').trim();
  const topJob = String(parsed.jobNumber ?? parsed.jobNo ?? parsed.job_no ?? '').trim();

  if (!firstMeta.explicitDocketNumber && topDocket && (canBackfillFromTop || !otherPageIds.has(topDocket))) {
    firstMeta.explicitDocketNumber = topDocket;
  }
  if (!firstMeta.supplier && parsed.supplier?.trim()) firstMeta.supplier = String(parsed.supplier).trim();
  if (!firstMeta.customerName && parsed.customerName?.trim()) {
    firstMeta.customerName = String(parsed.customerName).trim();
  }
  if (!firstMeta.deliveryDate && parsed.deliveryDate) {
    const trimmedDate = String(parsed.deliveryDate).trim();
    if (isGci) {
      const normDate = normalizeGciDispatchDate(trimmedDate);
      if (normDate) firstMeta.deliveryDate = normDate;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate)) {
      firstMeta.deliveryDate = trimmedDate;
    }
  }
  if (!firstMeta.orderNumber && topOrder && (canBackfillFromTop || !otherPageIds.has(topOrder))) {
    firstMeta.orderNumber = topOrder;
  }
  if (!firstMeta.jobNumber && topJob && (canBackfillFromTop || !otherPageIds.has(topJob))) {
    firstMeta.jobNumber = topJob;
  }
  if (!firstMeta.carrier && parsed.carrier?.trim()) firstMeta.carrier = String(parsed.carrier).trim();
  if (topLevelWarnings.length > 0 && totalPages === 1) firstMeta.validationWarnings.push(...topLevelWarnings);

  for (const rawIt of rawItems) {
    const pNum = Math.min(totalPages, Math.max(1, Number(rawIt?.page ?? rawIt?.pageNumber) || 1));
    const meta = pageMetaMap.get(pNum)!;
    meta.rawItems.push({ ...rawIt, page: pNum });
    const nVal = parseInt(parseCleanRowNo(rawIt?.no), 10);
    if (!Number.isNaN(nVal) && nVal > 0 && nVal <= 1500) {
      meta.minRowNo = meta.minRowNo === undefined ? nVal : Math.min(meta.minRowNo, nVal);
      meta.maxRowNo = meta.maxRowNo === undefined ? nVal : Math.max(meta.maxRowNo, nVal);
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

  interface WorkerSegment {
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
    rawItems: any[];
    validationWarnings: string[];
    separationUncertain: boolean;
    separationReason?: string;
  }

  const segments: WorkerSegment[] = [];
  const normDocketKey = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '');

  for (let p = 1; p <= totalPages; p++) {
    const meta = pageMetaMap.get(p)!;
    const explicitKey = normDocketKey(meta.explicitDocketNumber);
    const hasExplicit = explicitKey.length > 0;

    if (segments.length === 0) {
      if (isGci && !hasExplicit) {
        const missingKey = `GCI-MISSING-JOB-P${p}-${Math.floor(100 + Math.random() * 900)}`;
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
          validationWarnings: Array.from(new Set([...meta.validationWarnings, GCI_MISSING_JOB_NO_WARNING])),
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
        if (!prevSeg.hasExplicitDocketNumber || (!orderChanged && !meta.startsNewDocket)) {
          prevSeg.separationUncertain = true;
          prevSeg.separationReason = prevSeg.separationReason || 'Verify multi-page boundary against adjoining pages.';
        }
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
      prevSeg.pageNumbers.push(p);
      prevSeg.rawItems.push(...meta.rawItems);
      prevSeg.validationWarnings.push(...meta.validationWarnings);
      prevSeg.maxRowSeen = Math.max(prevSeg.maxRowSeen, meta.maxRowNo || 0);
      prevSeg.palletCount = Math.max(prevSeg.palletCount, meta.palletCount || 1);
    }
  }

  const builtDockets = segments.map((seg) => {
    const items: any[] = [];
    const excludedRowNos = new Set<number>();
    let autoSeq = 1;
    for (const rawIt of seg.rawItems) {
      if (isGci && isGciExcludedNonPartItem(rawIt?.part, rawIt?.desc)) {
        const exNo = parseInt(parseCleanRowNo(rawIt?.no), 10);
        if (!Number.isNaN(exNo) && exNo > 0) {
          excludedRowNos.add(exNo);
        }
        continue;
      }
      const normalized = normalizeRawBatchItem(rawIt, seg.pageNumbers[0]);
      if (!normalized) continue;
      if (isGci && isGciExcludedNonPartItem(normalized.item.partNumber, normalized.item.description)) {
        const exNo = parseInt(normalized.cleanNo, 10);
        if (!Number.isNaN(exNo) && exNo > 0) {
          excludedRowNos.add(exNo);
        }
        continue;
      }
      items.push({
        ...normalized.item,
        itemNumber: normalized.cleanNo || String(autoSeq++),
      });
    }
    const flaggedCount = items.filter((it) => it.confidence === 'low').length;
    const dedupWarnings = Array.from(new Set(seg.validationWarnings.filter(Boolean)));
    const segRawText = seg.pageNumbers
      .map((pNum) => resolvedPayloads[pNum - 1]?.pdfSelectableText?.trim())
      .filter(Boolean)
      .join('\n')
      .trim();

    return {
      docketNumber: seg.explicitDocketNumber,
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
      confidenceScore: items.length > 0 ? (seg.separationUncertain || flaggedCount > 0 || (isGci && !seg.hasExplicitDocketNumber) ? 80 : 100) : 0,
      needsManualReview: items.length === 0 || seg.separationUncertain || flaggedCount > 0 || (isGci && !seg.hasExplicitDocketNumber),
      separationUncertain: seg.separationUncertain,
      separationReason: seg.separationReason,
      sourcePageNumbers: [...seg.pageNumbers],
      extractionMethod: 'gemini-vision',
      extractionEngineLabel: `Gemini (${modelUsed})`,
      aiModelUsed: modelUsed,
      fallbackUsed,
      retryAttempts,
      pagesScanned: seg.pageNumbers.length,
      hasPrintedNoColumn: parsed.hasPrintedNoColumn !== false,
      flaggedRowCount: flaggedCount,
      validationFlags: dedupWarnings.length > 0 ? dedupWarnings : undefined,
      validationWarnings: dedupWarnings.length > 0 ? dedupWarnings : undefined,
    };
  });

  const primary = builtDockets[0] || {
    docketNumber: isGci ? '' : String(parsed.docketNumber || `DK-${Math.floor(10000 + Math.random() * 90000)}`).trim(),
    supplier: isGci ? 'GCI' : String(parsed.supplier || 'Steel Fabrication Supplier').trim(),
    customerName: parsed.customerName ? String(parsed.customerName).trim() : undefined,
    deliveryDate: String(parsed.deliveryDate || new Date().toISOString().slice(0, 10)).trim(),
    carrier: parsed.carrier ? String(parsed.carrier).trim() : undefined,
    orderNumber: parsed.orderNumber ? String(parsed.orderNumber).trim() : undefined,
    jobNumber: parsed.jobNumber ? String(parsed.jobNumber).trim() : undefined,
    palletCount: Math.max(1, Number(parsed.palletCount) || 1),
    items: [],
    confidenceScore: 0,
    needsManualReview: true,
    extractionMethod: 'gemini-vision',
    extractionEngineLabel: `Gemini (${modelUsed})`,
    aiModelUsed: modelUsed,
    fallbackUsed,
    retryAttempts,
    pagesScanned: totalPages,
  };

  const responsePayload = {
    ...primary,
    pagesScanned: totalPages,
    processingTimeMs: diagnostics.durationMs,
    ocrDiagnostics: diagnostics,
    separatedDockets: builtDockets,
  };

  return new Response(JSON.stringify(responsePayload), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function handleRecoverDocketItems(request: Request, env: Env): Promise<Response> {
  const apiKey = (env.GEMINI_API_KEY || '').trim();
  const body: any = await request.json().catch(() => ({}));
  const { slicePayload, pageNumber, missingNos } = body || {};

  if (!apiKey || !slicePayload || !Array.isArray(missingNos) || missingNos.length === 0) {
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  const parts: Array<Record<string, unknown>> = [];
  if (slicePayload.upperDataUrl && slicePayload.lowerDataUrl) {
    const up = parseDataUrl(slicePayload.upperDataUrl);
    const low = parseDataUrl(slicePayload.lowerDataUrl);
    parts.push({ inlineData: { mimeType: up.mimeType, data: up.base64Data } });
    parts.push({ inlineData: { mimeType: low.mimeType, data: low.base64Data } });
  } else {
    const full = parseDataUrl(slicePayload.fullDataUrl);
    parts.push({ inlineData: { mimeType: full.mimeType, data: full.base64Data } });
  }

  parts.push({
    text: `TARGETED RECOVERY on Page ${pageNumber}: Locate row numbers [ ${missingNos.join(', ')} ] in the printed No column and transcribe each.`,
  });

  const responseSchema = {
    type: 'OBJECT',
    properties: {
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
            qty: { type: 'NUMBER' },
          },
          required: ['no', 'part', 'desc', 'qty'],
        },
      },
    },
    required: ['items'],
  };

  try {
    const { parsed } = await callGeminiRestWithRetryAndFallback(
      apiKey,
      env,
      'You are a precision industrial docket row recovery engine.',
      parts,
      responseSchema,
      'recovery'
    );
    const rawItems: any[] = Array.isArray(parsed?.items) ? parsed.items : [];

    const items = rawItems.map((it: any) => ({
      partNumber: String(it.part || 'PART').trim().toUpperCase(),
      itemNumber: String(it.no || '').trim(),
      description: String(it.desc || it.part || '').trim(),
      revision: it.rev && String(it.rev).trim() ? String(it.rev).trim() : undefined,
      material: it.mat && String(it.mat).trim() ? String(it.mat).trim() : undefined,
      thickness: it.thk && String(it.thk).trim() ? String(it.thk).trim() : undefined,
      dimensions: it.dim && String(it.dim).trim() ? String(it.dim).trim() : undefined,
      weight: it.wt && String(it.wt).trim() ? String(it.wt).trim() : undefined,
      quantity: Math.max(1, Math.round(Number(it.qty) || 1)),
      palletNumber: 'Pallet 1',
      pageNumber: Number(pageNumber) || 1,
      confidence: 'high',
    }));

    return new Response(JSON.stringify({ items }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  } catch {
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    if (url.pathname === '/api/health') {
      if (env.DB) {
        const dbRes = await handlePalletTrackApiRequest(request, env.DB, env);
        if (dbRes) return dbRes;
      }
      return new Response(
        JSON.stringify({
          status: 'ok',
          app: 'PartTrack',
          tagline: 'Track every part. Every pallet. Every order.',
          runtime: 'cloudflare-worker',
          geminiConfigured: Boolean(env.GEMINI_API_KEY),
          d1Configured: Boolean(env.DB),
          timestamp: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        }
      );
    }

    // Handle WebSocket Upgrade on /api/realtime/ws (via Durable Object or Worker WebSocketPair)
    if (url.pathname === '/api/realtime/ws') {
      const upgradeHeader = request.headers.get('Upgrade') || request.headers.get('upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response(JSON.stringify({ error: 'Expected WebSocket Upgrade header' }), {
          status: 426,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
      if (!env.DB) {
        return new Response(JSON.stringify({ error: 'D1 database not bound' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }

      const token = extractSessionTokenFromRequest(request);
      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized: Missing session token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }

      const service = new PalletTrackDbService(env.DB);
      await service.ensureSchemaReady();
      const user = await service.validateSession(token);
      if (!user || !user.active) {
        return new Response(JSON.stringify({ error: 'Unauthorized: Invalid or expired session' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }

      // If Cloudflare Durable Object REALTIME_HUB is bound, delegate room coordination to the Durable Object
      if (env.REALTIME_HUB && typeof env.REALTIME_HUB.idFromName === 'function') {
        const doId = env.REALTIME_HUB.idFromName('global-pallettrack-hub');
        const stub = env.REALTIME_HUB.get(doId);
        const forwardedHeaders = new Headers(request.headers);
        forwardedHeaders.set('X-Authenticated-User', JSON.stringify(user));
        forwardedHeaders.set('X-Session-Token', token);
        return stub.fetch(new Request(request.url, { headers: forwardedHeaders }));
      }

      // Standard Cloudflare Worker WebSocketPair handling
      const WebSocketPairCtor = (globalThis as any).WebSocketPair;
      if (typeof WebSocketPairCtor === 'function') {
        const pair = new WebSocketPairCtor();
        const clientWs = pair[0];
        const serverWs = pair[1];
        serverWs.accept();

        const initialDeliveryId = url.searchParams.get('deliveryId') || null;
        const lastSeq = Math.max(0, Number(url.searchParams.get('lastSeq')) || 0);
        await realtimeBroker.getLatestSequenceNumber(env.DB);
        const connId = realtimeBroker.registerClient(
          serverWs,
          user,
          token,
          initialDeliveryId,
          lastSeq,
          env.DB
        );

        serverWs.addEventListener('message', (evt: any) => {
          const text = typeof evt.data === 'string' ? evt.data : String(evt.data || '');
          realtimeBroker.handleClientMessage(connId, text, env.DB).catch(() => {});
        });
        serverWs.addEventListener('close', () => {
          realtimeBroker.unregisterClient(connId);
        });
        serverWs.addEventListener('error', () => {
          realtimeBroker.unregisterClient(connId);
        });

        return new Response(null, { status: 101, webSocket: clientWs } as any);
      }
    }

    // Handle PalletTrack Centralised Database, Real-Time & Authentication API routes
    if (
      url.pathname.startsWith('/api/auth') ||
      url.pathname.startsWith('/api/deliveries') ||
      url.pathname.startsWith('/api/groups') ||
      url.pathname.startsWith('/api/users') ||
      url.pathname.startsWith('/api/realtime')
    ) {
      if (!env.DB) {
        return new Response(
          JSON.stringify({
            error:
              'Cloudflare D1 database is not bound to this Worker. Please ensure the DB binding is configured in wrangler.toml or the Cloudflare dashboard.',
            code: 'D1_NOT_BOUND',
          }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          }
        );
      }

      if (env.REALTIME_HUB && typeof env.REALTIME_HUB.idFromName === 'function') {
        realtimeBroker.setDurableObjectForwarder(async (event: RealtimeEvent) => {
          try {
            const doId = env.REALTIME_HUB!.idFromName('global-pallettrack-hub');
            const stub = env.REALTIME_HUB!.get(doId);
            await stub.fetch(
              new Request('https://internal.pallettrack/broadcast', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(event),
              })
            );
          } catch {
            // Ignore DO forwarding notice
          }
        });
      }

      const apiResponse = await handlePalletTrackApiRequest(request, env.DB, env);
      if (apiResponse) return apiResponse;
    }

    if (url.pathname === '/api/extract-docket' && request.method === 'POST') {
      try {
        return await handleExtractDocket(request, env);
      } catch (err: any) {
        const classification = classifyGeminiError(err);
        const errorMessage =
          classification.errorCode === 'MISSING_GEMINI_API_KEY'
            ? 'Gemini AI API key is not configured in the Cloudflare Worker. Please set the GEMINI_API_KEY secret.'
            : classification.errorCode === 'GEMINI_AUTH_ERROR'
            ? `Gemini API authentication or permission error (HTTP ${classification.statusCode}): Please verify your GEMINI_API_KEY secret.`
            : classification.errorCode === 'GEMINI_INVALID_MODEL'
            ? `Designated Gemini model is unavailable or unsupported (HTTP 404): ${classification.cleanMessage}`
            : classification.errorCode === 'GEMINI_QUOTA_EXHAUSTED'
            ? `Gemini API quota exceeded (HTTP 429): ${classification.cleanMessage}`
            : classification.errorCode === 'GEMINI_RATE_LIMIT_429'
            ? 'Gemini AI rate limit reached (HTTP 429). Your uploaded docket has been preserved — please wait a few seconds and click "Retry Extraction".'
            : classification.errorCode === 'GEMINI_TIMEOUT'
            ? `${classification.cleanMessage || 'Gemini AI request timed out (HTTP 504).'} Your uploaded docket has been preserved — please click "Retry Extraction".`
            : classification.errorCode === 'GEMINI_HIGH_DEMAND_503'
            ? 'Gemini AI is currently experiencing temporary high demand (HTTP 503). Your uploaded docket has been preserved — please click "Retry Extraction".'
            : classification.cleanMessage || 'Gemini AI invoice extraction failed.';

        return new Response(
          JSON.stringify({
            error: errorMessage,
            code: classification.errorCode,
            retryable: classification.isRetryableAvailabilityError || classification.isTimeout,
            diagnostics: err?.diagnostics,
          }),
          {
            status: classification.statusCode,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          }
        );
      }
    }

    if (url.pathname === '/api/recover-docket-items' && request.method === 'POST') {
      return handleRecoverDocketItems(request, env);
    }

    if (url.pathname === '/api/read-part-label' && request.method === 'POST') {
      const apiKey = (env.GEMINI_API_KEY || '').trim();
      if (!apiKey) {
        return new Response(
          JSON.stringify({
            error: 'GEMINI_API_KEY is not configured on the Worker.',
            code: 'MISSING_GEMINI_API_KEY',
          }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          }
        );
      }
      try {
        const body: any = await request.json().catch(() => ({}));
        const imageDataUrl =
          typeof body?.image === 'string' && body.image
            ? body.image
            : typeof body?.imageBase64 === 'string' && body.imageBase64
            ? `data:${body?.mimeType || 'image/jpeg'};base64,${body.imageBase64}`
            : body?.imageDataUrl;
        if (!imageDataUrl || typeof imageDataUrl !== 'string') {
          return new Response(JSON.stringify({ error: 'Missing imageDataUrl' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
        }
        const parsedImg = parseDataUrl(imageDataUrl);
        const partsList = Array.isArray(body?.knownParts)
          ? body.knownParts
          : Array.isArray(body?.docketParts)
          ? body.docketParts
          : [];
        const knownContext =
          partsList.length > 0
            ? `\nActive Docket Expected Parts:\n${partsList
                .slice(0, 120)
                .map((p: any) => `- Docket No: ${p.itemNumber || p.no || ''} | Part#: ${p.partNumber || ''} (${p.description || ''})`)
                .join('\n')}`
            : '';

        const schema = {
          type: 'OBJECT',
          properties: {
            detectedCode: { type: 'STRING' },
            partNumber: { type: 'STRING' },
            description: { type: 'STRING' },
            quantity: { type: 'NUMBER' },
            unit: { type: 'STRING' },
            rawText: { type: 'STRING' },
            confidence: { type: 'STRING' },
          },
          required: ['detectedCode', 'rawText', 'confidence'],
        };
        const { parsed, modelUsed, fallbackUsed } = await callGeminiRestWithRetryAndFallback(
          apiKey,
          env,
          'Read the barcode, part code, description, quantity, and literal text from the industrial part/pallet label image without fabricating values.',
          [
            { inlineData: { mimeType: parsedImg.mimeType, data: parsedImg.base64Data } },
            {
              text: `Examine this industrial part or pallet label photograph and transcribe the literal label details.${knownContext}\nExtract detectedCode, partNumber, description, quantity (numeric or 0), unit, rawText, confidence (high|medium|low).`,
            },
          ],
          schema,
          'label'
        );
        const detectedCode = String(parsed?.detectedCode || parsed?.partNumber || '').trim();
        const partNumber =
          parsed?.partNumber && String(parsed.partNumber).trim()
            ? String(parsed.partNumber).trim().toUpperCase()
            : detectedCode || null;
        const rawQty = Number(parsed?.quantity);
        const quantity =
          !Number.isNaN(rawQty) && rawQty > 0 && rawQty <= 99999 ? Math.round(rawQty) : null;
        return new Response(
          JSON.stringify({
            detectedCode,
            scannedCode: detectedCode,
            partNumber,
            description:
              parsed?.description && String(parsed.description).trim()
                ? String(parsed.description).trim()
                : null,
            quantity,
            unit:
              parsed?.unit && String(parsed.unit).trim()
                ? String(parsed.unit).trim().toUpperCase()
                : null,
            rawText: String(parsed?.rawText || '').trim(),
            confidence: String(parsed?.confidence || 'high').toLowerCase(),
            aiModelUsed: modelUsed,
            fallbackUsed,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          }
        );
      } catch (err: any) {
        const classification = classifyGeminiError(err);
        return new Response(
          JSON.stringify({
            error: classification.cleanMessage || 'Failed to read part label',
            code: classification.errorCode,
          }),
          {
            status: classification.statusCode,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          }
        );
      }
    }

    // Never allow unmatched /api/* routes to fall through to SPA index.html
    if (url.pathname.startsWith('/api/')) {
      return new Response(
        JSON.stringify({
          error: `API route not found: ${request.method} ${url.pathname}`,
          code: 'NOT_FOUND',
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        }
      );
    }

    // Serve frontend static assets through Cloudflare Worker with SPA fallback
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      const assetRes = await env.ASSETS.fetch(request);
      if (assetRes.status !== 404) {
        return assetRes;
      }
      const isStaticAssetPath =
        url.pathname.startsWith('/assets/') ||
        /\.(?:js|mjs|wasm|gz|css|map|png|jpg|jpeg|webp|svg|ico|woff2?)$/i.test(url.pathname);
      if (!isStaticAssetPath && (request.method === 'GET' || request.method === 'HEAD')) {
        const indexUrl = new URL('/', request.url);
        return env.ASSETS.fetch(new Request(indexUrl.toString(), request));
      }
      return assetRes;
    }

    return new Response(JSON.stringify({ error: `Not found: ${url.pathname}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  },
};

/**
 * Cloudflare Durable Object: PalletTrackRealtimeHub
 * Coordinates multi-user WebSocket rooms, presence, and instantaneous event fan-out
 * across Cloudflare edge isolates while D1 remains the authoritative state store.
 * Uses the native Durable Object Alarm API for scheduled heartbeat & stale connection pruning.
 */
export interface DurableObjectStorageLike {
  getAlarm?: () => Promise<number | null>;
  setAlarm?: (scheduledTime: number | Date) => Promise<void>;
  deleteAlarm?: () => Promise<void>;
}

export interface DurableObjectStateLike {
  storage?: DurableObjectStorageLike;
}

export class PalletTrackRealtimeHub {
  private broker: PalletTrackRealtimeBroker;
  private state: DurableObjectStateLike | null;
  private env: Env;

  constructor(state: DurableObjectStateLike, env: Env) {
    this.state = state || null;
    this.env = env;
    const hasNativeAlarm = typeof state?.storage?.setAlarm === 'function';
    this.broker = new PalletTrackRealtimeBroker({
      disableIntervalTimer: hasNativeAlarm,
    });
  }

  private async scheduleHeartbeatAlarmIfNeeded(): Promise<void> {
    const storage = this.state?.storage;
    if (!storage || typeof storage.setAlarm !== 'function') {
      this.broker.startHeartbeat();
      return;
    }

    if (this.broker.getConnectedClientCount() === 0) {
      if (typeof storage.deleteAlarm === 'function') {
        await storage.deleteAlarm().catch(() => {});
      }
      return;
    }

    try {
      const existingAlarm =
        typeof storage.getAlarm === 'function' ? await storage.getAlarm() : null;
      if (existingAlarm === null || existingAlarm === undefined || existingAlarm <= Date.now()) {
        await storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
      }
    } catch {
      this.broker.startHeartbeat();
    }
  }

  async alarm(): Promise<void> {
    this.broker.pruneStaleConnectionsAndPing();
    if (this.broker.getConnectedClientCount() > 0) {
      const storage = this.state?.storage;
      if (storage && typeof storage.setAlarm === 'function') {
        await storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS).catch(() => {});
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const event = (await request.json().catch(() => null)) as RealtimeEvent | null;
      if (event) {
        this.broker.broadcastEvent(event);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const upgradeHeader = request.headers.get('Upgrade') || request.headers.get('upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      const userJson = request.headers.get('X-Authenticated-User');
      const token = request.headers.get('X-Session-Token') || '';
      if (!userJson) {
        return new Response('Unauthorized', { status: 401 });
      }
      const user = JSON.parse(userJson);
      const WebSocketPairCtor = (globalThis as any).WebSocketPair;
      const pair = new WebSocketPairCtor();
      const clientWs = pair[0];
      const serverWs = pair[1];
      serverWs.accept();

      const initialDeliveryId = url.searchParams.get('deliveryId') || null;
      const lastSeq = Math.max(0, Number(url.searchParams.get('lastSeq')) || 0);
      const connId = this.broker.registerClient(
        serverWs,
        user,
        token,
        initialDeliveryId,
        lastSeq,
        this.env.DB
      );
      await this.scheduleHeartbeatAlarmIfNeeded();

      serverWs.addEventListener('message', (evt: any) => {
        const text = typeof evt.data === 'string' ? evt.data : String(evt.data || '');
        this.broker.handleClientMessage(connId, text, this.env.DB).catch(() => {});
      });
      serverWs.addEventListener('close', () => {
        this.broker.unregisterClient(connId);
        this.scheduleHeartbeatAlarmIfNeeded().catch(() => {});
      });
      serverWs.addEventListener('error', () => {
        this.broker.unregisterClient(connId);
        this.scheduleHeartbeatAlarmIfNeeded().catch(() => {});
      });

      return new Response(null, { status: 101, webSocket: clientWs } as any);
    }

    return new Response(JSON.stringify({ status: 'ok', hub: 'PalletTrackRealtimeHub' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}


