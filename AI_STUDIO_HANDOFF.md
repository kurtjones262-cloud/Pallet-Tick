# PartTrack — AI Studio source handoff

## Important identity check
The uploaded archive filename says `paycheck-australian-wage-shift-tracker`, but the actual application source identifies itself throughout as **PartTrack**, an industrial parts receiving and delivery verification app. Its React entry point is `src/App.tsx`; its UI includes delivery dashboard, scanner, checklist, docket OCR review, and settings. Confirm this is the app you intended to restore before making changes.

## What is included
- `src/`: full React/TypeScript application source, components, scanning, Gemini-first OCR orchestration (`src/utils/offlineOcr.ts`, `src/utils/docketParser.ts`, `src/utils/palletLabelOcr.ts`), IndexedDB storage & offline docket queue (`src/utils/indexedDb.ts`, `src/utils/offlineDocketQueue.ts`), PDF/ZIP exports, and server-side Gemini docket extraction source (`src/server/docketOcr.ts`).
- `public/`: app icons and `pdf.worker.min.mjs` for client-side PDF rendering.
- `package.json`, `bun.lock`, `vite.config.ts`, `tsconfig.json`, `index.html`, `server.ts`, `worker.ts`, `functions/api/*`, `capacitor.config.ts`, `metadata.json`, `.env.example`, `.gitignore`.

## Deliberately excluded
- `android/` and `ios/`: generated native platform projects; recreate/sync them with Capacitor when needed.
- `.aistudio/`: temporary AI Studio media cache.
- `server.js`: generated build output; regenerate from `server.ts`.
- Any installed dependencies or build output (none are required to restore the source).

## Restore guidance
Treat this as an existing codebase to restore, not a request to redesign or rewrite it. Preserve existing UI, data structures, scan matching rules, offline barcode/QR scanning, offline docket upload queueing, IndexedDB persistence, exports, and mobile camera behavior. Make only explicitly requested changes. Do not rename the app or change its identity without confirmation.

The project uses React 19, TypeScript, Vite, Tailwind CSS v4, html5-qrcode, IndexedDB (`idb`), jsPDF, JSZip, Capacitor, and the Google GenAI SDK (`gemini-4-hydrogen` primary, `gemini-3.1-flash-lite` fallback). The backend (`server.ts`, `worker.ts`, and `functions/api/*`) exposes `/api/extract-docket`, `/api/recover-docket-items`, and `/api/read-part-label`. Offline docket uploads are safely queued in `pending_docket_uploads` in IndexedDB (`src/utils/offlineDocketQueue.ts`) and processed automatically upon reconnection.

## Secrets
`.env.example` contains placeholders only. Do not copy real API keys into source files. Configure `GEMINI_API_KEY` through AI Studio Secrets/runtime environment as appropriate.
