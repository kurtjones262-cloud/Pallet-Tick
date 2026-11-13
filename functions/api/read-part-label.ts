/**
 * Cloudflare Pages Function: POST /api/read-part-label
 *
 * Gemini-first pallet/part label vision extraction using gemini-4-hydrogen primary
 * and gemini-3.1-flash-lite fallback.
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
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const LABEL_TIMEOUT_MS = 15000;

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

    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: 'GEMINI_API_KEY is not configured in Cloudflare Pages.',
          code: 'MISSING_GEMINI_API_KEY',
        }),
        { status: 503, headers: corsHeaders }
      );
    }

    const body: any = await context.request.json().catch(() => ({}));
    const { imageDataUrl, knownParts } = body || {};

    if (!imageDataUrl || typeof imageDataUrl !== 'string') {
      return new Response(JSON.stringify({ error: 'imageDataUrl is required.' }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const { mimeType, base64Data } = parseDataUrl(imageDataUrl);
    const knownContext =
      Array.isArray(knownParts) && knownParts.length > 0
        ? `\nExpected Parts Context:\n${knownParts
            .slice(0, 120)
            .map((p: any) => `- Docket No: ${p.itemNumber || ''} | Part#: ${p.partNumber || ''} (${p.description || ''})`)
            .join('\n')}`
        : '';

    const promptText = `Examine this industrial part or pallet label photograph and transcribe the literal label details.${knownContext}
Rules:
1. Preserve printed Part Numbers, barcode values, or QR text literally as printed without guessing blurred digits.
2. Extract:
   - detectedCode: primary barcode, QR, or Part Number
   - partNumber: printed Part Number / Drawing No ("" if none visible)
   - description: description line if printed ("" otherwise)
   - quantity: numeric pallet/label quantity if printed (0 if not explicitly printed)
   - unit: unit like EA, PCS, SET if shown
   - rawText: literal multi-line text visible on the label
   - confidence: "high", "medium", or "low"`;

    const responseSchema = {
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

    const models = [PRIMARY_MODEL, FALLBACK_MODEL];
    let parsed: any = null;
    let modelUsed = PRIMARY_MODEL;
    let lastStatus = 500;
    let lastErrMsg = 'Gemini label recognition failed.';

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
      const timer = setTimeout(() => controller.abort(), LABEL_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text: 'Read the barcode, part code, description, quantity, and literal text from the industrial part/pallet label image without fabricating values.',
                },
              ],
            },
            contents: [
              {
                parts: [
                  { inlineData: { mimeType, data: base64Data } },
                  { text: promptText },
                ],
              },
            ],
            generationConfig,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          lastStatus = res.status;
          lastErrMsg = (await res.text()).slice(0, 220);
          if (res.status === 401 || res.status === 403 || res.status === 400) break;
          continue;
        }

        const resJson: any = await res.json();
        const rawText = resJson?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawText) {
          parsed = JSON.parse(rawText);
          modelUsed = model;
          break;
        }
      } catch (err: any) {
        if (controller.signal.aborted || err?.name === 'AbortError') {
          lastStatus = 504;
          lastErrMsg = `Label OCR request timed out after ${Math.round(LABEL_TIMEOUT_MS / 1000)}s.`;
        } else {
          lastErrMsg = err?.message || String(err);
        }
      } finally {
        clearTimeout(timer);
      }
    }

    if (!parsed) {
      return new Response(
        JSON.stringify({
          error: lastErrMsg,
          code:
            lastStatus === 401 || lastStatus === 403
              ? 'GEMINI_AUTH_ERROR'
              : lastStatus === 504
              ? 'GEMINI_TIMEOUT'
              : lastStatus === 429
              ? 'GEMINI_RATE_LIMIT_429'
              : lastStatus === 503
              ? 'GEMINI_HIGH_DEMAND_503'
              : 'AI_EXTRACTION_FAILED',
        }),
        { status: lastStatus, headers: corsHeaders }
      );
    }

    const detectedCode = String(parsed.detectedCode || parsed.partNumber || '').trim();
    const partNumber =
      parsed.partNumber && String(parsed.partNumber).trim()
        ? String(parsed.partNumber).trim().toUpperCase()
        : detectedCode || null;
    const rawQty = Number(parsed.quantity);
    const quantity = !Number.isNaN(rawQty) && rawQty > 0 && rawQty <= 99999 ? Math.round(rawQty) : null;

    return new Response(
      JSON.stringify({
        detectedCode,
        scannedCode: detectedCode,
        partNumber,
        description:
          parsed.description && String(parsed.description).trim()
            ? String(parsed.description).trim()
            : null,
        quantity,
        unit:
          parsed.unit && String(parsed.unit).trim()
            ? String(parsed.unit).trim().toUpperCase()
            : null,
        rawText: String(parsed.rawText || '').trim(),
        confidence: String(parsed.confidence || 'high').toLowerCase(),
        aiModelUsed: modelUsed,
        fallbackUsed: modelUsed !== PRIMARY_MODEL,
      }),
      { status: 200, headers: corsHeaders }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || 'Part label recognition failed.', code: 'AI_EXTRACTION_FAILED' }),
      { status: 500, headers: corsHeaders }
    );
  }
};
