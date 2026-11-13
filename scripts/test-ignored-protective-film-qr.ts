/**
 * Verification Suite: Protective Film QR Code Exclusion
 *
 * Verifies:
 * 1. The attached protective film QR image decodes to the exact excluded payload.
 * 2. The excluded QR payload is silently ignored in single-docket, group-scan, and frame batch detection.
 * 3. Only the exact excluded QR payload is ignored (no false positives on other QRs/URLs/barcodes).
 * 4. Legitimate part QR codes and 1D barcodes still match and scan normally in both individual and group mode.
 * 5. Excluded QR cannot mutate docket quantities or generate scan events/warnings on client or backend.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { NodeSqliteD1Adapter } from '../src/server/db/nodeSqliteAdapter.ts';
import { handlePalletTrackApiRequest } from '../src/server/api/palletTrackApiRouter.ts';
import {
  IGNORED_NON_PART_QR_PAYLOADS,
  isIgnoredNonPartQrPayload,
  filterOutIgnoredQrDetections,
} from '../src/utils/ignoredQrCodes.ts';
import {
  findMatchingPartsInDelivery,
  findMatchingPartsInGroup,
  processScannedCode,
} from '../src/utils/storage.ts';
import type { Delivery } from '../src/types/delivery.ts';

const require = createRequire(import.meta.url);

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function apiCall(
  db: NodeSqliteD1Adapter,
  urlPath: string,
  method: string,
  token?: string,
  body?: unknown,
  env: Record<string, string> = { INITIAL_SETUP_SECRET: 'test-setup-secret-9999' }
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const req = new Request(`http://localhost:3000${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await handlePalletTrackApiRequest(req, db, env);
  if (!res) return { status: 404, data: { error: 'Not found' } };
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function runTests() {
  console.log('🧪 Starting Protective Film QR Exclusion Verification...\n');

  // 1. Decode the uploaded protective film QR photograph using ZXing (same engine as html5-qrcode)
  console.log('1. Verifying exact QR payload decoded from uploaded photo...');
  const photoPath = path.resolve(process.cwd(), 'public/assets/aistudio/20261113_151458_0df9c6d9.jpg');
  assert(fs.existsSync(photoPath), 'Uploaded QR photo exists');

  const tmpRaw = `/tmp/pt_verify_qr_${Date.now()}.raw`;
  let decodedFromPhoto = '';
  try {
    execSync(
      `convert "${photoPath}" -crop 1300x1300+1550+1050 +repage -channel R -separate +channel -blur 0x8 -lat 200x200-2% -resize 400x400 gray:"${tmpRaw}"`
    );
    const buf = new Uint8ClampedArray(fs.readFileSync(tmpRaw));
    const ZXing = require('../node_modules/html5-qrcode/third_party/zxing-js.umd.js');
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.QR_CODE]);
    const reader = new ZXing.MultiFormatReader();
    reader.setHints(hints);
    const src = new ZXing.RGBLuminanceSource(buf, 400, 400);
    const bmp = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(src));
    const result = reader.decode(bmp, hints);
    decodedFromPhoto = result.getText();
  } finally {
    if (fs.existsSync(tmpRaw)) fs.unlinkSync(tmpRaw);
  }

  assert(
    decodedFromPhoto === 'https://www.novacel-solutions.com/qr/46',
    `Decoded QR payload should be exact URL, got "${decodedFromPhoto}"`
  );
  assert(
    IGNORED_NON_PART_QR_PAYLOADS.includes(decodedFromPhoto),
    'Decoded QR payload is present in IGNORED_NON_PART_QR_PAYLOADS'
  );
  console.log(`   ✓ Decoded & matched exact payload: ${decodedFromPhoto}`);

  // 2. Exact match & safeguard checks (no overly broad exclusion)
  console.log('2. Verifying exact-match safeguards...');
  assert(isIgnoredNonPartQrPayload(decodedFromPhoto) === true, 'Exact payload is ignored');
  assert(isIgnoredNonPartQrPayload(`  ${decodedFromPhoto}\n`) === true, 'Whitespace-padded exact payload is ignored');
  assert(isIgnoredNonPartQrPayload('https://www.novacel-solutions.com/qr/47') === false, 'Similar URL /qr/47 is NOT ignored');
  assert(isIgnoredNonPartQrPayload('https://www.novacel-solutions.com/qr/4') === false, 'Prefix URL is NOT ignored');
  assert(isIgnoredNonPartQrPayload('https://www.novacel-solutions.com') === false, 'Base domain is NOT ignored');
  assert(isIgnoredNonPartQrPayload('GCI-PN-88412') === false, 'Legitimate part QR is NOT ignored');
  assert(isIgnoredNonPartQrPayload('194252-1') === false, 'Legitimate barcode is NOT ignored');
  assert(isIgnoredNonPartQrPayload('') === false, 'Empty string returns false');
  assert(isIgnoredNonPartQrPayload(null) === false, 'Null returns false');

  const mixedDetections = [
    { rawValue: decodedFromPhoto, format: 'qr_code' },
    { rawValue: 'GCI-PN-88412', format: 'qr_code' },
    { rawValue: '194252-1', format: 'code_128' },
  ];
  const filtered = filterOutIgnoredQrDetections(mixedDetections, (d) => d.rawValue);
  assert(filtered.length === 2, 'Mixed camera frame drops ONLY excluded QR and keeps legitimate detections');
  assert(filtered[0].rawValue === 'GCI-PN-88412' && filtered[1].rawValue === '194252-1', 'Legitimate detections preserved in order');
  console.log('   ✓ Exact-match & mixed-frame detection filters verified');

  // 3. Individual docket & group matching guards
  console.log('3. Verifying individual & group client scan guards...');
  const sampleGciDelivery: Delivery = {
    id: 'del-gci-1',
    docketNumber: '194252/1',
    supplier: 'GCI',
    supplierProfile: 'gci',
    deliveryDate: '2026-11-13',
    status: 'receiving',
    docketAttachments: [],
    parts: [
      {
        id: 'part-gci-1',
        docketLineIndex: 0,
        itemNumber: '1',
        partNumber: 'GCI-PN-88412',
        description: 'Stainless Panel A',
        quantity: 2,
        status: 'outstanding',
        verificationStatus: 'unscanned',
      },
      // Edge case: even if raw code string happened to look related, exact ignored payload must never match
      {
        id: 'part-gci-2',
        docketLineIndex: 1,
        itemNumber: '2',
        partNumber: 'GCI-PN-99100',
        description: 'Stainless Panel B',
        quantity: 1,
        status: 'outstanding',
        verificationStatus: 'unscanned',
      },
    ],
    unexpectedParts: [],
    scanHistory: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const sampleLaserDelivery: Delivery = {
    id: 'del-lc-1',
    docketNumber: '194255',
    supplier: 'Laser Central',
    supplierProfile: 'laser_central',
    deliveryDate: '2026-11-13',
    status: 'receiving',
    docketAttachments: [],
    parts: [
      {
        id: 'part-lc-1',
        docketLineIndex: 0,
        itemNumber: '7',
        partNumber: 'LC-PLATE-01',
        description: 'Bracket Plate',
        quantity: 1,
        status: 'outstanding',
        verificationStatus: 'unscanned',
      },
    ],
    unexpectedParts: [],
    scanHistory: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  assert(
    findMatchingPartsInDelivery(sampleGciDelivery, decodedFromPhoto).length === 0,
    'Excluded QR returns 0 matches in individual docket mode'
  );
  assert(
    findMatchingPartsInGroup([sampleGciDelivery, sampleLaserDelivery], decodedFromPhoto).length === 0,
    'Excluded QR returns 0 matches in group scan mode'
  );

  const ignoredProcessRes = processScannedCode(sampleGciDelivery, decodedFromPhoto);
  assert(ignoredProcessRes.updatedDelivery === sampleGciDelivery, 'Excluded QR does not mutate delivery');
  assert(ignoredProcessRes.result.message === '', 'Excluded QR produces no error/warning message');

  // Verify legitimate QR & barcode still scan normally
  const gciMatches = findMatchingPartsInDelivery(sampleGciDelivery, 'GCI-PN-88412');
  assert(gciMatches.length === 1 && gciMatches[0].part.partNumber === 'GCI-PN-88412', 'Legitimate GCI QR matches normally');

  const groupMatches = findMatchingPartsInGroup([sampleGciDelivery, sampleLaserDelivery], '194255-7');
  assert(groupMatches.length === 1 && groupMatches[0].part.partNumber === 'LC-PLATE-01', 'Legitimate Laser Central barcode matches normally in group mode');

  const legitProcessRes = processScannedCode(sampleGciDelivery, 'GCI-PN-99100');
  assert(legitProcessRes.result.status === 'matched', 'Legitimate qty=1 QR commits normally');
  console.log('   ✓ Client individual & group scan guards verified');

  // 4. Backend group scan API guard
  console.log('4. Verifying backend /api/groups/:id/scan protection...');
  const testDbDir = path.resolve(process.cwd(), '.data', 'test');
  fs.mkdirSync(testDbDir, { recursive: true });
  const testDbPath = path.resolve(testDbDir, `test-ignored-qr-${Date.now()}.db`);
  const schemaSql = fs.readFileSync(path.resolve(process.cwd(), 'schema.sql'), 'utf-8');
  const db = new NodeSqliteD1Adapter(testDbPath, schemaSql);

  try {
    const setupRes = await apiCall(db, '/api/auth/setup-admin', 'POST', undefined, {
      employeeName: 'Verifier Admin',
      employeeCode: 'VER01',
      pin: '1234',
      setupSecret: 'test-setup-secret-9999',
    });
    assert(setupRes.status === 201 && Boolean(setupRes.data?.token), 'Admin setup succeeded');
    const token = setupRes.data.token as string;

    const createDel = await apiCall(db, '/api/deliveries', 'POST', token, sampleGciDelivery);
    assert(createDel.status === 200 || createDel.status === 201, 'Created test delivery in DB');

    const createGroup = await apiCall(db, '/api/groups', 'POST', token, {
      name: 'Protective Film Test Group',
      deliveryIds: [sampleGciDelivery.id],
    });
    assert(createGroup.status === 200 || createGroup.status === 201, 'Created test group in DB');
    const groupId = createGroup.data.id as string;

    // Attempt group scan with excluded protective film QR
    const ignoredScanRes = await apiCall(db, `/api/groups/${groupId}/scan`, 'POST', token, {
      scannedCode: decodedFromPhoto,
      scannedVia: 'qr',
    });
    assert(ignoredScanRes.status === 200, `Group scan with excluded QR returns HTTP 200 cleanly (got ${ignoredScanRes.status})`);
    assert(ignoredScanRes.data?.status === 'ignored_non_part_qr', 'Backend flags ignored_non_part_qr');
    assert(ignoredScanRes.data?.matched === false, 'Backend reports matched: false');

    // Confirm part quantity remained untouched and no scan history added
    const afterIgnored = await apiCall(db, `/api/deliveries/${sampleGciDelivery.id}`, 'GET', token);
    assert(afterIgnored.status === 200, 'Fetched delivery after ignored QR');
    assert(
      afterIgnored.data.parts.every((p: any) => p.status === 'outstanding' && (p.receivedQuantity || 0) === 0),
      'All part quantities remain untouched after ignored QR scan'
    );
    assert(
      Array.isArray(afterIgnored.data.scanHistory) && afterIgnored.data.scanHistory.length === 0,
      'Scan history remains empty after ignored QR scan'
    );

    // Confirm legitimate QR scan in the same group succeeds immediately after
    const legitGroupScan = await apiCall(db, `/api/groups/${groupId}/scan`, 'POST', token, {
      scannedCode: 'GCI-PN-88412',
      scannedVia: 'qr',
      receivedQuantity: 2,
      mode: 'set',
    });
    assert(
      legitGroupScan.status === 200 &&
        legitGroupScan.data?.matched === true &&
        legitGroupScan.data?.part?.partNumber === 'GCI-PN-88412' &&
        legitGroupScan.data?.part?.receivedQuantity === 2 &&
        legitGroupScan.data?.part?.status === 'received',
      `Legitimate QR still commits in group scan (got ${JSON.stringify(legitGroupScan.data)})`
    );
    console.log('   ✓ Backend group scan protection & legitimate commit verified\n');
  } finally {
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
  }

  console.log('✅ All Protective Film QR Exclusion verification tests PASSED!');
}

runTests().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
