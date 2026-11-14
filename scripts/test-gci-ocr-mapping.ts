import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import workerEntry from '../worker.ts';
import { onRequestPost as pagesExtractDocketPost } from '../functions/api/extract-docket.ts';
import {
  buildDocketExtractionPrompt,
  resolveGciPageHeaderFields,
  normalizeGciDispatchDate,
  extractGciFieldsFromSelectableText,
  GCI_MISSING_JOB_NO_WARNING,
} from '../src/server/docketOcr.ts';
import {
  parseIndustrialDocketText,
  validateAndNormalizeGeminiDocket,
} from '../src/utils/docketParser.ts';
import { performSmartDocketExtraction } from '../src/utils/offlineOcr.ts';
import { NodeSqliteD1Adapter } from '../src/server/db/nodeSqliteAdapter.ts';
import { PalletTrackDbService } from '../src/server/api/palletTrackDbService.ts';

function geminiJsonResponse(payload: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify(payload) }],
          },
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

async function runTests() {
  console.log('==================================================================');
  console.log('🧪 PARTTRACK — GCI-SPECIFIC OCR FIELD MAPPING & REGRESSION TESTS');
  console.log('==================================================================\n');
  let passed = 0;

  // ---------------------------------------------------------------------------
  // 1. Prompt Generation: GCI-only conditional rule; non-GCI byte-for-byte unchanged
  // ---------------------------------------------------------------------------
  console.log('--- 1. Prompt Isolation & GCI Conditional Instructions ---');
  const laserPrompt = buildDocketExtractionPrompt(['Page 1'], [1], 1, 'laser_central');
  const labelPrompt = buildDocketExtractionPrompt(['Page 1'], [1], 1, 'ocr_label');
  const defaultPrompt = buildDocketExtractionPrompt(['Page 1'], [1], 1, undefined);
  const gciPrompt = buildDocketExtractionPrompt(['Page 1'], [1], 1, 'gci');

  assert.equal(laserPrompt, defaultPrompt, 'laser_central prompt must match default prompt identically');
  assert.equal(labelPrompt, defaultPrompt, 'ocr_label prompt must match default prompt identically');
  assert(!laserPrompt.includes('GCI SUPPLIER-SPECIFIC HEADER MAPPING'), 'Non-GCI prompt must never contain GCI override section');
  assert(gciPrompt.includes('GCI SUPPLIER-SPECIFIC HEADER MAPPING'), 'GCI prompt must include GCI mapping section');
  assert(gciPrompt.includes('Job No'), 'GCI prompt must instruct Job No -> docketNumber');
  assert(gciPrompt.includes('Client Order No'), 'GCI prompt must instruct Client Order No -> orderNumber');
  assert(gciPrompt.includes('Despatch Date'), 'GCI prompt must mention Despatch Date / Dispatch Date');
  console.log('  ✅ PASS: Prompt isolation & GCI conditional mapping rules verified');
  passed += 7;

  // ---------------------------------------------------------------------------
  // 2. Date & Header Resolution Helpers (Real GCI Example: Job 194322 / Client Order 72018 / 12/11/2026)
  // ---------------------------------------------------------------------------
  console.log('\n--- 2. GCI Date Normalization & Selectable Text / Swapped Header Resolution ---');
  assert.equal(normalizeGciDispatchDate('12/11/2026'), '2026-11-12');
  assert.equal(normalizeGciDispatchDate('12-11-2026'), '2026-11-12');
  assert.equal(normalizeGciDispatchDate('2026-11-12'), '2026-11-12');
  assert.equal(normalizeGciDispatchDate('12 Nov 2026'), '2026-11-12');

  const selectableParsed = extractGciFieldsFromSelectableText(
    'GCI Delivery Docket\nClient Order No | Job No | Despatch Date | Despatched By\n72018 | 194322 | 12/11/2026 | Layla MacDonald'
  );
  assert.equal(selectableParsed.clientOrderNo, '72018');
  assert.equal(selectableParsed.jobNo, '194322');
  assert.equal(selectableParsed.dispatchDate, '2026-11-12');

  // Swapped Gemini output guard: AI put Client Order No "72018" in docketNumber while jobNumber is "194322"
  const swappedResolved = resolveGciPageHeaderFields({
    docketNumber: '72018',
    jobNumber: '194322',
    orderNumber: '72018',
    deliveryDate: '12/11/2026',
    supplier: 'Golden Coast Industrial',
  });
  assert.equal(swappedResolved.docketNumber, '194322');
  assert.equal(swappedResolved.jobNumber, '194322');
  assert.equal(swappedResolved.orderNumber, '72018');
  assert.equal(swappedResolved.deliveryDate, '2026-11-12');
  assert.equal(swappedResolved.supplier, 'GCI');
  assert.equal(swappedResolved.missingJobNo, false);

  // Missing Job No guard: AI put Client Order No "72018" in docketNumber and jobNumber is blank -> must NOT keep "72018"
  const missingJobResolved = resolveGciPageHeaderFields({
    docketNumber: '72018',
    jobNumber: '',
    orderNumber: '72018',
    deliveryDate: '12/11/2026',
  });
  assert.equal(missingJobResolved.docketNumber, '');
  assert.equal(missingJobResolved.jobNumber, undefined);
  assert.equal(missingJobResolved.orderNumber, '72018');
  assert.equal(missingJobResolved.missingJobNo, true);
  assert(missingJobResolved.validationWarnings.includes(GCI_MISSING_JOB_NO_WARNING));
  console.log('  ✅ PASS: GCI date normalization, swapped field correction, and missing-Job-No guard verified');
  passed += 14;

  // ---------------------------------------------------------------------------
  // 3. Worker API (/api/extract-docket) — Real GCI Image Fixture + Multi-Docket + Missing Job No + Non-GCI
  // ---------------------------------------------------------------------------
  console.log('\n--- 3. Worker /api/extract-docket GCI & Multi-Docket & Non-GCI Verification ---');
  const schemaSql = fs.readFileSync(path.resolve(process.cwd(), 'schema.sql'), 'utf-8');
  const db = new NodeSqliteD1Adapter(':memory:', schemaSql);
  const env: any = { DB: db, GEMINI_API_KEY: 'test-key-never-logged' };

  const realGciImg = fs.readFileSync(
    path.resolve(process.cwd(), 'public/assets/aistudio/20261113_141321_b0b57d18.jpg')
  );
  const gciDataUrl = `data:image/jpeg;base64,${realGciImg.slice(0, 2048).toString('base64')}`;

  const originalFetch = globalThis.fetch;
  try {
    // 3a. Single GCI docket (even if Gemini swapped docketNumber="72018" and put jobNumber="194322")
    let capturedPrompt = '';
    let capturedModelUrl = '';
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      capturedModelUrl = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const parts = body?.contents?.[0]?.parts || [];
      capturedPrompt = parts.map((p: any) => p.text || '').join('\n');
      return geminiJsonResponse({
        docketNumber: '72018',
        supplier: 'Golden Coast Industrial',
        deliveryDate: '12/11/2026',
        orderNumber: '72018',
        jobNumber: '194322',
        pageHeaders: [
          {
            page: 1,
            docketNumber: '72018',
            supplier: 'Golden Coast Industrial',
            deliveryDate: '12/11/2026',
            orderNumber: '72018',
            jobNumber: '194322',
          },
        ],
        items: [
          {
            page: 1,
            no: '1',
            part: 'J-4410-BRK',
            desc: 'Support Bracket 6mm MS',
            rev: 'C',
            qty: 8,
            unit: 'EA',
          },
          {
            page: 1,
            no: '2',
            part: 'J-4412-PLT',
            desc: 'Base Plate 10mm',
            rev: 'A',
            qty: 2,
            unit: 'EA',
          },
        ],
      });
    }) as typeof fetch;

    const singleRes = await workerEntry.fetch(
      new Request('http://localhost:3000/api/extract-docket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierHint: 'gci',
          pageSlices: [{ fullDataUrl: gciDataUrl }],
        }),
      }),
      env
    );
    assert.equal(singleRes.status, 200);
    const singleJson: any = await singleRes.json();
    assert(capturedModelUrl.includes('gemini-4-hydrogen:generateContent'), 'Must keep primary model gemini-4-hydrogen');
    assert(capturedPrompt.includes('GCI SUPPLIER-SPECIFIC HEADER MAPPING'), 'Worker must send GCI prompt rules');
    assert.equal(singleJson.docketNumber, '194322', 'Job No 194322 must populate Docket / Ref #');
    assert.equal(singleJson.orderNumber, '72018', 'Client Order No 72018 must populate PO / Order #');
    assert.equal(singleJson.deliveryDate, '2026-11-12', 'Despatch Date 12/11/2026 must normalize to 2026-11-12');
    assert.equal(singleJson.supplier, 'GCI');
    assert.equal(singleJson.items.length, 2, 'All GCI part items must remain intact');
    assert.equal(singleJson.items[0].partNumber, 'J-4410-BRK');
    assert.equal(singleJson.items[0].quantity, 8);
    assert.equal(singleJson.items[0].revision, 'C');

    // 3b. Multi-docket GCI upload (P1 + P2 continuation share Job No 194322 / PO 72018; P3 has Job No 194500 / PO 72105)
    globalThis.fetch = (async () =>
      geminiJsonResponse({
        pageHeaders: [
          { page: 1, docketNumber: '72018', jobNumber: '194322', orderNumber: '72018', deliveryDate: '12/11/2026', startsNewDocket: false },
          { page: 2, docketNumber: '', jobNumber: '', orderNumber: '', deliveryDate: '', startsNewDocket: false },
          { page: 3, docketNumber: '72105', jobNumber: '194500', orderNumber: '72105', deliveryDate: '14/11/2026', startsNewDocket: true },
        ],
        items: [
          { page: 1, no: '1', part: 'GCI-P1-A', desc: 'Plate A', rev: 'A', qty: 5 },
          { page: 2, no: '2', part: 'GCI-P2-B', desc: 'Plate B', rev: 'B', qty: 3 },
          { page: 3, no: '1', part: 'GCI-P3-C', desc: 'Bracket C', rev: '01', qty: 12 },
        ],
      })) as typeof fetch;

    const multiRes = await workerEntry.fetch(
      new Request('http://localhost:3000/api/extract-docket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierHint: 'gci',
          pageSlices: [
            { fullDataUrl: gciDataUrl },
            { fullDataUrl: gciDataUrl },
            { fullDataUrl: gciDataUrl },
          ],
        }),
      }),
      env
    );
    assert.equal(multiRes.status, 200);
    const multiJson: any = await multiRes.json();
    assert.equal(multiJson.separatedDockets.length, 2, 'Multi-page GCI batch must group P1+P2 into Job 194322 and split P3 into Job 194500');
    assert.equal(multiJson.separatedDockets[0].docketNumber, '194322');
    assert.equal(multiJson.separatedDockets[0].orderNumber, '72018');
    assert.equal(multiJson.separatedDockets[0].deliveryDate, '2026-11-12');
    assert.deepEqual(multiJson.separatedDockets[0].sourcePageNumbers, [1, 2]);
    assert.equal(multiJson.separatedDockets[0].items.length, 2);
    assert.equal(multiJson.separatedDockets[1].docketNumber, '194500');
    assert.equal(multiJson.separatedDockets[1].orderNumber, '72105');
    assert.equal(multiJson.separatedDockets[1].deliveryDate, '2026-11-14');
    assert.deepEqual(multiJson.separatedDockets[1].sourcePageNumbers, [3]);
    assert.equal(multiJson.separatedDockets[1].items[0].partNumber, 'GCI-P3-C');

    // 3c. GCI missing / unreadable Job No -> never substitute Client Order No or fake DK-xxxx
    globalThis.fetch = (async () =>
      geminiJsonResponse({
        docketNumber: '72018',
        jobNumber: '',
        orderNumber: '72018',
        deliveryDate: '12/11/2026',
        pageHeaders: [
          { page: 1, docketNumber: '72018', jobNumber: '', orderNumber: '72018', deliveryDate: '12/11/2026' },
        ],
        items: [{ page: 1, no: '1', part: 'GCI-MISS-1', desc: 'Plate', qty: 4 }],
      })) as typeof fetch;

    const missingRes = await workerEntry.fetch(
      new Request('http://localhost:3000/api/extract-docket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierHint: 'gci',
          pageSlices: [{ fullDataUrl: gciDataUrl }],
        }),
      }),
      env
    );
    assert.equal(missingRes.status, 200);
    const missingJson: any = await missingRes.json();
    assert.equal(missingJson.docketNumber, '', 'Missing GCI Job No must stay blank, never 72018 or DK-xxxxx');
    assert.equal(missingJson.orderNumber, '72018');
    assert.equal(missingJson.deliveryDate, '2026-11-12');
    assert.equal(missingJson.needsManualReview, true);
    assert.equal(missingJson.separationUncertain, true);
    assert(
      Array.isArray(missingJson.validationWarnings) &&
        missingJson.validationWarnings.some((w: string) => /GCI Job No/i.test(w)),
      'Missing GCI Job No must emit explicit manual review warning'
    );

    // 3d. Non-GCI (laser_central) must remain 100% unchanged!
    let nonGciPrompt = '';
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      nonGciPrompt = (body?.contents?.[0]?.parts || []).map((p: any) => p.text || '').join('\n');
      return geminiJsonResponse({
        docketNumber: 'DN-8801',
        supplier: 'Laser Central',
        deliveryDate: '2026-11-10',
        orderNumber: 'PO-1122',
        jobNumber: 'J-999',
        pageHeaders: [
          { page: 1, docketNumber: 'DN-8801', supplier: 'Laser Central', deliveryDate: '2026-11-10', orderNumber: 'PO-1122', jobNumber: 'J-999' },
        ],
        items: [{ page: 1, no: '1', part: 'LC-500', desc: 'Laser Plate', qty: 7 }],
      });
    }) as typeof fetch;

    const lcRes = await workerEntry.fetch(
      new Request('http://localhost:3000/api/extract-docket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierHint: 'laser_central',
          pageSlices: [{ fullDataUrl: gciDataUrl }],
        }),
      }),
      env
    );
    assert.equal(lcRes.status, 200);
    const lcJson: any = await lcRes.json();
    assert(!nonGciPrompt.includes('GCI SUPPLIER-SPECIFIC HEADER MAPPING'), 'Non-GCI request must NOT get GCI prompt instructions');
    assert.equal(lcJson.docketNumber, 'DN-8801', 'Laser Central docketNumber must NOT be overwritten by jobNumber');
    assert.equal(lcJson.orderNumber, 'PO-1122');
    assert.equal(lcJson.jobNumber, 'J-999');
    assert.equal(lcJson.supplier, 'Laser Central');

    // -------------------------------------------------------------------------
    // 4. Cloudflare Pages Function (functions/api/extract-docket.ts)
    // -------------------------------------------------------------------------
    console.log('\n--- 4. Cloudflare Pages Function /api/extract-docket GCI Verification ---');
    globalThis.fetch = (async () =>
      geminiJsonResponse({
        pageHeaders: [
          { page: 1, docketNumber: '72018', jobNumber: '194322', orderNumber: '72018', deliveryDate: '12/11/2026' },
          { page: 2, docketNumber: '', jobNumber: '', orderNumber: '72999', deliveryDate: '13/11/2026', startsNewDocket: true },
        ],
        items: [
          { page: 1, no: '1', part: 'GCI-PG-1', desc: 'Bracket 1', qty: 2 },
          { page: 2, no: '1', part: 'GCI-PG-2', desc: 'Bracket 2', qty: 6 },
        ],
      })) as typeof fetch;

    const pagesRes = await pagesExtractDocketPost({
      request: new Request('https://parttrack.pages.dev/api/extract-docket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierHint: 'gci',
          pageSlices: [{ fullDataUrl: gciDataUrl }, { fullDataUrl: gciDataUrl }],
        }),
      }),
      env: { GEMINI_API_KEY: 'test-key-never-logged' },
    } as any);
    assert.equal(pagesRes.status, 200);
    const pagesJson: any = await pagesRes.json();
    assert.equal(pagesJson.separatedDockets.length, 2);
    assert.equal(pagesJson.separatedDockets[0].docketNumber, '194322');
    assert.equal(pagesJson.separatedDockets[0].orderNumber, '72018');
    assert.equal(pagesJson.separatedDockets[0].deliveryDate, '2026-11-12');
    assert.equal(pagesJson.separatedDockets[1].docketNumber, '', 'Missing Job No on Page 2 must stay empty');
    assert.equal(pagesJson.separatedDockets[1].orderNumber, '72999');
    assert.equal(pagesJson.separatedDockets[1].needsManualReview, true);

    // -------------------------------------------------------------------------
    // 5. Client Pipeline (performSmartDocketExtraction + validateAndNormalizeGeminiDocket + parseIndustrialDocketText)
    // -------------------------------------------------------------------------
    console.log('\n--- 5. Client OCR Pipeline & Parser GCI vs Non-GCI Regression ---');
    const clientOut = await performSmartDocketExtraction(
      [gciDataUrl],
      undefined,
      false,
      undefined,
      {
        supplierHint: 'gci',
        enableTargetedRecovery: false,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              docketNumber: '72018',
              jobNumber: '194322',
              orderNumber: '72018',
              deliveryDate: '12/11/2026',
              supplier: 'Golden Coast Industrial',
              aiModelUsed: 'gemini-4-hydrogen',
              extractionMethod: 'gemini-vision',
              confidenceScore: 98,
              needsManualReview: false,
              items: [
                {
                  itemNumber: '1',
                  partNumber: 'GCI-10',
                  description: 'Gusset 4 EA',
                  rev: 'B',
                  quantity: 4,
                  confidence: 'high',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ),
      }
    );
    assert.equal(clientOut.extractedData.docketNumber, '194322');
    assert.equal(clientOut.extractedData.orderNumber, '72018');
    assert.equal(clientOut.extractedData.deliveryDate, '2026-11-12');
    assert.equal(clientOut.extractedData.supplier, 'GCI');
    assert.equal(clientOut.extractedData.items[0].quantity, 4);
    assert.equal(clientOut.extractedData.items[0].revision, 'B');

    // Text parser guard for GCI
    const textParsedGci = parseIndustrialDocketText(
      [
        { text: 'GOLDEN COAST INDUSTRIAL - DELIVERY DOCKET', confidence: 99, pageNumber: 1 },
        { text: 'Client Order No: 72018   Job No: 194322   Despatch Date: 12/11/2026', confidence: 99, pageNumber: 1 },
      ],
      1,
      'gci'
    );
    assert.equal(textParsedGci.header.docketNumber, '194322');
    assert.equal(textParsedGci.header.orderNumber, '72018');
    assert.equal(textParsedGci.header.deliveryDate, '2026-11-12');

    // Non-GCI client validator regression
    const nonGciNormalized = validateAndNormalizeGeminiDocket(
      {
        docketNumber: 'LC-4401',
        jobNumber: 'LC-JOB-9',
        orderNumber: 'PO-LC-2',
        supplier: 'Laser Central',
        deliveryDate: '2026-11-10',
        confidenceScore: 95,
        needsManualReview: false,
        items: [{ itemNumber: '1', partNumber: 'LC-PART-1', description: 'Frame', quantity: 3, confidence: 'high' }],
      },
      'laser_central'
    );
    assert.equal(nonGciNormalized.docketNumber, 'LC-4401');
    assert.equal(nonGciNormalized.orderNumber, 'PO-LC-2');
    assert.equal(nonGciNormalized.jobNumber, 'LC-JOB-9');
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('  ✅ PASS: Worker, Pages Function, Client OCR Pipeline & Parser all verified');
  passed += 26;

  // ---------------------------------------------------------------------------
  // 6. Save & Database Reload Verification (D1 SQLite persistence check)
  // ---------------------------------------------------------------------------
  console.log('\n--- 6. D1 Save & Reload Verification for GCI Docket ---');
  const dbService = new PalletTrackDbService(db);
  const saved = await dbService.createDelivery({
    docketNumber: '194322',
    supplier: 'GCI',
    purchaseOrderNumber: '72018',
    deliveryDate: '2026-11-12',
    supplierProfile: 'gci',
    carrier: 'GCI Freight',
    palletCount: 1,
    parts: [
      {
        partNumber: 'J-4410-BRK',
        itemNumber: '1',
        docketLineIndex: 1,
        description: 'Support Bracket 6mm MS',
        revision: 'C',
        quantity: 8,
      },
    ],
  });
  assert(saved, 'Saved GCI delivery must not be null');
  const reloadedById = await dbService.getDeliveryById(saved.id);
  assert(reloadedById, 'Saved GCI delivery must reload cleanly from D1');
  assert.equal(reloadedById.docketNumber, '194322');
  assert.equal(reloadedById.orderNumber, '72018');
  assert.equal(reloadedById.deliveryDate, '2026-11-12');
  assert.equal(reloadedById.supplier, 'GCI');
  assert.equal(reloadedById.supplierProfile, 'gci');
  assert.equal(reloadedById.parts[0].partNumber, 'J-4410-BRK');
  assert.equal(reloadedById.parts[0].quantity, 8);

  const listResult: any = await dbService.listDeliveries();
  const listArray = Array.isArray(listResult) ? listResult : listResult.deliveries || [];
  const listed = listArray.find((d: any) => d.id === saved.id);
  assert(listed, 'Saved GCI delivery must appear in listDeliveries()');
  assert.equal(listed.docketNumber, '194322');
  assert.equal(listed.orderNumber, '72018');
  assert.equal(listed.deliveryDate, '2026-11-12');

  console.log('  ✅ PASS: GCI save & reload round-trip verified in D1 SQLite');
  passed += 11;

  console.log(`\n🎉 ALL ${passed} GCI OCR MAPPING & REGRESSION ASSERTIONS PASSED!`);
}

runTests().catch((err) => {
  console.error('❌ GCI test suite failed:', err);
  process.exit(1);
});
