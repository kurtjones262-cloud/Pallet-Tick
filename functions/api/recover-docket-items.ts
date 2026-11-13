/**
 * Cloudflare Pages Function: POST /api/recover-docket-items
 *
 * Dedicated targeted row recovery helper for Cloudflare Pages deployment.
 */

interface CloudflareEnv {
  GEMINI_API_KEY?: string;
  [key: string]: unknown;
}

interface EventContext {
  request: Request;
  env: CloudflareEnv;
}

const PRIMARY_MODEL = 'gemini-4-hydrogen';
const GEMINI_REQUEST_TIMEOUT_MS = 22000;

function parseDataUrl(dataUrl: string): { mimeType: string; base64Data: string } {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  return {
    mimeType: match ? match[1] : 'image/jpeg',
    base64Data: match ? match[2] : dataUrl.replace(/^data:image\/\w+;base64,/, ''),
  };
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

    const body: any = await context.request.json().catch(() => ({}));
    const { slicePayload, pageNumber, missingNos } = body || {};

    if (!apiKey || !slicePayload || !Array.isArray(missingNos) || missingNos.length === 0) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: corsHeaders,
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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${PRIMARY_MODEL}:generateContent?key=${apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema,
            thinkingConfig: { thinkingLevel: 'LOW' },
          },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: corsHeaders,
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
      headers: corsHeaders,
    });
  } catch {
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: corsHeaders,
    });
  }
};
