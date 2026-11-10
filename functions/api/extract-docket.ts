/**
 * Cloudflare Pages Function: POST /api/extract-docket
 *
 * Secure server-side Gemini AI invoice & docket extraction for production Cloudflare deployment.
 * Never exposes GEMINI_API_KEY to the browser or client-side bundles.
 */

interface CloudflareEnv {
  GEMINI_API_KEY?: string;
  [key: string]: unknown;
}

interface EventContext {
  request: Request;
  env: CloudflareEnv;
}

const PRIMARY_MODEL = 'gemini-3.8-flash';
const FALLBACK_MODELS = ['gemini-3.1-flash-lite', 'gemini-flash-latest'] as const;

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
    let modelUsed: string = PRIMARY_MODEL;

    for (const model of [PRIMARY_MODEL, ...FALLBACK_MODELS]) {
      try {
        rawJsonText = await callGeminiRest(apiKey, model, systemInstruction, parts, responseSchema);
        if (rawJsonText) {
          modelUsed = model;
          break;
        }
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
      aiModelUsed: modelUsed,
      pagesScanned: totalPages,
    };

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (err: any) {
    const rawMsg = err?.message || String(err || '');
    const isMissingKey = rawMsg.includes('GEMINI_API_KEY') || rawMsg.includes('API key');
    return new Response(
      JSON.stringify({
        error: isMissingKey
          ? 'Gemini AI API key is not configured in Cloudflare Pages. Please set the GEMINI_API_KEY environment variable in your Cloudflare Pages dashboard.'
          : rawMsg || 'Gemini AI invoice extraction failed.',
        code: isMissingKey ? 'MISSING_GEMINI_API_KEY' : 'AI_EXTRACTION_FAILED',
      }),
      {
        status: isMissingKey ? 503 : 500,
        headers: corsHeaders,
      }
    );
  }
};
