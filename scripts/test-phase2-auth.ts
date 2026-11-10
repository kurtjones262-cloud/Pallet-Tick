/**
 * Comprehensive verification script for PalletTrack:
 * Multi-Admin & 4-Tier Role-Based Access Control (SUPER_ADMIN, ADMIN, SUPERVISOR, EMPLOYEE).
 */
import { getLocalDevDatabase } from '../src/server/db/nodeSqliteAdapter.ts';
import { PalletTrackDbService } from '../src/server/api/palletTrackDbService.ts';
import { handlePalletTrackApiRequest } from '../src/server/api/palletTrackApiRouter.ts';

async function runPhase2AuthTests() {
  console.log('==================================================================');
  console.log('🧪 PALLETTRACK MULTI-ADMIN & 4-TIER RBAC VERIFICATION SUITE');
  console.log('==================================================================\n');

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

  const TEST_SETUP_SECRET = 'test-only-strong-setup-secret-9941!';

  // Helper to make mock Request to API Router
  async function callApi(
    path: string,
    method: string,
    body?: any,
    headers?: Record<string, string>,
    envOverride?: Record<string, string | undefined>
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
    const envObj =
      envOverride !== undefined
        ? envOverride
        : { INITIAL_SETUP_SECRET: TEST_SETUP_SECRET };
    const res = await handlePalletTrackApiRequest(req, db, envObj);
    if (!res) {
      throw new Error(`Route not handled: ${method} ${path}`);
    }
    const resBody = await res.json().catch(() => ({}));
    return { status: res.status, body: resBody, headers: res.headers };
  }

  // Clean test users and sessions to test fresh Super Admin provisioning
  await db.exec("DELETE FROM sessions;");
  await db.exec("DELETE FROM users;");

  console.log('--- 1. Initial Super Admin Provisioning, Fail-Closed Secret & Rate Limiting ---');
  // Check provision status when empty
  const provRes = await callApi('/api/auth/provision-status', 'GET');
  assert(provRes.status === 200, 'GET /api/auth/provision-status returns 200');
  assert(provRes.body.hasSuperAdmin === false, 'Empty database reports hasSuperAdmin = false');

  const superAdminCode = 'SUPER-01';
  const superAdminPin = '1234';

  // 1a. Fail closed when INITIAL_SETUP_SECRET is missing/empty (503)
  const missingSecretEnvRes = await callApi(
    '/api/auth/setup-admin',
    'POST',
    {
      employeeName: 'Primary Super Admin',
      employeeCode: superAdminCode,
      pin: superAdminPin,
      setupSecret: TEST_SETUP_SECRET,
    },
    undefined,
    { INITIAL_SETUP_SECRET: '' }
  );
  assert(
    missingSecretEnvRes.status === 503 &&
      missingSecretEnvRes.body.code === 'SETUP_SECRET_NOT_CONFIGURED',
    'Fails closed (503 SETUP_SECRET_NOT_CONFIGURED) when INITIAL_SETUP_SECRET is not configured'
  );

  // 1b. Fail closed when INITIAL_SETUP_SECRET is weak (<12 chars) or legacy placeholder (503)
  const weakSecretEnvRes = await callApi(
    '/api/auth/setup-admin',
    'POST',
    {
      employeeName: 'Primary Super Admin',
      employeeCode: superAdminCode,
      pin: superAdminPin,
      setupSecret: 'short-key',
    },
    undefined,
    { INITIAL_SETUP_SECRET: 'short-key' }
  );
  assert(
    weakSecretEnvRes.status === 503 && weakSecretEnvRes.body.code === 'SETUP_SECRET_WEAK',
    'Fails closed (503 SETUP_SECRET_WEAK) when INITIAL_SETUP_SECRET is shorter than 12 chars'
  );

  // 1c. Verify setup process cannot be bypassed through alternative API routes (even with forged Bearer token)
  const bypassUsersRes = await callApi(
    '/api/users',
    'POST',
    { employeeName: 'Bypass Admin', employeeCode: 'BYPASS-01', role: 'super_admin', pin: '1234' },
    { Authorization: 'Bearer forged_token_value' }
  );
  assert(
    bypassUsersRes.status === 428 && bypassUsersRes.body.code === 'SETUP_REQUIRED',
    'Alternative route POST /api/users cannot bypass initial setup (428 SETUP_REQUIRED)'
  );

  // 1d. Attempt setup with WRONG secret -> must be rejected (403) and rate-limited after 5 attempts (429)
  for (let attempt = 1; attempt <= 4; attempt++) {
    const badSecretSetupRes = await callApi('/api/auth/setup-admin', 'POST', {
      employeeName: 'Primary Super Admin',
      employeeCode: superAdminCode,
      pin: superAdminPin,
      setupSecret: `WRONG-SECRET-ATTEMPT-${attempt}`,
    });
    if (attempt === 1) {
      assert(
        badSecretSetupRes.status === 403 &&
          badSecretSetupRes.body.code === 'INVALID_SETUP_SECRET' &&
          !JSON.stringify(badSecretSetupRes.body).includes(TEST_SETUP_SECRET),
        'Initial setup with invalid setupSecret rejected (403) without leaking expected secret'
      );
    }
  }

  // 5th failed setup attempt must trigger 429 SETUP_RATE_LIMITED
  const fifthBadSetupRes = await callApi('/api/auth/setup-admin', 'POST', {
    employeeName: 'Primary Super Admin',
    employeeCode: superAdminCode,
    pin: superAdminPin,
    setupSecret: 'WRONG-SECRET-ATTEMPT-5',
  });
  assert(
    fifthBadSetupRes.status === 429 && fifthBadSetupRes.body.code === 'SETUP_RATE_LIMITED',
    '5th failed setup secret attempt triggers rate-limit lockout (429 SETUP_RATE_LIMITED)'
  );

  // Even a valid setupSecret must be rejected while setup rate-limit lockout is active
  const lockedSetupRes = await callApi('/api/auth/setup-admin', 'POST', {
    employeeName: 'Primary Super Admin',
    employeeCode: superAdminCode,
    pin: superAdminPin,
    setupSecret: TEST_SETUP_SECRET,
  });
  assert(
    lockedSetupRes.status === 429 && lockedSetupRes.body.code === 'SETUP_RATE_LIMITED',
    'Setup endpoint remains locked (429) during 15-minute cooldown even with valid secret'
  );

  // Clear setup guard row to proceed with valid Super Admin provisioning
  await db.prepare("DELETE FROM users WHERE id = '__system_setup_guard__'").run();

  // 1e. Provision initial Super Admin with valid strong setupSecret
  const setupRes = await callApi('/api/auth/setup-admin', 'POST', {
    employeeName: 'Primary Super Admin',
    employeeCode: superAdminCode,
    pin: superAdminPin,
    setupSecret: TEST_SETUP_SECRET,
  });
  assert(setupRes.status === 201, 'POST /api/auth/setup-admin provisions initial Super Admin (201)');
  assert(setupRes.body.user?.role === 'super_admin', 'First provisioned account has role = super_admin');
  assert(Boolean(setupRes.body.token), 'Initial Super Admin setup returns session token');
  const superAdminId = setupRes.body.user.id;

  // 1f. Attempting a second setup-admin MUST be permanently rejected (403 SETUP_ALREADY_COMPLETED)
  const dupSetupRes = await callApi('/api/auth/setup-admin', 'POST', {
    employeeName: 'Second Super Admin Attempt',
    employeeCode: 'SUPER-02',
    pin: '9999',
    setupSecret: TEST_SETUP_SECRET,
  });
  assert(
    dupSetupRes.status === 403 &&
      dupSetupRes.body.code === 'SETUP_ALREADY_COMPLETED' &&
      dupSetupRes.body.error.includes('permanently disabled'),
    'Subsequent setup-admin permanently disabled once Super Admin exists (403 SETUP_ALREADY_COMPLETED)'
  );

  console.log('\n--- 2. PIN Login Authentication ---');
  // Correct PIN login for Super Admin
  const loginRes = await callApi('/api/auth/login', 'POST', {
    employeeCode: superAdminCode,
    pin: superAdminPin,
  });
  assert(loginRes.status === 200, 'Super Admin login with correct 4-digit PIN returns 200');
  assert(loginRes.body.user.role === 'super_admin', 'Logged in user has role = super_admin');

  // Bad PIN login
  const badPinRes = await callApi('/api/auth/login', 'POST', {
    employeeCode: superAdminCode,
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
      employeeCode: superAdminCode,
      pin: '0000',
    });
  }
  const lockoutTriggerRes = await callApi('/api/auth/login', 'POST', {
    employeeCode: superAdminCode,
    pin: '0000',
  });
  assert(
    lockoutTriggerRes.status === 429 && lockoutTriggerRes.body.code === 'ACCOUNT_LOCKED',
    '5th consecutive failed attempt triggers ACCOUNT_LOCKED (429)'
  );

  // Next attempt while locked
  const whileLockedRes = await callApi('/api/auth/login', 'POST', {
    employeeCode: superAdminCode,
    pin: superAdminPin, // Even with correct PIN, locked account must be rejected!
  });
  assert(
    whileLockedRes.status === 429 && whileLockedRes.body.error.includes('locked'),
    'Locked account rejected even with correct PIN'
  );

  // Unlock Super Admin account for testing
  await db
    .prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE UPPER(employee_code) = ?')
    .bind(superAdminCode)
    .run();

  // Re-login as Super Admin
  const reloginRes = await callApi('/api/auth/login', 'POST', {
    employeeCode: superAdminCode,
    pin: superAdminPin,
  });
  const superAdminToken = reloginRes.body.token;

  console.log('\n--- 4. Multiple Administrators & 4-Tier Role Hierarchy ---');
  // Super Admin creates Admin #1
  const createAdmin1Res = await callApi(
    '/api/users',
    'POST',
    {
      employeeName: 'Alice Admin',
      employeeCode: 'ADMIN-01',
      role: 'admin',
      pin: '1111',
    },
    { Authorization: `Bearer ${superAdminToken}` }
  );
  assert(createAdmin1Res.status === 201, 'Super Admin creates first Admin account ADMIN-01 (201)');
  assert(createAdmin1Res.body.role === 'admin', 'ADMIN-01 has role = admin');

  // Super Admin creates Admin #2 (verifying multiple admins are supported!)
  const createAdmin2Res = await callApi(
    '/api/users',
    'POST',
    {
      employeeName: 'Bob Admin',
      employeeCode: 'ADMIN-02',
      role: 'admin',
      pin: '1122',
    },
    { Authorization: `Bearer ${superAdminToken}` }
  );
  assert(createAdmin2Res.status === 201, 'Super Admin creates second Admin account ADMIN-02 (201)');

  // Log in as ADMIN-01
  const admin1Login = await callApi('/api/auth/login', 'POST', {
    employeeCode: 'ADMIN-01',
    pin: '1111',
  });
  assert(admin1Login.status === 200, 'ADMIN-01 logs in successfully (200)');
  const admin1Token = admin1Login.body.token;

  // ADMIN-01 creates Admin #3 (verifying Admin can create additional Admin accounts)
  const createAdmin3Res = await callApi(
    '/api/users',
    'POST',
    {
      employeeName: 'Charlie Admin',
      employeeCode: 'ADMIN-03',
      role: 'admin',
      pin: '1133',
    },
    { Authorization: `Bearer ${admin1Token}` }
  );
  assert(createAdmin3Res.status === 201, 'Standard Admin can create additional Admin accounts (201)');

  // ADMIN-01 creates Supervisor
  const createSupRes = await callApi(
    '/api/users',
    'POST',
    {
      employeeName: 'Sarah Supervisor',
      employeeCode: 'SUP-01',
      role: 'supervisor',
      pin: '2222',
    },
    { Authorization: `Bearer ${admin1Token}` }
  );
  assert(createSupRes.status === 201, 'Standard Admin can create Supervisor account (201)');

  // ADMIN-01 creates Employee
  const createEmpRes = await callApi(
    '/api/users',
    'POST',
    {
      employeeName: 'John Employee',
      employeeCode: 'EMP-01',
      role: 'employee',
      pin: '3333',
    },
    { Authorization: `Bearer ${admin1Token}` }
  );
  assert(createEmpRes.status === 201, 'Standard Admin can create Employee account (201)');
  assert(createEmpRes.body.role === 'employee', 'Created employee has role = employee');

  console.log('\n--- 5. Super Admin Protection Against Standard Admin Actions ---');
  // 5a. Standard Admin attempts to create a Super Admin -> MUST FAIL (403)
  const adminCreateSuperRes = await callApi(
    '/api/users',
    'POST',
    {
      employeeName: 'Unauthorized Super',
      employeeCode: 'SUPER-99',
      role: 'super_admin',
      pin: '9999',
    },
    { Authorization: `Bearer ${admin1Token}` }
  );
  assert(
    adminCreateSuperRes.status === 403,
    'Standard Admin blocked from creating a Super Admin account (403 Forbidden)'
  );

  // 5b. Standard Admin attempts to downgrade Super Admin -> MUST FAIL (403)
  const adminDowngradeSuperRes = await callApi(
    `/api/users/${superAdminId}`,
    'PATCH',
    { role: 'employee' },
    { Authorization: `Bearer ${admin1Token}` }
  );
  assert(
    adminDowngradeSuperRes.status === 403,
    'Standard Admin blocked from downgrading Super Admin (403 Forbidden)'
  );

  // 5c. Standard Admin attempts to deactivate Super Admin -> MUST FAIL (403)
  const adminDeactivateSuperRes = await callApi(
    `/api/users/${superAdminId}`,
    'PATCH',
    { active: false },
    { Authorization: `Bearer ${admin1Token}` }
  );
  assert(
    adminDeactivateSuperRes.status === 403,
    'Standard Admin blocked from deactivating Super Admin (403 Forbidden)'
  );

  // 5d. Standard Admin attempts to reset Super Admin PIN -> MUST FAIL (403)
  const adminResetSuperPinRes = await callApi(
    `/api/users/${superAdminId}/reset-pin`,
    'POST',
    { newPin: '0000' },
    { Authorization: `Bearer ${admin1Token}` }
  );
  assert(
    adminResetSuperPinRes.status === 403,
    'Standard Admin blocked from resetting Super Admin PIN (403 Forbidden)'
  );

  // 5e. Standard Admin attempts to delete Super Admin -> MUST FAIL (403)
  const adminDeleteSuperRes = await callApi(
    `/api/users/${superAdminId}`,
    'DELETE',
    null,
    { Authorization: `Bearer ${admin1Token}` }
  );
  assert(
    adminDeleteSuperRes.status === 403,
    'Standard Admin blocked from deleting Super Admin (403 Forbidden)'
  );

  console.log('\n--- 6. Role-Based Access Control (Supervisor & Employee) ---');
  // Log in as Supervisor and Employee
  const supLogin = await callApi('/api/auth/login', 'POST', {
    employeeCode: 'SUP-01',
    pin: '2222',
  });
  assert(supLogin.status === 200, 'Supervisor logs in successfully');
  const supToken = supLogin.body.token;

  const empLogin = await callApi('/api/auth/login', 'POST', {
    employeeCode: 'EMP-01',
    pin: '3333',
  });
  assert(empLogin.status === 200, 'Employee logs in successfully');
  const empToken = empLogin.body.token;

  // 1. Employee attempts to access User Management
  const empUsersRes = await callApi('/api/users', 'GET', null, {
    Authorization: `Bearer ${empToken}`,
  });
  assert(empUsersRes.status === 403, 'Employee blocked from GET /api/users (403 Forbidden)');

  // 2. Supervisor attempts to access User Management
  const supUsersRes = await callApi('/api/users', 'GET', null, {
    Authorization: `Bearer ${supToken}`,
  });
  assert(supUsersRes.status === 403, 'Supervisor blocked from GET /api/users (403 Forbidden)');

  // 3. Both Super Admin and Admin can access User Management
  const adminUsersRes = await callApi('/api/users', 'GET', null, {
    Authorization: `Bearer ${admin1Token}`,
  });
  assert(adminUsersRes.status === 200, 'Standard Admin allowed GET /api/users (200 OK)');
  assert(adminUsersRes.body.length === 6, 'All 6 accounts (1 Super Admin, 3 Admins, 1 Supervisor, 1 Employee) returned');

  // 4. Employee attempts to create delivery
  const empCreateDelRes = await callApi(
    '/api/deliveries',
    'POST',
    {
      docketNumber: 'TEST-DOCKET-EMP',
      supplier: 'Test Supplier',
      deliveryDate: '2026-11-10',
      parts: [],
    },
    { Authorization: `Bearer ${empToken}` }
  );
  assert(empCreateDelRes.status === 403, 'Employee blocked from creating deliveries (403 Forbidden)');

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

  console.log('\n--- 7. Scan Event Employee Attribution ---');
  // Employee scans & receives part
  const empScanRes = await callApi(
    `/api/deliveries/${createdDelId}/parts/${createdPartId}/receive`,
    'POST',
    {
      receivedQuantity: 2,
      scannedVia: 'qr',
      scannedCode: 'TEST-BRK-100',
    },
    { Authorization: `Bearer ${empToken}` }
  );
  assert(empScanRes.status === 200, 'Employee allowed to scan & receive part (200)');
  assert(
    empScanRes.body.scanEvent.employeeName === 'John Employee',
    'Scan event attributed to authenticated employee name'
  );
  assert(
    empScanRes.body.scanEvent.employeeRole === 'employee',
    'Scan event attributed to authenticated employee role (employee)'
  );

  console.log('\n--- 8. Deactivated Account & Session Revocation ---');
  const empUserId = createEmpRes.body.id;
  await callApi(
    `/api/users/${empUserId}`,
    'PATCH',
    { active: false },
    { Authorization: `Bearer ${admin1Token}` }
  );

  // Employee attempts login while deactivated
  const deactLogin = await callApi('/api/auth/login', 'POST', {
    employeeCode: 'EMP-01',
    pin: '3333',
  });
  assert(
    deactLogin.status === 403 && deactLogin.body.error.includes('deactivated'),
    'Deactivated employee login rejected (403)'
  );

  // Employee existing session token revoked on deactivation
  const deactSessionCheck = await callApi('/api/auth/session', 'GET', null, {
    Authorization: `Bearer ${empToken}`,
  });
  assert(deactSessionCheck.status === 401, 'Deactivated employee active sessions immediately revoked (401)');

  // Re-activate EMP-01 so default demo accounts remain clean
  await callApi(
    `/api/users/${empUserId}`,
    'PATCH',
    { active: true },
    { Authorization: `Bearer ${admin1Token}` }
  );

  console.log('\n==================================================================');
  console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('==================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase2AuthTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
