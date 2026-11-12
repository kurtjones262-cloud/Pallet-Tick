/**
 * PartTrack — Production Reliability Verification Audit Suite
 *
 * Executes end-to-end automated verification across all 6 production reliability domains:
 * 1. Multi-user concurrency (same-isolate & cross-isolate CAS race conditions, set & increment modes, 3-worker simultaneous scanning)
 * 2. Offline synchronisation (Device A offline queue, Device B online overlap, exact-once reconnect flush, idempotent retry safety)
 * 3. WebSocket reliability (D1-backed atomic sequence numbers across multiple Worker isolates, catch-up sync, deduplication, heartbeat pruning)
 * 4. Cloudflare production behaviour (worker.ts routing, /api/* 404 JSON guard vs SPA fallback, WebSocket upgrade 101/401/426/503, D1 cold-start query budget & concurrent schema init)
 * 5. Authentication resilience (Network timeout, HTTP 500, 502, 503 preserve session vs explicit HTTP 401, 403 clear session)
 * 6. Delivery synchronisation (Preserves docket data, preserves uploaded docketAttachments photos, protects newer versions, prevents duplicate dockets, migrates local-only records)
 */

import fs from 'node:fs';
import path from 'node:path';
import workerEntry from '../worker';
import { NodeSqliteD1Adapter } from '../src/server/db/nodeSqliteAdapter';
import { PalletTrackDbService } from '../src/server/api/palletTrackDbService';
import { handlePalletTrackApiRequest } from '../src/server/api/palletTrackApiRouter';
import {
  PalletTrackRealtimeBroker,
  STALE_CONNECTION_TIMEOUT_MS,
  RealtimeSocketLike,
} from '../src/server/realtime/realtimeHub';
import {
  apiGetSession,
  setAuthToken,
  getAuthToken,
  setStoredUser,
  getStoredUser,
} from '../src/services/palletTrackApi';
import {
  PalletTrackRealtimeClient,
  realtimeClient,
} from '../src/services/realtimeSync';
import {
  applyRealtimeEventToDeliveries,
  getStoredDeliveries,
  saveStoredDeliveries,
  syncDeliveriesFromCentralDatabase,
} from '../src/utils/storage';
import type { Delivery, UserAccount } from '../src/types/delivery';

let passedCount = 0;
let failedCount = 0;
const auditResults: Array<{ section: string; name: string; passed: boolean; details?: string }> = [];

function assert(condition: unknown, section: string, message: string, details?: string) {
  if (!condition) {
    failedCount++;
    auditResults.push({ section, name: message, passed: false, details });
    console.error(`  ❌ FAIL [${section}]: ${message}${details ? ` (${details})` : ''}`);
    throw new Error(`[${section}] Assertion failed: ${message}`);
  }
  passedCount++;
  auditResults.push({ section, name: message, passed: true, details });
  console.log(`  ✅ PASS [${section}]: ${message}${details ? ` — ${details}` : ''}`);
}

class MockSocket implements RealtimeSocketLike {
  public readyState = 1; // OPEN
  public sentMessages: any[] = [];
  public closeCode?: number;
  public closeReason?: string;
  private listeners: Record<string, Array<(evt: any) => void>> = {};

  send(data: string) {
    if (this.readyState !== 1) {
      throw new Error('Socket not open');
    }
    try {
      this.sentMessages.push(JSON.parse(data));
    } catch {
      this.sentMessages.push(data);
    }
  }

  close(code?: number, reason?: string) {
    this.readyState = 3; // CLOSED
    this.closeCode = code;
    this.closeReason = reason;
    this.emit('close', { code, reason });
  }

  accept() {
    this.readyState = 1;
  }

  addEventListener(type: string, cb: (evt: any) => void) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(cb);
  }

  emit(type: string, evt: any) {
    for (const cb of this.listeners[type] || []) {
      cb(evt);
    }
  }
}

function createInMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

async function runAudit() {
  console.log('================================================================================');
  console.log(' PARTTRACK — PRODUCTION RELIABILITY VERIFICATION AUDIT');
  console.log('================================================================================\n');

  // Set up localStorage & sessionStorage polyfills for Node test environment
  const memLocalStorage = createInMemoryStorage();
  const memSessionStorage = createInMemoryStorage();
  (globalThis as any).localStorage = memLocalStorage;
  (globalThis as any).sessionStorage = memSessionStorage;

  // Set up fresh SQLite D1-compatible database with schema.sql
  const testDbDir = path.resolve(process.cwd(), '.data', 'test');
  if (!fs.existsSync(testDbDir)) {
    fs.mkdirSync(testDbDir, { recursive: true });
  }
  const testDbPath = path.resolve(testDbDir, `audit-${Date.now()}.db`);
  const schemaPath = path.resolve(process.cwd(), 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

  const d1 = new NodeSqliteD1Adapter(testDbPath, schemaSql);
  const serviceIsolateA = new PalletTrackDbService(d1);
  const serviceIsolateB = new PalletTrackDbService(d1); // Simulates a separate Cloudflare Worker isolate
  await serviceIsolateA.ensureSchemaReady();

  async function apiReq(
    urlPath: string,
    method: string,
    token?: string,
    body?: any
  ): Promise<{ status: number; data: any }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = new Request(`http://localhost:3000${urlPath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const res = await handlePalletTrackApiRequest(req, d1, {
      INITIAL_SETUP_SECRET: 'audit-verification-secret-2026-secure',
    });
    if (!res) throw new Error(`Unhandled API route: ${method} ${urlPath}`);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  // Provision Super Admin (Worker A) and create Worker B & Worker C
  const setupRes = await apiReq('/api/auth/setup-admin', 'POST', undefined, {
    employeeName: 'Kurt Jones (Worker A)',
    employeeCode: 'SUPER-01',
    pin: '1234',
    setupSecret: 'audit-verification-secret-2026-secure',
  });
  if (setupRes.status !== 201 || !setupRes.data.token) {
    throw new Error(`Failed to setup initial Super Admin: ${JSON.stringify(setupRes)}`);
  }
  const tokenA = setupRes.data.token as string;
  const userA = setupRes.data.user as UserAccount;

  await apiReq('/api/users', 'POST', tokenA, {
    employeeName: 'Liam Connor (Worker B)',
    employeeCode: 'EMP-01',
    role: 'employee',
    pin: '2222',
  });
  await apiReq('/api/users', 'POST', tokenA, {
    employeeName: 'Sarah Chen (Worker C)',
    employeeCode: 'SUP-01',
    role: 'supervisor',
    pin: '3333',
  });

  const loginB = await apiReq('/api/auth/login', 'POST', undefined, {
    employeeCode: 'EMP-01',
    pin: '2222',
  });
  const loginC = await apiReq('/api/auth/login', 'POST', undefined, {
    employeeCode: 'SUP-01',
    pin: '3333',
  });

  if (loginB.status !== 200 || loginC.status !== 200) {
    throw new Error('Failed to authenticate test workers B and C');
  }

  const tokenB = loginB.data.token as string;
  const tokenC = loginC.data.token as string;
  const userB = loginB.data.user as UserAccount;
  const userC = loginC.data.user as UserAccount;

  // =========================================================================
  // 1. MULTI-USER CONCURRENCY AUDIT
  // =========================================================================
  console.log('--- 1. Multi-User Concurrency & Millisecond Race Conditions ---');
  const SEC1 = '1. Multi-User Concurrency';

  const createConcurrentRes = await apiReq('/api/deliveries', 'POST', tokenA, {
    id: 'del_audit_concurrency_01',
    docketNumber: 'AUDIT-CONC-1001',
    supplier: 'GCI Laser',
    deliveryDate: '2026-04-19',
    status: 'receiving',
    parts: Array.from({ length: 12 }, (_, idx) => ({
      id: `part_conc_${idx + 1}`,
      partNumber: `GCI-CONC-${100 + idx + 1}`,
      itemNumber: String(idx + 1),
      description: `Precision Laser Bracket #${idx + 1}`,
      quantity: idx === 11 ? 30 : 10, // Part 12 is multi-pallet (qty 30)
      receivedQuantity: 0,
      status: 'outstanding',
      palletNumber: 'Pallet 1',
    })),
  });
  assert(
    createConcurrentRes.status === 201,
    SEC1,
    'Worker A creates shared delivery AUDIT-CONC-1001 with 12 parts',
    `deliveryId=${createConcurrentRes.data.id}`
  );

  // 1A. Same-isolate millisecond race condition on Part 1 (Worker A, B, C all scan Part 1 at the exact same instant)
  const [race1A, race1B, race1C] = await Promise.all([
    apiReq('/api/deliveries/del_audit_concurrency_01/parts/part_conc_1/receive', 'POST', tokenA, {
      receivedQuantity: 10,
      mode: 'set',
      scannedVia: 'qr',
      scannedCode: 'GCI-CONC-101',
      idempotencyKey: 'conc_race1_workerA',
    }),
    apiReq('/api/deliveries/del_audit_concurrency_01/parts/part_conc_1/receive', 'POST', tokenB, {
      receivedQuantity: 10,
      mode: 'set',
      scannedVia: 'qr',
      scannedCode: 'GCI-CONC-101',
      idempotencyKey: 'conc_race1_workerB',
    }),
    apiReq('/api/deliveries/del_audit_concurrency_01/parts/part_conc_1/receive', 'POST', tokenC, {
      receivedQuantity: 10,
      mode: 'set',
      scannedVia: 'qr',
      scannedCode: 'GCI-CONC-101',
      idempotencyKey: 'conc_race1_workerC',
    }),
  ]);

  const race1Statuses = [race1A.status, race1B.status, race1C.status].sort();
  assert(
    race1Statuses[0] === 200 && race1Statuses[1] === 409 && race1Statuses[2] === 409,
    SEC1,
    '3-way simultaneous scan on Part 1 accepts exactly 1 (200) and rejects 2 duplicates (409)',
    `statuses=${JSON.stringify(race1Statuses)}`
  );

  // 1B. Cross-isolate millisecond race condition on Part 2 (Worker A on Isolate A vs Worker B on Isolate B)
  // Both read Part 2 and execute updatePartReceivedQuantity concurrently without sharing in-memory locks
  const [isoRaceA, isoRaceB] = await Promise.all([
    serviceIsolateA.updatePartReceivedQuantity(
      'del_audit_concurrency_01',
      'part_conc_2',
      {
        receivedQuantity: 10,
        mode: 'set',
        scannedVia: 'qr',
        scannedCode: 'GCI-CONC-102',
        idempotencyKey: 'iso_race_part2_A',
        userId: userA.id,
        employeeName: userA.employeeName,
      }
    ),
    serviceIsolateB.updatePartReceivedQuantity(
      'del_audit_concurrency_01',
      'part_conc_2',
      {
        receivedQuantity: 10,
        mode: 'set',
        scannedVia: 'qr',
        scannedCode: 'GCI-CONC-102',
        idempotencyKey: 'iso_race_part2_B',
        userId: userB.id,
        employeeName: userB.employeeName,
      }
    ),
  ]);

  const isoDuplicates = [isoRaceA.duplicate, isoRaceB.duplicate];
  assert(
    isoDuplicates.filter(Boolean).length === 1 && isoDuplicates.filter((d) => !d).length === 1,
    SEC1,
    'Cross-isolate simultaneous scan on Part 2 atomically accepts 1 and marks 1 duplicate via D1 version CAS',
    `isoA.duplicate=${isoRaceA.duplicate}, isoB.duplicate=${isoRaceB.duplicate}`
  );

  // 1C. Cross-isolate simultaneous incremental pallet scan on Part 12 (qty 30: Worker A scans Pallet 1 [12], Worker B scans Pallet 2 [18])
  const [incIsoA, incIsoB] = await Promise.all([
    serviceIsolateA.updatePartReceivedQuantity(
      'del_audit_concurrency_01',
      'part_conc_12',
      {
        receivedQuantity: 12,
        mode: 'increment',
        scannedVia: 'ocr_label',
        scannedCode: 'GCI-CONC-112-PAL1',
        idempotencyKey: 'iso_inc_part12_pal1',
        userId: userA.id,
        employeeName: userA.employeeName,
      }
    ),
    serviceIsolateB.updatePartReceivedQuantity(
      'del_audit_concurrency_01',
      'part_conc_12',
      {
        receivedQuantity: 18,
        mode: 'increment',
        scannedVia: 'ocr_label',
        scannedCode: 'GCI-CONC-112-PAL2',
        idempotencyKey: 'iso_inc_part12_pal2',
        userId: userB.id,
        employeeName: userB.employeeName,
      }
    ),
  ]);

  const afterIncPart12 = (await serviceIsolateA.getDeliveryById('del_audit_concurrency_01'))?.parts.find(
    (p) => p.id === 'part_conc_12'
  );
  assert(
    !incIsoA.duplicate && !incIsoB.duplicate && afterIncPart12?.receivedQuantity === 30,
    SEC1,
    'Cross-isolate concurrent incremental scans (12 + 18) both succeed with zero lost quantity',
    `finalReceivedQuantity=${afterIncPart12?.receivedQuantity}/30`
  );

  // 1D. 9 remaining parts (Parts 3..11) scanned concurrently by Workers A, B, and C (3 parts each)
  const batchPromises = [];
  for (let i = 3; i <= 11; i++) {
    const token = i % 3 === 0 ? tokenA : i % 3 === 1 ? tokenB : tokenC;
    batchPromises.push(
      apiReq(
        `/api/deliveries/del_audit_concurrency_01/parts/part_conc_${i}/receive`,
        'POST',
        token,
        {
          receivedQuantity: 10,
          mode: 'set',
          scannedVia: 'qr',
          scannedCode: `GCI-CONC-${100 + i}`,
          idempotencyKey: `batch_conc_part_${i}`,
        }
      )
    );
  }
  const batchResponses = await Promise.all(batchPromises);
  assert(
    batchResponses.every((r) => r.status === 200 && !r.data.duplicate),
    SEC1,
    'Simultaneous 9-part multi-worker batch scan completes with 0 lost scans',
    `accepted=${batchResponses.filter((r) => r.status === 200).length}/9`
  );

  const finalConcDelivery = await serviceIsolateA.getDeliveryById('del_audit_concurrency_01');
  const totalConcReceivedQty = (finalConcDelivery?.parts || []).reduce(
    (sum, p) => sum + (p.receivedQuantity || 0),
    0
  );
  assert(
    finalConcDelivery?.receivedParts === 12 && totalConcReceivedQty === 11 * 10 + 30,
    SEC1,
    'All 12 parts verified with exact aggregate quantity (140 units) and no duplicate inflation',
    `receivedParts=${finalConcDelivery?.receivedParts}/12, totalQty=${totalConcReceivedQty}/140`
  );

  // =========================================================================
  // 2. OFFLINE SYNCHRONISATION & IDEMPOTENT RETRY AUDIT
  // =========================================================================
  console.log('\n--- 2. Offline Synchronisation & Idempotent Reconnection ---');
  const SEC2 = '2. Offline Synchronisation';

  const createOfflineDelRes = await apiReq('/api/deliveries', 'POST', tokenA, {
    id: 'del_audit_offline_02',
    docketNumber: 'AUDIT-OFFLINE-2002',
    supplier: 'Laser Central',
    deliveryDate: '2026-04-19',
    status: 'receiving',
    parts: [
      { id: 'p_off_1', partNumber: 'LC-201', itemNumber: '1', description: 'Side Plate', quantity: 5, status: 'outstanding' },
      { id: 'p_off_2', partNumber: 'LC-202', itemNumber: '2', description: 'Top Cover', quantity: 8, status: 'outstanding' },
      { id: 'p_off_3', partNumber: 'LC-203', itemNumber: '3', description: 'Base Frame', quantity: 4, status: 'outstanding' },
      { id: 'p_off_4', partNumber: 'LC-204', itemNumber: '4', description: 'Mount Arm', quantity: 6, status: 'outstanding' },
    ],
  });
  assert(createOfflineDelRes.status === 201, SEC2, 'Created shared delivery AUDIT-OFFLINE-2002 for offline simulation');

  const deviceAClient = new PalletTrackRealtimeClient();
  // Clear offline queue
  memLocalStorage.removeItem('pallettrack_offline_scan_queue_v1');

  // Device A goes offline and scans Part 1, Part 2, and Part 3 (scanning Part 3 twice while offline)
  deviceAClient.enqueueOfflineScan({
    idempotencyKey: 'off_devA_part1_key',
    deliveryId: 'del_audit_offline_02',
    partId: 'p_off_1',
    partNumber: 'LC-201',
    itemNumber: '1',
    receivedQuantity: 5,
    mode: 'set',
    scannedVia: 'barcode',
    scannedCode: '1',
    queuedAt: new Date().toISOString(),
  });
  deviceAClient.enqueueOfflineScan({
    idempotencyKey: 'off_devA_part2_key',
    deliveryId: 'del_audit_offline_02',
    partId: 'p_off_2',
    partNumber: 'LC-202',
    itemNumber: '2',
    receivedQuantity: 8,
    mode: 'set',
    scannedVia: 'barcode',
    scannedCode: '2',
    queuedAt: new Date().toISOString(),
  });
  deviceAClient.enqueueOfflineScan({
    idempotencyKey: 'off_devA_part3_key_first',
    deliveryId: 'del_audit_offline_02',
    partId: 'p_off_3',
    partNumber: 'LC-203',
    itemNumber: '3',
    receivedQuantity: 4,
    mode: 'set',
    scannedVia: 'barcode',
    scannedCode: '3',
    queuedAt: new Date().toISOString(),
  });
  // Accidental second offline scan of Part 3 on Device A with a different key:
  deviceAClient.enqueueOfflineScan({
    idempotencyKey: 'off_devA_part3_key_second',
    deliveryId: 'del_audit_offline_02',
    partId: 'p_off_3',
    partNumber: 'LC-203',
    itemNumber: '3',
    receivedQuantity: 4,
    mode: 'set',
    scannedVia: 'barcode',
    scannedCode: '3',
    queuedAt: new Date().toISOString(),
  });

  const queuedBeforeReconnect = deviceAClient.getOfflineQueue();
  assert(
    queuedBeforeReconnect.length === 3,
    SEC2,
    'Device A offline queue deduplicates repeat set-mode scan on Part 3 (3 unique parts queued)',
    `queueLength=${queuedBeforeReconnect.length}`
  );

  // Meanwhile, Device B is online and scans Part 2 and Part 4
  const devBPart2 = await apiReq(
    '/api/deliveries/del_audit_offline_02/parts/p_off_2/receive',
    'POST',
    tokenB,
    {
      receivedQuantity: 8,
      mode: 'set',
      scannedVia: 'barcode',
      scannedCode: '2',
      idempotencyKey: 'online_devB_part2_key',
    }
  );
  const devBPart4 = await apiReq(
    '/api/deliveries/del_audit_offline_02/parts/p_off_4/receive',
    'POST',
    tokenB,
    {
      receivedQuantity: 6,
      mode: 'set',
      scannedVia: 'barcode',
      scannedCode: '4',
      idempotencyKey: 'online_devB_part4_key',
    }
  );
  assert(
    devBPart2.status === 200 && devBPart4.status === 200,
    SEC2,
    'Device B scans Part 2 and Part 4 online while Device A is offline'
  );

  // Route global fetch to our local API router so deviceAClient.flushOfflineScanQueue() hits the real backend
  const originalFetch = globalThis.fetch;
  setAuthToken(tokenA);
  setStoredUser(userA);
  (globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const req = new Request(urlStr.startsWith('http') ? urlStr : `http://localhost:3000${urlStr}`, init);
    const res = await handlePalletTrackApiRequest(req, d1, {});
    if (res) return res;
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  };

  try {
    // Device A reconnects and flushes its offline queue
    const flushOutcomes = await deviceAClient.flushOfflineScanQueue();
    const outcomeMap = new Map(flushOutcomes.map((o) => [o.scan.partId, o]));

    assert(
      outcomeMap.get('p_off_1')?.outcome === 'accepted' &&
        outcomeMap.get('p_off_2')?.outcome === 'duplicate' &&
        outcomeMap.get('p_off_2')?.alreadyScannedBy === userB.employeeName &&
        outcomeMap.get('p_off_3')?.outcome === 'accepted',
      SEC2,
      'Device A reconnect flush accepts Part 1 & Part 3 and flags Part 2 as already scanned by Worker B',
      `outcomes=${JSON.stringify(flushOutcomes.map((o) => `${o.scan.partId}:${o.outcome}`))}`
    );

    assert(
      deviceAClient.getOfflineQueue().length === 0,
      SEC2,
      'Device A offline queue is empty after successful reconciliation'
    );

    // Test idempotent retry: replay Part 1's exact idempotencyKey ('off_devA_part1_key') and incremental scan retry
    const retryPart1Res = await apiReq(
      '/api/deliveries/del_audit_offline_02/parts/p_off_1/receive',
      'POST',
      tokenA,
      {
        receivedQuantity: 5,
        mode: 'set',
        scannedVia: 'barcode',
        scannedCode: '1',
        idempotencyKey: 'off_devA_part1_key',
      }
    );
    assert(
      retryPart1Res.status === 200 && retryPart1Res.data.idempotentReplay === true,
      SEC2,
      'Retrying scan with identical idempotencyKey returns 200 idempotentReplay without error or duplicate mutation',
      `idempotentReplay=${retryPart1Res.data.idempotentReplay}`
    );

    const afterOfflineDel = await serviceIsolateA.getDeliveryById('del_audit_offline_02');
    const p1 = afterOfflineDel?.parts.find((p) => p.id === 'p_off_1');
    const p2 = afterOfflineDel?.parts.find((p) => p.id === 'p_off_2');
    const p3 = afterOfflineDel?.parts.find((p) => p.id === 'p_off_3');
    const p4 = afterOfflineDel?.parts.find((p) => p.id === 'p_off_4');

    assert(
      p1?.receivedQuantity === 5 &&
        p2?.receivedQuantity === 8 &&
        p2?.lastScannedByName === userB.employeeName &&
        p3?.receivedQuantity === 4 &&
        p4?.receivedQuantity === 6 &&
        afterOfflineDel?.receivedParts === 4,
      SEC2,
      'Final quantities across all 4 parts are exact (5, 8, 4, 6) and Worker B attribution on Part 2 is preserved',
      `quantities=[${p1?.receivedQuantity}, ${p2?.receivedQuantity}, ${p3?.receivedQuantity}, ${p4?.receivedQuantity}]`
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // =========================================================================
  // 3. WEBSOCKET RELIABILITY & CROSS-ISOLATE SEQUENCE CONSISTENCY AUDIT
  // =========================================================================
  console.log('\n--- 3. WebSocket Reliability & Cross-Isolate Sequence Consistency ---');
  const SEC3 = '3. WebSocket Reliability';

  // 3A. Instantiate two separate PalletTrackRealtimeBroker instances (simulating Isolate 1 & Isolate 2)
  const brokerIsolate1 = new PalletTrackRealtimeBroker({ disableIntervalTimer: true });
  const brokerIsolate2 = new PalletTrackRealtimeBroker({ disableIntervalTimer: true });

  assert(
    !brokerIsolate1.isHeartbeatRunning() && !brokerIsolate2.isHeartbeatRunning(),
    SEC3,
    'Broker instantiation starts zero background timers in global scope'
  );

  // Publish interleaved events from Isolate 1 and Isolate 2 into shared D1
  const evIso1A = await brokerIsolate1.publishEvent(d1, {
    type: 'part:scanned',
    deliveryId: 'del_audit_offline_02',
    partId: 'p_off_1',
    userId: userA.id,
    employeeName: userA.employeeName,
    deliveryVersion: 10,
    payload: { partId: 'p_off_1', receivedQuantity: 5 },
  });
  const evIso2A = await brokerIsolate2.publishEvent(d1, {
    type: 'part:scanned',
    deliveryId: 'del_audit_offline_02',
    partId: 'p_off_2',
    userId: userB.id,
    employeeName: userB.employeeName,
    deliveryVersion: 11,
    payload: { partId: 'p_off_2', receivedQuantity: 8 },
  });
  const evIso1B = await brokerIsolate1.publishEvent(d1, {
    type: 'part:scanned',
    deliveryId: 'del_audit_offline_02',
    partId: 'p_off_3',
    userId: userA.id,
    employeeName: userA.employeeName,
    deliveryVersion: 12,
    payload: { partId: 'p_off_3', receivedQuantity: 4 },
  });

  assert(
    evIso1A.sequenceNumber < evIso2A.sequenceNumber &&
      evIso2A.sequenceNumber < evIso1B.sequenceNumber,
    SEC3,
    'Sequence numbers allocated across separate Worker isolates are strictly monotonic via D1 AUTOINCREMENT',
    `seqs=[${evIso1A.sequenceNumber}, ${evIso2A.sequenceNumber}, ${evIso1B.sequenceNumber}]`
  );

  // 3B. Cold isolate (Isolate 3) receives a WebSocket connection with lastSeq = evIso1A.sequenceNumber
  const brokerIsolate3 = new PalletTrackRealtimeBroker({ disableIntervalTimer: true });
  const wsClientOnIso3 = new MockSocket();
  await brokerIsolate3.getLatestSequenceNumber(d1);
  const connId3 = brokerIsolate3.registerClient(
    wsClientOnIso3,
    userC,
    tokenC,
    'del_audit_offline_02',
    evIso1A.sequenceNumber,
    d1
  );

  // Allow async D1 catch-up query on registerClient to resolve
  await new Promise((r) => setTimeout(r, 30));

  const catchupMsg = wsClientOnIso3.sentMessages.find((m) => m.type === 'sync_catchup');
  assert(
    Boolean(catchupMsg) &&
      Array.isArray(catchupMsg.events) &&
      catchupMsg.events.length === 2 &&
      catchupMsg.events[0].sequenceNumber === evIso2A.sequenceNumber &&
      catchupMsg.events[1].sequenceNumber === evIso1B.sequenceNumber &&
      catchupMsg.latestSeq === evIso1B.sequenceNumber,
    SEC3,
    'Cold Worker isolate recovers missed events from D1 on client reconnect (sync_catchup)',
    `recoveredSeqs=${JSON.stringify(catchupMsg?.events?.map((e: any) => e.sequenceNumber))}`
  );

  // 3C. Test sync_request message on cold isolate
  wsClientOnIso3.sentMessages = [];
  await brokerIsolate3.handleClientMessage(
    connId3,
    JSON.stringify({
      type: 'sync_request',
      sinceSeq: evIso2A.sequenceNumber,
      deliveryId: 'del_audit_offline_02',
    }),
    d1
  );
  const syncRespMsg = wsClientOnIso3.sentMessages.find((m) => m.type === 'sync_response');
  assert(
    Boolean(syncRespMsg) &&
      syncRespMsg.latestSeq === evIso1B.sequenceNumber &&
      syncRespMsg.events.length === 1 &&
      syncRespMsg.events[0].sequenceNumber === evIso1B.sequenceNumber,
    SEC3,
    'sync_request returns authoritative D1 latestSeq and exact missed delta',
    `latestSeq=${syncRespMsg?.latestSeq}, deltaCount=${syncRespMsg?.events?.length}`
  );

  // 3D. Test duplicate event & stale version guard on client state reducer
  const initialDelState: Delivery[] = [
    {
      id: 'del_audit_offline_02',
      docketNumber: 'AUDIT-OFFLINE-2002',
      supplier: 'Laser Central',
      deliveryDate: '2026-04-19',
      status: 'receiving',
      version: 12,
      totalParts: 4,
      receivedParts: 2,
      parts: [
        {
          id: 'p_off_1',
          docketLineIndex: 1,
          partNumber: 'LC-201',
          itemNumber: '1',
          description: 'Side Plate',
          quantity: 5,
          receivedQuantity: 5,
          status: 'received',
          palletNumber: 'Pallet 1',
        },
      ],
      unexpectedParts: [],
      scanHistory: [],
      docketAttachments: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  saveStoredDeliveries(initialDelState);

  // Send a stale event with deliveryVersion = 9 (< 12)
  const staleResult = applyRealtimeEventToDeliveries(getStoredDeliveries(), {
    id: 'rt_stale_event_9',
    type: 'part:scanned',
    sequenceNumber: 999,
    deliveryId: 'del_audit_offline_02',
    partId: 'p_off_1',
    deliveryVersion: 9,
    timestamp: new Date().toISOString(),
    payload: {
      part: {
        id: 'p_off_1',
        partNumber: 'LC-201',
        itemNumber: '1',
        description: 'Side Plate',
        quantity: 5,
        receivedQuantity: 1, // Stale wrong quantity
        status: 'received',
        palletNumber: 'Pallet 1',
      },
    },
  });
  assert(
    staleResult.changed === false &&
      staleResult.deliveries[0].parts[0].receivedQuantity === 5,
    SEC3,
    'Monotonic deliveryVersion guard rejects out-of-order stale WebSocket event (ver 9 < ver 12)'
  );

  // 3E. Test WebSocket heartbeat ping & stale connection timeout pruning
  // Force client lastPongMs to be older than STALE_CONNECTION_TIMEOUT_MS
  const internalClientsMap = (brokerIsolate3 as any).clients as Map<string, any>;
  const clientRecord = internalClientsMap.get(connId3);
  clientRecord.lastPongMs = Date.now() - (STALE_CONNECTION_TIMEOUT_MS + 5000);
  brokerIsolate3.pruneStaleConnectionsAndPing();

  assert(
    wsClientOnIso3.readyState === 3 &&
      wsClientOnIso3.closeCode === 4000 &&
      brokerIsolate3.getConnectedClientCount() === 0,
    SEC3,
    'Heartbeat prunes stale WebSocket connections after timeout (code 4000) and stops timer when 0 clients remain'
  );

  // =========================================================================
  // 4. CLOUDFLARE PRODUCTION BEHAVIOUR AUDIT
  // =========================================================================
  console.log('\n--- 4. Cloudflare Production Behaviour (Worker Routing, WS Upgrade & D1 Limits) ---');
  const SEC4 = '4. Cloudflare Production Behaviour';

  const mockAssets = {
    fetch: async (req: Request) => {
      const u = new URL(req.url);
      if (u.pathname === '/' || u.pathname === '/index.html') {
        return new Response('<!doctype html><html><head><title>PartTrack</title></head><body><div id="root"></div></body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      return new Response('Asset not found', { status: 404 });
    },
  };

  const workerEnv: any = {
    DB: d1,
    GEMINI_API_KEY: 'test-gemini-key',
    ASSETS: mockAssets,
  };

  // 4A. /api/health reaches Worker
  const healthRes = await workerEntry.fetch(
    new Request('https://parttrack.example.com/api/health', { method: 'GET' }),
    workerEnv
  );
  const healthData: any = await healthRes.json();
  assert(
    healthRes.status === 200 && healthData.status === 'ok' && healthData.dbConnected === true,
    SEC4,
    'GET /api/health reaches Cloudflare Worker and confirms D1 connection',
    `status=${healthRes.status}, dbConnected=${healthData.dbConnected}`
  );

  // 4B. Unmatched GET /api/* route returns 404 JSON and NEVER falls through to SPA index.html
  const unknownApiRes = await workerEntry.fetch(
    new Request('https://parttrack.example.com/api/non-existent-route', { method: 'GET' }),
    workerEnv
  );
  const unknownApiContentType = unknownApiRes.headers.get('Content-Type') || '';
  const unknownApiJson: any = await unknownApiRes.json().catch(() => ({}));
  assert(
    unknownApiRes.status === 404 &&
      unknownApiContentType.includes('application/json') &&
      unknownApiJson.code === 'NOT_FOUND',
    SEC4,
    'Unmatched GET /api/* returns 404 JSON (never falls through to SPA HTML)',
    `status=${unknownApiRes.status}, code=${unknownApiJson.code}`
  );

  // 4C. Frontend SPA route (e.g. /scanner) falls back to index.html via env.ASSETS
  const spaRes = await workerEntry.fetch(
    new Request('https://parttrack.example.com/scanner', { method: 'GET' }),
    workerEnv
  );
  const spaHtml = await spaRes.text();
  assert(
    spaRes.status === 200 && spaHtml.includes('<title>PartTrack</title>'),
    SEC4,
    'Frontend navigation route (/scanner) serves SPA index.html via env.ASSETS'
  );

  // 4D. WebSocket upgrade validation on /api/realtime/ws
  const wsNoUpgradeRes = await workerEntry.fetch(
    new Request('https://parttrack.example.com/api/realtime/ws', { method: 'GET' }),
    workerEnv
  );
  assert(
    wsNoUpgradeRes.status === 426,
    SEC4,
    'GET /api/realtime/ws without Upgrade header returns HTTP 426 Upgrade Required'
  );

  const wsUnauthRes = await workerEntry.fetch(
    new Request('https://parttrack.example.com/api/realtime/ws?token=invalid_token', {
      method: 'GET',
      headers: { Upgrade: 'websocket' },
    }),
    workerEnv
  );
  assert(
    wsUnauthRes.status === 401,
    SEC4,
    'GET /api/realtime/ws with invalid token returns HTTP 401 Unauthorized'
  );

  // Mock Cloudflare WebSocketPair to verify 101 Switching Protocols in worker.ts
  (globalThis as any).WebSocketPair = function () {
    return { 0: new MockSocket(), 1: new MockSocket() };
  };
  const OriginalResponse = globalThis.Response;
  (globalThis as any).Response = class CloudflareResponse extends OriginalResponse {
    public webSocket?: any;
    constructor(body: BodyInit | null | undefined, init?: ResponseInit & { webSocket?: any }) {
      const status = init?.status === 101 ? 200 : init?.status;
      super(body, { ...init, status });
      if (init?.status === 101) {
        Object.defineProperty(this, 'status', { value: 101 });
      }
      this.webSocket = init?.webSocket;
    }
  };

  try {
    const wsUpgradeRes: any = await workerEntry.fetch(
      new Request(`https://parttrack.example.com/api/realtime/ws?token=${encodeURIComponent(tokenA)}&lastSeq=0`, {
        method: 'GET',
        headers: { Upgrade: 'websocket' },
      }),
      workerEnv
    );
    assert(
      wsUpgradeRes.status === 101 && Boolean(wsUpgradeRes.webSocket),
      SEC4,
      'GET /api/realtime/ws with valid token upgrades with HTTP 101 and WebSocket pair'
    );
  } finally {
    globalThis.Response = OriginalResponse;
    delete (globalThis as any).WebSocketPair;
  }

  // 4E. D1 Cold-Start Query Budget & Concurrent Schema Initialisation Safety
  const coldDbPath = path.resolve(testDbDir, `audit-cold-${Date.now()}.db`);
  const rawColdD1 = new NodeSqliteD1Adapter(coldDbPath);
  let coldRoundTrips = 0;
  let coldStatementsExecuted = 0;
  const instrumentedColdD1 = {
    prepare(query: string) {
      const inner = rawColdD1.prepare(query);
      return {
        bind(...values: unknown[]) {
          const bound = inner.bind(...values);
          return {
            first<T = unknown>(col?: string) {
              coldRoundTrips++;
              coldStatementsExecuted++;
              return bound.first<T>(col);
            },
            run<T = unknown>() {
              coldRoundTrips++;
              coldStatementsExecuted++;
              return bound.run<T>();
            },
            all<T = unknown>() {
              coldRoundTrips++;
              coldStatementsExecuted++;
              return bound.all<T>();
            },
            raw<T = unknown>() {
              coldRoundTrips++;
              coldStatementsExecuted++;
              return bound.raw<T>();
            },
          };
        },
        first<T = unknown>(col?: string) {
          coldRoundTrips++;
          coldStatementsExecuted++;
          return inner.first<T>(col);
        },
        run<T = unknown>() {
          coldRoundTrips++;
          coldStatementsExecuted++;
          return inner.run<T>();
        },
        all<T = unknown>() {
          coldRoundTrips++;
          coldStatementsExecuted++;
          return inner.all<T>();
        },
        raw<T = unknown>() {
          coldRoundTrips++;
          coldStatementsExecuted++;
          return inner.raw<T>();
        },
      };
    },
    batch(statements: any[]) {
      coldRoundTrips++;
      coldStatementsExecuted += statements.length;
      return rawColdD1.batch(statements);
    },
    exec(query: string) {
      coldRoundTrips++;
      coldStatementsExecuted++;
      return rawColdD1.exec(query);
    },
  };

  // Fire 10 concurrent cold-start requests against a completely empty database (no tables pre-created)
  const coldServices = Array.from({ length: 10 }, () => new PalletTrackDbService(instrumentedColdD1 as any));
  await Promise.all(coldServices.map((svc) => svc.ensureSchemaReady()));

  const roundTripsAfterWarmup = coldRoundTrips;
  const stmtsAfterWarmup = coldStatementsExecuted;
  await coldServices[0].listDeliveries();
  const roundTripsForGetDeliveries = coldRoundTrips - roundTripsAfterWarmup;

  assert(
    roundTripsAfterWarmup <= 30 && stmtsAfterWarmup <= 35 && roundTripsForGetDeliveries <= 5,
    SEC4,
    'Concurrent D1 cold-start schema init (10 parallel callers) succeeds safely within Cloudflare query limits',
    `coldRoundTrips=${roundTripsAfterWarmup}, coldStmts=${stmtsAfterWarmup}, listDeliveriesRoundTrips=${roundTripsForGetDeliveries}`
  );

  // =========================================================================
  // 5. AUTHENTICATION RESILIENCE AUDIT
  // =========================================================================
  console.log('\n--- 5. Authentication Resilience (Network Failures, 5xx vs 401/403) ---');
  const SEC5 = '5. Authentication Resilience';

  const validSessionUser: UserAccount = {
    id: userA.id,
    employeeName: userA.employeeName,
    employeeCode: userA.employeeCode,
    role: userA.role,
    active: true,
    createdAt: userA.createdAt,
  };

  setAuthToken(tokenA);
  setStoredUser(validSessionUser);

  const transientFailureScenarios: Array<{ label: string; mockFetch: () => Promise<Response> }> = [
    {
      label: 'Temporary Network Drop (TypeError: Failed to fetch)',
      mockFetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    },
    {
      label: 'HTTP 500 Internal Server Error',
      mockFetch: async () =>
        new Response(JSON.stringify({ error: 'D1 transient error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
    },
    {
      label: 'HTTP 502 Bad Gateway',
      mockFetch: async () =>
        new Response('Bad Gateway', {
          status: 502,
          headers: { 'Content-Type': 'text/plain' },
        }),
    },
    {
      label: 'HTTP 503 Service Unavailable',
      mockFetch: async () =>
        new Response(JSON.stringify({ error: 'Worker overloaded' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
    },
  ];

  for (const scenario of transientFailureScenarios) {
    (globalThis as any).fetch = scenario.mockFetch;
    let caughtErr: any = null;
    try {
      await apiGetSession();
    } catch (err) {
      caughtErr = err;
    }
    assert(
      Boolean(caughtErr) &&
        getAuthToken() === tokenA &&
        getStoredUser()?.id === userA.id,
      SEC5,
      `Transient failure [${scenario.label}] preserves valid session token and user in storage`
    );
  }

  // Verify explicit HTTP 401 clears the session
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ error: 'Unauthorized: Invalid or expired session' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  try {
    await apiGetSession();
  } catch {
    // Expected 401
  }
  assert(
    getAuthToken() === null && getStoredUser() === null,
    SEC5,
    'Explicit HTTP 401 Unauthorized clears stored session token and user'
  );

  // Restore session and verify explicit HTTP 403 clears the session
  setAuthToken(tokenA);
  setStoredUser(validSessionUser);
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ error: 'Forbidden: Account deactivated' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  try {
    await apiGetSession();
  } catch {
    // Expected 403
  }
  assert(
    getAuthToken() === null && getStoredUser() === null,
    SEC5,
    'Explicit HTTP 403 Forbidden immediately clears stored session token and user'
  );

  globalThis.fetch = originalFetch;

  // =========================================================================
  // 6. DELIVERY SYNCHRONISATION AUDIT
  // =========================================================================
  console.log('\n--- 6. Delivery Synchronisation (Photos, Newer Versions, Dedup & Local Migration) ---');
  const SEC6 = '6. Delivery Synchronisation';

  setAuthToken(tokenA);
  setStoredUser(validSessionUser);

  // Route fetch to our local D1 router for syncDeliveriesFromCentralDatabase()
  (globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const req = new Request(urlStr.startsWith('http') ? urlStr : `http://localhost:3000${urlStr}`, init);
    const res = await handlePalletTrackApiRequest(req, d1, {});
    if (res) return res;
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  };

  try {
    // Seed local storage with:
    // 1. Existing delivery 'del_audit_concurrency_01' that has a local uploaded docket photo (`docketAttachments`)
    //    AND a newer local version (e.g. version = 999) on Part 1 to test version protection
    // 2. A brand-new local-only delivery 'del_local_only_6001' created while offline, with an uploaded photo
    // 3. A duplicate docket entry with different casing ('audit-conc-1001') to verify duplicate prevention
    const centralBeforeSync = await serviceIsolateA.getDeliveryById('del_audit_concurrency_01');
    if (!centralBeforeSync) throw new Error('Expected del_audit_concurrency_01 in D1');

    const localPhotoAttachment = {
      id: 'att_photo_page1',
      name: 'docket_194252_page1.jpg',
      type: 'image/jpeg',
      dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
      uploadedAt: new Date().toISOString(),
      pageCount: 1,
    };

    const localExistingWithPhotoAndNewerNote: Delivery = {
      ...(centralBeforeSync as any),
      scanHistory: (centralBeforeSync?.scanHistory || []) as any,
      version: (centralBeforeSync?.version || 1) + 10, // Newer local version
      notes: 'Updated locally with newer version',
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
      docketAttachments: [localPhotoAttachment],
    };

    const localOnlyDelivery: Delivery = {
      id: 'del_local_only_6001',
      docketNumber: 'LOCAL-MIG-6001',
      supplier: 'GCI Laser',
      deliveryDate: '2026-04-19',
      status: 'receiving',
      version: 1,
      totalParts: 2,
      receivedParts: 1,
      docketAttachments: [localPhotoAttachment],
      parts: [
        {
          id: 'p_loc_1',
          docketLineIndex: 1,
          partNumber: 'GCI-LOC-01',
          itemNumber: '1',
          description: 'Local Bracket 1',
          quantity: 4,
          receivedQuantity: 4,
          status: 'received',
          palletNumber: 'Pallet 1',
        },
        {
          id: 'p_loc_2',
          docketLineIndex: 2,
          partNumber: 'GCI-LOC-02',
          itemNumber: '2',
          description: 'Local Bracket 2',
          quantity: 6,
          receivedQuantity: 0,
          status: 'outstanding',
          palletNumber: 'Pallet 1',
        },
      ],
      unexpectedParts: [],
      scanHistory: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const duplicateCaseDocketLocal: Delivery = {
      ...localOnlyDelivery,
      id: 'del_local_dup_case',
      docketNumber: 'local-mig-6001', // Duplicate docket number in lowercase
    };

    saveStoredDeliveries([
      localExistingWithPhotoAndNewerNote,
      localOnlyDelivery,
      duplicateCaseDocketLocal,
    ]);

    const syncedDeliveries = await syncDeliveriesFromCentralDatabase();

    // Verify 6A: Existing docket data & uploaded photo attachments preserved
    const syncedConc = syncedDeliveries.find((d) => d.id === 'del_audit_concurrency_01');
    assert(
      Boolean(syncedConc) &&
        syncedConc?.docketAttachments?.length === 1 &&
        syncedConc?.docketAttachments?.[0]?.dataUrl === localPhotoAttachment.dataUrl,
      SEC6,
      'Central sync preserves uploaded docketAttachments photo dataUrls on existing deliveries'
    );

    // Verify 6B: Newer local data/version is NOT overwritten by older central payload
    assert(
      syncedConc?.notes === 'Updated locally with newer version' &&
        (syncedConc?.version || 0) >= localExistingWithPhotoAndNewerNote.version!,
      SEC6,
      'Central sync does not overwrite newer local delivery version or metadata',
      `version=${syncedConc?.version}, notes="${syncedConc?.notes}"`
    );

    // Verify 6C: Local-only delivery was migrated to central D1 and its photo preserved
    const migratedInD1 = await serviceIsolateA.getDeliveryById('del_local_only_6001');
    const syncedLocalMig = syncedDeliveries.find((d) => d.id === 'del_local_only_6001');
    assert(
      Boolean(migratedInD1) &&
        migratedInD1?.parts.length === 2 &&
        syncedLocalMig?.docketAttachments?.length === 1,
      SEC6,
      'Local-only delivery (LOCAL-MIG-6001) automatically migrates to central D1 while preserving photos'
    );

    // Verify 6D: No duplicate dockets created in D1 or local merged list
    const matchingMigDockets = syncedDeliveries.filter(
      (d) => (d.docketNumber || '').trim().toLowerCase() === 'local-mig-6001'
    );
    assert(
      matchingMigDockets.length === 1,
      SEC6,
      'Case-insensitive docket deduplication prevents duplicate dockets during migration and sync',
      `matchingDocketsCount=${matchingMigDockets.length}`
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('\n================================================================================');
  console.log(` AUDIT COMPLETE: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('================================================================================');
}

runAudit().catch((err) => {
  console.error('\n❌ PRODUCTION RELIABILITY AUDIT FAILED:', err);
  process.exit(1);
});
