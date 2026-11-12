import {
  getStoredSessionToken,
  apiReceivePart,
  apiFetchRealtimeEvents,
  markBackendSynced,
  getLastSyncedAt,
} from './palletTrackApi';
import { resolveApiUrl } from '../utils/apiConfig';
import { DeliveryPresenceSummary, ScanMethod } from '../types/delivery';

export type RealtimeConnectionState =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'offline'
  | 'disconnected';

export interface ClientRealtimeEvent {
  id: string;
  type:
    | 'delivery:processing'
    | 'delivery:created'
    | 'delivery:updated'
    | 'delivery:completed'
    | 'delivery:reopened'
    | 'parts:batch_saved'
    | 'part:added'
    | 'part:edited'
    | 'part:deleted'
    | 'part:scanned'
    | 'part:duplicate_rejected'
    | 'quantity:updated'
    | 'part:scan_reversed'
    | 'presence:updated'
    | 'worker:scanning_activity';
  sequenceNumber: number;
  deliveryId?: string;
  partId?: string;
  userId?: string;
  employeeName?: string;
  employeeRole?: string;
  deliveryVersion?: number;
  timestamp: string;
  payload: Record<string, any>;
}

export type RealtimeSyncEvent = ClientRealtimeEvent;

export interface RealtimeClientState {
  status: RealtimeConnectionState;
  presence: DeliveryPresenceSummary;
  pendingOfflineScansCount: number;
  lastSyncedAt?: string;
  lastError?: string;
}

export interface QueuedOfflineScan {
  idempotencyKey: string;
  deliveryId: string;
  partId: string;
  partNumber: string;
  itemNumber: string;
  receivedQuantity: number;
  mode: 'set' | 'increment';
  scannedVia: ScanMethod;
  scannedCode: string;
  notes?: string;
  rawOcrText?: string;
  queuedAt: string;
}

const OFFLINE_QUEUE_STORAGE_KEY = 'pallettick_pending_offline_scans_v1';

class PalletTrackRealtimeClient {
  private ws: WebSocket | null = null;
  private connectionState: RealtimeConnectionState = 'disconnected';
  private activeDeliveryId: string | null = null;
  private workerStatus: 'dashboard' | 'viewing' | 'scanning' = 'dashboard';
  private lastSequenceNumber = 0;
  private processedEventIds = new Set<string>();
  private deliveryVersions = new Map<string, number>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private fallbackPollTimer: ReturnType<typeof setInterval> | null = null;
  private manuallyStopped = false;
  private isFlushingOfflineQueue = false;
  private lastSyncedAt: string | undefined = getLastSyncedAt();
  private lastError: string | undefined = undefined;

  private presenceSummary: DeliveryPresenceSummary = {
    deliveryId: null,
    connectedWorkersCount: 0,
    connectedDevicesCount: 0,
    workers: [],
    allConnectedWorkers: [],
    timestamp: new Date().toISOString(),
  };

  private eventListeners = new Set<(event: ClientRealtimeEvent) => void>();
  private stateListeners = new Set<
    (state: RealtimeConnectionState, presence: DeliveryPresenceSummary) => void
  >();
  private authRevokedListeners = new Set<(reason: string) => void>();

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        if (!this.manuallyStopped && getStoredSessionToken()) {
          this.reconnectImmediately('network_online');
        }
      });

      window.addEventListener('offline', () => {
        this.setConnectionState('offline');
      });

      document.addEventListener('visibilitychange', () => {
        if (
          document.visibilityState === 'visible' &&
          !this.manuallyStopped &&
          getStoredSessionToken()
        ) {
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.reconnectImmediately('visibility_visible');
          } else {
            this.requestCatchUpSync();
          }
        }
      });
    }
  }

  public start(initialDeliveryId?: string | null) {
    const token = getStoredSessionToken();
    if (!token) {
      this.stop();
      return;
    }

    this.manuallyStopped = false;
    if (initialDeliveryId !== undefined) {
      this.activeDeliveryId = initialDeliveryId;
    }

    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      if (this.ws.readyState === WebSocket.OPEN && initialDeliveryId !== undefined) {
        this.joinDeliveryRoom(this.activeDeliveryId, this.workerStatus);
      }
      return;
    }

    this.connectWebSocket();
    this.startFallbackCatchUpLoop();
  }

  /**
   * Forces an immediate WebSocket reconnection, HTTP catch-up sync, and offline scan queue flush.
   */
  public async reconnectNow(deliveryId?: string | null): Promise<void> {
    if (deliveryId !== undefined) {
      this.activeDeliveryId = deliveryId;
    }
    const token = getStoredSessionToken();
    if (!token) {
      this.lastError = 'Authentication session required for live sync';
      this.setConnectionState('disconnected');
      return;
    }

    this.manuallyStopped = false;
    this.lastError = undefined;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.ws) {
        try {
          this.ws.onclose = null;
          this.ws.onerror = null;
          this.ws.onmessage = null;
          this.ws.close(1000, 'Reconnecting now');
        } catch {
          // Ignore
        }
        this.ws = null;
      }
      this.connectWebSocket();
    } else {
      if (this.activeDeliveryId) {
        this.joinDeliveryRoom(this.activeDeliveryId, this.workerStatus);
      }
      this.requestCatchUpSync();
    }

    this.startFallbackCatchUpLoop();
    await this.fetchCatchUpHttp();
    await this.flushOfflineScanQueue().catch(() => {});
  }

  public stop() {
    this.manuallyStopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPingLoop();
    if (this.fallbackPollTimer) {
      clearInterval(this.fallbackPollTimer);
      this.fallbackPollTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.close(1000, 'Client stopped');
      } catch {
        // Ignore
      }
      this.ws = null;
    }
    this.setConnectionState('disconnected');
  }

  public getConnectionState(): RealtimeConnectionState {
    return this.connectionState;
  }

  public getState(): RealtimeClientState {
    return {
      status: this.connectionState,
      presence: this.presenceSummary,
      pendingOfflineScansCount: this.getOfflineQueue().length,
      lastSyncedAt: this.lastSyncedAt || getLastSyncedAt(),
      lastError: this.lastError,
    };
  }

  public getPresenceSummary(): DeliveryPresenceSummary {
    return this.presenceSummary;
  }

  public getLastSequenceNumber(): number {
    return this.lastSequenceNumber;
  }

  /**
   * Check whether a delivery version is newer than or equal to the highest version seen so far.
   * Prevents stale/out-of-order network payloads from overwriting newer state.
   */
  public acceptDeliveryVersion(deliveryId: string, version?: number): boolean {
    if (!deliveryId || typeof version !== 'number' || !Number.isFinite(version)) {
      return true;
    }
    const current = this.deliveryVersions.get(deliveryId) || 0;
    if (version < current) {
      return false;
    }
    this.deliveryVersions.set(deliveryId, version);
    return true;
  }

  public getKnownDeliveryVersion(deliveryId: string): number {
    return this.deliveryVersions.get(deliveryId) || 0;
  }

  public joinDeliveryRoom(
    deliveryId: string | null,
    status: 'dashboard' | 'viewing' | 'scanning' = deliveryId ? 'viewing' : 'dashboard'
  ) {
    this.activeDeliveryId = deliveryId;
    this.workerStatus = status;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendJson({
        type: deliveryId ? 'join_delivery' : 'leave_delivery',
        deliveryId,
        status,
      });
    }
  }

  public setWorkerStatus(
    status: 'dashboard' | 'viewing' | 'scanning',
    lastScanSummary?: string
  ) {
    this.workerStatus = status;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendJson({
        type: 'worker_status',
        status,
        lastScanSummary,
      });
    }
  }

  public notifyScanningActivity(payload: {
    action: string;
    partId?: string;
    partNumber?: string;
    itemNumber?: string;
    summary?: string;
  }) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendJson({
        type: 'scanning_activity',
        ...payload,
      });
    }
  }

  public onEvent(listener: (event: ClientRealtimeEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  public onStateChange(
    listener: (
      state: RealtimeConnectionState,
      presence: DeliveryPresenceSummary
    ) => void
  ): () => void {
    this.stateListeners.add(listener);
    listener(this.connectionState, this.presenceSummary);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  public onAuthRevoked(listener: (reason: string) => void): () => void {
    this.authRevokedListeners.add(listener);
    return () => {
      this.authRevokedListeners.delete(listener);
    };
  }

  // =========================================================================
  // Offline Pending Scan Queue (Revalidated on Reconnect, Never Overwrites)
  // =========================================================================

  public getOfflineQueue(): QueuedOfflineScan[] {
    try {
      const raw = localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private saveOfflineQueue(queue: QueuedOfflineScan[]) {
    try {
      localStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(queue));
    } catch {
      // Ignore storage error
    }
  }

  public enqueueOfflineScan(scan: QueuedOfflineScan) {
    const queue = this.getOfflineQueue();
    if (!queue.some((item) => item.idempotencyKey === scan.idempotencyKey)) {
      queue.push(scan);
      this.saveOfflineQueue(queue);
    }
  }

  public removeOfflineScan(idempotencyKey: string) {
    const queue = this.getOfflineQueue().filter(
      (item) => item.idempotencyKey !== idempotencyKey
    );
    this.saveOfflineQueue(queue);
  }

  public flushPendingOfflineScans() {
    return this.flushOfflineScanQueue();
  }

  public async flushOfflineScanQueue(): Promise<
    Array<{
      scan: QueuedOfflineScan;
      outcome: 'accepted' | 'duplicate' | 'error';
      alreadyScannedBy?: string;
    }>
  > {
    if (this.isFlushingOfflineQueue) return [];
    const queue = this.getOfflineQueue();
    if (queue.length === 0) return [];

    this.isFlushingOfflineQueue = true;
    const outcomes: Array<{
      scan: QueuedOfflineScan;
      outcome: 'accepted' | 'duplicate' | 'error';
      alreadyScannedBy?: string;
    }> = [];

    try {
      for (const item of queue) {
        try {
          const res = await apiReceivePart(item.deliveryId, item.partId, {
            receivedQuantity: item.receivedQuantity,
            mode: item.mode,
            idempotencyKey: item.idempotencyKey,
            scannedVia: item.scannedVia,
            scannedCode: item.scannedCode,
            status: 'received',
            notes: item.notes,
            rawOcrText: item.rawOcrText,
            eventAction: 'part_scan_reconnected',
          });

          this.removeOfflineScan(item.idempotencyKey);

          if (res.duplicate) {
            outcomes.push({
              scan: item,
              outcome: 'duplicate',
              alreadyScannedBy: res.alreadyScannedBy,
            });
          } else {
            outcomes.push({
              scan: item,
              outcome: 'accepted',
            });
          }
        } catch {
          // Keep in queue if still offline
          outcomes.push({
            scan: item,
            outcome: 'error',
          });
          break;
        }
      }
    } finally {
      this.isFlushingOfflineQueue = false;
    }

    return outcomes;
  }

  // =========================================================================
  // Internal WebSocket Connection & Catch-Up Synchronisation
  // =========================================================================

  private buildWebSocketUrl(token: string): string {
    const params = new URLSearchParams({
      token,
      lastSeq: String(Math.max(0, this.lastSequenceNumber || 0)),
    });
    if (this.activeDeliveryId) {
      params.set('deliveryId', this.activeDeliveryId);
    }

    const resolvedHttp = resolveApiUrl(`/api/realtime/ws?${params.toString()}`);
    if (/^https?:\/\//i.test(resolvedHttp)) {
      return resolvedHttp.replace(/^http/i, 'ws');
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${resolvedHttp}`;
  }

  private connectWebSocket() {
    if (this.manuallyStopped) return;
    const token = getStoredSessionToken();
    if (!token) {
      this.setConnectionState('disconnected');
      return;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.setConnectionState('offline');
      this.scheduleReconnect();
      return;
    }

    this.setConnectionState(
      this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting'
    );

    try {
      const wsUrl = this.buildWebSocketUrl(token);
      const socket = new WebSocket(wsUrl);
      this.ws = socket;

      socket.onopen = () => {
        if (this.ws !== socket) return;
        const wasReconnect = this.reconnectAttempts > 0 || this.lastSequenceNumber > 0;
        this.reconnectAttempts = 0;
        this.lastError = undefined;
        const nowIso = new Date().toISOString();
        this.lastSyncedAt = nowIso;
        markBackendSynced(nowIso);
        this.setConnectionState('connected');
        this.startPingLoop();

        if (this.activeDeliveryId) {
          this.sendJson({
            type: 'join_delivery',
            deliveryId: this.activeDeliveryId,
            status: this.workerStatus,
          });
        }

        if (wasReconnect) {
          this.requestCatchUpSync();
        }
        this.flushOfflineScanQueue().catch(() => {});
      };

      socket.onmessage = (evt) => {
        if (this.ws !== socket) return;
        this.handleRawMessage(String(evt.data || ''));
      };

      socket.onclose = (evt) => {
        if (this.ws !== socket) return;
        this.ws = null;
        this.stopPingLoop();

        if (evt.code === 4001 || evt.code === 4003) {
          this.lastError = evt.reason || 'Session expired or revoked';
          this.setConnectionState('disconnected');
          this.authRevokedListeners.forEach((cb) =>
            cb(evt.reason || 'Session expired or revoked')
          );
          return;
        }

        if (!this.manuallyStopped) {
          this.setConnectionState(
            typeof navigator !== 'undefined' && navigator.onLine === false
              ? 'offline'
              : 'reconnecting'
          );
          this.scheduleReconnect();
        }
      };

      socket.onerror = () => {
        // onclose will handle reconnection
      };
    } catch (err: any) {
      this.lastError = err?.message || 'WebSocket connection error';
      this.scheduleReconnect();
    }
  }

  private handleRawMessage(raw: string) {
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (!data || typeof data.type !== 'string') return;

    const nowIso = new Date().toISOString();
    this.lastSyncedAt = nowIso;

    switch (data.type) {
      case 'connected': {
        this.lastError = undefined;
        markBackendSynced(data.timestamp || nowIso);
        if (typeof data.latestSeq === 'number' && this.lastSequenceNumber === 0) {
          this.lastSequenceNumber = data.latestSeq;
        }
        if (data.presence) {
          this.presenceSummary = data.presence;
          this.notifyStateListeners();
        }
        break;
      }

      case 'ping': {
        this.sendJson({ type: 'pong', timestamp: nowIso });
        if (
          typeof data.latestSeq === 'number' &&
          data.latestSeq > this.lastSequenceNumber
        ) {
          this.requestCatchUpSync();
        }
        break;
      }

      case 'pong': {
        if (
          typeof data.latestSeq === 'number' &&
          data.latestSeq > this.lastSequenceNumber
        ) {
          this.requestCatchUpSync();
        }
        break;
      }

      case 'auth_error':
      case 'auth_revoked': {
        this.lastError = data.reason || data.error || 'Session revoked';
        this.stop();
        this.authRevokedListeners.forEach((cb) =>
          cb(data.reason || data.error || 'Session revoked')
        );
        break;
      }

      case 'sync_catchup':
      case 'sync_response': {
        markBackendSynced(data.timestamp || nowIso);
        if (data.presence) {
          this.presenceSummary = data.presence;
          this.notifyStateListeners();
        }
        if (Array.isArray(data.events)) {
          const sorted = [...data.events].sort(
            (a, b) => (Number(a.sequenceNumber) || 0) - (Number(b.sequenceNumber) || 0)
          );
          for (const ev of sorted) {
            this.dispatchIncomingEvent(ev);
          }
        }
        if (typeof data.latestSeq === 'number' && data.latestSeq > this.lastSequenceNumber) {
          this.lastSequenceNumber = data.latestSeq;
        }
        break;
      }

      case 'event': {
        markBackendSynced(data.event?.timestamp || nowIso);
        if (data.event) {
          this.dispatchIncomingEvent(data.event);
        }
        break;
      }
    }
  }

  private dispatchIncomingEvent(event: ClientRealtimeEvent) {
    if (!event || !event.type) return;

    if (event.type === 'presence:updated' && event.payload) {
      this.presenceSummary = event.payload as DeliveryPresenceSummary;
      this.notifyStateListeners();
      this.eventListeners.forEach((cb) => cb(event));
      return;
    }

    if (event.type === 'worker:scanning_activity') {
      this.eventListeners.forEach((cb) => cb(event));
      return;
    }

    // Deduplicate by event ID and enforce monotonic sequence ordering
    if (event.id && this.processedEventIds.has(event.id)) {
      return;
    }
    if (event.id) {
      this.processedEventIds.add(event.id);
      if (this.processedEventIds.size > 1000) {
        const first = this.processedEventIds.values().next().value;
        if (first) this.processedEventIds.delete(first);
      }
    }

    const seq = Number(event.sequenceNumber) || 0;
    if (seq > this.lastSequenceNumber) {
      this.lastSequenceNumber = seq;
    }

    // Ignore stale out-of-order delivery state events if we already have a newer deliveryVersion
    if (event.deliveryId && typeof event.deliveryVersion === 'number') {
      const currentVer = this.deliveryVersions.get(event.deliveryId) || 0;
      if (event.deliveryVersion < currentVer) {
        return;
      }
      this.deliveryVersions.set(event.deliveryId, event.deliveryVersion);
    }

    this.eventListeners.forEach((cb) => cb(event));
  }

  public requestCatchUpSync() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendJson({
        type: 'sync_request',
        sinceSeq: this.lastSequenceNumber,
        deliveryId: this.activeDeliveryId,
      });
    } else {
      this.fetchCatchUpHttp().catch(() => {});
    }
  }

  private async fetchCatchUpHttp() {
    if (!getStoredSessionToken()) return;
    try {
      const res = await apiFetchRealtimeEvents(
        this.lastSequenceNumber,
        this.activeDeliveryId
      );
      const nowIso = res.timestamp || new Date().toISOString();
      this.lastSyncedAt = nowIso;
      this.lastError = undefined;
      markBackendSynced(nowIso);
      if (res.presence) {
        this.presenceSummary = res.presence;
        this.notifyStateListeners();
      }
      if (Array.isArray(res.events) && res.events.length > 0) {
        const sorted = [...res.events].sort(
          (a, b) => (Number(a.sequenceNumber) || 0) - (Number(b.sequenceNumber) || 0)
        );
        for (const ev of sorted) {
          this.dispatchIncomingEvent(ev);
        }
      }
      if (typeof res.latestSeq === 'number' && res.latestSeq > this.lastSequenceNumber) {
        this.lastSequenceNumber = res.latestSeq;
      }
    } catch (err: any) {
      if (err?.status === 401 || err?.status === 403) {
        this.lastError = 'Session expired. Please sign in again.';
      }
    }
  }

  private reconnectImmediately(_reason: string) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.connectWebSocket();
  }

  private scheduleReconnect() {
    if (this.manuallyStopped || this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delayMs = Math.min(8000, 400 * Math.pow(1.6, Math.min(6, this.reconnectAttempts - 1)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, delayMs);
  }

  private startPingLoop() {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendJson({ type: 'ping', timestamp: new Date().toISOString() });
      }
    }, 10000);
  }

  private stopPingLoop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private startFallbackCatchUpLoop() {
    if (this.fallbackPollTimer) return;
    this.fallbackPollTimer = setInterval(() => {
      if (this.manuallyStopped || !getStoredSessionToken()) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.fetchCatchUpHttp().catch(() => {});
        if (!this.reconnectTimer && this.connectionState !== 'connecting') {
          this.scheduleReconnect();
        }
      }
    }, 4000);
  }

  private sendJson(payload: Record<string, any>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch {
      // Ignore send error
    }
  }

  private setConnectionState(next: RealtimeConnectionState) {
    if (this.connectionState === next) return;
    this.connectionState = next;
    this.notifyStateListeners();
  }

  private notifyStateListeners() {
    this.stateListeners.forEach((cb) => cb(this.connectionState, this.presenceSummary));
  }
}

export const realtimeClient = new PalletTrackRealtimeClient();
