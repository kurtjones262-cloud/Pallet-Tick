/**
 * End-to-End Verification Suite:
 * PalletTrack – Complete Docket Management, Scanning & User Accountability Upgrade
 */

import fs from 'node:fs';
import path from 'node:path';
import { NodeSqliteD1Adapter } from '../src/server/db/nodeSqliteAdapter.ts';
import { PalletTrackDbService } from '../src/server/api/palletTrackDbService.ts';
import { handlePalletTrackApiRequest } from '../src/server/api/palletTrackApiRouter.ts';
import {
  parseIndustrialDocketText,
  segmentParsedPagesIntoDockets,
} from '../src/utils/docketParser.ts';
import { getStoredDeliveries, clearAllDeliveries } from '../src/utils/storage.ts';
import {
  createDeliveryPdfDoc,
  createGroupPdfDoc,
  formatPartScannersSummary,
} from '../src/utils/pdfExport.ts';
import type { Delivery, DocketGroup } from '../src/types/delivery.ts';

function assert(cond: boolean, message: string) {
  if (!cond) {
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
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const req = new Request(`http://localhost:3000${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await handlePalletTrackApiRequest(req, db, env);
  if (!res) {
    return { status: 404, data: { error: 'Route not handled' } };
  }
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function runTests() {
  console.log('🧪 Starting PalletTrack Docket Management, Scanning & Accountability Verification...\n');

  const testDbDir = path.resolve(process.cwd(), '.data', 'test');
  fs.mkdirSync(testDbDir, { recursive: true });
  const testDbPath = path.resolve(testDbDir, `test-docket-upgrade-${Date.now()}.db`);
  const schemaSql = fs.readFileSync(path.resolve(process.cwd(), 'schema.sql'), 'utf-8');
  const db = new NodeSqliteD1Adapter(testDbPath, schemaSql);
  const service = new PalletTrackDbService(db);

  try {
    // -----------------------------------------------------------------------
    // 1. Setup Admin & Users + Verify Fresh Empty Database (0 sample dockets)
    // -----------------------------------------------------------------------
    console.log('1. Verifying clean empty database & user account setup...');
    const setupRes = await apiCall(db, '/api/auth/setup-admin', 'POST', undefined, {
      employeeName: 'System Owner',
      employeeCode: 'ADM01',
      pin: '1234',
      setupSecret: 'test-setup-secret-9999',
    });
    assert(setupRes.status === 201 && Boolean(setupRes.data?.token), 'Super Admin setup succeeds');
    const adminToken: string = setupRes.data.token;

    const initialList = await apiCall(db, '/api/deliveries', 'GET', adminToken);
    assert(initialList.status === 200, 'GET /api/deliveries returns 200');
    assert(
      Array.isArray(initialList.data) && initialList.data.length === 0,
      `Fresh DB starts with 0 dockets (got ${initialList.data?.length})`
    );

    // Mock localStorage in Node to verify client cache helper never auto-restores samples
    const fakeStore = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => fakeStore.get(k) ?? null,
      setItem: (k: string, v: string) => fakeStore.set(k, v),
      removeItem: (k: string) => fakeStore.delete(k),
      clear: () => fakeStore.clear(),
    };
    assert(getStoredDeliveries().length === 0, 'getStoredDeliveries returns [] when empty');

    // Create John Smith (employee) and Dave Jones (supervisor)
    const createJohn = await apiCall(db, '/api/users', 'POST', adminToken, {
      employeeName: 'John Smith',
      employeeCode: 'JOHN1',
      role: 'employee',
      pin: '1111',
    });
    assert(createJohn.status === 201, 'Created employee John Smith');

    const createDave = await apiCall(db, '/api/users', 'POST', adminToken, {
      employeeName: 'Dave Jones',
      employeeCode: 'DAVE1',
      role: 'supervisor',
      pin: '2222',
    });
    assert(createDave.status === 201, 'Created supervisor Dave Jones');

    const loginJohn = await apiCall(db, '/api/auth/login', 'POST', undefined, {
      employeeCode: 'JOHN1',
      pin: '1111',
    });
    assert(loginJohn.status === 200 && loginJohn.data.token, 'John Smith logged in');
    const tokenJohn: string = loginJohn.data.token;

    const loginDave = await apiCall(db, '/api/auth/login', 'POST', undefined, {
      employeeCode: 'DAVE1',
      pin: '2222',
    });
    assert(loginDave.status === 200 && loginDave.data.token, 'Dave Jones logged in');
    const tokenDave: string = loginDave.data.token;
    console.log('   ✅ Passed: Empty DB starts at 0 dockets; users authenticated.');

    // -----------------------------------------------------------------------
    // 2. Multi-Docket OCR Segmentation & Multi-Page Grouping
    // -----------------------------------------------------------------------
    console.log('2. Verifying multi-docket separation & multi-page continuity...');
    const makeLines = (textBlock: string, pageNum: number) =>
      textBlock.split('\n').map((t) => ({ text: t.trim(), confidence: 95, pageNumber: pageNum }));

    const pageSame1 = parseIndustrialDocketText(
      makeLines(
        `Laser Central Pty Ltd
        Docket No: 194501
        Date: 10/11/2026
        No   Part No      Description           Qty
        1    PART-S1-A    Mount Plate           2
        2    PART-S1-B    Side Gusset           4`,
        1
      ),
      1
    );
    const pageSame2 = parseIndustrialDocketText(
      makeLines(
        `Laser Central Pty Ltd
        Docket No: 194501
        Date: 10/11/2026
        No   Part No      Description           Qty
        3    PART-S1-C    Base Channel          1`,
        2
      ),
      2
    );
    const sameCombined = segmentParsedPagesIntoDockets([pageSame1, pageSame2]);
    assert(sameCombined.length === 1, 'Two pages with same docket # remain 1 docket');
    assert(sameCombined[0].docketNumber === '194501', 'Combined docket preserves docketNumber 194501');
    assert(sameCombined[0].items.length === 3, 'Combined docket preserves all 3 items across 2 pages');
    assert(!sameCombined[0].separationUncertain, 'Same explicit docket pages not flagged uncertain');

    const pageDiffB = parseIndustrialDocketText(
      makeLines(
        `GCI Group
        Delivery Docket: 194502
        Date: 10/11/2026
        No   Part No      Description           Qty
        1    PART-S2-X    Top Bracket           6`,
        2
      ),
      2
    );
    const separatedTwo = segmentParsedPagesIntoDockets([pageSame1, pageDiffB]);
    assert(
      separatedTwo.length === 2,
      `Distinct docket numbers auto-split into 2 dockets (got ${separatedTwo.length})`
    );
    assert(separatedTwo[0].docketNumber === '194501', 'First segmented docket is 194501');
    assert(separatedTwo[1].docketNumber === '194502', 'Second segmented docket is 194502');

    const uncertainP1 = parseIndustrialDocketText(
      makeLines(
        `No   Part No      Description           Qty
        1    PART-U1      Plate One             2
        2    PART-U2      Plate Two             3
        3    PART-U3      Plate Three           1`,
        1
      ),
      1
    );
    const uncertainP2 = parseIndustrialDocketText(
      makeLines(
        `No   Part No      Description           Qty
        1    PART-U4      Plate Four            5`,
        2
      ),
      2
    );
    const uncertainSplit = segmentParsedPagesIntoDockets([uncertainP1, uncertainP2], {
      sourceFileIds: ['file_a.pdf', 'file_b.pdf'],
    });
    assert(uncertainSplit.length === 2, 'Uncertain multi-file upload splits conservatively');
    assert(
      uncertainSplit[1].needsManualReview === true && Boolean(uncertainSplit[1].separationReason),
      'Uncertain split flags needsManualReview with separationReason'
    );
    console.log('   ✅ Passed: Multi-docket splitting & multi-page continuity verified.');

    // -----------------------------------------------------------------------
    // 3. Independent Docket Creation & Duplicate Prevention (409)
    // -----------------------------------------------------------------------
    console.log('3. Verifying duplicate docket prevention & independent delivery records...');
    const empCreateBlocked = await apiCall(db, '/api/deliveries', 'POST', tokenJohn, {
      docketNumber: 'DK-TEST-A',
      supplier: 'Laser Central',
      parts: [{ partNumber: 'P-1', itemNumber: '1', description: 'Blocked', quantity: 1 }],
    });
    assert(empCreateBlocked.status === 403, 'Employee cannot create delivery');

    const createDelA = await apiCall(db, '/api/deliveries', 'POST', tokenDave, {
      docketNumber: 'DK-TEST-A',
      supplier: 'Laser Central',
      deliveryDate: '2026-11-10',
      parts: [
        { partNumber: 'PART-ALPHA', itemNumber: '1', description: 'Alpha Bracket', quantity: 5 },
        { partNumber: 'PART-BETA', itemNumber: '2', description: 'Beta Gusset', quantity: 2 },
      ],
    });
    assert(createDelA.status === 201 && createDelA.data?.id, 'Created Docket A');
    const delAId: string = createDelA.data.id;

    const dupCreateA = await apiCall(db, '/api/deliveries', 'POST', tokenDave, {
      docketNumber: '  dk-test-a ',
      supplier: 'Laser Central',
      deliveryDate: '2026-11-10',
      parts: [{ partNumber: 'PART-ALPHA', itemNumber: '1', description: 'Dup', quantity: 5 }],
    });
    assert(dupCreateA.status === 409, `Duplicate docket rejected with 409 (got ${dupCreateA.status})`);
    assert(dupCreateA.data?.code === 'DUPLICATE_DOCKET', 'Returns DUPLICATE_DOCKET code');

    const createDelB = await apiCall(db, '/api/deliveries', 'POST', tokenDave, {
      docketNumber: 'DK-TEST-B',
      supplier: 'GCI',
      deliveryDate: '2026-11-10',
      parts: [
        { partNumber: 'PART-BETA', itemNumber: '1', description: 'Beta Gusset (Order B)', quantity: 4 },
        { partNumber: 'PART-GAMMA', itemNumber: '2', description: 'Gamma Plate', quantity: 3 },
      ],
    });
    assert(createDelB.status === 201 && createDelB.data?.id, 'Created Docket B');
    const delBId: string = createDelB.data.id;

    const createDelC = await apiCall(db, '/api/deliveries', 'POST', tokenDave, {
      docketNumber: 'DK-OUTSIDE-C',
      supplier: 'Laser Central',
      deliveryDate: '2026-11-10',
      parts: [
        { partNumber: 'PART-EXTERNAL', itemNumber: '1', description: 'Outside Group Part', quantity: 2 },
      ],
    });
    assert(createDelC.status === 201 && createDelC.data?.id, 'Created Docket C (outside group)');
    const delCId: string = createDelC.data.id;
    console.log('   ✅ Passed: Independent dockets created and duplicates blocked (409).');

    // -----------------------------------------------------------------------
    // 4. Server-Derived Multi-User Attribution & Cumulative History
    // -----------------------------------------------------------------------
    console.log('4. Verifying server-derived multi-user scan attribution...');
    const delAFetched = await apiCall(db, `/api/deliveries/${delAId}`, 'GET', tokenJohn);
    const partAlphaId = delAFetched.data.parts.find((p: any) => p.partNumber === 'PART-ALPHA').id;
    const partBetaAId = delAFetched.data.parts.find((p: any) => p.partNumber === 'PART-BETA').id;

    // John scans 2 with spoofed body user fields — server MUST use session identity!
    const scanJohn = await apiCall(
      db,
      `/api/deliveries/${delAId}/parts/${partAlphaId}/receive`,
      'POST',
      tokenJohn,
      {
        receivedQuantity: 2,
        mode: 'increment',
        scannedVia: 'ocr_label',
        scannedCode: 'PART-ALPHA',
        employeeName: 'SPOOFED NAME',
        userId: 'usr_spoofed',
      }
    );
    assert(scanJohn.status === 200, 'John partial scan succeeded');
    assert(
      scanJohn.data.part.lastScannedByName === 'John Smith',
      `Server ignored spoofed employeeName (got "${scanJohn.data.part.lastScannedByName}")`
    );

    // Dave scans remaining 3 units on same part
    const scanDave = await apiCall(
      db,
      `/api/deliveries/${delAId}/parts/${partAlphaId}/receive`,
      'POST',
      tokenDave,
      {
        receivedQuantity: 3,
        mode: 'increment',
        scannedVia: 'qr',
        scannedCode: 'PART-ALPHA',
      }
    );
    assert(scanDave.status === 200, 'Dave follow-up scan succeeded');
    assert(scanDave.data.part.receivedQuantity === 5, 'Cumulative quantity reached 5/5');
    assert(scanDave.data.part.verificationStatus === 'verified', 'Part verified at 5/5');

    const delAAfter = await apiCall(db, `/api/deliveries/${delAId}`, 'GET', adminToken);
    const partAlphaAfter = delAAfter.data.parts.find((p: any) => p.id === partAlphaId);
    assert(
      Array.isArray(partAlphaAfter.scannedByUsers) && partAlphaAfter.scannedByUsers.length === 2,
      `Part tracks both scanners chronologically (got ${partAlphaAfter.scannedByUsers?.length})`
    );
    assert(
      formatPartScannersSummary(partAlphaAfter, delAAfter.data.scanHistory) ===
        'John Smith, Dave Jones',
      `Summary preserves both scanners: ${formatPartScannersSummary(partAlphaAfter)}`
    );
    console.log('   ✅ Passed: Multi-user attribution accumulated chronologically & securely.');

    // -----------------------------------------------------------------------
    // 5. Docket Groups CRUD, Scoping, Conflict Allocation & Non-Destructive Delete
    // -----------------------------------------------------------------------
    console.log('5. Verifying Docket Groups CRUD & scoped group scanning...');
    const createGroupRes = await apiCall(db, '/api/groups', 'POST', tokenDave, {
      name: 'Morning Steel Batch',
      deliveryIds: [delAId, delBId],
    });
    assert(createGroupRes.status === 201 && createGroupRes.data?.id, 'Created Docket Group');
    const groupId: string = createGroupRes.data.id;
    assert(createGroupRes.data.deliveryIds.length === 2, 'Group contains 2 dockets');

    // External part scan against Group must reject with 404 NOT_IN_GROUP
    const extScan = await apiCall(db, `/api/groups/${groupId}/scan`, 'POST', tokenJohn, {
      scannedCode: 'PART-EXTERNAL',
      scannedVia: 'qr',
    });
    assert(extScan.status === 404, `External part rejected with 404 (got ${extScan.status})`);
    const delCAfterExt = await apiCall(db, `/api/deliveries/${delCId}`, 'GET', adminToken);
    assert(
      delCAfterExt.data.parts[0].status === 'outstanding',
      'Docket C outside group was NOT modified by group scan'
    );

    // Ambiguous part PART-BETA present in both Docket A and Docket B must return 409 with candidates
    const ambigScan = await apiCall(db, `/api/groups/${groupId}/scan`, 'POST', tokenJohn, {
      scannedCode: 'PART-BETA',
      scannedVia: 'qr',
    });
    assert(ambigScan.status === 409, `Ambiguous group part returns 409 (got ${ambigScan.status})`);
    assert(
      ambigScan.data.code === 'AMBIGUOUS_GROUP_PART' &&
        Array.isArray(ambigScan.data.candidates) &&
        ambigScan.data.candidates.length === 2,
      'Ambiguous 409 returns AMBIGUOUS_GROUP_PART with 2 docket candidates'
    );

    // Allocate PART-BETA specifically to Docket B
    const delBFetched = await apiCall(db, `/api/deliveries/${delBId}`, 'GET', tokenJohn);
    const partBetaBId = delBFetched.data.parts.find((p: any) => p.partNumber === 'PART-BETA').id;
    const allocScan = await apiCall(db, `/api/groups/${groupId}/scan`, 'POST', tokenJohn, {
      scannedCode: 'PART-BETA',
      scannedVia: 'qr',
      receivedQuantity: 4,
      targetDeliveryId: delBId,
      targetPartId: partBetaBId,
    });
    assert(allocScan.status === 200 && allocScan.data.deliveryId === delBId, 'Allocated scan to Docket B');

    const checkDelAAfterAlloc = await apiCall(db, `/api/deliveries/${delAId}`, 'GET', adminToken);
    const checkDelBAfterAlloc = await apiCall(db, `/api/deliveries/${delBId}`, 'GET', adminToken);
    assert(
      checkDelAAfterAlloc.data.parts.find((p: any) => p.id === partBetaAId).status === 'outstanding',
      'Docket A PART-BETA remained outstanding after allocating to Docket B'
    );
    assert(
      checkDelBAfterAlloc.data.parts.find((p: any) => p.id === partBetaBId).status === 'received' &&
        checkDelBAfterAlloc.data.parts.find((p: any) => p.id === partBetaBId).lastScannedByName ===
          'John Smith',
      'Docket B PART-BETA received and attributed to John Smith'
    );

    // Non-destructive remove & group delete
    const tempGroup = await apiCall(db, '/api/groups', 'POST', tokenDave, {
      name: 'Temp Group To Delete',
      deliveryIds: [delCId],
    });
    const delTempGroup = await apiCall(
      db,
      `/api/groups/${tempGroup.data.id}`,
      'DELETE',
      tokenDave
    );
    assert(delTempGroup.status === 200, 'Group deleted cleanly');
    const delCStillExists = await apiCall(db, `/api/deliveries/${delCId}`, 'GET', adminToken);
    assert(delCStillExists.status === 200, 'Deleting group is non-destructive to underlying dockets');
    console.log('   ✅ Passed: Group scoping, conflict allocation & non-destructive group deletion verified.');

    // -----------------------------------------------------------------------
    // 6. PDF Export Generation (Single & Group with Attribution)
    // -----------------------------------------------------------------------
    console.log('6. Verifying PDF generation for individual dockets and groups...');
    const fullDelA: Delivery = delAAfter.data;
    const fullDelB: Delivery = checkDelBAfterAlloc.data;
    const fullGroup: DocketGroup = createGroupRes.data;

    const singleDoc = createDeliveryPdfDoc(fullDelA);
    const singlePdfText = JSON.stringify((singleDoc as any).internal.pages);
    assert(singlePdfText.includes('DK-TEST-A'), 'Single PDF includes docket number');
    assert(
      singlePdfText.includes('John Smith') && singlePdfText.includes('Dave Jones'),
      'Single PDF includes operator scanning attributions'
    );

    const groupDoc = createGroupPdfDoc(fullGroup, [fullDelA, fullDelB]);
    const groupPdfText = JSON.stringify((groupDoc as any).internal.pages);
    assert(groupPdfText.includes('Morning Steel Batch'), 'Group PDF includes group name');
    assert(
      groupPdfText.includes('DK-TEST-A') && groupPdfText.includes('DK-TEST-B'),
      'Group PDF includes separate sections for all member dockets'
    );
    console.log('   ✅ Passed: Individual & Group PDF generation verified.');

    // -----------------------------------------------------------------------
    // 7. Role-Restricted Completed Docket Deletion
    // -----------------------------------------------------------------------
    console.log('7. Verifying role-restricted completed docket deletion...');
    // Complete remaining part on Docket A
    const scanBetaA = await apiCall(
      db,
      `/api/deliveries/${delAId}/parts/${partBetaAId}/receive`,
      'POST',
      tokenDave,
      { receivedQuantity: 2, mode: 'set', scannedVia: 'qr', scannedCode: 'PART-BETA' }
    );
    assert(scanBetaA.status === 200, 'Completed second part on Docket A');
    await apiCall(db, `/api/deliveries/${delAId}`, 'PATCH', tokenDave, { status: 'completed' });

    const empDelAttempt = await apiCall(
      db,
      `/api/deliveries/${delAId}?completedOnly=1`,
      'DELETE',
      tokenJohn
    );
    assert(empDelAttempt.status === 403, `Employee delete blocked with 403 (got ${empDelAttempt.status})`);

    const incDelAttempt = await apiCall(
      db,
      `/api/deliveries/${delBId}?completedOnly=1`,
      'DELETE',
      tokenDave
    );
    assert(
      incDelAttempt.status === 409,
      `Deleting incomplete docket blocked with 409 (got ${incDelAttempt.status})`
    );

    const supDelSuccess = await apiCall(
      db,
      `/api/deliveries/${delAId}?completedOnly=1`,
      'DELETE',
      tokenDave
    );
    assert(supDelSuccess.status === 200 && supDelSuccess.data.deleted === true, 'Supervisor deleted completed docket');

    const groupAfterDocketDel = await apiCall(db, `/api/groups/${groupId}`, 'GET', tokenDave);
    assert(
      !groupAfterDocketDel.data.deliveryIds.includes(delAId),
      'Deleting completed docket automatically cleans up group memberships'
    );
    console.log('   ✅ Passed: Role & completion guards on docket deletion verified.');

    // -----------------------------------------------------------------------
    // 8. Clear All Dockets & Persistence Zero-Restore Verification
    // -----------------------------------------------------------------------
    console.log('8. Verifying CLEAR ALL DOCKETS & permanent zero-restore...');
    const empClearBlocked = await apiCall(db, '/api/deliveries/clear-all', 'POST', tokenJohn, {
      confirm: true,
    });
    assert(empClearBlocked.status === 403, `Employee clear-all blocked with 403 (got ${empClearBlocked.status})`);

    const adminClearOk = await apiCall(db, '/api/deliveries/clear-all', 'POST', adminToken, {
      confirm: true,
    });
    assert(
      adminClearOk.status === 200 &&
        adminClearOk.data.deletedDeliveries === 2 &&
        adminClearOk.data.deletedGroups === 1,
      `Admin cleared remaining 2 dockets and 1 group (got del=${adminClearOk.data.deletedDeliveries}, grp=${adminClearOk.data.deletedGroups})`
    );

    // Re-instantiate service on same DB to simulate server restart
    const restartedService = new PalletTrackDbService(db);
    const docketsAfterRestart = await restartedService.listDeliveries();
    const groupsAfterRestart = await restartedService.listGroups();
    assert(docketsAfterRestart.length === 0, 'After Clear All + restart: 0 dockets remain');
    assert(groupsAfterRestart.length === 0, 'After Clear All + restart: 0 groups remain');

    // Users & active sessions MUST be preserved
    const usersAfterClear = await apiCall(db, '/api/users', 'GET', adminToken);
    assert(usersAfterClear.status === 200 && usersAfterClear.data.length === 3, 'All 3 user accounts preserved');
    const sessionDaveStillValid = await apiCall(db, '/api/auth/session', 'GET', tokenDave);
    assert(sessionDaveStillValid.status === 200, 'Active sessions preserved after Clear All');

    // Client clearAllDeliveries stays empty
    clearAllDeliveries();
    assert(getStoredDeliveries().length === 0, 'Local storage stays at 0 dockets after clear');
    console.log('   ✅ Passed: Clear All Dockets wipes dockets/groups cleanly while preserving users/sessions.\n');

    console.log('🎉 ALL DOCKET MANAGEMENT, SCANNING & ACCOUNTABILITY TESTS PASSED!');
  } finally {
    try {
      fs.unlinkSync(testDbPath);
    } catch {}
  }
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
