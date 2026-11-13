import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  performSmartDocketExtraction,
  DocketOfflineError,
} from '../src/utils/offlineOcr.ts';
import { validateAndNormalizeGeminiDocket } from '../src/utils/docketParser.ts';

async function runEndToEnd() {
  console.log('=== PartTrack Gemini-First Real Docket Fixture E2E Verification ===\n');

  const fixtures = [
    path.resolve(process.cwd(), 'public/assets/aistudio/20261110_145129_65392c1d.jpg'),
    path.resolve(process.cwd(), 'public/assets/aistudio/20261113_141321_b0b57d18.jpg'),
  ];

  for (const fixturePath of fixtures) {
    assert(fs.existsSync(fixturePath), `Expected real docket fixture at ${fixturePath}`);
  }

  const primaryBuf = fs.readFileSync(fixtures[0]);
  const base64DataUrl = `data:image/jpeg;base64,${primaryBuf.toString('base64')}`;

  // 1. Offline upload throws DocketOfflineError (no fake OCR)
  await assert.rejects(
    () => performSmartDocketExtraction([base64DataUrl], undefined, true),
    (err: any) => err instanceof DocketOfflineError && err.code === 'DOCKET_OFFLINE_QUEUED',
    'Offline docket extraction must throw DocketOfflineError instead of running fake offline OCR'
  );
  console.log('  ✅ PASS: Offline extraction rejects with DocketOfflineError for local IndexedDB queueing');

  // 2. Online mocked Gemini E2E pass on real docket fixture bytes
  const mockResponsePayload = {
    docketNumber: 'GCI-88412',
    supplier: 'Golden Coast Industrial',
    customerName: 'Apex Fabrication',
    orderNumber: 'PO-55910',
    deliveryDate: '2026-11-10',
    aiModelUsed: 'gemini-4-hydrogen',
    extractionMethod: 'gemini-vision',
    needsManualReview: false,
    confidenceScore: 95,
    items: [
      {
        itemNumber: '1',
        partNumber: 'GCI-4012-A',
        description: 'Laser Cut Side Plate 10 EA',
        rev: 'A',
        revision: 'A',
        material: '250Gr',
        thickness: '6mm',
        quantity: 10,
        palletNumber: 'Pallet 1',
        confidence: 'high',
      },
      {
        itemNumber: '3',
        partNumber: 'GCI-4015-B',
        description: 'Mounting Bracket 4 EA',
        rev: 'B',
        revision: 'B',
        material: '350Gr',
        thickness: '8mm',
        quantity: 4,
        palletNumber: 'Pallet 1',
        confidence: 'high',
      },
    ],
  };

  let requestedUrl = '';
  const mockFetch: typeof fetch = async (input: any) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify(mockResponsePayload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await performSmartDocketExtraction(
    [base64DataUrl],
    undefined,
    false,
    [{ rawText: 'GCI DELIVERY DOCKET GCI-88412', hasSelectableText: true }],
    {
      supplierHint: 'gci',
      fetchImpl: mockFetch,
      enableTargetedRecovery: false,
    }
  );

  assert(requestedUrl.endsWith('/api/extract-docket'), `Expected call to /api/extract-docket, got ${requestedUrl}`);
  assert.equal(result.extractedData.extractionMethod, 'gemini-vision');
  assert.equal(result.extractedData.aiModelUsed, 'gemini-4-hydrogen');
  assert.equal(result.extractedData.supplier, 'GCI');
  assert.deepEqual(
    result.extractedData.missingRowNumbers,
    [2],
    'Post-Gemini validator should flag missing printed row sequence No. 2'
  );
  assert.equal(result.extractedData.items[0].unit, 'EA');
  assert.equal(result.extractedData.needsManualReview, true);

  // Verify standalone validator on non-part charge filtering
  const chargeFiltered = validateAndNormalizeGeminiDocket({
    ...result.extractedData,
    items: [
      ...result.extractedData.items,
      {
        itemNumber: '4',
        partNumber: 'FREIGHT',
        description: 'DELIVERY CHARGE',
        quantity: 1,
        confidence: 'medium',
      },
    ],
  });
  assert.equal(chargeFiltered.items.length, 2, 'Charge row FREIGHT / DELIVERY CHARGE must be stripped cleanly');

  console.log(
    `  ✅ PASS: Real docket fixture E2E completed (${primaryBuf.byteLength} bytes, sequence gap [2] detected, unit EA extracted, non-part charges stripped)`
  );
}

runEndToEnd().catch((err) => {
  console.error('❌ E2E test failed:', err);
  process.exit(1);
});
