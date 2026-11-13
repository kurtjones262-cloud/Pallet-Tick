import { WebSocket } from 'ws';
import { applyRealtimeEventToDeliveries } from '../src/utils/storage.ts';
import type { Delivery } from '../src/types/delivery.ts';
import type { RealtimeSyncEvent } from '../src/services/realtimeSync.ts';

const BASE_HTTP = 'http://localhost:3000';
const BASE_WS = 'ws://localhost:3000/api/realtime/ws';

interface TestResult {
  id: number;
  name: string;
  passed: boolean;
  details: string;
  latencyMs?: number;
}

const results: TestResult[] = [];
const broadcastLatenciesMs: number[] = [];

function recordResult(id: number, name: string, passed: boolean, details: string, latencyMs?: number) {
  results.push({ id, name, passed, details, latencyMs });
  if (typeof latencyMs === 'number' && latencyMs >= 0) {
    broadcastLatenciesMs.push(latencyMs);
  }
  const badge = passed ? 'PASS' : 'FAIL';
  const latStr = typeof latencyMs === 'number' ? ` [${latencyMs.toFixed(1)}ms]` : '';
  console.log(`[${badge}] #${id} ${name}${latStr} -> ${details}`);
}

async function apiReq(
  path: string,
  method: string,
  token?: string,
  body?: any
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_HTTP}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

class SimulatedWorkerClient {
  public name: string;
  public token: string;
  public userId: string = '';
  public ws: WebSocket | null = null;
  public events: RealtimeSyncEvent[] = [];
  public presenceUpdates: any[] = [];
  public authRevoked: boolean = false;
  public lastSeq: number = 0;
  private eventWaiters: Array<{
    predicate: (ev: RealtimeSyncEvent) => boolean;
    resolve: (ev: RealtimeSyncEvent) => void;
  }> = [];

  constructor(name: string, token: string, userId: string) {
    this.name = name;
    this.token = token;
    this.userId = userId;
  }

  async connect(activeDeliveryId: string | null = null): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${BASE_WS}?token=${encodeURIComponent(this.token)}${
        activeDeliveryId ? `&deliveryId=${encodeURIComponent(activeDeliveryId)}` : ''
      }&lastSeq=${this.lastSeq}`;
      const ws = new WebSocket(url);
      this.ws = ws;

      const timeout = setTimeout(() => {
        reject(new Error(`Timeout connecting WebSocket for ${this.name}`));
      }, 5000);

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'connected') {
          if (typeof msg.currentSequenceNumber === 'number') {
            this.lastSeq = Math.max(this.lastSeq, msg.currentSequenceNumber);
          }
          if (msg.presence) {
            this.presenceUpdates.push(msg.presence);
          }
          clearTimeout(timeout);
          resolve();
        } else if (msg.type === 'event' && msg.event) {
          const ev: RealtimeSyncEvent = msg.event;
          if (typeof ev.sequenceNumber === 'number') {
            this.lastSeq = Math.max(this.lastSeq, ev.sequenceNumber);
          }
          this.events.push(ev);
          for (let i = this.eventWaiters.length - 1; i >= 0; i--) {
            if (this.eventWaiters[i].predicate(ev)) {
              const w = this.eventWaiters.splice(i, 1)[0];
              w.resolve(ev);
            }
          }
        } else if (msg.type === 'sync_catchup' && Array.isArray(msg.events)) {
          for (const ev of msg.events) {
            if (typeof ev.sequenceNumber === 'number') {
              this.lastSeq = Math.max(this.lastSeq, ev.sequenceNumber);
            }
            this.events.push(ev);
            for (let i = this.eventWaiters.length - 1; i >= 0; i--) {
              if (this.eventWaiters[i].predicate(ev)) {
                const w = this.eventWaiters.splice(i, 1)[0];
                w.resolve(ev);
              }
            }
          }
        } else if (msg.type === 'presence_update' && msg.presence) {
          this.presenceUpdates.push(msg.presence);
        } else if (msg.type === 'auth_revoked') {
          this.authRevoked = true;
        }
      });

      ws.on('close', (code) => {
        if (code === 4003) {
          this.authRevoked = true;
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  waitForEvent(
    predicate: (ev: RealtimeSyncEvent) => boolean,
    timeoutMs: number = 3000
  ): Promise<RealtimeSyncEvent> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.eventWaiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.eventWaiters.splice(idx, 1);
        reject(new Error(`${this.name} timed out waiting for WebSocket event after ${timeoutMs}ms`));
      }, timeoutMs);

      this.eventWaiters.push({
        predicate,
        resolve: (ev) => {
          clearTimeout(timer);
          resolve(ev);
        },
      });
    });
  }

  sendJson(payload: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

async function runTests() {
  console.log('================================================================');
  console.log(' PALLETTRACK REAL-TIME MULTI-USER & CONCURRENCY TEST SUITE');
  console.log('================================================================\n');

  // 1. Test Unauthenticated WebSocket Connection Rejection
  {
    const unauthCode = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${BASE_WS}?token=invalid_token_xyz`);
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {});
    });
    recordResult(
      1,
      'Unauthenticated WebSocket rejection',
      unauthCode === 4001,
      `Closed with code ${unauthCode} (expected 4001)`
    );
  }

  // Authenticate Super Admin (Worker A) and create/login Worker B & Worker C
  const loginA = await apiReq('/api/auth/login', 'POST', undefined, {
    employeeCode: 'SUPER-01',
    pin: '1234',
  });
  if (loginA.status !== 200 || !loginA.data.token) {
    throw new Error(`Failed to login SUPER-01: ${JSON.stringify(loginA)}`);
  }
  const tokenA = loginA.data.token;
  const userA = loginA.data.user;

  // Create or login Worker B (WORK-B) and Worker C (WORK-C)
  await apiReq('/api/users', 'POST', tokenA, {
    employeeName: 'Liam Connor (Worker B)',
    employeeCode: 'WORK-B',
    role: 'operator',
    pin: '2222',
  });
  await apiReq('/api/users', 'POST', tokenA, {
    employeeName: 'Sarah Chen (Worker C)',
    employeeCode: 'WORK-C',
    role: 'supervisor',
    pin: '3333',
  });

  const loginB = await apiReq('/api/auth/login', 'POST', undefined, {
    employeeCode: 'WORK-B',
    pin: '2222',
  });
  const loginC = await apiReq('/api/auth/login', 'POST', undefined, {
    employeeCode: 'WORK-C',
    pin: '3333',
  });

  const workerA = new SimulatedWorkerClient('Worker A (Super Admin)', tokenA, userA.id);
  const workerB = new SimulatedWorkerClient('Worker B (Liam Connor)', loginB.data.token, loginB.data.user.id);
  const workerC = new SimulatedWorkerClient('Worker C (Sarah Chen)', loginC.data.token, loginC.data.user.id);

  await workerA.connect();
  await workerB.connect();
  await workerC.connect();

  // 2. Test Live Docket Processing Notification + Live Delivery Upload Synchronisation
  const deliveryId1 = `del_rt_test_${Date.now()}`;
  const deliveryId2 = `del_rt_iso_${Date.now()}`;

  {
    const procWaitB = workerB.waitForEvent((e) => e.type === 'delivery:processing');
    const t0Proc = performance.now();
    await apiReq('/api/deliveries/processing', 'POST', tokenA, {
      fileName: 'GCI_Docket_99401.pdf',
      fileCount: 2,
      supplier: 'GCI',
      status: 'processing',
    });
    const procEv = await procWaitB;
    const procLat = performance.now() - t0Proc;

    const createWaitB = workerB.waitForEvent(
      (e) => e.type === 'delivery:created' && e.deliveryId === deliveryId1
    );
    const createWaitC = workerC.waitForEvent(
      (e) => e.type === 'delivery:created' && e.deliveryId === deliveryId1
    );

    const t0Create = performance.now();
    const createRes = await apiReq('/api/deliveries', 'POST', tokenA, {
      id: deliveryId1,
      docketNumber: 'DK-RT-99401',
      supplier: 'GCI',
      supplierProfile: 'gci',
      deliveryDate: '2026-11-12',
      palletCount: 2,
      status: 'receiving',
      parts: [
        {
          id: `${deliveryId1}_p1`,
          partNumber: '123456',
          itemNumber: '1',
          description: 'Chassis Side Rail 6mm',
          quantity: 1,
          palletNumber: 'Pallet 1',
          status: 'outstanding',
        },
        {
          id: `${deliveryId1}_p2`,
          partNumber: '789012',
          itemNumber: '2',
          description: 'CrossmemberGusset 8mm',
          quantity: 1,
          palletNumber: 'Pallet 1',
          status: 'outstanding',
        },
        {
          id: `${deliveryId1}_p3`,
          partNumber: '345678',
          itemNumber: '3',
          description: 'Mounting Bracket 10mm',
          quantity: 1,
          palletNumber: 'Pallet 1',
          status: 'outstanding',
        },
        {
          id: `${deliveryId1}_p4`,
          partNumber: '555888',
          itemNumber: '4',
          description: 'Heavy Base Plate (Race Test)',
          quantity: 1,
          palletNumber: 'Pallet 1',
          status: 'outstanding',
        },
        {
          id: `${deliveryId1}_p5`,
          partNumber: '900240',
          itemNumber: '5',
          description: 'Multi-Pallet Bulk Washer Plate',
          quantity: 24,
          palletNumber: 'Pallet 2',
          status: 'outstanding',
        },
      ],
    });

    const [evB, evC] = await Promise.all([createWaitB, createWaitC]);
    const createLat = performance.now() - t0Create;

    recordResult(
      2,
      'Worker A uploads new delivery -> Worker B & C receive live without refresh',
      createRes.status === 201 &&
        Boolean(procEv) &&
        evB.payload?.delivery?.docketNumber === 'DK-RT-99401' &&
        evC.payload?.delivery?.parts?.length === 5 &&
        createLat < 500,
      `Processing notice (${procLat.toFixed(1)}ms) + delivery:created broadcast to B & C (${createLat.toFixed(1)}ms), seq=${evB.sequenceNumber}`,
      createLat
    );
  }

  // 3. Test Live Worker Presence & Active Scanner Status in Shared Delivery Room
  {
    workerA.sendJson({ type: 'join_delivery', deliveryId: deliveryId1, status: 'scanning' });
    workerB.sendJson({ type: 'join_delivery', deliveryId: deliveryId1, status: 'scanning' });
    await new Promise((r) => setTimeout(r, 80));

    const presRes = await apiReq(
      `/api/realtime/presence?deliveryId=${encodeURIComponent(deliveryId1)}`,
      'GET',
      tokenA
    );
    const pres = presRes.data?.presence;
    const scanningWorkers = (pres?.deliveryWorkers || []).filter((w: any) => w.status === 'scanning');

    recordResult(
      3,
      'Two workers open same delivery -> live worker presence & scanning status',
      presRes.status === 200 &&
        pres?.connectedWorkersCount >= 3 &&
        (pres?.deliveryWorkers?.length || 0) >= 2 &&
        scanningWorkers.length >= 2,
      `Total online: ${pres?.connectedWorkersCount}, In delivery room: ${pres?.deliveryWorkers?.length}, Actively scanning: ${scanningWorkers.length}`
    );
  }

  // 4. Test Worker A scans a part -> Worker B updates immediately (<500ms)
  {
    const scanWaitB = workerB.waitForEvent(
      (e) => e.type === 'part:scanned' && e.partId === `${deliveryId1}_p1`
    );
    const t0 = performance.now();
    const resA = await apiReq(
      `/api/deliveries/${deliveryId1}/parts/${deliveryId1}_p1/receive`,
      'POST',
      tokenA,
      {
        receivedQuantity: 1,
        code: '123456-1',
        scanType: 'qr',
        mode: 'set',
      }
    );
    const evB = await scanWaitB;
    const latency = performance.now() - t0;

    recordResult(
      4,
      'Worker A scans Part 1 -> Worker B updates immediately (<500ms)',
      resA.status === 200 &&
        evB.payload?.part?.status === 'received' &&
        evB.payload?.deliveryStats?.receivedCount === 1 &&
        latency < 500,
      `Part 123456 marked received by ${evB.employeeName}, stats.receivedCount=${evB.payload?.deliveryStats?.receivedCount}, seq=${evB.sequenceNumber}`,
      latency
    );
  }

  // 5. Test Worker B scans a different part -> Worker A updates immediately (<500ms)
  {
    const scanWaitA = workerA.waitForEvent(
      (e) => e.type === 'part:scanned' && e.partId === `${deliveryId1}_p2`
    );
    const t0 = performance.now();
    const resB = await apiReq(
      `/api/deliveries/${deliveryId1}/parts/${deliveryId1}_p2/receive`,
      'POST',
      loginB.data.token,
      {
        receivedQuantity: 1,
        code: '789012-2',
        scanType: 'qr',
        mode: 'set',
      }
    );
    const evA = await scanWaitA;
    const latency = performance.now() - t0;

    recordResult(
      5,
      'Worker B scans Part 2 -> Worker A updates immediately (<500ms)',
      resB.status === 200 &&
        evA.payload?.part?.status === 'received' &&
        evA.payload?.deliveryStats?.receivedCount === 2 &&
        latency < 500,
      `Part 789012 marked received by ${evA.employeeName}, stats.receivedCount=${evA.payload?.deliveryStats?.receivedCount}, seq=${evA.sequenceNumber}`,
      latency
    );
  }

  // 6. Test Simultaneous Scans of DIFFERENT Parts by Worker A and Worker B
  {
    // Reset p1 and p2 first or add p6 & p7? Let's use p3 for Worker A and a newly added part p6 for Worker B, or test p3 + p5 partial
    // Let's add p6 so we have two fresh single-qty parts for simultaneous different-part scan test
    await apiReq(`/api/deliveries/${deliveryId1}/parts`, 'POST', tokenA, {
      id: `${deliveryId1}_p6`,
      partNumber: '654321',
      itemNumber: '6',
      description: 'Simultaneous Diff Part B',
      quantity: 1,
      palletNumber: 'Pallet 1',
    });

    const waitP3OnB = workerB.waitForEvent(
      (e) => e.type === 'part:scanned' && e.partId === `${deliveryId1}_p3`
    );
    const waitP6OnA = workerA.waitForEvent(
      (e) => e.type === 'part:scanned' && e.partId === `${deliveryId1}_p6`
    );

    const t0 = performance.now();
    const [resDiffA, resDiffB] = await Promise.all([
      apiReq(`/api/deliveries/${deliveryId1}/parts/${deliveryId1}_p3/receive`, 'POST', tokenA, {
        receivedQuantity: 1,
        code: '345678-3',
        scanType: 'qr',
      }),
      apiReq(
        `/api/deliveries/${deliveryId1}/parts/${deliveryId1}_p6/receive`,
        'POST',
        loginB.data.token,
        {
          receivedQuantity: 1,
          code: '654321-6',
          scanType: 'qr',
        }
      ),
    ]);
    const [evP3, evP6] = await Promise.all([waitP3OnB, waitP6OnA]);
    const latency = performance.now() - t0;

    recordResult(
      6,
      'Simultaneous scans of DIFFERENT parts (345678 & 654321) -> both accepted & synced',
      resDiffA.status === 200 &&
        resDiffB.status === 200 &&
        evP3.payload?.part?.status === 'received' &&
        evP6.payload?.part?.status === 'received',
      `Both scans accepted concurrently (HTTP ${resDiffA.status} & ${resDiffB.status}) and broadcast to peers`,
      latency
    );
  }

  // 7. Test Simultaneous Scans of the SAME Part within milliseconds (Race Condition Protection)
  {
    const t0 = performance.now();
    const [raceResA, raceResB] = await Promise.all([
      apiReq(`/api/deliveries/${deliveryId1}/parts/${deliveryId1}_p4/receive`, 'POST', tokenA, {
        receivedQuantity: 1,
        code: '555888-4',
        scanType: 'qr',
        mode: 'set',
      }),
      apiReq(
        `/api/deliveries/${deliveryId1}/parts/${deliveryId1}_p4/receive`,
        'POST',
        loginB.data.token,
        {
          receivedQuantity: 1,
          code: '555888-4',
          scanType: 'qr',
          mode: 'set',
        }
      ),
    ]);
    const latency = performance.now() - t0;

    const statuses = [raceResA.status, raceResB.status].sort();
    const winner = raceResA.status === 200 ? raceResA : raceResB;
    const loser = raceResA.status === 409 ? raceResA : raceResB;

    // Verify D1 authoritative state has receivedQuantity === 1 (never 2!)
    const delCheck = await apiReq(`/api/deliveries/${deliveryId1}`, 'GET', tokenA);
    const part4 = (delCheck.data?.parts || delCheck.data?.delivery?.parts)?.find(
      (p: any) => p.id === `${deliveryId1}_p4`
    );

    recordResult(
      7,
      'Simultaneous scans of SAME part (555888) -> atomic lock accepts 1 (200) & rejects 2nd (409)',
      statuses[0] === 200 &&
        statuses[1] === 409 &&
        loser.data?.duplicate === true &&
        Boolean(loser.data?.alreadyScannedBy) &&
        String(loser.data?.error || '').includes(
          'Duplicate scan – this part has already been received by another worker'
        ) &&
        part4?.receivedQuantity === 1,
      `Statuses=[${statuses.join(', ')}], Winner qty=${winner.data?.part?.receivedQuantity}, Loser duplicate=${loser.data?.duplicate} ("${loser.data?.error}" by ${loser.data?.alreadyScannedBy})`,
      latency
    );
  }

  // 8. Test Subsequent Duplicate Scan of Already-Received Part by Another Worker
  {
    const dupWaitA = workerA.waitForEvent(
      (e) => e.type === 'part:duplicate_rejected' && e.partId === `${deliveryId1}_p1`
    );
    const t0 = performance.now();
    const subDupRes = await apiReq(
      `/api/deliveries/${deliveryId1}/parts/${deliveryId1}_p1/receive`,
      'POST',
      loginC.data.token,
      {
        receivedQuantity: 1,
        code: '123456-1',
        scanType: 'qr',
        mode: 'set',
      }
    );
    const dupEv = await dupWaitA;
    const latency = performance.now() - t0;

    recordResult(
      8,
      'Subsequent scan of already-received part -> rejected with 409 & duplicate metadata',
      subDupRes.status === 409 &&
        subDupRes.data?.duplicate === true &&
        Boolean(subDupRes.data?.alreadyScannedBy) &&
        Boolean(subDupRes.data?.alreadyScannedAt) &&
        dupEv.type === 'part:duplicate_rejected',
      `HTTP 409: "${subDupRes.data?.error}" (alreadyScannedBy=${subDupRes.data?.alreadyScannedBy})`,
      latency
    );
  }

  // 9. Test Multi-Quantity & Incremental Multi-Pallet Receiving Across Multiple Workers
  {
    // Part 5 requires 24 pieces. Worker A receives Pallet 1 (12 pcs) with mode: 'increment', Worker B receives Pallet 2 (12 pcs) with mode: 'increment'.
    const waitPartial = workerB.waitForEvent(
      (e) =>
        e.type === 'quantity:updated' &&
        e.partId === `${deliveryId1}_p5` &&
        e.payload?.receivedQuantity === 12
    );
    const inc1 = await apiReq(
      `/api/deliveries/${deliveryId1}/parts/${deliveryId1}_p5/receive`,
      'POST',
      tokenA,
      {
        receivedQuantity: 12,
        code: '900240-5',
        scanType: 'ocr_label',
        mode: 'increment',
      }
    );
    await waitPartial;

    const waitFull = workerA.waitForEvent(
      (e) =>
        e.type === 'part:scanned' &&
        e.partId === `${deliveryId1}_p5` &&
        e.payload?.receivedQuantity === 24
    );
    const inc2 = await apiReq(
      `/api/deliveries/${deliveryId1}/parts/${deliveryId1}_p5/receive`,
      'POST',
      loginB.data.token,
      {
        receivedQuantity: 12,
        code: '900240-5',
        scanType: 'ocr_label',
        mode: 'increment',
      }
    );
    await waitFull;

    // Now that 24/24 are received, a 3rd incremental scan must be rejected with 409 Duplicate!
    const inc3 = await apiReq(
      `/api/deliveries/${deliveryId1}/parts/${deliveryId1}_p5/receive`,
      'POST',
      tokenA,
      {
        receivedQuantity: 6,
        code: '900240-5',
        scanType: 'ocr_label',
        mode: 'increment',
      }
    );

    recordResult(
      9,
      'Multi-quantity & incremental multi-pallet receiving (12/24 -> 24/24 -> 3rd rejected)',
      inc1.status === 200 &&
        inc1.data?.part?.receivedQuantity === 12 &&
        inc1.data?.part?.verificationStatus === 'quantity_mismatch' &&
        inc2.status === 200 &&
        inc2.data?.part?.receivedQuantity === 24 &&
        inc2.data?.part?.verificationStatus === 'verified' &&
        inc3.status === 409 &&
        inc3.data?.duplicate === true,
      `Scan 1: 12/24 (mismatch), Scan 2: 24/24 (verified), Scan 3: HTTP ${inc3.status} duplicate=${inc3.data?.duplicate}`
    );
  }

  // 10. Test Idempotency Key Replay Protection (Offline/Retry Deduplication)
  {
    await apiReq(`/api/deliveries/${deliveryId1}/parts`, 'POST', tokenA, {
      id: `${deliveryId1}_p7`,
      partNumber: '777111',
      itemNumber: '7',
      description: 'Idempotency Test Part',
      quantity: 10,
      palletNumber: 'Pallet 2',
    });

    const idemKey = `idem_${Date.now()}_retry_test`;
    const firstTry = await apiReq(
      `/api/deliveries/${deliveryId1}/parts/${deliveryId1}_p7/receive`,
      'POST',
      tokenA,
      {
        receivedQuantity: 5,
        code: '777111-7',
        scanType: 'qr',
        mode: 'increment',
        idempotencyKey: idemKey,
      }
    );
    const replayTry = await apiReq(
      `/api/deliveries/${deliveryId1}/parts/${deliveryId1}_p7/receive`,
      'POST',
      tokenA,
      {
        receivedQuantity: 5,
        code: '777111-7',
        scanType: 'qr',
        mode: 'increment',
        idempotencyKey: idemKey,
      }
    );

    recordResult(
      10,
      'Idempotency key replay protection (network retry does not double-increment)',
      firstTry.status === 200 &&
        firstTry.data?.part?.receivedQuantity === 5 &&
        replayTry.status === 200 &&
        replayTry.data?.idempotentReplay === true &&
        replayTry.data?.part?.receivedQuantity === 5,
      `First call qty=${firstTry.data?.part?.receivedQuantity}, Replay call idempotentReplay=${replayTry.data?.idempotentReplay}, qty=${replayTry.data?.part?.receivedQuantity}`
    );
  }

  // 11. Test Scan Reversal / Undo Synchronisation Across Connected Devices
  {
    const waitReversalB = workerB.waitForEvent(
      (e) => e.type === 'part:scan_reversed' && e.partId === `${deliveryId1}_p7`
    );
    const t0 = performance.now();
    const revRes = await apiReq(
      `/api/deliveries/${deliveryId1}/parts/${deliveryId1}_p7/receive`,
      'POST',
      tokenA,
      {
        receivedQuantity: 0,
        code: 'UNDO',
        scanType: 'manual',
        mode: 'set',
      }
    );
    const revEv = await waitReversalB;
    const latency = performance.now() - t0;

    recordResult(
      11,
      'Scan reversal / undo broadcasts part:scan_reversed & restores outstanding state',
      revRes.status === 200 &&
        revEv.payload?.part?.status === 'outstanding' &&
        revEv.payload?.part?.receivedQuantity === 0,
      `Part 777111 reset to outstanding (qty=0) on Worker B in ${latency.toFixed(1)}ms`,
      latency
    );
  }

  // 12. Test Manual Part Addition, Inline Edit, and Deletion Synchronisation
  {
    const tempPartId = `${deliveryId1}_p_manual`;
    const waitAddB = workerB.waitForEvent(
      (e) => e.type === 'part:added' && e.partId === tempPartId
    );
    const addRes = await apiReq(`/api/deliveries/${deliveryId1}/parts`, 'POST', tokenA, {
      id: tempPartId,
      partNumber: 'MAN-909',
      itemNumber: '8',
      description: 'Manual Gusset Plate',
      quantity: 4,
      palletNumber: 'Pallet 2',
    });
    const addEv = await waitAddB;

    const waitEditB = workerB.waitForEvent(
      (e) => e.type === 'part:edited' && e.partId === tempPartId
    );
    const editRes = await apiReq(
      `/api/deliveries/${deliveryId1}/parts/${tempPartId}`,
      'PATCH',
      loginC.data.token,
      {
        description: 'Manual Gusset Plate Rev B (Edited by Supervisor)',
        revision: 'B',
        quantity: 6,
      }
    );
    const editEv = await waitEditB;

    const waitDelB = workerB.waitForEvent(
      (e) => e.type === 'part:deleted' && e.partId === tempPartId
    );
    const delRes = await apiReq(
      `/api/deliveries/${deliveryId1}/parts/${tempPartId}`,
      'DELETE',
      tokenA
    );
    const delEv = await waitDelB;

    recordResult(
      12,
      'Manual part add, inline edit, and delete synchronise across all devices',
      addRes.status === 201 &&
        addEv.payload?.part?.partNumber === 'MAN-909' &&
        editRes.status === 200 &&
        editEv.payload?.part?.revision === 'B' &&
        editEv.payload?.part?.quantity === 6 &&
        delRes.status === 200 &&
        delEv.partId === tempPartId,
      `part:added (seq=${addEv.sequenceNumber}) -> part:edited (seq=${editEv.sequenceNumber}) -> part:deleted (seq=${delEv.sequenceNumber})`
    );
  }

  // 13. Test Delivery Completion and Reopening Synchronisation
  {
    const waitCompleteB = workerB.waitForEvent(
      (e) => e.type === 'delivery:completed' && e.deliveryId === deliveryId1
    );
    const compRes = await apiReq(`/api/deliveries/${deliveryId1}`, 'PATCH', tokenA, {
      status: 'completed',
    });
    const compEv = await waitCompleteB;

    const waitReopenB = workerB.waitForEvent(
      (e) => e.type === 'delivery:reopened' && e.deliveryId === deliveryId1
    );
    const reopRes = await apiReq(`/api/deliveries/${deliveryId1}`, 'PATCH', tokenA, {
      status: 'receiving',
    });
    const reopEv = await waitReopenB;

    recordResult(
      13,
      'Delivery completion and reopening synchronise across all devices',
      compRes.status === 200 &&
        compEv.payload?.status === 'completed' &&
        reopRes.status === 200 &&
        reopEv.payload?.status === 'receiving',
      `delivery:completed (seq=${compEv.sequenceNumber}) -> delivery:reopened (seq=${reopEv.sequenceNumber})`
    );
  }

  // 14. Test Out-of-Order / Stale Version Protection in Client Reducer
  {
    const mockDeliveries: Delivery[] = [
      {
        id: deliveryId1,
        docketNumber: 'DK-RT-99401',
        supplier: 'GCI',
        deliveryDate: '2026-11-12',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        palletCount: 1,
        status: 'receiving',
        version: 15,
        parts: [
          {
            id: `${deliveryId1}_p1`,
            docketLineIndex: 1,
            partNumber: '123456',
            itemNumber: '1',
            description: 'Chassis Side Rail',
            quantity: 1,
            receivedQuantity: 1,
            status: 'received',
            verificationStatus: 'verified',
            palletNumber: 'Pallet 1',
          },
        ],
        docketAttachments: [],
        unexpectedParts: [],
        scanHistory: [],
      },
    ];

    const staleEvent: RealtimeSyncEvent = {
      id: 'evt_stale_test',
      type: 'part:scan_reversed',
      deliveryId: deliveryId1,
      partId: `${deliveryId1}_p1`,
      userId: userA.id,
      employeeName: 'Stale Packet',
      employeeRole: 'operator',
      timestamp: new Date(Date.now() - 60000).toISOString(),
      sequenceNumber: 2,
      deliveryVersion: 5, // Older than current version 15!
      payload: {
        part: {
          id: `${deliveryId1}_p1`,
          docketLineIndex: 1,
          partNumber: '123456',
          itemNumber: '1',
          description: 'Chassis Side Rail',
          quantity: 1,
          receivedQuantity: 0,
          status: 'outstanding',
          verificationStatus: 'unscanned',
          palletNumber: 'Pallet 1',
        },
      },
    };

    const applied = applyRealtimeEventToDeliveries(mockDeliveries, staleEvent);
    recordResult(
      14,
      'Out-of-order / stale deliveryVersion events are ignored and never overwrite newer state',
      applied.changed === false &&
        applied.deliveries[0].parts[0].status === 'received' &&
        applied.deliveries[0].version === 15,
      `Stale event (v5 < v15) ignored: changed=${applied.changed}, status remained "${applied.deliveries[0].parts[0].status}"`
    );
  }

  // 15. Test Temporary Disconnect, Offline Scan happens while disconnected, and Reconnect Catch-Up
  {
    const seqBeforeDisconnect = workerB.lastSeq;
    workerB.disconnect();

    // While Worker B is disconnected, Worker A scans part p7
    const scanWhileOffline = await apiReq(
      `/api/deliveries/${deliveryId1}/parts/${deliveryId1}_p7/receive`,
      'POST',
      tokenA,
      {
        receivedQuantity: 10,
        code: '777111-7',
        scanType: 'qr',
        mode: 'set',
      }
    );

    // Worker B reconnects passing its lastSeq and automatically receives missed events via sync_catchup + HTTP endpoint
    const catchupHttp = await apiReq(
      `/api/realtime/events?sinceSeq=${seqBeforeDisconnect}&deliveryId=${encodeURIComponent(deliveryId1)}`,
      'GET',
      loginB.data.token
    );
    await workerB.connect(deliveryId1);
    const caughtUpEvent = await workerB.waitForEvent(
      (e) =>
        e.sequenceNumber > seqBeforeDisconnect &&
        e.partId === `${deliveryId1}_p7` &&
        e.type === 'part:scanned',
      2000
    );

    recordResult(
      15,
      'Disconnect & reconnect catch-up recovers missed scan events in sequence order',
      scanWhileOffline.status === 200 &&
        catchupHttp.status === 200 &&
        Array.isArray(catchupHttp.data?.events) &&
        catchupHttp.data.events.some((e: any) => e.partId === `${deliveryId1}_p7`) &&
        Boolean(caughtUpEvent),
      `Missed events since seq ${seqBeforeDisconnect} recovered via WebSocket catch-up & HTTP (${catchupHttp.data?.events?.length} event(s))`
    );
  }

  // 16. Test Multi-Delivery Room Isolation (Delivery 1 vs Delivery 2)
  {
    await apiReq('/api/deliveries', 'POST', loginC.data.token, {
      id: deliveryId2,
      docketNumber: 'DK-ISO-202',
      supplier: 'Laser Central',
      supplierProfile: 'laser_central',
      deliveryDate: '2026-11-12',
      palletCount: 1,
      status: 'receiving',
      parts: [
        {
          id: `${deliveryId2}_p1`,
          partNumber: '998877',
          itemNumber: '1',
          description: 'Isolated Delivery 2 Part',
          quantity: 1,
          palletNumber: 'Pallet 1',
          status: 'outstanding',
        },
      ],
    });

    workerC.sendJson({ type: 'join_delivery', deliveryId: deliveryId2, status: 'scanning' });
    await new Promise((r) => setTimeout(r, 60));

    // Worker C scans in Delivery 2
    await apiReq(
      `/api/deliveries/${deliveryId2}/parts/${deliveryId2}_p1/receive`,
      'POST',
      loginC.data.token,
      {
        receivedQuantity: 1,
        code: '998877-1',
        scanType: 'barcode',
      }
    );

    const del1Check = await apiReq(`/api/deliveries/${deliveryId1}`, 'GET', tokenA);
    const del2Check = await apiReq(`/api/deliveries/${deliveryId2}`, 'GET', tokenA);
    const presDel1 = await apiReq(
      `/api/realtime/presence?deliveryId=${encodeURIComponent(deliveryId1)}`,
      'GET',
      tokenA
    );
    const presDel2 = await apiReq(
      `/api/realtime/presence?deliveryId=${encodeURIComponent(deliveryId2)}`,
      'GET',
      tokenA
    );

    const workerCInDel1 = (presDel1.data?.presence?.deliveryWorkers || []).some(
      (w: any) => w.userId === workerC.userId
    );
    const workerCInDel2 = (presDel2.data?.presence?.deliveryWorkers || []).some(
      (w: any) => w.userId === workerC.userId
    );

    recordResult(
      16,
      'Multi-delivery room isolation (Delivery 1 vs Delivery 2 presence & parts isolated)',
      !workerCInDel1 &&
        workerCInDel2 &&
        (del2Check.data?.parts || del2Check.data?.delivery?.parts)?.[0]?.status === 'received' &&
        (del1Check.data?.docketNumber || del1Check.data?.delivery?.docketNumber) === 'DK-RT-99401',
      `Worker C isolated in Delivery 2 room (inDel1=${workerCInDel1}, inDel2=${workerCInDel2})`
    );
  }

  // 17. Test Deactivated User Session Revocation Disconnects Live WebSocket Immediately
  {
    const deactRes = await apiReq(`/api/users/${workerC.userId}`, 'PATCH', tokenA, {
      active: false,
    });
    await new Promise((r) => setTimeout(r, 100));
    const wasRevoked = workerC.authRevoked;

    // Re-activate Worker C and clean up test deliveries
    await apiReq(`/api/users/${workerC.userId}`, 'PATCH', tokenA, { active: true });
    await apiReq(`/api/deliveries/${deliveryId1}`, 'DELETE', tokenA);
    await apiReq(`/api/deliveries/${deliveryId2}`, 'DELETE', tokenA);

    recordResult(
      17,
      'Deactivating an employee account immediately revokes their live WebSocket session',
      deactRes.status === 200 && wasRevoked === true,
      `Worker C WebSocket revoked=${wasRevoked} immediately upon account deactivation`
    );
  }

  workerA.disconnect();
  workerB.disconnect();
  workerC.disconnect();

  // 18. Cloudflare Worker Global Scope Validation on build/worker.js
  {
    const origSetInterval = globalThis.setInterval;
    const origSetTimeout = globalThis.setTimeout;
    const origFetch = globalThis.fetch;
    const origMathRandom = Math.random;

    let globalScopeError: Error | null = null;
    const disallow = (op: string) => () => {
      const err = new Error(
        `Uncaught Error: Disallowed operation called within global scope (${op}).`
      );
      globalScopeError = err;
      throw err;
    };

    try {
      (globalThis as any).setInterval = disallow('setInterval');
      (globalThis as any).setTimeout = disallow('setTimeout');
      (globalThis as any).fetch = disallow('fetch');
      Math.random = disallow('Math.random') as any;

      // @ts-ignore — generated dynamically by `npm run build`
      const workerModule = await import('../build/worker.js');
      const hasDefaultExport = typeof workerModule?.default?.fetch === 'function';
      const hasDurableObjectClass = typeof workerModule?.PalletTrackRealtimeHub === 'function';

      recordResult(
        18,
        'Cloudflare Worker bundle (build/worker.js) passes strict global-scope validation',
        globalScopeError === null && hasDefaultExport && hasDurableObjectClass,
        `Imported build/worker.js with zero global-scope timers/fetch/random calls (default.fetch=${hasDefaultExport}, PalletTrackRealtimeHub=${hasDurableObjectClass})`
      );
    } catch (err: any) {
      recordResult(
        18,
        'Cloudflare Worker bundle (build/worker.js) passes strict global-scope validation',
        false,
        `Global scope violation: ${err?.message || err}`
      );
    } finally {
      globalThis.setInterval = origSetInterval;
      globalThis.setTimeout = origSetTimeout;
      globalThis.fetch = origFetch;
      Math.random = origMathRandom;
    }
  }

  // 19. Lazy Request-Scoped Heartbeat Lifecycle & Clean Shutdown
  {
    const { PalletTrackRealtimeBroker } = await import('../src/server/realtime/realtimeHub.ts');
    const broker = new PalletTrackRealtimeBroker();
    const idleBeforeConnect = broker.isHeartbeatRunning() === false;

    const sentPackets: string[] = [];
    const mockSocket1 = {
      readyState: 1,
      send: (data: string) => sentPackets.push(data),
      close: () => {},
    };
    const mockSocket2 = {
      readyState: 1,
      send: (data: string) => sentPackets.push(data),
      close: () => {},
    };
    const mockUser = {
      id: 'usr_hb_test',
      employeeName: 'Heartbeat Tester',
      employeeCode: 'HB-01',
      role: 'operator' as const,
      active: true,
    };

    const conn1 = broker.registerClient(mockSocket1, mockUser, 'tok_hb_1', null);
    const runningAfterFirst = broker.isHeartbeatRunning() === true;

    const conn2 = broker.registerClient(mockSocket2, mockUser, 'tok_hb_2', null);
    const runningAfterSecond = broker.isHeartbeatRunning() === true;

    broker.pruneStaleConnectionsAndPing();
    const receivedPing = sentPackets.some((p) => p.includes('"type":"ping"'));

    broker.unregisterClient(conn1);
    const stillRunningWithOneClient = broker.isHeartbeatRunning() === true;

    broker.unregisterClient(conn2);
    const stoppedAfterLastDisconnect =
      broker.isHeartbeatRunning() === false && broker.getConnectedClientCount() === 0;

    recordResult(
      19,
      'Lazy heartbeat starts on client connect, avoids duplicate timers, pings, and stops when idle',
      idleBeforeConnect &&
        runningAfterFirst &&
        runningAfterSecond &&
        receivedPing &&
        stillRunningWithOneClient &&
        stoppedAfterLastDisconnect,
      `idleAtConstruct=${idleBeforeConnect} -> activeOnConnect=${runningAfterFirst} -> pingSent=${receivedPing} -> stoppedWhenEmpty=${stoppedAfterLastDisconnect}`
    );
  }

  // 20. Cloudflare Durable Object (PalletTrackRealtimeHub) Native Alarm Lifecycle
  {
    const { PalletTrackRealtimeHub } = await import('../worker.ts');
    let scheduledAlarmMs: number | null = null;
    let setAlarmCalls = 0;
    let deleteAlarmCalls = 0;

    const mockDoState = {
      storage: {
        getAlarm: async () => scheduledAlarmMs,
        setAlarm: async (time: number | Date) => {
          scheduledAlarmMs = typeof time === 'number' ? time : time.getTime();
          setAlarmCalls++;
        },
        deleteAlarm: async () => {
          scheduledAlarmMs = null;
          deleteAlarmCalls++;
        },
      },
    };

    const listeners: Record<string, Array<(evt?: any) => void>> = {};
    const doSentMessages: string[] = [];
    const origWebSocketPair = (globalThis as any).WebSocketPair;
    (globalThis as any).WebSocketPair = class {
      0: any;
      1: any;
      constructor() {
        this[0] = {};
        this[1] = {
          readyState: 1,
          accept: () => {},
          send: (data: string) => doSentMessages.push(data),
          close: () => {},
          addEventListener: (event: string, cb: (evt?: any) => void) => {
            listeners[event] = listeners[event] || [];
            listeners[event].push(cb);
          },
        };
      }
    };

    try {
      const hub = new PalletTrackRealtimeHub(mockDoState, {});
      const noAlarmAtInit = scheduledAlarmMs === null && setAlarmCalls === 0;

      // Simulate authenticated WebSocket upgrade request to Durable Object
      const wsReq = new Request('https://internal.pallettrack/api/realtime/ws?deliveryId=del_do_1', {
        headers: {
          Upgrade: 'websocket',
          'X-Authenticated-User': JSON.stringify({
            id: 'usr_do_1',
            employeeName: 'DO Worker',
            employeeCode: 'DO-01',
            role: 'operator',
            active: true,
          }),
          'X-Session-Token': 'tok_do_1',
        },
      });
      await hub.fetch(wsReq).catch(() => {
        // Node Response(null, { status: 101 }) throws RangeError in standard Node fetch Response,
        // which occurs after registerClient & scheduleHeartbeatAlarmIfNeeded complete
      });

      const alarmScheduledAfterConnect = scheduledAlarmMs !== null && setAlarmCalls === 1;

      // Trigger Durable Object alarm() handler
      await hub.alarm();
      const pingSentOnAlarm = doSentMessages.some((m) => m.includes('"type":"ping"'));
      const alarmRescheduled = scheduledAlarmMs !== null && setAlarmCalls === 2;

      // Simulate WebSocket close event
      for (const closeCb of listeners['close'] || []) {
        closeCb();
      }
      await new Promise((r) => setTimeout(r, 20));
      const alarmCleanedUp = scheduledAlarmMs === null && deleteAlarmCalls >= 1;

      recordResult(
        20,
        'Durable Object PalletTrackRealtimeHub uses native storage.setAlarm() and cleans up on disconnect',
        noAlarmAtInit &&
          alarmScheduledAfterConnect &&
          pingSentOnAlarm &&
          alarmRescheduled &&
          alarmCleanedUp,
        `noAlarmAtInit=${noAlarmAtInit}, scheduled=${alarmScheduledAfterConnect}, alarmPing=${pingSentOnAlarm}, cleanedUp=${alarmCleanedUp}`
      );
    } finally {
      (globalThis as any).WebSocketPair = origWebSocketPair;
    }
  }

  const passedCount = results.filter((r) => r.passed).length;
  const minLat = Math.min(...broadcastLatenciesMs);
  const maxLat = Math.max(...broadcastLatenciesMs);
  const avgLat =
    broadcastLatenciesMs.reduce((a, b) => a + b, 0) / Math.max(1, broadcastLatenciesMs.length);

  console.log('\n================================================================');
  console.log(` SUMMARY: ${passedCount}/${results.length} TESTS PASSED`);
  console.log(
    ` WEBSOCKET SYNC LATENCY: min=${minLat.toFixed(1)}ms | avg=${avgLat.toFixed(1)}ms | max=${maxLat.toFixed(1)}ms (Target <500ms)`
  );
  console.log('================================================================');

  if (passedCount !== results.length) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
