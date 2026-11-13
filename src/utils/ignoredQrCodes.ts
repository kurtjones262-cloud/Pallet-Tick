/**
 * Permanent exclusion list of non-part QR code payloads that appear on raw materials
 * (such as protective plastic film covering sheet metal) and must be silently ignored
 * by the PalletTrack scanner across all users, devices, single-docket scans, and group scans.
 *
 * Safeguards:
 * - Only exact payloads in this list are ignored.
 * - Does not disable QR scanning or filter codes by colour, size, or appearance.
 * - Does not interfere with legitimate part numbers, QR codes, or barcodes.
 */
export const IGNORED_NON_PART_QR_PAYLOADS: readonly string[] = [
  'https://www.novacel-solutions.com/qr/46',
];

const IGNORED_NON_PART_QR_PAYLOAD_SET = new Set<string>(IGNORED_NON_PART_QR_PAYLOADS);

/**
 * Returns true strictly when the scanned payload exactly matches a permanently
 * excluded non-part QR payload (after trimming surrounding whitespace).
 */
export function isIgnoredNonPartQrPayload(rawPayload: string | null | undefined): boolean {
  if (typeof rawPayload !== 'string') return false;
  const trimmed = rawPayload.trim();
  if (!trimmed) return false;
  return IGNORED_NON_PART_QR_PAYLOAD_SET.has(trimmed);
}

/**
 * Filters a batch of decoded camera/frame detections so excluded non-part QR codes
 * are dropped silently while any legitimate barcodes or QR codes in the same frame remain.
 */
export function filterOutIgnoredQrDetections<T>(
  detections: readonly T[],
  getRawValue: (item: T) => string | null | undefined
): T[] {
  return detections.filter((item) => !isIgnoredNonPartQrPayload(getRawValue(item)));
}
