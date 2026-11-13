import { resolveApiUrl } from '../utils/apiConfig.ts';
import {
  Delivery,
  DeliveryPart,
  DocketGroup,
  GroupScanConflictCandidate,
  ScanEvent,
  UserAccount,
  UserRole,
} from '../types/delivery.ts';

export interface BackendHealth {
  connected: boolean;
  app?: string;
  database?: string;
  dbConnected?: boolean;
  hasAdmin?: boolean;
  latencyMs?: number;
  lastChecked?: string;
  lastSyncedAt?: string;
  error?: string;
}

const TOKEN_KEY = 'pallettrack_token';
const USER_KEY = 'pallettrack_user';
const LAST_SYNCED_KEY = 'parttrack_last_synced_at';

let inMemoryToken: string | null = null;
let inMemoryLastSyncedAt: string | undefined = undefined;
try {
  inMemoryToken = localStorage.getItem(TOKEN_KEY);
  inMemoryLastSyncedAt = localStorage.getItem(LAST_SYNCED_KEY) || undefined;
} catch {
  // fallback for memory-only environments
}

export function getAuthToken(): string | null {
  if (!inMemoryToken) {
    try {
      inMemoryToken = localStorage.getItem(TOKEN_KEY);
    } catch {
      // ignore
    }
  }
  return inMemoryToken;
}

export function getStoredSessionToken(): string | null {
  return getAuthToken();
}

export function setAuthToken(token: string | null) {
  inMemoryToken = token;
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // ignore storage quota errors
  }
}

export function getStoredUser(): UserAccount | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setStoredUser(user: UserAccount | null) {
  try {
    if (user) {
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(USER_KEY);
    }
  } catch {
    // ignore
  }
}

export function getLastSyncedAt(): string | undefined {
  if (!inMemoryLastSyncedAt) {
    try {
      inMemoryLastSyncedAt = localStorage.getItem(LAST_SYNCED_KEY) || undefined;
    } catch {
      // ignore
    }
  }
  return inMemoryLastSyncedAt;
}

export function markBackendSynced(timestampIso?: string) {
  const nowIso = timestampIso || new Date().toISOString();
  inMemoryLastSyncedAt = nowIso;
  try {
    localStorage.setItem(LAST_SYNCED_KEY, nowIso);
  } catch {
    // ignore
  }
  const updatedHealth: BackendHealth = {
    ...lastKnownHealth,
    connected: true,
    dbConnected: true,
    lastChecked: nowIso,
    lastSyncedAt: nowIso,
    error: undefined,
  };
  notifyHealthListeners(updatedHealth);
}

let lastKnownHealth: BackendHealth = {
  connected: true,
  lastChecked: new Date().toISOString(),
  lastSyncedAt: inMemoryLastSyncedAt || new Date().toISOString(),
};
const listeners = new Set<(health: BackendHealth) => void>();

export function subscribeToBackendHealth(listener: (health: BackendHealth) => void): () => void {
  listeners.add(listener);
  listener(lastKnownHealth);
  return () => listeners.delete(listener);
}

function notifyHealthListeners(health: BackendHealth) {
  lastKnownHealth = health;
  listeners.forEach((fn) => {
    try {
      fn(health);
    } catch (e) {
      console.error('Error in health listener:', e);
    }
  });
}

function getAuthHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    ...extraHeaders,
  };
  const token = getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Checks connection health to the centralized Cloudflare D1 / Worker backend.
 * Includes cache-busting and automatic retry on transient timeout/cold-start.
 */
export async function checkBackendConnection(maxAttempts = 2): Promise<BackendHealth> {
  const start = performance.now();
  let lastErrorMsg = 'Network unreachable';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const url = resolveApiUrl('/api/health');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-cache',
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const latencyMs = Math.round(performance.now() - start);
      const nowIso = new Date().toISOString();

      if (res.ok) {
        const contentType = res.headers.get('content-type') || '';
        const rawText = await res.text().catch(() => '');
        let data: any = null;
        try {
          data = rawText ? JSON.parse(rawText) : null;
        } catch {
          data = null;
        }

        if (!data || typeof data !== 'object') {
          lastErrorMsg = contentType.includes('text/html')
            ? 'API endpoint returned HTML instead of JSON. Check Cloudflare Worker /api/* routing.'
            : 'Invalid JSON response from /api/health.';
        } else {
          const isConnected = Boolean(data.dbConnected !== false && data.status !== 'degraded');
          if (isConnected) {
            inMemoryLastSyncedAt = nowIso;
            try {
              localStorage.setItem(LAST_SYNCED_KEY, nowIso);
            } catch {
              // ignore
            }
          }
          const health: BackendHealth = {
            connected: isConnected,
            app: data.app || 'PartTrack',
            database: data.database || 'Cloudflare D1',
            dbConnected: data.dbConnected,
            hasAdmin: data.hasAdmin,
            latencyMs,
            lastChecked: nowIso,
            lastSyncedAt: isConnected ? nowIso : getLastSyncedAt(),
            error: isConnected
              ? undefined
              : data.error || 'Cloudflare D1 database connection is degraded.',
          };
          notifyHealthListeners(health);
          return health;
        }
      } else {
        const errBody: any = await res.json().catch(() => ({}));
        lastErrorMsg =
          errBody?.error || `HTTP ${res.status}: Central D1 backend unavailable`;
      }
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError' || String(err?.message || '').includes('abort');
      lastErrorMsg = isAbort
        ? 'Connection timed out waiting for Cloudflare Worker (8s)'
        : err?.message || 'Network unreachable';
    }

    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  const latencyMs = Math.round(performance.now() - start);
  const health: BackendHealth = {
    connected: false,
    latencyMs,
    lastChecked: new Date().toISOString(),
    lastSyncedAt: getLastSyncedAt(),
    error: lastErrorMsg,
  };
  notifyHealthListeners(health);
  return health;
}

export function isBackendOnline(): boolean {
  return lastKnownHealth.connected;
}

// ==========================================
// PHASE 2: AUTHENTICATION API METHODS
// ==========================================

export async function apiCheckProvisionStatus(): Promise<{
  hasSuperAdmin?: boolean;
  hasAdmin: boolean;
  adminCount?: number;
  totalUsers: number;
}> {
  const url = resolveApiUrl('/api/auth/provision-status');
  const res = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Failed to check provision status (HTTP ${res.status})`);
  }
  const data = await res.json();
  markBackendSynced();
  return data;
}

export async function apiSetupAdmin(data: {
  employeeName: string;
  employeeCode: string;
  pin: string;
  setupSecret?: string;
}): Promise<{ success: boolean; user: UserAccount; token: string }> {
  const url = resolveApiUrl('/api/auth/setup-admin');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(data),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || 'Failed to setup initial Super Admin.');
  }

  setAuthToken(body.token);
  setStoredUser(body.user);
  markBackendSynced();
  return body;
}

export async function apiLogin(
  employeeCode: string,
  pin: string
): Promise<{ success: boolean; user: UserAccount; token: string }> {
  const url = resolveApiUrl('/api/auth/login');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ employeeCode, pin }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error: any = new Error(body.error || 'Invalid employee identifier or PIN');
    error.status = res.status;
    error.code = body.code;
    throw error;
  }

  setAuthToken(body.token);
  setStoredUser(body.user);
  markBackendSynced();
  return body;
}

export async function apiLogout(): Promise<void> {
  const url = resolveApiUrl('/api/auth/logout');
  try {
    await fetch(url, {
      method: 'POST',
      headers: getAuthHeaders({ Accept: 'application/json' }),
    });
  } catch {
    // Ignore network failures on logout
  } finally {
    setAuthToken(null);
    setStoredUser(null);
  }
}

export async function apiGetSession(): Promise<{ authenticated: boolean; user: UserAccount }> {
  const token = getAuthToken();
  if (!token) {
    setStoredUser(null);
    const err: any = new Error('No active session');
    err.status = 401;
    throw err;
  }

  const url = resolveApiUrl('/api/auth/session');
  const res = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    headers: getAuthHeaders({ Accept: 'application/json' }),
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      setAuthToken(null);
      setStoredUser(null);
      const err: any = new Error('Session invalid or expired');
      err.status = res.status;
      throw err;
    }
    const err: any = new Error(`Session check failed (HTTP ${res.status})`);
    err.status = res.status;
    err.isTransient = true;
    throw err;
  }

  const body = await res.json();
  if (body?.user) {
    setStoredUser(body.user);
  }
  markBackendSynced();
  return body;
}

// ==========================================
// PHASE 2: USER MANAGEMENT API (Admin only)
// ==========================================

export async function apiGetUsers(): Promise<UserAccount[]> {
  const url = resolveApiUrl('/api/users');
  const res = await fetch(url, {
    method: 'GET',
    headers: getAuthHeaders({ Accept: 'application/json' }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch users (HTTP ${res.status})`);
  }

  return await res.json();
}

export async function apiCreateUser(data: {
  employeeName: string;
  employeeCode: string;
  role: UserRole;
  pin: string;
}): Promise<UserAccount> {
  const url = resolveApiUrl('/api/users');
  const res = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify(data),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Failed to create employee (HTTP ${res.status})`);
  }

  return body;
}

export async function apiUpdateUser(
  userId: string,
  updates: Partial<UserAccount>
): Promise<UserAccount> {
  const url = resolveApiUrl(`/api/users/${encodeURIComponent(userId)}`);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: getAuthHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify(updates),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Failed to update employee (HTTP ${res.status})`);
  }

  return body;
}

export async function apiResetUserPin(userId: string, pin: string): Promise<{ success: boolean; message: string }> {
  const url = resolveApiUrl(`/api/users/${encodeURIComponent(userId)}/reset-pin`);
  const res = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify({ pin }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Failed to reset PIN (HTTP ${res.status})`);
  }

  return body;
}

export async function apiDeleteUser(userId: string): Promise<{ success: boolean; message: string }> {
  const url = resolveApiUrl(`/api/users/${encodeURIComponent(userId)}`);
  const res = await fetch(url, {
    method: 'DELETE',
    headers: getAuthHeaders({ Accept: 'application/json' }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Failed to delete employee (HTTP ${res.status})`);
  }

  return body;
}

// ==========================================
// DELIVERIES & SCANNING API METHODS
// ==========================================

/**
 * Fetch all deliveries from the central database
 */
export async function apiFetchDeliveries(): Promise<Delivery[]> {
  const url = resolveApiUrl('/api/deliveries');
  const res = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    headers: getAuthHeaders({ Accept: 'application/json' }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err: any = new Error(
      body.error || `Failed to load deliveries from central database (HTTP ${res.status})`
    );
    err.status = res.status;
    throw err;
  }

  const deliveries = await res.json();
  markBackendSynced();
  return deliveries;
}

/**
 * Fetch full delivery details by ID from the central database
 */
export async function apiFetchDelivery(id: string): Promise<Delivery | null> {
  const url = resolveApiUrl(`/api/deliveries/${encodeURIComponent(id)}`);
  const res = await fetch(url, {
    method: 'GET',
    headers: getAuthHeaders({ Accept: 'application/json' }),
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch delivery ${id} (HTTP ${res.status})`);
  }

  return await res.json();
}

/**
 * Create a new delivery in the central database
 */
export async function apiCreateDelivery(delivery: Partial<Delivery>): Promise<Delivery> {
  const url = resolveApiUrl('/api/deliveries');
  const res = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify(delivery),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const error: any = new Error(
      errBody.error || `Failed to create delivery (HTTP ${res.status})`
    );
    error.status = res.status;
    error.code = errBody.code;
    error.existingDeliveryId = errBody.existingDeliveryId;
    throw error;
  }

  markBackendSynced();
  return await res.json();
}

/**
 * Update delivery header metadata (status, notes, etc.)
 */
export async function apiUpdateDelivery(id: string, updates: Partial<Delivery>): Promise<Delivery> {
  const url = resolveApiUrl(`/api/deliveries/${encodeURIComponent(id)}`);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: getAuthHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify(updates),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to update delivery ${id} (HTTP ${res.status})`);
  }

  return await res.json();
}

/**
 * Delete a completed docket (Supervisor / Admin / Super Admin only)
 */
export async function apiDeleteDelivery(id: string): Promise<{ success: boolean; deleted: boolean; id: string }> {
  const url = resolveApiUrl(`/api/deliveries/${encodeURIComponent(id)}?completedOnly=1`);
  const res = await fetch(url, {
    method: 'DELETE',
    headers: getAuthHeaders({ Accept: 'application/json' }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error: any = new Error(body.error || `Failed to delete docket (HTTP ${res.status})`);
    error.status = res.status;
    throw error;
  }

  markBackendSynced();
  return body;
}

/**
 * Clear ALL dockets and docket groups across central database (Supervisor / Admin / Super Admin only)
 */
export async function apiClearAllDeliveries(): Promise<{
  success: boolean;
  deletedDeliveries: number;
  deletedGroups: number;
}> {
  const url = resolveApiUrl('/api/deliveries/clear-all');
  const res = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify({ confirm: true }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error: any = new Error(body.error || `Failed to clear all dockets (HTTP ${res.status})`);
    error.status = res.status;
    throw error;
  }

  markBackendSynced();
  return body;
}

/**
 * Update received quantity on a part in the central database.
 * Enforces online receiving requirement and handles duplicate scan responses.
 */
export async function apiReceivePart(
  deliveryId: string,
  partId: string,
  payload: {
    receivedQuantity: number;
    mode?: 'set' | 'increment';
    idempotencyKey?: string;
    scannedVia?: 'qr' | 'barcode' | 'ocr_label' | 'manual';
    scannedCode?: string;
    status?: 'received' | 'outstanding';
    notes?: string;
    rawOcrText?: string;
    eventAction?: string;
  }
): Promise<{
  duplicate: boolean;
  idempotentReplay?: boolean;
  status: string;
  message?: string;
  detailMessage?: string;
  alreadyScannedBy?: string;
  alreadyScannedAt?: string;
  deliveryVersion?: number;
  sequenceNumber?: number;
  part?: DeliveryPart;
  scanEvent?: ScanEvent;
}> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const offlineErr: any = new Error(
      'ONLINE CONNECTION REQUIRED: Device is currently offline. Scan queued for server verification upon reconnect.'
    );
    offlineErr.isOffline = true;
    throw offlineErr;
  }

  const url = resolveApiUrl(
    `/api/deliveries/${encodeURIComponent(deliveryId)}/parts/${encodeURIComponent(partId)}/receive`
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: getAuthHeaders({
        'Content-Type': 'application/json',
        Accept: 'application/json',
      }),
      body: JSON.stringify(payload),
    });
  } catch (netErr: any) {
    const offlineErr: any = new Error(
      netErr?.message ||
        'Network unreachable while committing scan to central database.'
    );
    offlineErr.isOffline = true;
    throw offlineErr;
  }

  if (res.status === 409) {
    const data = await res.json().catch(() => ({}));
    return {
      duplicate: true,
      status: 'duplicate',
      message:
        data.message ||
        'Duplicate scan – this part has already been received by another worker',
      detailMessage: data.detailMessage,
      alreadyScannedBy: data.alreadyScannedBy || 'Another worker',
      alreadyScannedAt: data.alreadyScannedAt,
      part: data.part,
    };
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to record receiving transaction (HTTP ${res.status})`);
  }

  const result = await res.json();
  markBackendSynced();
  return result;
}

/**
 * Record a scan event directly into the central audit log
 */
export async function apiRecordScan(
  deliveryId: string,
  scan: Partial<ScanEvent>
): Promise<ScanEvent> {
  const url = resolveApiUrl(`/api/deliveries/${encodeURIComponent(deliveryId)}/scans`);
  const res = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify({
      code: scan.code,
      scanType: scan.codeType || 'barcode',
      scanStatus: scan.status || 'match_success',
      partId: scan.partId,
      quantityAdded: scan.addedQuantity || 0,
      receivedQuantityAfter: scan.receivedQuantity,
      scanResult: scan.message,
      rawOcrText: scan.rawOcrText,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to record scan audit event (HTTP ${res.status})`);
  }

  return await res.json();
}

/**
 * Safely migrate local deliveries to the centralized database
 */
export async function apiMigrateDeliveries(deliveries: Delivery[]): Promise<{
  success: boolean;
  message: string;
  importedCount: number;
  skippedCount: number;
  importedIds: string[];
  existingIds: string[];
}> {
  const url = resolveApiUrl('/api/deliveries/migrate');
  const res = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify({ deliveries }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Migration failed (HTTP ${res.status})`);
  }

  return await res.json();
}

// ==========================================
// MANUAL PARTS LIST EDITING API METHODS
// ==========================================

export async function apiAddDeliveryPart(
  deliveryId: string,
  partInput: {
    id?: string;
    partNumber: string;
    itemNumber?: string;
    description?: string;
    revision?: string;
    quantity?: number;
    material?: string;
    thickness?: string;
    dimensions?: string;
    weight?: string;
    palletNumber?: string | number;
    notes?: string;
  }
): Promise<{ status: string; part: DeliveryPart; delivery: Delivery }> {
  const url = resolveApiUrl(`/api/deliveries/${encodeURIComponent(deliveryId)}/parts`);
  const res = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify(partInput),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Failed to add part to delivery (HTTP ${res.status})`);
  }
  return body;
}

export async function apiUpdateDeliveryPart(
  deliveryId: string,
  partId: string,
  updates: {
    partNumber?: string;
    itemNumber?: string;
    description?: string;
    revision?: string | null;
    quantity?: number;
    material?: string | null;
    thickness?: string | null;
    dimensions?: string | null;
    weight?: string | null;
    palletNumber?: string | number | null;
    notes?: string | null;
  }
): Promise<{ status: string; part: DeliveryPart; delivery: Delivery }> {
  const url = resolveApiUrl(
    `/api/deliveries/${encodeURIComponent(deliveryId)}/parts/${encodeURIComponent(partId)}`
  );
  const res = await fetch(url, {
    method: 'PATCH',
    headers: getAuthHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify(updates),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Failed to update part (HTTP ${res.status})`);
  }
  return body;
}

export async function apiBatchSaveDeliveryParts(
  deliveryId: string,
  parts: Array<{
    id?: string;
    partNumber: string;
    itemNumber?: string;
    docketLineIndex?: number;
    description?: string;
    revision?: string | null;
    quantity?: number;
    material?: string | null;
    thickness?: string | null;
    dimensions?: string | null;
    weight?: string | null;
    palletNumber?: string | number | null;
    notes?: string | null;
  }>
): Promise<{ status: string; delivery: Delivery }> {
  const url = resolveApiUrl(`/api/deliveries/${encodeURIComponent(deliveryId)}/parts`);
  const res = await fetch(url, {
    method: 'PUT',
    headers: getAuthHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify({ parts }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Failed to batch save parts list (HTTP ${res.status})`);
  }
  return body;
}

export async function apiDeleteDeliveryPart(
  deliveryId: string,
  partId: string
): Promise<{ status: string; deletedPartId: string; delivery: Delivery }> {
  const url = resolveApiUrl(
    `/api/deliveries/${encodeURIComponent(deliveryId)}/parts/${encodeURIComponent(partId)}`
  );
  const res = await fetch(url, {
    method: 'DELETE',
    headers: getAuthHeaders({
      Accept: 'application/json',
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Failed to delete part (HTTP ${res.status})`);
  }
  return body;
}

// ==========================================
// REAL-TIME SYNCHRONISATION & PRESENCE API
// ==========================================

export async function apiNotifyDocketProcessing(payload: {
  fileName?: string;
  fileCount?: number;
  supplier?: string;
  status?: 'processing' | 'failed';
}): Promise<{ success?: boolean; sequenceNumber?: number } | null> {
  try {
    const url = resolveApiUrl('/api/deliveries/processing');
    const res = await fetch(url, {
      method: 'POST',
      headers: getAuthHeaders({
        'Content-Type': 'application/json',
        Accept: 'application/json',
      }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

export async function apiFetchRealtimeEvents(
  sinceSeq: number,
  deliveryId?: string | null
): Promise<{
  events: any[];
  latestSeq: number;
  presence: any;
  timestamp: string;
}> {
  const params = new URLSearchParams({
    sinceSeq: String(Math.max(0, Number(sinceSeq) || 0)),
  });
  if (deliveryId) {
    params.set('deliveryId', deliveryId);
  }
  const url = resolveApiUrl(`/api/realtime/events?${params.toString()}`);
  const res = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    headers: getAuthHeaders({ Accept: 'application/json' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: any = new Error(body.error || `Failed to fetch real-time events (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  markBackendSynced(body.timestamp);
  return body;
}

export async function apiFetchRealtimePresence(deliveryId?: string | null) {
  const params = new URLSearchParams();
  if (deliveryId) {
    params.set('deliveryId', deliveryId);
  }
  const url = resolveApiUrl(
    `/api/realtime/presence${params.toString() ? `?${params.toString()}` : ''}`
  );
  const res = await fetch(url, {
    method: 'GET',
    headers: getAuthHeaders({ Accept: 'application/json' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Failed to fetch worker presence (HTTP ${res.status})`);
  }
  return body;
}

// ==========================================
// DOCKET GROUPS & GROUP SCANNING API
// ==========================================

export async function apiListGroups(): Promise<DocketGroup[]> {
  const url = resolveApiUrl('/api/groups');
  const res = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    headers: getAuthHeaders({ Accept: 'application/json' }),
  });

  const body = await res.json().catch(() => []);
  if (!res.ok) {
    throw new Error(body?.error || `Failed to load docket groups (HTTP ${res.status})`);
  }
  markBackendSynced();
  return Array.isArray(body) ? body : [];
}

export async function apiGetGroup(id: string): Promise<DocketGroup | null> {
  const url = resolveApiUrl(`/api/groups/${encodeURIComponent(id)}`);
  const res = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    headers: getAuthHeaders({ Accept: 'application/json' }),
  });
  if (res.status === 404) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error || `Failed to load docket group (HTTP ${res.status})`);
  }
  return body;
}

export async function apiCreateGroup(input: {
  name: string;
  description?: string;
  deliveryIds?: string[];
}): Promise<DocketGroup> {
  const url = resolveApiUrl('/api/groups');
  const res = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error || `Failed to create docket group (HTTP ${res.status})`);
  }
  markBackendSynced();
  return body;
}

export async function apiUpdateGroup(
  id: string,
  updates: { name?: string; description?: string }
): Promise<DocketGroup> {
  const url = resolveApiUrl(`/api/groups/${encodeURIComponent(id)}`);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: getAuthHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify(updates),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error || `Failed to update docket group (HTTP ${res.status})`);
  }
  markBackendSynced();
  return body;
}

export async function apiDeleteGroup(id: string): Promise<{ success: boolean; deleted: boolean; id: string }> {
  const url = resolveApiUrl(`/api/groups/${encodeURIComponent(id)}`);
  const res = await fetch(url, {
    method: 'DELETE',
    headers: getAuthHeaders({ Accept: 'application/json' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error || `Failed to delete docket group (HTTP ${res.status})`);
  }
  markBackendSynced();
  return body;
}

export async function apiAddDocketsToGroup(
  groupId: string,
  deliveryIds: string[]
): Promise<DocketGroup> {
  const url = resolveApiUrl(`/api/groups/${encodeURIComponent(groupId)}/dockets`);
  const res = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify({ deliveryIds }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error || `Failed to add dockets to group (HTTP ${res.status})`);
  }
  markBackendSynced();
  return body;
}

export async function apiRemoveDocketFromGroup(
  groupId: string,
  deliveryId: string
): Promise<DocketGroup> {
  const url = resolveApiUrl(
    `/api/groups/${encodeURIComponent(groupId)}/dockets/${encodeURIComponent(deliveryId)}`
  );
  const res = await fetch(url, {
    method: 'DELETE',
    headers: getAuthHeaders({ Accept: 'application/json' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error || `Failed to remove docket from group (HTTP ${res.status})`);
  }
  markBackendSynced();
  return body;
}

export async function apiScanGroupPart(
  groupId: string,
  payload: {
    scannedCode: string;
    scannedVia?: 'qr' | 'barcode' | 'ocr_label' | 'manual';
    receivedQuantity?: number;
    mode?: 'set' | 'increment';
    targetDeliveryId?: string;
    targetPartId?: string;
    idempotencyKey?: string;
    rawOcrText?: string;
  }
): Promise<{
  status: 'committed' | 'duplicate' | 'ambiguous' | 'not_found';
  deliveryId?: string;
  partId?: string;
  part?: DeliveryPart;
  scanEvent?: ScanEvent;
  deliveryVersion?: number;
  idempotentReplay?: boolean;
  alreadyScannedBy?: string;
  alreadyScannedAt?: string;
  candidates?: GroupScanConflictCandidate[];
  message: string;
}> {
  const url = resolveApiUrl(`/api/groups/${encodeURIComponent(groupId)}/scan`);
  const res = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => ({}));

  if (res.status === 404 || body?.code === 'NOT_IN_GROUP' || body?.code === 'PART_NOT_IN_GROUP') {
    return {
      status: 'not_found',
      message: body?.error || 'Scanned part does not belong to any docket in this group.',
    };
  }

  if (res.status === 409) {
    if (body?.code === 'AMBIGUOUS_GROUP_PART') {
      return {
        status: 'ambiguous',
        candidates: Array.isArray(body.candidates) ? body.candidates : [],
        message:
          body.error ||
          'Multiple dockets in this group contain this part. Select the docket to allocate this scan to.',
      };
    }
    return {
      status: 'duplicate',
      deliveryId: body?.deliveryId,
      partId: body?.partId,
      part: body?.part,
      alreadyScannedBy: body?.alreadyScannedBy,
      alreadyScannedAt: body?.alreadyScannedAt,
      message: body?.error || body?.message || 'Duplicate scan — part already fully received.',
    };
  }

  if (!res.ok) {
    throw new Error(body?.error || `Group scan failed (HTTP ${res.status})`);
  }

  markBackendSynced();
  return {
    status: 'committed',
    deliveryId: body.deliveryId,
    partId: body.partId,
    part: body.part,
    scanEvent: body.scanEvent,
    deliveryVersion: body.deliveryVersion,
    idempotentReplay: body.idempotentReplay,
    message: body.message || 'Group scan committed.',
  };
}



