interface CloudflareEnv {
  GEMINI_API_KEY?: string;
  [key: string]: unknown;
}

interface EventContext {
  request: Request;
  env: CloudflareEnv;
}

export const onRequestGet = async (context: EventContext): Promise<Response> => {
  const apiKey =
    (typeof context.env?.GEMINI_API_KEY === 'string' && context.env.GEMINI_API_KEY.trim()) ||
    (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) ||
    '';

  return new Response(
    JSON.stringify({
      status: 'ok',
      app: 'PartTrack',
      runtime: 'cloudflare-pages',
      geminiConfigured: Boolean(apiKey),
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    }
  );
};
