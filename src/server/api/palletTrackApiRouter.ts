import { D1Database } from '../db/types.ts';
import { PalletTrackDbService, AuthenticatedUser } from './palletTrackDbService.ts';
import { realtimeBroker } from '../realtime/realtimeHub.ts';

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

export function extractSessionTokenFromRequest(request: Request): string | null {
  try {
    const url = new URL(request.url);
    const queryToken = url.searchParams.get('token');
    if (queryToken && queryToken.trim()) {
      return queryToken.trim();
    }
  } catch {
    // Ignore URL parse error
  }
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

function extractToken(request: Request): string | null {
  return extractSessionTokenFromRequest(request);
}

function buildSetCookieHeader(token: string, maxAge = 28800): string {
  return `pallettrack_session=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}

function buildClearCookieHeader(): string {
  return `pallettrack_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

function isAdminRole(role?: string): boolean {
  return role === 'super_admin' || role === 'admin';
}

function isEmployeeRole(role?: string): boolean {
  return role === 'employee' || role === 'operator';
}

export async function handlePalletTrackApiRequest(
  request: Request,
  db: D1Database,
  env?: { INITIAL_SETUP_SECRET?: string; [key: string]: unknown }
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

  // Never fall back to a hardcoded default setup secret; fail closed if unconfigured
  const expectedSetupSecret =
    (env && typeof env === 'object' && 'INITIAL_SETUP_SECRET' in env
      ? String(env.INITIAL_SETUP_SECRET ?? '').trim()
      : typeof process !== 'undefined' && process.env?.INITIAL_SETUP_SECRET
      ? String(process.env.INITIAL_SETUP_SECRET).trim()
      : '');

  try {
    // Ensure D1 schema and migrations are ready before any API query
    await service.ensureSchemaReady();

    // -------------------------------------------------------------------------
    // 1. Health check with central database status
    // -------------------------------------------------------------------------
    if (path === '/api/health') {
      try {
        const ping = await db.prepare('SELECT 1 as alive').first();
        const prov = await service.getProvisionStatus();
        return jsonResponse({
          status: 'ok',
          app: 'PartTrack',
          tagline: 'Track every part. Every pallet. Every order.',
          database: 'Cloudflare D1 (centralised)',
          dbConnected: Boolean(ping),
          hasSuperAdmin: prov.hasSuperAdmin,
          hasAdmin: prov.hasAdmin,
          adminCount: prov.adminCount,
          totalUsers: prov.totalUsers,
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        return jsonResponse(
          {
            status: 'degraded',
            app: 'PartTrack',
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

    // POST /api/auth/setup-admin (One-time initial Super Admin provisioning)
    if (path === '/api/auth/setup-admin' && method === 'POST') {
      const body: any = await request.json().catch(() => ({}));
      if (!body.employeeName || !body.employeeCode || !body.pin) {
        return errorResponse(
          'Missing required fields: employeeName, employeeCode, and 4-digit pin are required.',
          400,
          'MISSING_FIELDS'
        );
      }
      try {
        const result = await service.setupInitialAdmin({
          employeeName: body.employeeName,
          employeeCode: body.employeeCode,
          pin: body.pin,
          setupSecret: typeof body.setupSecret === 'string' ? body.setupSecret : '',
          expectedSetupSecret,
          userAgent,
          ipAddress,
        });
        return jsonResponse(
          {
            success: true,
            user: result.user,
            token: result.token,
            expiresAt: result.expiresAt,
            message: 'Initial Super Admin provisioned successfully.',
          },
          201,
          { 'Set-Cookie': buildSetCookieHeader(result.token) }
        );
      } catch (err: any) {
        const statusCode =
          typeof err?.status === 'number'
            ? err.status
            : err?.code === 'SETUP_SECRET_NOT_CONFIGURED' || err?.code === 'SETUP_SECRET_WEAK'
            ? 503
            : err?.code === 'SETUP_RATE_LIMITED'
            ? 429
            : err?.code === 'SETUP_ALREADY_COMPLETED' || err?.code === 'INVALID_SETUP_SECRET'
            ? 403
            : 400;
        return errorResponse(
          err?.message || 'Failed to provision initial Super Admin',
          statusCode,
          err?.code || 'SETUP_FAILED'
        );
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
        realtimeBroker.disconnectSessionToken(token);
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
      const prov = await service.getProvisionStatus();
      if (!prov.hasAdmin) {
        return errorResponse(
          'Initial Super Admin setup required before using PartTrack.',
          428,
          'SETUP_REQUIRED'
        );
      }

      const token = extractToken(request);
      if (!token) {
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
    // 3. User Management Endpoints (Super Admin and Admin roles allowed)
    // -------------------------------------------------------------------------
    if (path.startsWith('/api/users')) {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;
      const currentUser = authResult;

      // Strict RBAC: Super Admin or Admin required to access User Management
      if (!isAdminRole(currentUser.role)) {
        return errorResponse(
          'Forbidden: Administrator privileges required to manage accounts.',
          403,
          'FORBIDDEN'
        );
      }

      // GET /api/users - List all users
      if (path === '/api/users' && method === 'GET') {
        const users = await service.listUsers();
        return jsonResponse(users);
      }

      // POST /api/users - Create new user (Employee, Supervisor, Admin, or Super Admin)
      if (path === '/api/users' && method === 'POST') {
        const body: any = await request.json().catch(() => ({}));
        try {
          const created = await service.createUser(body, currentUser);
          return jsonResponse(created, 201);
        } catch (err: any) {
          const isForbidden = String(err?.message || '').startsWith('Forbidden:');
          return errorResponse(
            err?.message || 'Failed to create account',
            isForbidden ? 403 : 400,
            isForbidden ? 'FORBIDDEN' : 'BAD_REQUEST'
          );
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
          const pinValue = body.pin ?? body.newPin;
          if (!pinValue) {
            return errorResponse('New 4-digit PIN is required.', 400);
          }
          try {
            const res = await service.resetUserPin(targetUserId, pinValue, currentUser);
            realtimeBroker.disconnectUser(targetUserId, 'PIN reset by administrator');
            return jsonResponse(res);
          } catch (err: any) {
            const isForbidden = String(err?.message || '').startsWith('Forbidden:');
            return errorResponse(
              err?.message || 'Failed to reset PIN',
              isForbidden ? 403 : 400,
              isForbidden ? 'FORBIDDEN' : 'BAD_REQUEST'
            );
          }
        }

        // PATCH /api/users/:id
        if ((sub === '' || sub === '/') && (method === 'PATCH' || method === 'PUT')) {
          const body: any = await request.json().catch(() => ({}));
          try {
            const updated = await service.updateUser(targetUserId, body, currentUser);
            if (body.active === false || !updated.active) {
              realtimeBroker.disconnectUser(targetUserId, 'Account deactivated by administrator');
            }
            return jsonResponse(updated);
          } catch (err: any) {
            const isForbidden = String(err?.message || '').startsWith('Forbidden:');
            return errorResponse(
              err?.message || 'Failed to update user',
              isForbidden ? 403 : 400,
              isForbidden ? 'FORBIDDEN' : 'BAD_REQUEST'
            );
          }
        }

        // DELETE /api/users/:id
        if ((sub === '' || sub === '/') && method === 'DELETE') {
          try {
            const deleted = await service.deleteUser(targetUserId, currentUser);
            realtimeBroker.disconnectUser(targetUserId, 'Account deleted by administrator');
            return jsonResponse(deleted);
          } catch (err: any) {
            const isForbidden = String(err?.message || '').startsWith('Forbidden:');
            return errorResponse(
              err?.message || 'Failed to delete user',
              isForbidden ? 403 : 400,
              isForbidden ? 'FORBIDDEN' : 'BAD_REQUEST'
            );
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 3b. Real-Time Multi-User Synchronisation & Catch-Up Endpoints
    // -------------------------------------------------------------------------
    if (path === '/api/realtime/events' && method === 'GET') {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;

      const sinceSeq = Math.max(0, Number(url.searchParams.get('sinceSeq')) || 0);
      const deliveryId = url.searchParams.get('deliveryId') || undefined;
      const events = await realtimeBroker.getEventsSince(db, sinceSeq, deliveryId);
      const latestSeq = await realtimeBroker.getLatestSequenceNumber(db);
      const presence = realtimeBroker.getPresenceSummary(deliveryId || null);

      return jsonResponse({
        events,
        latestSeq,
        presence,
        timestamp: new Date().toISOString(),
      });
    }

    if (path === '/api/realtime/presence' && method === 'GET') {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;

      const deliveryId = url.searchParams.get('deliveryId') || null;
      const presence = realtimeBroker.getPresenceSummary(deliveryId);
      const latestSeq = await realtimeBroker.getLatestSequenceNumber(db);

      return jsonResponse({
        presence,
        latestSeq,
        timestamp: new Date().toISOString(),
      });
    }

    // POST /api/deliveries/processing (Notify connected workers that a docket is being processed)
    if (path === '/api/deliveries/processing' && method === 'POST') {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;
      const currentUser = authResult;

      if (isEmployeeRole(currentUser.role)) {
        return errorResponse('Forbidden: Employees cannot upload new deliveries.', 403, 'FORBIDDEN');
      }

      const body: any = await request.json().catch(() => ({}));
      const rtEvent = await realtimeBroker.publishEvent(db, {
        type: 'delivery:processing',
        userId: currentUser.id,
        employeeName: currentUser.employeeName,
        employeeRole: currentUser.role,
        payload: {
          status: body.status || 'processing',
          fileName: body.fileName || 'Delivery Docket',
          fileCount: Number(body.fileCount) || 1,
          employeeName: currentUser.employeeName,
        },
      });

      return jsonResponse({
        success: true,
        sequenceNumber: rtEvent.sequenceNumber,
      });
    }

    // -------------------------------------------------------------------------
    // 4. Safe Local Storage / IndexedDB migration endpoint
    // -------------------------------------------------------------------------
    if (path === '/api/deliveries/migrate' && method === 'POST') {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;
      const currentUser = authResult;

      // Employees cannot trigger bulk migrations
      if (isEmployeeRole(currentUser.role)) {
        return errorResponse('Forbidden: Employee role cannot trigger data migration.', 403, 'FORBIDDEN');
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

      // GET /api/deliveries (All authenticated users: super_admin, admin, supervisor, employee)
      if (method === 'GET') {
        const list = await service.listDeliveries();
        return jsonResponse(list);
      }

      // POST /api/deliveries (Super Admin, Admin, and Supervisor; Employee restricted)
      if (method === 'POST') {
        if (isEmployeeRole(currentUser.role)) {
          return errorResponse(
            'Forbidden: Employees cannot create new deliveries. Contact your supervisor or administrator.',
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
        if (created) {
          const rtEvent = await realtimeBroker.publishEvent(db, {
            type: 'delivery:created',
            deliveryId: created.id,
            userId: currentUser.id,
            employeeName: currentUser.employeeName,
            employeeRole: currentUser.role,
            deliveryVersion: created.version || 1,
            payload: {
              delivery: created,
              createdByName: currentUser.employeeName,
            },
          });
          return jsonResponse({ ...created, sequenceNumber: rtEvent.sequenceNumber }, 201);
        }
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
          // Employees cannot modify delivery metadata or complete deliveries
          if (isEmployeeRole(currentUser.role)) {
            return errorResponse(
              'Forbidden: Employees cannot modify delivery headers or status.',
              403,
              'FORBIDDEN'
            );
          }

          const body: any = await request.json().catch(() => ({}));
          const prevDelivery = await service.getDeliveryById(deliveryId);
          const updated = await service.updateDelivery(deliveryId, body);
          if (updated) {
            const prevStatus = prevDelivery?.status || (prevDelivery as any)?.deliveryStatus;
            const nextStatus = updated.status || (updated as any).deliveryStatus;
            const eventType =
              prevDelivery &&
              prevStatus !== 'completed' &&
              nextStatus === 'completed'
                ? 'delivery:completed'
                : prevDelivery &&
                  prevStatus === 'completed' &&
                  nextStatus === 'receiving'
                ? 'delivery:reopened'
                : 'delivery:updated';

            const rtEvent = await realtimeBroker.publishEvent(db, {
              type: eventType,
              deliveryId: updated.id,
              userId: currentUser.id,
              employeeName: currentUser.employeeName,
              employeeRole: currentUser.role,
              deliveryVersion: updated.version || 1,
              payload: {
                delivery: updated,
                status: nextStatus,
                updatedByName: currentUser.employeeName,
              },
            });
            return jsonResponse({ ...updated, sequenceNumber: rtEvent.sequenceNumber });
          }
          return jsonResponse(updated);
        }

        // DELETE /api/deliveries/:id
        if (method === 'DELETE') {
          if (isEmployeeRole(currentUser.role)) {
            return errorResponse(
              'Forbidden: Employees cannot delete deliveries.',
              403,
              'FORBIDDEN'
            );
          }

          const deleted = await service.deleteDelivery(deliveryId);
          if (!deleted) {
            return errorResponse(`Delivery not found: ${deliveryId}`, 404, 'NOT_FOUND');
          }
          return jsonResponse({ success: true, id: deliveryId });
        }
      }

      // GET /api/deliveries/:id/parts
      // POST /api/deliveries/:id/parts (Add missing part)
      // PUT /api/deliveries/:id/parts (Batch save parts list)
      if (subPath === '/parts' || subPath === '/parts/') {
        if (method === 'GET') {
          const parts = await service.getDeliveryParts(deliveryId);
          return jsonResponse(parts);
        }

        if (method === 'POST') {
          const body: any = await request.json().catch(() => ({}));
          if (!body || !String(body.partNumber || '').trim()) {
            return errorResponse('Part Number is required when adding a part.', 400);
          }
          try {
            const added = await service.addDeliveryPart(deliveryId, body, {
              id: currentUser.id,
              employeeName: currentUser.employeeName,
              role: currentUser.role,
            });
            const rtEvent = await realtimeBroker.publishEvent(db, {
              type: 'part:added',
              deliveryId,
              partId: added.part?.id,
              userId: currentUser.id,
              employeeName: currentUser.employeeName,
              employeeRole: currentUser.role,
              deliveryVersion: added.delivery?.version || 1,
              payload: {
                part: added.part,
                delivery: added.delivery,
                actorName: currentUser.employeeName,
              },
            });
            return jsonResponse({ ...added, sequenceNumber: rtEvent.sequenceNumber }, 201);
          } catch (err: any) {
            const isForbidden = String(err?.message || '').startsWith('Forbidden:');
            return errorResponse(
              err?.message || 'Failed to add part to delivery',
              isForbidden ? 403 : 400,
              isForbidden ? 'FORBIDDEN' : 'BAD_REQUEST'
            );
          }
        }

        if (method === 'PUT') {
          const body: any = await request.json().catch(() => ({}));
          const partsArray = Array.isArray(body) ? body : body?.parts;
          if (!Array.isArray(partsArray)) {
            return errorResponse('Expected an array of parts in "parts" field.', 400);
          }
          try {
            const saved = await service.batchSaveDeliveryParts(deliveryId, partsArray, {
              id: currentUser.id,
              employeeName: currentUser.employeeName,
              role: currentUser.role,
            });
            const rtEvent = await realtimeBroker.publishEvent(db, {
              type: 'parts:batch_saved',
              deliveryId,
              userId: currentUser.id,
              employeeName: currentUser.employeeName,
              employeeRole: currentUser.role,
              deliveryVersion: saved.delivery?.version || 1,
              payload: {
                delivery: saved.delivery,
                actorName: currentUser.employeeName,
              },
            });
            return jsonResponse({ ...saved, sequenceNumber: rtEvent.sequenceNumber }, 200);
          } catch (err: any) {
            const isForbidden = String(err?.message || '').startsWith('Forbidden:');
            return errorResponse(
              err?.message || 'Failed to save parts list',
              isForbidden ? 403 : 400,
              isForbidden ? 'FORBIDDEN' : 'BAD_REQUEST'
            );
          }
        }
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

        // Employee restriction: If employee tries to manually override quantities when forbidden
        if (isEmployeeRole(currentUser.role) && body.scannedVia === 'manual' && body.overrideAllowed === false) {
          return errorResponse('Forbidden: Employees cannot manually override quantities.', 403, 'FORBIDDEN');
        }

        // Pass authenticated employee information server-side
        const receivePayload = {
          ...body,
          scannedVia: body.scannedVia || body.scanType || 'qr',
          scannedCode: body.scannedCode || body.code,
          userId: currentUser.id,
          employeeName: currentUser.employeeName,
          employeeRole: currentUser.role,
          eventAction: body.eventAction || (Number(body.receivedQuantity) > 0 ? 'part_receive' : 'part_untick'),
        };

        const result = await service.updatePartReceivedQuantity(deliveryId, partId, receivePayload);
        if (result.duplicate) {
          await realtimeBroker.publishEvent(db, {
            type: 'part:duplicate_rejected',
            deliveryId,
            partId,
            userId: currentUser.id,
            employeeName: currentUser.employeeName,
            employeeRole: currentUser.role,
            payload: {
              part: result.part,
              alreadyScannedBy: (result as any).alreadyScannedBy,
              alreadyScannedAt: (result as any).alreadyScannedAt,
              attemptedBy: currentUser.employeeName,
              message: result.message,
            },
          });
          return jsonResponse(result, 409); // 409 Conflict with strict duplicate scan payload
        }

        if (!(result as any).idempotentReplay) {
          const isUndo =
            result.part?.status === 'outstanding' || Number(result.part?.receivedQuantity) === 0;
          const isPartialQtyUpdate =
            !isUndo &&
            result.part?.verificationStatus === 'quantity_mismatch' &&
            Number(result.part?.receivedQuantity) < Number(result.part?.quantity);
          const eventType = isUndo
            ? 'part:scan_reversed'
            : body.scannedVia === 'manual' || isPartialQtyUpdate
            ? 'quantity:updated'
            : 'part:scanned';

          const rtEvent = await realtimeBroker.publishEvent(db, {
            type: eventType,
            deliveryId,
            partId,
            userId: currentUser.id,
            employeeName: currentUser.employeeName,
            employeeRole: currentUser.role,
            deliveryVersion: (result as any).deliveryVersion || 1,
            payload: {
              part: result.part,
              scanEvent: result.scanEvent,
              scannedByName: currentUser.employeeName,
              receivedQuantity: result.part?.receivedQuantity,
              requiredQuantity: result.part?.quantity,
              deliveryStats: (result as any).deliveryStats,
              deliveryVersion: (result as any).deliveryVersion || 1,
            },
          });
          return jsonResponse({ ...result, sequenceNumber: rtEvent.sequenceNumber }, 200);
        }

        return jsonResponse(result, 200);
      }

      // PATCH / PUT / DELETE /api/deliveries/:id/parts/:partId (Edit or Delete a specific part row)
      const partItemMatch = subPath.match(/^\/parts\/([^/]+)\/?$/);
      if (partItemMatch) {
        const partId = decodeURIComponent(partItemMatch[1]);

        if (method === 'PATCH' || method === 'PUT') {
          const body: any = await request.json().catch(() => ({}));
          try {
            const updated = await service.updateDeliveryPart(deliveryId, partId, body, {
              id: currentUser.id,
              employeeName: currentUser.employeeName,
              role: currentUser.role,
            });
            const rtEvent = await realtimeBroker.publishEvent(db, {
              type: 'part:edited',
              deliveryId,
              partId,
              userId: currentUser.id,
              employeeName: currentUser.employeeName,
              employeeRole: currentUser.role,
              deliveryVersion: updated.delivery?.version || 1,
              payload: {
                part: updated.part,
                delivery: updated.delivery,
                actorName: currentUser.employeeName,
              },
            });
            return jsonResponse({ ...updated, sequenceNumber: rtEvent.sequenceNumber }, 200);
          } catch (err: any) {
            const isForbidden = String(err?.message || '').startsWith('Forbidden:');
            return errorResponse(
              err?.message || 'Failed to update part',
              isForbidden ? 403 : 400,
              isForbidden ? 'FORBIDDEN' : 'BAD_REQUEST'
            );
          }
        }

        if (method === 'DELETE') {
          try {
            const deleted = await service.deleteDeliveryPart(deliveryId, partId, {
              id: currentUser.id,
              employeeName: currentUser.employeeName,
              role: currentUser.role,
            });
            const rtEvent = await realtimeBroker.publishEvent(db, {
              type: 'part:deleted',
              deliveryId,
              partId,
              userId: currentUser.id,
              employeeName: currentUser.employeeName,
              employeeRole: currentUser.role,
              deliveryVersion: deleted.delivery?.version || 1,
              payload: {
                deletedPartId: deleted.deletedPartId,
                delivery: deleted.delivery,
                actorName: currentUser.employeeName,
              },
            });
            return jsonResponse({ ...deleted, sequenceNumber: rtEvent.sequenceNumber }, 200);
          } catch (err: any) {
            const isForbidden = String(err?.message || '').startsWith('Forbidden:');
            return errorResponse(
              err?.message || 'Failed to delete part',
              isForbidden ? 403 : 400,
              isForbidden ? 'FORBIDDEN' : 'BAD_REQUEST'
            );
          }
        }
      }

      // GET /api/deliveries/:id/scans
      // POST /api/deliveries/:id/scans
      if (subPath === '/scans' || subPath.startsWith('/scans/')) {
        if (method === 'DELETE' || method === 'PUT' || method === 'PATCH') {
          return errorResponse(
            'Forbidden: Audit scan history is immutable and cannot be modified or erased.',
            403,
            'AUDIT_HISTORY_IMMUTABLE'
          );
        }

        if (subPath === '/scans' && method === 'GET') {
          const scans = await service.getScanHistory(deliveryId);
          return jsonResponse(scans);
        }

        if (subPath === '/scans' && method === 'POST') {
          const body: any = await request.json().catch(() => ({}));
          if (!body.code || !body.scanType) {
            return errorResponse('code and scanType are required', 400);
          }

          // Attach authenticated employee identity from session (never trust frontend employeeName/userId)
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
    console.error('PartTrack API Error:', err);
    return errorResponse(err?.message || 'Internal database server error', 500, 'INTERNAL_ERROR');
  }
}
