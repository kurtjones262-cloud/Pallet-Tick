import express, { Request, Response } from 'express';
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Serve public directory static assets (Tesseract offline workers, wasm, and lang data)
app.use(express.static(path.resolve(__dirname, 'public')));
// Fallback for /tesseract/worker.min.js directly from node_modules/tesseract.js/dist
app.use('/tesseract', express.static(path.resolve(__dirname, 'node_modules/tesseract.js/dist')));


/**
 * GET /api/health
 */
app.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    app: 'PalletTick',
    runtime: 'node-express',
    offlineOcrReady: true,
    engine: 'tesseract.js-wasm-local',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/export-project-zip
 * Bundles the application project source code and assets into a .zip file
 */
app.get('/api/export-project-zip', async (_req: Request, res: Response) => {
  try {
    const JSZipModule = (await import('jszip')).default;
    const fs = await import('fs');
    const zip = new JSZipModule();
    const rootDir = process.cwd();

    const ignoredNames = new Set([
      'node_modules',
      'dist',
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
          // Avoid bundling huge files like the 20MB local wasm engine in source zip
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
    res.setHeader('Content-Disposition', 'attachment; filename="pallettick-app-source.zip"');
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
app.post('/api/extract-docket', async (req: Request, res: Response) => {
  try {
    const { images, startItemIndex, pageSlices } = req.body || {};
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
      Array.isArray(pageSlices) ? pageSlices : undefined
    );
    return res.status(200).json(result);
  } catch (err: any) {
    const rawMsg = err?.message || String(err || '');
    console.error('Gemini AI docket extraction error:', rawMsg);
    const isMissingKey = rawMsg.includes('GEMINI_API_KEY');
    return res.status(isMissingKey ? 503 : 500).json({
      error: isMissingKey
        ? 'Gemini AI API key is not configured on the server. Please set GEMINI_API_KEY in your server environment settings.'
        : rawMsg || 'Gemini AI docket extraction failed.',
      code: isMissingKey ? 'MISSING_GEMINI_API_KEY' : 'AI_EXTRACTION_FAILED',
    });
  }
});

/**
 * POST /api/recover-docket-items
 * Targeted recovery pass for any missing "No" numbers across page boundaries (e.g. 1..199).
 */
app.post('/api/recover-docket-items', async (req: Request, res: Response) => {
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
app.post('/api/read-part-label', async (req: Request, res: Response) => {
  try {
    const { image, imageBase64, mimeType, knownParts, docketParts } = req.body || {};
    const resolvedImage =
      typeof image === 'string' && image
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
    return res.status(500).json({
      error: err?.message || 'Failed to read part label.',
    });
  }
});

// Ensure any unmatched /api/* route returns JSON instead of falling through to SPA HTML
app.all('/api/*', (req: Request, res: Response) => {
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PalletTick server running on http://localhost:${PORT}`);
  });
}

startServer();
