import assert from 'node:assert/strict';
import {
  computeExponentialBackoffWithJitter,
  classifyGeminiError,
  resolveConfiguredVisionModels,
  validateAndParseOcrJsonResponse,
} from '../src/server/docketOcr.ts';
import fs from 'node:fs';
import path from 'node:path';
import { validateClientExtractedDocketResult } from '../src/utils/offlineOcr.ts';
import { NodeSqliteD1Adapter } from '../src/server/db/nodeSqliteAdapter.ts';
import { handlePalletTrackApiRequest } from '../src/server/api/palletTrackApiRouter.ts';

async function runTests() {
  console.log('=== PalletTrack OCR Reliability & Manual Parts Editing Verification ===\n');
  let passed = 0;

  // ---------------------------------------------------------------------------
  // PART 1: Gemini OCR Retry, Backoff, Fallback & Validation Tests
  // ---------------------------------------------------------------------------
  console.log('1. Testing Exponential Backoff with Jitter (2s base, max 3 retries)...');
  const d1 = computeExponentialBackoffWithJitter(1, 2000);
  const d2 = computeExponentialBackoffWithJitter(2, 2000);
  const d3 = computeExponentialBackoffWithJitter(3, 2000);
  assert(d1 >= 1600 && d1 <= 2650, `Expected attempt 1 delay ~2000ms, got ${d1}ms`);
  assert(d2 >= 3200 && d2 <= 5000, `Expected attempt 2 delay ~4000ms, got ${d2}ms`);
  assert(d3 >= 6400 && d3 <= 9800, `Expected attempt 3 delay ~8000ms, got ${d3}ms`);
  console.log(`   [PASS] Backoff delays with jitter: Attempt 1=${d1}ms, Attempt 2=${d2}ms, Attempt 3=${d3}ms`);
  passed += 3;

  console.log('2. Testing HTTP 503, 429 & 5xx Error Classification...');
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
    message: '400 INVALID_ARGUMENT: Invalid image format',
  });
  assert.equal(err400.statusCode, 400);
  assert.equal(err400.isRetryableAvailabilityError, false);
  console.log('   [PASS] 503, 429, 502 classified as retryable; 400 classified as non-retryable');
  passed += 4;

  console.log('3. Testing Configurable Primary & Secondary Fallback Model Resolution...');
  const defaultModels = resolveConfiguredVisionModels();
  assert.equal(defaultModels.primaryModel, 'gemini-3.8-flash');
  assert(defaultModels.fallbackModels.length >= 1, 'Should include at least one secondary fallback model');
  const customModels = resolveConfiguredVisionModels({
    GEMINI_PRIMARY_MODEL: 'gemini-3.8-flash',
    GEMINI_FALLBACK_MODELS: 'gemini-3-flash-preview,gemini-2.5-pro',
  });
  assert.equal(customModels.primaryModel, 'gemini-3.8-flash');
  assert.deepEqual(customModels.fallbackModels, [
    'gemini-3-flash-preview',
    'gemini-2.5-pro',
  ]);
  console.log(`   [PASS] Models resolved: ${customModels.primaryModel} -> ${customModels.fallbackModels.join(' -> ')}`);
  passed += 2;

  console.log('4. Testing Strict OCR Output Validation (Never silently accept malformed/incomplete OCR)...');
  assert.throws(
    () => validateAndParseOcrJsonResponse('', 'batch'),
    /empty response body/i
  );
  assert.throws(
    () => validateAndParseOcrJsonResponse('{"docketNumber":"123"}', 'batch'),
    /Missing required "items" array/i
  );
  assert.throws(
    () =>
      validateAndParseOcrJsonResponse(
        JSON.stringify({ items: [{ no: '1', part: '', desc: '', qty: 1 }] }),
        'batch'
      ),
    /both part number and description are empty/i
  );
  assert.throws(
    () => validateClientExtractedDocketResult({ docketNumber: 'DK-1' }),
    /Incomplete OCR response/i
  );

  const validParsed = validateAndParseOcrJsonResponse(
    JSON.stringify({
      docketNumber: 'DK-9001',
      supplier: 'Laser Central',
      items: [
        {
          no: '1',
          part: 'PLT-2048',
          desc: 'Base Plate 10mm',
          rev: 'B',
          qty: 4,
        },
      ],
    }),
    'batch'
  );
  assert.equal(validParsed.items.length, 1);
  assert.equal(validParsed.items[0].part, 'PLT-2048');
  assert.equal(validParsed.items[0].rev, 'B');
  console.log('   [PASS] Malformed/incomplete OCR payloads rejected; valid payload with Revision accepted');
  passed += 5;

  // ---------------------------------------------------------------------------
  // PART 2: Manual Parts List Editing, Adding, Deleting & Audit History in D1
  // ---------------------------------------------------------------------------
  console.log('\n5. Testing Central D1 Database Manual Parts Editing & Audit Trail...');
  const schemaSql = fs.readFileSync(path.resolve(process.cwd(), 'schema.sql'), 'utf-8');
  const db = new NodeSqliteD1Adapter(':memory:', schemaSql);

  async function apiCall(path: string, method: string, body?: any, token?: string) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = new Request(`http://localhost:3000${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const res = await handlePalletTrackApiRequest(req, db);
    assert(res, `Expected response for ${method} ${path}`);
    const data: any = await res.json();
    return { status: res.status, data };
  }

  // Provision Super Admin to get session token
  const setupRes = await apiCall('/api/auth/setup-admin', 'POST', {
    employeeName: 'Sarah Connor',
    employeeCode: 'ADMIN01',
    pin: '4826',
    setupSecret: 'PALLETTRACK-SETUP-2026',
  });
  assert.equal(setupRes.status, 201);
  const token = setupRes.data.token;

  // Create a delivery with 2 initial OCR parts
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
          quantity: 2,
          material: '350Gr',
          thickness: '12mm',
          palletNumber: 'Pallet 1',
        },
      ],
    },
    token
  );
  assert.equal(createDelRes.status, 201);
  const deliveryId = createDelRes.data.id;
  assert.equal(createDelRes.data.parts.length, 2);
  assert.equal(createDelRes.data.parts[0].revision, 'A');
  assert.equal(createDelRes.data.parts[0].originalOcrValues.partNumber, 'LC-1001-OCR');
  console.log('   [PASS] Delivery created with initial OCR parts and originalOcrValues');
  passed += 2;

  // Test adding a missing part (+ Add Part)
  const addPartRes = await apiCall(
    `/api/deliveries/${deliveryId}/parts`,
    'POST',
    {
      partNumber: 'LC-1003-MANUAL',
      description: 'Stiffener Rib',
      revision: 'C',
      quantity: 6,
      material: '250Gr',
      thickness: '6mm',
      palletNumber: 'Pallet 2',
    },
    token
  );
  assert.equal(addPartRes.status, 201);
  assert.equal(addPartRes.data.part.partNumber, 'LC-1003-MANUAL');
  assert.equal(addPartRes.data.part.revision, 'C');
  assert.equal(addPartRes.data.part.quantity, 6);
  assert.equal(addPartRes.data.part.manuallyEdited, true);
  assert.equal(addPartRes.data.delivery.parts.length, 3);
  console.log('   [PASS] Added missing part via POST /api/deliveries/:id/parts');
  passed += 2;

  // Test editing an existing unscanned part and preserving original OCR values
  const editUnscannedRes = await apiCall(
    `/api/deliveries/${deliveryId}/parts/part_dk5500_1`,
    'PATCH',
    {
      partNumber: 'LC-1001-FIXED',
      description: 'Side Gusset Plate (Corrected)',
      revision: 'B',
      quantity: 5,
    },
    token
  );
  assert.equal(editUnscannedRes.status, 200);
  const editedPart1 = editUnscannedRes.data.part;
  assert.equal(editedPart1.partNumber, 'LC-1001-FIXED');
  assert.equal(editedPart1.revision, 'B');
  assert.equal(editedPart1.quantity, 5);
  assert.equal(editedPart1.manuallyEdited, true);
  assert.equal(editedPart1.lastEditedBy, 'Sarah Connor');
  // Original OCR values must remain preserved!
  assert.equal(editedPart1.originalOcrValues.partNumber, 'LC-1001-OCR');
  assert.equal(editedPart1.originalOcrValues.revision, 'A');
  assert.equal(editedPart1.originalOcrValues.quantity, 4);
  console.log('   [PASS] Edited part and preserved originalOcrValues + lastEditedBy audit fields');
  passed += 3;

  // Test scanning Part 2 (Qty 2/2 -> verified), then editing its required quantity and checking verificationStatus consistency
  const receiveRes = await apiCall(
    `/api/deliveries/${deliveryId}/parts/part_dk5500_2/receive`,
    'POST',
    {
      receivedQuantity: 2,
      scannedVia: 'barcode',
      scannedCode: '5500-2',
    },
    token
  );
  assert.equal(receiveRes.status, 200);
  assert.equal(receiveRes.data.part.status, 'received');
  assert.equal(receiveRes.data.part.verificationStatus, 'verified');

  // Now edit the already-scanned Part 2's required quantity from 2 to 4
  const editScannedRes = await apiCall(
    `/api/deliveries/${deliveryId}/parts/part_dk5500_2`,
    'PATCH',
    {
      quantity: 4,
      revision: '1',
    },
    token
  );
  assert.equal(editScannedRes.status, 200);
  assert.equal(editScannedRes.data.part.status, 'received');
  assert.equal(editScannedRes.data.part.receivedQuantity, 2);
  assert.equal(editScannedRes.data.part.quantity, 4);
  assert.equal(
    editScannedRes.data.part.verificationStatus,
    'quantity_mismatch',
    'Expected verificationStatus to recalculate to quantity_mismatch (2 received vs 4 required)'
  );
  console.log('   [PASS] Editing an already-scanned part keeps scanning status consistent (2/4 -> quantity_mismatch)');
  passed += 2;

  // Test deleting a part and verifying audit history
  const deleteRes = await apiCall(
    `/api/deliveries/${deliveryId}/parts/part_dk5500_1`,
    'DELETE',
    undefined,
    token
  );
  assert.equal(deleteRes.status, 200);
  assert.equal(deleteRes.data.delivery.parts.length, 2);

  // Verify audit trail in scanHistory contains part_added, part_edited, and part_deleted
  const scanHistory = deleteRes.data.delivery.scanHistory;
  const statuses = new Set(scanHistory.map((s: any) => s.status));
  assert(statuses.has('part_added'), 'Audit history must record part_added');
  assert(statuses.has('part_edited'), 'Audit history must record part_edited');
  assert(statuses.has('part_deleted'), 'Audit history must record part_deleted');
  console.log('   [PASS] Deleted part from docket and verified part_added, part_edited, part_deleted in audit trail');
  passed += 3;

  console.log(`\n=== ALL ${passed} ASSERTIONS PASSED SUCCESSFULLY ===`);
}

runTests().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
