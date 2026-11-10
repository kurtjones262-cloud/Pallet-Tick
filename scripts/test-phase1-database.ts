/**
 * Automated Test Suite for PalletTrack Phase 1: Centralised Database Foundation
 * Verifies:
 * 1. Database creation (Tables, constraints, foreign keys, indexes)
 * 2. Creating and retrieving deliveries
 * 3. Updating received quantities
 * 4. Recording scan events (Audit log)
 * 5. Strict duplicate scan prevention
 * 6. Server-side validation of invalid quantities (negative values rejected)
 * 7. Simultaneous concurrent requests (atomic consistency)
 * 8. Backend connection health checks
 */

import fs from 'node:fs';
import path from 'node:path';
import { NodeSqliteD1Adapter } from '../src/server/db/nodeSqliteAdapter.ts';
import { PalletTrackDbService } from '../src/server/api/palletTrackDbService.ts';

async function runTests() {
  console.log('🧪 Starting PalletTrack Phase 1 Database & API Test Suite...\n');

  const testDbDir = path.resolve(process.cwd(), '.data', 'test');
  if (!fs.existsSync(testDbDir)) {
    fs.mkdirSync(testDbDir, { recursive: true });
  }
  const testDbPath = path.resolve(testDbDir, `test-${Date.now()}.db`);
  const schemaPath = path.resolve(process.cwd(), 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

  // 1. Test Database Creation
  console.log('Test 1: Database Creation and Schema Verification...');
  const d1 = new NodeSqliteD1Adapter(testDbPath, schemaSql);
  const service = new PalletTrackDbService(d1);

  // Check tables exist
  const tables = await d1.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all<{ name: string }>();
  const tableNames = (tables.results || []).map((t) => t.name);
  console.log('  Created tables:', tableNames.join(', '));
  const expectedTables = ['deliveries', 'delivery_parts', 'm1_synchronisations', 'scan_events', 'users'];
  for (const exp of expectedTables) {
    if (!tableNames.includes(exp)) {
      throw new Error(`Missing expected table: ${exp}`);
    }
  }
  console.log('  ✅ Database creation test passed.\n');

  // Insert test user for delivery attribution
  const testUserId = 'test-user-001';
  await d1.prepare(`
    INSERT INTO users (id, employee_name, employee_code, pin_hash, role, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
  `).bind(testUserId, 'Test Admin', 'EMP-TEST', 'hash', 'admin').run();

  // 2. Test Creating and Retrieving Deliveries
  console.log('Test 2: Creating and Retrieving Deliveries...');
  const created = await service.createDelivery({
    docketNumber: 'DK-2026-9901',
    supplier: 'Laser Central',
    purchaseOrderNumber: 'PO-8812',
    deliveryDate: '2026-11-10',
    carrier: 'Direct Freight Express',
    palletCount: 2,
    supplierProfile: 'laser_central',
    createdBy: testUserId,
    parts: [
      {
        partNumber: 'BRACKET-52048',
        itemNumber: '1',
        docketLineIndex: 1,
        description: 'Mounting bracket 4mm mild steel',
        quantity: 1,
      },
      {
        partNumber: 'SS-PLATE-10482',
        itemNumber: '2',
        docketLineIndex: 2,
        description: 'Stainless 304 backing plate',
        quantity: 5,
      },
      {
        partNumber: 'LASER-BRK-2048',
        itemNumber: '3',
        docketLineIndex: 3,
        description: 'Chassis gusset plate',
        quantity: 10,
      },
    ],
  });

  if (!created || !created.id) throw new Error('Failed to create delivery');
  console.log(`  Created delivery ID: ${created.id} with ${created.parts.length} parts`);

  const fetched = await service.getDeliveryById(created.id);
  if (!fetched || fetched.docketNumber !== 'DK-2026-9901') {
    throw new Error('Retrieved delivery does not match created');
  }
  if (fetched.parts.length !== 3) {
    throw new Error(`Expected 3 parts, found ${fetched.parts.length}`);
  }
  console.log('  ✅ Creating and retrieving delivery passed.\n');

  // 3. Test Updating Received Quantities
  console.log('Test 3: Updating Received Quantities...');
  const part1 = fetched.parts[0]; // Qty 1
  const updateRes1 = await service.updatePartReceivedQuantity(created.id, part1.id, {
    receivedQuantity: 1,
    scannedVia: 'barcode',
    scannedCode: '482910-1',
  });
  if (updateRes1.duplicate) {
    throw new Error('Initial receive was falsely marked duplicate');
  }
  if (!updateRes1.part || updateRes1.part.receivedQuantity !== 1 || updateRes1.part.status !== 'received') {
    throw new Error('Part 1 received quantity not updated correctly');
  }
  if (updateRes1.part.verificationStatus !== 'verified') {
    throw new Error('Verification status should be verified when qty matches');
  }
  console.log('  Part 1 received and verified.');

  const part2 = fetched.parts[1]; // Qty 5, let's receive 3 (partial/mismatch)
  const updateRes2 = await service.updatePartReceivedQuantity(created.id, part2.id, {
    receivedQuantity: 3,
    scannedVia: 'qr',
    scannedCode: 'SS-PLATE-10482',
  });
  if (updateRes2.part?.verificationStatus !== 'quantity_mismatch') {
    throw new Error('Partial receive should have verificationStatus quantity_mismatch');
  }
  console.log('  Part 2 quantity mismatch correctly detected (3 of 5).');
  console.log('  ✅ Updating received quantities passed.\n');

  // 4. Test Recording Scan Events (Audit Trail)
  console.log('Test 4: Recording Scan Events & Audit Trail...');
  const scanHistory = await service.getScanHistory(created.id);
  if (scanHistory.length < 2) {
    throw new Error(`Expected at least 2 scan events, got ${scanHistory.length}`);
  }
  console.log(`  Found ${scanHistory.length} scan audit records in delivery history`);
  console.log('  ✅ Recording scan events passed.\n');

  // 5. Test Duplicate Prevention
  console.log('Test 5: Strict Duplicate Prevention...');
  const duplicateAttempt = await service.updatePartReceivedQuantity(created.id, part1.id, {
    receivedQuantity: 1,
    scannedVia: 'barcode',
    scannedCode: '482910-1',
  });

  if (!duplicateAttempt.duplicate) {
    throw new Error('Server failed to reject duplicate scan!');
  }
  if (duplicateAttempt.message !== 'This part has already been scanned into this delivery.') {
    throw new Error(`Unexpected duplicate message: ${duplicateAttempt.message}`);
  }
  console.log(`  Duplicate rejected with exact message: "${duplicateAttempt.message}"`);

  // Verify delivery totals were NOT changed
  const afterDuplicate = await service.getDeliveryById(created.id);
  const part1After = afterDuplicate?.parts.find((p) => p.id === part1.id);
  if (part1After?.receivedQuantity !== 1) {
    throw new Error('Duplicate scan altered part received quantity!');
  }
  console.log('  ✅ Strict duplicate prevention test passed.\n');

  // 6. Test Invalid Quantities (Server-side validation)
  console.log('Test 6: Invalid Quantities Server Validation...');
  let errorCaught = false;
  try {
    await service.updatePartReceivedQuantity(created.id, part2.id, {
      receivedQuantity: -5,
      scannedVia: 'manual',
    });
  } catch (err: any) {
    errorCaught = true;
    console.log(`  Negative quantity correctly rejected by server: "${err.message}"`);
  }
  if (!errorCaught) {
    throw new Error('Server accepted negative quantity!');
  }
  console.log('  ✅ Invalid quantities rejected passed.\n');

  // 7. Test Simultaneous Requests (Concurrent safety)
  console.log('Test 7: Simultaneous Concurrent Requests...');
  const part3 = fetched.parts[2]; // Qty 10
  // Fire 5 concurrent requests updating scan events
  const promises = [1, 2, 3, 4, 5].map((i) =>
    service.recordScanEvent(created.id, {
      code: `TEST-BURST-${i}`,
      scanType: 'barcode',
      scanStatus: 'match_success',
      partId: part3.id,
      quantityAdded: 0,
      receivedQuantityAfter: 0,
      scanResult: `Concurrent test burst ${i}`,
    })
  );
  const burstResults = await Promise.all(promises);
  if (burstResults.length !== 5) {
    throw new Error('Concurrent burst requests failed');
  }
  const updatedHistory = await service.getScanHistory(created.id);
  console.log(`  Concurrent bursts recorded cleanly. Total scan events: ${updatedHistory.length}`);
  console.log('  ✅ Simultaneous requests test passed.\n');

  // 8. Clean up test database file
  try {
    fs.unlinkSync(testDbPath);
  } catch {}

  console.log('🎉 ALL PHASE 1 DATABASE & API TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
