import {
  Delivery,
  AppSettings,
  DeliveryPart,
  UnexpectedPart,
  ScanEvent,
  ScanMethod,
  PendingQuantityConfirmation,
  SupplierRuleId,
  SupplierRuleDefinition,
} from '../types/delivery';
import {
  generate200PartDelivery,
  generate45PartDelivery,
  generate15PartDelivery,
  DEFAULT_APP_SETTINGS,
} from './sampleData';
import {
  saveDeliveryToIndexedDb,
  deleteDeliveryFromIndexedDb,
  saveDocketImageToIndexedDb,
  clearAllIndexedDb,
} from './indexedDb';
import {
  apiFetchDeliveries,
  apiCreateDelivery,
  apiUpdateDelivery,
  apiReceivePart,
  apiMigrateDeliveries,
  apiAddDeliveryPart,
  apiUpdateDeliveryPart,
  apiBatchSaveDeliveryParts,
  apiDeleteDeliveryPart,
  getStoredUser,
  checkBackendConnection,
  isBackendOnline,
} from '../services/palletTrackApi';


const DELIVERIES_KEY = 'parttrack_deliveries_v2';
const ACTIVE_DELIVERY_KEY = 'parttrack_active_delivery_id_v2';
const SETTINGS_KEY = 'parttrack_settings_v1';
const PREFERRED_SUPPLIER_RULE_KEY = 'parttrack_preferred_supplier_rule_v1';
const RESET_FLAG = 'parttrack_fresh_reset_20261105';

export const SUPPLIER_RULES: Record<SupplierRuleId, SupplierRuleDefinition> = {
  laser_central: {
    id: 'laser_central',
    name: 'Laser Central',
    codeType: 'barcode',
    ruleBadge: 'Laser Central',
    ruleSummary: 'Laser Central',
    scanPrompt: 'Laser Central · Ready to scan',
  },
  gci: {
    id: 'gci',
    name: 'GCI',
    codeType: 'qr',
    ruleBadge: 'GCI',
    ruleSummary: 'GCI',
    scanPrompt: 'GCI · Ready to scan',
  },
  ocr_label: {
    id: 'ocr_label',
    name: 'OCR Label Scanner',
    codeType: 'ocr_label',
    ruleBadge: 'OCR Label Scanner',
    ruleSummary: 'OCR Label Scanner',
    scanPrompt: 'OCR Label Scanner · Position pallet label in frame',
  },
};

export function getPreferredSupplierRuleId(): SupplierRuleId {
  if (typeof window === 'undefined') return 'laser_central';
  try {
    const stored = localStorage.getItem(PREFERRED_SUPPLIER_RULE_KEY);
    if (stored === 'gci' || stored === 'laser_central' || stored === 'ocr_label') {
      return stored;
    }
  } catch {}
  return 'laser_central';
}

export function setPreferredSupplierRuleId(ruleId: SupplierRuleId): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(PREFERRED_SUPPLIER_RULE_KEY, ruleId);
    window.dispatchEvent(
      new CustomEvent('parttrack_supplier_rule_changed', { detail: ruleId })
    );
  } catch {}
}

export function getDeliverySupplierRule(delivery?: Delivery | null): SupplierRuleDefinition {
  if (!delivery) {
    return SUPPLIER_RULES[getPreferredSupplierRuleId()] || SUPPLIER_RULES.laser_central;
  }
  if (delivery.supplierProfile && SUPPLIER_RULES[delivery.supplierProfile]) {
    return SUPPLIER_RULES[delivery.supplierProfile];
  }
  if (/\bocr\b/i.test(delivery.supplier || '')) {
    return SUPPLIER_RULES.ocr_label;
  }
  if (/\bgci\b/i.test(delivery.supplier || '')) {
    return SUPPLIER_RULES.gci;
  }
  return SUPPLIER_RULES.laser_central;
}

export function setDeliverySupplierRule(
  delivery: Delivery,
  ruleId: SupplierRuleId
): Delivery {
  const rule = SUPPLIER_RULES[ruleId] || SUPPLIER_RULES.laser_central;
  setPreferredSupplierRuleId(rule.id);
  const updated: Delivery = {
    ...delivery,
    supplierProfile: rule.id,
    supplier: rule.name,
    updatedAt: new Date().toISOString(),
  };
  updateDelivery(updated);
  return updated;
}

// Perform clean reset of all previous deliveries to guarantee a completely fresh app
if (typeof window !== 'undefined') {
  try {
    if (!localStorage.getItem(RESET_FLAG)) {
      localStorage.removeItem('parttrack_deliveries_v1');
      localStorage.removeItem('parttrack_active_delivery_id');
      localStorage.removeItem('parttrack_deliveries_v2');
      localStorage.removeItem('parttrack_active_delivery_id_v2');
      localStorage.setItem(DELIVERIES_KEY, JSON.stringify([]));
      localStorage.setItem(RESET_FLAG, 'true');
    }
  } catch (e) {
    console.error('Initial reset error:', e);
  }
}

export function getPartVerificationState(part: DeliveryPart): {
  state: 'verified' | 'quantity_mismatch' | 'unscanned';
  color: 'green' | 'orange' | 'red';
  requiredQty: number;
  receivedQty: number;
} {
  const requiredQty = Math.max(1, part.quantity ?? 1);
  if (part.status !== 'received') {
    return {
      state: 'unscanned',
      color: 'red',
      requiredQty,
      receivedQty: 0,
    };
  }
  const receivedQty =
    typeof part.receivedQuantity === 'number' ? part.receivedQuantity : requiredQty;
  if (receivedQty === requiredQty) {
    return {
      state: 'verified',
      color: 'green',
      requiredQty,
      receivedQty,
    };
  }
  return {
    state: 'quantity_mismatch',
    color: 'orange',
    requiredQty,
    receivedQty,
  };
}

export function getStoredSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_APP_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_APP_SETTINGS;
    return { ...DEFAULT_APP_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function saveStoredSettings(settings: AppSettings): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

export function getStoredDeliveries(): Delivery[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(DELIVERIES_KEY);
    if (!raw) {
      const initial = [generate200PartDelivery(), generate45PartDelivery(), generate15PartDelivery()];
      saveStoredDeliveries(initial);
      setActiveDeliveryId(initial[0].id);
      return initial;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map(normalizeDeliveryDocketNumbers);
    }
    const initial = [generate200PartDelivery(), generate45PartDelivery(), generate15PartDelivery()];
    saveStoredDeliveries(initial);
    setActiveDeliveryId(initial[0].id);
    return initial;
  } catch (e) {
    console.error('Failed to load deliveries from storage:', e);
    return [];
  }
}

let isSyncingCentralDb = false;

/**
 * Synchronises local deliveries with the centralised Cloudflare D1 / Worker backend.
 * Retains IndexedDB and localStorage as local cache.
 */
export async function syncDeliveriesFromCentralDatabase(): Promise<Delivery[]> {
  if (isSyncingCentralDb || typeof window === 'undefined') return getStoredDeliveries();
  isSyncingCentralDb = true;
  try {
    const health = await checkBackendConnection();
    if (!health.connected) {
      return getStoredDeliveries();
    }

    const centralList = await apiFetchDeliveries();
    if (Array.isArray(centralList) && centralList.length > 0) {
      const normalizedList = centralList.map(normalizeDeliveryDocketNumbers);
      saveStoredDeliveries(normalizedList);
      const activeId = getActiveDeliveryId();
      if (!activeId || !normalizedList.some((d) => d.id === activeId)) {
        setActiveDeliveryId(normalizedList[0].id);
      }
      return normalizedList;
    } else {
      // If the central database is freshly provisioned and empty,
      // upload the local working deliveries into the central database.
      const locals = getStoredDeliveries();
      if (locals.length > 0) {
        await apiMigrateDeliveries(locals);
        const refreshed = await apiFetchDeliveries();
        if (refreshed.length > 0) {
          const normalizedRefreshed = refreshed.map(normalizeDeliveryDocketNumbers);
          saveStoredDeliveries(normalizedRefreshed);
          return normalizedRefreshed;
        }
      }
    }
    return getStoredDeliveries();

  } catch (err) {
    console.warn('Central database sync notice:', err);
    return getStoredDeliveries();
  } finally {
    isSyncingCentralDb = false;
  }
}


/**
 * Ensures every part in a stored delivery has its clean Docket "No" (1, 2, 3...)
 * in itemNumber & docketLineIndex, repairing any legacy "ITM-003-1", "3-1", or "BC-9001" values.
 */
function normalizeDeliveryDocketNumbers(delivery: Delivery): Delivery {
  if (!delivery) return delivery;
  if (!Array.isArray(delivery.parts)) {
    return { ...delivery, parts: [] };
  }


  let currentDocketRowNo = 0;
  let lastGroupKey = '';

  const normalizedParts = delivery.parts.map((part, idx) => {
    const rawItem = (part.itemNumber || '').trim();
    const isExpandedPiece = /\(Piece\s+\d+\s+of\s+\d+\)/i.test(part.description || '');
    const baseDesc = (part.description || '').replace(/\s*\(Piece\s+\d+\s+of\s+\d+\)/i, '').trim();
    const groupKey = `${part.partNumber}__${baseDesc}`;

    if (!isExpandedPiece || groupKey !== lastGroupKey || currentDocketRowNo === 0) {
      currentDocketRowNo++;
      lastGroupKey = groupKey;
    }

    let cleanNoStr = '';

    // Case 1: Legacy "ITM-003-1" or "ITM-003" or "LINE-03" (not 8000+ sample IDs)
    const itmPrefixMatch = rawItem.match(
      /^(?:ITM|ITEM|LINE|POS|NO\.?)\s*[-:]?\s*0*(\d+)(?:-\d+)?$/i
    );
    if (itmPrefixMatch) {
      const n = parseInt(itmPrefixMatch[1], 10);
      if (!Number.isNaN(n) && n > 0 && n < 8000) {
        cleanNoStr = String(n);
      }
    }

    // Case 2: Legacy expanded "3-1" where description has "(Piece X of Y)"
    if (!cleanNoStr && isExpandedPiece) {
      const pieceSuffixMatch = rawItem.match(/^0*(\d+)-\d+$/);
      if (pieceSuffixMatch) {
        cleanNoStr = String(parseInt(pieceSuffixMatch[1], 10));
      }
    }

    // Case 3: Already a clean integer "1", "2", "03"
    if (!cleanNoStr && /^\d+$/.test(rawItem)) {
      const n = parseInt(rawItem, 10);
      if (!Number.isNaN(n) && n > 0 && n < 8000) {
        cleanNoStr = String(n);
      }
    }

    // Case 4: Full "######-No" stored in itemNumber (e.g. "123456-03")
    if (!cleanNoStr) {
      const fullBarcodeMatch = rawItem.match(/^\d{3,10}\s*[-–—]\s*0*(\d+)$/);
      if (fullBarcodeMatch) {
        cleanNoStr = String(parseInt(fullBarcodeMatch[1], 10));
      }
    }

    // Fallback to docket row number
    if (!cleanNoStr) {
      cleanNoStr = String(currentDocketRowNo || part.docketLineIndex || idx + 1);
    }

    const numericNo = parseInt(cleanNoStr, 10) || currentDocketRowNo || idx + 1;

    if (part.itemNumber === cleanNoStr && part.docketLineIndex === numericNo) {
      return part;
    }

    return {
      ...part,
      itemNumber: cleanNoStr,
      docketLineIndex: numericNo,
    };
  });

  return {
    ...delivery,
    parts: normalizedParts,
  };
}

export function clearAllDeliveries(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(DELIVERIES_KEY);
    localStorage.removeItem(ACTIVE_DELIVERY_KEY);
    localStorage.setItem(DELIVERIES_KEY, JSON.stringify([]));
    clearAllIndexedDb().catch(console.error);
    window.dispatchEvent(new CustomEvent('parttrack_deliveries_updated'));
    window.dispatchEvent(new CustomEvent('parttrack_active_delivery_changed', { detail: null }));
  } catch (e) {
    console.error('Failed to clear deliveries:', e);
  }
}

export function saveStoredDeliveries(deliveries: Delivery[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(DELIVERIES_KEY, JSON.stringify(deliveries));
  } catch (quotaErr) {
    // If multi-page docket photo attachments exceed the 5MB localStorage quota,
    // keep the first page's preview or strip dataUrl in localStorage (full images remain in IndexedDB)
    try {
      const lightweight = deliveries.map((d, idx) => ({
        ...d,
        docketAttachments: (d.docketAttachments || []).map((att, attIdx) => ({
          ...att,
          dataUrl: idx === 0 && attIdx === 0 ? att.dataUrl : undefined,
        })),
      }));
      localStorage.setItem(DELIVERIES_KEY, JSON.stringify(lightweight));
    } catch {
      try {
        const ultraLight = deliveries.map((d) => ({
          ...d,
          docketAttachments: (d.docketAttachments || []).map((att) => ({
            ...att,
            dataUrl: undefined,
          })),
        }));
        localStorage.setItem(DELIVERIES_KEY, JSON.stringify(ultraLight));
      } catch (e) {
        console.error('Failed to save deliveries to storage:', e);
      }
    }
  }
  try {
    deliveries.forEach((d) => saveDeliveryToIndexedDb(d).catch(console.error));
    window.dispatchEvent(new CustomEvent('parttrack_deliveries_updated'));
  } catch (e) {
    console.error('Failed to dispatch delivery update:', e);
  }
}

export function getActiveDeliveryId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(ACTIVE_DELIVERY_KEY);
  } catch {
    return null;
  }
}

export function setActiveDeliveryId(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(ACTIVE_DELIVERY_KEY, id);
    window.dispatchEvent(new CustomEvent('parttrack_active_delivery_changed', { detail: id }));
  } catch {}
}

export function getActiveDelivery(): Delivery | null {
  const deliveries = getStoredDeliveries();
  const activeId = getActiveDeliveryId();
  if (activeId) {
    const found = deliveries.find((d) => d.id === activeId);
    if (found) return found;
  }
  return deliveries[0] || null;
}

export function updateDelivery(updated: Delivery): void {
  const deliveries = getStoredDeliveries();
  const index = deliveries.findIndex((d) => d.id === updated.id);
  const now = new Date().toISOString();
  const withUpdatedTimestamp = { ...updated, updatedAt: now };

  if (index >= 0) {
    deliveries[index] = withUpdatedTimestamp;
  } else {
    deliveries.unshift(withUpdatedTimestamp);
  }

  saveStoredDeliveries(deliveries);
  saveDeliveryToIndexedDb(withUpdatedTimestamp).catch(console.error);

  // Sync to central database
  if (typeof window !== 'undefined') {
    if (index >= 0) {
      apiUpdateDelivery(updated.id, {
        status: updated.status,
        carrier: updated.carrier,
        notes: updated.notes,
        docketNumber: updated.docketNumber,
        supplier: updated.supplier,
      }).catch((err) => {

        console.warn('Central database update sync notice:', err?.message || err);
      });
    } else {
      apiCreateDelivery(withUpdatedTimestamp).catch((err) => {
        console.warn('Central database create sync notice:', err?.message || err);
      });
    }
  }
}


export function deleteDelivery(id: string): void {
  const deliveries = getStoredDeliveries();
  const filtered = deliveries.filter((d) => d.id !== id);
  saveStoredDeliveries(filtered);
  deleteDeliveryFromIndexedDb(id).catch(console.error);

  if (getActiveDeliveryId() === id) {
    if (filtered.length > 0) {
      setActiveDeliveryId(filtered[0].id);
    } else {
      localStorage.removeItem(ACTIVE_DELIVERY_KEY);
    }
  }
}

/**
 * Stores full-resolution photographed docket page images into IndexedDB
 */
export async function saveDocketImages(
  deliveryId: string,
  images: Array<{ pageNumber: number; dataUrl: string; name?: string }>
): Promise<void> {
  for (const img of images) {
    await saveDocketImageToIndexedDb({
      id: `img_${deliveryId}_p${img.pageNumber}`,
      deliveryId,
      pageNumber: img.pageNumber,
      dataUrl: img.dataUrl,
      name: img.name || `Docket Page ${img.pageNumber}`,
      size: Math.round(img.dataUrl.length * 0.75),
      mimeType: 'image/jpeg',
      createdAt: new Date().toISOString(),
    });
  }
}

/**
 * Marks an individual part as received or outstanding (with optional receivedQuantity)
 */
export function setPartStatus(
  deliveryId: string,
  partId: string,
  status: 'received' | 'outstanding',
  method: 'qr' | 'barcode' | 'manual' = 'manual',
  scannedCode?: string,
  customReceivedQuantity?: number
): Delivery | null {
  const deliveries = getStoredDeliveries();
  const delivery = deliveries.find((d) => d.id === deliveryId);
  if (!delivery) return null;

  const partIndex = delivery.parts.findIndex((p) => p.id === partId);
  if (partIndex === -1) return null;

  const part = delivery.parts[partIndex];
  if (status === 'received' && !isBackendOnline()) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('parttrack_connection_required'));
    }
    return null;
  }

  const now = new Date().toISOString();

  const requiredQty = Math.max(1, part.quantity ?? 1);
  const resolvedReceivedQty =
    status === 'received'
      ? customReceivedQuantity !== undefined
        ? customReceivedQuantity
        : requiredQty
      : undefined;
  const isQtyMatch = status === 'received' && resolvedReceivedQty === requiredQty;

  const previousStatus = part.status;
  const previousReceivedQuantity =
    part.status === 'received'
      ? typeof part.receivedQuantity === 'number'
        ? part.receivedQuantity
        : requiredQty
      : 0;

  const updatedPart: DeliveryPart = {
    ...part,
    status,
    receivedQuantity: resolvedReceivedQty,
    verificationStatus:
      status === 'received'
        ? isQtyMatch
          ? 'verified'
          : 'quantity_mismatch'
        : 'unscanned',
    scannedAt: status === 'received' ? now : undefined,
    scannedVia: status === 'received' ? method : undefined,
    scannedCode: status === 'received' ? scannedCode || part.scannedCode : undefined,
  };

  const newParts = [...delivery.parts];
  newParts[partIndex] = updatedPart;

  const scanEvent: ScanEvent = {
    id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: now,
    code: scannedCode || (method === 'qr' ? part.partNumber : part.itemNumber),
    codeType: method,
    status:
      status === 'received'
        ? !isQtyMatch
          ? 'quantity_mismatch'
          : method === 'manual'
          ? 'manual_ticked'
          : 'match_success'
        : 'undo_performed',
    partId: part.id,
    partNumber: part.partNumber,
    itemNumber: part.itemNumber,
    requiredQuantity: requiredQty,
    receivedQuantity: resolvedReceivedQty,
    previousReceivedQuantity,
    previousStatus,
    message:
      status === 'received'
        ? isQtyMatch
          ? `Marked ${part.partNumber} (No. ${part.itemNumber}, Qty ${resolvedReceivedQty}/${requiredQty}) as received via ${method.toUpperCase()}`
          : `Quantity mismatch for ${part.partNumber} (No. ${part.itemNumber}): Received ${resolvedReceivedQty} of ${requiredQty} required`
        : `Unticked ${part.partNumber} (${part.itemNumber})`,
  };

  const updatedDelivery: Delivery = {
    ...delivery,
    parts: newParts,
    scanHistory: [scanEvent, ...delivery.scanHistory].slice(0, 300), // Keep last 300 logs
    updatedAt: now,
  };

  updateDelivery(updatedDelivery);

  // Sync receiving transaction to central database
  if (typeof window !== 'undefined') {
    apiReceivePart(deliveryId, partId, {
      receivedQuantity: resolvedReceivedQty || 0,
      status,
      scannedVia: method,
      scannedCode,
    }).catch((err) => {
      console.warn('Central database receive sync notice:', err?.message || err);
    });
  }

  return updatedDelivery;
}


/**
 * Confirms the user-entered quantity for a scanned part whose required quantity > 1.
 * Compares enteredQuantity against requiredQuantity:
 * - Correct quantity = green ('verified')
 * - Incorrect quantity = orange ('quantity_mismatch')
 */
export function confirmScannedPartQuantity(
  delivery: Delivery,
  pending: PendingQuantityConfirmation,
  enteredQuantity: number
): {
  updatedDelivery: Delivery;
  updatedPart: DeliveryPart;
  isCorrectQuantity: boolean;
  requiredQuantity: number;
  receivedQuantity: number;
} {
  const requiredQuantity = Math.max(1, pending.part.quantity ?? 1);
  const receivedQuantity = Math.max(0, Math.round(enteredQuantity));

  if (!isBackendOnline()) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('parttrack_connection_required'));
    }
    return {
      updatedDelivery: delivery,
      updatedPart: pending.part,
      isCorrectQuantity: false,
      requiredQuantity,
      receivedQuantity: pending.part.receivedQuantity ?? 0,
    };
  }

  const isCorrectQuantity = receivedQuantity === requiredQuantity;

  const previousStatus = pending.part.status;
  const previousReceivedQuantity =
    pending.part.status === 'received'
      ? typeof pending.part.receivedQuantity === 'number'
        ? pending.part.receivedQuantity
        : requiredQuantity
      : 0;

  const now = new Date().toISOString();

  const updatedPart: DeliveryPart = {
    ...pending.part,
    status: 'received',
    receivedQuantity,
    verificationStatus: isCorrectQuantity ? 'verified' : 'quantity_mismatch',
    scannedAt: now,
    scannedVia: pending.detectedType,
    scannedCode: pending.code,
  };

  const newParts = delivery.parts.map((p) => (p.id === pending.part.id ? updatedPart : p));
  const docketNoLabel = pending.part.itemNumber.replace(/^ITM-0*/i, '');

  const scanEvent: ScanEvent = {
    id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: now,
    code: pending.code,
    codeType: pending.detectedType,
    status: isCorrectQuantity ? 'match_success' : 'quantity_mismatch',
    partId: pending.part.id,
    partNumber: pending.part.partNumber,
    itemNumber: pending.part.itemNumber,
    requiredQuantity,
    receivedQuantity,
    addedQuantity: receivedQuantity,
    previousReceivedQuantity,
    previousStatus,
    message: isCorrectQuantity
      ? `Verified ${pending.part.partNumber} [No. ${docketNoLabel}] — Qty ${receivedQuantity}/${requiredQuantity} matched`
      : `Qty Mismatch ${pending.part.partNumber} [No. ${docketNoLabel}] — Scanned ${receivedQuantity} of ${requiredQuantity} required`,
  };

  const updatedDelivery: Delivery = {
    ...delivery,
    parts: newParts,
    scanHistory: [scanEvent, ...delivery.scanHistory].slice(0, 300),
    updatedAt: now,
  };

  updateDelivery(updatedDelivery);

  // Sync to central database
  if (typeof window !== 'undefined') {
    apiReceivePart(delivery.id, pending.part.id, {
      receivedQuantity,
      scannedVia: pending.detectedType,
      scannedCode: pending.code,
    }).catch((err) => {
      console.warn('Central database quantity sync notice:', err?.message || err);
    });
  }

  return {
    updatedDelivery,

    updatedPart,
    isCorrectQuantity,
    requiredQuantity,
    receivedQuantity,
  };
}

/**
 * Checks scan history for any previously confirmed pallet label scans with the same
 * part number and quantity (or identical raw OCR text) to warn the operator before confirming.
 * Separate pallets can legitimately have identical labels, so this returns a warning list
 * rather than blocking the scan.
 */
export function findPreviousIdenticalLabelScans(
  delivery: Delivery | null | undefined,
  partNumber: string,
  palletQuantity: number
): ScanEvent[] {
  if (!delivery || !partNumber.trim()) return [];
  const normPart = partNumber.trim().toUpperCase().replace(/\s*-\s*/g, '-');
  return delivery.scanHistory.filter((ev) => {
    if (ev.status === 'undo_performed') return false;
    const evPart = (ev.partNumber || ev.code || '').trim().toUpperCase().replace(/\s*-\s*/g, '-');
    if (evPart !== normPart) return false;
    if (ev.codeType === 'ocr_label') {
      return ev.addedQuantity === palletQuantity || ev.receivedQuantity === palletQuantity;
    }
    return true;
  });
}

/**
 * Confirms an OCR Pallet Label scan against a matched part on the compiled parts list.
 * Adds the confirmed pallet quantity to the existing scanned quantity for that part
 * (e.g., Expected: 48, Pallet 1: 24 -> 24/48, Pallet 2: 24 -> 48/48).
 * Never overwrites previously scanned quantities.
 */
export function confirmOcrPalletLabelScan(
  delivery: Delivery,
  params: {
    part: DeliveryPart;
    recognizedPartNumber: string;
    recognizedDescription: string;
    palletQuantity: number;
    rawOcrText: string;
  }
): {
  updatedDelivery: Delivery;
  updatedPart: DeliveryPart;
  isExactQuantityMatch: boolean;
  existingScannedQty: number;
  addedPalletQty: number;
  newTotalScannedQty: number;
  expectedQty: number;
} {
  const now = new Date().toISOString();
  const targetPart =
    delivery.parts.find((p) => p.id === params.part.id) || params.part;

  const expectedQty = Math.max(1, targetPart.quantity ?? 1);
  const existingScannedQty =
    targetPart.status === 'received'
      ? typeof targetPart.receivedQuantity === 'number'
        ? targetPart.receivedQuantity
        : expectedQty
      : 0;
  const addedPalletQty = Math.max(1, Math.round(params.palletQuantity));
  const newTotalScannedQty = existingScannedQty + addedPalletQty;
  const isExactQuantityMatch = newTotalScannedQty === expectedQty;

  const updatedPart: DeliveryPart = {
    ...targetPart,
    status: 'received',
    receivedQuantity: newTotalScannedQty,
    verificationStatus: isExactQuantityMatch ? 'verified' : 'quantity_mismatch',
    scannedAt: now,
    scannedVia: 'ocr_label',
    scannedCode: params.recognizedPartNumber.trim(),
  };

  const newParts = delivery.parts.map((p) =>
    p.id === targetPart.id ? updatedPart : p
  );

  const docketNoLabel = targetPart.itemNumber.replace(/^ITM-0*/i, '');
  const cumulativeNote =
    existingScannedQty > 0
      ? `Pallet +${addedPalletQty} added to prior ${existingScannedQty} → Total ${newTotalScannedQty}/${expectedQty}`
      : `Pallet Qty ${addedPalletQty} → Total ${newTotalScannedQty}/${expectedQty}`;

  const scanEvent: ScanEvent = {
    id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: now,
    code: params.recognizedPartNumber.trim(),
    codeType: 'ocr_label',
    status: isExactQuantityMatch ? 'match_success' : 'quantity_mismatch',
    partId: targetPart.id,
    partNumber: targetPart.partNumber,
    itemNumber: targetPart.itemNumber,
    recognizedDescription: params.recognizedDescription.trim(),
    requiredQuantity: expectedQty,
    receivedQuantity: newTotalScannedQty,
    addedQuantity: addedPalletQty,
    previousReceivedQuantity: existingScannedQty,
    previousStatus: targetPart.status,
    rawOcrText: params.rawOcrText,
    message: isExactQuantityMatch
      ? `OCR Label Verified ${targetPart.partNumber} [No. ${docketNoLabel}] · ${cumulativeNote}`
      : `OCR Label Partial/Mismatch ${targetPart.partNumber} [No. ${docketNoLabel}] · ${cumulativeNote}`,
  };

  const updatedDelivery: Delivery = {
    ...delivery,
    parts: newParts,
    scanHistory: [scanEvent, ...delivery.scanHistory].slice(0, 300),
    updatedAt: now,
  };

  updateDelivery(updatedDelivery);

  return {
    updatedDelivery,
    updatedPart,
    isExactQuantityMatch,
    existingScannedQty,
    addedPalletQty,
    newTotalScannedQty,
    expectedQty,
  };
}

/**
 * Records an unmatched OCR Pallet Label scan as an Unexpected Part (Red indicator)
 * while preserving the recognized part number, description, quantity, and raw OCR text.
 */
export function recordUnmatchedOcrPalletLabel(
  delivery: Delivery,
  params: {
    recognizedPartNumber: string;
    recognizedDescription: string;
    palletQuantity: number;
    rawOcrText: string;
  }
): Delivery {
  const now = new Date().toISOString();
  const code = params.recognizedPartNumber.trim().toUpperCase() || 'UNKNOWN-LABEL';

  const unexpectedPart: UnexpectedPart = {
    id: `unexp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    code,
    codeType: 'ocr_label',
    scannedAt: now,
    recognizedDescription: params.recognizedDescription.trim(),
    recognizedQuantity: params.palletQuantity,
    rawOcrText: params.rawOcrText,
    notes: `OCR Pallet Label: Part "${code}" (${
      params.recognizedDescription.trim() || 'No description'
    }, Qty: ${params.palletQuantity}) — not found on compiled parts list`,
    resolved: false,
  };

  const scanEvent: ScanEvent = {
    id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: now,
    code,
    codeType: 'ocr_label',
    status: 'unexpected_warning',
    partNumber: code,
    recognizedDescription: params.recognizedDescription.trim(),
    receivedQuantity: params.palletQuantity,
    addedQuantity: params.palletQuantity,
    rawOcrText: params.rawOcrText,
    message: `Unmatched OCR Pallet Label: "${code}" (Qty ${params.palletQuantity}) not on docket`,
  };

  const updatedDelivery: Delivery = {
    ...delivery,
    unexpectedParts: [unexpectedPart, ...delivery.unexpectedParts],
    scanHistory: [scanEvent, ...delivery.scanHistory].slice(0, 300),
    updatedAt: now,
  };

  updateDelivery(updatedDelivery);
  return updatedDelivery;
}

/**
 * Handles incoming scanned code (from camera or manual code entry)
 * Matches QR codes against Part Numbers, Barcodes against Item Numbers, or either interchangeably!
 */
export interface ProcessScanResult {
  status: 'matched' | 'requires_quantity' | 'duplicate' | 'unexpected';
  part?: DeliveryPart;
  message: string;
  code: string;
  detectedType: ScanMethod;
  pendingQuantityConfirmation?: PendingQuantityConfirmation;
}

/**
 * Parses a scanned barcode of the form "######-<No>" (e.g. "123456-1", "482910-03", "654321-12", "LC-482910-3")
 * where the leading order/docket number is ignored and the numbers after the "-" are the sequential item number
 * in the "No" section of the delivery docket.
 */
export function parseBarcodeDocketNo(rawCode: string): {
  hasDashFormat: boolean;
  prefix: string;
  rawAfterDash: string;
  numericNo: number | null;
} {
  // Strip whitespace and any Code-39 leading/trailing '*' characters
  const trimmed = rawCode
    .trim()
    .replace(/^\*+|\*+$/g, '')
    .trim()
    .toUpperCase();

  // 1. Legacy explicit item prefix format: "ITM-003-1", "ITM-003", "ITEM-3", "NO-03", "LINE-3"
  const explicitPrefixMatch = trimmed.match(
    /^(NO\.?|ITM|ITEM|LINE|POS|BC|BAR)\s*[-–—:]\s*0*(\d+)(?:\s*[-/]\s*\d+)?$/i
  );
  if (explicitPrefixMatch) {
    const prefix = explicitPrefixMatch[1].trim();
    const afterDashDigits = explicitPrefixMatch[2];
    const numericNo = parseInt(afterDashDigits, 10);
    return {
      hasDashFormat: true,
      prefix,
      rawAfterDash: afterDashDigits,
      numericNo: Number.isNaN(numericNo) ? null : numericNo,
    };
  }

  // 2. Primary Laser Central long barcode pattern: "<OrderNumber>-<SequentialItemNo>"
  // Supports e.g. "482910-1", "482910-03", "12345678-14", "LC-482910-3", "SO-123456-005"
  // Extracts the trailing sequential item number after the last "-" while ignoring the order number prefix.
  const lastDashMatch = trimmed.match(/^([A-Z0-9._/\-\s]+?)\s*[-–—]\s*0*(\d{1,4})$/);
  if (lastDashMatch) {
    const prefix = lastDashMatch[1].trim();
    const afterDashDigits = lastDashMatch[2];
    const numericNo = parseInt(afterDashDigits, 10);
    const digitCountInPrefix = (prefix.match(/\d/g) || []).length;
    // Order number prefix in Laser Central barcodes contains digits (e.g. "482910", "12345", "LC-482910")
    if (digitCountInPrefix >= 2 && !Number.isNaN(numericNo) && numericNo > 0) {
      return {
        hasDashFormat: true,
        prefix,
        rawAfterDash: afterDashDigits,
        numericNo,
      };
    }
  }

  // 3. Fallback if barcode contains "######-<No>" embedded inside a longer string
  const embeddedMatch = trimmed.match(/(\d{3,12})\s*[-–—]\s*0*(\d{1,4})\b/);
  if (embeddedMatch) {
    const prefix = embeddedMatch[1];
    const afterDashDigits = embeddedMatch[2];
    const numericNo = parseInt(afterDashDigits, 10);
    return {
      hasDashFormat: true,
      prefix,
      rawAfterDash: afterDashDigits,
      numericNo: Number.isNaN(numericNo) ? null : numericNo,
    };
  }

  // 4. Also support entering/scanning a pure docket "No" directly (e.g. "1", "01", "12")
  if (/^\d{1,4}$/.test(trimmed)) {
    const numericNo = parseInt(trimmed, 10);
    return {
      hasDashFormat: false,
      prefix: '',
      rawAfterDash: trimmed,
      numericNo: Number.isNaN(numericNo) ? null : numericNo,
    };
  }

  return {
    hasDashFormat: false,
    prefix: '',
    rawAfterDash: '',
    numericNo: null,
  };
}

/**
 * Extracts the numeric "No" from a delivery docket part's "No" section (itemNumber / docketLineIndex).
 * E.g. itemNumber "1", "01", "No. 1", "ITM-001", "ITM-001-1", "123456-01" -> 1
 */
export function getPartDocketNumericNo(part: DeliveryPart): number | null {
  const rawItem = String(part.itemNumber ?? '').trim().toUpperCase();
  const isExpandedPiece = /\(Piece\s+\d+\s+of\s+\d+\)/i.test(part.description || '');

  if (rawItem) {
    // 1. Pure digits: "1", "01", "12"
    if (/^\d+$/.test(rawItem)) {
      const n = parseInt(rawItem, 10);
      if (!Number.isNaN(n) && n < 8000) return n;
    }

    // 2. Legacy "ITM-003-1" or "ITM-003" or "NO. 3"
    const prefixMatch = rawItem.match(
      /^(?:ITM|ITEM|LINE|POS|NO\.?|#)\s*[-:]?\s*0*(\d+)(?:-\d+)?$/i
    );
    if (prefixMatch) {
      const n = parseInt(prefixMatch[1], 10);
      if (!Number.isNaN(n) && n < 8000) return n;
    }

    // 3. Legacy expanded "3-1" where description has "(Piece X of Y)"
    if (isExpandedPiece) {
      const pieceMatch = rawItem.match(/^0*(\d+)-\d+$/);
      if (pieceMatch) {
        const n = parseInt(pieceMatch[1], 10);
        if (!Number.isNaN(n)) return n;
      }
    }

    // 4. Full "######-<No>" or "<Prefix>-######-<No>" stored in itemNumber (e.g. "123456-03", "LC-482910-03")
    const parsedFromItem = parseBarcodeDocketNo(rawItem);
    if (parsedFromItem && parsedFromItem.numericNo !== null) {
      return parsedFromItem.numericNo;
    }
  }

  return typeof part.docketLineIndex === 'number' && part.docketLineIndex > 0
    ? part.docketLineIndex
    : null;
}

/**
 * Normalizes part numbers for comparison (preserving leading zeros, hyphens, and alphanumeric chars)
 */
function normalizePartCodeForMatch(raw: string): string {
  return (raw || '')
    .trim()
    .toUpperCase()
    .replace(/[–—−]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ');
}

/**
 * Checks if a QR payload or scanned string matches a part's internal Part Number
 */
function doesPartNumberMatchQrPayload(part: DeliveryPart, normalizedInput: string): boolean {
  const partNumNorm = normalizePartCodeForMatch(part.partNumber);
  const inputNorm = normalizePartCodeForMatch(normalizedInput);
  if (!partNumNorm || !inputNorm) return false;

  if (partNumNorm === inputNorm) return true;

  // Support structured QR payloads (e.g. "PART: PLT-105\nQTY: 4" or JSON/CSV) containing the part number token
  if (partNumNorm.length >= 3 && inputNorm.includes(partNumNorm)) {
    const escaped = partNumNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tokenRegex = new RegExp(`(?:^|[^A-Z0-9-])${escaped}(?:$|[^A-Z0-9-])`, 'i');
    if (tokenRegex.test(inputNorm)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a part on the delivery docket matches the scanned code:
 * 1. If the barcode is "######-<No>", cross-references <No> (the numbers after the dash)
 *    against the part's sequential number in the "No" section of the docket.
 * 2. Also supports exact/QR match on internal partNumber or itemNumber.
 */
function doesPartMatchScannedCode(
  part: DeliveryPart,
  normalizedInput: string,
  parsedBarcode: ReturnType<typeof parseBarcodeDocketNo>,
  supplierRuleId: SupplierRuleId = 'laser_central'
): { matched: boolean; matchMode: 'exact-part' | 'docket-no' | 'exact-item' } {
  const itemNumUpper = part.itemNumber.trim().toUpperCase();

  // If GCI (QR code rule), check internal Part Number match first
  if (supplierRuleId === 'gci') {
    if (doesPartNumberMatchQrPayload(part, normalizedInput)) {
      return { matched: true, matchMode: 'exact-part' };
    }
  }

  // 1. Laser Central Primary: Long Barcode "######-<No>" extracting sequential item number <No>
  if (parsedBarcode.hasDashFormat && parsedBarcode.numericNo !== null) {
    const partDocketNo = getPartDocketNumericNo(part);
    if (partDocketNo !== null && partDocketNo === parsedBarcode.numericNo) {
      return { matched: true, matchMode: 'docket-no' };
    }
  }

  // 2. Exact / QR match on internal Part Number or Item Number
  if (doesPartNumberMatchQrPayload(part, normalizedInput)) {
    return { matched: true, matchMode: 'exact-part' };
  }
  if (itemNumUpper === normalizedInput || part.id.toUpperCase() === normalizedInput) {
    return { matched: true, matchMode: 'exact-item' };
  }

  // 3. Direct numeric Docket "No" match (e.g. entering "3" or "03" directly)
  if (parsedBarcode.numericNo !== null) {
    const partDocketNo = getPartDocketNumericNo(part);
    if (partDocketNo !== null && partDocketNo === parsedBarcode.numericNo) {
      return { matched: true, matchMode: 'docket-no' };
    }
  }

  return { matched: false, matchMode: 'exact-item' };
}

export function processScannedCode(
  delivery: Delivery,
  rawCode: string
): { updatedDelivery: Delivery; result: ProcessScanResult } {
  const cleaned = rawCode.trim().replace(/^\*+|\*+$/g, '').trim();
  const now = new Date().toISOString();
  const normalizedInput = cleaned.toUpperCase();
  const parsedBarcode = parseBarcodeDocketNo(cleaned);
  const supplierRule = getDeliverySupplierRule(delivery);

  let matchingOutstandingPart: DeliveryPart | undefined;
  let matchedMode: 'exact-part' | 'docket-no' | 'exact-item' =
    supplierRule.id === 'gci' ? 'exact-part' : 'docket-no';

  if (supplierRule.id === 'gci') {
    // GCI Supplier Rule: Prioritize QR Code -> internal Part Number matching
    for (const p of delivery.parts) {
      if (p.status !== 'outstanding') continue;
      if (doesPartNumberMatchQrPayload(p, normalizedInput)) {
        matchingOutstandingPart = p;
        matchedMode = 'exact-part';
        break;
      }
    }
  } else {
    // Laser Central (or OCR Label mode with live barcode/QR):
    // First check if the scanned code is an exact internal Part Number (e.g. QR code) when not a docket barcode
    if (!parsedBarcode.hasDashFormat) {
      for (const p of delivery.parts) {
        if (p.status !== 'outstanding') continue;
        if (doesPartNumberMatchQrPayload(p, normalizedInput)) {
          matchingOutstandingPart = p;
          matchedMode = 'exact-part';
          break;
        }
      }
    }

    // Laser Central Barcode "######-<No>" -> sequential Docket "No" matching (ignoring order number)
    if (!matchingOutstandingPart && parsedBarcode.hasDashFormat && parsedBarcode.numericNo !== null) {
      for (const p of delivery.parts) {
        if (p.status !== 'outstanding') continue;
        if (getPartDocketNumericNo(p) === parsedBarcode.numericNo) {
          matchingOutstandingPart = p;
          matchedMode = 'docket-no';
          break;
        }
      }
    }
  }

  // Fallback check across all supported matching modes so both Laser Central barcodes and GCI QR codes work seamlessly
  if (!matchingOutstandingPart) {
    for (const p of delivery.parts) {
      if (p.status !== 'outstanding') continue;
      const check = doesPartMatchScannedCode(
        p,
        normalizedInput,
        parsedBarcode,
        supplierRule.id
      );
      if (check.matched) {
        matchingOutstandingPart = p;
        matchedMode = check.matchMode;
        break;
      }
    }
  }

  // If found an outstanding match:
  if (matchingOutstandingPart) {
    const detectedType: 'qr' | 'barcode' =
      matchedMode === 'exact-part' ? 'qr' : 'barcode';

    const requiredQty = Math.max(1, matchingOutstandingPart.quantity ?? 1);

    // Mandatory Quantity Confirmation when required quantity > 1:
    // Do NOT mark received yet; pause scanner and require explicit quantity entry.
    if (requiredQty > 1) {
      const pendingConfirmation: PendingQuantityConfirmation = {
        part: matchingOutstandingPart,
        code: cleaned,
        detectedType,
        matchedMode,
      };
      return {
        updatedDelivery: delivery,
        result: {
          status: 'requires_quantity',
          part: matchingOutstandingPart,
          message: `Enter received quantity for ${matchingOutstandingPart.partNumber} (Required: ${requiredQty})`,
          code: cleaned,
          detectedType,
          pendingQuantityConfirmation: pendingConfirmation,
        },
      };
    }

    // For parts with required quantity of 1, retain quick-scan behaviour without popup
    const updatedPart: DeliveryPart = {
      ...matchingOutstandingPart,
      status: 'received',
      receivedQuantity: 1,
      verificationStatus: 'verified',
      scannedAt: now,
      scannedVia: detectedType,
      scannedCode: cleaned,
    };

    const newParts = delivery.parts.map((p) =>
      p.id === matchingOutstandingPart!.id ? updatedPart : p
    );

    const docketNoLabel = matchingOutstandingPart.itemNumber.replace(/^ITM-0*/i, '');

    const scanEvent: ScanEvent = {
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: now,
      code: cleaned,
      codeType: detectedType,
      status: 'match_success',
      partId: matchingOutstandingPart.id,
      partNumber: matchingOutstandingPart.partNumber,
      itemNumber: matchingOutstandingPart.itemNumber,
      requiredQuantity: 1,
      receivedQuantity: 1,
      message:
        matchedMode === 'docket-no'
          ? `Barcode ${cleaned} → Matched Docket No. ${docketNoLabel} (${matchingOutstandingPart.partNumber})`
          : `Matched ${matchingOutstandingPart.partNumber} [No. ${docketNoLabel}]`,
    };

    const updatedDelivery: Delivery = {
      ...delivery,
      parts: newParts,
      scanHistory: [scanEvent, ...delivery.scanHistory].slice(0, 300),
      updatedAt: now,
    };

    updateDelivery(updatedDelivery);

    return {
      updatedDelivery,
      result: {
        status: 'matched',
        part: updatedPart,
        message:
          matchedMode === 'docket-no'
            ? `Docket No. ${docketNoLabel} · ${matchingOutstandingPart.partNumber}`
            : `Received ${matchingOutstandingPart.partNumber} (No. ${docketNoLabel})`,
        code: cleaned,
        detectedType,
      },
    };
  }

  // 2. Check if this code belongs to an ALREADY RECEIVED part (Duplicate scan)
  // Do NOT allow duplicate scans to overwrite previously recorded quantities!
  const alreadyReceivedPart = delivery.parts.find((p) => {
    if (p.status !== 'received') return false;
    if (p.scannedCode?.toUpperCase() === normalizedInput) return true;
    return doesPartMatchScannedCode(p, normalizedInput, parsedBarcode).matched;
  });

  if (alreadyReceivedPart) {
    const detectedType: 'qr' | 'barcode' = parsedBarcode.hasDashFormat ? 'barcode' : 'qr';
    const docketNoLabel = alreadyReceivedPart.itemNumber.replace(/^ITM-0*/i, '');
    const reqQty = Math.max(1, alreadyReceivedPart.quantity ?? 1);
    const recQty =
      typeof alreadyReceivedPart.receivedQuantity === 'number'
        ? alreadyReceivedPart.receivedQuantity
        : reqQty;

    // STRICT DUPLICATE PREVENTION:
    // Do not increment quantities, create another scan record or modify delivery totals.
    return {
      updatedDelivery: delivery,
      result: {
        status: 'duplicate',
        part: alreadyReceivedPart,
        message: 'This part has already been scanned into this delivery.',
        code: cleaned,
        detectedType,
      },
    };
  }

  // 3. Part is NOT on the delivery docket -> UNEXPECTED PART
  const unexpectedNote =
    parsedBarcode.hasDashFormat && parsedBarcode.numericNo !== null
      ? `Scanned barcode "${cleaned}" (Docket No. ${parsedBarcode.numericNo}) — no matching "No. ${parsedBarcode.numericNo}" on docket`
      : 'Scanned in workshop - no match found on delivery docket';

  const unexpectedPart: UnexpectedPart = {
    id: `unexp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    code: cleaned,
    codeType:
      parsedBarcode.hasDashFormat ||
      /^[0-9]+$/.test(cleaned) ||
      cleaned.startsWith('BC-') ||
      cleaned.startsWith('ITM-')
        ? 'barcode'
        : 'qr',
    scannedAt: now,
    notes: unexpectedNote,
    resolved: false,
  };

  const scanEvent: ScanEvent = {
    id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: now,
    code: cleaned,
    codeType: unexpectedPart.codeType,
    status: 'unexpected_warning',
    message:
      parsedBarcode.hasDashFormat && parsedBarcode.numericNo !== null
        ? `Unexpected barcode "${cleaned}": Docket No. ${parsedBarcode.numericNo} does not exist on this docket`
        : `Unexpected part: Code "${cleaned}" does not exist on this delivery docket`,
  };

  const updatedDelivery: Delivery = {
    ...delivery,
    unexpectedParts: [unexpectedPart, ...delivery.unexpectedParts],
    scanHistory: [scanEvent, ...delivery.scanHistory].slice(0, 300),
    updatedAt: now,
  };

  updateDelivery(updatedDelivery);

  return {
    updatedDelivery,
    result: {
      status: 'unexpected',
      message:
        parsedBarcode.hasDashFormat && parsedBarcode.numericNo !== null
          ? `No. ${parsedBarcode.numericNo} (from ${cleaned}) not found on docket!`
          : `Unexpected part! Code "${cleaned}" not on docket.`,
      code: cleaned,
      detectedType: unexpectedPart.codeType,
    },
  };
}

/**
 * Undoes the last confirmed scan event (supports single-pallet scans and cumulative multi-pallet OCR scans)
 */
export function undoLastScan(delivery: Delivery): Delivery {
  const lastSuccessIdx = delivery.scanHistory.findIndex(
    (ev) =>
      (ev.status === 'match_success' ||
        ev.status === 'quantity_mismatch' ||
        ev.status === 'manual_ticked') &&
      ev.partId
  );

  if (lastSuccessIdx === -1) {
    return delivery;
  }

  const lastScan = delivery.scanHistory[lastSuccessIdx];
  if (!lastScan.partId) return delivery;

  const partIndex = delivery.parts.findIndex((p) => p.id === lastScan.partId);
  if (partIndex === -1) return delivery;

  const part = delivery.parts[partIndex];
  const now = new Date().toISOString();
  const requiredQty = Math.max(1, part.quantity ?? 1);

  // If this scan added onto a previously received quantity (e.g. Pallet 2 of 2), restore the prior quantity
  const shouldRestorePreviousReceived =
    lastScan.previousStatus === 'received' &&
    typeof lastScan.previousReceivedQuantity === 'number' &&
    lastScan.previousReceivedQuantity > 0;

  const restoredPart: DeliveryPart = shouldRestorePreviousReceived
    ? {
        ...part,
        status: 'received',
        receivedQuantity: lastScan.previousReceivedQuantity,
        verificationStatus:
          lastScan.previousReceivedQuantity === requiredQty
            ? 'verified'
            : 'quantity_mismatch',
        scannedAt: now,
      }
    : {
        ...part,
        status: 'outstanding',
        receivedQuantity: undefined,
        verificationStatus: 'unscanned',
        scannedAt: undefined,
        scannedVia: undefined,
        scannedCode: undefined,
      };

  const newParts = [...delivery.parts];
  newParts[partIndex] = restoredPart;

  // Remove the undone scan event from active history and log an undo event
  const remainingHistory = delivery.scanHistory.filter((_, idx) => idx !== lastSuccessIdx);
  const undoEvent: ScanEvent = {
    id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: now,
    code: lastScan.code,
    codeType: lastScan.codeType,
    status: 'undo_performed',
    partId: part.id,
    partNumber: part.partNumber,
    itemNumber: part.itemNumber,
    requiredQuantity: requiredQty,
    receivedQuantity: shouldRestorePreviousReceived
      ? lastScan.previousReceivedQuantity
      : 0,
    message: shouldRestorePreviousReceived
      ? `Undid scan (+${lastScan.addedQuantity || 0}) on ${part.partNumber} · Restored Qty ${lastScan.previousReceivedQuantity}/${requiredQty}`
      : `Undid scan on ${part.partNumber} (${part.itemNumber}) · Reverted to outstanding`,
  };

  const updatedDelivery: Delivery = {
    ...delivery,
    parts: newParts,
    scanHistory: [undoEvent, ...remainingHistory].slice(0, 300),
    updatedAt: now,
  };

  updateDelivery(updatedDelivery);
  return updatedDelivery;
}

// ============================================================================
// MANUAL PARTS LIST EDITING, ADDING & DELETION (With Audit History & D1 Sync)
// ============================================================================

function getActiveActorInfo(): { id: string; name: string; role: string } {
  const user = getStoredUser();
  if (user) {
    return {
      id: user.id,
      name: `${user.employeeName} (${user.employeeCode})`,
      role: user.role,
    };
  }
  return {
    id: 'usr_receiver_default',
    name: 'Workshop Operator',
    role: 'supervisor',
  };
}

/**
 * Adds a new part row to an existing delivery's parts list in localStorage, IndexedDB, and Cloudflare D1,
 * recording a full audit trail entry.
 */
export function addPartToDelivery(
  deliveryId: string,
  input: {
    partNumber: string;
    itemNumber?: string;
    description?: string;
    revision?: string;
    quantity?: number;
    material?: string;
    thickness?: string;
    dimensions?: string;
    weight?: string;
    palletNumber?: string;
    notes?: string;
  }
): Delivery | null {
  const deliveries = getStoredDeliveries();
  const deliveryIdx = deliveries.findIndex((d) => d.id === deliveryId);
  if (deliveryIdx === -1) return null;

  const delivery = deliveries[deliveryIdx];
  const cleanPartNumber = String(input.partNumber || '')
    .trim()
    .toUpperCase();
  if (!cleanPartNumber) {
    throw new Error('Part Number is required when adding a part.');
  }

  const rawQty = input.quantity === undefined || input.quantity === null ? 1 : Number(input.quantity);
  if (Number.isNaN(rawQty) || rawQty < 1) {
    throw new Error('Quantity must be at least 1.');
  }
  const reqQty = Math.max(1, Math.round(rawQty));

  const maxLineIdx = delivery.parts.reduce(
    (max, p, idx) => Math.max(max, p.docketLineIndex || idx + 1),
    0
  );
  const maxNumericNo = delivery.parts.reduce((max, p) => {
    const n = parseInt(String(p.itemNumber || '').replace(/\D+/g, ''), 10);
    return Number.isNaN(n) ? max : Math.max(max, n);
  }, 0);

  const nextLineIndex = maxLineIdx + 1;
  const cleanItemNo =
    String(input.itemNumber || '').trim() || String(Math.max(nextLineIndex, maxNumericNo + 1));
  const cleanDescription = String(input.description || '').trim() || `Part ${cleanPartNumber}`;
  const cleanRevision = input.revision ? String(input.revision).trim() : undefined;
  const now = new Date().toISOString();
  const actor = getActiveActorInfo();
  const newPartId = `part_${deliveryId}_manual_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const newPart: DeliveryPart = {
    id: newPartId,
    partNumber: cleanPartNumber,
    itemNumber: cleanItemNo,
    docketLineIndex: nextLineIndex,
    description: cleanDescription,
    revision: cleanRevision,
    quantity: reqQty,
    verificationStatus: 'unscanned',
    status: 'outstanding',
    material: input.material ? String(input.material).trim() : undefined,
    thickness: input.thickness ? String(input.thickness).trim() : undefined,
    dimensions: input.dimensions ? String(input.dimensions).trim() : undefined,
    weight: input.weight ? String(input.weight).trim() : undefined,
    palletNumber: input.palletNumber ? String(input.palletNumber).trim() : undefined,
    notes: input.notes ? String(input.notes).trim() : undefined,
    manuallyEdited: true,
    lastEditedBy: actor.name,
    lastEditedAt: now,
    editHistory: [
      {
        id: `aud_${Date.now()}`,
        timestamp: now,
        action: 'added',
        editedBy: actor.name,
        editedByRole: actor.role,
        summary: `Added part ${cleanPartNumber} (No. ${cleanItemNo}${
          cleanRevision ? `, Rev ${cleanRevision}` : ''
        }, Qty ${reqQty})`,
      },
    ],
  };

  const scanEvent: ScanEvent = {
    id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: now,
    code: cleanPartNumber,
    codeType: 'manual',
    status: 'part_added',
    partId: newPart.id,
    partNumber: cleanPartNumber,
    itemNumber: cleanItemNo,
    requiredQuantity: reqQty,
    receivedQuantity: 0,
    message: `Added part ${cleanPartNumber} (No. ${cleanItemNo}${
      cleanRevision ? `, Rev ${cleanRevision}` : ''
    }) — "${cleanDescription}" (Qty ${reqQty}) by ${actor.name}`,
  };

  const updatedDelivery: Delivery = {
    ...delivery,
    parts: [...delivery.parts, newPart],
    scanHistory: [scanEvent, ...(delivery.scanHistory || [])].slice(0, 300),
    updatedAt: now,
  };

  deliveries[deliveryIdx] = updatedDelivery;
  saveStoredDeliveries(deliveries);
  saveDeliveryToIndexedDb(updatedDelivery).catch(console.error);

  if (typeof window !== 'undefined') {
    apiAddDeliveryPart(deliveryId, {
      id: newPart.id,
      partNumber: cleanPartNumber,
      itemNumber: cleanItemNo,
      description: cleanDescription,
      revision: cleanRevision,
      quantity: reqQty,
      material: newPart.material,
      thickness: newPart.thickness,
      dimensions: newPart.dimensions,
      weight: newPart.weight,
      palletNumber: newPart.palletNumber,
      notes: newPart.notes,
    }).catch((err) => {
      console.warn('Central database addPart sync notice:', err?.message || err);
    });
  }

  return updatedDelivery;
}

/**
 * Edits an existing part in a delivery's parts list.
 * Preserves originalOcrValues before the first edit, recalculates verificationStatus if already scanned,
 * and syncs to localStorage, IndexedDB, and Cloudflare D1.
 */
export function editPartInDelivery(
  deliveryId: string,
  partId: string,
  updates: {
    partNumber?: string;
    itemNumber?: string;
    description?: string;
    revision?: string;
    quantity?: number;
    material?: string;
    thickness?: string;
    dimensions?: string;
    weight?: string;
    palletNumber?: string;
    notes?: string;
  }
): Delivery | null {
  const deliveries = getStoredDeliveries();
  const deliveryIdx = deliveries.findIndex((d) => d.id === deliveryId);
  if (deliveryIdx === -1) return null;

  const delivery = deliveries[deliveryIdx];
  const partIdx = delivery.parts.findIndex((p) => p.id === partId);
  if (partIdx === -1) return null;

  const existing = delivery.parts[partIdx];
  const newPartNumber =
    updates.partNumber !== undefined
      ? String(updates.partNumber).trim().toUpperCase()
      : existing.partNumber;
  if (!newPartNumber) {
    throw new Error('Part Number cannot be empty.');
  }

  const newItemNumber =
    updates.itemNumber !== undefined
      ? String(updates.itemNumber).trim() || existing.itemNumber
      : existing.itemNumber;

  const newDescription =
    updates.description !== undefined ? String(updates.description).trim() : existing.description;

  const newRevision =
    updates.revision !== undefined
      ? String(updates.revision).trim() || undefined
      : existing.revision;

  let newReqQty = Math.max(1, existing.quantity ?? 1);
  if (updates.quantity !== undefined && updates.quantity !== null) {
    const parsed = Number(updates.quantity);
    if (Number.isNaN(parsed) || parsed < 1) {
      throw new Error('Quantity must be at least 1.');
    }
    newReqQty = Math.max(1, Math.round(parsed));
  }

  const newMaterial =
    updates.material !== undefined
      ? String(updates.material).trim() || undefined
      : existing.material;
  const newThickness =
    updates.thickness !== undefined
      ? String(updates.thickness).trim() || undefined
      : existing.thickness;
  const newDimensions =
    updates.dimensions !== undefined
      ? String(updates.dimensions).trim() || undefined
      : existing.dimensions;
  const newWeight =
    updates.weight !== undefined
      ? String(updates.weight).trim() || undefined
      : existing.weight;
  const newPalletNumber =
    updates.palletNumber !== undefined
      ? String(updates.palletNumber).trim() || undefined
      : existing.palletNumber;
  const newNotes =
    updates.notes !== undefined
      ? String(updates.notes).trim() || undefined
      : existing.notes;

  // Preserve original OCR values before any manual edits
  const originalOcrValues = existing.originalOcrValues || {
    partNumber: existing.partNumber,
    itemNumber: existing.itemNumber,
    description: existing.description,
    revision: existing.revision,
    quantity: Math.max(1, existing.quantity ?? 1),
  };

  // Keep scanning & verification status consistent with pallet scanning and outstanding quantities
  const isScanned = existing.status === 'received' || (existing.receivedQuantity ?? 0) > 0;
  const recQty = isScanned
    ? typeof existing.receivedQuantity === 'number'
      ? existing.receivedQuantity
      : Math.max(1, existing.quantity ?? 1)
    : undefined;
  const newVerificationStatus: DeliveryPart['verificationStatus'] = isScanned
    ? recQty === newReqQty
      ? 'verified'
      : 'quantity_mismatch'
    : 'unscanned';

  const changes: string[] = [];
  if (newPartNumber !== existing.partNumber) {
    changes.push(`Part#: ${existing.partNumber} → ${newPartNumber}`);
  }
  if (newItemNumber !== existing.itemNumber) {
    changes.push(`No: ${existing.itemNumber} → ${newItemNumber}`);
  }
  if (newDescription !== existing.description) {
    changes.push(`Desc: "${existing.description}" → "${newDescription}"`);
  }
  if ((newRevision || '') !== (existing.revision || '')) {
    changes.push(`Rev: ${existing.revision || '—'} → ${newRevision || '—'}`);
  }
  if (newReqQty !== (existing.quantity ?? 1)) {
    changes.push(`Qty: ${existing.quantity ?? 1} → ${newReqQty}`);
  }
  if ((newPalletNumber || '') !== (existing.palletNumber || '')) {
    changes.push(`Pallet: ${existing.palletNumber || '—'} → ${newPalletNumber || '—'}`);
  }
  if ((newMaterial || '') !== (existing.material || '')) {
    changes.push(`Mat: ${existing.material || '—'} → ${newMaterial || '—'}`);
  }
  if ((newThickness || '') !== (existing.thickness || '')) {
    changes.push(`Thk: ${existing.thickness || '—'} → ${newThickness || '—'}`);
  }

  const now = new Date().toISOString();
  const actor = getActiveActorInfo();
  const summaryText =
    changes.length > 0
      ? `Edited ${newPartNumber} (No. ${newItemNumber}): ${changes.join('; ')}`
      : `Saved ${newPartNumber} (No. ${newItemNumber})`;

  const updatedPart: DeliveryPart = {
    ...existing,
    partNumber: newPartNumber,
    itemNumber: newItemNumber,
    description: newDescription,
    revision: newRevision,
    quantity: newReqQty,
    receivedQuantity: recQty,
    verificationStatus: newVerificationStatus,
    material: newMaterial,
    thickness: newThickness,
    dimensions: newDimensions,
    weight: newWeight,
    palletNumber: newPalletNumber,
    notes: newNotes,
    manuallyEdited: true,
    lastEditedBy: actor.name,
    lastEditedAt: now,
    originalOcrValues,
    editHistory: [
      {
        id: `aud_${Date.now()}`,
        timestamp: now,
        action: 'edited',
        editedBy: actor.name,
        editedByRole: actor.role,
        summary: summaryText,
        previousValues: {
          partNumber: existing.partNumber,
          itemNumber: existing.itemNumber,
          description: existing.description,
          revision: existing.revision,
          quantity: existing.quantity,
        },
        newValues: {
          partNumber: newPartNumber,
          itemNumber: newItemNumber,
          description: newDescription,
          revision: newRevision,
          quantity: newReqQty,
        },
      },
      ...(existing.editHistory || []),
    ],
  };

  const newParts = [...delivery.parts];
  newParts[partIdx] = updatedPart;

  const scanEvent: ScanEvent = {
    id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: now,
    code: newPartNumber,
    codeType: 'manual',
    status: 'part_edited',
    partId: updatedPart.id,
    partNumber: newPartNumber,
    itemNumber: newItemNumber,
    requiredQuantity: newReqQty,
    receivedQuantity: recQty ?? 0,
    message: `${summaryText} by ${actor.name}`,
  };

  const updatedDelivery: Delivery = {
    ...delivery,
    parts: newParts,
    scanHistory: [scanEvent, ...(delivery.scanHistory || [])].slice(0, 300),
    updatedAt: now,
  };

  deliveries[deliveryIdx] = updatedDelivery;
  saveStoredDeliveries(deliveries);
  saveDeliveryToIndexedDb(updatedDelivery).catch(console.error);

  if (typeof window !== 'undefined') {
    apiUpdateDeliveryPart(deliveryId, partId, {
      partNumber: newPartNumber,
      itemNumber: newItemNumber,
      description: newDescription,
      revision: newRevision || null,
      quantity: newReqQty,
      material: newMaterial || null,
      thickness: newThickness || null,
      dimensions: newDimensions || null,
      weight: newWeight || null,
      palletNumber: newPalletNumber || null,
      notes: newNotes || null,
    }).catch((err) => {
      console.warn('Central database editPart sync notice:', err?.message || err);
    });
  }

  return updatedDelivery;
}

/**
 * Deletes a part row from a delivery's parts list in localStorage, IndexedDB, and Cloudflare D1,
 * recording a full audit event in scanHistory.
 */
export function deletePartFromDelivery(deliveryId: string, partId: string): Delivery | null {
  const deliveries = getStoredDeliveries();
  const deliveryIdx = deliveries.findIndex((d) => d.id === deliveryId);
  if (deliveryIdx === -1) return null;

  const delivery = deliveries[deliveryIdx];
  const targetPart = delivery.parts.find((p) => p.id === partId);
  if (!targetPart) return null;

  const now = new Date().toISOString();
  const actor = getActiveActorInfo();
  const wasScannedNote =
    targetPart.status === 'received' || (targetPart.receivedQuantity ?? 0) > 0
      ? ` [Was already scanned: ${targetPart.receivedQuantity ?? targetPart.quantity ?? 1}/${
          targetPart.quantity ?? 1
        }]`
      : '';

  const scanEvent: ScanEvent = {
    id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: now,
    code: targetPart.partNumber,
    codeType: 'manual',
    status: 'part_deleted',
    partNumber: targetPart.partNumber,
    itemNumber: targetPart.itemNumber,
    requiredQuantity: targetPart.quantity ?? 1,
    receivedQuantity: targetPart.receivedQuantity ?? 0,
    message: `Deleted part ${targetPart.partNumber} (No. ${targetPart.itemNumber}${
      targetPart.revision ? `, Rev ${targetPart.revision}` : ''
    }) — "${targetPart.description}" (Qty ${targetPart.quantity ?? 1})${wasScannedNote} by ${
      actor.name
    }`,
  };

  const remainingParts = delivery.parts.filter((p) => p.id !== partId);
  const updatedDelivery: Delivery = {
    ...delivery,
    parts: remainingParts,
    scanHistory: [scanEvent, ...(delivery.scanHistory || [])].slice(0, 300),
    updatedAt: now,
  };

  deliveries[deliveryIdx] = updatedDelivery;
  saveStoredDeliveries(deliveries);
  saveDeliveryToIndexedDb(updatedDelivery).catch(console.error);

  if (typeof window !== 'undefined') {
    apiDeleteDeliveryPart(deliveryId, partId).catch((err) => {
      console.warn('Central database deletePart sync notice:', err?.message || err);
    });
  }

  return updatedDelivery;
}

/**
 * Saves multi-row edits, additions, and deletions for a delivery's parts list in bulk.
 * Preserves original OCR values, recalculates verificationStatus on scanned parts, and syncs to D1.
 */
export function saveDeliveryPartsBatch(
  deliveryId: string,
  editedParts: Array<{
    id?: string;
    partNumber: string;
    itemNumber?: string;
    docketLineIndex?: number;
    description: string;
    revision?: string;
    quantity: number;
    material?: string;
    thickness?: string;
    dimensions?: string;
    weight?: string;
    palletNumber?: string;
    notes?: string;
  }>
): Delivery | null {
  const deliveries = getStoredDeliveries();
  const deliveryIdx = deliveries.findIndex((d) => d.id === deliveryId);
  if (deliveryIdx === -1) return null;

  const delivery = deliveries[deliveryIdx];
  const existingById = new Map<string, DeliveryPart>(delivery.parts.map((p) => [p.id, p]));
  const now = new Date().toISOString();
  const actor = getActiveActorInfo();
  const newAuditEvents: ScanEvent[] = [];

  // Validate all rows first
  for (let i = 0; i < editedParts.length; i++) {
    const row = editedParts[i];
    if (!String(row.partNumber || '').trim()) {
      throw new Error(`Row ${i + 1}: Part Number is required.`);
    }
    const q = Number(row.quantity ?? 1);
    if (Number.isNaN(q) || q < 1) {
      throw new Error(`Row ${i + 1} (${row.partNumber}): Quantity must be at least 1.`);
    }
  }

  const incomingIds = new Set(editedParts.map((p) => p.id).filter(Boolean) as string[]);

  // Track deleted parts
  for (const oldPart of delivery.parts) {
    if (!incomingIds.has(oldPart.id)) {
      newAuditEvents.push({
        id: `ev_${Date.now()}_del_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: now,
        code: oldPart.partNumber,
        codeType: 'manual',
        status: 'part_deleted',
        partNumber: oldPart.partNumber,
        itemNumber: oldPart.itemNumber,
        requiredQuantity: oldPart.quantity ?? 1,
        message: `Deleted part ${oldPart.partNumber} (No. ${oldPart.itemNumber}) — "${oldPart.description}" (Qty ${
          oldPart.quantity ?? 1
        }) by ${actor.name}`,
      });
    }
  }

  const updatedParts: DeliveryPart[] = editedParts.map((row, idx) => {
    const existing = row.id ? existingById.get(row.id) : undefined;
    const cleanPartNo = String(row.partNumber).trim().toUpperCase();
    const cleanItemNo = String(row.itemNumber || idx + 1).trim();
    const cleanDesc = String(row.description || '').trim() || `Part ${cleanPartNo}`;
    const cleanRev = row.revision ? String(row.revision).trim() : undefined;
    const cleanQty = Math.max(1, Math.round(Number(row.quantity ?? 1)));
    const cleanPallet = row.palletNumber ? String(row.palletNumber).trim() : undefined;
    const cleanMat = row.material ? String(row.material).trim() : undefined;
    const cleanThk = row.thickness ? String(row.thickness).trim() : undefined;

    if (!existing) {
      const createdId = row.id || `part_${deliveryId}_manual_${Date.now()}_${idx}`;
      newAuditEvents.push({
        id: `ev_${Date.now()}_add_${idx}_${Math.random().toString(36).slice(2, 5)}`,
        timestamp: now,
        code: cleanPartNo,
        codeType: 'manual',
        status: 'part_added',
        partId: createdId,
        partNumber: cleanPartNo,
        itemNumber: cleanItemNo,
        requiredQuantity: cleanQty,
        receivedQuantity: 0,
        message: `Added part ${cleanPartNo} (No. ${cleanItemNo}${
          cleanRev ? `, Rev ${cleanRev}` : ''
        }) — "${cleanDesc}" (Qty ${cleanQty}) by ${actor.name}`,
      });

      return {
        id: createdId,
        partNumber: cleanPartNo,
        itemNumber: cleanItemNo,
        docketLineIndex: row.docketLineIndex || idx + 1,
        description: cleanDesc,
        revision: cleanRev,
        quantity: cleanQty,
        verificationStatus: 'unscanned',
        status: 'outstanding',
        palletNumber: cleanPallet,
        material: cleanMat,
        thickness: cleanThk,
        dimensions: row.dimensions,
        weight: row.weight,
        notes: row.notes,
        manuallyEdited: true,
        lastEditedBy: actor.name,
        lastEditedAt: now,
      };
    }

    const hasChanged =
      cleanPartNo !== existing.partNumber ||
      cleanItemNo !== existing.itemNumber ||
      cleanDesc !== existing.description ||
      (cleanRev || '') !== (existing.revision || '') ||
      cleanQty !== (existing.quantity ?? 1) ||
      (cleanPallet || '') !== (existing.palletNumber || '') ||
      (cleanMat || '') !== (existing.material || '') ||
      (cleanThk || '') !== (existing.thickness || '');

    if (!hasChanged) {
      return existing;
    }

    const originalOcrValues = existing.originalOcrValues || {
      partNumber: existing.partNumber,
      itemNumber: existing.itemNumber,
      description: existing.description,
      revision: existing.revision,
      quantity: Math.max(1, existing.quantity ?? 1),
    };

    const isScanned = existing.status === 'received' || (existing.receivedQuantity ?? 0) > 0;
    const recQty = isScanned
      ? typeof existing.receivedQuantity === 'number'
        ? existing.receivedQuantity
        : Math.max(1, existing.quantity ?? 1)
      : undefined;
    const newVerificationStatus: DeliveryPart['verificationStatus'] = isScanned
      ? recQty === cleanQty
        ? 'verified'
        : 'quantity_mismatch'
      : 'unscanned';

    newAuditEvents.push({
      id: `ev_${Date.now()}_ed_${idx}_${Math.random().toString(36).slice(2, 5)}`,
      timestamp: now,
      code: cleanPartNo,
      codeType: 'manual',
      status: 'part_edited',
      partId: existing.id,
      partNumber: cleanPartNo,
      itemNumber: cleanItemNo,
      requiredQuantity: cleanQty,
      receivedQuantity: recQty ?? 0,
      message: `Edited part ${cleanPartNo} (No. ${cleanItemNo}${
        cleanRev ? `, Rev ${cleanRev}` : ''
      }, Qty ${cleanQty}) by ${actor.name}`,
    });

    return {
      ...existing,
      partNumber: cleanPartNo,
      itemNumber: cleanItemNo,
      description: cleanDesc,
      revision: cleanRev,
      quantity: cleanQty,
      receivedQuantity: recQty,
      verificationStatus: newVerificationStatus,
      palletNumber: cleanPallet,
      material: cleanMat,
      thickness: cleanThk,
      dimensions: row.dimensions ?? existing.dimensions,
      weight: row.weight ?? existing.weight,
      notes: row.notes ?? existing.notes,
      manuallyEdited: true,
      lastEditedBy: actor.name,
      lastEditedAt: now,
      originalOcrValues,
    };
  });

  const updatedDelivery: Delivery = {
    ...delivery,
    parts: updatedParts,
    scanHistory: [...newAuditEvents, ...(delivery.scanHistory || [])].slice(0, 300),
    updatedAt: now,
  };

  deliveries[deliveryIdx] = updatedDelivery;
  saveStoredDeliveries(deliveries);
  saveDeliveryToIndexedDb(updatedDelivery).catch(console.error);

  if (typeof window !== 'undefined') {
    apiBatchSaveDeliveryParts(
      deliveryId,
      updatedParts.map((p) => ({
        id: p.id,
        partNumber: p.partNumber,
        itemNumber: p.itemNumber,
        docketLineIndex: p.docketLineIndex,
        description: p.description,
        revision: p.revision || null,
        quantity: p.quantity,
        palletNumber: p.palletNumber || null,
        material: p.material || null,
        thickness: p.thickness || null,
        dimensions: p.dimensions || null,
        weight: p.weight || null,
        notes: p.notes || null,
      }))
    ).catch((err) => {
      console.warn('Central database batchSaveParts sync notice:', err?.message || err);
    });
  }

  return updatedDelivery;
}

