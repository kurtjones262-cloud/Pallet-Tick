import { Delivery, AppSettings, DeliveryPart, UnexpectedPart, ScanEvent, ScanMethod } from '../types/delivery';
import { generate200PartDelivery, DEFAULT_APP_SETTINGS } from './sampleData';
import {
  saveDeliveryToIndexedDb,
  deleteDeliveryFromIndexedDb,
  saveDocketImageToIndexedDb,
  clearAllIndexedDb,
} from './indexedDb';

const DELIVERIES_KEY = 'parttrack_deliveries_v2';
const ACTIVE_DELIVERY_KEY = 'parttrack_active_delivery_id_v2';
const SETTINGS_KEY = 'parttrack_settings_v1';
const RESET_FLAG = 'parttrack_fresh_reset_20261105';

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
    if (!raw) return [];
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

/**
 * Ensures every part in a stored delivery has its clean Docket "No" (1, 2, 3...)
 * in itemNumber & docketLineIndex, repairing any legacy "ITM-003-1", "3-1", or "BC-9001" values.
 */
function normalizeDeliveryDocketNumbers(delivery: Delivery): Delivery {
  if (!delivery || !Array.isArray(delivery.parts)) return delivery;

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
 * Marks an individual part as received or outstanding
 */
export function setPartStatus(
  deliveryId: string,
  partId: string,
  status: 'received' | 'outstanding',
  method: 'qr' | 'barcode' | 'manual' = 'manual',
  scannedCode?: string
): Delivery | null {
  const deliveries = getStoredDeliveries();
  const delivery = deliveries.find((d) => d.id === deliveryId);
  if (!delivery) return null;

  const partIndex = delivery.parts.findIndex((p) => p.id === partId);
  if (partIndex === -1) return null;

  const part = delivery.parts[partIndex];
  const now = new Date().toISOString();

  const updatedPart: DeliveryPart = {
    ...part,
    status,
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
    status: status === 'received' ? (method === 'manual' ? 'manual_ticked' : 'match_success') : 'undo_performed',
    partId: part.id,
    partNumber: part.partNumber,
    itemNumber: part.itemNumber,
    message:
      status === 'received'
        ? `Marked ${part.partNumber} (${part.itemNumber}) as received via ${method.toUpperCase()}`
        : `Unticked ${part.partNumber} (${part.itemNumber})`,
  };

  const updatedDelivery: Delivery = {
    ...delivery,
    parts: newParts,
    scanHistory: [scanEvent, ...delivery.scanHistory].slice(0, 300), // Keep last 300 logs
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
  status: 'matched' | 'duplicate' | 'unexpected';
  part?: DeliveryPart;
  message: string;
  code: string;
  detectedType: ScanMethod;
}

/**
 * Parses a scanned barcode of the form "######-<No>" (e.g. "123456-1", "482910-03", "654321-12")
 * where the numbers after the "-" are the part's number in the "No" section of the delivery docket.
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

  // 1. Primary pattern: "######-<No>" (numbers/code before '-', then digits after '-')
  // Supports e.g. "123456-1", "123456-03", "123456-14", "123456 - 2"
  const dashMatch = trimmed.match(/^([A-Z0-9._/]+?)\s*[-–—]\s*0*(\d+)(?:\s*[-/]\s*\d+)?$/);
  if (dashMatch) {
    const prefix = dashMatch[1].trim();
    const afterDashDigits = dashMatch[2];
    const rawSuffix = trimmed.split(/[-–—]/)[1]?.trim() || afterDashDigits;
    const numericNo = parseInt(afterDashDigits, 10);
    if (/\d/.test(prefix) || /^(NO|ITM|ITEM|LINE|POS|BC|BAR)$/i.test(prefix)) {
      return {
        hasDashFormat: true,
        prefix,
        rawAfterDash: rawSuffix,
        numericNo: Number.isNaN(numericNo) ? null : numericNo,
      };
    }
  }

  // 2. Fallback if barcode contains "######-<No>" anywhere inside the string
  const embeddedMatch = trimmed.match(/(\d{3,10})\s*[-–—]\s*0*(\d+)/);
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

  // 3. Also support entering/scanning a pure docket "No" directly (e.g. "1", "01", "12")
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
  const rawItem = (part.itemNumber || '').trim().toUpperCase();
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

    // 4. Full "######-<No>" stored in itemNumber (e.g. "123456-03")
    const dashMatch = rawItem.match(/^\d{3,10}\s*[-–—]\s*0*(\d+)$/);
    if (dashMatch) {
      const n = parseInt(dashMatch[1], 10);
      if (!Number.isNaN(n)) return n;
    }
  }

  return typeof part.docketLineIndex === 'number' && part.docketLineIndex > 0
    ? part.docketLineIndex
    : null;
}

/**
 * Checks if a part on the delivery docket matches the scanned code:
 * 1. If the barcode is "######-<No>", cross-references <No> (the numbers after the dash)
 *    against the part's number in the "No" section of the docket.
 * 2. Also supports exact match on partNumber or itemNumber.
 */
function doesPartMatchScannedCode(
  part: DeliveryPart,
  normalizedInput: string,
  parsedBarcode: ReturnType<typeof parseBarcodeDocketNo>
): { matched: boolean; matchMode: 'exact-part' | 'docket-no' | 'exact-item' } {
  const partNumUpper = part.partNumber.trim().toUpperCase();
  const itemNumUpper = part.itemNumber.trim().toUpperCase();

  // 1. Primary: Barcode "######-<No>" cross-referencing the numbers after "-" against the Docket "No"
  if (parsedBarcode.hasDashFormat && parsedBarcode.numericNo !== null) {
    const partDocketNo = getPartDocketNumericNo(part);
    if (partDocketNo !== null && partDocketNo === parsedBarcode.numericNo) {
      return { matched: true, matchMode: 'docket-no' };
    }
  }

  // 2. Exact match on Part Number or Item Number
  if (partNumUpper === normalizedInput) {
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

  let matchingOutstandingPart: DeliveryPart | undefined;
  let matchedMode: 'exact-part' | 'docket-no' | 'exact-item' = 'docket-no';

  // If the scanned barcode is "######-<No>", prioritize matching the number after "-" against the Docket "No"!
  if (parsedBarcode.hasDashFormat && parsedBarcode.numericNo !== null) {
    for (const p of delivery.parts) {
      if (p.status !== 'outstanding') continue;
      if (getPartDocketNumericNo(p) === parsedBarcode.numericNo) {
        matchingOutstandingPart = p;
        matchedMode = 'docket-no';
        break;
      }
    }
  }

  // Otherwise (or if not found yet), check exact partNumber / itemNumber / numeric No
  if (!matchingOutstandingPart) {
    for (const p of delivery.parts) {
      if (p.status !== 'outstanding') continue;
      const check = doesPartMatchScannedCode(p, normalizedInput, parsedBarcode);
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
      matchedMode === 'exact-part' && !parsedBarcode.hasDashFormat ? 'qr' : 'barcode';

    const updatedPart: DeliveryPart = {
      ...matchingOutstandingPart,
      status: 'received',
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
  const alreadyReceivedPart = delivery.parts.find((p) => {
    if (p.status !== 'received') return false;
    if (p.scannedCode?.toUpperCase() === normalizedInput) return true;
    return doesPartMatchScannedCode(p, normalizedInput, parsedBarcode).matched;
  });

  if (alreadyReceivedPart) {
    const detectedType: 'qr' | 'barcode' = parsedBarcode.hasDashFormat ? 'barcode' : 'qr';
    const docketNoLabel = alreadyReceivedPart.itemNumber.replace(/^ITM-0*/i, '');

    const scanEvent: ScanEvent = {
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: now,
      code: cleaned,
      codeType: detectedType,
      status: 'duplicate_warning',
      partId: alreadyReceivedPart.id,
      partNumber: alreadyReceivedPart.partNumber,
      itemNumber: alreadyReceivedPart.itemNumber,
      message: `Duplicate scan: Docket No. ${docketNoLabel} (${alreadyReceivedPart.partNumber}) was already received`,
    };

    const updatedDelivery: Delivery = {
      ...delivery,
      scanHistory: [scanEvent, ...delivery.scanHistory].slice(0, 300),
      updatedAt: now,
    };

    updateDelivery(updatedDelivery);

    return {
      updatedDelivery,
      result: {
        status: 'duplicate',
        part: alreadyReceivedPart,
        message: `Duplicate: Docket No. ${docketNoLabel} (${alreadyReceivedPart.partNumber}) already received!`,
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
 * Undoes the last scan event
 */
export function undoLastScan(delivery: Delivery): Delivery {
  const lastSuccessScan = delivery.scanHistory.find(
    (ev) => ev.status === 'match_success' && ev.partId
  );

  if (!lastSuccessScan || !lastSuccessScan.partId) {
    return delivery;
  }

  const updated = setPartStatus(delivery.id, lastSuccessScan.partId, 'outstanding');
  return updated || delivery;
}
