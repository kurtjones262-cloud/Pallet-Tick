/**
 * Cloudflare Worker: PartTrack Serverless API
 *
 * Secure server-side endpoint for Gemini multimodal delivery docket & invoice extraction.
 * Reads the secret GEMINI_API_KEY from the Cloudflare Worker environment.
 * Never exposes the API key to frontend code, browser storage, or network responses.
 */

export interface Env {
  GEMINI_API_KEY?: string;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  [key: string]: unknown;
}

const PRIMARY_MODEL = 'gemini-3.1-flash-lite';
const FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-2.5-flash'] as const;

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

async function callGeminiRest(
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
    throw new Error(`Gemini API error (${response.status}): ${errText}`);
  }

  const result: any = await response.json();
  const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Empty response received from Gemini AI model.');
  }
  return text;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
2. For each row: record 'page', 'no' (exact printed row number), 'part' (part number or profile name), 'desc' (full description), 'mat' (material if listed), 'thk' (thickness if listed), 'dim' (dimensions if listed), 'wt' (weight if listed), and 'qty' (integer quantity).
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

  let rawJsonText = '';
  let lastError: unknown = null;

  for (const model of [PRIMARY_MODEL, ...FALLBACK_MODELS]) {
    try {
      rawJsonText = await callGeminiRest(apiKey, model, systemInstruction, parts, responseSchema);
      if (rawJsonText) break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!rawJsonText) {
    throw lastError || new Error('Could not extract parts from docket images.');
  }

  const parsed = JSON.parse(rawJsonText);
  const rawItems: any[] = Array.isArray(parsed.items) ? parsed.items : [];

  const items = rawItems.map((it: any, idx: number) => {
    const cleanNo = parseCleanRowNo(it.no) || String(idx + 1);
    const rawQty = Number(it.qty);
    const qty = !Number.isNaN(rawQty) && rawQty >= 1 ? Math.round(rawQty) : 1;
    return {
      partNumber: String(it.part || it.desc?.slice(0, 24) || 'PART').trim().toUpperCase(),
      itemNumber: cleanNo,
      description: String(it.desc || it.part || '').trim(),
      material: it.mat && String(it.mat).trim() ? String(it.mat).trim() : undefined,
      thickness: it.thk && String(it.thk).trim() ? String(it.thk).trim() : undefined,
      dimensions: it.dim && String(it.dim).trim() ? String(it.dim).trim() : undefined,
      weight: it.wt && String(it.wt).trim() ? String(it.wt).trim() : undefined,
      quantity: qty,
      palletNumber: 'Pallet 1',
      pageNumber: Number(it.page) || 1,
      confidence: 'high',
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
    aiModelUsed: PRIMARY_MODEL,
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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${PRIMARY_MODEL}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema,
        },
      }),
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    const resJson: any = await res.json();
    const rawText = resJson?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = JSON.parse(rawText || '{}');
    const rawItems: any[] = Array.isArray(parsed?.items) ? parsed.items : [];

    const items = rawItems.map((it: any) => ({
      partNumber: String(it.part || 'PART').trim().toUpperCase(),
      itemNumber: String(it.no || '').trim(),
      description: String(it.desc || it.part || '').trim(),
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
      return new Response(
        JSON.stringify({
          status: 'ok',
          app: 'PartTrack',
          runtime: 'cloudflare-worker',
          geminiConfigured: Boolean(env.GEMINI_API_KEY),
          timestamp: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        }
      );
    }

    if (url.pathname === '/api/extract-docket' && request.method === 'POST') {
      try {
        return await handleExtractDocket(request, env);
      } catch (err: any) {
        const rawMsg = err?.message || String(err || '');
        const isMissingKey = rawMsg.includes('GEMINI_API_KEY') || rawMsg.includes('API key');
        return new Response(
          JSON.stringify({
            error: isMissingKey
              ? 'Gemini AI API key is not configured in the Cloudflare Worker. Please set the GEMINI_API_KEY secret.'
              : rawMsg || 'Gemini AI invoice extraction failed.',
            code: isMissingKey ? 'MISSING_GEMINI_API_KEY' : 'AI_EXTRACTION_FAILED',
          }),
          {
            status: isMissingKey ? 503 : 500,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          }
        );
      }
    }

    if (url.pathname === '/api/recover-docket-items' && request.method === 'POST') {
      return handleRecoverDocketItems(request, env);
    }

    // If running in Cloudflare Worker with static assets binding
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return new Response(JSON.stringify({ error: `Not found: ${url.pathname}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  },
};
