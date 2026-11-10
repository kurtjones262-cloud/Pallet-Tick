/**
 * Comprehensive verification script for PalletTrack Phase 2:
 * Multi-User Authentication & Role-Based Access Control (RBAC).
 */
import { getLocalDevDatabase } from '../src/server/db/nodeSqliteAdapter.ts';
import { PalletTrackDbService } from '../src/server/api/palletTrackDbService.ts';
import { handlePalletTrackApiRequest } from '../src/server/api/palletTrackApiRouter.ts';

async function runPhase2AuthTests() {
  console.log('========================================================');
  console.log('🧪 PALLETTRACK PHASE 2: AUTH & RBAC VERIFICATION SUITE');
  console.log('========================================================\n');

  const db = getLocalDevDatabase();
  const service = new PalletTrackDbService(db);

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${detail ? ` - ${detail}` : ''}`);
      failed++;
    }
  }

  // Helper to make mock Request to API Router
  async function callApi(
    path: string,
    method: string,
    body?: any,
    headers?: Record<string, string>
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const reqHeaders = new Headers({
      'Content-Type': 'application/json',
      ...headers,
    });
    const req = new Request(`http://localhost:3000${path}`, {
      method,
      headers: reqHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = await handlePalletTrackApiRequest(req, db);
    if (!res) {
      throw new Error(`Route not handled: ${method} ${path}`);
    }
    const resBody = await res.json().catch(() => ({}));
    return { status: res.status, body: resBody, headers: res.headers };
  }

  // Clean test users and sessions to test fresh provisioning
  await db.exec("DELETE FROM sessions;");
  await db.exec("DELETE FROM users WHERE employee_code LIKE 'TEST-%';");

  console.log('--- 1. Initial Provisioning & One-Time Setup ---');
  // Check provision status
  const provRes = await callApi('/api/auth/provision-status', 'GET');
  assert(provRes.status === 200, 'GET /api/auth/provision-status returns 200');

  // Create initial Admin if not exists or test admin
  const testAdminCode = 'TEST-ADMIN';
  const testAdminPin = '1234';

  // Test setup-admin endpoint
  // If system already has an admin, check that it blocks or test via service
  const hasExistingAdmin = (await service.getProvisionStatus()).hasAdmin;
  if (!hasExistingAdmin) {
    const setupRes = await callApi('/api/auth/setup-admin', 'POST', {
      employeeName: 'Super Administrator',
      employeeCode: testAdminCode,
      pin: testAdminPin,
    });
    assert(setupRes.status === 201, 'POST /api/auth/setup-admin provisions initial admin (201)');
    assert(Boolean(setupRes.body.token), 'Initial admin setup returns session token');

    // Attempting a second setup-admin MUST be rejected
    const dupSetupRes = await callApi('/api/auth/setup-admin', 'POST', {
      employeeName: 'Hacker Admin',
      employeeCode: 'TEST-HACK',
      pin: '9999',
    });
    assert(
      dupSetupRes.status === 400 && dupSetupRes.body.error.includes('permanently disabled'),
      'Subsequent setup-admin permanently disabled (400)'
    );
  } else {
    console.log('  ℹ️  Admin already provisioned from prior migration. Creating test admin directly.');
    await service.createUser({
      employeeName: 'Super Administrator',
      employeeCode: testAdminCode,
      role: 'admin',
      pin: testAdminPin,
    });
  }

  console.log('\n--- 2. PIN Login Authentication ---');
  // Correct PIN login
  const loginRes = await callApi('/api/auth/login', 'POST', {
    employeeCode: testAdminCode,
    pin: testAdminPin,
  });
  assert(loginRes.status === 200, 'Admin login with correct 4-digit PIN returns 200');
  assert(loginRes.body.user.role === 'admin', 'Logged in user has role = admin');
  const adminToken = loginRes.body.token;

  // Bad PIN login
  const badPinRes = await callApi('/api/auth/login', 'POST', {
    employeeCode: testAdminCode,
    pin: '0000',
  });
  assert(badPinRes.status === 401, 'Bad PIN returns 401 Unauthorized');
  assert(
    badPinRes.body.error === 'Invalid employee identifier or PIN',
    'Generic error message for bad PIN (never reveals account existence)'
  );

  // Non-existent user login
  const nonExistentRes = await callApi('/api/auth/login', 'POST', {
    employeeCode: 'TEST-NONEXISTENT',
    pin: '1234',
  });
  assert(nonExistentRes.status === 401, 'Non-existent user returns 401');
  assert(
    nonExistentRes.body.error === 'Invalid employee identifier or PIN',
    'Generic error message for non-existent user'
  );

  console.log('\n--- 3. Rate-Limiting & Lockout Protection ---');
  // Trigger 4 more consecutive failures (total 5)
  for (let i = 0; i < 3; i++) {
    await callApi('/api/auth/login', 'POST', {
      employeeCode: testAdminCode,
      pin: '0000',
    });
  }
  const lockoutTriggerRes = await callApi('/api/auth/login', 'POST', {
    employeeCode: testAdminCode,
    pin: '0000',
  });
  assert(
    lockoutTriggerRes.status === 429 && lockoutTriggerRes.body.code === 'ACCOUNT_LOCKED',
    '5th consecutive failed attempt triggers ACCOUNT_LOCKED (429)'
  );

  // Next attempt while locked
  const whileLockedRes = await callApi('/api/auth/login', 'POST', {
    employeeCode: testAdminCode,
    pin: testAdminPin, // Even with correct PIN, locked account must be rejected!
  });
  assert(
    whileLockedRes.status === 429 && whileLockedRes.body.error.includes('locked'),
    'Locked account rejected even with correct PIN'
  );

  // Admin resets PIN / unlocks account for testing
  await db
    .prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE UPPER(employee_code) = ?')
    .bind(testAdminCode)
    .run();
  console.log('  ℹ️  Unlocked test admin account');

  // Re-login as Admin
  const reloginRes = await callApi('/api/auth/login', 'POST', {
    employeeCode: testAdminCode,
    pin: testAdminPin,
  });
  const validAdminToken = reloginRes.body.token;

  console.log('\n--- 4. User Management & Employee Accounts (Admin Only) ---');
  // Create Supervisor
  const createSupRes = await callApi(
    '/api/users',
    'POST',
    {
      employeeName: 'Sarah Supervisor',
      employeeCode: 'TEST-SUP',
      role: 'supervisor',
      pin: '2222',
    },
    { Authorization: `Bearer ${validAdminToken}` }
  );
  assert(createSupRes.status === 201, 'Admin can create Supervisor account (201)');

  // Create Operator
  const createOpRes = await callApi(
    '/api/users',
    'POST',
    {
      employeeName: 'John Operator',
      employeeCode: 'TEST-OP',
      role: 'operator',
      pin: '3333',
    },
    { Authorization: `Bearer ${validAdminToken}` }
  );
  assert(createOpRes.status === 201, 'Admin can create Operator account (201)');

  // Duplicate employee code creation
  const dupCodeRes = await callApi(
    '/api/users',
    'POST',
    {
      employeeName: 'Duplicate Person',
      employeeCode: 'TEST-OP',
      role: 'operator',
      pin: '4444',
    },
    { Authorization: `Bearer ${validAdminToken}` }
  );
  assert(dupCodeRes.status === 400, 'Duplicate employee identifier rejected (400)');

  // Log in as Supervisor and Operator
  const supLogin = await callApi('/api/auth/login', 'POST', {
    employeeCode: 'TEST-SUP',
    pin: '2222',
  });
  assert(supLogin.status === 200, 'Supervisor logs in successfully');
  const supToken = supLogin.body.token;

  const opLogin = await callApi('/api/auth/login', 'POST', {
    employeeCode: 'TEST-OP',
    pin: '3333',
  });
  assert(opLogin.status === 200, 'Operator logs in successfully');
  const opToken = opLogin.body.token;

  console.log('\n--- 5. Role-Based Access Control (RBAC) Enforcement ---');
  // 1. Operator attempts to access User Management
  const opUsersRes = await callApi('/api/users', 'GET', null, {
    Authorization: `Bearer ${opToken}`,
  });
  assert(opUsersRes.status === 403, 'Operator blocked from GET /api/users (403 Forbidden)');

  // 2. Supervisor attempts to access User Management
  const supUsersRes = await callApi('/api/users', 'GET', null, {
    Authorization: `Bearer ${supToken}`,
  });
  assert(supUsersRes.status === 403, 'Supervisor blocked from GET /api/users (403 Forbidden)');

  // 3. Admin accesses User Management
  const adminUsersRes = await callApi('/api/users', 'GET', null, {
    Authorization: `Bearer ${validAdminToken}`,
  });
  assert(adminUsersRes.status === 200, 'Admin allowed GET /api/users (200 OK)');
  assert(Array.isArray(adminUsersRes.body), 'Admin receives list of employees');

  // 4. Operator attempts to create delivery
  const opCreateDelRes = await callApi(
    '/api/deliveries',
    'POST',
    {
      docketNumber: 'TEST-DOCKET-OP',
      supplier: 'Test Supplier',
      deliveryDate: '2026-11-10',
      parts: [],
    },
    { Authorization: `Bearer ${opToken}` }
  );
  assert(opCreateDelRes.status === 403, 'Operator blocked from creating deliveries (403 Forbidden)');

  // 5. Supervisor creates delivery
  const supCreateDelRes = await callApi(
    '/api/deliveries',
    'POST',
    {
      docketNumber: 'TEST-DOCKET-SUP-01',
      supplier: 'Laser Central',
      deliveryDate: '2026-11-10',
      parts: [
        {
          partNumber: 'TEST-BRK-100',
          itemNumber: '1001-01',
          description: 'Test Bracket 5mm',
          quantity: 2,
        },
      ],
    },
    { Authorization: `Bearer ${supToken}` }
  );
  assert(supCreateDelRes.status === 201, 'Supervisor allowed to create delivery (201)');
  const createdDelId = supCreateDelRes.body.id;
  const createdPartId = supCreateDelRes.body.parts[0].id;

  console.log('\n--- 6. Scan Event Employee Attribution ---');
  // Operator scans & receives part
  const opScanRes = await callApi(
    `/api/deliveries/${createdDelId}/parts/${createdPartId}/receive`,
    'POST',
    {
      receivedQuantity: 2,
      scannedVia: 'qr',
      scannedCode: 'TEST-BRK-100',
    },
    { Authorization: `Bearer ${opToken}` }
  );
  assert(opScanRes.status === 200, 'Operator allowed to scan & receive part (200)');
  assert(
    opScanRes.body.scanEvent.employeeName === 'John Operator',
    'Scan event attributed to authenticated employee name'
  );
  assert(
    opScanRes.body.scanEvent.employeeRole === 'operator',
    'Scan event attributed to authenticated employee role'
  );

  // Check scan history on delivery
  const scanHistoryRes = await callApi(`/api/deliveries/${createdDelId}/scans`, 'GET', null, {
    Authorization: `Bearer ${opToken}`,
  });
  assert(scanHistoryRes.status === 200, 'GET /api/deliveries/:id/scans returns 200');
  const lastScan = scanHistoryRes.body[0];
  assert(
    lastScan && lastScan.employeeName === 'John Operator',
    'Audit history persistently records employee name'
  );

  console.log('\n--- 7. Deactivated Account & Session Expiry ---');
  // Deactivate Operator account
  const opUserId = createOpRes.body.id;
  await callApi(
    `/api/users/${opUserId}`,
    'PATCH',
    { active: false },
    { Authorization: `Bearer ${validAdminToken}` }
  );

  // Operator attempts login while deactivated
  const deactLogin = await callApi('/api/auth/login', 'POST', {
    employeeCode: 'TEST-OP',
    pin: '3333',
  });
  assert(
    deactLogin.status === 403 && deactLogin.body.error.includes('deactivated'),
    'Deactivated employee login rejected (403)'
  );

  // Operator existing session token revoked on deactivation
  const deactSessionCheck = await callApi('/api/auth/session', 'GET', null, {
    Authorization: `Bearer ${opToken}`,
  });
  assert(deactSessionCheck.status === 401, 'Deactivated employee active sessions immediately revoked (401)');

  console.log('\n--- 8. Session Revocation on Logout ---');
  // Supervisor logs out
  const supLogoutRes = await callApi('/api/auth/logout', 'POST', null, {
    Authorization: `Bearer ${supToken}`,
  });
  assert(supLogoutRes.status === 200, 'Logout succeeds (200)');

  // Verify session is dead
  const postLogoutSession = await callApi('/api/auth/session', 'GET', null, {
    Authorization: `Bearer ${supToken}`,
  });
  assert(postLogoutSession.status === 401, 'Revoked session cannot access /api/auth/session');

  console.log('\n========================================================');
  console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase2AuthTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
