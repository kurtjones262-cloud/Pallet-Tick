import express, { type Request as ExpressRequest, type Response as ExpressResponse } from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  extractDocketWithGeminiVision,
  extractPartCodeWithGeminiVision,
  recoverMissingDocketItems,
} from './src/server/docketOcr.ts';

dotenv.config({ quiet: true });

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Support high-resolution delivery docket photo uploads up to 35MB
app.use(express.json({ limit: '35mb' }));

// Allow camera, microphone, and device access in iframes and CORS for standalone mobile APK
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=*, microphone=*, geolocation=*');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Serve public directory static assets (icons, manifest, PDF.js worker)
app.use(express.static(path.resolve(__dirname, 'public')));


import { getLocalDevDatabase } from './src/server/db/nodeSqliteAdapter.ts';
import {
  handlePalletTrackApiRequest,
  extractSessionTokenFromRequest,
} from './src/server/api/palletTrackApiRouter.ts';
import { PalletTrackDbService } from './src/server/api/palletTrackDbService.ts';
import { realtimeBroker } from './src/server/realtime/realtimeHub.ts';

const localDb = getLocalDevDatabase();

// Mount PalletTrack Centralised Database API routes
app.use(async (req, res, next) => {
  if (
    req.path.startsWith('/api/deliveries') ||
    req.path.startsWith('/api/groups') ||
    req.path.startsWith('/api/users') ||
    req.path.startsWith('/api/auth') ||
    req.path.startsWith('/api/realtime') ||
    req.path === '/api/health'
  ) {
    try {
      const url = `${req.protocol}://${req.get('host') || 'localhost:3000'}${req.originalUrl}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) v.forEach((val) => headers.append(k, val));
      }

      const body =
        req.method !== 'GET' && req.method !== 'HEAD' && req.body
          ? JSON.stringify(req.body)
          : undefined;

      const webReq = new Request(url, {
        method: req.method,
        headers,
        body,
      });

      const webRes = await handlePalletTrackApiRequest(webReq, localDb, process.env as any);
      if (webRes) {
        res.status(webRes.status);
        webRes.headers.forEach((val, key) => {
          res.setHeader(key, val);
        });
        const responseText = await webRes.text();
        return res.send(responseText);
      }
    } catch (err: any) {
      console.error('API router error in server.ts:', err);
      return res.status(500).json({ error: err?.message || 'Server database error' });
    }
  }
  next();
});


/**
 * GET /api/export-project-zip
 * Bundles the application project source code and assets into a .zip file
 */
app.get('/api/export-project-zip', async (_req: ExpressRequest, res: ExpressResponse) => {
  try {
    const JSZipModule = (await import('jszip')).default;
    const fs = await import('fs');
    const zip = new JSZipModule();
    const rootDir = process.cwd();

    const ignoredNames = new Set([
      'node_modules',
      'dist',
      'build',
      'server.js',
      '.data',
      '.git',
      '.tempmediaStorage',
      '.aistudio',
      '.DS_Store',
    ]);

    function addDirectory(currentPath: string, zipFolder: any) {
      const items = fs.readdirSync(currentPath, { withFileTypes: true });
      for (const item of items) {
        if (ignoredNames.has(item.name)) continue;
        const itemFullPath = path.join(currentPath, item.name);
        if (item.isDirectory()) {
          const sub = zipFolder.folder(item.name);
          if (sub) addDirectory(itemFullPath, sub);
        } else if (item.isFile()) {
          // Avoid bundling oversized binary assets into the source zip
          const stat = fs.statSync(itemFullPath);
          if (stat.size < 10 * 1024 * 1024) {
            const fileContent = fs.readFileSync(itemFullPath);
            zipFolder.file(item.name, fileContent);
          }
        }
      }
    }

    addDirectory(rootDir, zip);

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="parttrack-app-source.zip"');
    res.send(zipBuffer);
  } catch (err: any) {
    console.error('Error generating project zip:', err);
    res.status(500).json({ error: 'Failed to generate project zip', details: err?.message });
  }
});

/**
 * POST /api/extract-docket
 * Uses Gemini Flash multimodal structured extraction when online to identify
 * ONLY each individual part on the delivery docket and all of its details.
 */
app.post('/api/extract-docket', async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const { images, startItemIndex, pageSlices, supplierHint } = req.body || {};
    if (
      (!Array.isArray(images) || images.length === 0) &&
      (!Array.isArray(pageSlices) || pageSlices.length === 0)
    ) {
      return res.status(400).json({ error: 'No docket images provided.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        error:
          'Gemini AI API key is not configured on the server. Please set GEMINI_API_KEY in your server environment settings or Cloudflare Pages project secrets.',
        code: 'MISSING_GEMINI_API_KEY',
      });
    }

    const startIdx =
      typeof startItemIndex === 'number' && startItemIndex > 0 ? startItemIndex : 1;
    const result = await extractDocketWithGeminiVision(
      Array.isArray(images) ? images : [],
      startIdx,
      Array.isArray(pageSlices) ? pageSlices : undefined,
      undefined,
      typeof supplierHint === 'string' ? supplierHint : undefined
    );
    return res.status(200).json(result);
  } catch (err: any) {
    const { classifyGeminiError } = await import('./src/server/docketOcr.ts');
    const classification = classifyGeminiError(err);
    console.error(
      `Gemini AI docket extraction error [${classification.errorCode} / HTTP ${classification.statusCode}]:`,
      classification.cleanMessage
    );

    const errorMessage =
      classification.errorCode === 'MISSING_GEMINI_API_KEY'
        ? 'Gemini AI API key is not configured on the server. Please set GEMINI_API_KEY in your server environment settings.'
        : classification.errorCode === 'GEMINI_AUTH_ERROR'
        ? `Gemini API authentication or permission error (HTTP ${classification.statusCode}): ${classification.cleanMessage}`
        : classification.errorCode === 'GEMINI_INVALID_MODEL'
        ? `Designated Gemini model is unavailable or invalid (HTTP 404): ${classification.cleanMessage}`
        : classification.errorCode === 'GEMINI_QUOTA_EXHAUSTED'
        ? `Gemini API quota exceeded (HTTP 429): ${classification.cleanMessage}`
        : classification.cleanMessage || 'Gemini AI docket extraction failed.';

    return res.status(classification.statusCode).json({
      error: errorMessage,
      code: classification.errorCode,
      retryable: classification.isRetryableAvailabilityError || classification.isTimeout,
      diagnostics: err?.diagnostics,
    });
  }
});

/**
 * POST /api/recover-docket-items
 * Targeted recovery pass for any missing "No" numbers across page boundaries (e.g. 1..199).
 */
app.post('/api/recover-docket-items', async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const { slicePayload, pageNumber, missingNos } = req.body || {};
    if (!slicePayload || !Array.isArray(missingNos) || missingNos.length === 0) {
      return res.status(200).json({ items: [] });
    }
    const items = await recoverMissingDocketItems(
      slicePayload,
      Number(pageNumber) || 1,
      missingNos
    );
    return res.status(200).json({ items });
  } catch (err: any) {
    console.warn('Targeted row recovery warning:', err?.message || err);
    return res.status(200).json({ items: [] });
  }
});

/**
 * POST /api/read-part-label
 * Reads a single part barcode/QR/tag image with Gemini AI Vision when optical barcode decoding struggles.
 */
app.post('/api/read-part-label', async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const { imageDataUrl, image, imageBase64, mimeType, knownParts, docketParts } = req.body || {};
    const resolvedImage =
      typeof imageDataUrl === 'string' && imageDataUrl
        ? imageDataUrl
        : typeof image === 'string' && image
        ? image
        : typeof imageBase64 === 'string' && imageBase64
        ? `data:${mimeType || 'image/jpeg'};base64,${imageBase64}`
        : '';
    if (!resolvedImage) {
      return res.status(400).json({ error: 'No part label image provided.' });
    }
    const partsList = Array.isArray(knownParts)
      ? knownParts
      : Array.isArray(docketParts)
      ? docketParts.map((p: any) => ({
          itemNumber: String(p.no || p.itemNumber || ''),
          partNumber: String(p.partNumber || ''),
          description: String(p.description || ''),
        }))
      : undefined;
    const result = await extractPartCodeWithGeminiVision(resolvedImage, partsList);
    return res.status(200).json({
      ...result,
      scannedCode: result.detectedCode,
    });
  } catch (err: any) {
    const { classifyGeminiError } = await import('./src/server/docketOcr.ts');
    const classification = classifyGeminiError(err);
    return res.status(classification.statusCode).json({
      error: classification.cleanMessage || 'Failed to read part label.',
      code: classification.errorCode,
      retryable: classification.isRetryableAvailabilityError || classification.isTimeout,
    });
  }
});

// Ensure any unmatched /api/* route returns JSON instead of falling through to SPA HTML
app.all('/api/*', (req: ExpressRequest, res: ExpressResponse) => {
  return res.status(404).json({
    error: `API route not found: ${req.path}`,
    code: 'NOT_FOUND',
  });
});

// Setup Vite in development or serve static in production
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, watch: null },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const dbService = new PalletTrackDbService(localDb);

  httpServer.on('upgrade', (req, socket, head) => {
    try {
      const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost:3000'}`);
      if (reqUrl.pathname !== '/api/realtime/ws') {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, async (ws) => {
        try {
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string') headers.set(k, v);
            else if (Array.isArray(v)) v.forEach((val) => headers.append(k, val));
          }
          const webReq = new Request(reqUrl.toString(), { headers });
          const token = extractSessionTokenFromRequest(webReq);

          if (!token) {
            ws.send(
              JSON.stringify({
                type: 'auth_error',
                code: 'UNAUTHORIZED',
                error: 'Authentication required for real-time synchronisation.',
              })
            );
            ws.close(4001, 'Unauthorized: Missing session token');
            return;
          }

          const user = await dbService.validateSession(token);
          if (!user || !user.active) {
            ws.send(
              JSON.stringify({
                type: 'auth_error',
                code: 'SESSION_INVALID',
                error: 'Invalid, expired, or deactivated session.',
              })
            );
            ws.close(4001, 'Unauthorized: Invalid or expired session');
            return;
          }

          const initialDeliveryId = reqUrl.searchParams.get('deliveryId') || null;
          const lastSeq = Number(reqUrl.searchParams.get('lastSeq')) || 0;
          const connectionId = realtimeBroker.registerClient(
            ws as any,
            user,
            token,
            initialDeliveryId,
            lastSeq,
            localDb
          );

          ws.on('message', (data) => {
            const text = typeof data === 'string' ? data : data.toString('utf-8');
            realtimeBroker.handleClientMessage(connectionId, text, localDb).catch(() => {});
          });

          ws.on('close', () => {
            realtimeBroker.unregisterClient(connectionId);
          });

          ws.on('error', () => {
            realtimeBroker.unregisterClient(connectionId);
          });
        } catch {
          try {
            ws.close(4000, 'Internal connection error');
          } catch {
            // Ignore
          }
        }
      });
    } catch {
      socket.destroy();
    }
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`PartTrack server running on http://localhost:${PORT}`);
  });
}

startServer();
