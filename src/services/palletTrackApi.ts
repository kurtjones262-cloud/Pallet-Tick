import { resolveApiUrl } from '../utils/apiConfig.ts';
import { Delivery, DeliveryPart, ScanEvent, UserAccount, UserRole } from '../types/delivery.ts';

export interface BackendHealth {
  connected: boolean;
  app?: string;
  database?: string;
  dbConnected?: boolean;
  hasAdmin?: boolean;
  latencyMs?: number;
  lastChecked?: string;
  error?: string;
}

const TOKEN_KEY = 'pallettrack_token';
const USER_KEY = 'pallettrack_user';

let inMemoryToken: string | null = null;
try {
  inMemoryToken = localStorage.getItem(TOKEN_KEY);
} catch {
  // fallback for memory-only environments
}

export function getAuthToken(): string | null {
  return inMemoryToken;
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

let lastKnownHealth: BackendHealth = { connected: true, lastChecked: new Date().toISOString() };
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
 */
export async function checkBackendConnection(): Promise<BackendHealth> {
  const start = performance.now();
  try {
    const url = resolveApiUrl('/api/health');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const latencyMs = Math.round(performance.now() - start);

    if (res.ok) {
      const data: any = await res.json().catch(() => ({}));
      const health: BackendHealth = {
        connected: Boolean(data.dbConnected !== false),
        app: data.app || 'PalletTrack',
        database: data.database || 'Cloudflare D1',
        dbConnected: data.dbConnected,
        hasAdmin: data.hasAdmin,
        latencyMs,
        lastChecked: new Date().toISOString(),
      };
      notifyHealthListeners(health);
      return health;
    } else {
      const health: BackendHealth = {
        connected: false,
        latencyMs,
        lastChecked: new Date().toISOString(),
        error: `HTTP ${res.status}: Backend unavailable`,
      };
      notifyHealthListeners(health);
      return health;
    }
  } catch (err: any) {
    const latencyMs = Math.round(performance.now() - start);
    const health: BackendHealth = {
      connected: false,
      latencyMs,
      lastChecked: new Date().toISOString(),
      error: err?.message || 'Network unreachable',
    };
    notifyHealthListeners(health);
    return health;
  }
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
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Failed to check provision status (HTTP ${res.status})`);
  }
  return await res.json();
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
    throw new Error('No active session');
  }

  const url = resolveApiUrl('/api/auth/session');
  const res = await fetch(url, {
    method: 'GET',
    headers: getAuthHeaders({ Accept: 'application/json' }),
  });

  if (!res.ok) {
    setAuthToken(null);
    setStoredUser(null);
    throw new Error('Session invalid or expired');
  }

  const body = await res.json();
  setStoredUser(body.user);
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
    headers: getAuthHeaders({ Accept: 'application/json' }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to load deliveries from central database (HTTP ${res.status})`);
  }

  const deliveries = await res.json();
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
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to create delivery (HTTP ${res.status})`);
  }

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
 * Update received quantity on a part in the central database.
 * Enforces online receiving requirement and handles duplicate scan responses.
 */
export async function apiReceivePart(
  deliveryId: string,
  partId: string,
  payload: {
    receivedQuantity: number;
    scannedVia?: 'qr' | 'barcode' | 'ocr_label' | 'manual';
    scannedCode?: string;
    status?: 'received' | 'outstanding';
    notes?: string;
    rawOcrText?: string;
  }
): Promise<{
  duplicate: boolean;
  status: string;
  message?: string;
  part?: DeliveryPart;
  scanEvent?: ScanEvent;
}> {
  const health = await checkBackendConnection();
  if (!health.connected) {
    throw new Error(
      'ONLINE CONNECTION REQUIRED: Cannot record receiving scan while disconnected from the central database. Scan rejected.'
    );
  }

  const url = resolveApiUrl(
    `/api/deliveries/${encodeURIComponent(deliveryId)}/parts/${encodeURIComponent(partId)}/receive`
  );

  const res = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify(payload),
  });

  if (res.status === 409) {
    const data = await res.json().catch(() => ({}));
    return {
      duplicate: true,
      status: 'duplicate',
      message: data.message || 'This part has already been scanned into this delivery.',
      part: data.part,
    };
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to record receiving transaction (HTTP ${res.status})`);
  }

  return await res.json();
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

