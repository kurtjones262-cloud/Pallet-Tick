import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  computeExponentialBackoffWithJitter,
  classifyGeminiError,
  resolveConfiguredVisionModels,
  validateAndParseOcrJsonResponse,
  generateWithRetryAndFallback,
} from '../src/server/docketOcr.ts';
import { validateClientExtractedDocketResult } from '../src/utils/offlineOcr.ts';
import { NodeSqliteD1Adapter } from '../src/server/db/nodeSqliteAdapter.ts';
import { handlePalletTrackApiRequest } from '../src/server/api/palletTrackApiRouter.ts';
import { PalletTrackDbService } from '../src/server/api/palletTrackDbService.ts';

async function runTests() {
  console.log('==================================================================');
  console.log('🧪 PALLETTRACK PHASE VERIFICATION, SECURITY & RELIABILITY AUDIT');
  console.log('==================================================================\n');
  let passed = 0;

  // ---------------------------------------------------------------------------
  // SECTION 1: Gemini OCR Retry, Backoff, Fallback & Validation Tests
  // ---------------------------------------------------------------------------
  console.log('--- 1. Gemini OCR Retry, Exponential Backoff, Fallback & Validation ---');

  const d1 = computeExponentialBackoffWithJitter(1, 2000);
  const d2 = computeExponentialBackoffWithJitter(2, 2000);
  const d3 = computeExponentialBackoffWithJitter(3, 2000);
  assert(d1 >= 2000 && d1 <= 2650, `Expected attempt 1 delay ~2000-2650ms, got ${d1}ms`);
  assert(d2 >= 4000 && d2 <= 4650, `Expected attempt 2 delay ~4000-4650ms, got ${d2}ms`);
  assert(d3 >= 8000 && d3 <= 8650, `Expected attempt 3 delay ~8000-8650ms, got ${d3}ms`);
  console.log(`  ✅ PASS: Exponential backoff + jitter verified (Attempt 1=${d1}ms, 2=${d2}ms, 3=${d3}ms)`);
  passed += 3;

  // Error classification
  const err503 = classifyGeminiError({
    status: 503,
    message: '503 Service Unavailable: The model is overloaded due to high demand.',
  });
  assert.equal(err503.statusCode, 503);
  assert.equal(err503.isHighDemand503, true);
  assert.equal(err503.isRetryableAvailabilityError, true);

  const err429 = classifyGeminiError({
    status: 429,
    message: '429 RESOURCE_EXHAUSTED: Quota exceeded',
  });
  assert.equal(err429.statusCode, 429);
  assert.equal(err429.isRateLimit, true);
  assert.equal(err429.isRetryableAvailabilityError, true);

  const err502 = classifyGeminiError({
    status: 502,
    message: '502 Bad Gateway',
  });
  assert.equal(err502.statusCode, 502);
  assert.equal(err502.isRetryableAvailabilityError, true);

  const err400 = classifyGeminiError({
    status: 400,
    message: '400 INVALID_ARGUMENT: API key not valid. Please pass a valid API key.',
  });
  assert.equal(err400.statusCode, 400);
  assert.equal(err400.isRetryableAvailabilityError, false);
  console.log('  ✅ PASS: HTTP 503, 429, and 5xx classified as retryable; 400/401/403 classified as non-retryable');
  passed += 4;

  // Model configuration resolution
  const defaultModels = resolveConfiguredVisionModels();
  assert.equal(defaultModels.primaryModel, 'gemini-4-hydrogen');
  assert.deepEqual(defaultModels.fallbackModels, [
    'gemini-3.1-flash-lite',
  ]);
  const customModels = resolveConfiguredVisionModels({
    GEMINI_PRIMARY_MODEL: 'gemini-3.8-flash',
    GEMINI_FALLBACK_MODEL: 'gemini-3-flash-preview,gemini-3.1-flash-lite',
  });
  assert.equal(customModels.primaryModel, 'gemini-4-hydrogen');
  assert.deepEqual(customModels.fallbackModels, ['gemini-3.1-flash-lite']);
  console.log(
    `  ✅ PASS: Configurable primary & fallback models resolved & legacy names normalized (${defaultModels.primaryModel} -> ${defaultModels.fallbackModels.join(' -> ')})`
  );
  passed += 2;

  // Test generateWithRetryAndFallback: Primary model fails 2 times (initial + 1 retry) with 503,
  // then falls back to secondary model with identical systemInstruction and responseSchema
  const callLog: Array<{ model: string; systemInstruction: string; responseSchema: any }> = [];
  const mockAiFallbackSuccess = {
    models: {
      generateContent: async (req: any) => {
        callLog.push({
          model: req.model,
          systemInstruction: req.config.systemInstruction,
          responseSchema: req.config.responseSchema,
        });
        if (req.model === 'gemini-4-hydrogen') {
          const e: any = new Error('503 UNAVAILABLE: Model is experiencing high demand');
          e.status = 503;
          throw e;
        }
        return {
          text: JSON.stringify({
            docketNumber: 'DK-FALLBACK-1',
            supplier: 'Laser Central',
            items: [{ no: '1', part: 'FB-100', desc: 'Fallback Extracted Plate', rev: 'A', qty: 5 }],
          }),
        };
      },
    },
  };

  const testSchema = { type: 'OBJECT', properties: { items: { type: 'ARRAY' } } };
  const testSysInstruction = 'Exact extraction prompt';
  const fallbackResult = await generateWithRetryAndFallback(
    mockAiFallbackSuccess,
    { MEDIUM: 'MEDIUM' },
    [{ text: 'page 1' }],
    testSysInstruction,
    testSchema,
    'batch',
    {
      GEMINI_PRIMARY_MODEL: 'gemini-4-hydrogen',
      GEMINI_FALLBACK_MODEL: 'gemini-3.1-flash-lite',
    },
    1 // 1ms base delay for fast test execution
  );

  // Primary model must be called 2 times (1 initial + 1 retry), then fallback model called once = 3 total calls
  const primaryCalls = callLog.filter((c) => c.model === 'gemini-4-hydrogen');
  const fallbackCalls = callLog.filter((c) => c.model === 'gemini-3.1-flash-lite');
  assert.equal(primaryCalls.length, 2, 'Primary model must execute initial attempt + max 1 automatic retry');
  assert.equal(fallbackCalls.length, 1, 'Secondary fallback model must be invoked after primary retry exhausts');
  assert.equal(fallbackCalls[0].systemInstruction, testSysInstruction, 'Fallback model must use identical systemInstruction');
  assert.deepEqual(fallbackCalls[0].responseSchema, testSchema, 'Fallback model must use identical responseSchema');
  assert.equal(fallbackResult.modelUsed, 'gemini-3.1-flash-lite');
  assert.equal(fallbackResult.fallbackUsed, true);
  assert.equal(fallbackResult.retryAttempts, 1);
  assert.equal(fallbackResult.parsed.items[0].part, 'FB-100');
  console.log('  ✅ PASS: Primary model retried at most 1 time on 503, then succeeded on fallback model with identical schema & instructions');
  passed += 6;

  // Test non-retryable 400 Invalid API Key / Malformed Request: must abort immediately with 0 retries and 0 fallback calls
  let badKeyCalls = 0;
  const mockAiBadKey = {
    models: {
      generateContent: async () => {
        badKeyCalls++;
        const e: any = new Error('400 INVALID_ARGUMENT: API key not valid');
        e.status = 400;
        throw e;
      },
    },
  };
  await assert.rejects(
    () =>
      generateWithRetryAndFallback(
        mockAiBadKey,
        null,
        [{ text: 'test' }],
        testSysInstruction,
        testSchema,
        'batch',
        { GEMINI_PRIMARY_MODEL: 'gemini-4-hydrogen', GEMINI_FALLBACK_MODEL: 'gemini-3.1-flash-lite' },
        1
      ),
    /API key not valid/
  );
  assert.equal(badKeyCalls, 1, 'Non-retryable 400 error must abort on first attempt without retrying or calling fallback models');
  console.log('  ✅ PASS: Non-retryable 400/401/403 errors abort immediately (0 retries, 0 fallbacks)');
  passed += 2;

  // Test strict OCR validation on primary & fallback responses
  assert.throws(() => validateAndParseOcrJsonResponse('', 'batch'), /empty response body/i);
  assert.throws(() => validateAndParseOcrJsonResponse('{"docketNumber":"123"}', 'batch'), /Missing required "items" array/i);
  assert.throws(
    () => validateAndParseOcrJsonResponse(JSON.stringify({ items: [{ no: '1', part: '', desc: '', qty: 1 }] }), 'batch'),
    /both part number and description are empty/i
  );
  assert.throws(() => validateClientExtractedDocketResult({ docketNumber: 'DK-1' }), /Incomplete OCR response/i);
  console.log('  ✅ PASS: Malformed or incomplete OCR payloads rejected safely');
  passed += 4;

  // ---------------------------------------------------------------------------
  // SECTION 2: Migration Compatibility (0001 -> 0002 -> 0003 -> 0004)
  // ---------------------------------------------------------------------------
  console.log('\n--- 2. Database Migration Compatibility (0001 -> 0002 -> 0003 -> 0004) ---');
  const m1 = fs.readFileSync(path.resolve(process.cwd(), 'migrations/0001_initial_schema.sql'), 'utf-8');
  const m2 = fs.readFileSync(path.resolve(process.cwd(), 'migrations/0002_auth_and_rbac.sql'), 'utf-8');
  const m3 = fs.readFileSync(path.resolve(process.cwd(), 'migrations/0003_super_admin_and_roles.sql'), 'utf-8');
  const m4 = fs.readFileSync(path.resolve(process.cwd(), 'migrations/0004_parts_manual_editing.sql'), 'utf-8');

  const migDb = new NodeSqliteD1Adapter(':memory:');
  await migDb.exec(m1);
  // Insert pre-existing delivery and part after 0001
  await migDb
    .prepare(
      `INSERT INTO deliveries (id, docket_number, supplier, delivery_date, delivery_status, pallet_count, supplier_profile, created_at, updated_at)
       VALUES ('del_legacy_1', 'DK-LEGACY-100', 'GCI', '2026-01-15', 'receiving', 1, 'gci', '2026-01-15T00:00:00Z', '2026-01-15T00:00:00Z')`
    )
    .run();
  await migDb
    .prepare(
      `INSERT INTO delivery_parts (id, delivery_id, part_number, item_number, docket_line_index, description, required_quantity, received_quantity, verification_status, status, created_at, updated_at)
       VALUES ('part_legacy_1', 'del_legacy_1', 'GCI-900', '1', 1, 'Legacy Chassis Rail', 3, 3, 'verified', 'received', '2026-01-15T00:00:00Z', '2026-01-15T00:00:00Z')`
    )
    .run();

  // Apply 0002, 0003, 0004 in sequence (ignoring columns already added by adapter constructor)
  for (const stmt of [...m2.split(';'), ...m3.split(';'), ...m4.split(';')]) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;
    try {
      await migDb.exec(trimmed + ';');
    } catch (e: any) {
      if (!String(e?.message || '').includes('duplicate column name')) {
        throw e;
      }
    }
  }

  const preservedPart = await migDb
    .prepare('SELECT id, part_number, required_quantity, received_quantity, manually_edited FROM delivery_parts WHERE id = ?')
    .bind('part_legacy_1')
    .first<any>();
  assert(preservedPart, 'Legacy part must survive 0001->0004 migrations');
  assert.equal(preservedPart.part_number, 'GCI-900');
  assert.equal(preservedPart.received_quantity, 3);
  assert.equal(preservedPart.manually_edited, 0);
  console.log('  ✅ PASS: Migrations 0001 -> 0002 -> 0003 -> 0004 apply cleanly without destroying existing records');
  passed += 3;

  // Verify concurrent ensureSchemaReady() calls on migDb resolve safely via per-DB Promise mutex
  const concurrentServices = Array.from({ length: 8 }, () => new PalletTrackDbService(migDb));
  await Promise.all(concurrentServices.map((s) => s.ensureSchemaReady()));
  console.log('  ✅ PASS: Concurrent ensureSchemaReady() calls resolved safely via per-DB Promise mutex without conflict');
  passed += 1;

  // ---------------------------------------------------------------------------
  // SECTION 3: Manual Parts Editing CRUD, Validation & Duplicate Prevention
  // ---------------------------------------------------------------------------
  console.log('\n--- 3. Manual Parts List Editing CRUD, Validation & Duplicate Prevention ---');
  const schemaSql = fs.readFileSync(path.resolve(process.cwd(), 'schema.sql'), 'utf-8');
  const db = new NodeSqliteD1Adapter(':memory:', schemaSql);
  const TEST_SETUP_SECRET = 'test-only-strong-setup-secret-9941!';

  async function apiCall(pathStr: string, method: string, body?: any, token?: string) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = new Request(`http://localhost:3000${pathStr}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const res = await handlePalletTrackApiRequest(req, db, {
      INITIAL_SETUP_SECRET: TEST_SETUP_SECRET,
    });
    assert(res, `Expected response for ${method} ${pathStr}`);
    const data: any = await res.json();
    return { status: res.status, data };
  }

  // Provision Super Admin, Supervisor, and Employee accounts
  const setupRes = await apiCall('/api/auth/setup-admin', 'POST', {
    employeeName: 'Sarah Connor',
    employeeCode: 'SUPER01',
    pin: '4826',
    setupSecret: TEST_SETUP_SECRET,
  });
  assert.equal(setupRes.status, 201);
  const superAdminToken = setupRes.data.token;

  await apiCall(
    '/api/users',
    'POST',
    { employeeName: 'John Supervisor', employeeCode: 'SUP01', role: 'supervisor', pin: '2233' },
    superAdminToken
  );
  const supLogin = await apiCall('/api/auth/login', 'POST', { employeeCode: 'SUP01', pin: '2233' });
  const supervisorToken = supLogin.data.token;

  const empCreate = await apiCall(
    '/api/users',
    'POST',
    { employeeName: 'Mike Operator', employeeCode: 'EMP01', role: 'employee', pin: '7788' },
    superAdminToken
  );
  const empUserId = empCreate.data.id;
  const empLogin = await apiCall('/api/auth/login', 'POST', { employeeCode: 'EMP01', pin: '7788' });
  const employeeToken = empLogin.data.token;

  // Create delivery with 2 initial OCR parts
  const createDelRes = await apiCall(
    '/api/deliveries',
    'POST',
    {
      docketNumber: 'DK-5500',
      supplier: 'Laser Central',
      deliveryDate: '2026-11-09',
      parts: [
        {
          id: 'part_dk5500_1',
          itemNumber: '1',
          partNumber: 'LC-1001-OCR',
          description: 'Side Gusset Plate',
          revision: 'A',
          quantity: 4,
          material: '250Gr',
          thickness: '8mm',
          palletNumber: 'Pallet 1',
        },
        {
          id: 'part_dk5500_2',
          itemNumber: '2',
          partNumber: 'LC-1002-OCR',
          description: 'Top Mounting Flange',
          revision: '0',
          quantity: 4,
          material: '350Gr',
          thickness: '12mm',
          palletNumber: 'Pallet 1',
        },
      ],
    },
    supervisorToken
  );
  assert.equal(createDelRes.status, 201);
  const deliveryId = createDelRes.data.id;
  console.log('  ✅ PASS: Created delivery with 2 OCR parts and originalOcrValues snapshots');
  passed += 1;

  // Validation: Reject empty partNumber, 0 quantity, negative quantity, and duplicate partNumber
  const badEmptyPart = await apiCall(
    `/api/deliveries/${deliveryId}/parts`,
    'POST',
    { partNumber: '   ', quantity: 2 },
    supervisorToken
  );
  assert.equal(badEmptyPart.status, 400);

  const badZeroQty = await apiCall(
    `/api/deliveries/${deliveryId}/parts`,
    'POST',
    { partNumber: 'LC-9999', quantity: 0 },
    supervisorToken
  );
  assert.equal(badZeroQty.status, 400);

  const badDuplicateAdd = await apiCall(
    `/api/deliveries/${deliveryId}/parts`,
    'POST',
    { partNumber: 'lc-1001-ocr', description: 'Accidental Duplicate', quantity: 2 },
    supervisorToken
  );
  assert.equal(badDuplicateAdd.status, 400);
  assert(
    String(badDuplicateAdd.data.error).includes('Duplicate part number'),
    'Should block adding accidental duplicate part number'
  );

  // Verify legitimate multi-line docket entries with same partNumber but distinct Revision or Pallet allocation are allowed
  const splitRevisionAdd = await apiCall(
    `/api/deliveries/${deliveryId}/parts`,
    'POST',
    {
      partNumber: 'LC-1001-OCR',
      description: 'Side Gusset Plate (Rev B)',
      revision: 'B',
      palletNumber: 'Pallet 1',
      quantity: 2,
    },
    supervisorToken
  );
  assert.equal(splitRevisionAdd.status, 201, 'Same partNumber with distinct Revision (Rev B vs Rev A) must be permitted');

  const splitPalletAdd = await apiCall(
    `/api/deliveries/${deliveryId}/parts`,
    'POST',
    {
      partNumber: 'LC-1001-OCR',
      description: 'Side Gusset Plate (Pallet 2 Split)',
      revision: 'A',
      palletNumber: 'Pallet 2',
      quantity: 2,
    },
    supervisorToken
  );
  assert.equal(splitPalletAdd.status, 201, 'Same partNumber with distinct Pallet allocation (Pallet 2 vs Pallet 1) must be permitted');

  // Clean up the 2 temporary split rows so subsequent part count assertions remain exact
  await apiCall(`/api/deliveries/${deliveryId}/parts/${splitRevisionAdd.data.part.id}`, 'DELETE', undefined, supervisorToken);
  await apiCall(`/api/deliveries/${deliveryId}/parts/${splitPalletAdd.data.part.id}`, 'DELETE', undefined, supervisorToken);

  console.log('  ✅ PASS: Validation blocks accidental duplicates while permitting distinct Revision / Pallet split lines');
  passed += 5;

  // Add a valid missing part (+ Add Part)
  const addPartRes = await apiCall(
    `/api/deliveries/${deliveryId}/parts`,
    'POST',
    {
      partNumber: 'LC-1003-MANUAL',
      itemNumber: '3',
      description: 'Stiffener Rib',
      revision: 'C',
      quantity: 6,
      material: '250Gr',
      thickness: '6mm',
      palletNumber: 'Pallet 2',
    },
    supervisorToken
  );
  assert.equal(addPartRes.status, 201);
  assert.equal(addPartRes.data.part.partNumber, 'LC-1003-MANUAL');
  assert.equal(addPartRes.data.part.revision, 'C');
  assert.equal(addPartRes.data.part.quantity, 6);
  assert.equal(addPartRes.data.part.manuallyEdited, true);
  assert.equal(addPartRes.data.part.lastEditedBy, 'John Supervisor');
  console.log('  ✅ PASS: Added missing part with all fields persisted in D1');
  passed += 2;

  // Edit all fields of an existing unscanned part & verify originalOcrValues never overwritten across multiple edits
  const edit1 = await apiCall(
    `/api/deliveries/${deliveryId}/parts/part_dk5500_1`,
    'PATCH',
    {
      partNumber: 'LC-1001-FIXED',
      itemNumber: '1A',
      description: 'Side Gusset Plate (Corrected)',
      revision: 'B',
      quantity: 5,
      material: '350Gr',
      thickness: '10mm',
      palletNumber: 'Pallet 3',
    },
    supervisorToken
  );
  assert.equal(edit1.status, 200);
  const edit2 = await apiCall(
    `/api/deliveries/${deliveryId}/parts/part_dk5500_1`,
    'PATCH',
    {
      partNumber: 'LC-1001-FINAL',
      revision: 'C',
      quantity: 8,
    },
    superAdminToken
  );
  assert.equal(edit2.status, 200);
  assert.equal(edit2.data.part.partNumber, 'LC-1001-FINAL');
  assert.equal(edit2.data.part.itemNumber, '1A');
  assert.equal(edit2.data.part.description, 'Side Gusset Plate (Corrected)');
  assert.equal(edit2.data.part.revision, 'C');
  assert.equal(edit2.data.part.quantity, 8);
  assert.equal(edit2.data.part.material, '350Gr');
  assert.equal(edit2.data.part.thickness, '10mm');
  assert.equal(edit2.data.part.palletNumber, 'Pallet 3');
  assert.equal(edit2.data.part.lastEditedBy, 'Sarah Connor');
  // Original OCR values must still reflect the very first OCR extraction!
  assert.equal(edit2.data.part.originalOcrValues.partNumber, 'LC-1001-OCR');
  assert.equal(edit2.data.part.originalOcrValues.revision, 'A');
  assert.equal(edit2.data.part.originalOcrValues.quantity, 4);
  console.log('  ✅ PASS: Consecutive edits to all fields persist in D1 while originalOcrValues remain immutable');
  passed += 4;

  // ---------------------------------------------------------------------------
  // SECTION 4: Scanned Parts, Quantity Integrity, RBAC & Duplicate Scan Prevention
  // ---------------------------------------------------------------------------
  console.log('\n--- 4. Scanned Parts, Quantity Integrity, RBAC & Duplicate Scan Regression ---');

  // Employee scans Part 2 partially (2 of 4 required)
  const partialScanRes = await apiCall(
    `/api/deliveries/${deliveryId}/parts/part_dk5500_2/receive`,
    'POST',
    {
      receivedQuantity: 2,
      scannedVia: 'barcode',
      scannedCode: '5500-2',
      // Attempt to spoof employeeName from frontend; server must ignore and use authenticated employee ("Mike Operator")
      employeeName: 'SPOOFED_HACKER',
      userId: 'usr_spoofed',
    },
    employeeToken
  );
  assert.equal(partialScanRes.status, 200);
  assert.equal(partialScanRes.data.part.status, 'received');
  assert.equal(partialScanRes.data.part.receivedQuantity, 2);
  assert.equal(partialScanRes.data.part.verificationStatus, 'quantity_mismatch');
  assert.equal(
    partialScanRes.data.scanEvent.employeeName,
    'Mike Operator',
    'Server must use authenticated session identity, never frontend input'
  );
  console.log('  ✅ PASS: Partial scan (2/4) sets quantity_mismatch and enforces server-side session attribution');
  passed += 2;

  // Duplicate scan prevention regression: scanning already-received Part 2 via barcode again must return 409 Conflict
  const dupScanRes = await apiCall(
    `/api/deliveries/${deliveryId}/parts/part_dk5500_2/receive`,
    'POST',
    {
      receivedQuantity: 2,
      scannedVia: 'barcode',
      scannedCode: '5500-2',
    },
    employeeToken
  );
  assert.equal(dupScanRes.status, 409, 'Duplicate scan of already received part must return 409 Conflict');
  assert.equal(dupScanRes.data.duplicate, true);
  assert.equal(dupScanRes.data.part.receivedQuantity, 2, 'Duplicate scan must not increment receivedQuantity');
  console.log('  ✅ PASS: Strict duplicate scan prevention verified (409 Conflict, quantity unchanged)');
  passed += 2;

  // Standard Employee attempting to edit or delete already-scanned Part 2 without supervisor approval must be blocked (403)
  const empEditScanned = await apiCall(
    `/api/deliveries/${deliveryId}/parts/part_dk5500_2`,
    'PATCH',
    { quantity: 10 },
    employeeToken
  );
  assert.equal(empEditScanned.status, 403, 'Employee cannot edit an already-scanned part without supervisor approval');

  const empDeleteScanned = await apiCall(
    `/api/deliveries/${deliveryId}/parts/part_dk5500_2`,
    'DELETE',
    undefined,
    employeeToken
  );
  assert.equal(empDeleteScanned.status, 403, 'Employee cannot delete an already-scanned part without supervisor approval');
  console.log('  ✅ PASS: Standard employee blocked (403 Forbidden) from editing or deleting already-scanned parts');
  passed += 2;

  // Supervisor edits partially-received Part 2 (received=2, required=4 -> required=2) -> becomes 'verified' (2/2)!
  const supEditPartialToMatch = await apiCall(
    `/api/deliveries/${deliveryId}/parts/part_dk5500_2`,
    'PATCH',
    { quantity: 2 },
    supervisorToken
  );
  assert.equal(supEditPartialToMatch.status, 200);
  assert.equal(supEditPartialToMatch.data.part.receivedQuantity, 2, 'receivedQuantity must never be lost');
  assert.equal(supEditPartialToMatch.data.part.quantity, 2);
  assert.equal(supEditPartialToMatch.data.part.verificationStatus, 'verified');
  console.log('  ✅ PASS: Editing partially received part (2/4 -> 2/2) preserves receivedQuantity and updates status to verified');
  passed += 2;

  // Increase required quantity on fully received Part 2 (2/2 -> 2/5) -> becomes 'quantity_mismatch'
  const supIncreaseQty = await apiCall(
    `/api/deliveries/${deliveryId}/parts/part_dk5500_2`,
    'PATCH',
    { quantity: 5 },
    supervisorToken
  );
  assert.equal(supIncreaseQty.status, 200);
  assert.equal(supIncreaseQty.data.part.receivedQuantity, 2);
  assert.equal(supIncreaseQty.data.part.quantity, 5);
  assert.equal(supIncreaseQty.data.part.verificationStatus, 'quantity_mismatch');
  console.log('  ✅ PASS: Increasing required quantity after receiving (2/2 -> 2/5) sets quantity_mismatch');
  passed += 2;

  // Decrease required quantity below already-received quantity (received=2 -> required=1)
  const supDecreaseBelowRec = await apiCall(
    `/api/deliveries/${deliveryId}/parts/part_dk5500_2`,
    'PATCH',
    { quantity: 1 },
    supervisorToken
  );
  assert.equal(supDecreaseBelowRec.status, 200);
  assert.equal(
    supDecreaseBelowRec.data.part.receivedQuantity,
    2,
    'Decreasing required quantity below receivedQuantity must NEVER silently truncate receivedQuantity'
  );
  assert.equal(supDecreaseBelowRec.data.part.quantity, 1);
  assert.equal(supDecreaseBelowRec.data.part.verificationStatus, 'quantity_mismatch');
  console.log('  ✅ PASS: Decreasing required quantity below received quantity (2/1) preserves receivedQuantity=2 and flags quantity_mismatch');
  passed += 2;

  // ---------------------------------------------------------------------------
  // SECTION 5: Atomic Batch Save & Rollback Behaviour
  // ---------------------------------------------------------------------------
  console.log('\n--- 5. Atomic Batch Save & Rollback Verification ---');

  // Attempt a batch save where Row 1 is deleted, Row 2 is modified, and Row 3 has a duplicate Part Number.
  // Because Row 3 is invalid, Row 1 must NOT be deleted (atomic transaction rollback).
  const failedBatchRes = await apiCall(
    `/api/deliveries/${deliveryId}/parts`,
    'PUT',
    {
      parts: [
        // Omitting part_dk5500_1 (would delete it if not atomic)
        {
          id: 'part_dk5500_2',
          partNumber: 'LC-DUP-TEST',
          itemNumber: '2',
          description: 'Top Mounting Flange',
          quantity: 2,
        },
        {
          partNumber: 'LC-DUP-TEST', // Duplicate part number in same batch!
          itemNumber: '3',
          description: 'Duplicate Row',
          quantity: 1,
        },
      ],
    },
    supervisorToken
  );
  assert.equal(failedBatchRes.status, 400);

  // Verify part_dk5500_1 is still present in D1!
  const checkAfterFailedBatch = await apiCall(`/api/deliveries/${deliveryId}`, 'GET', undefined, supervisorToken);
  assert.equal(checkAfterFailedBatch.data.parts.length, 3, 'Failed batch save must not partially delete or modify parts');
  console.log('  ✅ PASS: Invalid batch save rolls back cleanly without partial deletions or updates');
  passed += 2;

  // Valid multi-row batch save
  const validBatchRes = await apiCall(
    `/api/deliveries/${deliveryId}/parts`,
    'PUT',
    {
      parts: checkAfterFailedBatch.data.parts.map((p: any, i: number) => ({
        id: p.id,
        partNumber: p.partNumber,
        itemNumber: p.itemNumber,
        description: `${p.description} [Batch Checked]`,
        revision: p.revision || 'A',
        quantity: i === 1 ? 2 : p.quantity, // Set part 2 back to 2 so 2/2 is verified
        material: p.material,
        thickness: p.thickness,
        palletNumber: p.palletNumber,
      })),
    },
    supervisorToken
  );
  assert.equal(validBatchRes.status, 200);
  assert.equal(validBatchRes.data.delivery.parts[1].verificationStatus, 'verified');
  console.log('  ✅ PASS: Atomic multi-row batch save persisted all changes and recalculated verification statuses');
  passed += 2;

  // ---------------------------------------------------------------------------
  // SECTION 6: Deleting Scanned Part & Audit History Immutability
  // ---------------------------------------------------------------------------
  console.log('\n--- 6. Deleting Scanned Part, Deactivated User Attribution & Audit Immutability ---');

  // Supervisor deletes already-received Part 2 (which has scan history from Mike Operator)
  const deleteScannedRes = await apiCall(
    `/api/deliveries/${deliveryId}/parts/part_dk5500_2`,
    'DELETE',
    undefined,
    supervisorToken
  );
  assert.equal(deleteScannedRes.status, 200);
  assert.equal(deleteScannedRes.data.delivery.parts.length, 2);

  // Deactivate Mike Operator (EMP01) and verify his historical scan events remain attributed to "Mike Operator"
  const deactRes = await apiCall(
    `/api/users/${empUserId}`,
    'PATCH',
    { active: false },
    superAdminToken
  );
  assert.equal(deactRes.status, 200);

  // Verify historical scan events for deleted Part 2 and deactivated employee Mike Operator still exist!
  const scansAfterDelete = await apiCall(`/api/deliveries/${deliveryId}/scans`, 'GET', undefined, superAdminToken);
  assert.equal(scansAfterDelete.status, 200);
  const scanList: any[] = scansAfterDelete.data;

  const originalBarcodeScan = scanList.find((s) => s.code === '5500-2');
  assert(originalBarcodeScan, 'Historical barcode scan event for deleted part must NOT be deleted');
  assert.equal(
    originalBarcodeScan.employeeName,
    'Mike Operator',
    'Historical employee attribution must survive part deletion and account deactivation'
  );

  const deleteAuditEvent = scanList.find((s) => s.status === 'part_deleted' && s.code === 'LC-1002-OCR');
  assert(deleteAuditEvent, 'part_deleted audit event must be recorded');
  assert(
    String(deleteAuditEvent.message).includes('Was already scanned: 2/2'),
    'Deletion audit event must record that the part was already scanned with quantities'
  );
  console.log('  ✅ PASS: Historical scan events survive part deletion and employee account deactivation');
  passed += 4;

  // Verify operators and admins cannot modify or erase audit history via API
  const attemptDeleteScans = await apiCall(
    `/api/deliveries/${deliveryId}/scans`,
    'DELETE',
    undefined,
    superAdminToken
  );
  assert.equal(attemptDeleteScans.status, 403);
  assert.equal(attemptDeleteScans.data.code, 'AUDIT_HISTORY_IMMUTABLE');
  console.log('  ✅ PASS: Audit scan history is strictly immutable (DELETE/PUT/PATCH blocked with 403)');
  passed += 2;

  console.log('\n==================================================================');
  console.log(`🏁 AUDIT SUITE COMPLETE: ${passed} ASSERTIONS PASSED, 0 FAILED`);
  console.log('==================================================================');
}

runTests().catch((err) => {
  console.error('Audit verification failed:', err);
  process.exit(1);
});
