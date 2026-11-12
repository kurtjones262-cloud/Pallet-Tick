import { D1Database, RealtimeEventRow } from '../db/types.ts';
import { AuthenticatedUser } from '../api/palletTrackDbService.ts';

export type RealtimeEventType =
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

export interface RealtimeEvent {
  id: string;
  type: RealtimeEventType;
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

export interface WorkerPresence {
  connectionId: string;
  userId: string;
  employeeName: string;
  employeeCode: string;
  role: string;
  activeDeliveryId: string | null;
  status: 'dashboard' | 'viewing' | 'scanning';
  connectedAt: string;
  lastActivityAt: string;
  lastScanSummary?: string;
}

export interface DeliveryPresenceSummary {
  deliveryId: string | null;
  connectedWorkersCount: number;
  deliveryWorkersCount: number;
  connectedDevicesCount: number;
  workers: WorkerPresence[];
  deliveryWorkers: WorkerPresence[];
  allConnectedWorkers: WorkerPresence[];
  timestamp: string;
}

export interface RealtimeSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}

interface ConnectedClient {
  connectionId: string;
  socket: RealtimeSocketLike;
  user: AuthenticatedUser;
  sessionToken: string;
  activeDeliveryId: string | null;
  status: 'dashboard' | 'viewing' | 'scanning';
  connectedAt: string;
  lastActivityAt: string;
  lastPongMs: number;
  lastScanSummary?: string;
}

const WS_OPEN = 1;
const HEARTBEAT_INTERVAL_MS = 15_000;
const STALE_CONNECTION_TIMEOUT_MS = 45_000;

export class PalletTrackRealtimeBroker {
  private clients = new Map<string, ConnectedClient>();
  private latestSeq = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private durableObjectForwarder?: (event: RealtimeEvent) => Promise<void>;

  constructor() {
    this.startHeartbeat();
  }

  public setDurableObjectForwarder(fn: (event: RealtimeEvent) => Promise<void>) {
    this.durableObjectForwarder = fn;
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.pruneStaleConnectionsAndPing();
    }, HEARTBEAT_INTERVAL_MS);
    if (typeof (this.heartbeatTimer as any)?.unref === 'function') {
      (this.heartbeatTimer as any).unref();
    }
  }

  public pruneStaleConnectionsAndPing() {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    let changed = false;
    const affectedDeliveries = new Set<string | null>();

    for (const [connId, client] of this.clients.entries()) {
      if (
        client.socket.readyState !== WS_OPEN ||
        nowMs - client.lastPongMs > STALE_CONNECTION_TIMEOUT_MS
      ) {
        affectedDeliveries.add(client.activeDeliveryId);
        try {
          client.socket.close(4000, 'Heartbeat timeout');
        } catch {
          // Ignore close error
        }
        this.clients.delete(connId);
        changed = true;
        continue;
      }

      try {
        client.socket.send(
          JSON.stringify({
            type: 'ping',
            timestamp: nowIso,
            latestSeq: this.latestSeq,
          })
        );
      } catch {
        affectedDeliveries.add(client.activeDeliveryId);
        this.clients.delete(connId);
        changed = true;
      }
    }

    if (changed) {
      for (const delId of affectedDeliveries) {
        this.broadcastPresenceUpdate(delId);
      }
      this.broadcastPresenceUpdate(null);
    }
  }

  /**
   * Register a newly authenticated WebSocket connection
   */
  public registerClient(
    socket: RealtimeSocketLike,
    user: AuthenticatedUser,
    sessionToken: string,
    initialDeliveryId?: string | null,
    lastSeq?: number,
    db?: D1Database
  ): string {
    const connectionId = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const nowIso = new Date().toISOString();

    const client: ConnectedClient = {
      connectionId,
      socket,
      user,
      sessionToken,
      activeDeliveryId: initialDeliveryId || null,
      status: initialDeliveryId ? 'viewing' : 'dashboard',
      connectedAt: nowIso,
      lastActivityAt: nowIso,
      lastPongMs: Date.now(),
    };

    this.clients.set(connectionId, client);

    // Send initial welcome handshake with current sequence number & presence
    this.safeSend(socket, {
      type: 'connected',
      connectionId,
      user: {
        id: user.id,
        employeeName: user.employeeName,
        employeeCode: user.employeeCode,
        role: user.role,
      },
      latestSeq: this.latestSeq,
      currentSequenceNumber: this.latestSeq,
      presence: this.getPresenceSummary(initialDeliveryId || null),
      timestamp: nowIso,
    });

    if (db && typeof lastSeq === 'number' && lastSeq > 0) {
      this.getEventsSince(db, lastSeq, initialDeliveryId || undefined)
        .then((missedEvents) => {
          if (missedEvents.length > 0) {
            this.safeSend(socket, {
              type: 'sync_catchup',
              sinceSeq: lastSeq,
              latestSeq: this.latestSeq,
              events: missedEvents,
              timestamp: new Date().toISOString(),
            });
          }
        })
        .catch(() => {});
    }

    this.broadcastPresenceUpdate(initialDeliveryId || null);
    if (initialDeliveryId) {
      this.broadcastPresenceUpdate(null);
    }

    return connectionId;
  }

  /**
   * Remove a disconnected client and broadcast updated worker presence
   */
  public unregisterClient(connectionId: string) {
    const existing = this.clients.get(connectionId);
    if (!existing) return;
    const prevDeliveryId = existing.activeDeliveryId;
    this.clients.delete(connectionId);
    this.broadcastPresenceUpdate(prevDeliveryId);
    if (prevDeliveryId !== null) {
      this.broadcastPresenceUpdate(null);
    }
  }

  /**
   * Immediately disconnect all active WebSockets for a deactivated or logged-out user
   */
  public disconnectUser(userId: string, reason = 'Session ended or account deactivated') {
    const affectedDeliveries = new Set<string | null>();
    for (const [connId, client] of this.clients.entries()) {
      if (client.user.id === userId) {
        affectedDeliveries.add(client.activeDeliveryId);
        this.safeSend(client.socket, {
          type: 'auth_revoked',
          reason,
          timestamp: new Date().toISOString(),
        });
        try {
          client.socket.close(4003, reason);
        } catch {
          // Ignore close error
        }
        this.clients.delete(connId);
      }
    }
    for (const delId of affectedDeliveries) {
      this.broadcastPresenceUpdate(delId);
    }
    if (affectedDeliveries.size > 0) {
      this.broadcastPresenceUpdate(null);
    }
  }

  /**
   * Disconnect a specific session token on logout
   */
  public disconnectSessionToken(sessionToken: string) {
    if (!sessionToken) return;
    const affectedDeliveries = new Set<string | null>();
    for (const [connId, client] of this.clients.entries()) {
      if (client.sessionToken === sessionToken) {
        affectedDeliveries.add(client.activeDeliveryId);
        try {
          client.socket.close(4001, 'Logged out');
        } catch {
          // Ignore
        }
        this.clients.delete(connId);
      }
    }
    for (const delId of affectedDeliveries) {
      this.broadcastPresenceUpdate(delId);
    }
    if (affectedDeliveries.size > 0) {
      this.broadcastPresenceUpdate(null);
    }
  }

  /**
   * Handle incoming WebSocket message from a connected client
   */
  public async handleClientMessage(
    connectionId: string,
    rawMessage: string,
    db?: D1Database
  ) {
    const client = this.clients.get(connectionId);
    if (!client) return;

    client.lastPongMs = Date.now();
    client.lastActivityAt = new Date().toISOString();

    let msg: any;
    try {
      msg = JSON.parse(rawMessage);
    } catch {
      return;
    }

    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'ping': {
        this.safeSend(client.socket, {
          type: 'pong',
          timestamp: new Date().toISOString(),
          latestSeq: this.latestSeq,
        });
        break;
      }

      case 'pong': {
        // Already updated lastPongMs above
        break;
      }

      case 'join_delivery': {
        const prevDeliveryId = client.activeDeliveryId;
        const nextDeliveryId =
          typeof msg.deliveryId === 'string' && msg.deliveryId.trim()
            ? msg.deliveryId.trim()
            : null;
        const nextStatus =
          msg.status === 'scanning'
            ? 'scanning'
            : nextDeliveryId
            ? 'viewing'
            : 'dashboard';

        client.activeDeliveryId = nextDeliveryId;
        client.status = nextStatus;

        if (prevDeliveryId !== nextDeliveryId) {
          if (prevDeliveryId) this.broadcastPresenceUpdate(prevDeliveryId);
          if (nextDeliveryId) this.broadcastPresenceUpdate(nextDeliveryId);
        } else if (nextDeliveryId) {
          this.broadcastPresenceUpdate(nextDeliveryId);
        }
        this.broadcastPresenceUpdate(null);
        break;
      }

      case 'leave_delivery': {
        const prevDeliveryId = client.activeDeliveryId;
        client.activeDeliveryId = null;
        client.status = 'dashboard';
        if (prevDeliveryId) {
          this.broadcastPresenceUpdate(prevDeliveryId);
        }
        this.broadcastPresenceUpdate(null);
        break;
      }

      case 'worker_status': {
        const nextStatus =
          msg.status === 'scanning'
            ? 'scanning'
            : client.activeDeliveryId
            ? 'viewing'
            : 'dashboard';
        const statusChanged = client.status !== nextStatus;
        client.status = nextStatus;
        if (typeof msg.lastScanSummary === 'string') {
          client.lastScanSummary = msg.lastScanSummary.slice(0, 160);
        }
        if (statusChanged || msg.lastScanSummary) {
          if (client.activeDeliveryId) {
            this.broadcastPresenceUpdate(client.activeDeliveryId);
          }
          this.broadcastPresenceUpdate(null);
        }
        break;
      }

      case 'scanning_activity': {
        if (!client.activeDeliveryId) break;
        client.status = 'scanning';
        if (typeof msg.summary === 'string') {
          client.lastScanSummary = msg.summary.slice(0, 160);
        }
        const activityEvent: RealtimeEvent = {
          id: `rt_act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'worker:scanning_activity',
          sequenceNumber: this.latestSeq,
          deliveryId: client.activeDeliveryId,
          partId: typeof msg.partId === 'string' ? msg.partId : undefined,
          userId: client.user.id,
          employeeName: client.user.employeeName,
          employeeRole: client.user.role,
          timestamp: new Date().toISOString(),
          payload: {
            action: msg.action || 'scanning',
            partNumber: msg.partNumber,
            itemNumber: msg.itemNumber,
            summary: msg.summary || `${client.user.employeeName} is scanning`,
          },
        };
        this.broadcastToDeliveryRoom(client.activeDeliveryId, {
          type: 'event',
          event: activityEvent,
        });
        this.broadcastPresenceUpdate(client.activeDeliveryId);
        break;
      }

      case 'sync_request': {
        if (!db) break;
        const sinceSeq = Math.max(0, Number(msg.sinceSeq) || 0);
        const deliveryId =
          typeof msg.deliveryId === 'string' && msg.deliveryId.trim()
            ? msg.deliveryId.trim()
            : undefined;
        const missedEvents = await this.getEventsSince(db, sinceSeq, deliveryId);
        this.safeSend(client.socket, {
          type: 'sync_response',
          sinceSeq,
          latestSeq: this.latestSeq,
          events: missedEvents,
          presence: this.getPresenceSummary(client.activeDeliveryId),
          timestamp: new Date().toISOString(),
        });
        break;
      }
    }
  }

  /**
   * Build live worker presence summary for a specific delivery room and globally
   */
  public getPresenceSummary(deliveryId: string | null = null): DeliveryPresenceSummary {
    const allDevices: WorkerPresence[] = [];
    for (const client of this.clients.values()) {
      if (client.socket.readyState !== WS_OPEN) continue;
      allDevices.push({
        connectionId: client.connectionId,
        userId: client.user.id,
        employeeName: client.user.employeeName,
        employeeCode: client.user.employeeCode,
        role: client.user.role,
        activeDeliveryId: client.activeDeliveryId,
        status: client.status,
        connectedAt: client.connectedAt,
        lastActivityAt: client.lastActivityAt,
        lastScanSummary: client.lastScanSummary,
      });
    }

    // Deduplicate workers by userId (prioritizing 'scanning' > 'viewing' > 'dashboard' and latest activity)
    const dedupByUser = (list: WorkerPresence[]): WorkerPresence[] => {
      const byUser = new Map<string, WorkerPresence>();
      const rank = { scanning: 3, viewing: 2, dashboard: 1 };
      for (const item of list) {
        const prev = byUser.get(item.userId);
        if (
          !prev ||
          rank[item.status] > rank[prev.status] ||
          item.lastActivityAt > prev.lastActivityAt
        ) {
          byUser.set(item.userId, item);
        }
      }
      return Array.from(byUser.values());
    };

    const allUniqueWorkers = dedupByUser(allDevices);
    const roomDevices = deliveryId
      ? allDevices.filter((d) => d.activeDeliveryId === deliveryId)
      : allDevices;
    const roomUniqueWorkers = dedupByUser(roomDevices);

    return {
      deliveryId,
      connectedWorkersCount: allUniqueWorkers.length,
      deliveryWorkersCount: roomUniqueWorkers.length,
      connectedDevicesCount: roomDevices.length,
      workers: roomUniqueWorkers,
      deliveryWorkers: roomUniqueWorkers,
      allConnectedWorkers: allUniqueWorkers,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Broadcast presence update to clients in a delivery room (or globally if deliveryId is null)
   */
  public broadcastPresenceUpdate(deliveryId: string | null = null) {
    const nowIso = new Date().toISOString();

    for (const client of this.clients.values()) {
      if (client.socket.readyState !== WS_OPEN) continue;
      if (deliveryId !== null && client.activeDeliveryId !== deliveryId) {
        // Still send global presence summary if global update requested
        continue;
      }
      const summary = this.getPresenceSummary(client.activeDeliveryId);
      const event: RealtimeEvent = {
        id: `rt_pres_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'presence:updated',
        sequenceNumber: this.latestSeq,
        deliveryId: client.activeDeliveryId || undefined,
        timestamp: nowIso,
        payload: summary,
      };
      this.safeSend(client.socket, {
        type: 'event',
        event,
      });
    }
  }

  /**
   * Persist an authoritative state-change event to D1 `realtime_events`, assign a monotonic
   * sequenceNumber, update the scanning worker's live activity summary, and broadcast to
   * all connected clients immediately.
   */
  public async publishEvent(
    db: D1Database,
    input: {
      type: RealtimeEventType;
      deliveryId?: string;
      partId?: string;
      userId?: string;
      employeeName?: string;
      employeeRole?: string;
      deliveryVersion?: number;
      payload: Record<string, any>;
    }
  ): Promise<RealtimeEvent> {
    const nowIso = new Date().toISOString();
    const eventId = `rt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payloadJson = JSON.stringify(input.payload || {});

    let seq = this.latestSeq + 1;

    try {
      const insertRes = await db
        .prepare(
          `INSERT INTO realtime_events (
            id, event_type, delivery_id, part_id, user_id, employee_name, employee_role,
            delivery_version, payload, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          eventId,
          input.type,
          input.deliveryId || null,
          input.partId || null,
          input.userId || null,
          input.employeeName || null,
          input.employeeRole || null,
          input.deliveryVersion ?? null,
          payloadJson,
          nowIso
        )
        .run();

      const lastRowId = Number(insertRes.meta?.last_row_id);
      if (Number.isFinite(lastRowId) && lastRowId > 0) {
        seq = lastRowId;
      } else {
        const row = await db
          .prepare('SELECT seq FROM realtime_events WHERE id = ?')
          .bind(eventId)
          .first<{ seq: number }>();
        if (row?.seq) {
          seq = Number(row.seq);
        }
      }

      if (seq > this.latestSeq) {
        this.latestSeq = seq;
      }

      // Periodically prune old realtime_events beyond 2000 rows to keep table compact
      if (seq % 200 === 0 && seq > 2000) {
        db.prepare('DELETE FROM realtime_events WHERE seq < ?')
          .bind(seq - 2000)
          .run()
          .catch(() => {});
      }
    } catch (err) {
      console.warn('Realtime event persistence fallback notice:', err);
      this.latestSeq = seq;
    }

    // Update worker's live scan summary if this was a scan/edit action
    if (input.userId && input.deliveryId) {
      let summaryText: string | undefined;
      if (input.type === 'part:scanned' || input.type === 'quantity:updated') {
        const partNo = input.payload?.part?.partNumber || input.payload?.partNumber || '';
        const recQty = input.payload?.part?.receivedQuantity ?? input.payload?.receivedQuantity;
        const reqQty = input.payload?.part?.quantity ?? input.payload?.requiredQuantity;
        summaryText = `Scanned ${partNo} (${recQty}/${reqQty})`;
      } else if (input.type === 'part:duplicate_rejected') {
        const partNo = input.payload?.part?.partNumber || input.payload?.partNumber || '';
        summaryText = `Duplicate scan blocked on ${partNo}`;
      } else if (input.type === 'part:added' || input.type === 'part:edited') {
        const partNo = input.payload?.part?.partNumber || '';
        summaryText = `Edited ${partNo}`;
      }

      if (summaryText) {
        for (const client of this.clients.values()) {
          if (client.user.id === input.userId) {
            client.lastScanSummary = summaryText;
            client.lastActivityAt = nowIso;
          }
        }
      }
    }

    const event: RealtimeEvent = {
      id: eventId,
      type: input.type,
      sequenceNumber: seq,
      deliveryId: input.deliveryId,
      partId: input.partId,
      userId: input.userId,
      employeeName: input.employeeName,
      employeeRole: input.employeeRole,
      deliveryVersion: input.deliveryVersion,
      timestamp: nowIso,
      payload: input.payload || {},
    };

    this.broadcastEvent(event);

    if (this.durableObjectForwarder) {
      this.durableObjectForwarder(event).catch(() => {});
    }

    return event;
  }

  /**
   * Broadcast a RealtimeEvent to all connected authenticated WebSocket clients.
   * Room isolation rule:
   * - `part:duplicate_rejected` and `worker:scanning_activity` are only sent to clients
   *   actively viewing/scanning the target `deliveryId` (or the triggering user).
   * - Authoritative delivery/part state transitions (`delivery:*`, `part:*`, `quantity:updated`)
   *   include `deliveryId` and `deliveryVersion` and are sent to all authenticated clients so both
   *   open checklists for that delivery AND dashboard progress bars update instantaneously, while
   *   clients viewing a different delivery safely ignore foreign part mutations in their active view.
   */
  public broadcastEvent(event: RealtimeEvent) {
    if (event.sequenceNumber > this.latestSeq) {
      this.latestSeq = event.sequenceNumber;
    }

    const packet = JSON.stringify({
      type: 'event',
      event,
    });

    const isRoomScopedOnly =
      event.type === 'worker:scanning_activity' || event.type === 'part:duplicate_rejected';

    for (const [connId, client] of this.clients.entries()) {
      if (client.socket.readyState !== WS_OPEN) {
        this.clients.delete(connId);
        continue;
      }

      if (isRoomScopedOnly && event.deliveryId) {
        if (
          client.activeDeliveryId !== event.deliveryId &&
          client.user.id !== event.userId
        ) {
          continue;
        }
      }

      try {
        client.socket.send(packet);
      } catch {
        this.clients.delete(connId);
      }
    }
  }

  private broadcastToDeliveryRoom(deliveryId: string, message: Record<string, any>) {
    const packet = JSON.stringify(message);
    for (const [connId, client] of this.clients.entries()) {
      if (client.socket.readyState !== WS_OPEN) {
        this.clients.delete(connId);
        continue;
      }
      if (client.activeDeliveryId === deliveryId) {
        try {
          client.socket.send(packet);
        } catch {
          this.clients.delete(connId);
        }
      }
    }
  }

  private safeSend(socket: RealtimeSocketLike, payload: Record<string, any>) {
    if (socket.readyState !== WS_OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // Ignore transient socket error
    }
  }

  /**
   * Query missed events since `sinceSeq` from D1 `realtime_events`
   */
  public async getEventsSince(
    db: D1Database,
    sinceSeq: number,
    deliveryId?: string
  ): Promise<RealtimeEvent[]> {
    try {
      let rowsRes;
      if (deliveryId) {
        rowsRes = await db
          .prepare(
            `SELECT * FROM realtime_events
             WHERE seq > ? AND (delivery_id = ? OR delivery_id IS NULL OR event_type LIKE 'delivery:%')
             ORDER BY seq ASC
             LIMIT 300`
          )
          .bind(sinceSeq, deliveryId)
          .all<RealtimeEventRow>();
      } else {
        rowsRes = await db
          .prepare(
            `SELECT * FROM realtime_events
             WHERE seq > ?
             ORDER BY seq ASC
             LIMIT 300`
          )
          .bind(sinceSeq)
          .all<RealtimeEventRow>();
      }

      const events: RealtimeEvent[] = [];
      for (const row of rowsRes.results || []) {
        let parsedPayload: Record<string, any> = {};
        try {
          parsedPayload = JSON.parse(row.payload);
        } catch {
          parsedPayload = {};
        }
        if (row.seq > this.latestSeq) {
          this.latestSeq = row.seq;
        }
        events.push({
          id: row.id,
          type: row.event_type as RealtimeEventType,
          sequenceNumber: Number(row.seq),
          deliveryId: row.delivery_id || undefined,
          partId: row.part_id || undefined,
          userId: row.user_id || undefined,
          employeeName: row.employee_name || undefined,
          employeeRole: row.employee_role || undefined,
          deliveryVersion:
            row.delivery_version !== null && row.delivery_version !== undefined
              ? Number(row.delivery_version)
              : undefined,
          timestamp: row.created_at,
          payload: parsedPayload,
        });
      }
      return events;
    } catch {
      return [];
    }
  }

  /**
   * Get the latest sequence number from memory or D1
   */
  public async getLatestSequenceNumber(db: D1Database): Promise<number> {
    try {
      const row = await db
        .prepare('SELECT MAX(seq) as max_seq FROM realtime_events')
        .first<{ max_seq: number | null }>();
      const dbMax = Number(row?.max_seq || 0);
      if (dbMax > this.latestSeq) {
        this.latestSeq = dbMax;
      }
    } catch {
      // Ignore
    }
    return this.latestSeq;
  }
}

export const realtimeBroker = new PalletTrackRealtimeBroker();
