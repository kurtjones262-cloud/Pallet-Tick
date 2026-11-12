/**
 * Cloudflare Pages Function: POST /api/extract-docket
 *
 * Secure server-side Gemini AI invoice & docket extraction with:
 * - Automatic retry handling for HTTP 503, 429, and 5xx errors
 * - Exponential backoff with jitter starting at ~2s (max 3 retries)
 * - Configurable secondary Gemini model failover using identical instructions & schema
 * - Strict output validation before accepting results
 * - Safe operational logging without exposing API keys or document contents
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

const DEFAULT_PRIMARY_MODEL = 'gemini-3.8-flash';
const DEFAULT_FALLBACK_MODELS = [
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-flash-latest',
] as const;
const MAX_AUTOMATIC_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeExponentialBackoffWithJitter(retryAttempt: number, baseMs: number = INITIAL_BACKOFF_MS): number {
  const exp = Math.max(0, retryAttempt - 1);
  return Math.min(20000, baseMs * Math.pow(2, exp) + Math.floor(Math.random() * 650));
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
  const primaryModel =
    (typeof env?.GEMINI_PRIMARY_MODEL === 'string' && env.GEMINI_PRIMARY_MODEL.trim()) ||
    (typeof procEnv.GEMINI_PRIMARY_MODEL === 'string' && procEnv.GEMINI_PRIMARY_MODEL.trim()) ||
    DEFAULT_PRIMARY_MODEL;

  const rawFallbacks =
    (typeof env?.GEMINI_FALLBACK_MODEL === 'string' && env.GEMINI_FALLBACK_MODEL.trim()) ||
    (typeof env?.GEMINI_FALLBACK_MODELS === 'string' && env.GEMINI_FALLBACK_MODELS.trim()) ||
    (typeof procEnv.GEMINI_FALLBACK_MODEL === 'string' && procEnv.GEMINI_FALLBACK_MODEL.trim()) ||
    (typeof procEnv.GEMINI_FALLBACK_MODELS === 'string' && procEnv.GEMINI_FALLBACK_MODELS.trim()) ||
    DEFAULT_FALLBACK_MODELS.join(',');

  const fallbackModels = rawFallbacks
    .split(',')
    .map((m) => m.trim())
    .filter((m) => Boolean(m) && m !== primaryModel);

  return {
    primaryModel,
    fallbackModels: fallbackModels.length > 0 ? fallbackModels : [...DEFAULT_FALLBACK_MODELS],
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
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
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

async function callGeminiRestSingleAttempt(
  apiKey: string,
  model: string,
  systemInstruction: string,
  parts: Array<Record<string, unknown>>,
  responseSchema: Record<string, unknown>
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const requestBody = {
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    contents: [
      {
        parts,
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

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
    const { images, pageSlices } = body || {};

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
Transcribe EVERY physical part row literally visible across the document into the JSON 'items' array. Never invent, guess, or fabricate parts or quantities. If blank, return items: [].`;

    const promptText = `Examine ${pageDescriptions.join(' and ')} (${totalPages} total pages) and extract EVERY physical part row literally visible in the table.
Rules:
1. Extract every numbered part row from top to bottom.
2. For each row: record 'page', 'no' (exact printed row number), 'part' (part number or profile name), 'desc' (full description), 'rev' (revision if listed), 'mat' (material if listed), 'thk' (thickness if listed), 'dim' (dimensions if listed), 'wt' (weight if listed), and 'qty' (integer quantity).
3. Ignore header consignment barcodes and tax summary lines (Freight, GST, Total, Balance Due).`;

    parts.push({ text: promptText });

    const responseSchema = {
      type: 'OBJECT',
      properties: {
        docketNumber: { type: 'STRING' },
        supplier: { type: 'STRING' },
        deliveryDate: { type: 'STRING' },
        orderNumber: { type: 'STRING' },
        carrier: { type: 'STRING' },
        palletCount: { type: 'INTEGER' },
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

    const { primaryModel, fallbackModels } = resolveConfiguredModels(context.env);
    const candidateModels = [primaryModel, ...fallbackModels];

    let parsed: any = null;
    let lastError: any = null;
    let modelUsed: string = primaryModel;
    let fallbackUsed = false;
    let totalRetryAttempts = 0;

    for (let mIdx = 0; mIdx < candidateModels.length && !parsed; mIdx++) {
      const model = candidateModels[mIdx];
      const isFallback = mIdx > 0;
      const maxRetries = MAX_AUTOMATIC_RETRIES;

      logPagesOcrEvent('info', isFallback ? 'model_fallback_selected' : 'model_selected', {
        model,
        isFallback,
      });

      for (let retry = 0; retry <= maxRetries; retry++) {
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
          const status = Number(err?.status || 500);
          const msg = String(err?.message || '');
          const isRetryable =
            status === 503 ||
            status === 429 ||
            status >= 500 ||
            /503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded|Malformed|Incomplete OCR|Invalid OCR item/i.test(msg);

          logPagesOcrEvent('warn', 'extraction_attempt_failed', {
            model,
            isFallback,
            attempt: retry + 1,
            maxAttempts: maxRetries + 1,
            statusCode: status,
            isRetryable,
            reason: msg.slice(0, 220),
          });

          if (!isRetryable && (status === 400 || status === 401 || status === 403)) {
            throw err;
          }
          if (!isRetryable && status === 404) {
            break;
          }

          if (retry < maxRetries) {
            totalRetryAttempts++;
            const waitMs = computeExponentialBackoffWithJitter(retry + 1, INITIAL_BACKOFF_MS);
            logPagesOcrEvent('info', 'retrying_after_backoff', {
              model,
              retryAttempt: retry + 1,
              maxRetries,
              waitMs,
              statusCode: status,
            });
            await sleep(waitMs);
          }
        }
      }
    }

    if (!parsed) {
      throw lastError || new Error('Could not extract parts from docket images.');
    }

    const rawItems: any[] = Array.isArray(parsed.items) ? parsed.items : [];

    const items = rawItems.map((it: any, idx: number) => {
      const cleanNo = parseCleanRowNo(it.no) || String(idx + 1);
      const rawQty = Number(it.qty);
      const qty = !Number.isNaN(rawQty) && rawQty >= 1 ? Math.round(rawQty) : 1;
      const partNumber = String(it.part || it.desc?.slice(0, 24) || 'PART').trim().toUpperCase();
      const description = String(it.desc || it.part || '').trim();
      const revision = it.rev && String(it.rev).trim() ? String(it.rev).trim() : undefined;
      const material = it.mat && String(it.mat).trim() ? String(it.mat).trim() : undefined;
      const thickness = it.thk && String(it.thk).trim() ? String(it.thk).trim() : undefined;

      return {
        partNumber,
        itemNumber: cleanNo,
        description,
        revision,
        material,
        thickness,
        dimensions: it.dim && String(it.dim).trim() ? String(it.dim).trim() : undefined,
        weight: it.wt && String(it.wt).trim() ? String(it.wt).trim() : undefined,
        quantity: qty,
        palletNumber: 'Pallet 1',
        pageNumber: Number(it.page) || 1,
        confidence: 'high',
        originalOcrValues: {
          partNumber,
          itemNumber: cleanNo,
          description,
          revision,
          quantity: qty,
          material,
          thickness,
        },
      };
    });

    const responsePayload = {
      docketNumber: String(parsed.docketNumber || `DK-${Math.floor(10000 + Math.random() * 90000)}`).trim(),
      supplier: String(parsed.supplier || 'Steel Fabrication Supplier').trim(),
      deliveryDate: String(parsed.deliveryDate || new Date().toISOString().slice(0, 10)).trim(),
      carrier: parsed.carrier ? String(parsed.carrier).trim() : undefined,
      orderNumber: parsed.orderNumber ? String(parsed.orderNumber).trim() : undefined,
      palletCount: Math.max(1, Number(parsed.palletCount) || 1),
      items,
      confidenceScore: items.length > 0 ? 100 : 0,
      needsManualReview: items.length === 0,
      extractionMethod: 'ai-vision',
      aiModelUsed: modelUsed,
      fallbackUsed,
      retryAttempts: totalRetryAttempts,
      pagesScanned: totalPages,
    };

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (err: any) {
    const rawMsg = err?.message || String(err || '');
    const isMissingKey = rawMsg.includes('GEMINI_API_KEY') || rawMsg.includes('API key');
    const isHighDemand = /503|UNAVAILABLE|high demand|overloaded/i.test(rawMsg);
    const isRateLimit = /429|RESOURCE_EXHAUSTED|rate limit/i.test(rawMsg);
    return new Response(
      JSON.stringify({
        error: isMissingKey
          ? 'Gemini AI API key is not configured in Cloudflare Pages. Please set the GEMINI_API_KEY environment variable in your Cloudflare Pages dashboard.'
          : isHighDemand
          ? 'Gemini AI is currently experiencing high demand (HTTP 503) after automatic retries and model fallback. Your uploaded docket has been preserved — please click "Retry Extraction".'
          : rawMsg || 'Gemini AI invoice extraction failed.',
        code: isMissingKey
          ? 'MISSING_GEMINI_API_KEY'
          : isHighDemand
          ? 'GEMINI_HIGH_DEMAND_503'
          : isRateLimit
          ? 'GEMINI_RATE_LIMIT_429'
          : 'AI_EXTRACTION_FAILED',
      }),
      {
        status: isMissingKey || isHighDemand ? 503 : isRateLimit ? 429 : 500,
        headers: corsHeaders,
      }
    );
  }
};
