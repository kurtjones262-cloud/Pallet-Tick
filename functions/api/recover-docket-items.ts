/**
 * Cloudflare Pages Function: POST /api/recover-docket-items
 *
 * Targeted row recovery helper using Gemini 4 Hydrogen primary and Gemini 3.1 Flash Lite fallback.
 */

interface CloudflareEnv {
  GEMINI_API_KEY?: string;
  GEMINI_PRIMARY_MODEL?: string;
  GEMINI_FALLBACK_MODEL?: string;
  [key: string]: unknown;
}

interface EventContext {
  request: Request;
  env: CloudflareEnv;
}

const DEFAULT_PRIMARY_MODEL = 'gemini-4-hydrogen';
const DEFAULT_FALLBACK_MODEL = 'gemini-3.1-flash-lite';
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
      text: `TARGETED RECOVERY on Page ${pageNumber}: Locate ONLY row numbers [ ${missingNos.join(', ')} ] in the printed No column and transcribe each literally without fabricating missing values.`,
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

    const models = [DEFAULT_PRIMARY_MODEL, DEFAULT_FALLBACK_MODEL];
    let parsed: any = null;

    for (const model of models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const generationConfig: Record<string, unknown> = {
        responseMimeType: 'application/json',
        responseSchema,
      };
      if (model.includes('gemini-4-hydrogen')) {
        generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GEMINI_REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text: 'You are a precision industrial docket row recovery engine. Locate the exact requested row numbers and transcribe them literally without fabricating parts or quantities.',
                },
              ],
            },
            contents: [{ parts }],
            generationConfig,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          if (res.status === 401 || res.status === 403 || res.status === 400) break;
          continue;
        }

        const resJson: any = await res.json();
        const rawText = resJson?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawText) {
          parsed = JSON.parse(rawText);
          if (Array.isArray(parsed?.items)) break;
        }
      } catch {
        continue;
      } finally {
        clearTimeout(timer);
      }
    }

    const rawItems: any[] = Array.isArray(parsed?.items) ? parsed.items : [];
    const items = rawItems.map((it: any) => {
      const partNumber = String(it.part || 'PART').trim().toUpperCase();
      const revision = it.rev && String(it.rev).trim() ? String(it.rev).trim().toUpperCase() : undefined;
      const warnings = Array.isArray(it.validationWarnings)
        ? it.validationWarnings.map((w: any) => String(w || '').trim()).filter(Boolean)
        : [];
      const conf = String(it.confidence || '').toLowerCase() === 'low' || warnings.length > 0 ? 'low' : 'high';
      return {
        partNumber,
        itemNumber: String(it.no || '').trim(),
        description: String(it.desc || it.part || '').trim(),
        revision,
        rev: revision,
        material: it.mat && String(it.mat).trim() ? String(it.mat).trim() : undefined,
        thickness: it.thk && String(it.thk).trim() ? String(it.thk).trim() : undefined,
        dimensions: it.dim && String(it.dim).trim() ? String(it.dim).trim() : undefined,
        weight: it.wt && String(it.wt).trim() ? String(it.wt).trim() : undefined,
        unit: it.unit && String(it.unit).trim() ? String(it.unit).trim().toUpperCase() : undefined,
        quantity: Math.max(1, Math.round(Number(it.qty) || 1)),
        palletNumber: 'Pallet 1',
        pageNumber: Number(pageNumber) || 1,
        originalText: it.originalText && String(it.originalText).trim() ? String(it.originalText).trim() : undefined,
        confidence: conf,
        notes: warnings.length > 0 ? warnings.join('; ') : undefined,
        validationWarnings: warnings.length > 0 ? warnings : undefined,
      };
    });

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
