import { Delivery, DeliveryPart } from '../types/delivery';
import { parseBarcodeDocketNo, getPartDocketNumericNo } from './storage';

export interface DuplicateScanResult {
  isDuplicate: boolean;
  matchedPart: DeliveryPart | null;
  partNumber: string;
  description: string;
  itemNumber?: string;
  palletNumber?: string | number;
  scannedAt?: string;
  receivedQuantity?: number;
  reason?: 'part_already_received' | 'part_number_already_received' | 'unexpected_already_scanned';
}

/**
 * Normalizes a part number for case, whitespace, and hyphen-insensitive comparison
 */
export function normalizePartCode(raw?: string | null): string {
  if (!raw) return '';
  return raw
    .trim()
    .toUpperCase()
    .replace(/[–—−]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ');
}

/**
 * STRICT DUPLICATE SCAN PREVENTION
 *
 * Core requirement:
 * A part that has already been successfully scanned into the current delivery/pallet must not be allowed to be scanned again.
 *
 * 1. Checks whether a scanned QR code or barcode matches an already-received part in the current delivery.
 * 2. Identifies duplicates using the part's unique identifier/part number, not just raw barcode data.
 * 3. Returns duplicate details for the prominent RED duplicate warning popup.
 * 4. Ensures duplicate detection happens before any database writes or quantity increments.
 */
export function detectDuplicateScan(
  delivery: Delivery | null | undefined,
  scannedCode: string,
  detectedPartNumber?: string
): DuplicateScanResult {
  if (!delivery || (!scannedCode && !detectedPartNumber)) {
    return { isDuplicate: false, matchedPart: null, partNumber: '', description: '' };
  }

  const cleaned = (scannedCode || '').trim().replace(/^\*+|\*+$/g, '').trim();
  const cleanNorm = normalizePartCode(cleaned);
  const detectedNorm = normalizePartCode(detectedPartNumber);
  const parsedBarcode = parseBarcodeDocketNo(cleaned);

  // 1. Identify which part on the delivery matches this scan
  let candidatePart: DeliveryPart | null = null;

  // 1a. If an explicit detected part number was passed (e.g. from OCR label)
  if (detectedNorm) {
    candidatePart =
      delivery.parts.find((p) => normalizePartCode(p.partNumber) === detectedNorm) || null;
  }

  // 1b. Exact part number match (e.g. QR code or direct part number)
  if (!candidatePart && cleanNorm) {
    candidatePart =
      delivery.parts.find((p) => normalizePartCode(p.partNumber) === cleanNorm) || null;
  }

  // 1c. Structured QR payload match (e.g. contains part number token)
  if (!candidatePart && cleanNorm) {
    candidatePart =
      delivery.parts.find((p) => {
        const norm = normalizePartCode(p.partNumber);
        return norm.length >= 3 && cleanNorm.includes(norm);
      }) || null;
  }

  // 1d. Laser Central Barcode format "######-<No>" extracting sequential item line <No>
  if (!candidatePart && parsedBarcode.hasDashFormat && parsedBarcode.numericNo !== null) {
    candidatePart =
      delivery.parts.find((p) => {
        const numNo = getPartDocketNumericNo(p);
        return numNo !== null && numNo === parsedBarcode.numericNo;
      }) || null;
  }

  // 1e. Item number direct match (e.g. "ITM-003", "3", or "123456-03")
  if (!candidatePart && cleanNorm) {
    candidatePart =
      delivery.parts.find((p) => {
        const rawItm = normalizePartCode(p.itemNumber);
        if (!rawItm) return false;
        return (
          rawItm === cleanNorm ||
          rawItm.replace(/^ITM-0*/, '') === cleanNorm ||
          rawItm.replace(/^NO\.?\s*0*/, '') === cleanNorm
        );
      }) || null;
  }

  // 1f. Numeric item line match
  if (!candidatePart && parsedBarcode.numericNo !== null) {
    candidatePart =
      delivery.parts.find((p) => {
        const numNo = getPartDocketNumericNo(p);
        return numNo !== null && numNo === parsedBarcode.numericNo;
      }) || null;
  }

  // 2. If a docket part was identified:
  if (candidatePart) {
    const candidateNorm = normalizePartCode(candidatePart.partNumber);

    // Check A: Is this exact part record already received in this delivery?
    const isThisPartReceived =
      candidatePart.status === 'received' ||
      (candidatePart.receivedQuantity !== undefined && candidatePart.receivedQuantity > 0) ||
      Boolean(candidatePart.scannedAt);

    // Check B: Has ANY part with this exact Part Number already been received in this delivery?
    const isAnyWithSamePartNumberReceived = delivery.parts.some(
      (p) =>
        normalizePartCode(p.partNumber) === candidateNorm &&
        (p.status === 'received' ||
          (p.receivedQuantity !== undefined && p.receivedQuantity > 0) ||
          Boolean(p.scannedAt))
    );

    if (isThisPartReceived || isAnyWithSamePartNumberReceived) {
      // Find the received part instance to pull accurate metadata (quantity, scannedAt, etc.)
      const alreadyReceivedInstance =
        (isThisPartReceived ? candidatePart : null) ||
        delivery.parts.find(
          (p) =>
            normalizePartCode(p.partNumber) === candidateNorm &&
            (p.status === 'received' || Boolean(p.scannedAt))
        ) ||
        candidatePart;

      return {
        isDuplicate: true,
        matchedPart: alreadyReceivedInstance,
        partNumber: alreadyReceivedInstance.partNumber,
        description: alreadyReceivedInstance.description || candidatePart.description || '',
        itemNumber: alreadyReceivedInstance.itemNumber,
        palletNumber: alreadyReceivedInstance.palletNumber,
        scannedAt: alreadyReceivedInstance.scannedAt,
        receivedQuantity: alreadyReceivedInstance.receivedQuantity,
        reason: isThisPartReceived ? 'part_already_received' : 'part_number_already_received',
      };
    }
  }

  // 3. Check if this code was already scanned previously as an unlisted/unexpected part in this delivery
  if (cleanNorm) {
    const alreadyUnexpected = (delivery.unexpectedParts || []).find(
      (u) => normalizePartCode(u.code) === cleanNorm
    );
    if (alreadyUnexpected) {
      return {
        isDuplicate: true,
        matchedPart: null,
        partNumber: alreadyUnexpected.code,
        description:
          alreadyUnexpected.recognizedDescription ||
          alreadyUnexpected.notes ||
          'Unlisted item previously scanned into this delivery',
        scannedAt: alreadyUnexpected.scannedAt,
        receivedQuantity: alreadyUnexpected.recognizedQuantity ?? 1,
        reason: 'unexpected_already_scanned',
      };
    }
  }

  return { isDuplicate: false, matchedPart: null, partNumber: '', description: '' };
}
