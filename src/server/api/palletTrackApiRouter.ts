import { D1Database, UserRole } from '../db/types.ts';
import { PalletTrackDbService, AuthenticatedUser } from './palletTrackDbService.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cookie',
  'Access-Control-Allow-Credentials': 'true',
};

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function errorResponse(
  message: string,
  status = 400,
  code?: string,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(
    JSON.stringify({
      error: message,
      code: code || 'BAD_REQUEST',
    }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...CORS_HEADERS,
        ...extraHeaders,
      },
    }
  );
}

function extractToken(request: Request): string | null {
  const authHeader = request.headers.get('authorization') || request.headers.get('Authorization');
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  const cookieHeader = request.headers.get('cookie');
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)pallettrack_session=([^;]+)/);
    if (match) {
      return decodeURIComponent(match[1].trim());
    }
  }
  return null;
}

function buildSetCookieHeader(token: string, maxAge = 28800): string {
  return `pallettrack_session=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}

function buildClearCookieHeader(): string {
  return `pallettrack_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

export async function handlePalletTrackApiRequest(
  request: Request,
  db: D1Database
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  // Only handle /api/* routes
  if (!path.startsWith('/api/')) {
    return null;
  }

  const service = new PalletTrackDbService(db);
  const userAgent = request.headers.get('user-agent') || undefined;
  const ipAddress =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    undefined;

  try {
    // -------------------------------------------------------------------------
    // 1. Health check with central database status
    // -------------------------------------------------------------------------
    if (path === '/api/health') {
      try {
        const ping = await db.prepare('SELECT 1 as alive').first();
        const prov = await service.getProvisionStatus();
        return jsonResponse({
          status: 'ok',
          app: 'PalletTrack',
          database: 'Cloudflare D1 (centralised)',
          dbConnected: Boolean(ping),
          hasAdmin: prov.hasAdmin,
          totalUsers: prov.totalUsers,
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        return jsonResponse(
          {
            status: 'degraded',
            app: 'PalletTrack',
            database: 'Cloudflare D1 (error)',
            dbConnected: false,
            error: err?.message,
            timestamp: new Date().toISOString(),
          },
          500
        );
      }
    }

    // -------------------------------------------------------------------------
    // 2. Authentication endpoints
    // -------------------------------------------------------------------------

    // GET /api/auth/provision-status
    if (path === '/api/auth/provision-status' && method === 'GET') {
      const status = await service.getProvisionStatus();
      return jsonResponse(status);
    }

    // POST /api/auth/setup-admin (One-time initial Administrator provisioning)
    if (path === '/api/auth/setup-admin' && method === 'POST') {
      const body: any = await request.json().catch(() => ({}));
      if (!body.employeeName || !body.employeeCode || !body.pin) {
        return errorResponse(
          'Missing required fields: employeeName, employeeCode, and 4-digit pin are required.',
          400
        );
      }
      try {
        const result = await service.setupInitialAdmin({
          employeeName: body.employeeName,
          employeeCode: body.employeeCode,
          pin: body.pin,
          userAgent,
          ipAddress,
        });
        return jsonResponse(
          {
            success: true,
            user: result.user,
            token: result.token,
            expiresAt: result.expiresAt,
            message: 'Initial Administrator provisioned successfully.',
          },
          201,
          { 'Set-Cookie': buildSetCookieHeader(result.token) }
        );
      } catch (err: any) {
        return errorResponse(err.message || 'Failed to provision initial administrator', 400);
      }
    }

    // POST /api/auth/login (4-digit PIN authentication with lockout protection)
    if (path === '/api/auth/login' && method === 'POST') {
      const body: any = await request.json().catch(() => ({}));
      const { employeeCode, pin } = body;
      if (!employeeCode || !pin) {
        return errorResponse('Invalid employee identifier or PIN', 401, 'INVALID_CREDENTIALS');
      }

      try {
        const result = await service.loginWithPin(employeeCode, pin, userAgent, ipAddress);
        return jsonResponse(
          {
            success: true,
            user: result.user,
            token: result.token,
            expiresAt: result.expiresAt,
          },
          200,
          { 'Set-Cookie': buildSetCookieHeader(result.token) }
        );
      } catch (err: any) {
        const msg = err?.message || 'Invalid employee identifier or PIN';
        const isLockout = msg.includes('locked');
        const isDeactivated = msg.includes('deactivated');
        return errorResponse(
          msg,
          isLockout ? 429 : isDeactivated ? 403 : 401,
          isLockout ? 'ACCOUNT_LOCKED' : isDeactivated ? 'ACCOUNT_DEACTIVATED' : 'INVALID_CREDENTIALS'
        );
      }
    }

    // POST /api/auth/logout (Revoke active session token)
    if (path === '/api/auth/logout' && method === 'POST') {
      const token = extractToken(request);
      if (token) {
        await service.revokeSession(token);
      }
      return jsonResponse(
        { success: true, message: 'Logged out successfully.' },
        200,
        { 'Set-Cookie': buildClearCookieHeader() }
      );
    }

    // GET /api/auth/session (Verify current active session)
    if (path === '/api/auth/session' && method === 'GET') {
      const token = extractToken(request);
      if (!token) {
        return errorResponse('No active session token provided', 401, 'UNAUTHORIZED');
      }
      const user = await service.validateSession(token);
      if (!user) {
        return errorResponse(
          'Session expired or invalid. Please log in again.',
          401,
          'SESSION_EXPIRED',
          { 'Set-Cookie': buildClearCookieHeader() }
        );
      }
      return jsonResponse({
        authenticated: true,
        user,
      });
    }

    // -------------------------------------------------------------------------
    // Helper: Session Authentication Guard for Protected Routes
    // -------------------------------------------------------------------------
    async function authenticateSession(): Promise<AuthenticatedUser | Response> {
      const token = extractToken(request);
      if (!token) {
        // If system has no admin at all, inform client
        const prov = await service.getProvisionStatus();
        if (!prov.hasAdmin) {
          return errorResponse(
            'Initial Administrator setup required before using PalletTrack.',
            428,
            'SETUP_REQUIRED'
          );
        }
        return errorResponse(
          'Authentication required. Please log in with your 4-digit PIN.',
          401,
          'UNAUTHORIZED'
        );
      }
      const user = await service.validateSession(token);
      if (!user) {
        return errorResponse(
          'Session expired or invalid. Please log in again.',
          401,
          'SESSION_EXPIRED',
          { 'Set-Cookie': buildClearCookieHeader() }
        );
      }
      return user;
    }

    // -------------------------------------------------------------------------
    // 3. User Management Endpoints (Admin role strictly required)
    // -------------------------------------------------------------------------
    if (path.startsWith('/api/users')) {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;
      const currentUser = authResult;

      // Strict RBAC: Only Administrator can access User Management
      if (currentUser.role !== 'admin') {
        return errorResponse(
          'Forbidden: Administrator privileges required to manage employee accounts.',
          403,
          'FORBIDDEN'
        );
      }

      // GET /api/users - List all employees
      if (path === '/api/users' && method === 'GET') {
        const users = await service.listUsers();
        return jsonResponse(users);
      }

      // POST /api/users - Create new employee
      if (path === '/api/users' && method === 'POST') {
        const body: any = await request.json().catch(() => ({}));
        try {
          const created = await service.createUser(body);
          return jsonResponse(created, 201);
        } catch (err: any) {
          return errorResponse(err?.message || 'Failed to create employee', 400);
        }
      }

      // Specific user routes:
      // PATCH /api/users/:id
      // POST  /api/users/:id/reset-pin
      // DELETE /api/users/:id
      const userMatch = path.match(/^\/api\/users\/([^/]+)(.*)$/);
      if (userMatch) {
        const targetUserId = decodeURIComponent(userMatch[1]);
        const sub = userMatch[2];

        // POST /api/users/:id/reset-pin
        if (sub === '/reset-pin' && method === 'POST') {
          const body: any = await request.json().catch(() => ({}));
          if (!body.pin) {
            return errorResponse('New 4-digit PIN is required.', 400);
          }
          try {
            const res = await service.resetUserPin(targetUserId, body.pin);
            return jsonResponse(res);
          } catch (err: any) {
            return errorResponse(err?.message || 'Failed to reset PIN', 400);
          }
        }

        // PATCH /api/users/:id
        if ((sub === '' || sub === '/') && (method === 'PATCH' || method === 'PUT')) {
          const body: any = await request.json().catch(() => ({}));
          try {
            const updated = await service.updateUser(targetUserId, body);
            return jsonResponse(updated);
          } catch (err: any) {
            return errorResponse(err?.message || 'Failed to update user', 400);
          }
        }

        // DELETE /api/users/:id
        if ((sub === '' || sub === '/') && method === 'DELETE') {
          try {
            const deleted = await service.deleteUser(targetUserId);
            return jsonResponse(deleted);
          } catch (err: any) {
            return errorResponse(err?.message || 'Failed to delete user', 400);
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 4. Safe Local Storage / IndexedDB migration endpoint
    // -------------------------------------------------------------------------
    if (path === '/api/deliveries/migrate' && method === 'POST') {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;
      const currentUser = authResult;

      // Operator cannot trigger bulk migrations
      if (currentUser.role === 'operator') {
        return errorResponse('Forbidden: Operator role cannot trigger data migration.', 403, 'FORBIDDEN');
      }

      const body: any = await request.json().catch(() => ({}));
      const { deliveries } = body;
      if (!Array.isArray(deliveries)) {
        return errorResponse('Expected an array of deliveries to migrate in "deliveries" field.', 400);
      }
      const result = await service.migrateLocalDeliveries(deliveries);
      return jsonResponse({
        success: true,
        message: `Migration complete: ${result.importedCount} imported, ${result.skippedCount} skipped (already in database).`,
        ...result,
      });
    }

    // -------------------------------------------------------------------------
    // 5. Deliveries Collection: GET /api/deliveries, POST /api/deliveries
    // -------------------------------------------------------------------------
    if (path === '/api/deliveries') {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;
      const currentUser = authResult;

      // GET /api/deliveries (All authenticated users: admin, supervisor, operator)
      if (method === 'GET') {
        const list = await service.listDeliveries();
        return jsonResponse(list);
      }

      // POST /api/deliveries (Admin and Supervisor only; Operator restricted)
      if (method === 'POST') {
        if (currentUser.role === 'operator') {
          return errorResponse(
            'Forbidden: Operators cannot create new deliveries. Contact your supervisor or administrator.',
            403,
            'FORBIDDEN'
          );
        }

        const body: any = await request.json().catch(() => null);
        if (!body || !body.docketNumber) {
          return errorResponse('Missing required delivery docketNumber', 400);
        }
        body.createdBy = currentUser.id;
        const created = await service.createDelivery(body);
        return jsonResponse(created, 201);
      }
    }

    // -------------------------------------------------------------------------
    // 6. Specific Delivery Operations (Scan, Update, Parts, History)
    // -------------------------------------------------------------------------
    const deliveryPathMatch = path.match(/^\/api\/deliveries\/([^/]+)(.*)$/);
    if (deliveryPathMatch) {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;
      const currentUser = authResult;

      const deliveryId = decodeURIComponent(deliveryPathMatch[1]);
      const subPath = deliveryPathMatch[2];

      // GET /api/deliveries/:id
      if (subPath === '' || subPath === '/') {
        if (method === 'GET') {
          const delivery = await service.getDeliveryById(deliveryId);
          if (!delivery) {
            return errorResponse(`Delivery not found: ${deliveryId}`, 404, 'NOT_FOUND');
          }
          return jsonResponse(delivery);
        }

        // PUT /api/deliveries/:id or PATCH /api/deliveries/:id
        if (method === 'PUT' || method === 'PATCH') {
          // Operators cannot modify delivery metadata or complete deliveries
          if (currentUser.role === 'operator') {
            return errorResponse(
              'Forbidden: Operators cannot modify delivery headers or status.',
              403,
              'FORBIDDEN'
            );
          }

          const body: any = await request.json().catch(() => ({}));
          const updated = await service.updateDelivery(deliveryId, body);
          return jsonResponse(updated);
        }
      }

      // GET /api/deliveries/:id/parts
      if (subPath === '/parts' && method === 'GET') {
        const parts = await service.getDeliveryParts(deliveryId);
        return jsonResponse(parts);
      }

      // POST /api/deliveries/:id/parts/:partId/receive
      // PUT  /api/deliveries/:id/parts/:partId/quantity
      // (Accessible to all roles for scanning & receiving; accountability recorded from session)
      const partReceiveMatch = subPath.match(/^\/parts\/([^/]+)\/(?:receive|quantity)$/);
      if (partReceiveMatch && (method === 'POST' || method === 'PUT')) {
        const partId = decodeURIComponent(partReceiveMatch[1]);
        const body: any = await request.json().catch(() => ({}));
        if (typeof body.receivedQuantity === 'undefined') {
          return errorResponse('receivedQuantity is required', 400);
        }

        // Operator restriction: If operator tries to manually override quantities without scanning
        if (currentUser.role === 'operator' && body.scannedVia === 'manual' && body.overrideAllowed === false) {
          return errorResponse('Forbidden: Operators cannot manually override quantities.', 403, 'FORBIDDEN');
        }

        // Pass authenticated employee information server-side
        const receivePayload = {
          ...body,
          userId: currentUser.id,
          employeeName: currentUser.employeeName,
          employeeRole: currentUser.role,
          eventAction: body.eventAction || (Number(body.receivedQuantity) > 0 ? 'part_receive' : 'part_untick'),
        };

        const result = await service.updatePartReceivedQuantity(deliveryId, partId, receivePayload);
        if (result.duplicate) {
          return jsonResponse(result, 409); // 409 Conflict with strict duplicate scan payload
        }
        return jsonResponse(result, 200);
      }

      // GET /api/deliveries/:id/scans
      // POST /api/deliveries/:id/scans
      if (subPath === '/scans') {
        if (method === 'GET') {
          const scans = await service.getScanHistory(deliveryId);
          // If operator, can view scan history for this delivery
          return jsonResponse(scans);
        }

        if (method === 'POST') {
          const body: any = await request.json().catch(() => ({}));
          if (!body.code || !body.scanType) {
            return errorResponse('code and scanType are required', 400);
          }

          // Attach authenticated employee identity from session
          const scanPayload = {
            ...body,
            userId: currentUser.id,
            employeeName: currentUser.employeeName,
            employeeRole: currentUser.role,
            eventAction: body.eventAction || 'scan_logged',
          };

          const scan = await service.recordScanEvent(deliveryId, scanPayload);
          return jsonResponse(scan, 201);
        }
      }
    }

    return null;
  } catch (err: any) {
    console.error('PalletTrack API Error:', err);
    return errorResponse(err?.message || 'Internal database server error', 500, 'INTERNAL_ERROR');
  }
}
