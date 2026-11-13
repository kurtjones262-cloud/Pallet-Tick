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
  PartScanAttribution,
} from '../types/delivery';
import { DEFAULT_APP_SETTINGS } from './sampleData';
import {
  saveDeliveryToIndexedDb,
  deleteDeliveryFromIndexedDb,
  saveDocketImageToIndexedDb,
  clearAllIndexedDb,
} from './indexedDb';
import { processPendingDocketUploads } from './offlineDocketQueue';
import {
  apiFetchDeliveries,
  apiCreateDelivery,
  apiUpdateDelivery,
  apiDeleteDelivery,
  apiClearAllDeliveries,
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
import { realtimeClient, ClientRealtimeEvent } from '../services/realtimeSync';
import { isIgnoredNonPartQrPayload } from './ignoredQrCodes';


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
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(DELIVERIES_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map(normalizeDeliveryDocketNumbers);
    }
    return [];
  } catch (e) {
    console.error('Failed to load deliveries from storage:', e);
    return [];
  }
}

let isSyncingCentralDb = false;

/**
 * Synchronises local deliveries with the centralised Cloudflare D1 / Worker backend.
 * Retains IndexedDB and localStorage as local cache, flushes pending offline scans first,
 * trusts empty central DB arrays (0 dockets stays 0 dockets), and preserves only genuine
 * offline-created pendingSync records rather than resurrecting deleted/sample dockets.
 */
export async function syncDeliveriesFromCentralDatabase(): Promise<Delivery[]> {
  if (isSyncingCentralDb || typeof localStorage === 'undefined') return getStoredDeliveries();
  isSyncingCentralDb = true;
  try {
    const health = await checkBackendConnection();
    if (!health.connected) {
      return getStoredDeliveries();
    }

    // 1. Flush any pending offline scans first so central D1 has all queued scans
    try {
      await realtimeClient.flushOfflineScanQueue();
    } catch {
      // Ignore flush notice
    }

    const locals = getStoredDeliveries();
    const localById = new Map<string, Delivery>();
    const localByDocket = new Map<string, Delivery>();
    for (const loc of locals) {
      localById.set(loc.id, loc);
      if (loc.docketNumber) {
        localByDocket.set(loc.docketNumber.trim().toLowerCase(), loc);
      }
    }

    let centralList = await apiFetchDeliveries();

    // 2. Only upload locally created deliveries that were explicitly queued offline (`pendingSync === true`)
    const pendingLocalCreations = locals.filter((loc: any) => Boolean(loc?.pendingSync));
    if (pendingLocalCreations.length > 0) {
      const centralIds = new Set((centralList || []).map((d) => d.id));
      const centralDockets = new Set(
        (centralList || []).map((d) => (d.docketNumber || '').trim().toLowerCase())
      );
      const unmigratedLocals = pendingLocalCreations.filter(
        (loc) =>
          !centralIds.has(loc.id) &&
          !centralDockets.has((loc.docketNumber || '').trim().toLowerCase())
      );
      if (unmigratedLocals.length > 0) {
        try {
          await apiMigrateDeliveries(unmigratedLocals);
          centralList = await apiFetchDeliveries();
        } catch (migErr) {
          console.warn('Local delivery migration notice:', migErr);
        }
      }
    }

    if (Array.isArray(centralList)) {
      const seenMergedIds = new Set<string>();
      const seenMergedDockets = new Set<string>();
      const mergedList: Delivery[] = [];

      for (const centralDel of centralList) {
        const normalized = normalizeDeliveryDocketNumbers(centralDel);
        const normDocket = (normalized.docketNumber || '').trim().toLowerCase();
        if (seenMergedIds.has(normalized.id) || (normDocket && seenMergedDockets.has(normDocket))) {
          continue;
        }
        seenMergedIds.add(normalized.id);
        if (normDocket) seenMergedDockets.add(normDocket);

        const matchingLocal =
          localById.get(normalized.id) ||
          (normDocket ? localByDocket.get(normDocket) : undefined);

        if (!matchingLocal) {
          mergedList.push(normalized);
          continue;
        }

        const localVersion = Number(matchingLocal.version) || 1;
        const centralVersion = Number(normalized.version) || 1;
        const localTime = Date.parse(matchingLocal.updatedAt || matchingLocal.createdAt || '') || 0;
        const centralTime = Date.parse(normalized.updatedAt || normalized.createdAt || '') || 0;
        const localIsNewer =
          localVersion > centralVersion ||
          (localVersion === centralVersion && localTime > centralTime);

        const localPartsById = new Map(matchingLocal.parts.map((p) => [p.id, p]));
        const localPartsByKey = new Map(
          matchingLocal.parts.map((p) => [
            `${(p.itemNumber || '').trim()}__${(p.partNumber || '').trim().toUpperCase()}`,
            p,
          ])
        );

        const mergedParts = normalized.parts.map((cPart) => {
          const lPart =
            localPartsById.get(cPart.id) ||
            localPartsByKey.get(
              `${(cPart.itemNumber || '').trim()}__${(cPart.partNumber || '').trim().toUpperCase()}`
            );
          if (!lPart) return cPart;

          const lPartVer = Number(lPart.version) || 1;
          const cPartVer = Number(cPart.version) || 1;
          if (cPart.status === 'received') {
            return { ...cPart, pendingSync: false };
          }
          if (lPart.pendingSync) {
            return lPart;
          }
          if (lPartVer > cPartVer || (lPart.status === 'received' && localIsNewer)) {
            return lPart;
          }
          return cPart;
        });

        const centralPartIds = new Set(mergedParts.map((p) => p.id));
        for (const lPart of matchingLocal.parts) {
          if (!centralPartIds.has(lPart.id) && (lPart.manuallyEdited || lPart.pendingSync)) {
            mergedParts.push(lPart);
          }
        }

        const historyMap = new Map<string, any>();
        for (const ev of normalized.scanHistory || []) {
          if (ev?.id) historyMap.set(ev.id, ev);
        }
        for (const ev of matchingLocal.scanHistory || []) {
          if (ev?.id && !historyMap.has(ev.id)) {
            historyMap.set(ev.id, ev);
          }
        }
        const mergedScanHistory = Array.from(historyMap.values()).sort(
          (a, b) => (Date.parse(b.timestamp || '') || 0) - (Date.parse(a.timestamp || '') || 0)
        );

        mergedList.push({
          ...(localIsNewer ? matchingLocal : normalized),
          id: normalized.id,
          version: Math.max(localVersion, centralVersion),
          updatedAt: localTime > centralTime ? matchingLocal.updatedAt : normalized.updatedAt,
          parts: mergedParts,
          docketAttachments:
            normalized.docketAttachments && normalized.docketAttachments.length > 0
              ? normalized.docketAttachments
              : matchingLocal.docketAttachments || [],
          unexpectedParts:
            normalized.unexpectedParts && normalized.unexpectedParts.length > 0
              ? normalized.unexpectedParts
              : matchingLocal.unexpectedParts || [],
          scanHistory: mergedScanHistory,
        });
      }

      // Preserve ONLY unsynced offline-created deliveries (not already-deleted server dockets!)
      for (const loc of pendingLocalCreations) {
        const locDocket = (loc.docketNumber || '').trim().toLowerCase();
        if (
          !seenMergedIds.has(loc.id) &&
          (!locDocket || !seenMergedDockets.has(locDocket))
        ) {
          seenMergedIds.add(loc.id);
          if (locDocket) seenMergedDockets.add(locDocket);
          mergedList.push(normalizeDeliveryDocketNumbers(loc));
        }
      }

      if (mergedList.length === 0) {
        saveStoredDeliveries([]);
        localStorage.removeItem(ACTIVE_DELIVERY_KEY);
        if (typeof window !== 'undefined' && typeof indexedDB !== 'undefined') {
          clearAllIndexedDb().catch(() => {});
        }
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('parttrack_active_delivery_changed', { detail: null }));
        }
        return [];
      }

      saveStoredDeliveries(mergedList);
      const activeId = getActiveDeliveryId();
      if (!activeId || !mergedList.some((d) => d.id === activeId)) {
        setActiveDeliveryId(mergedList[0].id);
      }
      return mergedList;
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
 * Full manual/automatic reconnection & live sync workflow triggered by Retry / Sync Now buttons.
 */
export async function reconnectAndSyncWithCentralDb(): Promise<{
  connected: boolean;
  error?: string;
}> {
  const health = await checkBackendConnection(2);
  if (!health.connected) {
    return {
      connected: false,
      error: health.error || 'Could not reach central Cloudflare D1 database.',
    };
  }

  try {
    await realtimeClient.reconnectNow(getActiveDeliveryId());
  } catch (e) {
    console.warn('Realtime reconnect notice:', e);
  }

  try {
    await syncDeliveriesFromCentralDatabase();
  } catch (e) {
    console.warn('Central DB sync notice:', e);
  }

  try {
    await realtimeClient.flushPendingOfflineScans();
  } catch (e) {
    console.warn('Offline queue flush notice:', e);
  }

  try {
    await processPendingDocketUploads();
  } catch (e) {
    console.warn('Offline docket upload queue sync notice:', e);
  }

  return {
    connected: true,
    error: realtimeClient.getState().lastError,
  };
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
  if (typeof localStorage === 'undefined') return;
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
    if (typeof window !== 'undefined' && typeof indexedDB !== 'undefined') {
      deliveries.forEach((d) => saveDeliveryToIndexedDb(d).catch(console.error));
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('parttrack_deliveries_updated'));
    }
  } catch (e) {
    console.error('Failed to dispatch delivery update:', e);
  }
}

export function getActiveDeliveryId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(ACTIVE_DELIVERY_KEY);
  } catch {
    return null;
  }
}

export function setActiveDeliveryId(id: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(ACTIVE_DELIVERY_KEY, id);
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('parttrack_active_delivery_changed', { detail: id }));
    }
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
  const previous = index >= 0 ? deliveries[index] : null;
  const now = new Date().toISOString();
  const withUpdatedTimestamp = { ...updated, updatedAt: now };

  if (index >= 0) {
    deliveries[index] = withUpdatedTimestamp;
  } else {
    deliveries.unshift(withUpdatedTimestamp);
  }

  saveStoredDeliveries(deliveries);
  saveDeliveryToIndexedDb(withUpdatedTimestamp).catch(console.error);

  // Sync to central database only when creating a new delivery or when delivery-level fields change
  if (typeof window !== 'undefined') {
    if (previous) {
      const metadataChanged =
        previous.status !== updated.status ||
        previous.carrier !== updated.carrier ||
        previous.notes !== updated.notes ||
        previous.docketNumber !== updated.docketNumber ||
        previous.supplier !== updated.supplier;
      if (metadataChanged) {
        apiUpdateDelivery(updated.id, {
          status: updated.status,
          carrier: updated.carrier,
          notes: updated.notes,
          docketNumber: updated.docketNumber,
          supplier: updated.supplier,
        }).catch((err) => {
          console.warn('Central database update sync notice:', err?.message || err);
        });
      }
    } else {
      apiCreateDelivery(withUpdatedTimestamp).catch((err) => {
        console.warn('Central database create sync notice:', err?.message || err);
      });
    }
  }
}


/**
 * Authoritatively creates a delivery in the central DB first so duplicate docket checks (409)
 * are enforced immediately; falls back to queued offline creation ONLY if offline/network error.
 */
export async function addDeliveryAuthoritative(newDelivery: Delivery): Promise<Delivery> {
  const deliveries = getStoredDeliveries();
  const normDocket = (newDelivery.docketNumber || '').trim().toUpperCase();
  const localDuplicate = deliveries.find(
    (d) => (d.docketNumber || '').trim().toUpperCase() === normDocket
  );
  if (localDuplicate) {
    const err: any = new Error(
      `Duplicate docket: Docket "${newDelivery.docketNumber}" already exists.`
    );
    err.status = 409;
    err.code = 'DUPLICATE_DOCKET';
    throw err;
  }

  let saved: Delivery;
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw Object.assign(new Error('Offline'), { isOffline: true });
    }
    const created = await apiCreateDelivery(newDelivery);
    saved = normalizeDeliveryDocketNumbers({
      ...newDelivery,
      ...created,
      docketAttachments:
        newDelivery.docketAttachments?.length > 0
          ? newDelivery.docketAttachments
          : created.docketAttachments || [],
    });
  } catch (err: any) {
    if (err?.status === 409 || err?.status === 400 || err?.status === 403 || err?.code === 'DUPLICATE_DOCKET') {
      throw err;
    }
    saved = normalizeDeliveryDocketNumbers({
      ...newDelivery,
      pendingSync: true,
    } as any);
  }

  const current = getStoredDeliveries().filter((d) => d.id !== saved.id);
  const next = [saved, ...current];
  saveStoredDeliveries(next);
  saveDeliveryToIndexedDb(saved).catch(console.error);
  return saved;
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
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('parttrack_active_delivery_changed', { detail: null }));
      }
    }
  }
}

export async function deleteDeliveryAuthoritative(id: string): Promise<void> {
  await apiDeleteDelivery(id);
  deleteDelivery(id);
}

export async function clearAllDocketsAuthoritative(): Promise<{
  deletedDeliveries: number;
  deletedGroups: number;
}> {
  const res = await apiClearAllDeliveries();
  clearAllDeliveries();
  return res;
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

  const updatedUser = getStoredUser();
  const actorName = updatedUser
    ? updatedUser.employeeName
    : 'Workshop Operator';
  const actorId = updatedUser?.id || 'usr_operator';

  const nextAttributions =
    status === 'received' && resolvedReceivedQty && resolvedReceivedQty > 0
      ? mergePartAttributionList(part.scannedByUsers, {
          userId: actorId,
          employeeName: actorName,
          quantityScanned: resolvedReceivedQty,
          lastScannedAt: now,
          scanCount: 1,
        }, 'set')
      : [];

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
    lastScannedById: status === 'received' ? actorId : undefined,
    lastScannedByName: status === 'received' ? actorName : undefined,
    scannedByUsers: nextAttributions,
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
    employeeName: actorName,
    employeeRole: updatedUser?.role,
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

  const currentUser = getStoredUser();
  const actorName = currentUser?.employeeName || 'Workshop Operator';
  const actorId = currentUser?.id || 'usr_operator';

  const updatedPart: DeliveryPart = {
    ...targetPart,
    status: 'received',
    receivedQuantity: newTotalScannedQty,
    verificationStatus: isExactQuantityMatch ? 'verified' : 'quantity_mismatch',
    scannedAt: now,
    lastScannedById: actorId,
    lastScannedByName: actorName,
    scannedByUsers: mergePartAttributionList(
      targetPart.scannedByUsers,
      {
        userId: actorId,
        employeeName: actorName,
        quantityScanned: addedPalletQty,
        lastScannedAt: now,
        scanCount: 1,
      },
      'increment'
    ),
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

  if (typeof window !== 'undefined') {
    const idempotencyKey = `ocr_${delivery.id}_${targetPart.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    apiReceivePart(delivery.id, targetPart.id, {
      receivedQuantity: addedPalletQty,
      mode: 'increment',
      idempotencyKey,
      scannedVia: 'ocr_label',
      scannedCode: params.recognizedPartNumber.trim(),
      status: 'received',
      rawOcrText: params.rawOcrText,
      eventAction: 'part_scan_ocr_pallet',
    }).catch((err) => {
      console.warn('Central database OCR pallet label sync notice:', err?.message || err);
    });
  }

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

export function mergePartAttributionList(
  existing: PartScanAttribution[] | undefined,
  addition: PartScanAttribution,
  mode: 'set' | 'increment'
): PartScanAttribution[] {
  const list = Array.isArray(existing) ? existing.map((a) => ({ ...a })) : [];
  if (mode === 'set' && list.length === 0) {
    return [addition];
  }
  const idx = list.findIndex(
    (a) =>
      (a.userId && addition.userId && a.userId === addition.userId) ||
      a.employeeName.toLowerCase() === addition.employeeName.toLowerCase()
  );
  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      quantityScanned:
        mode === 'increment'
          ? (list[idx].quantityScanned || 0) + addition.quantityScanned
          : Math.max(list[idx].quantityScanned || 0, addition.quantityScanned),
      lastScannedAt: addition.lastScannedAt,
      scanCount: (list[idx].scanCount || 0) + Math.max(1, addition.scanCount || 1),
    };
  } else {
    list.push({
      ...addition,
      scanCount: Math.max(1, addition.scanCount || 1),
    });
  }
  return list;
}

export interface ScopedPartMatch {
  delivery: Delivery;
  part: DeliveryPart;
  matchMode: 'exact-part' | 'docket-no' | 'exact-item';
  detectedType: 'qr' | 'barcode';
  alreadyFullyScanned: boolean;
}

/**
 * Matches a scanned barcode or QR code strictly within a single delivery.
 */
export function findMatchingPartsInDelivery(
  delivery: Delivery,
  rawCode: string
): ScopedPartMatch[] {
  if (isIgnoredNonPartQrPayload(rawCode)) return [];
  const cleaned = rawCode.trim().replace(/^\*+|\*+$/g, '').trim();
  if (!cleaned || !delivery) return [];
  const normalizedInput = cleaned.toUpperCase();
  const parsedBarcode = parseBarcodeDocketNo(cleaned);
  const supplierRule = getDeliverySupplierRule(delivery);
  const matches: ScopedPartMatch[] = [];

  for (const part of delivery.parts) {
    const check = doesPartMatchScannedCode(
      part,
      normalizedInput,
      parsedBarcode,
      supplierRule.id
    );
    if (check.matched) {
      const detectedType: 'qr' | 'barcode' =
        check.matchMode === 'exact-part' ? 'qr' : 'barcode';
      const req = Math.max(1, part.quantity ?? 1);
      const rec =
        part.status === 'received'
          ? typeof part.receivedQuantity === 'number'
            ? part.receivedQuantity
            : req
          : 0;
      matches.push({
        delivery,
        part,
        matchMode: check.matchMode,
        detectedType,
        alreadyFullyScanned: part.status === 'received' && rec >= req,
      });
    }
  }
  return matches;
}

/**
 * Matches a scanned barcode or QR code strictly within the dockets belonging to a Docket Group.
 */
export function findMatchingPartsInGroup(
  groupDeliveries: Delivery[],
  rawCode: string
): ScopedPartMatch[] {
  const results: ScopedPartMatch[] = [];
  for (const del of groupDeliveries) {
    const sub = findMatchingPartsInDelivery(del, rawCode);
    results.push(...sub);
  }
  return results;
}

export function processScannedCode(
  delivery: Delivery,
  rawCode: string
): { updatedDelivery: Delivery; result: ProcessScanResult } {
  if (isIgnoredNonPartQrPayload(rawCode)) {
    return {
      updatedDelivery: delivery,
      result: {
        status: 'unexpected',
        message: '',
        code: rawCode.trim(),
        detectedType: 'qr',
      },
    };
  }
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

  if (typeof window !== 'undefined') {
    const restoredQty = shouldRestorePreviousReceived
      ? Number(lastScan.previousReceivedQuantity) || 0
      : 0;
    const restoredStatus = shouldRestorePreviousReceived ? 'received' : 'outstanding';
    apiReceivePart(delivery.id, part.id, {
      receivedQuantity: restoredQty,
      mode: 'set',
      status: restoredStatus,
      scannedVia: 'manual',
      scannedCode: lastScan.code,
      eventAction: 'part_untick',
    }).catch((err) => {
      console.warn('Central database undo sync notice:', err?.message || err);
    });
  }

  return updatedDelivery;
}

/**
 * Commits a scanned part quantity authoritatively to the central D1 database.
 * - Uses a unique `idempotencyKey` so network retries never double-count.
 * - Detects server-side 409 Conflict when another worker scanned the same part
 *   milliseconds earlier, returning `outcome: 'duplicate'` with who scanned it and when.
 * - If the device is temporarily offline, queues the scan in `realtimeClient` as
 *   `pending_sync` for server revalidation upon reconnect without marking it verified.
 */
export async function commitScanPartAuthoritative(
  delivery: Delivery,
  pending: PendingQuantityConfirmation,
  enteredQuantity: number,
  options?: { mode?: 'set' | 'increment'; rawOcrText?: string; notes?: string }
): Promise<{
  outcome: 'verified' | 'quantity_mismatch' | 'duplicate' | 'pending_sync';
  updatedDelivery: Delivery;
  updatedPart: DeliveryPart;
  isCorrectQuantity: boolean;
  requiredQuantity: number;
  receivedQuantity: number;
  alreadyScannedBy?: string;
  alreadyScannedAt?: string;
  message: string;
}> {
  const requiredQuantity = Math.max(1, pending.part.quantity ?? 1);
  const enteredQty = Math.max(0, Math.round(enteredQuantity));
  const mode = options?.mode || 'set';
  const idempotencyKey = `scan_${delivery.id}_${pending.part.id}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;

  try {
    const res = await apiReceivePart(delivery.id, pending.part.id, {
      receivedQuantity: enteredQty,
      mode,
      idempotencyKey,
      scannedVia: pending.detectedType,
      scannedCode: pending.code,
      status: 'received',
      notes: options?.notes,
      rawOcrText: options?.rawOcrText,
      eventAction: 'part_scan',
    });

    if (res.duplicate) {
      // Another worker already scanned this part! Reconcile local state with server part
      const serverPart: DeliveryPart = res.part
        ? {
            ...pending.part,
            ...res.part,
            pendingSync: false,
          }
        : {
            ...pending.part,
            status: 'received',
            pendingSync: false,
          };

      const reconciledParts = delivery.parts.map((p) =>
        p.id === pending.part.id ? serverPart : p
      );
      const reconciledDelivery: Delivery = {
        ...delivery,
        parts: reconciledParts,
        updatedAt: new Date().toISOString(),
      };
      saveStoredDeliveries(
        getStoredDeliveries().map((d) =>
          d.id === reconciledDelivery.id ? reconciledDelivery : d
        )
      );

      const who = res.alreadyScannedBy || 'another worker';
      return {
        outcome: 'duplicate',
        updatedDelivery: reconciledDelivery,
        updatedPart: serverPart,
        isCorrectQuantity: false,
        requiredQuantity,
        receivedQuantity: serverPart.receivedQuantity ?? requiredQuantity,
        alreadyScannedBy: res.alreadyScannedBy,
        alreadyScannedAt: res.alreadyScannedAt,
        message:
          res.message ||
          `Duplicate scan – this part has already been received by ${who}`,
      };
    }

    // Server accepted and committed the scan in D1!
    if (res.deliveryVersion) {
      realtimeClient.acceptDeliveryVersion(delivery.id, res.deliveryVersion);
    }

    const now = new Date().toISOString();
    const committedRecQty =
      typeof res.part?.receivedQuantity === 'number'
        ? res.part.receivedQuantity
        : enteredQty;
    const isCorrectQuantity = committedRecQty === requiredQuantity;

    const currentUser = getStoredUser();
    const fallbackActorName = currentUser?.employeeName || 'Workshop Operator';
    const fallbackActorId = currentUser?.id || 'usr_operator';
    const resolvedAttributions =
      Array.isArray(res.part?.scannedByUsers) && res.part!.scannedByUsers!.length > 0
        ? res.part!.scannedByUsers
        : mergePartAttributionList(
            pending.part.scannedByUsers,
            {
              userId: fallbackActorId,
              employeeName: res.scanEvent?.employeeName || fallbackActorName,
              quantityScanned: mode === 'increment' ? enteredQty : committedRecQty,
              lastScannedAt: now,
              scanCount: 1,
            },
            mode
          );

    const updatedPart: DeliveryPart = {
      ...pending.part,
      ...(res.part || {}),
      status: 'received',
      receivedQuantity: committedRecQty,
      verificationStatus: isCorrectQuantity ? 'verified' : 'quantity_mismatch',
      scannedAt: res.part?.scannedAt || now,
      lastScannedById: res.part?.lastScannedById || fallbackActorId,
      lastScannedByName: res.part?.lastScannedByName || res.scanEvent?.employeeName || fallbackActorName,
      scannedByUsers: resolvedAttributions,
      scannedVia: pending.detectedType,
      scannedCode: pending.code,
      pendingSync: false,
    };

    const newParts = delivery.parts.map((p) =>
      p.id === pending.part.id ? updatedPart : p
    );
    const docketNoLabel = pending.part.itemNumber.replace(/^ITM-0*/i, '');

    const scanEvent: ScanEvent = res.scanEvent
      ? {
          id: res.scanEvent.id || `ev_${Date.now()}`,
          timestamp: res.scanEvent.timestamp || now,
          code: res.scanEvent.code || pending.code,
          codeType: (res.scanEvent.codeType as ScanMethod) || pending.detectedType,
          status: isCorrectQuantity ? 'match_success' : 'quantity_mismatch',
          partId: pending.part.id,
          partNumber: pending.part.partNumber,
          itemNumber: pending.part.itemNumber,
          requiredQuantity,
          receivedQuantity: committedRecQty,
          addedQuantity: enteredQty,
          employeeName: res.scanEvent.employeeName,
          employeeRole: res.scanEvent.employeeRole,
          message:
            res.scanEvent.message ||
            (isCorrectQuantity
              ? `Verified ${pending.part.partNumber} [No. ${docketNoLabel}] — Qty ${committedRecQty}/${requiredQuantity} matched`
              : `Qty Mismatch ${pending.part.partNumber} [No. ${docketNoLabel}] — Scanned ${committedRecQty} of ${requiredQuantity} required`),
        }
      : {
          id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: now,
          code: pending.code,
          codeType: pending.detectedType,
          status: isCorrectQuantity ? 'match_success' : 'quantity_mismatch',
          partId: pending.part.id,
          partNumber: pending.part.partNumber,
          itemNumber: pending.part.itemNumber,
          requiredQuantity,
          receivedQuantity: committedRecQty,
          addedQuantity: enteredQty,
          message: isCorrectQuantity
            ? `Verified ${pending.part.partNumber} [No. ${docketNoLabel}] — Qty ${committedRecQty}/${requiredQuantity} matched`
            : `Qty Mismatch ${pending.part.partNumber} [No. ${docketNoLabel}] — Scanned ${committedRecQty} of ${requiredQuantity} required`,
        };

    const updatedDelivery: Delivery = {
      ...delivery,
      version: res.deliveryVersion || (delivery.version || 1) + 1,
      parts: newParts,
      scanHistory: [
        scanEvent,
        ...delivery.scanHistory.filter((e) => e.id !== scanEvent.id),
      ].slice(0, 300),
      updatedAt: now,
    };

    saveStoredDeliveries(
      getStoredDeliveries().map((d) =>
        d.id === updatedDelivery.id ? updatedDelivery : d
      )
    );
    saveDeliveryToIndexedDb(updatedDelivery).catch(() => {});

    return {
      outcome: isCorrectQuantity ? 'verified' : 'quantity_mismatch',
      updatedDelivery,
      updatedPart,
      isCorrectQuantity,
      requiredQuantity,
      receivedQuantity: committedRecQty,
      message: scanEvent.message,
    };
  } catch (err: any) {
    // Offline or network drop: queue scan with idempotencyKey for server revalidation on reconnect
    realtimeClient.enqueueOfflineScan({
      idempotencyKey,
      deliveryId: delivery.id,
      partId: pending.part.id,
      partNumber: pending.part.partNumber,
      itemNumber: pending.part.itemNumber,
      receivedQuantity: enteredQty,
      mode,
      scannedVia: pending.detectedType,
      scannedCode: pending.code,
      notes: options?.notes,
      rawOcrText: options?.rawOcrText,
      queuedAt: new Date().toISOString(),
    });

    const pendingPart: DeliveryPart = {
      ...pending.part,
      pendingSync: true,
    };
    const updatedParts = delivery.parts.map((p) =>
      p.id === pending.part.id ? pendingPart : p
    );
    const updatedDelivery: Delivery = {
      ...delivery,
      parts: updatedParts,
    };

    saveStoredDeliveries(
      getStoredDeliveries().map((d) =>
        d.id === updatedDelivery.id ? updatedDelivery : d
      )
    );
    if (typeof window !== 'undefined' && typeof indexedDB !== 'undefined') {
      saveDeliveryToIndexedDb(updatedDelivery).catch(() => {});
    }

    return {
      outcome: 'pending_sync',
      updatedDelivery,
      updatedPart: pendingPart,
      isCorrectQuantity: false,
      requiredQuantity,
      receivedQuantity: pending.part.receivedQuantity ?? 0,
      message:
        'Connection temporarily unavailable — scan queued as Pending Sync and will be verified with the central server upon reconnection.',
    };
  }
}

/**
 * Applies a server-broadcast real-time event to the local `deliveries` array,
 * enforcing monotonic deliveryVersion ordering so stale/out-of-order events
 * never overwrite newer state.
 */
export function applyRealtimeEventToDeliveries(
  currentDeliveries: Delivery[],
  event: ClientRealtimeEvent
): {
  deliveries: Delivery[];
  changed: boolean;
  notification?: {
    type: 'info' | 'success' | 'warning';
    title: string;
    message: string;
    deliveryId?: string;
    partId?: string;
  };
} {
  if (!event || !event.type) {
    return { deliveries: currentDeliveries, changed: false };
  }

  const actor = event.employeeName || event.payload?.scannedByName || event.payload?.actorName || 'Coworker';

  switch (event.type) {
    case 'delivery:created': {
      const incoming = event.payload?.delivery as Delivery | undefined;
      if (!incoming || !incoming.id) {
        return { deliveries: currentDeliveries, changed: false };
      }
      const normalized = normalizeDeliveryDocketNumbers(incoming);
      const existsIdx = currentDeliveries.findIndex((d) => d.id === normalized.id);
      let nextDeliveries: Delivery[];
      if (existsIdx >= 0) {
        nextDeliveries = currentDeliveries.map((d, i) =>
          i === existsIdx ? normalized : d
        );
      } else {
        nextDeliveries = [normalized, ...currentDeliveries];
      }
      saveStoredDeliveries(nextDeliveries);
      saveDeliveryToIndexedDb(normalized).catch(() => {});
      return {
        deliveries: nextDeliveries,
        changed: true,
        notification: {
          type: 'info',
          title: `New Delivery Docket: ${normalized.docketNumber}`,
          message: `${actor} uploaded ${normalized.supplier} (${normalized.parts.length} parts)`,
          deliveryId: normalized.id,
        },
      };
    }

    case 'delivery:updated':
    case 'delivery:completed':
    case 'delivery:reopened': {
      const incoming = event.payload?.delivery as Delivery | undefined;
      if (!incoming || !incoming.id) {
        return { deliveries: currentDeliveries, changed: false };
      }
      const normalized = normalizeDeliveryDocketNumbers(incoming);
      const nextDeliveries = currentDeliveries.map((d) => {
        if (d.id !== normalized.id) return d;
        if (
          typeof d.version === 'number' &&
          typeof normalized.version === 'number' &&
          normalized.version < d.version
        ) {
          return d;
        }
        return {
          ...d,
          ...normalized,
          docketAttachments:
            normalized.docketAttachments?.length > 0
              ? normalized.docketAttachments
              : d.docketAttachments || [],
        };
      });
      saveStoredDeliveries(nextDeliveries);
      return {
        deliveries: nextDeliveries,
        changed: true,
        notification:
          event.type === 'delivery:completed'
            ? {
                type: 'success',
                title: `Delivery ${normalized.docketNumber} Completed`,
                message: `Marked complete by ${actor}`,
                deliveryId: normalized.id,
              }
            : event.type === 'delivery:reopened'
            ? {
                type: 'info',
                title: `Delivery ${normalized.docketNumber} Reopened`,
                message: `Reopened for receiving by ${actor}`,
                deliveryId: normalized.id,
              }
            : undefined,
      };
    }

    case 'part:scanned':
    case 'quantity:updated':
    case 'part:scan_reversed': {
      const deliveryId = event.deliveryId;
      const incomingPart = event.payload?.part as DeliveryPart | undefined;
      const incomingScan = event.payload?.scanEvent as ScanEvent | undefined;
      if (!deliveryId || !incomingPart) {
        return { deliveries: currentDeliveries, changed: false };
      }

      let changed = false;
      const nextDeliveries = currentDeliveries.map((del) => {
        if (del.id !== deliveryId) return del;
        if (
          typeof del.version === 'number' &&
          typeof event.deliveryVersion === 'number' &&
          event.deliveryVersion < del.version
        ) {
          return del;
        }

        const nextParts = del.parts.map((p) => {
          if (p.id !== incomingPart.id) return p;
          if (
            typeof p.version === 'number' &&
            typeof incomingPart.version === 'number' &&
            incomingPart.version < p.version
          ) {
            return p;
          }
          changed = true;
          return {
            ...p,
            ...incomingPart,
            itemNumber: p.itemNumber || incomingPart.itemNumber,
            docketLineIndex: p.docketLineIndex || incomingPart.docketLineIndex,
            pendingSync: false,
          };
        });

        let nextHistory = del.scanHistory || [];
        if (incomingScan && incomingScan.id) {
          if (!nextHistory.some((s) => s.id === incomingScan.id)) {
            const mappedScan: ScanEvent = {
              id: incomingScan.id,
              timestamp: incomingScan.timestamp || event.timestamp,
              code: incomingScan.code || incomingPart.partNumber,
              codeType:
                ((incomingScan as any).codeType as ScanMethod) ||
                incomingPart.scannedVia ||
                'qr',
              status: (incomingScan.status as any) || 'match_success',
              partId: incomingPart.id,
              partNumber: incomingPart.partNumber,
              itemNumber: incomingPart.itemNumber,
              requiredQuantity: incomingPart.quantity,
              receivedQuantity: incomingPart.receivedQuantity,
              addedQuantity: (incomingScan as any).quantityAdded,
              employeeName: incomingScan.employeeName || event.employeeName,
              employeeRole: incomingScan.employeeRole || event.employeeRole,
              message:
                incomingScan.message ||
                `${actor} scanned ${incomingPart.partNumber} (${incomingPart.receivedQuantity}/${incomingPart.quantity})`,
            };
            nextHistory = [mappedScan, ...nextHistory].slice(0, 300);
            changed = true;
          }
        }

        if (!changed) return del;
        return {
          ...del,
          version: event.deliveryVersion || (del.version || 1) + 1,
          parts: nextParts,
          scanHistory: nextHistory,
          updatedAt: event.timestamp || new Date().toISOString(),
        };
      });

      if (changed) {
        saveStoredDeliveries(nextDeliveries);
      }

      return {
        deliveries: nextDeliveries,
        changed,
        notification: {
          type: event.type === 'part:scan_reversed' ? 'warning' : 'success',
          title:
            event.type === 'part:scan_reversed'
              ? `Scan Reversed: ${incomingPart.partNumber}`
              : `Scanned: ${incomingPart.partNumber} (No. ${incomingPart.itemNumber})`,
          message:
            event.type === 'part:scan_reversed'
              ? `${actor} unticked ${incomingPart.partNumber}`
              : `${actor} received ${incomingPart.receivedQuantity ?? 1}/${incomingPart.quantity ?? 1}`,
          deliveryId,
          partId: incomingPart.id,
        },
      };
    }

    case 'part:added':
    case 'part:edited':
    case 'part:deleted':
    case 'parts:batch_saved': {
      const deliveryId = event.deliveryId;
      const incomingDelivery = event.payload?.delivery as Delivery | undefined;
      if (!deliveryId || !incomingDelivery) {
        return { deliveries: currentDeliveries, changed: false };
      }
      const normalized = normalizeDeliveryDocketNumbers(incomingDelivery);
      const nextDeliveries = currentDeliveries.map((d) =>
        d.id === deliveryId
          ? {
              ...d,
              ...normalized,
              docketAttachments:
                normalized.docketAttachments?.length > 0
                  ? normalized.docketAttachments
                  : d.docketAttachments || [],
            }
          : d
      );
      saveStoredDeliveries(nextDeliveries);
      const partNo = event.payload?.part?.partNumber || '';
      return {
        deliveries: nextDeliveries,
        changed: true,
        notification: {
          type: 'info',
          title:
            event.type === 'part:added'
              ? `Part Added: ${partNo}`
              : event.type === 'part:deleted'
              ? 'Part Removed from Docket'
              : `Parts List Updated`,
          message: `Updated by ${actor}`,
          deliveryId,
          partId: event.partId,
        },
      };
    }

    case 'delivery:deleted': {
      const targetId = event.deliveryId || event.payload?.deliveryId;
      if (!targetId) {
        return { deliveries: currentDeliveries, changed: false };
      }
      const exists = currentDeliveries.some((d) => d.id === targetId);
      const nextDeliveries = currentDeliveries.filter((d) => d.id !== targetId);
      if (exists) {
        saveStoredDeliveries(nextDeliveries);
        deleteDeliveryFromIndexedDb(targetId).catch(() => {});
        if (getActiveDeliveryId() === targetId) {
          if (nextDeliveries.length > 0) {
            setActiveDeliveryId(nextDeliveries[0].id);
          } else {
            localStorage.removeItem(ACTIVE_DELIVERY_KEY);
          }
        }
      }
      return {
        deliveries: nextDeliveries,
        changed: exists,
        notification: exists
          ? {
              type: 'warning',
              title: `Docket Deleted`,
              message: `${actor} removed a completed docket`,
            }
          : undefined,
      };
    }

    case 'deliveries:cleared': {
      clearAllDeliveries();
      return {
        deliveries: [],
        changed: currentDeliveries.length > 0,
        notification: {
          type: 'warning',
          title: 'All Dockets Cleared',
          message: `${actor} cleared all dockets across the system`,
        },
      };
    }

    default:
      return { deliveries: currentDeliveries, changed: false };
  }
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

  const duplicatePart = delivery.parts.find(
    (p) => String(p.partNumber || '').trim().toUpperCase() === cleanPartNumber
  );
  if (duplicatePart) {
    throw new Error(
      `Duplicate part number "${cleanPartNumber}" already exists in this delivery (No. ${duplicatePart.itemNumber}). Edit the existing part row instead of creating a duplicate.`
    );
  }

  const rawQty = input.quantity === undefined || input.quantity === null ? 1 : Number(input.quantity);
  if (!Number.isFinite(rawQty) || rawQty < 1 || rawQty > 100000) {
    throw new Error('Quantity must be a valid positive number (at least 1).');
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

  const duplicateRow = delivery.parts.find(
    (p) => p.id !== partId && String(p.partNumber || '').trim().toUpperCase() === newPartNumber
  );
  if (duplicateRow) {
    throw new Error(
      `Duplicate part number "${newPartNumber}" already exists in this delivery (No. ${duplicateRow.itemNumber}).`
    );
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
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100000) {
      throw new Error('Quantity must be a valid positive number (at least 1).');
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

  // Validate all rows first (including duplicate part number check)
  const seenBatchParts = new Set<string>();
  for (let i = 0; i < editedParts.length; i++) {
    const row = editedParts[i];
    const cleanPartNo = String(row.partNumber || '').trim().toUpperCase();
    if (!cleanPartNo) {
      throw new Error(`Row ${i + 1}: Part Number is required.`);
    }
    const q = Number(row.quantity ?? 1);
    if (!Number.isFinite(q) || q < 1 || q > 100000) {
      throw new Error(`Row ${i + 1} (${cleanPartNo}): Quantity must be at least 1.`);
    }
    if (seenBatchParts.has(cleanPartNo)) {
      throw new Error(`Duplicate part number "${cleanPartNo}" found in the parts list.`);
    }
    seenBatchParts.add(cleanPartNo);
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

