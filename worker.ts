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

function logWorkerOcrEvent(level: 'info' | 'warn' | 'error', event: string, meta: Record<string, unknown> = {}) {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (/key|token|secret|image|base64|dataurl|text/i.test(k)) continue;
    safe[k] = typeof v === 'string' ? v.replace(/key=[A-Za-z0-9_\-]+/gi, 'key=[REDACTED]').slice(0, 300) : v;
  }
  const msg = JSON.stringify({ timestamp: new Date().toISOString(), component: 'PartTrack-Worker-OCR', event, ...safe });
  if (level === 'error') console.error(msg);
  else if (level === 'warn') console.warn(msg);
  else console.log(msg);
}

function resolveWorkerModels(env: Env): { primaryModel: string; fallbackModels: string[] } {
  const primaryModel =
    (typeof env.GEMINI_PRIMARY_MODEL === 'string' && env.GEMINI_PRIMARY_MODEL.trim()) ||
    DEFAULT_PRIMARY_MODEL;
  const rawFallbacks =
    (typeof env.GEMINI_FALLBACK_MODEL === 'string' && env.GEMINI_FALLBACK_MODEL.trim()) ||
    (typeof env.GEMINI_FALLBACK_MODELS === 'string' && env.GEMINI_FALLBACK_MODELS.trim()) ||
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
  if (!trimmed) {
    throw new Error('Malformed OCR response: empty body.');
  }
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
    if (!it || typeof it !== 'object') {
      throw new Error(`Malformed OCR item at index ${i}.`);
    }
    const hasPartOrDesc =
      (typeof it.part === 'string' && it.part.trim().length > 0) ||
      (typeof it.desc === 'string' && it.desc.trim().length > 0);
    if (!hasPartOrDesc) {
      throw new Error(`Incomplete OCR item at index ${i}: missing part and description.`);
    }
    const q = Number(it.qty);
    if (Number.isNaN(q) || q < 0) {
      throw new Error(`Invalid OCR item quantity at index ${i}.`);
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

async function callGeminiRestWithRetryAndFallback(
  apiKey: string,
  env: Env,
  systemInstruction: string,
  parts: Array<Record<string, unknown>>,
  responseSchema: Record<string, unknown>
): Promise<{ parsed: any; modelUsed: string; fallbackUsed: boolean; retryAttempts: number }> {
  const { primaryModel, fallbackModels } = resolveWorkerModels(env);
  const candidateModels = [primaryModel, ...fallbackModels];

  let totalRetryAttempts = 0;
  let lastError: any = null;

  for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
    const model = candidateModels[mIdx];
    const isFallback = mIdx > 0;
    const maxRetries = MAX_AUTOMATIC_RETRIES;

    logWorkerOcrEvent('info', isFallback ? 'model_fallback_selected' : 'model_selected', {
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
        const parsed = validateOcrPayload(rawJsonText);
        logWorkerOcrEvent('info', 'extraction_succeeded', {
          model,
          isFallback,
          retryAttempts: totalRetryAttempts,
          statusCode: 200,
          itemsExtracted: parsed.items.length,
        });
        return {
          parsed,
          modelUsed: model,
          fallbackUsed: isFallback,
          retryAttempts: totalRetryAttempts,
        };
      } catch (err: any) {
        lastError = err;
        const status = Number(err?.status || 500);
        const msg = String(err?.message || '');
        const isModelDailyQuotaExhausted =
          status === 429 &&
          /GenerateRequestsPerDayPerProjectPerModel|free_tier_requests|requests per day limit exceeded|limit:\s*0\b|Please retry in \d+h/i.test(
            msg
          );
        const isRetryable =
          status === 503 ||
          status === 429 ||
          status >= 500 ||
          /503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded|Malformed|Incomplete OCR|Invalid OCR item/i.test(msg);

        logWorkerOcrEvent('warn', 'extraction_attempt_failed', {
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
        if (
          (!isRetryable && status === 404) ||
          (isModelDailyQuotaExhausted && mIdx < candidateModels.length - 1)
        ) {
          break;
        }

        if (retry < maxRetries) {
          totalRetryAttempts++;
          const waitMs = computeExponentialBackoffWithJitter(retry + 1, INITIAL_BACKOFF_MS);
          logWorkerOcrEvent('info', 'retrying_after_backoff', {
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

  logWorkerOcrEvent('error', 'all_models_and_retries_exhausted', {
    primaryModel,
    fallbackModels: fallbackModels.join(','),
    totalRetryAttempts,
    error: String(lastError?.message || 'Unknown error').slice(0, 220),
  });

  throw lastError || new Error('Gemini AI could not process the docket after automatic retries and model fallback.');
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
  const { images, pageSlices } = body || {};

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

  const { parsed, modelUsed, fallbackUsed, retryAttempts } = await callGeminiRestWithRetryAndFallback(
    apiKey,
    env,
    systemInstruction,
    parts,
    responseSchema
  );

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
    retryAttempts,
    pagesScanned: totalPages,
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
      responseSchema
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
        const rawMsg = err?.message || String(err || '');
        const isMissingKey = rawMsg.includes('GEMINI_API_KEY') || rawMsg.includes('API key');
        const isHighDemand = /503|UNAVAILABLE|high demand|overloaded/i.test(rawMsg);
        const isRateLimit = /429|RESOURCE_EXHAUSTED|rate limit/i.test(rawMsg);
        return new Response(
          JSON.stringify({
            error: isMissingKey
              ? 'Gemini AI API key is not configured in the Cloudflare Worker. Please set the GEMINI_API_KEY secret.'
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
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          }
        );
      }
    }

    if (url.pathname === '/api/recover-docket-items' && request.method === 'POST') {
      return handleRecoverDocketItems(request, env);
    }

    // Serve frontend static assets through Cloudflare Worker with SPA fallback
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      const assetRes = await env.ASSETS.fetch(request);
      if (assetRes.status !== 404) {
        return assetRes;
      }
      const isStaticAssetPath =
        url.pathname.startsWith('/tesseract/') ||
        url.pathname.startsWith('/assets/') ||
        /\.(?:js|mjs|wasm|gz|traineddata|css|map|png|jpg|jpeg|webp|svg|ico|woff2?)$/i.test(url.pathname);
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


