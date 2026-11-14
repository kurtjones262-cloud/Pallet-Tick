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
  isGciExcludedNonPartItem,
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
  assert(!laserPrompt.includes('CUSTOMER-LABELS'), 'Non-GCI prompt must never contain GCI non-part exclusion rules');
  assert(gciPrompt.includes('GCI SUPPLIER-SPECIFIC HEADER MAPPING'), 'GCI prompt must include GCI mapping section');
  assert(gciPrompt.includes('CUSTOMER-LABELS'), 'GCI prompt must instruct excluding CUSTOMER-LABELS');
  assert(gciPrompt.includes('DELIVERY_EXCL'), 'GCI prompt must instruct excluding DELIVERY_EXCL');
  assert(gciPrompt.includes('Job No'), 'GCI prompt must instruct Job No -> docketNumber');
  assert(gciPrompt.includes('Client Order No'), 'GCI prompt must instruct Client Order No -> orderNumber');
  assert(gciPrompt.includes('Despatch Date'), 'GCI prompt must mention Despatch Date / Dispatch Date');
  console.log('  ✅ PASS: Prompt isolation & GCI conditional mapping + exclusion rules verified');
  passed += 10;

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

    // -------------------------------------------------------------------------
    // 7. GCI Non-Part Exclusion (CUSTOMER-LABELS & DELIVERY_EXCL) — 6 Required Scenarios
    // -------------------------------------------------------------------------
    console.log('\n--- 7. GCI Non-Part Exclusion (CUSTOMER-LABELS & DELIVERY_EXCL) — 6 Required Scenarios ---');

    // Unit checks on isGciExcludedNonPartItem for OCR variations & secondary description check
    assert.equal(isGciExcludedNonPartItem('CUSTOMER-LABELS', 'CUSTOMER LABELS'), true);
    assert.equal(isGciExcludedNonPartItem('customer labels', 'Customer Labels'), true);
    assert.equal(isGciExcludedNonPartItem('CUSTOMER_LABELS', 'CUSTOMER LABELS'), true);
    assert.equal(isGciExcludedNonPartItem('DELIVERY_EXCL', 'CUSTOMERS TRANSPORT'), true);
    assert.equal(isGciExcludedNonPartItem('DELIVERY EXCL', 'CUSTOMERS TRANSPORT'), true);
    assert.equal(isGciExcludedNonPartItem('delivery-excl', 'customers transport'), true);
    assert.equal(isGciExcludedNonPartItem('', 'CUSTOMER LABELS'), true, 'Secondary description check when part code is missing');
    assert.equal(isGciExcludedNonPartItem('UNKNOWN', 'CUSTOMERS TRANSPORT'), true, 'Secondary description check when part code is unreadable');
    // Safeguards: genuine parts must NEVER be excluded even if descriptions mention delivery or labels
    assert.equal(isGciExcludedNonPartItem('J160799102', 'DELIVERY MOUNTING BRACKET'), false);
    assert.equal(isGciExcludedNonPartItem('J160799103', 'PANEL WITH CUSTOMER LABELS SLOT'), false);
    assert.equal(isGciExcludedNonPartItem('1YY8231', '1YY8231 - TAPPED'), false);
    assert.equal(isGciExcludedNonPartItem('J160798105', 'J160798105 - NO CSK'), false);
    passed += 12;

    // Scenario 7.1: GCI docket containing BOTH CUSTOMER-LABELS and DELIVERY_EXCL (including middle-row placement + OCR variants)
    // Matches real GCI docket Job 194346 / PO 72019 where lines 1-3 are J160799102..104, line 4 is CUSTOMER-LABELS, line 5 is DELIVERY_EXCL,
    // plus an extra genuine part on line 6 to verify no false missingRowNumbers warning is emitted for lines 4 and 5!
    globalThis.fetch = (async () =>
      geminiJsonResponse({
        docketNumber: '72019',
        jobNumber: '194346',
        orderNumber: '72019',
        deliveryDate: '09/11/2026',
        supplier: 'GCI',
        pageHeaders: [
          { page: 1, docketNumber: '72019', jobNumber: '194346', orderNumber: '72019', deliveryDate: '09/11/2026' },
        ],
        items: [
          { page: 1, no: '1', part: 'J160799102', desc: 'J160799102', rev: '0', qty: 1 },
          { page: 1, no: '2', part: 'J160799103', desc: 'J160799103', rev: '0', qty: 1 },
          { page: 1, no: '3', part: 'J160799104', desc: 'J160799104', rev: '0', qty: 1 },
          { page: 1, no: '4', part: 'CUSTOMER-LABELS', desc: 'CUSTOMER LABELS', rev: 'A', qty: 1 },
          { page: 1, no: '5', part: 'DELIVERY_EXCL', desc: 'CUSTOMERS TRANSPORT', rev: '0', qty: 1 },
          { page: 1, no: '6', part: 'J160799105', desc: 'J160799105', rev: '0', qty: 2 },
          { page: 1, no: '7', part: 'CUSTOMER_LABELS', desc: 'CUSTOMER LABELS', rev: 'A', qty: 5 },
          { page: 1, no: '8', part: 'DELIVERY-EXCL', desc: 'CUSTOMERS TRANSPORT', rev: '0', qty: 1 },
          { page: 1, no: '9', part: '', desc: 'CUSTOMER LABELS', rev: 'A', qty: 1 },
          { page: 1, no: '10', part: '', desc: 'CUSTOMERS TRANSPORT', rev: '0', qty: 1 },
        ],
      })) as typeof fetch;

    const scen1WorkerRes = await workerEntry.fetch(
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
    assert.equal(scen1WorkerRes.status, 200);
    const scen1WorkerJson: any = await scen1WorkerRes.json();
    assert.equal(scen1WorkerJson.docketNumber, '194346');
    assert.equal(scen1WorkerJson.orderNumber, '72019');
    assert.equal(scen1WorkerJson.deliveryDate, '2026-11-09');
    assert.equal(scen1WorkerJson.items.length, 4, 'Must exclude all CUSTOMER-LABELS and DELIVERY_EXCL variants and keep 4 genuine parts');
    assert.deepEqual(
      scen1WorkerJson.items.map((i: any) => i.partNumber),
      ['J160799102', 'J160799103', 'J160799104', 'J160799105']
    );

    // Run through client validator to confirm 0 missingRowNumbers warnings for excluded lines 4, 5, 7, 8, 9, 10
    const scen1ClientNorm = validateAndNormalizeGeminiDocket(scen1WorkerJson, 'gci');
    assert.equal(scen1ClientNorm.items.length, 4);
    assert.deepEqual(scen1ClientNorm.missingRowNumbers || [], [], 'Excluded GCI rows must NOT trigger missing-part warnings');
    assert(
      !(scen1ClientNorm.validationWarnings || []).some((w) => /Potentially missed line item/i.test(w)),
      'Excluded GCI rows must NOT generate Potentially missed line item warning'
    );
    passed += 8;

    // Also test Scenario 7.1 via parseIndustrialDocketText (OCR text parser)
    const scen1TextParsed = parseIndustrialDocketText(
      [
        { text: 'GOLDEN COAST INDUSTRIAL - DELIVERY DOCKET', confidence: 99, pageNumber: 1 },
        { text: 'Client Order No: 72019   Job No: 194346   Despatch Date: 09/11/2026', confidence: 99, pageNumber: 1 },
        { text: 'Line Client Part Code Part Description Rev Ord/Q Desp', confidence: 99, pageNumber: 1 },
        { text: '1 J160799102 J160799102 0 1 1', confidence: 99, pageNumber: 1 },
        { text: '2 J160799103 J160799103 0 1 1', confidence: 99, pageNumber: 1 },
        { text: '3 J160799104 J160799104 0 1 1', confidence: 99, pageNumber: 1 },
        { text: '4 CUSTOMER-LABELS CUSTOMER LABELS A 1 1', confidence: 99, pageNumber: 1 },
        { text: '5 DELIVERY_EXCL CUSTOMERS TRANSPORT 0 1 1', confidence: 99, pageNumber: 1 },
      ],
      1,
      'gci'
    );
    assert.equal(scen1TextParsed.items.length, 3, 'Text parser must exclude CUSTOMER-LABELS and DELIVERY_EXCL for GCI');
    assert.deepEqual(
      scen1TextParsed.items.map((i) => i.partNumber),
      ['J160799102', 'J160799103', 'J160799104']
    );
    passed += 2;

    // Scenario 7.2 & 7.3: GCI docket containing neither entry + multiple genuine manufactured parts
    // (including genuine parts whose descriptions contain words like "DELIVERY" or "LABELS")
    const scen2And3Norm = validateAndNormalizeGeminiDocket(
      {
        docketNumber: '194322',
        jobNumber: '194322',
        orderNumber: '72018',
        deliveryDate: '2026-11-12',
        supplier: 'GCI',
        confidenceScore: 99,
        needsManualReview: false,
        items: [
          { itemNumber: '1', partNumber: 'J160798102', description: 'J160798102', rev: '0', quantity: 10, confidence: 'high' },
          { itemNumber: '2', partNumber: 'J160798104', description: 'J160798104', rev: '0', quantity: 8, confidence: 'high' },
          { itemNumber: '3', partNumber: 'J160799200', description: 'DELIVERY CHUTE SUPPORT BRACKET', rev: 'B', quantity: 4, confidence: 'high' },
          { itemNumber: '4', partNumber: 'J160799201', description: 'MOUNTING PLATE FOR WARNING LABELS', rev: 'A', quantity: 6, confidence: 'high' },
        ],
      },
      'gci'
    );
    assert.equal(scen2And3Norm.items.length, 4, 'All 4 genuine parts must be preserved when no excluded rows exist');
    assert.equal(scen2And3Norm.items[2].partNumber, 'J160799200');
    assert.equal(scen2And3Norm.items[2].quantity, 4);
    assert.equal(scen2And3Norm.items[3].partNumber, 'J160799201');
    assert.equal(scen2And3Norm.items[3].quantity, 6);
    passed += 5;

    // Scenario 7.4: GCI docket containing genuine parts with additional manufacturing descriptions (TAPPED, NO CSK, COUNTERSINK, **OFFCUT SUPPLIED**)
    const scen4Norm = validateAndNormalizeGeminiDocket(
      {
        docketNumber: '194322',
        jobNumber: '194322',
        orderNumber: '72018',
        deliveryDate: '2026-11-12',
        supplier: 'GCI',
        confidenceScore: 99,
        needsManualReview: false,
        items: [
          { itemNumber: '1', partNumber: '1YY8231', description: '1YY8231 - TAPPED', rev: 'A', quantity: 10, confidence: 'high' },
          { itemNumber: '2', partNumber: 'J160798105', description: 'J160798105 - NO CSK', rev: '0', quantity: 4, confidence: 'high' },
          { itemNumber: '3', partNumber: 'J160798103', description: 'J160798103 - COUNTERSINK', rev: '0', quantity: 2, confidence: 'high' },
          { itemNumber: '4', partNumber: 'OFFCUT', description: '**OFFCUT SUPPLIED** 495 X 735', rev: '0', quantity: 1, confidence: 'high' },
          { itemNumber: '5', partNumber: 'CUSTOMER-LABELS', description: 'CUSTOMER LABELS', rev: 'A', quantity: 1, confidence: 'high' },
          { itemNumber: '6', partNumber: 'DELIVERY_EXCL', description: 'CUSTOMERS TRANSPORT', rev: '0', quantity: 1, confidence: 'high' },
        ],
      },
      'gci'
    );
    assert.equal(scen4Norm.items.length, 4, 'Genuine parts with TAPPED, NO CSK, COUNTERSINK, OFFCUT must be preserved while CUSTOMER-LABELS & DELIVERY_EXCL are excluded');
    assert.equal(scen4Norm.items[0].partNumber, '1YY8231');
    assert.equal(scen4Norm.items[0].description, '1YY8231 - TAPPED');
    assert.equal(scen4Norm.items[0].quantity, 10);
    assert.equal(scen4Norm.items[0].revision, 'A');
    assert.equal(scen4Norm.items[1].partNumber, 'J160798105');
    assert.equal(scen4Norm.items[1].description, 'J160798105 - NO CSK');
    assert.equal(scen4Norm.items[1].quantity, 4);
    assert.equal(scen4Norm.items[2].partNumber, 'J160798103');
    assert.equal(scen4Norm.items[2].description, 'J160798103 - COUNTERSINK');
    assert.equal(scen4Norm.items[3].partNumber, 'OFFCUT');

    const scen4TextParsed = parseIndustrialDocketText(
      [
        { text: 'GOLDEN COAST INDUSTRIAL - DELIVERY DOCKET', confidence: 99, pageNumber: 1 },
        { text: 'Client Order No: 72018   Job No: 194322   Despatch Date: 12/11/2026', confidence: 99, pageNumber: 1 },
        { text: 'Line Client Part Code Part Description Rev Ord/Q Desp', confidence: 99, pageNumber: 1 },
        { text: '1 1YY8231 1YY8231 - TAPPED A 10 10', confidence: 99, pageNumber: 1 },
        { text: '2 J160798105 J160798105 - NO CSK 0 4 4', confidence: 99, pageNumber: 1 },
        { text: '3 J160798103 J160798103 - COUNTERSINK 0 2 2', confidence: 99, pageNumber: 1 },
        { text: '4 CUSTOMER-LABELS CUSTOMER LABELS A 1 1', confidence: 99, pageNumber: 1 },
        { text: '5 DELIVERY_EXCL CUSTOMERS TRANSPORT 0 1 1', confidence: 99, pageNumber: 1 },
      ],
      1,
      'gci'
    );
    assert.equal(scen4TextParsed.items.length, 3);
    assert.equal(scen4TextParsed.items[0].partNumber, '1YY8231');
    assert(scen4TextParsed.items[0].description.includes('TAPPED'), 'TAPPED description must be preserved in text parser');
    assert.equal(scen4TextParsed.items[1].partNumber, 'J160798105');
    assert(scen4TextParsed.items[1].description.includes('NO CSK'), 'NO CSK description must be preserved in text parser');
    passed += 16;

    // Scenario 7.5: Multiple GCI dockets in one PDF containing CUSTOMER-LABELS and DELIVERY_EXCL
    globalThis.fetch = (async () =>
      geminiJsonResponse({
        pageHeaders: [
          { page: 1, docketNumber: '72018', jobNumber: '194322', orderNumber: '72018', deliveryDate: '12/11/2026', startsNewDocket: false },
          { page: 2, docketNumber: '72019', jobNumber: '194346', orderNumber: '72019', deliveryDate: '09/11/2026', startsNewDocket: true },
        ],
        items: [
          { page: 1, no: '1', part: '1YY8231', desc: '1YY8231 - TAPPED', rev: 'A', qty: 10 },
          { page: 1, no: '2', part: 'CUSTOMER-LABELS', desc: 'CUSTOMER LABELS', rev: 'A', qty: 1 },
          { page: 1, no: '3', part: 'DELIVERY_EXCL', desc: 'CUSTOMERS TRANSPORT', rev: '0', qty: 1 },
          { page: 2, no: '1', part: 'J160799102', desc: 'J160799102', rev: '0', qty: 1 },
          { page: 2, no: '2', part: 'J160799103', desc: 'J160799103', rev: '0', qty: 1 },
          { page: 2, no: '3', part: 'CUSTOMER LABELS', desc: 'CUSTOMER LABELS', rev: 'A', qty: 1 },
          { page: 2, no: '4', part: 'DELIVERY EXCL', desc: 'CUSTOMERS TRANSPORT', rev: '0', qty: 1 },
        ],
      })) as typeof fetch;

    const scen5MultiRes = await workerEntry.fetch(
      new Request('http://localhost:3000/api/extract-docket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierHint: 'gci',
          pageSlices: [{ fullDataUrl: gciDataUrl }, { fullDataUrl: gciDataUrl }],
        }),
      }),
      env
    );
    assert.equal(scen5MultiRes.status, 200);
    const scen5MultiJson: any = await scen5MultiRes.json();
    assert.equal(scen5MultiJson.separatedDockets.length, 2);
    assert.equal(scen5MultiJson.separatedDockets[0].docketNumber, '194322');
    assert.equal(scen5MultiJson.separatedDockets[0].items.length, 1);
    assert.equal(scen5MultiJson.separatedDockets[0].items[0].partNumber, '1YY8231');
    assert.equal(scen5MultiJson.separatedDockets[1].docketNumber, '194346');
    assert.equal(scen5MultiJson.separatedDockets[1].items.length, 2);
    assert.deepEqual(
      scen5MultiJson.separatedDockets[1].items.map((i: any) => i.partNumber),
      ['J160799102', 'J160799103']
    );

    const scen5Norm = validateAndNormalizeGeminiDocket(scen5MultiJson, 'gci');
    assert.equal(scen5Norm.separatedDockets?.length, 2);
    assert.deepEqual(scen5Norm.separatedDockets?.[0].missingRowNumbers || [], []);
    assert.deepEqual(scen5Norm.separatedDockets?.[1].missingRowNumbers || [], []);
    passed += 11;

    // Scenario 7.6: Non-GCI supplier imports (laser_central, ocr_label) remain completely unaffected
    globalThis.fetch = (async () =>
      geminiJsonResponse({
        docketNumber: 'LC-9001',
        supplier: 'Laser Central',
        deliveryDate: '2026-11-12',
        orderNumber: 'PO-9001',
        pageHeaders: [
          { page: 1, docketNumber: 'LC-9001', supplier: 'Laser Central', deliveryDate: '2026-11-12', orderNumber: 'PO-9001' },
        ],
        items: [
          { page: 1, no: '1', part: 'LC-101', desc: 'Bracket', qty: 3 },
          { page: 1, no: '2', part: 'CUSTOMER-LABELS', desc: 'CUSTOMER LABELS', qty: 1 },
          { page: 1, no: '3', part: 'DELIVERY_EXCL', desc: 'CUSTOMERS TRANSPORT', qty: 1 },
        ],
      })) as typeof fetch;

    const scen6NonGciRes = await workerEntry.fetch(
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
    assert.equal(scen6NonGciRes.status, 200);
    const scen6NonGciJson: any = await scen6NonGciRes.json();
    assert.equal(scen6NonGciJson.items.length, 3, 'Non-GCI supplier must NOT apply GCI-specific row exclusions');
    const scen6Norm = validateAndNormalizeGeminiDocket(scen6NonGciJson, 'laser_central');
    assert.equal(scen6Norm.items.length, 3, 'Non-GCI client normalization must NOT apply GCI-specific row exclusions');
    passed += 3;

    console.log('  ✅ PASS: All 6 GCI non-part exclusion scenarios & safeguards verified');
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

  console.log(`\n🎉 ALL ${passed} GCI OCR MAPPING, EXCLUSION & REGRESSION ASSERTIONS PASSED!`);
}

runTests().catch((err) => {
  console.error('❌ GCI test suite failed:', err);
  process.exit(1);
});

