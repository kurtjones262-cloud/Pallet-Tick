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
  verifySetupSecretConstantTime,
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
    revision?: string;
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
    manuallyEdited?: boolean;
    lastEditedBy?: string;
    lastEditedAt?: string;
    originalOcrValues?: {
      partNumber: string;
      itemNumber?: string;
      description: string;
      revision?: string;
      quantity: number;
    };
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
  mode?: 'set' | 'increment';
  idempotencyKey?: string;
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
    let parsedOriginalOcr:
      | {
          partNumber: string;
          itemNumber?: string;
          description: string;
          revision?: string;
          quantity: number;
        }
      | undefined = undefined;
    if (row.original_ocr_values) {
      try {
        parsedOriginalOcr = JSON.parse(row.original_ocr_values);
      } catch {
        parsedOriginalOcr = undefined;
      }
    }

    return {
      id: row.id,
      deliveryId: row.delivery_id,
      partNumber: row.part_number,
      itemNumber: row.item_number,
      docketLineIndex: row.docket_line_index,
      description: row.description,
      revision: row.revision || undefined,
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
      lastScannedById: row.last_scanned_by_id || undefined,
      lastScannedByName: row.last_scanned_by_name || undefined,
      notes: row.notes || undefined,
      flaggedForReview: Boolean(row.flagged_for_review),
      ocrConfidence: (row.ocr_confidence as any) || undefined,
      manuallyEdited: Boolean(row.manually_edited),
      lastEditedBy: row.last_edited_by || undefined,
      lastEditedAt: row.last_edited_at || undefined,
      originalOcrValues: parsedOriginalOcr,
      version: Number(row.version || 1),
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
      version: Number(row.version || 1),
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
    const createdBy = input.createdBy || null;

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

      const originalOcrObj = p.originalOcrValues || {
        partNumber: p.partNumber.trim().toUpperCase(),
        itemNumber: p.itemNumber.trim(),
        description: p.description.trim(),
        revision: p.revision ? String(p.revision).trim() : undefined,
        quantity: reqQty,
      };

      stmts.push(
        this.db
          .prepare(
            `INSERT INTO delivery_parts (
              id, delivery_id, part_number, item_number, docket_line_index, description, revision,
              required_quantity, received_quantity, verification_status, status,
              material, thickness, dimensions, weight, pallet_number,
              scanned_at, scanned_via, scanned_code, notes, flagged_for_review,
              ocr_confidence, manually_edited, original_ocr_values, last_edited_by, last_edited_at,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            partId,
            id,
            p.partNumber.trim().toUpperCase(),
            p.itemNumber.trim(),
            lineIndex,
            p.description.trim(),
            p.revision ? String(p.revision).trim() : null,
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
            p.manuallyEdited ? 1 : 0,
            JSON.stringify(originalOcrObj),
            p.lastEditedBy || null,
            p.lastEditedAt || null,
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
             delivery_status = ?, carrier = ?, pallet_count = ?, notes = ?,
             version = COALESCE(version, 1) + 1, updated_at = ?
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
   * Helper: Determine if an actor has supervisor or administrator privileges
   */
  private isSupervisorOrAdmin(role?: string): boolean {
    const r = (role || '').trim().toLowerCase();
    return r === 'super_admin' || r === 'admin' || r === 'supervisor';
  }

  /**
   * Determines whether two part entries with the same normalized partNumber represent an
   * accidental duplicate conflict vs. a legitimate multi-line docket split (distinct non-empty
   * Revision or distinct non-empty Pallet allocation).
   */
  private isSamePartConflict(
    existing: {
      partNumber: string;
      itemNumber?: string | null;
      revision?: string | null;
      palletNumber?: string | null;
    },
    incoming: {
      partNumber: string;
      explicitItemNumber?: string | null;
      revision?: string | null;
      palletNumber?: string | null;
    }
  ): boolean {
    const p1 = String(existing.partNumber || '').trim().toUpperCase();
    const p2 = String(incoming.partNumber || '').trim().toUpperCase();
    if (!p1 || !p2 || p1 !== p2) return false;

    // If caller explicitly specified an itemNumber that collides with the existing row's itemNumber, always conflict
    const item1 = String(existing.itemNumber || '').trim();
    const item2 = String(incoming.explicitItemNumber || '').trim();
    if (item1 && item2 && item1 === item2) {
      return true;
    }

    const rev1 = String(existing.revision || '').trim().toUpperCase();
    const rev2 = String(incoming.revision || '').trim().toUpperCase();
    const hasDistinctRevision = rev1 !== '' && rev2 !== '' && rev1 !== rev2;

    const pal1 = String(existing.palletNumber || '').trim().toUpperCase();
    const pal2 = String(incoming.palletNumber || '').trim().toUpperCase();
    const hasDistinctPallet = pal1 !== '' && pal2 !== '' && pal1 !== pal2;

    // Legitimate split lines must explicitly differentiate either Revision or Pallet allocation
    if (hasDistinctRevision || hasDistinctPallet) {
      return false;
    }

    return true;
  }

  /**
   * Manually add a new part to an existing delivery docket with validation and audit logging
   */
  async addDeliveryPart(
    deliveryId: string,
    input: {
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
      allowDuplicatePartNumber?: boolean;
    },
    actor?: { id?: string; employeeName?: string; role?: string }
  ) {
    const delivery = await this.db
      .prepare('SELECT id, delivery_status FROM deliveries WHERE id = ?')
      .bind(deliveryId)
      .first<DeliveryRow>();

    if (!delivery) {
      throw new Error(`Delivery not found: ${deliveryId}`);
    }

    const partNumber = String(input.partNumber || '')
      .trim()
      .toUpperCase();
    if (!partNumber) {
      throw new Error('Part Number is required when adding a part.');
    }
    if (partNumber.length > 120) {
      throw new Error('Part Number cannot exceed 120 characters.');
    }

    const rawQty = input.quantity === undefined || input.quantity === null ? 1 : Number(input.quantity);
    if (!Number.isFinite(rawQty) || rawQty < 1 || rawQty > 100000) {
      throw new Error('Quantity must be a valid positive number (between 1 and 100,000).');
    }
    const reqQty = Math.max(1, Math.round(rawQty));

    const existingParts = await this.db
      .prepare(
        'SELECT id, part_number, item_number, docket_line_index, revision, pallet_number FROM delivery_parts WHERE delivery_id = ? ORDER BY docket_line_index DESC'
      )
      .bind(deliveryId)
      .all<{
        id: string;
        part_number: string;
        item_number: string;
        docket_line_index: number;
        revision: string | null;
        pallet_number: string | null;
      }>();

    const existingList = existingParts.results || [];

    const maxLineIndex = existingList.reduce(
      (max, r) => Math.max(max, Number(r.docket_line_index) || 0),
      0
    );
    const maxItemNum = existingList.reduce((max, r) => {
      const parsed = parseInt(String(r.item_number || '').replace(/\D+/g, ''), 10);
      return Number.isNaN(parsed) ? max : Math.max(max, parsed);
    }, 0);

    const nextIndex = maxLineIndex + 1;
    const explicitItemNumber = String(input.itemNumber || '').trim();
    const itemNumber = explicitItemNumber || String(Math.max(nextIndex, maxItemNum + 1));
    const description = String(input.description || '').trim() || `Part ${partNumber}`;
    const revision = input.revision ? String(input.revision).trim() : null;
    const palletNumber =
      input.palletNumber !== undefined && input.palletNumber !== null && String(input.palletNumber).trim() !== ''
        ? String(input.palletNumber).trim()
        : null;

    // Prevent accidental duplicate part entries in the same delivery while permitting legitimate
    // multi-line docket entries where the same partNumber has an explicitly distinct Revision or Pallet allocation
    // (or when allowDuplicatePartNumber is explicitly set).
    if (!input.allowDuplicatePartNumber) {
      const duplicatePart = existingList.find((r) =>
        this.isSamePartConflict(
          {
            partNumber: r.part_number,
            itemNumber: r.item_number,
            revision: r.revision,
            palletNumber: r.pallet_number,
          },
          {
            partNumber,
            explicitItemNumber,
            revision,
            palletNumber,
          }
        )
      );
      if (duplicatePart) {
        throw new Error(
          `Duplicate part number "${partNumber}" already exists in this delivery (Docket No. ${duplicatePart.item_number}). Specify a distinct Revision or Pallet Number for multi-line parts, or edit the existing part row.`
        );
      }
    }

    const now = new Date().toISOString();
    const partId = input.id || `part_${deliveryId}_manual_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const actorName = actor?.employeeName || 'Authorized User';
    const actorId = actor?.id || null;
    const actorRole = actor?.role || 'supervisor';

    const scanId = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const auditMessage = `Manually added part ${partNumber} (No. ${itemNumber}${
      revision ? `, Rev ${revision}` : ''
    }) — "${description}" (Qty ${reqQty}) by ${actorName}`;

    // Adding an unscanned part means the delivery now has an outstanding item; ensure status is 'receiving'
    const stmts = [
      this.db
        .prepare(
          `INSERT INTO delivery_parts (
            id, delivery_id, part_number, item_number, docket_line_index, description, revision,
            required_quantity, received_quantity, verification_status, status,
            material, thickness, dimensions, weight, pallet_number,
            notes, manually_edited, original_ocr_values, last_edited_by, last_edited_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'unscanned', 'outstanding', ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?)`
        )
        .bind(
          partId,
          deliveryId,
          partNumber,
          itemNumber,
          nextIndex,
          description,
          revision,
          reqQty,
          input.material ? String(input.material).trim() : null,
          input.thickness ? String(input.thickness).trim() : null,
          input.dimensions ? String(input.dimensions).trim() : null,
          input.weight ? String(input.weight).trim() : null,
          input.palletNumber ? String(input.palletNumber).trim() : null,
          input.notes ? String(input.notes).trim() : null,
          actorName,
          now,
          now,
          now
        ),
      this.db
        .prepare(
          `INSERT INTO scan_events (
            id, delivery_id, part_id, user_id, timestamp, code,
            scan_type, scan_status, quantity_added, received_quantity_after,
            scan_result, employee_name, employee_role, event_action
          ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'part_added', ?, 0, ?, ?, ?, 'part_added')`
        )
        .bind(scanId, deliveryId, partId, actorId, now, partNumber, reqQty, auditMessage, actorName, actorRole),
      this.db
        .prepare("UPDATE deliveries SET delivery_status = 'receiving', version = COALESCE(version, 1) + 1, updated_at = ? WHERE id = ?")
        .bind(now, deliveryId),
    ];

    await this.db.batch(stmts);

    const createdPartRow = await this.db
      .prepare('SELECT * FROM delivery_parts WHERE id = ?')
      .bind(partId)
      .first<DeliveryPartRow>();

    const updatedDelivery = await this.getDeliveryById(deliveryId);

    return {
      status: 'added',
      part: createdPartRow ? this.mapPartRow(createdPartRow) : null,
      delivery: updatedDelivery,
    };
  }

  /**
   * Manually edit an existing part on a delivery docket.
   * Preserves original OCR values, keeps scanning/verification status consistent if already scanned,
   * enforces supervisor/admin RBAC when modifying already-scanned parts, and records an audit event in scan_events.
   */
  async updateDeliveryPart(
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
      allowDuplicatePartNumber?: boolean;
      supervisorApproved?: boolean;
    },
    actor?: { id?: string; employeeName?: string; role?: string }
  ) {
    const existing = await this.db
      .prepare('SELECT * FROM delivery_parts WHERE delivery_id = ? AND id = ?')
      .bind(deliveryId, partId)
      .first<DeliveryPartRow>();

    if (!existing) {
      throw new Error(`Part ${partId} not found in delivery ${deliveryId}`);
    }

    const recQty = Math.max(0, Number(existing.received_quantity) || 0);
    const hasScanEventsRes = await this.db
      .prepare(
        "SELECT COUNT(*) as count FROM scan_events WHERE delivery_id = ? AND part_id = ? AND scan_status NOT IN ('part_added', 'part_edited', 'part_deleted')"
      )
      .bind(deliveryId, partId)
      .first<{ count: number }>();
    const hasScanHistory = Number(hasScanEventsRes?.count || 0) > 0;
    const isScanned = existing.status === 'received' || recQty > 0 || hasScanHistory;

    // Require Supervisor or Admin privileges (or explicit supervisor approval) to edit a part that has already been scanned
    if (isScanned && actor && !this.isSupervisorOrAdmin(actor.role) && !updates.supervisorApproved) {
      throw new Error(
        'Forbidden: Supervisor or Administrator approval is required to edit a part that has already been scanned.'
      );
    }

    const newPartNumber =
      updates.partNumber !== undefined
        ? String(updates.partNumber).trim().toUpperCase()
        : existing.part_number;
    if (!newPartNumber) {
      throw new Error('Part Number cannot be empty.');
    }
    if (newPartNumber.length > 120) {
      throw new Error('Part Number cannot exceed 120 characters.');
    }

    const newItemNumber =
      updates.itemNumber !== undefined
        ? String(updates.itemNumber).trim() || existing.item_number
        : existing.item_number;

    const newDescription =
      updates.description !== undefined
        ? String(updates.description).trim()
        : existing.description;

    const newRevision =
      updates.revision !== undefined
        ? updates.revision
          ? String(updates.revision).trim()
          : null
        : existing.revision || null;

    const effectivePalletForDup =
      updates.palletNumber !== undefined
        ? updates.palletNumber !== null && String(updates.palletNumber).trim() !== ''
          ? String(updates.palletNumber).trim()
          : null
        : existing.pallet_number || null;

    // Check for accidental duplicate against other rows in the same delivery
    if (
      !updates.allowDuplicatePartNumber &&
      (newPartNumber !== existing.part_number ||
        (newRevision || '') !== (existing.revision || '') ||
        (effectivePalletForDup || '') !== (existing.pallet_number || ''))
    ) {
      const otherRowsRes = await this.db
        .prepare(
          'SELECT id, part_number, item_number, revision, pallet_number FROM delivery_parts WHERE delivery_id = ? AND id != ? AND UPPER(part_number) = ?'
        )
        .bind(deliveryId, partId, newPartNumber)
        .all<{
          id: string;
          part_number: string;
          item_number: string;
          revision: string | null;
          pallet_number: string | null;
        }>();

      const duplicateRow = (otherRowsRes.results || []).find((r) =>
        this.isSamePartConflict(
          {
            partNumber: r.part_number,
            itemNumber: r.item_number,
            revision: r.revision,
            palletNumber: r.pallet_number,
          },
          {
            partNumber: newPartNumber,
            explicitItemNumber: updates.itemNumber !== undefined ? newItemNumber : null,
            revision: newRevision,
            palletNumber: effectivePalletForDup,
          }
        )
      );

      if (duplicateRow) {
        throw new Error(
          `Duplicate part number "${newPartNumber}" already exists in this delivery (Docket No. ${duplicateRow.item_number}). Specify a distinct Revision or Pallet Number for multi-line parts.`
        );
      }
    }

    let newReqQty = existing.required_quantity;
    if (updates.quantity !== undefined && updates.quantity !== null) {
      const parsedQty = Number(updates.quantity);
      if (!Number.isFinite(parsedQty) || parsedQty < 1 || parsedQty > 100000) {
        throw new Error('Quantity must be a positive number (between 1 and 100,000).');
      }
      newReqQty = Math.max(1, Math.round(parsedQty));
    }

    const newMaterial =
      updates.material !== undefined
        ? updates.material
          ? String(updates.material).trim()
          : null
        : existing.material;
    const newThickness =
      updates.thickness !== undefined
        ? updates.thickness
          ? String(updates.thickness).trim()
          : null
        : existing.thickness;
    const newDimensions =
      updates.dimensions !== undefined
        ? updates.dimensions
          ? String(updates.dimensions).trim()
          : null
        : existing.dimensions;
    const newWeight =
      updates.weight !== undefined
        ? updates.weight
          ? String(updates.weight).trim()
          : null
        : existing.weight;
    const newPalletNumber =
      updates.palletNumber !== undefined
        ? updates.palletNumber !== null && String(updates.palletNumber).trim() !== ''
          ? String(updates.palletNumber).trim()
          : null
        : existing.pallet_number;
    const newNotes =
      updates.notes !== undefined
        ? updates.notes
          ? String(updates.notes).trim()
          : null
        : existing.notes;

    // Preserve original OCR values before applying manual edits
    let originalOcrJson = existing.original_ocr_values;
    if (!originalOcrJson) {
      originalOcrJson = JSON.stringify({
        partNumber: existing.part_number,
        itemNumber: existing.item_number,
        description: existing.description,
        revision: existing.revision || undefined,
        quantity: existing.required_quantity,
      });
    }

    const changesSummary: string[] = [];
    if (newPartNumber !== existing.part_number) {
      changesSummary.push(`Part#: ${existing.part_number} → ${newPartNumber}`);
    }
    if (newItemNumber !== existing.item_number) {
      changesSummary.push(`No: ${existing.item_number} → ${newItemNumber}`);
    }
    if (newDescription !== existing.description) {
      changesSummary.push(`Desc: "${existing.description}" → "${newDescription}"`);
    }
    if ((newRevision || '') !== (existing.revision || '')) {
      changesSummary.push(`Rev: ${existing.revision || '—'} → ${newRevision || '—'}`);
    }
    if (newReqQty !== existing.required_quantity) {
      changesSummary.push(
        `Qty: ${existing.required_quantity} → ${newReqQty}${
          recQty > 0 ? ` (Received: ${recQty})` : ''
        }`
      );
    }
    if ((newPalletNumber || '') !== (existing.pallet_number || '')) {
      changesSummary.push(`Pallet: ${existing.pallet_number || '—'} → ${newPalletNumber || '—'}`);
    }
    if ((newMaterial || '') !== (existing.material || '')) {
      changesSummary.push(`Mat: ${existing.material || '—'} → ${newMaterial || '—'}`);
    }
    if ((newThickness || '') !== (existing.thickness || '')) {
      changesSummary.push(`Thk: ${existing.thickness || '—'} → ${newThickness || '—'}`);
    }

    const now = new Date().toISOString();
    const actorName = actor?.employeeName || 'Authorized User';
    const actorId = actor?.id || null;
    const actorRole = actor?.role || 'supervisor';
    const scanId = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const auditMessage =
      changesSummary.length > 0
        ? `Manually edited part ${newPartNumber} (No. ${newItemNumber}): ${changesSummary.join('; ')} by ${actorName}`
        : `Saved part ${newPartNumber} (No. ${newItemNumber}) by ${actorName}`;

    // Compute status and verification_status in SQL against live received_quantity to prevent scan/edit race conditions
    const stmts: any[] = [
      this.db
        .prepare(
          `UPDATE delivery_parts
           SET part_number = ?, item_number = ?, description = ?, revision = ?,
               required_quantity = ?,
               status = CASE WHEN status = 'received' OR received_quantity > 0 THEN 'received' ELSE 'outstanding' END,
               verification_status = CASE
                 WHEN status = 'received' OR received_quantity > 0 THEN
                   CASE WHEN received_quantity = ? THEN 'verified' ELSE 'quantity_mismatch' END
                 ELSE 'unscanned'
               END,
               material = ?, thickness = ?, dimensions = ?, weight = ?, pallet_number = ?,
               notes = ?, manually_edited = 1, original_ocr_values = ?,
               last_edited_by = ?, last_edited_at = ?, updated_at = ?,
               version = COALESCE(version, 1) + 1
           WHERE delivery_id = ? AND id = ?`
        )
        .bind(
          newPartNumber,
          newItemNumber,
          newDescription,
          newRevision,
          newReqQty,
          newReqQty,
          newMaterial,
          newThickness,
          newDimensions,
          newWeight,
          newPalletNumber,
          newNotes,
          originalOcrJson,
          actorName,
          now,
          now,
          deliveryId,
          partId
        ),
      this.db
        .prepare(
          `INSERT INTO scan_events (
            id, delivery_id, part_id, user_id, timestamp, code,
            scan_type, scan_status, quantity_added, received_quantity_after,
            scan_result, employee_name, employee_role, event_action
          ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'part_edited', 0, ?, ?, ?, ?, 'part_edited')`
        )
        .bind(
          scanId,
          deliveryId,
          partId,
          actorId,
          now,
          newPartNumber,
          recQty,
          auditMessage,
          actorName,
          actorRole
        ),
      this.db
        .prepare(
          `UPDATE deliveries
           SET delivery_status = CASE
             WHEN EXISTS (
               SELECT 1 FROM delivery_parts
               WHERE delivery_id = ? AND (status != 'received' OR verification_status != 'verified')
             ) THEN 'receiving'
             ELSE delivery_status
           END,
           updated_at = ?,
           version = COALESCE(version, 1) + 1
           WHERE id = ?`
        )
        .bind(deliveryId, now, deliveryId),
    ];

    await this.db.batch(stmts);

    const updatedPartRow = await this.db
      .prepare('SELECT * FROM delivery_parts WHERE id = ?')
      .bind(partId)
      .first<DeliveryPartRow>();

    const updatedDelivery = await this.getDeliveryById(deliveryId);

    return {
      status: 'updated',
      part: updatedPartRow ? this.mapPartRow(updatedPartRow) : null,
      delivery: updatedDelivery,
    };
  }

  /**
   * Delete a part from a delivery docket and record an audit trail entry in scan_events.
   * Historical scan events for the deleted part remain intact (part_id set to NULL).
   */
  async deleteDeliveryPart(
    deliveryId: string,
    partId: string,
    actor?: { id?: string; employeeName?: string; role?: string },
    options?: { supervisorApproved?: boolean }
  ) {
    const existing = await this.db
      .prepare('SELECT * FROM delivery_parts WHERE delivery_id = ? AND id = ?')
      .bind(deliveryId, partId)
      .first<DeliveryPartRow>();

    if (!existing) {
      throw new Error(`Part ${partId} not found in delivery ${deliveryId}`);
    }

    const recQty = Math.max(0, Number(existing.received_quantity) || 0);
    const hasScanEventsRes = await this.db
      .prepare(
        "SELECT COUNT(*) as count FROM scan_events WHERE delivery_id = ? AND part_id = ? AND scan_status NOT IN ('part_added', 'part_edited', 'part_deleted')"
      )
      .bind(deliveryId, partId)
      .first<{ count: number }>();
    const hasScanHistory = Number(hasScanEventsRes?.count || 0) > 0;
    const isScanned = existing.status === 'received' || recQty > 0 || hasScanHistory;

    if (isScanned && actor && !this.isSupervisorOrAdmin(actor.role) && !options?.supervisorApproved) {
      throw new Error(
        'Forbidden: Supervisor or Administrator approval is required to delete a part that has already been scanned.'
      );
    }

    const now = new Date().toISOString();
    const actorName = actor?.employeeName || 'Authorized User';
    const actorId = actor?.id || null;
    const actorRole = actor?.role || 'supervisor';
    const scanId = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const wasScannedNote = isScanned
      ? ` [Was already scanned: ${recQty}/${existing.required_quantity}]`
      : '';
    const auditMessage = `Deleted part ${existing.part_number} (No. ${existing.item_number}${
      existing.revision ? `, Rev ${existing.revision}` : ''
    }) — "${existing.description}" (Qty ${existing.required_quantity})${wasScannedNote} by ${actorName}`;

    const stmts = [
      this.db
        .prepare('UPDATE scan_events SET part_id = NULL WHERE delivery_id = ? AND part_id = ?')
        .bind(deliveryId, partId),
      this.db
        .prepare('DELETE FROM delivery_parts WHERE delivery_id = ? AND id = ?')
        .bind(deliveryId, partId),
      this.db
        .prepare(
          `INSERT INTO scan_events (
            id, delivery_id, part_id, user_id, timestamp, code,
            scan_type, scan_status, quantity_added, received_quantity_after,
            scan_result, employee_name, employee_role, event_action
          ) VALUES (?, ?, NULL, ?, ?, ?, 'manual', 'part_deleted', 0, ?, ?, ?, ?, 'part_deleted')`
        )
        .bind(scanId, deliveryId, actorId, now, existing.part_number, recQty, auditMessage, actorName, actorRole),
      this.db
        .prepare('UPDATE deliveries SET version = COALESCE(version, 1) + 1, updated_at = ? WHERE id = ?')
        .bind(now, deliveryId),
    ];

    await this.db.batch(stmts);

    const updatedDelivery = await this.getDeliveryById(deliveryId);

    return {
      status: 'deleted',
      deletedPartId: partId,
      delivery: updatedDelivery,
    };
  }

  /**
   * Batch save an entire delivery's parts list atomically in a single D1 transaction
   * (supports multi-row inline edits, additions, and deletions).
   */
  async batchSaveDeliveryParts(
    deliveryId: string,
    partsInput: Array<{
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
      allowDuplicatePartNumber?: boolean;
      supervisorApproved?: boolean;
    }>,
    actor?: { id?: string; employeeName?: string; role?: string }
  ) {
    const delivery = await this.db
      .prepare('SELECT id FROM deliveries WHERE id = ?')
      .bind(deliveryId)
      .first<DeliveryRow>();

    if (!delivery) {
      throw new Error(`Delivery not found: ${deliveryId}`);
    }

    if (!Array.isArray(partsInput)) {
      throw new Error('parts array is required');
    }

    const existingRowsRes = await this.db
      .prepare('SELECT * FROM delivery_parts WHERE delivery_id = ? ORDER BY docket_line_index ASC')
      .bind(deliveryId)
      .all<DeliveryPartRow>();
    const existingRows = existingRowsRes.results || [];
    const existingById = new Map<string, DeliveryPartRow>(existingRows.map((r) => [r.id, r]));

    // Pre-validate every part in the batch before executing any database statements
    const incomingIds = new Set<string>();
    const validatedBatchItems: Array<{
      partNumber: string;
      itemNumber?: string | null;
      revision?: string | null;
      palletNumber?: string | null;
    }> = [];

    for (let i = 0; i < partsInput.length; i++) {
      const p = partsInput[i];
      const cleanPartNo = String(p?.partNumber || '')
        .trim()
        .toUpperCase();
      if (!cleanPartNo) {
        throw new Error(`Row ${i + 1}: All parts must have a non-empty Part Number.`);
      }
      if (cleanPartNo.length > 120) {
        throw new Error(`Row ${i + 1}: Part Number cannot exceed 120 characters.`);
      }
      const q = Number(p.quantity ?? 1);
      if (!Number.isFinite(q) || q < 1 || q > 100000) {
        throw new Error(
          `Row ${i + 1}: Invalid quantity for part ${cleanPartNo}: must be between 1 and 100,000.`
        );
      }
      const normRev = p.revision ? String(p.revision).trim() : null;
      const normPallet =
        p.palletNumber !== undefined && p.palletNumber !== null && String(p.palletNumber).trim() !== ''
          ? String(p.palletNumber).trim()
          : null;

      if (!p.allowDuplicatePartNumber) {
        const conflict = validatedBatchItems.find((prev) =>
          this.isSamePartConflict(prev, {
            partNumber: cleanPartNo,
            explicitItemNumber: p.itemNumber ? String(p.itemNumber).trim() : null,
            revision: normRev,
            palletNumber: normPallet,
          })
        );
        if (conflict) {
          throw new Error(
            `Duplicate part number "${cleanPartNo}" found in the parts list. Specify a distinct Revision or Pallet Number for multi-line parts, or combine quantities.`
          );
        }
      }
      validatedBatchItems.push({
        partNumber: cleanPartNo,
        itemNumber: p.itemNumber ? String(p.itemNumber).trim() : null,
        revision: normRev,
        palletNumber: normPallet,
      });
      if (p.id) incomingIds.add(p.id);
    }

    const now = new Date().toISOString();
    const actorName = actor?.employeeName || 'Authorized User';
    const actorId = actor?.id || null;
    const actorRole = actor?.role || 'supervisor';
    const isSupOrAdmin = this.isSupervisorOrAdmin(actor?.role);

    const stmts: any[] = [];

    // 1. Prepare deletion statements for any existing parts removed in the batch
    for (const existing of existingRows) {
      if (!incomingIds.has(existing.id)) {
        const recQty = Math.max(0, Number(existing.received_quantity) || 0);
        const isScanned = existing.status === 'received' || recQty > 0;
        if (isScanned && actor && !isSupOrAdmin) {
          throw new Error(
            `Forbidden: Supervisor or Administrator approval is required to delete scanned part ${existing.part_number}.`
          );
        }
        const scanId = `ev_${Date.now()}_del_${Math.random().toString(36).slice(2, 6)}`;
        const wasScannedNote = isScanned
          ? ` [Was already scanned: ${recQty}/${existing.required_quantity}]`
          : '';
        const auditMessage = `Deleted part ${existing.part_number} (No. ${existing.item_number}${
          existing.revision ? `, Rev ${existing.revision}` : ''
        }) — "${existing.description}" (Qty ${existing.required_quantity})${wasScannedNote} by ${actorName}`;

        stmts.push(
          this.db
            .prepare('UPDATE scan_events SET part_id = NULL WHERE delivery_id = ? AND part_id = ?')
            .bind(deliveryId, existing.id),
          this.db
            .prepare('DELETE FROM delivery_parts WHERE delivery_id = ? AND id = ?')
            .bind(deliveryId, existing.id),
          this.db
            .prepare(
              `INSERT INTO scan_events (
                id, delivery_id, part_id, user_id, timestamp, code,
                scan_type, scan_status, quantity_added, received_quantity_after,
                scan_result, employee_name, employee_role, event_action
              ) VALUES (?, ?, NULL, ?, ?, ?, 'manual', 'part_deleted', 0, ?, ?, ?, ?, 'part_deleted')`
            )
            .bind(scanId, deliveryId, actorId, now, existing.part_number, recQty, auditMessage, actorName, actorRole)
        );
      }
    }

    // 2. Prepare UPDATE or INSERT statements for all parts in the batch
    for (let idx = 0; idx < partsInput.length; idx++) {
      const item = partsInput[idx];
      const existing = item.id ? existingById.get(item.id) : undefined;
      if (existing) {
        const cleanPartNo = String(item.partNumber).trim().toUpperCase();
        const cleanItemNo = String(item.itemNumber ?? existing.item_number).trim() || existing.item_number;
        const cleanDesc = String(item.description ?? existing.description).trim();
        const cleanRev = item.revision ? String(item.revision).trim() : null;
        const cleanQty = Math.max(1, Math.round(Number(item.quantity ?? existing.required_quantity)));
        const cleanPallet =
          item.palletNumber !== undefined && item.palletNumber !== null && String(item.palletNumber).trim() !== ''
            ? String(item.palletNumber).trim()
            : null;
        const cleanMat = item.material ? String(item.material).trim() : null;
        const cleanThk = item.thickness ? String(item.thickness).trim() : null;
        const cleanDim = item.dimensions ? String(item.dimensions).trim() : existing.dimensions;
        const cleanWt = item.weight ? String(item.weight).trim() : existing.weight;
        const cleanNotes = item.notes !== undefined ? (item.notes ? String(item.notes).trim() : null) : existing.notes;

        const hasChanged =
          cleanPartNo !== existing.part_number ||
          cleanItemNo !== existing.item_number ||
          cleanDesc !== existing.description ||
          (cleanRev || '') !== (existing.revision || '') ||
          cleanQty !== existing.required_quantity ||
          (cleanPallet || '') !== (existing.pallet_number || '') ||
          (cleanMat || '') !== (existing.material || '') ||
          (cleanThk || '') !== (existing.thickness || '');

        if (hasChanged) {
          const recQty = Math.max(0, Number(existing.received_quantity) || 0);
          const isScanned = existing.status === 'received' || recQty > 0;
          if (isScanned && actor && !isSupOrAdmin && !item.supervisorApproved) {
            throw new Error(
              `Forbidden: Supervisor or Administrator approval is required to edit scanned part ${existing.part_number}.`
            );
          }

          let originalOcrJson = existing.original_ocr_values;
          if (!originalOcrJson) {
            originalOcrJson = JSON.stringify({
              partNumber: existing.part_number,
              itemNumber: existing.item_number,
              description: existing.description,
              revision: existing.revision || undefined,
              quantity: existing.required_quantity,
            });
          }

          const changesSummary: string[] = [];
          if (cleanPartNo !== existing.part_number) changesSummary.push(`Part#: ${existing.part_number} → ${cleanPartNo}`);
          if (cleanItemNo !== existing.item_number) changesSummary.push(`No: ${existing.item_number} → ${cleanItemNo}`);
          if (cleanDesc !== existing.description) changesSummary.push(`Desc: "${existing.description}" → "${cleanDesc}"`);
          if ((cleanRev || '') !== (existing.revision || '')) changesSummary.push(`Rev: ${existing.revision || '—'} → ${cleanRev || '—'}`);
          if (cleanQty !== existing.required_quantity) {
            changesSummary.push(
              `Qty: ${existing.required_quantity} → ${cleanQty}${recQty > 0 ? ` (Received: ${recQty})` : ''}`
            );
          }
          if ((cleanPallet || '') !== (existing.pallet_number || '')) changesSummary.push(`Pallet: ${existing.pallet_number || '—'} → ${cleanPallet || '—'}`);
          if ((cleanMat || '') !== (existing.material || '')) changesSummary.push(`Mat: ${existing.material || '—'} → ${cleanMat || '—'}`);
          if ((cleanThk || '') !== (existing.thickness || '')) changesSummary.push(`Thk: ${existing.thickness || '—'} → ${cleanThk || '—'}`);

          const scanId = `ev_${Date.now()}_upd_${idx}_${Math.random().toString(36).slice(2, 6)}`;
          const auditMessage = `Manually edited part ${cleanPartNo} (No. ${cleanItemNo}): ${changesSummary.join('; ')} by ${actorName}`;

          stmts.push(
            this.db
              .prepare(
                `UPDATE delivery_parts
                 SET part_number = ?, item_number = ?, description = ?, revision = ?,
                     required_quantity = ?,
                     status = CASE WHEN status = 'received' OR received_quantity > 0 THEN 'received' ELSE 'outstanding' END,
                     verification_status = CASE
                       WHEN status = 'received' OR received_quantity > 0 THEN
                         CASE WHEN received_quantity = ? THEN 'verified' ELSE 'quantity_mismatch' END
                       ELSE 'unscanned'
                     END,
                     material = ?, thickness = ?, dimensions = ?, weight = ?, pallet_number = ?,
                     notes = ?, manually_edited = 1, original_ocr_values = ?,
                     last_edited_by = ?, last_edited_at = ?, updated_at = ?
                 WHERE delivery_id = ? AND id = ?`
              )
              .bind(
                cleanPartNo,
                cleanItemNo,
                cleanDesc,
                cleanRev,
                cleanQty,
                cleanQty,
                cleanMat,
                cleanThk,
                cleanDim,
                cleanWt,
                cleanPallet,
                cleanNotes,
                originalOcrJson,
                actorName,
                now,
                now,
                deliveryId,
                existing.id
              ),
            this.db
              .prepare(
                `INSERT INTO scan_events (
                  id, delivery_id, part_id, user_id, timestamp, code,
                  scan_type, scan_status, quantity_added, received_quantity_after,
                  scan_result, employee_name, employee_role, event_action
                ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'part_edited', 0, ?, ?, ?, ?, 'part_edited')`
              )
              .bind(scanId, deliveryId, existing.id, actorId, now, cleanPartNo, recQty, auditMessage, actorName, actorRole)
          );
        }
      } else {
        const cleanPartNo = String(item.partNumber).trim().toUpperCase();
        const cleanItemNo = String(item.itemNumber || idx + 1).trim();
        const cleanDesc = String(item.description || '').trim() || `Part ${cleanPartNo}`;
        const cleanRev = item.revision ? String(item.revision).trim() : null;
        const cleanQty = Math.max(1, Math.round(Number(item.quantity ?? 1)));
        const partId = item.id || `part_${deliveryId}_manual_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
        const scanId = `ev_${Date.now()}_add_${idx}_${Math.random().toString(36).slice(2, 6)}`;
        const auditMessage = `Manually added part ${cleanPartNo} (No. ${cleanItemNo}${
          cleanRev ? `, Rev ${cleanRev}` : ''
        }) — "${cleanDesc}" (Qty ${cleanQty}) by ${actorName}`;

        stmts.push(
          this.db
            .prepare(
              `INSERT INTO delivery_parts (
                id, delivery_id, part_number, item_number, docket_line_index, description, revision,
                required_quantity, received_quantity, verification_status, status,
                material, thickness, dimensions, weight, pallet_number,
                notes, manually_edited, original_ocr_values, last_edited_by, last_edited_at,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'unscanned', 'outstanding', ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?)`
            )
            .bind(
              partId,
              deliveryId,
              cleanPartNo,
              cleanItemNo,
              idx + 1,
              cleanDesc,
              cleanRev,
              cleanQty,
              item.material ? String(item.material).trim() : null,
              item.thickness ? String(item.thickness).trim() : null,
              item.dimensions ? String(item.dimensions).trim() : null,
              item.weight ? String(item.weight).trim() : null,
              item.palletNumber ? String(item.palletNumber).trim() : null,
              item.notes ? String(item.notes).trim() : null,
              actorName,
              now,
              now,
              now
            ),
          this.db
            .prepare(
              `INSERT INTO scan_events (
                id, delivery_id, part_id, user_id, timestamp, code,
                scan_type, scan_status, quantity_added, received_quantity_after,
                scan_result, employee_name, employee_role, event_action
              ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'part_added', ?, 0, ?, ?, ?, 'part_added')`
            )
            .bind(scanId, deliveryId, partId, actorId, now, cleanPartNo, cleanQty, auditMessage, actorName, actorRole)
        );
      }
    }

    if (stmts.length > 0) {
      stmts.push(
        this.db
          .prepare(
            `UPDATE deliveries
             SET delivery_status = CASE
               WHEN EXISTS (
                 SELECT 1 FROM delivery_parts
                 WHERE delivery_id = ? AND (status != 'received' OR verification_status != 'verified')
               ) THEN 'receiving'
               ELSE delivery_status
             END,
             version = COALESCE(version, 1) + 1,
             updated_at = ?
             WHERE id = ?`
          )
          .bind(deliveryId, now, deliveryId)
      );
      await this.db.batch(stmts);
    }

    const updatedDelivery = await this.getDeliveryById(deliveryId);
    return {
      status: 'batch_saved',
      delivery: updatedDelivery,
    };
  }

  private static partReceiveLocks = new Map<string, Promise<any>>();

  /**
   * Update received quantity for a specific part with atomic scan logging,
   * idempotency key deduplication, per-part concurrency serialization, and
   * strict SQL-level race-condition protection.
   */
  async updatePartReceivedQuantity(
    deliveryId: string,
    partId: string,
    input: ReceivePartInput
  ) {
    const lockKey = `${deliveryId}:${partId}`;
    const prevLock = PalletTrackDbService.partReceiveLocks.get(lockKey) || Promise.resolve();

    let releaseLock!: () => void;
    const currentLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    PalletTrackDbService.partReceiveLocks.set(
      lockKey,
      prevLock.then(() => currentLock).catch(() => currentLock)
    );

    await prevLock.catch(() => {});

    try {
      return await this.executeUpdatePartReceivedQuantityAtomic(deliveryId, partId, input);
    } finally {
      releaseLock();
      if (PalletTrackDbService.partReceiveLocks.get(lockKey) === currentLock) {
        PalletTrackDbService.partReceiveLocks.delete(lockKey);
      }
    }
  }

  private async executeUpdatePartReceivedQuantityAtomic(
    deliveryId: string,
    partId: string,
    input: ReceivePartInput
  ) {
    await this.ensureSchemaReady();

    const cleanIdempotencyKey =
      typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim()
        ? input.idempotencyKey.trim().slice(0, 128)
        : null;

    // 1. Idempotency check: If this exact scan request was already processed (e.g. network retry or offline queue replay),
    // return the previously committed state without double-counting or raising a false duplicate conflict.
    if (cleanIdempotencyKey) {
      const existingScan = await this.db
        .prepare('SELECT * FROM scan_events WHERE idempotency_key = ? LIMIT 1')
        .bind(cleanIdempotencyKey)
        .first<ScanEventRow>();

      if (existingScan) {
        const currentPart = await this.db
          .prepare('SELECT * FROM delivery_parts WHERE delivery_id = ? AND id = ?')
          .bind(deliveryId, partId)
          .first<DeliveryPartRow>();
        const currentDelivery = await this.db
          .prepare('SELECT version FROM deliveries WHERE id = ?')
          .bind(deliveryId)
          .first<{ version: number }>();

        return {
          duplicate: false,
          idempotentReplay: true,
          status: 'updated',
          deliveryVersion: Number(currentDelivery?.version || 1),
          part: currentPart ? this.mapPartRow(currentPart) : null,
          scanEvent: this.mapScanRow(existingScan),
        };
      }
    }

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
    const currentRecQty = Math.max(0, Number(part.received_quantity) || 0);
    const currentVersion = Number(part.version || 1);
    const isIncrementMode = input.mode === 'increment';
    const isScanAttempt = input.scannedVia !== 'manual';

    const recQty = isIncrementMode
      ? currentRecQty + Math.round(enteredQty)
      : Math.round(enteredQty);

    const targetStatus =
      input.status || (recQty > 0 ? 'received' : 'outstanding');

    // DUPLICATE & CONCURRENT RACE PROTECTION:
    // A scan attempt is rejected as a duplicate if:
    // 1. The part is already marked 'received' AND its required quantity is already fulfilled (currentRecQty >= reqQty), OR
    // 2. It is a standard non-increment scan attempt on a part that has already been scanned (currentRecQty > 0) and is not increasing partial quantity toward reqQty.
    const isAlreadyFulfilled =
      part.status === 'received' && currentRecQty >= reqQty && reqQty > 0;
    const isRedundantSameScan =
      isScanAttempt &&
      part.status === 'received' &&
      targetStatus === 'received' &&
      currentRecQty > 0 &&
      (!isIncrementMode && recQty <= currentRecQty);

    if (isScanAttempt && targetStatus === 'received' && (isAlreadyFulfilled || isRedundantSameScan)) {
      const alreadyScannedBy = part.last_scanned_by_name || 'Another worker';
      const alreadyScannedAt = part.scanned_at || part.updated_at;
      const dupScanId = `ev_dup_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const dupMsg = `Duplicate scan – part ${part.part_number} (No. ${part.item_number}) has already been received by ${alreadyScannedBy}`;

      try {
        await this.db
          .prepare(
            `INSERT INTO scan_events (
              id, delivery_id, part_id, user_id, timestamp, code,
              scan_type, scan_status, quantity_added, received_quantity_after,
              scan_result, employee_name, employee_role, event_action
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'duplicate_blocked', 0, ?, ?, ?, ?, 'duplicate_blocked')`
          )
          .bind(
            dupScanId,
            deliveryId,
            partId,
            input.userId || null,
            now,
            input.scannedCode || part.part_number,
            input.scannedVia || 'qr',
            currentRecQty,
            dupMsg,
            input.employeeName || null,
            input.employeeRole || null
          )
          .run();
      } catch {
        // Ignore audit insert error on duplicate
      }

      return {
        duplicate: true,
        status: 'duplicate',
        message: 'Duplicate scan – this part has already been received by another worker',
        error: 'Duplicate scan – this part has already been received by another worker',
        detailMessage: dupMsg,
        alreadyScannedBy,
        alreadyScannedAt,
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
    const lastScannedById =
      targetStatus === 'received' ? input.userId || part.last_scanned_by_id || null : null;
    const lastScannedByName =
      targetStatus === 'received'
        ? input.employeeName || part.last_scanned_by_name || 'Worker'
        : null;

    const scanId = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const addedQty = Math.max(0, recQty - currentRecQty);
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

    // Conditional optimistic-concurrency SQL UPDATE guard:
    // Ensures that if another worker modified this part row concurrently (version changed),
    // this UPDATE affects 0 rows and we immediately re-check and reject duplicate scans.
    const updateRes = await this.db
      .prepare(
        `UPDATE delivery_parts
         SET received_quantity = ?, verification_status = ?, status = ?,
             scanned_via = ?, scanned_code = ?, scanned_at = ?,
             last_scanned_by_id = ?, last_scanned_by_name = ?,
             notes = COALESCE(?, notes),
             version = COALESCE(version, 1) + 1,
             updated_at = ?
         WHERE delivery_id = ? AND id = ? AND COALESCE(version, 1) = ?`
      )
      .bind(
        recQty,
        verificationStatus,
        targetStatus,
        scannedVia,
        scannedCode,
        scannedAt,
        lastScannedById,
        lastScannedByName,
        input.notes || null,
        now,
        deliveryId,
        partId,
        currentVersion
      )
      .run();

    const rowsChanged = Number(updateRes.meta?.changes ?? 1);
    if (rowsChanged === 0) {
      // Another worker's concurrent update won the race! Re-read and return duplicate conflict if received
      const latestPart = await this.db
        .prepare('SELECT * FROM delivery_parts WHERE delivery_id = ? AND id = ?')
        .bind(deliveryId, partId)
        .first<DeliveryPartRow>();

      if (latestPart && latestPart.status === 'received') {
        return {
          duplicate: true,
          status: 'duplicate',
          message: 'Duplicate scan – this part has already been received by another worker',
          error: 'Duplicate scan – this part has already been received by another worker',
          alreadyScannedBy: latestPart.last_scanned_by_name || 'Another worker',
          alreadyScannedAt: latestPart.scanned_at || latestPart.updated_at,
          part: this.mapPartRow(latestPart),
        };
      }
    }

    // Record audit scan event and increment delivery version atomically
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO scan_events (
            id, delivery_id, part_id, user_id, timestamp, code,
            scan_type, scan_status, quantity_added, received_quantity_after,
            scan_result, raw_ocr_text, employee_name, employee_role, event_action, idempotency_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          scanId,
          deliveryId,
          partId,
          input.userId || null,
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
          input.eventAction || (recQty > 0 ? 'part_scan' : 'part_untick'),
          cleanIdempotencyKey
        ),
      this.db
        .prepare(
          'UPDATE deliveries SET version = COALESCE(version, 1) + 1, updated_at = ? WHERE id = ?'
        )
        .bind(now, deliveryId),
    ]);

    const updatedPart = await this.db
      .prepare('SELECT * FROM delivery_parts WHERE id = ?')
      .bind(partId)
      .first<DeliveryPartRow>();

    const updatedDeliveryRow = await this.db
      .prepare('SELECT version, delivery_status FROM deliveries WHERE id = ?')
      .bind(deliveryId)
      .first<{ version: number; delivery_status: string }>();

    const statsRow = await this.db
      .prepare(
        `SELECT
           COUNT(*) as total_count,
           SUM(CASE WHEN status = 'received' THEN 1 ELSE 0 END) as received_count
         FROM delivery_parts
         WHERE delivery_id = ?`
      )
      .bind(deliveryId)
      .first<{ total_count: number; received_count: number }>();

    const totalCount = Number(statsRow?.total_count || 0);
    const receivedCount = Number(statsRow?.received_count || 0);
    const outstandingCount = Math.max(0, totalCount - receivedCount);

    return {
      duplicate: false,
      status: 'updated',
      deliveryVersion: Number(updatedDeliveryRow?.version || 1),
      deliveryStats: {
        totalCount,
        receivedCount,
        outstandingCount,
      },
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
        idempotencyKey: cleanIdempotencyKey || undefined,
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
        input.userId || null,
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
  // PHASE 2: AUTHENTICATION, SUPER ADMIN & RBAC
  // ==========================================

  private static verifiedDbs = new WeakSet<D1Database>();
  private static inFlightSchemaInit = new WeakMap<D1Database, Promise<void>>();

  /**
   * Ensures all required D1 tables and columns exist on the connected database.
   * Uses a per-database in-flight Promise mutex and a single-query fast probe so
   * Cloudflare Workers never exceeds subrequest limits or times out on cold starts.
   */
  async ensureSchemaReady(): Promise<void> {
    if (PalletTrackDbService.verifiedDbs.has(this.db)) return;

    const existingPromise = PalletTrackDbService.inFlightSchemaInit.get(this.db);
    if (existingPromise) {
      return existingPromise;
    }

    const initPromise = this.runSchemaBootstrap().finally(() => {
      PalletTrackDbService.inFlightSchemaInit.delete(this.db);
    });
    PalletTrackDbService.inFlightSchemaInit.set(this.db, initPromise);
    return initPromise;
  }

  private async runSchemaBootstrap(): Promise<void> {
    try {
      await this.db
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM (SELECT id, employee_code, role, active FROM users LIMIT 1)) +
            (SELECT COUNT(*) FROM (SELECT id FROM sessions LIMIT 1)) +
            (SELECT COUNT(*) FROM (SELECT id, revision, manually_edited, original_ocr_values, last_edited_by, last_edited_at, version, last_scanned_by_id, last_scanned_by_name FROM delivery_parts LIMIT 1)) +
            (SELECT COUNT(*) FROM (SELECT id, version FROM deliveries LIMIT 1)) +
            (SELECT COUNT(*) FROM (SELECT id, idempotency_key, sequence_number FROM scan_events LIMIT 1)) +
            (SELECT COUNT(*) FROM (SELECT seq, id FROM realtime_events LIMIT 1)) AS schema_ready`
        )
        .first();
      PalletTrackDbService.verifiedDbs.add(this.db);
      return;
    } catch {
      // Tables or columns missing on a newly created or upgraded D1 instance; initialize non-destructively
    }

    const createStatements = [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        employee_name TEXT NOT NULL,
        employee_code TEXT UNIQUE,
        pin_hash TEXT,
        pin_salt TEXT,
        role TEXT NOT NULL DEFAULT 'employee',
        active INTEGER NOT NULL DEFAULT 1,
        failed_login_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        last_login_at TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        user_agent TEXT,
        ip_address TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        docket_number TEXT NOT NULL,
        supplier TEXT NOT NULL,
        purchase_order_number TEXT,
        delivery_date TEXT NOT NULL,
        delivery_status TEXT NOT NULL DEFAULT 'receiving',
        carrier TEXT,
        pallet_count INTEGER NOT NULL DEFAULT 1,
        supplier_profile TEXT NOT NULL DEFAULT 'laser_central',
        notes TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS delivery_parts (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
        part_number TEXT NOT NULL,
        item_number TEXT NOT NULL,
        docket_line_index INTEGER NOT NULL DEFAULT 1,
        description TEXT NOT NULL,
        revision TEXT,
        required_quantity INTEGER NOT NULL DEFAULT 1,
        received_quantity INTEGER NOT NULL DEFAULT 0,
        verification_status TEXT NOT NULL DEFAULT 'unscanned',
        status TEXT NOT NULL DEFAULT 'outstanding',
        material TEXT,
        thickness TEXT,
        dimensions TEXT,
        weight TEXT,
        pallet_number TEXT,
        scanned_at TEXT,
        scanned_via TEXT,
        scanned_code TEXT,
        last_scanned_by_id TEXT,
        last_scanned_by_name TEXT,
        notes TEXT,
        flagged_for_review INTEGER NOT NULL DEFAULT 0,
        ocr_confidence TEXT,
        manually_edited INTEGER NOT NULL DEFAULT 0,
        original_ocr_values TEXT,
        last_edited_by TEXT,
        last_edited_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS scan_events (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
        part_id TEXT REFERENCES delivery_parts(id) ON DELETE SET NULL,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        employee_name TEXT,
        employee_role TEXT,
        event_action TEXT NOT NULL DEFAULT 'part_scan',
        timestamp TEXT NOT NULL,
        code TEXT NOT NULL,
        scan_type TEXT NOT NULL,
        scan_status TEXT NOT NULL,
        quantity_added INTEGER NOT NULL DEFAULT 0,
        received_quantity_after INTEGER,
        scan_result TEXT,
        raw_ocr_text TEXT,
        idempotency_key TEXT,
        sequence_number INTEGER,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS m1_synchronisations (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
        m1_receipt_reference TEXT,
        sync_status TEXT NOT NULL DEFAULT 'pending',
        submission_timestamp TEXT,
        response_info TEXT,
        error_info TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS realtime_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        delivery_id TEXT,
        part_id TEXT,
        user_id TEXT,
        employee_name TEXT,
        employee_role TEXT,
        delivery_version INTEGER,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    ];

    try {
      await this.db.batch(createStatements.map((sql) => this.db.prepare(sql)));
    } catch {
      for (const sql of createStatements) {
        try {
          await this.db.prepare(sql).run();
        } catch (e) {
          console.warn('Schema bootstrap table notice:', e);
        }
      }
    }

    const alterCols: Array<{ table: string; col: string; sql: string }> = [
      { table: 'users', col: 'employee_code', sql: 'ALTER TABLE users ADD COLUMN employee_code TEXT' },
      { table: 'users', col: 'pin_salt', sql: 'ALTER TABLE users ADD COLUMN pin_salt TEXT' },
      { table: 'users', col: 'last_login_at', sql: 'ALTER TABLE users ADD COLUMN last_login_at TEXT' },
      { table: 'users', col: 'failed_login_attempts', sql: 'ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0' },
      { table: 'users', col: 'locked_until', sql: 'ALTER TABLE users ADD COLUMN locked_until TEXT' },
      { table: 'users', col: 'created_by', sql: 'ALTER TABLE users ADD COLUMN created_by TEXT' },
      { table: 'scan_events', col: 'employee_name', sql: 'ALTER TABLE scan_events ADD COLUMN employee_name TEXT' },
      { table: 'scan_events', col: 'employee_role', sql: 'ALTER TABLE scan_events ADD COLUMN employee_role TEXT' },
      { table: 'scan_events', col: 'event_action', sql: "ALTER TABLE scan_events ADD COLUMN event_action TEXT DEFAULT 'part_scan'" },
      { table: 'scan_events', col: 'idempotency_key', sql: 'ALTER TABLE scan_events ADD COLUMN idempotency_key TEXT' },
      { table: 'scan_events', col: 'sequence_number', sql: 'ALTER TABLE scan_events ADD COLUMN sequence_number INTEGER' },
      { table: 'deliveries', col: 'version', sql: 'ALTER TABLE deliveries ADD COLUMN version INTEGER NOT NULL DEFAULT 1' },
      { table: 'delivery_parts', col: 'revision', sql: 'ALTER TABLE delivery_parts ADD COLUMN revision TEXT' },
      { table: 'delivery_parts', col: 'manually_edited', sql: 'ALTER TABLE delivery_parts ADD COLUMN manually_edited INTEGER NOT NULL DEFAULT 0' },
      { table: 'delivery_parts', col: 'original_ocr_values', sql: 'ALTER TABLE delivery_parts ADD COLUMN original_ocr_values TEXT' },
      { table: 'delivery_parts', col: 'last_edited_by', sql: 'ALTER TABLE delivery_parts ADD COLUMN last_edited_by TEXT' },
      { table: 'delivery_parts', col: 'last_edited_at', sql: 'ALTER TABLE delivery_parts ADD COLUMN last_edited_at TEXT' },
      { table: 'delivery_parts', col: 'version', sql: 'ALTER TABLE delivery_parts ADD COLUMN version INTEGER NOT NULL DEFAULT 1' },
      { table: 'delivery_parts', col: 'last_scanned_by_id', sql: 'ALTER TABLE delivery_parts ADD COLUMN last_scanned_by_id TEXT' },
      { table: 'delivery_parts', col: 'last_scanned_by_name', sql: 'ALTER TABLE delivery_parts ADD COLUMN last_scanned_by_name TEXT' },
    ];

    try {
      const pragmaBatch = await this.db.batch<{ name: string }>([
        this.db.prepare('PRAGMA table_info(users)'),
        this.db.prepare('PRAGMA table_info(scan_events)'),
        this.db.prepare('PRAGMA table_info(deliveries)'),
        this.db.prepare('PRAGMA table_info(delivery_parts)'),
      ]);
      const existingByTable: Record<string, Set<string>> = {
        users: new Set((pragmaBatch[0]?.results || []).map((r) => r.name)),
        scan_events: new Set((pragmaBatch[1]?.results || []).map((r) => r.name)),
        deliveries: new Set((pragmaBatch[2]?.results || []).map((r) => r.name)),
        delivery_parts: new Set((pragmaBatch[3]?.results || []).map((r) => r.name)),
      };
      const missingAlters = alterCols.filter(
        (item) =>
          existingByTable[item.table] &&
          existingByTable[item.table].size > 0 &&
          !existingByTable[item.table].has(item.col)
      );
      for (const item of missingAlters) {
        try {
          await this.db.prepare(item.sql).run();
        } catch {
          // Column already exists
        }
      }
    } catch {
      for (const item of alterCols) {
        try {
          await this.db.prepare(item.sql).run();
        } catch {
          // Column already exists
        }
      }
    }

    const indexStatements = [
      'CREATE INDEX IF NOT EXISTS idx_users_active ON users(active)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee_code ON users(employee_code)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)',
      'CREATE INDEX IF NOT EXISTS idx_deliveries_docket ON deliveries(docket_number)',
      'CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(delivery_status)',
      'CREATE INDEX IF NOT EXISTS idx_deliveries_created_at ON deliveries(created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_parts_delivery ON delivery_parts(delivery_id)',
      'CREATE INDEX IF NOT EXISTS idx_parts_part_number ON delivery_parts(part_number)',
      'CREATE INDEX IF NOT EXISTS idx_parts_item_number ON delivery_parts(item_number)',
      'CREATE INDEX IF NOT EXISTS idx_parts_status ON delivery_parts(delivery_id, status)',
      'CREATE INDEX IF NOT EXISTS idx_scans_delivery ON scan_events(delivery_id)',
      'CREATE INDEX IF NOT EXISTS idx_scans_part ON scan_events(part_id)',
      'CREATE INDEX IF NOT EXISTS idx_scans_user ON scan_events(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scan_events(timestamp DESC)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_events_idempotency ON scan_events(idempotency_key) WHERE idempotency_key IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_m1_delivery ON m1_synchronisations(delivery_id)',
      'CREATE INDEX IF NOT EXISTS idx_realtime_events_seq ON realtime_events(seq ASC)',
      'CREATE INDEX IF NOT EXISTS idx_realtime_events_delivery_seq ON realtime_events(delivery_id, seq ASC)',
    ];

    try {
      await this.db.batch(indexStatements.map((sql) => this.db.prepare(sql)));
    } catch {
      for (const sql of indexStatements) {
        try {
          await this.db.prepare(sql).run();
        } catch {
          // Ignore index notice
        }
      }
    }

    PalletTrackDbService.verifiedDbs.add(this.db);
  }

  /**
   * Normalizes legacy role names ('operator' / 'receiver') to 'employee' while preserving
   * 'super_admin', 'admin', and 'supervisor'.
   */
  private normalizeRole(role: string | null | undefined): UserRole {
    const r = (role || '').trim().toLowerCase();
    if (r === 'super_admin') return 'super_admin';
    if (r === 'admin') return 'admin';
    if (r === 'supervisor') return 'supervisor';
    if (r === 'employee' || r === 'operator' || r === 'receiver') return 'employee';
    return 'employee';
  }

  /**
   * Check if a Super Admin or Admin exists in the system (first-time setup check)
   */
  async getProvisionStatus() {
    await this.ensureSchemaReady();

    const superAdminRes = await this.db
      .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'super_admin' AND active = 1")
      .first<{ count: number }>();

    const adminRes = await this.db
      .prepare("SELECT COUNT(*) as count FROM users WHERE role IN ('super_admin', 'admin') AND active = 1")
      .first<{ count: number }>();

    const totalRes = await this.db
      .prepare('SELECT COUNT(*) as count FROM users WHERE pin_hash IS NOT NULL')
      .first<{ count: number }>();

    let superAdminCount = Number(superAdminRes?.count || 0);
    const adminCount = Number(adminRes?.count || 0);
    const totalCount = Number(totalRes?.count || 0);

    // If an earlier Phase 2 setup created a single 'admin' before 'super_admin' was introduced,
    // automatically promote the earliest active admin to 'super_admin' so the system always has a Super Admin.
    if (superAdminCount === 0 && adminCount > 0) {
      const firstAdmin = await this.db
        .prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY created_at ASC LIMIT 1")
        .first<{ id: string }>();
      if (firstAdmin?.id) {
        await this.db
          .prepare("UPDATE users SET role = 'super_admin' WHERE id = ?")
          .bind(firstAdmin.id)
          .run();
        superAdminCount = 1;
      }
    }

    return {
      hasSuperAdmin: superAdminCount > 0,
      hasAdmin: superAdminCount > 0 || adminCount > 0,
      adminCount,
      totalUsers: totalCount,
    };
  }

  private static readonly SETUP_GUARD_ID = '__system_setup_guard__';
  private static readonly MAX_SETUP_ATTEMPTS = 5;
  private static readonly SETUP_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

  /**
   * Provision the initial Super Admin account.
   * - Permanently disabled once a Super Admin or Admin exists.
   * - Fails closed if INITIAL_SETUP_SECRET is missing or weak/predictable.
   * - Rate-limited in D1 (max 5 failed attempts per 15-minute window).
   * - Uses constant-time SHA-256 comparison so secret values never leak.
   */
  async setupInitialAdmin(input: {
    employeeName: string;
    employeeCode: string;
    pin: string;
    setupSecret?: string;
    expectedSetupSecret?: string;
    userAgent?: string;
    ipAddress?: string;
  }) {
    const status = await this.getProvisionStatus();
    if (status.hasSuperAdmin || status.hasAdmin) {
      const err: any = new Error(
        'Initial Super Admin setup is permanently disabled. A Super Admin already exists.'
      );
      err.code = 'SETUP_ALREADY_COMPLETED';
      err.status = 403;
      throw err;
    }

    const requiredSecret = (input.expectedSetupSecret || '').trim();
    if (!requiredSecret) {
      const err: any = new Error(
        'Initial setup is unavailable: INITIAL_SETUP_SECRET is not configured on the server.'
      );
      err.code = 'SETUP_SECRET_NOT_CONFIGURED';
      err.status = 503;
      throw err;
    }

    const forbiddenDefaults = new Set([
      'changeme',
      'secret',
      'password',
      'admin',
      '123456789012',
    ]);
    if (
      requiredSecret.length < 12 ||
      /^pallettrack-setup-\d+$/i.test(requiredSecret) ||
      forbiddenDefaults.has(requiredSecret.toLowerCase())
    ) {
      const err: any = new Error(
        'Initial setup is unavailable: Server INITIAL_SETUP_SECRET does not meet minimum security requirements (must be at least 12 characters and not a default placeholder).'
      );
      err.code = 'SETUP_SECRET_WEAK';
      err.status = 503;
      throw err;
    }

    // Check D1-backed rate limiting for setup attempts
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const guardRow = await this.db
      .prepare('SELECT failed_login_attempts, locked_until FROM users WHERE id = ?')
      .bind(PalletTrackDbService.SETUP_GUARD_ID)
      .first<{ failed_login_attempts: number; locked_until: string | null }>();

    if (guardRow?.locked_until) {
      const lockExpiresMs = new Date(guardRow.locked_until).getTime();
      if (lockExpiresMs > nowMs) {
        const remainingMinutes = Math.max(1, Math.ceil((lockExpiresMs - nowMs) / 60000));
        const err: any = new Error(
          `Too many failed setup attempts. Initial provisioning is temporarily locked for ${remainingMinutes} minute(s).`
        );
        err.code = 'SETUP_RATE_LIMITED';
        err.status = 429;
        throw err;
      }
    }

    const providedSecret = (input.setupSecret || '').trim();
    const isSecretValid = await verifySetupSecretConstantTime(providedSecret, requiredSecret);

    if (!isSecretValid) {
      const prevFailures =
        guardRow?.locked_until && new Date(guardRow.locked_until).getTime() <= nowMs
          ? 0
          : Number(guardRow?.failed_login_attempts || 0);
      const nextFailures = prevFailures + 1;
      const newLockedUntil =
        nextFailures >= PalletTrackDbService.MAX_SETUP_ATTEMPTS
          ? new Date(nowMs + PalletTrackDbService.SETUP_LOCKOUT_MS).toISOString()
          : null;

      await this.db
        .prepare(
          `INSERT INTO users (
            id, employee_name, employee_code, pin_hash, pin_salt, role, active,
            failed_login_attempts, locked_until, created_by, created_at, updated_at
          ) VALUES (?, 'System Setup Rate Limit Guard', NULL, NULL, NULL, 'employee', 0, ?, ?, 'SYSTEM', ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            failed_login_attempts = excluded.failed_login_attempts,
            locked_until = excluded.locked_until,
            updated_at = excluded.updated_at`
        )
        .bind(PalletTrackDbService.SETUP_GUARD_ID, nextFailures, newLockedUntil, nowIso, nowIso)
        .run();

      if (newLockedUntil) {
        const err: any = new Error(
          'Too many failed setup attempts. Initial provisioning is locked for 15 minutes.'
        );
        err.code = 'SETUP_RATE_LIMITED';
        err.status = 429;
        throw err;
      }

      const err: any = new Error('Invalid one-time setup secret key.');
      err.code = 'INVALID_SETUP_SECRET';
      err.status = 403;
      throw err;
    }

    const name = (input.employeeName || '').trim();
    const code = (input.employeeCode || '').trim().toUpperCase();
    const pin = (input.pin || '').trim();

    if (!name) throw new Error('Super Admin name is required');
    if (!code) throw new Error('Employee identifier is required');
    if (!/^\d{4}$/.test(pin)) throw new Error('PIN must be exactly 4 numeric digits');

    const { hash, salt } = await hashPin(pin);
    const now = new Date().toISOString();
    const userId = `usr_super_admin_${Date.now()}`;

    // Clear setup guard row and insert initial Super Admin atomically
    await this.db
      .prepare('DELETE FROM users WHERE id = ?')
      .bind(PalletTrackDbService.SETUP_GUARD_ID)
      .run();

    await this.db
      .prepare(
        `INSERT INTO users (
          id, employee_name, employee_code, pin_hash, pin_salt, role, active,
          failed_login_attempts, locked_until, last_login_at, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(userId, name, code, hash, salt, 'super_admin', 1, 0, null, now, 'INITIAL_SETUP', now, now)
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
        role: 'super_admin' as UserRole,
        active: true,
        lastLoginAt: now,
        createdBy: 'INITIAL_SETUP',
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
    await this.ensureSchemaReady();

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
        role: this.normalizeRole(user.role),
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

    await this.ensureSchemaReady();

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
      role: this.normalizeRole(row.role),
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
    await this.ensureSchemaReady();
    const tokenHash = await hashSessionToken(token);
    await this.db.prepare('DELETE FROM sessions WHERE id = ?').bind(tokenHash).run();
  }

  /**
   * List all users (excluding hashes and salts) with activity stats
   */
  async listUsers() {
    await this.ensureSchemaReady();

    const query = `
      SELECT u.id, u.employee_name, u.employee_code, u.role, u.active,
             u.failed_login_attempts, u.locked_until, u.last_login_at,
             u.created_by, u.created_at, u.updated_at,
             COUNT(s.id) as total_scans,
             MAX(s.timestamp) as last_scan_at
      FROM users u
      LEFT JOIN scan_events s ON u.id = s.user_id
      WHERE u.employee_code IS NOT NULL OR u.pin_hash IS NOT NULL
      GROUP BY u.id
      ORDER BY
        CASE u.role
          WHEN 'super_admin' THEN 1
          WHEN 'admin' THEN 2
          WHEN 'supervisor' THEN 3
          ELSE 4
        END ASC,
        u.employee_name ASC
    `;
    const res = await this.db.prepare(query).all<any>();

    return (res.results || []).map((u) => ({
      id: u.id,
      employeeName: u.employee_name,
      employeeCode: u.employee_code || u.id,
      role: this.normalizeRole(u.role),
      active: Boolean(u.active),
      failedLoginAttempts: Number(u.failed_login_attempts) || 0,
      lockedUntil: u.locked_until || null,
      lastLoginAt: u.last_login_at || null,
      createdBy: u.created_by || null,
      createdAt: u.created_at,
      updatedAt: u.updated_at,
      totalScans: Number(u.total_scans) || 0,
      lastScanAt: u.last_scan_at || null,
    }));
  }

  /**
   * Create a new user account (Super Admin or Admin).
   * Supports creating unlimited Admin, Supervisor, and Employee accounts.
   * Only a Super Admin can create another Super Admin.
   */
  async createUser(
    input: {
      employeeName: string;
      employeeCode: string;
      role: UserRole;
      pin: string;
    },
    actor?: AuthenticatedUser
  ) {
    await this.ensureSchemaReady();

    const name = (input.employeeName || '').trim();
    const code = (input.employeeCode || '').trim().toUpperCase();
    const pin = (input.pin || '').trim();
    const rawRole = (input.role || 'employee').trim().toLowerCase();
    const role: UserRole =
      rawRole === 'operator' ? 'employee' : (rawRole as UserRole);

    if (!name) throw new Error('Employee name is required');
    if (!code) throw new Error('Employee identifier is required');
    if (!['super_admin', 'admin', 'supervisor', 'employee'].includes(role)) {
      throw new Error('Invalid role specified. Allowed roles: super_admin, admin, supervisor, employee');
    }
    if (!/^\d{4}$/.test(pin)) {
      throw new Error('PIN must be exactly 4 numeric digits');
    }

    // Ensure initial Super Admin setup cannot be bypassed through createUser
    const status = await this.getProvisionStatus();
    if (!status.hasSuperAdmin && !status.hasAdmin) {
      throw new Error('Initial Super Admin setup must be completed before creating user accounts.');
    }
    if (!actor || (actor.role !== 'super_admin' && actor.role !== 'admin')) {
      throw new Error('Forbidden: Administrator privileges are required to create user accounts.');
    }

    // RBAC Check: Only Super Admin can assign the super_admin role
    if (role === 'super_admin' && actor.role !== 'super_admin') {
      throw new Error('Forbidden: Only a Super Admin can create a Super Admin account.');
    }

    // Check duplicate employee code
    const existing = await this.db
      .prepare('SELECT id FROM users WHERE UPPER(employee_code) = ?')
      .bind(code)
      .first();

    if (existing) {
      throw new Error(`An account with identifier "${code}" already exists.`);
    }

    const { hash, salt } = await hashPin(pin);
    const now = new Date().toISOString();
    const userId = `usr_${role}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const createdBy = actor ? `${actor.employeeName} (${actor.employeeCode})` : 'SYSTEM';

    await this.db
      .prepare(
        `INSERT INTO users (
          id, employee_name, employee_code, pin_hash, pin_salt, role, active,
          failed_login_attempts, locked_until, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, null, ?, ?, ?)`
      )
      .bind(userId, name, code, hash, salt, role, createdBy, now, now)
      .run();

    return {
      id: userId,
      employeeName: name,
      employeeCode: code,
      role,
      active: true,
      createdBy,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Update user details (Name, identifier, role, active status).
   * Enforces strict protection so Admin cannot remove, deactivate, or downgrade a Super Admin.
   */
  async updateUser(
    userId: string,
    updates: {
      employeeName?: string;
      employeeCode?: string;
      role?: UserRole;
      active?: boolean;
    },
    actor?: AuthenticatedUser
  ) {
    await this.ensureSchemaReady();

    const existing = await this.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first<UserRow>();

    if (!existing) {
      throw new Error(`User not found: ${userId}`);
    }

    const targetRole = this.normalizeRole(existing.role);
    const requestedRole =
      updates.role !== undefined ? this.normalizeRole(updates.role) : targetRole;

    // RBAC Rule: Admin cannot modify, deactivate, or downgrade a Super Admin
    if (targetRole === 'super_admin' && actor && actor.role !== 'super_admin') {
      throw new Error('Forbidden: Administrators cannot modify, deactivate, or downgrade a Super Admin account.');
    }

    // RBAC Rule: Admin cannot promote anyone to Super Admin
    if (requestedRole === 'super_admin' && actor && actor.role !== 'super_admin') {
      throw new Error('Forbidden: Only a Super Admin can assign the Super Admin role.');
    }

    // Guard: Prevent deactivating the last active Super Admin
    if (targetRole === 'super_admin' && updates.active === false) {
      const otherSuperAdmins = await this.db
        .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'super_admin' AND active = 1 AND id != ?")
        .bind(userId)
        .first<{ count: number }>();

      if ((otherSuperAdmins?.count || 0) <= 0) {
        throw new Error('Cannot deactivate the primary active Super Admin account.');
      }
    }

    // Guard: Prevent demoting the last active Super Admin
    if (targetRole === 'super_admin' && requestedRole !== 'super_admin') {
      const otherSuperAdmins = await this.db
        .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'super_admin' AND active = 1 AND id != ?")
        .bind(userId)
        .first<{ count: number }>();

      if ((otherSuperAdmins?.count || 0) <= 0) {
        throw new Error('Cannot downgrade the primary active Super Admin account.');
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
    const newRole = requestedRole;
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
   * Reset employee 4-digit PIN (Super Admin or Admin).
   * Admin cannot reset a Super Admin's PIN.
   */
  async resetUserPin(userId: string, newPin: string, actor?: AuthenticatedUser) {
    await this.ensureSchemaReady();

    const pin = (newPin || '').trim();
    if (!/^\d{4}$/.test(pin)) {
      throw new Error('PIN must be exactly 4 numeric digits');
    }

    const existing = await this.db
      .prepare('SELECT id, role FROM users WHERE id = ?')
      .bind(userId)
      .first<{ id: string; role: string }>();

    if (!existing) {
      throw new Error(`User not found: ${userId}`);
    }

    const targetRole = this.normalizeRole(existing.role);
    if (targetRole === 'super_admin' && actor && actor.role !== 'super_admin') {
      throw new Error('Forbidden: Administrators cannot reset a Super Admin PIN.');
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
   * Admin cannot delete a Super Admin. The last active Super Admin cannot be deleted.
   */
  async deleteUser(userId: string, actor?: AuthenticatedUser) {
    await this.ensureSchemaReady();

    const existing = await this.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first<UserRow>();

    if (!existing) {
      throw new Error(`User not found: ${userId}`);
    }

    const targetRole = this.normalizeRole(existing.role);

    if (targetRole === 'super_admin' && actor && actor.role !== 'super_admin') {
      throw new Error('Forbidden: Administrators cannot remove a Super Admin account.');
    }

    // Guard: Prevent deleting the last active Super Admin
    if (targetRole === 'super_admin') {
      const otherSuperAdmins = await this.db
        .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'super_admin' AND active = 1 AND id != ?")
        .bind(userId)
        .first<{ count: number }>();

      if ((otherSuperAdmins?.count || 0) <= 0) {
        throw new Error('Cannot delete the primary active Super Admin account.');
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


