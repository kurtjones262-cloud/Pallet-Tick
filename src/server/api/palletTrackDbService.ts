import {
  D1Database,
  DeliveryRow,
  DeliveryPartRow,
  ScanEventRow,
  UserRow,
  SessionRow,
  UserRole,
} from '../db/types.ts';
import {
  hashPin,
  verifyPin,
  generateSessionToken,
  hashSessionToken,
} from '../auth/crypto.ts';

export interface AuthenticatedUser {
  id: string;
  employeeName: string;
  employeeCode: string;
  role: UserRole;
  active: boolean;
  lastLoginAt?: string | null;
  createdAt?: string;
}

export interface CreateDeliveryInput {
  id?: string;
  docketNumber: string;
  supplier: string;
  purchaseOrderNumber?: string;
  orderNumber?: string;
  deliveryDate: string;
  carrier?: string;
  palletCount?: number;
  supplierProfile?: string;
  notes?: string;
  createdBy?: string;
  parts: Array<{
    id?: string;
    partNumber: string;
    itemNumber: string;
    docketLineIndex?: number;
    description: string;
    quantity?: number;
    receivedQuantity?: number;
    verificationStatus?: 'unscanned' | 'verified' | 'quantity_mismatch';
    status?: 'outstanding' | 'received';
    material?: string;
    thickness?: string;
    dimensions?: string;
    weight?: string;
    palletNumber?: string | number;
    scannedAt?: string;
    scannedVia?: 'qr' | 'barcode' | 'ocr_label' | 'manual';
    scannedCode?: string;
    notes?: string;
    flaggedForReview?: boolean;
    ocrConfidence?: string;
  }>;
  scanHistory?: Array<{
    id?: string;
    timestamp?: string;
    code: string;
    codeType?: 'qr' | 'barcode' | 'ocr_label' | 'manual';
    status?: string;
    partId?: string;
    quantityAdded?: number;
    receivedQuantity?: number;
    message?: string;
    rawOcrText?: string;
  }>;
}

export interface UpdateDeliveryInput {
  docketNumber?: string;
  supplier?: string;
  purchaseOrderNumber?: string;
  deliveryDate?: string;
  deliveryStatus?: 'receiving' | 'completed';
  status?: 'receiving' | 'completed';
  carrier?: string;
  palletCount?: number;
  notes?: string;
}

export interface ReceivePartInput {
  receivedQuantity: number;
  scannedVia?: 'qr' | 'barcode' | 'ocr_label' | 'manual';
  scannedCode?: string;
  status?: 'received' | 'outstanding';
  notes?: string;
  userId?: string;
  employeeName?: string;
  employeeRole?: string;
  eventAction?: string;
  rawOcrText?: string;
}

export interface RecordScanInput {
  code: string;
  scanType: 'qr' | 'barcode' | 'ocr_label' | 'manual';
  scanStatus: string;
  partId?: string;
  userId?: string;
  employeeName?: string;
  employeeRole?: string;
  eventAction?: string;
  quantityAdded?: number;
  receivedQuantityAfter?: number;
  scanResult?: string;
  rawOcrText?: string;
  timestamp?: string;
}

export class PalletTrackDbService {
  constructor(private db: D1Database) {}

  /**
   * Helper to format delivery parts from DB row to frontend object
   */
  private mapPartRow(row: DeliveryPartRow) {
    return {
      id: row.id,
      deliveryId: row.delivery_id,
      partNumber: row.part_number,
      itemNumber: row.item_number,
      docketLineIndex: row.docket_line_index,
      description: row.description,
      quantity: row.required_quantity,
      receivedQuantity: row.received_quantity,
      verificationStatus: row.verification_status,
      status: row.status,
      material: row.material || undefined,
      thickness: row.thickness || undefined,
      dimensions: row.dimensions || undefined,
      weight: row.weight || undefined,
      palletNumber: row.pallet_number || undefined,
      scannedAt: row.scanned_at || undefined,
      scannedVia: (row.scanned_via as any) || undefined,
      scannedCode: row.scanned_code || undefined,
      notes: row.notes || undefined,
      flaggedForReview: Boolean(row.flagged_for_review),
      ocrConfidence: (row.ocr_confidence as any) || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Helper to format scan event from DB row to frontend object
   */
  private mapScanRow(row: ScanEventRow) {
    return {
      id: row.id,
      deliveryId: row.delivery_id,
      partId: row.part_id || undefined,
      userId: row.user_id || undefined,
      employeeName: row.employee_name || undefined,
      employeeRole: row.employee_role || undefined,
      eventAction: row.event_action || undefined,
      timestamp: row.timestamp,
      code: row.code,
      codeType: row.scan_type,
      status: row.scan_status,
      quantityAdded: row.quantity_added,
      receivedQuantity: row.received_quantity_after || undefined,
      message: row.scan_result || '',
      rawOcrText: row.raw_ocr_text || undefined,
    };
  }

  /**
   * Helper to format delivery header from DB row
   */
  private mapDeliveryRow(
    row: DeliveryRow,
    stats?: { totalParts: number; receivedParts: number; verifiedParts: number },
    parts: any[] = []
  ) {
    return {
      id: row.id,
      docketNumber: row.docket_number,
      supplier: row.supplier,
      orderNumber: row.purchase_order_number || undefined,
      purchaseOrderNumber: row.purchase_order_number || undefined,
      deliveryDate: row.delivery_date,
      status: row.delivery_status,
      deliveryStatus: row.delivery_status,
      carrier: row.carrier || undefined,
      palletCount: row.pallet_count,
      supplierProfile: (row.supplier_profile as any) || 'laser_central',
      notes: row.notes || undefined,
      createdBy: row.created_by || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      stats: stats || { totalParts: parts.length, receivedParts: 0, verifiedParts: 0 },
      parts,
      scanHistory: [] as any[],
      unexpectedParts: [] as any[],
      docketAttachments: [] as any[],
    };
  }

  /**
   * List all deliveries with aggregated stats and full parts array
   */
  async listDeliveries() {
    const deliveriesQuery = `
      SELECT d.*,
             COUNT(p.id) AS total_parts,
             SUM(CASE WHEN p.status = 'received' THEN 1 ELSE 0 END) AS received_parts,
             SUM(CASE WHEN p.verification_status = 'verified' THEN 1 ELSE 0 END) AS verified_parts
      FROM deliveries d
      LEFT JOIN delivery_parts p ON d.id = p.delivery_id
      GROUP BY d.id
      ORDER BY d.created_at DESC
    `;
    const res = await this.db.prepare(deliveriesQuery).all<
      DeliveryRow & { total_parts: number; received_parts: number; verified_parts: number }
    >();

    const allPartsRes = await this.db
      .prepare('SELECT * FROM delivery_parts ORDER BY docket_line_index ASC')
      .all<DeliveryPartRow>();

    const partsByDelivery = new Map<string, any[]>();
    for (const p of allPartsRes.results || []) {
      const arr = partsByDelivery.get(p.delivery_id) || [];
      arr.push(this.mapPartRow(p));
      partsByDelivery.set(p.delivery_id, arr);
    }

    return (res.results || []).map((row) => {
      const parts = partsByDelivery.get(row.id) || [];
      return this.mapDeliveryRow(
        row,
        {
          totalParts: Number(row.total_parts) || parts.length,
          receivedParts:
            Number(row.received_parts) || parts.filter((p) => p.status === 'received').length,
          verifiedParts:
            Number(row.verified_parts) ||
            parts.filter((p) => p.verificationStatus === 'verified').length,
        },
        parts
      );
    });
  }


  /**
   * Get single delivery by ID, including parts and scan history
   */
  async getDeliveryById(id: string) {
    const delivery = await this.db
      .prepare('SELECT * FROM deliveries WHERE id = ?')
      .bind(id)
      .first<DeliveryRow>();

    if (!delivery) return null;

    const partsRes = await this.db
      .prepare('SELECT * FROM delivery_parts WHERE delivery_id = ? ORDER BY docket_line_index ASC')
      .bind(id)
      .all<DeliveryPartRow>();

    const scansRes = await this.db
      .prepare('SELECT * FROM scan_events WHERE delivery_id = ? ORDER BY timestamp DESC LIMIT 300')
      .bind(id)
      .all<ScanEventRow>();

    const parts = (partsRes.results || []).map((p) => this.mapPartRow(p));
    const scanHistory = (scansRes.results || []).map((s) => this.mapScanRow(s));

    const totalParts = parts.length;
    const receivedParts = parts.filter((p) => p.status === 'received').length;
    const verifiedParts = parts.filter((p) => p.verificationStatus === 'verified').length;

    return {
      ...this.mapDeliveryRow(delivery, { totalParts, receivedParts, verifiedParts }, parts),
      parts,
      scanHistory,
      unexpectedParts: [],
      docketAttachments: [],
    };

  }

  /**
   * Create a delivery with parts and optional initial scans atomically
   */
  async createDelivery(input: CreateDeliveryInput) {
    const id = input.id || `del_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();
    const docketNumber = (input.docketNumber || '').trim();
    const supplier = (input.supplier || 'Standard Supplier').trim();
    const po = input.purchaseOrderNumber || input.orderNumber || null;
    const deliveryDate = (input.deliveryDate || now.slice(0, 10)).trim();
    const carrier = input.carrier || null;
    const palletCount = Math.max(1, Number(input.palletCount) || 1);
    const supplierProfile = input.supplierProfile || 'laser_central';
    const notes = input.notes || null;
    const createdBy = input.createdBy || 'usr_receiver_default';

    if (!docketNumber) {
      throw new Error('docketNumber is required');
    }

    const stmts: any[] = [];

    // 1. Insert delivery header
    stmts.push(
      this.db
        .prepare(
          `INSERT INTO deliveries (
            id, docket_number, supplier, purchase_order_number, delivery_date,
            delivery_status, carrier, pallet_count, supplier_profile, notes,
            created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          docketNumber,
          supplier,
          po,
          deliveryDate,
          'receiving',
          carrier,
          palletCount,
          supplierProfile,
          notes,
          createdBy,
          now,
          now
        )
    );

    // 2. Insert parts
    const parts = Array.isArray(input.parts) ? input.parts : [];
    parts.forEach((p, idx) => {
      const partId = p.id || `part_${id}_${idx + 1}`;
      const lineIndex = typeof p.docketLineIndex === 'number' ? p.docketLineIndex : idx + 1;
      const reqQty = Math.max(0, Math.round(Number(p.quantity ?? 1)));
      const recQty = Math.max(0, Math.round(Number(p.receivedQuantity ?? 0)));
      const status = p.status === 'received' || recQty > 0 ? 'received' : 'outstanding';
      const verStatus =
        status === 'received'
          ? recQty === reqQty
            ? 'verified'
            : 'quantity_mismatch'
          : 'unscanned';

      stmts.push(
        this.db
          .prepare(
            `INSERT INTO delivery_parts (
              id, delivery_id, part_number, item_number, docket_line_index, description,
              required_quantity, received_quantity, verification_status, status,
              material, thickness, dimensions, weight, pallet_number,
              scanned_at, scanned_via, scanned_code, notes, flagged_for_review,
              ocr_confidence, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            partId,
            id,
            p.partNumber.trim().toUpperCase(),
            p.itemNumber.trim(),
            lineIndex,
            p.description.trim(),
            reqQty,
            recQty,
            verStatus,
            status,
            p.material || null,
            p.thickness || null,
            p.dimensions || null,
            p.weight || null,
            p.palletNumber ? String(p.palletNumber) : null,
            p.scannedAt || null,
            p.scannedVia || null,
            p.scannedCode || null,
            p.notes || null,
            p.flaggedForReview ? 1 : 0,
            p.ocrConfidence || null,
            now,
            now
          )
      );
    });

    // 3. Insert initial scans if provided
    if (Array.isArray(input.scanHistory)) {
      input.scanHistory.forEach((s) => {
        const scanId = s.id || `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        stmts.push(
          this.db
            .prepare(
              `INSERT INTO scan_events (
                id, delivery_id, part_id, user_id, timestamp, code,
                scan_type, scan_status, quantity_added, received_quantity_after,
                scan_result, raw_ocr_text
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              scanId,
              id,
              s.partId || null,
              createdBy,
              s.timestamp || now,
              s.code,
              s.codeType || 'barcode',
              s.status || 'match_success',
              s.quantityAdded ?? 0,
              s.receivedQuantity ?? null,
              s.message || null,
              s.rawOcrText || null
            )
        );
      });
    }

    await this.db.batch(stmts);
    return await this.getDeliveryById(id);
  }

  /**
   * Update delivery header fields (e.g. status, notes, carrier)
   */
  async updateDelivery(id: string, updates: UpdateDeliveryInput) {
    const existing = await this.db
      .prepare('SELECT * FROM deliveries WHERE id = ?')
      .bind(id)
      .first<DeliveryRow>();

    if (!existing) {
      throw new Error(`Delivery not found: ${id}`);
    }

    const now = new Date().toISOString();
    const deliveryStatus =
      updates.deliveryStatus || updates.status || existing.delivery_status;
    const docketNumber = updates.docketNumber !== undefined ? updates.docketNumber : existing.docket_number;
    const supplier = updates.supplier !== undefined ? updates.supplier : existing.supplier;
    const po =
      updates.purchaseOrderNumber !== undefined
        ? updates.purchaseOrderNumber
        : existing.purchase_order_number;
    const deliveryDate =
      updates.deliveryDate !== undefined ? updates.deliveryDate : existing.delivery_date;
    const carrier = updates.carrier !== undefined ? updates.carrier : existing.carrier;
    const palletCount =
      updates.palletCount !== undefined ? updates.palletCount : existing.pallet_count;
    const notes = updates.notes !== undefined ? updates.notes : existing.notes;

    await this.db
      .prepare(
        `UPDATE deliveries
         SET docket_number = ?, supplier = ?, purchase_order_number = ?, delivery_date = ?,
             delivery_status = ?, carrier = ?, pallet_count = ?, notes = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(
        docketNumber,
        supplier,
        po,
        deliveryDate,
        deliveryStatus,
        carrier,
        palletCount,
        notes,
        now,
        id
      )
      .run();

    return await this.getDeliveryById(id);
  }

  /**
   * Get all delivery parts for a delivery
   */
  async getDeliveryParts(deliveryId: string) {
    const res = await this.db
      .prepare('SELECT * FROM delivery_parts WHERE delivery_id = ? ORDER BY docket_line_index ASC')
      .bind(deliveryId)
      .all<DeliveryPartRow>();

    return (res.results || []).map((p) => this.mapPartRow(p));
  }

  /**
   * Update received quantity for a specific part with atomic scan logging and strict duplicate protection
   */
  async updatePartReceivedQuantity(
    deliveryId: string,
    partId: string,
    input: ReceivePartInput
  ) {
    const part = await this.db
      .prepare('SELECT * FROM delivery_parts WHERE delivery_id = ? AND id = ?')
      .bind(deliveryId, partId)
      .first<DeliveryPartRow>();

    if (!part) {
      throw new Error(`Part ${partId} not found in delivery ${deliveryId}`);
    }

    // Server-side validation: Quantities cannot be negative
    const enteredQty = Number(input.receivedQuantity);
    if (Number.isNaN(enteredQty) || enteredQty < 0) {
      throw new Error('Received quantity cannot be negative or invalid');
    }

    const now = new Date().toISOString();
    const reqQty = Math.max(0, part.required_quantity);
    const recQty = Math.round(enteredQty);

    // Check if status is explicitly being set or unticked
    const targetStatus =
      input.status || (recQty > 0 ? 'received' : 'outstanding');

    // DUPLICATE PROTECTION:
    // If the part is ALREADY received and client sends another scan claiming received quantity,
    // prevent duplicate scan from inflating or re-recording unless this is an explicit update or undo.
    const isScanAttempt = input.scannedVia !== 'manual';
    if (isScanAttempt && part.status === 'received' && targetStatus === 'received' && part.received_quantity > 0) {
      return {
        duplicate: true,
        status: 'duplicate',
        message: 'This part has already been scanned into this delivery.',
        part: this.mapPartRow(part),
      };
    }

    const isQtyMatch = targetStatus === 'received' && recQty === reqQty;
    const verificationStatus =
      targetStatus === 'received'
        ? isQtyMatch
          ? 'verified'
          : 'quantity_mismatch'
        : 'unscanned';

    const scannedVia = targetStatus === 'received' ? input.scannedVia || 'manual' : null;
    const scannedCode =
      targetStatus === 'received'
        ? input.scannedCode || part.scanned_code || (scannedVia === 'qr' ? part.part_number : part.item_number)
        : null;
    const scannedAt = targetStatus === 'received' ? now : null;

    const scanId = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const addedQty = Math.max(0, recQty - part.received_quantity);
    const scanStatus =
      targetStatus === 'received'
        ? isQtyMatch
          ? 'match_success'
          : 'quantity_mismatch'
        : 'undo_performed';

    const scanResultMsg =
      targetStatus === 'received'
        ? isQtyMatch
          ? `Verified ${part.part_number} (No. ${part.item_number}) - Qty ${recQty}/${reqQty} matched`
          : `Quantity mismatch for ${part.part_number}: Received ${recQty} of ${reqQty} required`
        : `Unticked ${part.part_number} (${part.item_number})`;

    // Atomic transaction: Update part record AND record audit scan event
    const stmts = [
      this.db
        .prepare(
          `UPDATE delivery_parts
           SET received_quantity = ?, verification_status = ?, status = ?,
               scanned_via = ?, scanned_code = ?, scanned_at = ?, notes = COALESCE(?, notes),
               updated_at = ?
           WHERE delivery_id = ? AND id = ?`
        )
        .bind(
          recQty,
          verificationStatus,
          targetStatus,
          scannedVia,
          scannedCode,
          scannedAt,
          input.notes || null,
          now,
          deliveryId,
          partId
        ),
      this.db
        .prepare(
          `INSERT INTO scan_events (
            id, delivery_id, part_id, user_id, timestamp, code,
            scan_type, scan_status, quantity_added, received_quantity_after,
            scan_result, raw_ocr_text, employee_name, employee_role, event_action
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          scanId,
          deliveryId,
          partId,
          input.userId || 'usr_receiver_default',
          now,
          scannedCode || part.part_number,
          scannedVia || 'manual',
          scanStatus,
          addedQty,
          recQty,
          scanResultMsg,
          input.rawOcrText || null,
          input.employeeName || null,
          input.employeeRole || null,
          input.eventAction || (recQty > 0 ? 'part_scan' : 'part_untick')
        ),
      this.db
        .prepare('UPDATE deliveries SET updated_at = ? WHERE id = ?')
        .bind(now, deliveryId),
    ];

    await this.db.batch(stmts);

    const updatedPart = await this.db
      .prepare('SELECT * FROM delivery_parts WHERE id = ?')
      .bind(partId)
      .first<DeliveryPartRow>();

    return {
      duplicate: false,
      status: 'updated',
      part: updatedPart ? this.mapPartRow(updatedPart) : null,
      scanEvent: {
        id: scanId,
        deliveryId,
        partId,
        userId: input.userId,
        employeeName: input.employeeName,
        employeeRole: input.employeeRole,
        eventAction: input.eventAction || (recQty > 0 ? 'part_scan' : 'part_untick'),
        timestamp: now,
        code: scannedCode || part.part_number,
        codeType: scannedVia || 'manual',
        status: scanStatus,
        quantityAdded: addedQty,
        receivedQuantity: recQty,
        message: scanResultMsg,
      },
    };
  }

  /**
   * Record a scan event directly into the audit log
   */
  async recordScanEvent(deliveryId: string, input: RecordScanInput) {
    const delivery = await this.db
      .prepare('SELECT id FROM deliveries WHERE id = ?')
      .bind(deliveryId)
      .first();

    if (!delivery) {
      throw new Error(`Delivery not found: ${deliveryId}`);
    }

    const now = input.timestamp || new Date().toISOString();
    const scanId = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const qtyAdded = Math.max(0, Math.round(Number(input.quantityAdded || 0)));

    await this.db
      .prepare(
        `INSERT INTO scan_events (
          id, delivery_id, part_id, user_id, timestamp, code,
          scan_type, scan_status, quantity_added, received_quantity_after,
          scan_result, raw_ocr_text, employee_name, employee_role, event_action
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        scanId,
        deliveryId,
        input.partId || null,
        input.userId || 'usr_receiver_default',
        now,
        input.code,
        input.scanType,
        input.scanStatus,
        qtyAdded,
        input.receivedQuantityAfter ?? null,
        input.scanResult || null,
        input.rawOcrText || null,
        input.employeeName || null,
        input.employeeRole || null,
        input.eventAction || 'scan_logged'
      )
      .run();

    return {
      id: scanId,
      deliveryId,
      partId: input.partId,
      userId: input.userId,
      employeeName: input.employeeName,
      employeeRole: input.employeeRole,
      eventAction: input.eventAction || 'scan_logged',
      timestamp: now,
      code: input.code,
      codeType: input.scanType,
      status: input.scanStatus,
      quantityAdded: qtyAdded,
      receivedQuantity: input.receivedQuantityAfter,
      message: input.scanResult || '',
    };
  }

  /**
   * Retrieve scan history for a delivery
   */
  async getScanHistory(deliveryId: string) {
    const res = await this.db
      .prepare('SELECT * FROM scan_events WHERE delivery_id = ? ORDER BY timestamp DESC LIMIT 500')
      .bind(deliveryId)
      .all<ScanEventRow>();

    return (res.results || []).map((s) => this.mapScanRow(s));
  }

  /**
   * Safe migration helper for existing localStorage / IndexedDB deliveries.
   * Checks for existing deliveries by ID and Docket Number to prevent conflicting duplicates.
   */
  async migrateLocalDeliveries(deliveries: CreateDeliveryInput[]) {
    if (!Array.isArray(deliveries) || deliveries.length === 0) {
      return { importedCount: 0, skippedCount: 0, importedIds: [], existingIds: [] };
    }

    const importedIds: string[] = [];
    const existingIds: string[] = [];

    for (const del of deliveries) {
      if (!del || !del.docketNumber) continue;

      // Check if ID or Docket Number already exists in the central database
      const existing = await this.db
        .prepare('SELECT id FROM deliveries WHERE id = ? OR docket_number = ?')
        .bind(del.id || '', del.docketNumber)
        .first();

      if (existing) {
        existingIds.push(del.id || del.docketNumber);
        continue;
      }

      await this.createDelivery(del);
      importedIds.push(del.id || del.docketNumber);
    }

    return {
      importedCount: importedIds.length,
      skippedCount: existingIds.length,
      importedIds,
      existingIds,
    };
  }

  // ==========================================
  // PHASE 2: AUTHENTICATION & USER MANAGEMENT
  // ==========================================

  /**
   * Check if any administrator exists in the system (first-time setup check)
   */
  async getProvisionStatus() {
    const adminRes = await this.db
      .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND active = 1")
      .first<{ count: number }>();

    const totalRes = await this.db
      .prepare('SELECT COUNT(*) as count FROM users')
      .first<{ count: number }>();

    const adminCount = Number(adminRes?.count || 0);
    const totalCount = Number(totalRes?.count || 0);

    return {
      hasAdmin: adminCount > 0,
      totalUsers: totalCount,
    };
  }

  /**
   * Provision the initial Administrator account.
   * Can ONLY be run once when no administrators exist.
   */
  async setupInitialAdmin(input: {
    employeeName: string;
    employeeCode: string;
    pin: string;
    userAgent?: string;
    ipAddress?: string;
  }) {
    const status = await this.getProvisionStatus();
    if (status.hasAdmin) {
      throw new Error('Initial admin setup is permanently disabled. Administrator already exists.');
    }

    const name = (input.employeeName || '').trim();
    const code = (input.employeeCode || '').trim().toUpperCase();
    const pin = (input.pin || '').trim();

    if (!name) throw new Error('Employee name is required');
    if (!code) throw new Error('Employee identifier is required');
    if (!/^\d{4}$/.test(pin)) throw new Error('PIN must be exactly 4 numeric digits');

    const { hash, salt } = await hashPin(pin);
    const now = new Date().toISOString();
    const userId = `usr_admin_${Date.now()}`;

    // Insert initial administrator
    await this.db
      .prepare(
        `INSERT INTO users (
          id, employee_name, employee_code, pin_hash, pin_salt, role, active,
          failed_login_attempts, locked_until, last_login_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(userId, name, code, hash, salt, 'admin', 1, 0, null, now, now, now)
      .run();

    // Create session immediately for frictionless initial setup
    const token = generateSessionToken();
    const tokenHash = await hashSessionToken(token);
    const expiresAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString();

    await this.db
      .prepare(
        `INSERT INTO sessions (
          id, user_id, created_at, expires_at, last_activity_at, user_agent, ip_address
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(tokenHash, userId, now, expiresAt, now, input.userAgent || null, input.ipAddress || null)
      .run();

    return {
      user: {
        id: userId,
        employeeName: name,
        employeeCode: code,
        role: 'admin' as UserRole,
        active: true,
        lastLoginAt: now,
        createdAt: now,
      },
      token,
      expiresAt,
    };
  }

  /**
   * Authenticate employee via 4-digit PIN.
   * Enforces 5-attempt rate-limiting lockout and generic error messages.
   */
  async loginWithPin(
    employeeCode: string,
    pin: string,
    userAgent?: string,
    ipAddress?: string
  ) {
    const code = (employeeCode || '').trim().toUpperCase();
    const cleanPin = (pin || '').trim();

    if (!code || !/^\d{4}$/.test(cleanPin)) {
      throw new Error('Invalid employee identifier or PIN');
    }

    const user = await this.db
      .prepare('SELECT * FROM users WHERE UPPER(employee_code) = ?')
      .bind(code)
      .first<UserRow>();

    if (!user) {
      // Run dummy hash to prevent timing attacks
      await hashPin('0000', '00'.repeat(16));
      throw new Error('Invalid employee identifier or PIN');
    }

    // Check deactivated status
    if (!user.active) {
      throw new Error('This account has been deactivated. Please contact an administrator.');
    }

    const now = new Date().toISOString();

    // Check lockout status
    if (user.locked_until) {
      const lockTime = new Date(user.locked_until).getTime();
      if (lockTime > Date.now()) {
        const remainingMinutes = Math.max(1, Math.ceil((lockTime - Date.now()) / 60000));
        throw new Error(
          `Account locked due to 5 failed attempts. Please try again in ${remainingMinutes} minute(s) or contact an administrator.`
        );
      } else {
        // Lockout expired, clear it
        await this.db
          .prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?')
          .bind(user.id)
          .run();
        user.failed_login_attempts = 0;
        user.locked_until = null;
      }
    }

    // Verify PIN hash
    const isValid = await verifyPin(cleanPin, user.pin_hash || '', user.pin_salt || '');

    if (!isValid) {
      const newAttempts = (user.failed_login_attempts || 0) + 1;
      let lockedUntil: string | null = null;

      if (newAttempts >= 5) {
        lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }

      await this.db
        .prepare(
          'UPDATE users SET failed_login_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?'
        )
        .bind(newAttempts, lockedUntil, now, user.id)
        .run();

      if (newAttempts >= 5) {
        throw new Error(
          'Account locked due to 5 consecutive failed attempts. Please try again in 15 minutes or contact an administrator.'
        );
      }

      throw new Error('Invalid employee identifier or PIN');
    }

    // Login successful: reset failed attempts & update last login
    await this.db
      .prepare(
        'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?'
      )
      .bind(now, now, user.id)
      .run();

    // Create session token
    const token = generateSessionToken();
    const tokenHash = await hashSessionToken(token);
    const expiresAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString();

    await this.db
      .prepare(
        `INSERT INTO sessions (
          id, user_id, created_at, expires_at, last_activity_at, user_agent, ip_address
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(tokenHash, user.id, now, expiresAt, now, userAgent || null, ipAddress || null)
      .run();

    return {
      user: {
        id: user.id,
        employeeName: user.employee_name,
        employeeCode: user.employee_code,
        role: user.role,
        active: Boolean(user.active),
        lastLoginAt: now,
        createdAt: user.created_at,
      },
      token,
      expiresAt,
    };
  }

  /**
   * Validate session token from Cookie or Bearer header.
   * Auto-refreshes last_activity_at and invalidates expired or deactivated sessions.
   */
  async validateSession(token: string): Promise<AuthenticatedUser | null> {
    if (!token || typeof token !== 'string') return null;

    const tokenHash = await hashSessionToken(token);
    const row = await this.db
      .prepare(
        `SELECT s.id as session_id, s.expires_at, s.last_activity_at,
                u.id as user_id, u.employee_name, u.employee_code, u.role, u.active,
                u.locked_until, u.last_login_at, u.created_at
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.id = ?`
      )
      .bind(tokenHash)
      .first<any>();

    if (!row) return null;

    // Check expiry
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await this.db.prepare('DELETE FROM sessions WHERE id = ?').bind(tokenHash).run();
      return null;
    }

    // Check if account was deactivated
    if (!row.active) {
      await this.db.prepare('DELETE FROM sessions WHERE id = ?').bind(tokenHash).run();
      return null;
    }

    // Touch last_activity_at
    const now = new Date().toISOString();
    await this.db
      .prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?')
      .bind(now, tokenHash)
      .run();

    return {
      id: row.user_id,
      employeeName: row.employee_name,
      employeeCode: row.employee_code,
      role: row.role as UserRole,
      active: Boolean(row.active),
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,
    };
  }

  /**
   * Revoke session on explicit logout
   */
  async revokeSession(token: string) {
    if (!token) return;
    const tokenHash = await hashSessionToken(token);
    await this.db.prepare('DELETE FROM sessions WHERE id = ?').bind(tokenHash).run();
  }

  /**
   * List all users (excluding hashes and salts) with activity stats
   */
  async listUsers() {
    const query = `
      SELECT u.id, u.employee_name, u.employee_code, u.role, u.active,
             u.failed_login_attempts, u.locked_until, u.last_login_at,
             u.created_at, u.updated_at,
             COUNT(s.id) as total_scans,
             MAX(s.timestamp) as last_scan_at
      FROM users u
      LEFT JOIN scan_events s ON u.id = s.user_id
      GROUP BY u.id
      ORDER BY u.employee_name ASC
    `;
    const res = await this.db.prepare(query).all<any>();

    return (res.results || []).map((u) => ({
      id: u.id,
      employeeName: u.employee_name,
      employeeCode: u.employee_code,
      role: u.role as UserRole,
      active: Boolean(u.active),
      failedLoginAttempts: Number(u.failed_login_attempts) || 0,
      lockedUntil: u.locked_until || null,
      lastLoginAt: u.last_login_at || null,
      createdAt: u.created_at,
      updatedAt: u.updated_at,
      totalScans: Number(u.total_scans) || 0,
      lastScanAt: u.last_scan_at || null,
    }));
  }

  /**
   * Create a new employee account (Administrator only)
   */
  async createUser(input: {
    employeeName: string;
    employeeCode: string;
    role: UserRole;
    pin: string;
  }) {
    const name = (input.employeeName || '').trim();
    const code = (input.employeeCode || '').trim().toUpperCase();
    const pin = (input.pin || '').trim();
    const role = input.role || 'operator';

    if (!name) throw new Error('Employee name is required');
    if (!code) throw new Error('Employee identifier is required');
    if (!['admin', 'supervisor', 'operator'].includes(role)) {
      throw new Error('Invalid role specified');
    }
    if (!/^\d{4}$/.test(pin)) {
      throw new Error('PIN must be exactly 4 numeric digits');
    }

    // Check duplicate employee code
    const existing = await this.db
      .prepare('SELECT id FROM users WHERE UPPER(employee_code) = ?')
      .bind(code)
      .first();

    if (existing) {
      throw new Error(`An employee with identifier "${code}" already exists.`);
    }

    const { hash, salt } = await hashPin(pin);
    const now = new Date().toISOString();
    const userId = `usr_${role}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    await this.db
      .prepare(
        `INSERT INTO users (
          id, employee_name, employee_code, pin_hash, pin_salt, role, active,
          failed_login_attempts, locked_until, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, null, ?, ?)`
      )
      .bind(userId, name, code, hash, salt, role, now, now)
      .run();

    return {
      id: userId,
      employeeName: name,
      employeeCode: code,
      role,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Update employee details (Name, identifier, role, active status)
   */
  async updateUser(
    userId: string,
    updates: {
      employeeName?: string;
      employeeCode?: string;
      role?: UserRole;
      active?: boolean;
    }
  ) {
    const existing = await this.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first<UserRow>();

    if (!existing) {
      throw new Error(`User not found: ${userId}`);
    }

    // Guard: Prevent deactivating the last active administrator
    if (existing.role === 'admin' && updates.active === false) {
      const activeAdmins = await this.db
        .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND active = 1 AND id != ?")
        .bind(userId)
        .first<{ count: number }>();

      if ((activeAdmins?.count || 0) <= 0) {
        throw new Error('Cannot deactivate the last remaining active Administrator.');
      }
    }

    // Guard: Prevent changing role of the last active administrator
    if (existing.role === 'admin' && updates.role && updates.role !== 'admin') {
      const activeAdmins = await this.db
        .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND active = 1 AND id != ?")
        .bind(userId)
        .first<{ count: number }>();

      if ((activeAdmins?.count || 0) <= 0) {
        throw new Error('Cannot demote the last remaining active Administrator.');
      }
    }

    // Check code uniqueness if changing code
    if (updates.employeeCode) {
      const code = updates.employeeCode.trim().toUpperCase();
      const duplicate = await this.db
        .prepare('SELECT id FROM users WHERE UPPER(employee_code) = ? AND id != ?')
        .bind(code, userId)
        .first();

      if (duplicate) {
        throw new Error(`Employee identifier "${code}" is already in use.`);
      }
    }

    const now = new Date().toISOString();
    const newName = updates.employeeName !== undefined ? updates.employeeName.trim() : existing.employee_name;
    const newCode = updates.employeeCode !== undefined ? updates.employeeCode.trim().toUpperCase() : existing.employee_code;
    const newRole = updates.role !== undefined ? updates.role : existing.role;
    const newActive = updates.active !== undefined ? (updates.active ? 1 : 0) : existing.active;

    await this.db
      .prepare(
        `UPDATE users
         SET employee_name = ?, employee_code = ?, role = ?, active = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(newName, newCode, newRole, newActive, now, userId)
      .run();

    // If deactivated, kill any active sessions immediately
    if (newActive === 0) {
      await this.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
    }

    return {
      id: userId,
      employeeName: newName,
      employeeCode: newCode,
      role: newRole,
      active: Boolean(newActive),
      updatedAt: now,
    };
  }

  /**
   * Reset employee 4-digit PIN (Administrator only).
   * Automatically clears any existing lockouts and revokes active sessions.
   */
  async resetUserPin(userId: string, newPin: string) {
    const pin = (newPin || '').trim();
    if (!/^\d{4}$/.test(pin)) {
      throw new Error('PIN must be exactly 4 numeric digits');
    }

    const existing = await this.db
      .prepare('SELECT id FROM users WHERE id = ?')
      .bind(userId)
      .first();

    if (!existing) {
      throw new Error(`User not found: ${userId}`);
    }

    const { hash, salt } = await hashPin(pin);
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `UPDATE users
         SET pin_hash = ?, pin_salt = ?, failed_login_attempts = 0, locked_until = NULL, updated_at = ?
         WHERE id = ?`
      )
      .bind(hash, salt, now, userId)
      .run();

    // Revoke sessions for security so user must log in with new PIN
    await this.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();

    return { success: true, message: 'PIN reset successfully.' };
  }

  /**
   * Delete an employee account safely while preserving historical scan records.
   */
  async deleteUser(userId: string) {
    const existing = await this.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first<UserRow>();

    if (!existing) {
      throw new Error(`User not found: ${userId}`);
    }

    // Guard: Prevent deleting the last active administrator
    if (existing.role === 'admin') {
      const activeAdmins = await this.db
        .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND active = 1 AND id != ?")
        .bind(userId)
        .first<{ count: number }>();

      if ((activeAdmins?.count || 0) <= 0) {
        throw new Error('Cannot delete the last remaining active Administrator.');
      }
    }

    // Revoke sessions
    await this.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();

    // Preserve historical audit trail: scan events already have employee_name and employee_role snapshotted.
    // Set user_id to NULL to satisfy relational constraints without losing scan history
    await this.db
      .prepare('UPDATE scan_events SET user_id = NULL WHERE user_id = ?')
      .bind(userId)
      .run();

    // Delete user
    await this.db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();

    return { success: true, message: 'User deleted successfully while preserving scan audit history.' };
  }
}

