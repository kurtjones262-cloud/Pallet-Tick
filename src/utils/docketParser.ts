import { ExtractedDocketItem, ExtractedDocketResult } from '../server/docketOcr';
import { SupplierRuleId } from '../types/delivery';

export interface RawOcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface RawOcrLine {
  text: string;
  confidence: number;
  pageNumber?: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
  words?: RawOcrWord[];
}

export type ValidationFlagType =
  | 'missing_part_number'
  | 'invalid_quantity'
  | 'uncertain_text'
  | 'incomplete_row'
  | 'missed_line_items'
  | 'duplicate_entry';

export interface DocketValidationReport {
  isAcceptableWithoutFallback: boolean;
  shouldFallbackToGemini: boolean;
  fallbackReason?: string;
  overallConfidenceScore: number;
  missingRowNumbers: number[];
  unparsedCandidateCount: number;
  flaggedRowCount: number;
  flagsSummary: string[];
}

export interface TableColumnBand {
  key:
    | 'no'
    | 'partNumber'
    | 'revision'
    | 'description'
    | 'material'
    | 'thickness'
    | 'dimensions'
    | 'weight'
    | 'quantity'
    | 'pallet';
  xCenter: number;
  x0: number;
  x1: number;
}

export interface TableColumnLayout {
  headerLineIndex: number;
  columns: TableColumnBand[];
  hasPositionalCoords: boolean;
}

/**
 * Reconstructs sorted horizontal table lines from raw positioned OCR words when word-level
 * bounding boxes are available (e.g. from Tesseract.js or PDF.js).
 */
export function groupPositionedWordsIntoLines(
  words: RawOcrWord[],
  pageNumber: number = 1
): RawOcrLine[] {
  const validWords = (words || []).filter((w) => w && String(w.text || '').trim().length > 0 && w.bbox);
  if (validWords.length === 0) return [];

  // Sort by vertical center (top to bottom), then horizontal x0 (left to right)
  const sorted = [...validWords].sort((a, b) => {
    const cyA = (a.bbox.y0 + a.bbox.y1) / 2;
    const cyB = (b.bbox.y0 + b.bbox.y1) / 2;
    const avgH = Math.max(8, ((a.bbox.y1 - a.bbox.y0) + (b.bbox.y1 - b.bbox.y0)) / 2);
    if (Math.abs(cyA - cyB) > avgH * 0.55) {
      return cyA - cyB;
    }
    return a.bbox.x0 - b.bbox.x0;
  });

  const clusters: Array<{ cy: number; height: number; words: RawOcrWord[] }> = [];
  for (const w of sorted) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    const h = Math.max(8, w.bbox.y1 - w.bbox.y0);
    const existing = clusters.find(
      (c) => Math.abs(c.cy - cy) <= Math.max(6, Math.min(c.height, h) * 0.6)
    );
    if (existing) {
      existing.words.push(w);
      // Update running vertical center
      const totalY = existing.words.reduce((acc, item) => acc + (item.bbox.y0 + item.bbox.y1) / 2, 0);
      existing.cy = totalY / existing.words.length;
    } else {
      clusters.push({ cy, height: h, words: [w] });
    }
  }

  clusters.sort((a, b) => a.cy - b.cy);

  const lines: RawOcrLine[] = [];
  for (const cluster of clusters) {
    cluster.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    let text = '';
    let prevX1: number | null = null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let confSum = 0;

    for (const w of cluster.words) {
      const avgCharW = Math.max(4, (w.bbox.x1 - w.bbox.x0) / Math.max(1, w.text.length));
      if (prevX1 !== null) {
        const gap = w.bbox.x0 - prevX1;
        if (gap > avgCharW * 2.2 || gap > 18) {
          text += '   '; // Preserve distinct column separator gap
        } else if (gap > 1) {
          text += ' ';
        }
      }
      text += w.text.trim();
      prevX1 = w.bbox.x1;
      if (w.bbox.x0 < minX) minX = w.bbox.x0;
      if (w.bbox.y0 < minY) minY = w.bbox.y0;
      if (w.bbox.x1 > maxX) maxX = w.bbox.x1;
      if (w.bbox.y1 > maxY) maxY = w.bbox.y1;
      confSum += Number.isFinite(w.confidence) ? w.confidence : 85;
    }

    const cleanText = text.trim();
    if (cleanText) {
      lines.push({
        text: cleanText,
        confidence: Math.round(confSum / cluster.words.length),
        pageNumber,
        bbox: { x0: minX, y0: minY, x1: maxX, y1: maxY },
        words: cluster.words,
      });
    }
  }

  return lines;
}

/**
 * Parses raw OCR text lines extracted from industrial delivery dockets & supplier invoices.
 * Supports deterministic Laser Central and GCI supplier layouts and positional column coordinates.
 */
export function parseIndustrialDocketText(
  lines: RawOcrLine[],
  pageNumber: number = 1,
  supplierHint?: SupplierRuleId
): {
  header: {
    supplier: string;
    supplierProfile: SupplierRuleId;
    docketNumber: string;
    deliveryDate: string;
    carrier?: string;
    palletCount?: number;
    orderNumber?: string;
  };
  items: ExtractedDocketItem[];
  rawText: string;
  unparsedCandidateCount: number;
  columnLayout?: TableColumnLayout;
} {
  const normalizedLines = lines.map((l) => ({
    ...l,
    pageNumber: l.pageNumber ?? pageNumber,
  }));
  const fullText = normalizedLines.map((l) => l.text).join('\n');

  // 1. Supplier & Profile Detection
  const detectedSupplier = extractSupplier(normalizedLines, supplierHint);
  const supplierProfile: SupplierRuleId =
    supplierHint ||
    (/\bgci\b|golden\s*coast/i.test(detectedSupplier) || /\bgci-\d+/i.test(fullText)
      ? 'gci'
      : 'laser_central');

  // 2. Docket Number / Packing Slip Reference Extraction
  const docketNumber = extractDocketNumber(normalizedLines, supplierProfile);

  // 3. Delivery Date
  const deliveryDate = extractDate(normalizedLines);

  // 4. Pallet Count
  const palletCount = extractPalletCount(normalizedLines);

  // 5. Carrier / Transport
  const carrier = extractCarrier(normalizedLines);

  // 6. PO / Order Number
  const orderNumber = extractOrderNumber(normalizedLines);

  // 7. Table Line Items Extraction using positional column layout + supplier-specific rules
  const { items, unparsedCandidateCount, columnLayout } = extractTableItemsWithLayout(
    normalizedLines,
    pageNumber,
    docketNumber,
    supplierProfile,
    orderNumber
  );

  return {
    header: {
      supplier: detectedSupplier,
      supplierProfile,
      docketNumber,
      deliveryDate,
      carrier,
      palletCount,
      orderNumber,
    },
    items,
    rawText: fullText,
    unparsedCandidateCount,
    columnLayout,
  };
}

/**
 * Combines parsed results across multiple docket pages into a unified compiled list
 * and runs strict row completeness and sequence validation.
 */
export function combineMultiPageDocketResults(
  pageResults: Array<ReturnType<typeof parseIndustrialDocketText>>,
  options?: {
    extractionMethod?: 'tesseract-ocr' | 'offline-ocr' | 'pdf-text';
    extractionEngineLabel?: string;
    processingTimeMs?: number;
    ocrTimeMs?: number;
    parseTimeMs?: number;
    pagesFromCache?: number;
  }
): ExtractedDocketResult & { validationReport: DocketValidationReport } {
  const method = options?.extractionMethod || 'tesseract-ocr';
  const engineLabel = options?.extractionEngineLabel || 'Tesseract.js OCR';

  if (pageResults.length === 0) {
    const emptyReport: DocketValidationReport = {
      isAcceptableWithoutFallback: false,
      shouldFallbackToGemini: true,
      fallbackReason: 'No pages or text lines were extracted by Tesseract.',
      overallConfidenceScore: 0,
      missingRowNumbers: [],
      unparsedCandidateCount: 0,
      flaggedRowCount: 0,
      flagsSummary: ['No part rows extracted'],
    };
    return {
      docketNumber: `DK-${Math.floor(10000 + Math.random() * 90000)}`,
      supplier: 'Laser Central',
      deliveryDate: new Date().toISOString().split('T')[0],
      items: [],
      confidenceScore: 0,
      needsManualReview: true,
      extractionMethod: method,
      extractionEngineLabel: engineLabel,
      processingTimeMs: options?.processingTimeMs,
      ocrTimeMs: options?.ocrTimeMs,
      parseTimeMs: options?.parseTimeMs,
      pagesFromCache: options?.pagesFromCache,
      validationFlags: emptyReport.flagsSummary,
      validationReport: emptyReport,
    };
  }

  const primaryHeader =
    pageResults.find(
      (p) =>
        p.header.docketNumber &&
        !p.header.docketNumber.startsWith('DK-AUTO') &&
        !/^DK-\d{5}$/.test(p.header.docketNumber)
    )?.header || pageResults[0].header;

  const combinedItems: ExtractedDocketItem[] = [];
  let itemCounter = 1;
  let totalUnparsedCandidates = 0;

  for (const page of pageResults) {
    totalUnparsedCandidates += page.unparsedCandidateCount || 0;
    for (const it of page.items) {
      const resolvedItemNo = it.itemNumber || String(itemCounter);
      const revVal = it.revision || it.rev || undefined;
      combinedItems.push({
        ...it,
        itemNumber: resolvedItemNo,
        revision: revVal,
        rev: revVal,
        originalOcrValues: it.originalOcrValues || {
          partNumber: it.partNumber,
          itemNumber: resolvedItemNo,
          description: it.description,
          revision: revVal,
          rev: revVal,
          quantity: Math.max(1, it.quantity || 1),
          material: it.material,
          thickness: it.thickness,
        },
      });
      itemCounter++;
    }
  }

  // Run comprehensive row & document validation
  const validationReport = validateDocketExtractionQuality(
    combinedItems,
    totalUnparsedCandidates
  );

  // Compute max pallet number referenced across items
  let maxPalletNum = primaryHeader.palletCount || 1;
  for (const it of combinedItems) {
    const m = String(it.palletNumber || '').match(/(\d+)/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n > maxPalletNum && n <= 50) {
        maxPalletNum = n;
      }
    }
  }

  const numericNos = combinedItems
    .map((it) => parseInt(String(it.itemNumber || '').replace(/\D+/g, ''), 10))
    .filter((n) => !Number.isNaN(n) && n > 0 && n <= 2000)
    .sort((a, b) => a - b);

  return {
    docketNumber: primaryHeader.docketNumber,
    supplier: primaryHeader.supplier,
    deliveryDate: primaryHeader.deliveryDate,
    carrier: primaryHeader.carrier,
    palletCount: maxPalletNum,
    orderNumber: primaryHeader.orderNumber,
    items: combinedItems,
    confidenceScore: validationReport.overallConfidenceScore,
    needsManualReview:
      !validationReport.isAcceptableWithoutFallback || validationReport.flaggedRowCount > 0,
    rawTextSummary: pageResults.map((p) => p.rawText).join('\n--- PAGE BREAK ---\n'),
    extractionMethod: method,
    extractionEngineLabel: engineLabel,
    pagesScanned: pageResults.length,
    pagesFromCache: options?.pagesFromCache,
    processingTimeMs: options?.processingTimeMs,
    ocrTimeMs: options?.ocrTimeMs,
    parseTimeMs: options?.parseTimeMs,
    validationFlags: validationReport.flagsSummary,
    missingRowNumbers: validationReport.missingRowNumbers,
    flaggedRowCount: validationReport.flaggedRowCount,
    hasPrintedNoColumn: numericNos.length > 0,
    firstVisibleRowNo: numericNos.length > 0 ? numericNos[0] : undefined,
    lastVisibleRowNo: numericNos.length > 0 ? numericNos[numericNos.length - 1] : undefined,
    validationReport,
  };
}

/**
 * Validates extracted rows for missing part numbers, invalid quantities, uncertain text,
 * incomplete rows, potentially missed line items, and duplicate entries.
 * Never silently accepts an incomplete or low-confidence parts list.
 */
export function validateDocketExtractionQuality(
  items: ExtractedDocketItem[],
  unparsedCandidateCount: number = 0
): DocketValidationReport {
  const flagsSummary: string[] = [];

  if (items.length === 0) {
    return {
      isAcceptableWithoutFallback: false,
      shouldFallbackToGemini: true,
      fallbackReason: 'Tesseract did not detect any structured part rows on the docket.',
      overallConfidenceScore: 0,
      missingRowNumbers: [],
      unparsedCandidateCount,
      flaggedRowCount: 0,
      flagsSummary: ['No part rows detected'],
    };
  }

  let missingPartCount = 0;
  let invalidQtyCount = 0;
  let uncertainRowCount = 0;
  let incompleteRowCount = 0;
  let duplicateRowCount = 0;

  const seenCompositeKeys = new Map<string, number>();
  const seenItemNumbers = new Map<string, number>();
  const numericItemNumbers: number[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const rowFlags: ValidationFlagType[] = [];
    const notesList: string[] = item.notes ? [item.notes] : [];

    const pn = String(item.partNumber || '').trim();
    const desc = String(item.description || '').trim();
    const itemNo = String(item.itemNumber || '').trim();

    // 1. Check Missing or Suspicious Part Number
    if (
      !pn ||
      pn.length < 2 ||
      pn === 'PART' ||
      pn === 'UNKNOWN' ||
      /^\d{1,2}$/.test(pn)
    ) {
      rowFlags.push('missing_part_number');
      missingPartCount++;
      notesList.push('Missing or invalid Part Number');
    }

    // 2. Check Invalid Quantity
    const qty = Number(item.quantity);
    if (!Number.isFinite(qty) || qty < 1 || qty > 10000 || Math.floor(qty) !== qty) {
      rowFlags.push('invalid_quantity');
      invalidQtyCount++;
      notesList.push('Invalid or missing quantity');
    }

    // 3. Check Incomplete Row
    if (!desc || desc.length < 2 || (desc.toUpperCase() === pn.toUpperCase() && !item.material && !item.thickness)) {
      rowFlags.push('incomplete_row');
      incompleteRowCount++;
      notesList.push('Incomplete row details (missing description/specs)');
    }

    // 4. Check Uncertain OCR Text
    const hasNoiseChars = /[~?{}§¤¦«»]/.test(pn) || /[~?{}§¤¦]{2,}/.test(desc);
    if (item.confidence === 'low' || hasNoiseChars) {
      rowFlags.push('uncertain_text');
      uncertainRowCount++;
      if (hasNoiseChars) {
        notesList.push('Uncertain OCR characters detected');
      }
    }

    // 5. Check Duplicate Entries within the same docket (same partNumber + revision + palletNumber)
    const revKey = String(item.revision || item.rev || '').trim().toUpperCase();
    const palletKey = String(item.palletNumber || '').trim().toUpperCase();
    const pageKey = String(item.pageNumber || 1);
    const compositeKey = `${pn.toUpperCase()}::REV=${revKey}::PAL=${palletKey}`;
    if (pn && seenCompositeKeys.has(compositeKey)) {
      rowFlags.push('duplicate_entry');
      duplicateRowCount++;
      const firstIdx = seenCompositeKeys.get(compositeKey)!;
      notesList.push(`Duplicate entry of Row #${items[firstIdx].itemNumber || firstIdx + 1}`);
      // Also flag the earlier row if not already flagged
      const firstItem = items[firstIdx];
      if (!firstItem.validationFlags?.includes('duplicate_entry')) {
        firstItem.validationFlags = [...(firstItem.validationFlags || []), 'duplicate_entry'];
        firstItem.confidence = 'low';
        firstItem.notes = firstItem.notes
          ? `${firstItem.notes}; Duplicate part entry`
          : `Duplicate part entry (matches Row #${itemNo || i + 1})`;
      }
    } else if (pn) {
      seenCompositeKeys.set(compositeKey, i);
    }

    if (itemNo && /^\d+$/.test(itemNo)) {
      const n = parseInt(itemNo, 10);
      if (n >= 1 && n <= 1500) {
        const scopedItemNoKey = `${pageKey}::${itemNo}`;
        if (seenItemNumbers.has(scopedItemNoKey)) {
          const prevIdx = seenItemNumbers.get(scopedItemNoKey)!;
          const prevItem = items[prevIdx];
          const isDistinctRevOrPallet =
            prevItem &&
            prevItem.partNumber.toUpperCase() === pn.toUpperCase() &&
            (String(prevItem.revision || prevItem.rev || '').toUpperCase() !== revKey ||
              String(prevItem.palletNumber || '').toUpperCase() !== palletKey);
          if (!isDistinctRevOrPallet && !rowFlags.includes('duplicate_entry')) {
            rowFlags.push('duplicate_entry');
            duplicateRowCount++;
            notesList.push(`Duplicate Docket No. ${itemNo}`);
          }
        } else {
          seenItemNumbers.set(scopedItemNoKey, i);
          numericItemNumbers.push(n);
        }
      }
    }

    if (rowFlags.length > 0) {
      item.validationFlags = Array.from(new Set([...(item.validationFlags || []), ...rowFlags]));
      item.confidence = 'low';
      item.notes = Array.from(new Set(notesList)).join('; ');
    }
  }

  // 6. Check for Potentially Missed Line Items (gaps in sequential printed No column 1..Max)
  const missingRowNumbers: number[] = [];
  if (numericItemNumbers.length >= 2) {
    const sorted = [...numericItemNumbers].sort((a, b) => a - b);
    const minNo = sorted[0];
    const maxNo = sorted[sorted.length - 1];
    // Only check contiguous sequence if numbering starts near 1 and span is reasonable (not arbitrary 4-digit item codes)
    if (minNo <= 3 && maxNo - minNo <= items.length + 15 && maxNo <= 500) {
      const presentSet = new Set(sorted);
      for (let expectedNo = 1; expectedNo <= maxNo; expectedNo++) {
        if (!presentSet.has(expectedNo)) {
          missingRowNumbers.push(expectedNo);
        }
      }
    }
  }

  if (missingPartCount > 0) {
    flagsSummary.push(`${missingPartCount} row(s) missing valid part numbers`);
  }
  if (invalidQtyCount > 0) {
    flagsSummary.push(`${invalidQtyCount} row(s) with invalid quantities`);
  }
  if (uncertainRowCount > 0) {
    flagsSummary.push(`${uncertainRowCount} row(s) with low OCR confidence`);
  }
  if (incompleteRowCount > 0) {
    flagsSummary.push(`${incompleteRowCount} incomplete row(s)`);
  }
  if (duplicateRowCount > 0) {
    flagsSummary.push(`${duplicateRowCount} duplicate entry warning(s)`);
  }
  if (missingRowNumbers.length > 0) {
    flagsSummary.push(
      `Potentially missed line item(s): No. ${missingRowNumbers.slice(0, 10).join(', ')}`
    );
  }
  if (unparsedCandidateCount > 0) {
    flagsSummary.push(`${unparsedCandidateCount} table line(s) could not be confidently parsed`);
  }

  const flaggedRowCount = items.filter((it) => it.confidence === 'low').length;
  const highOrMedCount = items.length - flaggedRowCount;
  const baseRatio = Math.round((highOrMedCount / items.length) * 100);
  const penalty =
    missingRowNumbers.length * 12 +
    unparsedCandidateCount * 10 +
    missingPartCount * 15 +
    invalidQtyCount * 15;
  const overallConfidenceScore = Math.max(0, Math.min(100, baseRatio - penalty));

  // Determine whether Tesseract extraction is complete & confident enough or should trigger Gemini fallback
  const fallbackReasons: string[] = [];
  if (missingPartCount > 0) {
    fallbackReasons.push(`${missingPartCount} row(s) missing part numbers`);
  }
  if (invalidQtyCount > 0) {
    fallbackReasons.push(`${invalidQtyCount} row(s) with invalid quantities`);
  }
  if (missingRowNumbers.length > 0) {
    fallbackReasons.push(
      `sequence gap detected (missing No. ${missingRowNumbers.slice(0, 6).join(', ')})`
    );
  }
  if (unparsedCandidateCount > 0) {
    fallbackReasons.push(`${unparsedCandidateCount} unparsed table candidate line(s)`);
  }
  if (overallConfidenceScore < 75) {
    fallbackReasons.push(`overall confidence score ${overallConfidenceScore}% is below 75% threshold`);
  }

  const shouldFallbackToGemini = fallbackReasons.length > 0;

  return {
    isAcceptableWithoutFallback: !shouldFallbackToGemini,
    shouldFallbackToGemini,
    fallbackReason:
      fallbackReasons.length > 0
        ? `Tesseract validation flagged: ${fallbackReasons.join('; ')}`
        : undefined,
    overallConfidenceScore,
    missingRowNumbers,
    unparsedCandidateCount,
    flaggedRowCount,
    flagsSummary,
  };
}

// ============================================================================
// HEADER EXTRACTION HELPERS (LASER CENTRAL & GCI AWARE)
// ============================================================================

const KNOWN_SUPPLIERS = [
  'Laser Central',
  'GCI',
  'GCI Group',
  'ShapeCut Precision Laser',
  'ShapeCut',
  'Precision Laser Cutting',
  'ProCut Laser Solutions',
  'Stelform Profiling',
  'BlueScope Steel',
  'Vulcan Steel',
  'Bystronic Profile Cutting',
  'Southern Steel',
  'Surdex Steel',
  'Apex Industrial',
  'Hardox Wearparts',
  'Atlas Steels',
];

function extractSupplier(lines: RawOcrLine[], supplierHint?: SupplierRuleId): string {
  const topLines = lines.slice(0, 18);
  const topJoined = topLines.map((l) => l.text).join('\n');

  if (/\blaser\s*central\b/i.test(topJoined)) {
    return 'Laser Central';
  }
  if (/\bgci\b|\bgolden\s*coast\s*industrial\b/i.test(topJoined)) {
    return 'GCI';
  }

  for (const line of topLines) {
    for (const known of KNOWN_SUPPLIERS) {
      if (line.text.toLowerCase().includes(known.toLowerCase())) {
        return known === 'GCI Group' ? 'GCI' : known;
      }
    }
  }

  for (const line of topLines) {
    const clean = line.text.trim();
    if (
      clean.length >= 3 &&
      clean.length <= 42 &&
      /(?:laser|gci|steel|profile|profiling|cutting|fabrication|metals|engineering|pty\s*ltd)/i.test(clean) &&
      !/(?:docket|invoice|page|delivery|tax|abn|date|order|packing|slip)/i.test(clean)
    ) {
      return clean.replace(/[^\w\s&.-]/g, '').trim();
    }
  }

  if (supplierHint === 'gci') return 'GCI';
  return 'Laser Central';
}

function extractDocketNumber(lines: RawOcrLine[], supplierProfile: SupplierRuleId): string {
  const topLines = lines.slice(0, 22);
  const topText = topLines.map((l) => l.text).join(' \n ');

  // 1. Line-by-line explicit labeled docket / delivery note / packing slip / invoice number
  // (Search within each line first so "PACKING SLIP" on line 1 doesn't consume "DOCKET" on line 2)
  const labelRegex =
    /(?:docket\s*(?:no|num|number|#)|delivery\s*(?:docket|note|no|num|#)|pack(?:ing)?\s*slip\s*(?:no|num|number|#)|tax\s*invoice\s*(?:no|num|number|#)|inv(?:oice)?\s*(?:no|num|number|#)|docket|d\/n|connote)\s*[:#.\- \t]+([A-Z0-9][A-Z0-9\-_/]{2,18})/i;

  for (const ln of topLines) {
    const m = ln.text.match(labelRegex);
    if (m && m[1]) {
      const candidate = m[1].replace(/[^\w\-/]/g, '').trim().toUpperCase();
      if (
        candidate.length >= 3 &&
        /\d/.test(candidate) &&
        !/^(?:DATE|PAGE|CUSTOMER|SUPPLIER|ORDER|NUMBER|SLIP|NOTE|DOCKET|INVOICE|DELIVERY|PACKING|GROUP|AUSTRALIA|PTY|LTD)$/i.test(
          candidate
        )
      ) {
        return candidate;
      }
    }
  }

  // 2. Prefixed docket / invoice / Laser Central / GCI reference
  const standaloneMatch = topText.match(
    /\b((?:DK|DN|PS|DEL|INV|LC|GCI|SO)-[A-Z0-9\-]{3,16})\b/i
  );
  if (standaloneMatch) {
    return standaloneMatch[1].toUpperCase();
  }

  // 3. Laser Central 6-digit docket barcode prefix if visible in lines (e.g. "894201-1" -> "894201")
  if (supplierProfile === 'laser_central') {
    const fullText = lines.map((l) => l.text).join(' ');
    const lcBarcodePrefix = fullText.match(/\b(\d{5,8})-0*1\b/);
    if (lcBarcodePrefix) {
      return `DK-${lcBarcodePrefix[1]}`;
    }
  }

  return `DK-${Math.floor(10000 + Math.random() * 90000)}`;
}

function extractDate(lines: RawOcrLine[]): string {
  const topText = lines.slice(0, 25).map((l) => l.text).join(' ');

  // ISO YYYY-MM-DD
  const isoMatch = topText.match(/\b(20\d{2})[/-](0[1-9]|1[0-2])[/-](0[1-9]|[12]\d|3[01])\b/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = topText.match(/\b(0?[1-9]|[12]\d|3[01])[/-](0?[1-9]|1[0-2])[/-](20\d{2}|\d{2})\b/);
  if (dmyMatch) {
    const d = dmyMatch[1].padStart(2, '0');
    const m = dmyMatch[2].padStart(2, '0');
    const y = dmyMatch[3].length === 2 ? `20${dmyMatch[3]}` : dmyMatch[3];
    return `${y}-${m}-${d}`;
  }

  return new Date().toISOString().split('T')[0];
}

function extractPalletCount(lines: RawOcrLine[]): number | undefined {
  const text = lines.map((l) => l.text).join(' ');
  const ofMatch = text.match(/\bpallet\s+\d{1,2}\s+of\s+(\d{1,2})\b/i);
  if (ofMatch) {
    const n = parseInt(ofMatch[1], 10);
    if (n > 0 && n <= 50) return n;
  }
  const match = text.match(/(?:total\s*)?(?:pallets|pallet\s*count|skids|bundles|packs)\s*[:#=\s]+(\d{1,2})\b/i);
  if (match && match[1]) {
    const val = parseInt(match[1], 10);
    if (!Number.isNaN(val) && val > 0 && val < 50) return val;
  }
  return undefined;
}

function extractCarrier(lines: RawOcrLine[]): string | undefined {
  for (const line of lines.slice(0, 25)) {
    const match = line.text.match(
      /(?:carrier|transport|freight|courier|via|despatch\s*via)\s*[:#\-]\s*([A-Za-z0-9\s&.\-]{3,32})/i
    );
    if (match && match[1]) {
      const cleaned = match[1]
        .split(/\s{2,}|\b(?:order|po|date|pallet|docket)\b/i)[0]
        .trim();
      if (cleaned.length >= 3) return cleaned;
    }
  }
  return undefined;
}

function extractOrderNumber(lines: RawOcrLine[]): string | undefined {
  const text = lines.slice(0, 25).map((l) => l.text).join(' \n ');
  const match = text.match(
    /(?:purchase\s*order|cust(?:omer)?\s*po|order\s*(?:no|num|#)|po\s*(?:no|num|#)?|job\s*(?:no|#))\s*[:#.\-\s]+([A-Z0-9][A-Z0-9\-_]{2,16})/i
  );
  if (match && match[1]) {
    const cand = match[1].trim().toUpperCase();
    if (!/^(?:DATE|NO|NUMBER|DELIVERY|DOCKET)$/i.test(cand)) {
      return cand;
    }
  }
  const poPrefix = text.match(/\b(PO-[A-Z0-9\-]{3,14})\b/i);
  if (poPrefix) return poPrefix[1].toUpperCase();
  return undefined;
}

// ============================================================================
// POSITIONAL COLUMN HEADER LAYOUT ANALYZER & SUPPLIER TABLE PARSER
// ============================================================================

const HEADER_TOKEN_MAP: Array<{
  key: TableColumnBand['key'];
  pattern: RegExp;
}> = [
  { key: 'no', pattern: /^(?:no\.?|item|item\s*no\.?|line|pos|#|sr|seq)$/i },
  { key: 'partNumber', pattern: /^(?:part|part\s*no\.?|part\s*#|part\s*number|drawing|drawing\s*no\.?|dwg|dwg\s*no\.?|item\s*code|code|mark|profile)$/i },
  { key: 'revision', pattern: /^(?:rev|revision|ver)$/i },
  { key: 'description', pattern: /^(?:description|part\s*description|item\s*description|desc|details|name)$/i },
  { key: 'material', pattern: /^(?:material|mat|grade|alloy|spec)$/i },
  { key: 'thickness', pattern: /^(?:thk|thick|thickness|gauge|ga)$/i },
  { key: 'dimensions', pattern: /^(?:size|dim|dimensions|length|width|l\s*x\s*w)$/i },
  { key: 'weight', pattern: /^(?:wt|weight|mass|kg)$/i },
  { key: 'quantity', pattern: /^(?:qty|oty|qtv|otv|quantity|shipped|delivered|supplied|ord|ordered|req|units)$/i },
  { key: 'pallet', pattern: /^(?:pallet|plt|skid|pack|bundle|alloc)$/i },
];

/**
 * Inspects the top 65% of lines to locate the table column header row and record
 * each column's horizontal X-coordinate band (using word bounding boxes or character offsets).
 */
export function detectTableColumnLayout(lines: RawOcrLine[]): TableColumnLayout | undefined {
  const maxIdx = Math.min(lines.length, Math.max(12, Math.ceil(lines.length * 0.65)));

  for (let i = 0; i < maxIdx; i++) {
    const line = lines[i];
    const raw = line.text.trim();
    if (raw.length < 6) continue;

    // Split header into segments either by positioned words or by 2+ spaces / pipe characters
    const segments: Array<{ text: string; x0: number; x1: number }> = [];

    if (line.words && line.words.length >= 2) {
      // Merge adjacent words that are very close horizontally (e.g. "Part" + "No" or "Drawing" + "No")
      let current: { text: string; x0: number; x1: number } | null = null;
      for (const w of line.words) {
        const cleanW = w.text.replace(/[|:]/g, '').trim();
        if (!cleanW) continue;
        const charW = Math.max(4, (w.bbox.x1 - w.bbox.x0) / Math.max(1, cleanW.length));
        if (current && w.bbox.x0 - current.x1 <= charW * 1.6) {
          const combinedCandidate = `${current.text} ${cleanW}`;
          // Only merge if the combined phrase matches a known two-word header
          if (
            /^(?:part\s*(?:no|number|#|description)|drawing\s*(?:no|number|#)|dwg\s*(?:no|number|#)|item\s*(?:no|code|description)|del\s*qty|ord\s*qty|pack\s*no)$/i.test(
              combinedCandidate
            )
          ) {
            current.text = combinedCandidate;
            current.x1 = w.bbox.x1;
            continue;
          }
        }
        if (current) segments.push(current);
        current = { text: cleanW, x0: w.bbox.x0, x1: w.bbox.x1 };
      }
      if (current) segments.push(current);
    } else {
      // Character-offset positional fallback when multi-space or pipe columns are present
      const parts = raw.split(/\s{2,}|\|/);
      let cursor = 0;
      for (const p of parts) {
        const trimmed = p.trim();
        if (!trimmed) continue;
        const idx = raw.indexOf(trimmed, cursor);
        const x0 = idx >= 0 ? idx * 8 : cursor * 8;
        const x1 = x0 + trimmed.length * 8;
        cursor = idx >= 0 ? idx + trimmed.length : cursor + trimmed.length;
        segments.push({ text: trimmed, x0, x1 });
      }
    }

    const matchedCols: TableColumnBand[] = [];
    const usedKeys = new Set<TableColumnBand['key']>();

    for (const seg of segments) {
      const cleanSeg = seg.text.replace(/^[^A-Za-z0-9#]+|[^A-Za-z0-9#]+$/g, '').trim();
      if (!cleanSeg) continue;

      for (const rule of HEADER_TOKEN_MAP) {
        if (!usedKeys.has(rule.key) && rule.pattern.test(cleanSeg)) {
          usedKeys.add(rule.key);
          matchedCols.push({
            key: rule.key,
            x0: seg.x0,
            x1: seg.x1,
            xCenter: (seg.x0 + seg.x1) / 2,
          });
          break;
        }
      }
    }

    // Also handle single-space separated headers when words weren't pre-segmented
    if (matchedCols.length < 3) {
      if (line.words && line.words.length >= 3) {
        const wordCols: TableColumnBand[] = [];
        const wordKeys = new Set<TableColumnBand['key']>();
        for (const w of line.words) {
          const cleanTok = w.text.replace(/[^A-Za-z0-9#]/g, '');
          if (!cleanTok) continue;
          for (const rule of HEADER_TOKEN_MAP) {
            if (!wordKeys.has(rule.key) && rule.pattern.test(cleanTok)) {
              wordKeys.add(rule.key);
              wordCols.push({
                key: rule.key,
                x0: w.bbox.x0,
                x1: w.bbox.x1,
                xCenter: (w.bbox.x0 + w.bbox.x1) / 2,
              });
              break;
            }
          }
        }
        if (
          wordCols.length >= 3 &&
          (wordKeys.has('partNumber') || wordKeys.has('description')) &&
          wordKeys.has('quantity')
        ) {
          return {
            headerLineIndex: i,
            columns: wordCols.sort((a, b) => a.x0 - b.x0),
            hasPositionalCoords: true,
          };
        }
      }

      const tokens = raw.split(/\s+/);
      let charPos = 0;
      const fallbackCols: TableColumnBand[] = [];
      const fallbackKeys = new Set<TableColumnBand['key']>();
      for (const tok of tokens) {
        const cleanTok = tok.replace(/[^A-Za-z0-9#]/g, '');
        const x0 = charPos * 8;
        const x1 = (charPos + tok.length) * 8;
        charPos += tok.length + 1;
        for (const rule of HEADER_TOKEN_MAP) {
          if (!fallbackKeys.has(rule.key) && rule.pattern.test(cleanTok)) {
            fallbackKeys.add(rule.key);
            fallbackCols.push({
              key: rule.key,
              x0,
              x1,
              xCenter: (x0 + x1) / 2,
            });
            break;
          }
        }
      }
      if (
        fallbackCols.length >= 3 &&
        (fallbackKeys.has('partNumber') || fallbackKeys.has('description')) &&
        fallbackKeys.has('quantity')
      ) {
        return {
          headerLineIndex: i,
          columns: fallbackCols.sort((a, b) => a.x0 - b.x0),
          // Character-offset columns must NOT be compared against pixel word bounding boxes
          hasPositionalCoords: false,
        };
      }
    }

    if (
      matchedCols.length >= 3 &&
      (usedKeys.has('partNumber') || usedKeys.has('description')) &&
      usedKeys.has('quantity')
    ) {
      return {
        headerLineIndex: i,
        columns: matchedCols.sort((a, b) => a.x0 - b.x0),
        hasPositionalCoords: Boolean(line.words && line.words.length > 0),
      };
    }
  }

  return undefined;
}

/**
 * Tests whether a text line is a barcode, docket-level metadata, header, or footer (NOT a part)
 */
function isBarcodeOrMetadataLine(
  text: string,
  docketNumber: string,
  orderNumber?: string
): boolean {
  const clean = text.trim();
  const lower = clean.toLowerCase();

  if (clean.length < 3) return true;

  // 1. Reject OCR barcode bar artifacts
  const pipeOrBarChars = (clean.match(/[|!Il1*]/g) || []).length;
  if (pipeOrBarChars >= 6 && pipeOrBarChars / clean.length > 0.45) {
    return true;
  }

  // 2. Reject standalone barcode numbers or asterisk-wrapped codes
  if (/^\*?[0-9A-Z\-]{5,22}\*?$/i.test(clean)) {
    return true;
  }

  // 3. Reject lines that are just header metadata
  if (
    docketNumber &&
    lower.includes(docketNumber.toLowerCase()) &&
    !/(?:mm|plate|gusset|flange|bracket|gr|grade|ss|steel|qty|ea|pcs|pallet|rib|cleat|lug|shim)/i.test(clean)
  ) {
    return true;
  }
  if (
    orderNumber &&
    lower.includes(orderNumber.toLowerCase()) &&
    !/(?:mm|plate|gusset|flange|bracket|gr|grade|ss|steel|qty|ea|pcs|pallet|rib|cleat|lug|shim)/i.test(clean)
  ) {
    return true;
  }

  // 4. Reject document titles, address blocks, contact details, and signature footers
  if (
    /^(?:tax\s*invoice|delivery\s*docket|packing\s*slip|delivery\s*advice|despatch\s*note|consignment|connote|manifest)/i.test(lower) ||
    /^(?:bill\s*to|ship\s*to|deliver\s*to|sold\s*to|consignee|customer|supplier\s*:|from\s*:|to\s*:)/i.test(lower) ||
    /^(?:carrier|transport|freight|truck|driver|rego|despatch|dispatch)\s*[:\-]/i.test(lower) ||
    /^(?:subtotal|sub-total|total|total\s*parts|total\s*weight|total\s*qty|gst|balance\s*due|amount\s*due|page\s*\d+|continued|end\s*of\s*docket)/i.test(lower) ||
    /^(?:received\s*by|authorised\s*by|checked\s*by|signature|print\s*name|date\s*:|driver\s*sign|received\s*in\s*good)/i.test(lower) ||
    /(?:abn\s*\d|acn\s*\d|phone\s*:|tel\s*:|fax\s*:|email\s*:|www\.|http|pty\s*ltd|street\b|road\b|ave\b|drive\b|blvd\b|\b(?:qld|nsw|vic|wa|sa|tas)\s+\d{4}\b)/i.test(lower)
  ) {
    return true;
  }

  // 5. Reject table column header rows
  const headerKeywords = [
    'no',
    'part',
    'item',
    'description',
    'desc',
    'rev',
    'revision',
    'qty',
    'quantity',
    'ordered',
    'shipped',
    'delivered',
    'supplied',
    'material',
    'grade',
    'thick',
    'thickness',
    'thk',
    'drawing',
    'dwg',
    'weight',
    'unit',
    'size',
    'dimensions',
    'pallet',
  ];
  const words = lower.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  const matchedHeaders = words.filter((w) => headerKeywords.includes(w));
  if (matchedHeaders.length >= 3 && matchedHeaders.length >= words.length * 0.5) {
    return true;
  }

  return false;
}

const STEEL_PART_KEYWORDS = [
  'PLATE',
  'FLANGE',
  'GUSSET',
  'BRACKET',
  'STIFFENER',
  'CLEAT',
  'SPLICE',
  'BASE',
  'BASEPLATE',
  'COVER',
  'WASHER',
  'BEAM',
  'CHANNEL',
  'ANGLE',
  'PROFILE',
  'RING',
  'SHIM',
  'RIB',
  'END CAP',
  'CAP',
  'POST',
  'WEB',
  'LIP',
  'CHUTE',
  'LUG',
  'PAD',
  'HOOP',
  'MOUNT',
  'MOUNTING',
  'FRAME',
  'LINER',
  'BAFFLE',
  'COLLAR',
  'DISC',
  'BAR',
  'STRIP',
  'PANEL',
  'SIDE',
  'TOP',
  'BOTTOM',
  'SUPPORT',
  'HANGER',
  'CLAMP',
  'RAIL',
  'CHASSIS',
];

function extractTableItemsWithLayout(
  lines: RawOcrLine[],
  pageNumber: number,
  docketNumber: string,
  supplierProfile: SupplierRuleId,
  orderNumber?: string
): {
  items: ExtractedDocketItem[];
  unparsedCandidateCount: number;
  columnLayout?: TableColumnLayout;
} {
  const items: ExtractedDocketItem[] = [];
  let currentPallet = `Pallet ${pageNumber}`;
  let unparsedCandidateCount = 0;

  const columnLayout = detectTableColumnLayout(lines);
  const tableStartIndex = columnLayout ? columnLayout.headerLineIndex + 1 : 0;
  const candidateLines = lines.slice(tableStartIndex);

  for (let i = 0; i < candidateLines.length; i++) {
    const line = candidateLines[i];
    const text = line.text.trim();

    // Stop if we hit a clear document footer block
    if (/^(?:received\s*in\s*good\s*order|customer\s*signature|authorised\s*signature|end\s*of\s*packing\s*slip)/i.test(text)) {
      break;
    }

    // Check for standalone pallet section divider (e.g., "PALLET 2", "PALLET 2 OF 6", "SKID 1")
    const palletHeaderMatch = text.match(
      /^(?:pallet|bundle|pack|skid)\s*#?\s*(\d{1,2})(?:\s*of\s*(\d{1,2}))?$/i
    );
    if (palletHeaderMatch) {
      currentPallet = palletHeaderMatch[2]
        ? `Pallet ${palletHeaderMatch[1]} of ${palletHeaderMatch[2]}`
        : `Pallet ${palletHeaderMatch[1]}`;
      continue;
    }

    if (isBarcodeOrMetadataLine(text, docketNumber, orderNumber)) {
      continue;
    }

    const item = parsePositionalAndSupplierLineItem(
      line,
      currentPallet,
      items.length + 1,
      docketNumber,
      supplierProfile,
      columnLayout
    );

    if (item) {
      item.pageNumber = line.pageNumber ?? pageNumber;
      item.bbox = line.bbox;
      // Consume 1 or more detail/description continuation lines immediately following this part row
      while (i + 1 < candidateLines.length) {
        const nextLine = candidateLines[i + 1];
        const nextText = nextLine.text.trim();
        if (isDetailContinuationLine(nextLine, docketNumber, orderNumber, columnLayout)) {
          mergeContinuationDetails(item, nextText);
          i++; // Consume continuation line
        } else {
          break;
        }
      }
      items.push(item);
    } else if (looksLikeUnparsedTableCandidateLine(text)) {
      unparsedCandidateCount++;
    }
  }

  // Fallback: if tableStartIndex skipped earlier valid rows, scan all lines
  if (items.length === 0 && tableStartIndex > 0) {
    unparsedCandidateCount = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const text = line.text.trim();
      if (!isBarcodeOrMetadataLine(text, docketNumber, orderNumber)) {
        const item = parsePositionalAndSupplierLineItem(
          line,
          currentPallet,
          items.length + 1,
          docketNumber,
          supplierProfile,
          undefined
        );
        if (item) {
          item.pageNumber = line.pageNumber ?? pageNumber;
          item.bbox = line.bbox;
          items.push(item);
        }
      }
    }
  }

  return { items, unparsedCandidateCount, columnLayout };
}

function looksLikeUnparsedTableCandidateLine(text: string): boolean {
  const clean = text.trim();
  if (clean.length < 6) return false;
  // Starts with a row index or part-like code and ends with a number, or contains thickness/grade tokens
  if (/^\d{1,3}\s+\S+/.test(clean) && /\d+\s*$/.test(clean)) return true;
  if (/\b\d{1,2}(?:\.\d)?\s*mm\b/i.test(clean) && /\b\d{1,4}\s*$/.test(clean)) return true;
  return false;
}

function isDetailContinuationLine(
  nextLine: RawOcrLine,
  docketNumber: string,
  orderNumber?: string,
  columnLayout?: TableColumnLayout
): boolean {
  const text = (nextLine?.text || '').trim();
  if (!text || text.length < 4) return false;
  if (isBarcodeOrMetadataLine(text, docketNumber, orderNumber)) return false;

  // Reject if it's a pallet section divider
  if (/^(?:pallet|bundle|pack|skid)\s*#?\s*\d{1,2}(?:\s*of\s*\d{1,2})?$/i.test(text)) {
    return false;
  }

  // Reject if it starts with a row number or barcode item code (e.g., "1 LC-1001 ...", "894201-2 ...", "BAR-201 ...")
  if (
    /^(?:\d{1,3}[.)\s]+\S+|\d{4,8}-0*\d{1,4}\b|(?:BC|ITM|BAR|LCR|LINE)-\d{2,8}\b)/i.test(
      text
    )
  ) {
    return false;
  }

  // Reject if it contains a new structured part code AND ends with a numeric quantity
  const hasNewPartCode = /\b([A-Z]{2,6}-[A-Z0-9\-_]{2,14})\b/.test(text);
  if (hasNewPartCode) {
    return false;
  }

  // If positional column layout and word bounding boxes are available, check if words sit inside the description/spec area
  // (and NOT in the 'no' or 'quantity' columns)
  if (columnLayout?.hasPositionalCoords && nextLine.words && nextLine.words.length > 0) {
    const cells = extractColumnCellsFromLayout(nextLine, columnLayout);
    if (cells && !cells.no && !cells.partNumber && !cells.quantity && (cells.description || cells.material || cells.dimensions)) {
      return true;
    }
  }

  const hasDetailSpec =
    /\b(?:\d{1,2}(?:\.\d)?\s*mm|\d+\/\d+\s*["″]|250\s*gr|350\s*gr|g250|g350|ha350|hardox|stainless|304|316|mild\s*steel|\d{2,4}\s*[xX]\s*\d{2,4}|\d+(?:\.\d+)?\s*kg|pallet\s*\d+|rev\s*[a-z0-9])\b/i.test(
      text
    );
  if (hasDetailSpec) return true;

  // Pure multi-line description wrap: contains alphabetic words, does not start with a number, and does not end with a standalone quantity
  const isPureDescriptionContinuation =
    /^[A-Za-z(]/.test(text) &&
    /[A-Za-z]{3,}/.test(text) &&
    !/\s+\d{1,4}(?:\.00)?\s*$/.test(text);

  return isPureDescriptionContinuation;
}

function mergeContinuationDetails(item: ExtractedDocketItem, continuationText: string): void {
  const details = extractPartSpecifications(continuationText);
  if (details.thickness && !item.thickness) item.thickness = details.thickness;
  if (details.material && !item.material) item.material = details.material;
  if (details.dimensions && !item.dimensions) item.dimensions = details.dimensions;
  if (details.weight && !item.weight) item.weight = details.weight;
  if (details.revision && !item.revision) {
    item.revision = details.revision;
    item.rev = details.revision;
  }
  if (details.palletNumber && (!item.palletNumber || item.palletNumber === 'Pallet 1')) {
    item.palletNumber = details.palletNumber;
  }

  const extraDesc = continuationText
    .replace(/\b(?:material|grade|thick|thickness|size|dim|dimensions|weight|wt|rev|revision|pallet)\s*[:.]?/gi, '')
    .trim();
  if (extraDesc && !item.description.toLowerCase().includes(extraDesc.toLowerCase())) {
    item.description = `${item.description} · ${extraDesc}`.slice(0, 120);
    if (item.originalOcrValues) {
      item.originalOcrValues.description = item.description;
    }
  }
}

/**
 * Extracts material, thickness, dimensions, weight, revision, and pallet allocation from a text string.
 * Supports metric (mm) and imperial/inch (1/2", 3/8", 0.5") measurements.
 */
export function extractPartSpecifications(rawInput: string): {
  thickness?: string;
  material?: string;
  dimensions?: string;
  weight?: string;
  revision?: string;
  palletNumber?: string;
} {
  const text = rawInput.replace(/[“”″]/g, '"').replace(/[‘’′]/g, "'");

  // Thickness: e.g. 10mm, 12.0mm, 6 mm, PL10, 10PL, or inch fractions 1/2", 3/8", 1/4", 3/4"
  const metricThicknessMatch =
    text.match(/\b(\d{1,2}(?:\.\d)?\s*mm)\b/i) ||
    text.match(/\bPL\s*(\d{1,2}(?:\.\d)?)\b/i);
  const inchThicknessMatch = text.match(/\b(\d\/\d{1,2}|\d{1,2}\s+\d\/\d{1,2}|0\.\d{2,3})\s*"/);
  const thickness = metricThicknessMatch
    ? metricThicknessMatch[1].toLowerCase().endsWith('mm')
      ? metricThicknessMatch[1].toLowerCase().replace(/\s+/g, '')
      : `${metricThicknessMatch[1]}mm`
    : inchThicknessMatch
    ? `${inchThicknessMatch[1].replace(/\s+/g, '-')}"`
    : undefined;

  // Material Grade: e.g. G250, G350, 350Gr, 250 Grade Steel, HA350, Hardox 450, 316 Stainless, 304SS, Mild Steel
  const materialMatch = text.match(
    /\b(G\s*250|G\s*350|350\s*Gr(?:ade)?(?:\s*Steel)?|250\s*Gr(?:ade)?(?:\s*Steel)?|Gr(?:ade)?\s*350|Gr(?:ade)?\s*250|HA\s*250|HA\s*350|HW\s*350|Hardox\s*\d{3}(?:\s*Wear\s*Plate)?|Bisalloy\s*\d{2,3}|316L?\s*(?:SS|Stainless(?:\s*Steel)?)|304L?\s*(?:SS|Stainless(?:\s*Steel)?)|Mild\s*Steel(?:\s*\d{3})?|Stainless\s*Steel|High\s*Tensile\s*\d{3}|Aluminium\s*\d{4}|Alum\s*\d{4}|Galv(?:anised)?|Corten|AS\s*3678(?:-\d{3})?|A36)\b/i
  );
  const material = materialMatch ? materialMatch[1].replace(/\s+/g, ' ').trim() : undefined;

  // Dimensions: e.g. 400x400, 1200 x 350, 450x200x10, 250x150mm, or inch dimensions 12" x 24"
  const dimMatch =
    text.match(/\b(\d{2,5}\s*[xX*]\s*\d{2,5}(?:\s*[xX*]\s*\d{1,3})?(?:\s*mm)?)\b/) ||
    text.match(/\b(\d{1,4}(?:\.\d+)?\s*"\s*[xX*]\s*\d{1,4}(?:\.\d+)?\s*")/);
  const dimensions = dimMatch ? dimMatch[1].replace(/\s+/g, '') : undefined;

  // Weight: e.g. 4.2kg, 18.5 kg, 120kg
  const weightMatch = text.match(/\b(\d{1,4}(?:\.\d{1,2})?\s*kg)\b/i);
  const weight = weightMatch ? weightMatch[1].toLowerCase().replace(/\s+/g, '') : undefined;

  // Explicit Revision: e.g. "Rev A", "REV: 02", "Rev. B"
  const revMatch = text.match(/\b(?:rev(?:ision)?\.?\s*[:\-]?\s*)([A-Z0-9]{1,3})\b/i);
  const revision =
    revMatch && !/^(?:MM|KG|EA|GR|NO|OF)$/i.test(revMatch[1])
      ? revMatch[1].toUpperCase()
      : undefined;

  // Explicit Pallet allocation on row: e.g. "Pallet 2", "Pallet 1 of 6", "Plt 3", "Skid 2"
  const palletMatch = text.match(
    /\b(?:pallet|plt|skid|pack)\s*#?\s*(\d{1,2}(?:\s*of\s*\d{1,2})?)\b/i
  );
  const palletNumber = palletMatch ? `Pallet ${palletMatch[1].replace(/\s+/g, ' ')}` : undefined;

  return { thickness, material, dimensions, weight, revision, palletNumber };
}

/**
 * Assigns words from a line to detected table columns using midpoint territory boundaries
 * in pixel/coordinate space when `layout.hasPositionalCoords` is true.
 * Never mixes character offsets with pixel coordinates and handles arbitrary page resolutions (600px - 3000px).
 */
function extractColumnCellsFromLayout(
  line: RawOcrLine,
  layout?: TableColumnLayout
): Partial<Record<TableColumnBand['key'], string>> | null {
  if (!layout || layout.columns.length < 3) return null;

  // Case A: Word-level bounding boxes available in the same coordinate space as header columns
  if (layout.hasPositionalCoords && line.words && line.words.length >= 2) {
    const sortedCols = [...layout.columns].sort((a, b) => a.x0 - b.x0);
    const buckets: Partial<Record<TableColumnBand['key'], string[]>> = {};

    // Compute average horizontal gap between adjacent column centers to scale tolerance to page resolution
    let totalCenterSpan = 0;
    for (let i = 1; i < sortedCols.length; i++) {
      totalCenterSpan += Math.max(20, sortedCols[i].xCenter - sortedCols[i - 1].xCenter);
    }
    const avgColSpacing =
      sortedCols.length > 1 ? totalCenterSpan / (sortedCols.length - 1) : 140;

    // Build contiguous horizontal territory [leftBound, rightBound] for each column using midpoints
    const territories = sortedCols.map((col, idx) => {
      const prev = idx > 0 ? sortedCols[idx - 1] : null;
      const next = idx < sortedCols.length - 1 ? sortedCols[idx + 1] : null;

      const leftBound = prev
        ? (Math.max(prev.x0, prev.x1) + col.x0) / 2
        : Math.max(0, col.x0 - Math.max(80, avgColSpacing * 0.85));

      const rightBound = next
        ? (col.x1 + Math.min(next.x0, next.x1)) / 2
        : col.x1 + Math.max(120, avgColSpacing * 0.95);

      return {
        key: col.key,
        leftBound,
        rightBound,
        x0: col.x0,
        x1: col.x1,
        xCenter: col.xCenter,
      };
    });

    for (const w of line.words) {
      const cleanW = w.text.replace(/^\||\|$/g, '').trim();
      if (!cleanW) continue;
      // Ignore standalone currency values from unmapped invoice price columns
      if (/^\$\d+(?:,\d{3})*(?:\.\d{2})?$/.test(cleanW)) continue;
      const wCenter = (w.bbox.x0 + w.bbox.x1) / 2;

      // 1. Check if wCenter falls inside a column's horizontal territory [leftBound, rightBound]
      let assignedKey: TableColumnBand['key'] | null = null;
      for (const terr of territories) {
        if (wCenter >= terr.leftBound && wCenter <= terr.rightBound) {
          assignedKey = terr.key;
          break;
        }
      }

      // 2. Fallback to nearest column if within reasonable resolution-scaled distance
      if (!assignedKey) {
        let bestDist = Infinity;
        let bestKey = territories[0].key;
        for (const terr of territories) {
          const dist = Math.min(
            Math.abs(wCenter - terr.x0),
            Math.abs(wCenter - terr.x1),
            Math.abs(wCenter - terr.xCenter)
          );
          if (dist < bestDist) {
            bestDist = dist;
            bestKey = terr.key;
          }
        }
        if (bestDist <= Math.max(120, avgColSpacing * 0.9)) {
          assignedKey = bestKey;
        }
      }

      if (assignedKey) {
        if (!buckets[assignedKey]) buckets[assignedKey] = [];
        buckets[assignedKey]!.push(cleanW);
      }
    }

    const result: Partial<Record<TableColumnBand['key'], string>> = {};
    for (const [k, arr] of Object.entries(buckets)) {
      result[k as TableColumnBand['key']] = (arr || []).join(' ').trim();
    }
    return result;
  }

  // Case B: Multi-space (`   `) or pipe (`|`) delimited tabular segments matching column count
  const segments = line.text
    .split(/\s{2,}|\|/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length === layout.columns.length) {
    const result: Partial<Record<TableColumnBand['key'], string>> = {};
    for (let i = 0; i < layout.columns.length; i++) {
      result[layout.columns[i].key] = segments[i];
    }
    return result;
  }

  return null;
}

/**
 * Parses a single table row using positional column cells (when available) + deterministic
 * Laser Central and GCI supplier patterns.
 */
function parsePositionalAndSupplierLineItem(
  rawLine: RawOcrLine,
  defaultPalletNumber: string,
  lineIndex: number,
  docketNumber: string,
  supplierProfile: SupplierRuleId,
  columnLayout?: TableColumnLayout
): ExtractedDocketItem | null {
  const rawText = rawLine.text;
  const ocrConfidence = rawLine.confidence;
  const line = rawText.replace(/[|]/g, '   ').trim();

  if (line.length < 4 || /^[\d\s\-*]+$/.test(line)) {
    return null;
  }

  const specs = extractPartSpecifications(line);
  const colCells = extractColumnCellsFromLayout(rawLine, columnLayout);

  let foundSteelKeyword = '';
  for (const kw of STEEL_PART_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(line)) {
      foundSteelKeyword = kw;
      break;
    }
  }

  let itemNumber = '';
  let partNumber = '';
  let revision = specs.revision;
  let material = specs.material;
  let thickness = specs.thickness;
  let dimensions = specs.dimensions;
  let weight = specs.weight;
  let palletNumber = specs.palletNumber || defaultPalletNumber;
  let quantity: number | null = null;
  let description = '';

  // 1. If positional column cells were mapped, extract structured fields from them first
  if (colCells) {
    if (colCells.no) {
      const cleanNo = colCells.no
        .replace(/^(?:ITM|ITEM|LINE|POS|NO\.?|#)\s*[-:]?\s*/i, '')
        .replace(/^\d{4,8}-0*(\d{1,4})$/, '$1')
        .trim();
      if (/^(?:\d{1,4}[A-Z]?|(?:BAR|ITM|BC)-\d{2,8})$/i.test(cleanNo)) {
        itemNumber = cleanNo.replace(/^0+(?=\d)/, '').toUpperCase();
      }
    }

    if (colCells.partNumber) {
      const candPart = colCells.partNumber
        .replace(/^["'“”‘’″′]+|["'“”‘’″′]+$/g, '')
        .replace(/\.(?:dxf|dwg|nc1|step|stp)$/i, '')
        .trim()
        .toUpperCase();
      if (candPart.length >= 2 && !/^(?:PART|ITEM|DESCRIPTION|QTY|TOTAL)$/i.test(candPart)) {
        // Sometimes "No" + "Part Number" fall into the same cell if close together (e.g. "1 LC-1001")
        const splitNoAndPart = candPart.match(/^(\d{1,3})\s+([A-Z0-9][A-Z0-9\-_./]{2,24})$/);
        if (splitNoAndPart && !itemNumber) {
          itemNumber = splitNoAndPart[1];
          partNumber = splitNoAndPart[2].replace(/^["'“”‘’″′]+|["'“”‘’″′]+$/g, '');
        } else if (/^[A-Z0-9][A-Z0-9\-_./]{1,26}$/.test(candPart)) {
          partNumber = candPart;
        }
      }
    }

    if (colCells.revision) {
      const candRev = colCells.revision.replace(/^(?:REV\.?|REVISION)\s*[:\-]?\s*/i, '').trim().toUpperCase();
      if (/^[A-Z0-9]{1,3}$/.test(candRev) && !/^(?:MM|KG|EA)$/i.test(candRev)) {
        revision = candRev;
      }
    }

    if (colCells.material && !material) {
      const mSpec = extractPartSpecifications(colCells.material);
      material = mSpec.material || colCells.material.trim();
    }

    if (colCells.thickness && !thickness) {
      const tSpec = extractPartSpecifications(colCells.thickness);
      thickness =
        tSpec.thickness ||
        (/^\d{1,2}(?:\.\d)?$/.test(colCells.thickness.trim())
          ? `${colCells.thickness.trim()}mm`
          : colCells.thickness.trim());
    }

    if (colCells.dimensions && !dimensions) {
      dimensions = colCells.dimensions.trim();
    }

    if (colCells.weight && !weight) {
      weight = colCells.weight.trim();
    }

    if (colCells.pallet) {
      const pMatch = colCells.pallet.match(/(\d{1,2}(?:\s*of\s*\d{1,2})?)/i);
      palletNumber = pMatch ? `Pallet ${pMatch[1]}` : colCells.pallet.trim();
    }

    if (colCells.quantity) {
      let qClean = colCells.quantity
        .replace(/\b(?:ea|pcs|units|off|no)\b/gi, '')
        .trim();
      // Normalize common OCR digit confusions inside the dedicated Quantity column (e.g. 'B' -> '8', 'S' -> '5', '1O' -> '10')
      if (/^[0-9OIlZSB]{1,3}$/i.test(qClean) && !/^\d+$/.test(qClean)) {
        qClean = qClean
          .toUpperCase()
          .replace(/O/g, '0')
          .replace(/[IL]/g, '1')
          .replace(/Z/g, '2')
          .replace(/S/g, '5')
          .replace(/B/g, '8');
      }
      // Handle "Ordered 4 / Shipped 4" or simple numeric "4" or "4.00"
      const slashMatch = qClean.match(/(\d{1,4})\s*$/);
      if (slashMatch) {
        const parsedQ = parseInt(slashMatch[1], 10);
        if (!Number.isNaN(parsedQ) && parsedQ > 0 && parsedQ <= 10000) {
          quantity = parsedQ;
        }
      }
    }

    if (colCells.description) {
      description = colCells.description.trim();
    }
  }

  // 2. Fallback / Supplement with deterministic token & supplier regex parsing across the line
  const cleanSingleSpaceLine = line.replace(/\s+/g, ' ').trim();
  let workingLine = cleanSingleSpaceLine;

  // Remove trailing Pallet token from workingLine so "Pallet 1" isn't mistaken for Quantity = 1!
  if (specs.palletNumber) {
    workingLine = workingLine
      .replace(/\b(?:pallet|plt|skid|pack)\s*#?\s*\d{1,2}(?:\s*of\s*\d{1,2})?\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Extract Item Number if not already resolved from column layout
  if (!itemNumber) {
    // Laser Central barcode-style item number (e.g. "894201-14" or "5500-2")
    const lcItemBarcodeMatch = workingLine.match(/^(\d{4,8})-0*(\d{1,4})\b/);
    if (lcItemBarcodeMatch) {
      itemNumber = lcItemBarcodeMatch[2];
      workingLine = workingLine.replace(lcItemBarcodeMatch[0], ' ').trim();
    } else {
      const explicitItemMatch = workingLine.match(/\b((?:BC|ITM|BAR|LCR|LINE)-\d{2,8})\b/i);
      if (explicitItemMatch) {
        itemNumber = explicitItemMatch[1].toUpperCase();
        workingLine = workingLine.replace(explicitItemMatch[0], ' ').trim();
      } else {
        const leadingIndexMatch = workingLine.match(/^(\d{1,3})[.)\s]+(.+)$/);
        if (leadingIndexMatch) {
          const idxNum = parseInt(leadingIndexMatch[1], 10);
          if (idxNum > 0 && idxNum <= 999) {
            itemNumber = String(idxNum);
            workingLine = leadingIndexMatch[2].trim();
          }
        }
      }
    }
  } else {
    // Strip the leading itemNumber from workingLine if it starts with it
    workingLine = workingLine
      .replace(new RegExp(`^(?:0*${itemNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})[.)\\s]+`, 'i'), '')
      .trim();
  }

  // Extract Part Number if not already resolved from column layout
  if (!partNumber) {
    const dxfMatch = workingLine.match(/\b([A-Za-z0-9][A-Za-z0-9\-_./]{1,24})\.(?:dxf|dwg|nc1|step|stp)\b/i);
    if (dxfMatch) {
      partNumber = dxfMatch[1].toUpperCase();
    }
  }

  if (!partNumber) {
    // Hyphenated or underscored part identifier (Laser Central & GCI standard: e.g. LASER-BRK-2048, GCI-900, FLG-150-PN16, LC-1001, PLT-105)
    const structuredPartMatches = workingLine.match(
      /\b([A-Z0-9]{1,10}(?:[-_][A-Z0-9]{1,12})+)\b/gi
    );
    if (structuredPartMatches) {
      for (const candidate of structuredPartMatches) {
        const upper = candidate.toUpperCase();
        if (upper === docketNumber.toUpperCase()) continue;
        if (/^\d{1,2}-\d{1,2}-\d{2,4}$/.test(upper)) continue;
        if (/^(?:AS-\d+|GR-\d+|G-\d+|REV-[A-Z0-9]+)$/i.test(upper)) continue;
        if (upper === itemNumber) continue;
        partNumber = upper;
        break;
      }
    }
  }

  if (!partNumber) {
    const alphaNumMatches = workingLine.match(
      /\b([A-Z]{1,6}\d{1,6}[A-Z0-9]{0,4}|\d{2,6}[A-Z]{1,4})\b/gi
    );
    if (alphaNumMatches) {
      for (const candidate of alphaNumMatches) {
        const upper = candidate.toUpperCase();
        if (/^\d+(?:MM|CM|M|KG|G|LB|EA|PC|PCS|GR|OFF|X\d+)$/i.test(upper)) continue;
        if (/^(?:G250|G350|GR250|GR350|HA350|HW350|SS304|SS316|304SS|316SS|AS3678|AS4100|Q235|A36|PALLET\d*)$/i.test(upper)) {
          continue;
        }
        if (/^\d+[X*]\d+/i.test(upper)) continue;
        if (upper === docketNumber.toUpperCase()) continue;
        partNumber = upper;
        break;
      }
    }
  }

  if (!partNumber && (foundSteelKeyword || thickness || material || dimensions)) {
    const firstTokenMatch = workingLine.match(/^([A-Z0-9./]{3,16})\s+/i);
    if (firstTokenMatch) {
      const candidate = firstTokenMatch[1].toUpperCase();
      if (!/^(?:QTY|ITEM|PART|THE|AND|FOR|REV|PALLET)$/i.test(candidate)) {
        partNumber = candidate;
      }
    }
  }

  if (!partNumber && foundSteelKeyword && (thickness || dimensions || material)) {
    partNumber = dimensions
      ? `${foundSteelKeyword.slice(0, 4)}-${dimensions.replace(/mm$/i, '')}`
      : `${foundSteelKeyword.slice(0, 4)}-${String(100 + lineIndex)}`;
  }

  partNumber = partNumber.replace(/^["'“”‘’″′]+|["'“”‘’″′]+$/g, '').trim();

  if (!partNumber) {
    return null;
  }

  const remainingAfterPart = workingLine
    .replace(partNumber, '')
    .replace(/^["'“”‘’″′\s]+/, '')
    .trim();
  if (
    remainingAfterPart.length === 0 &&
    !description &&
    !foundSteelKeyword &&
    !thickness &&
    !material &&
    !dimensions
  ) {
    return null;
  }

  // Extract standalone revision token if present between partNumber/description and specs
  if (!revision) {
    const standaloneRevMatch = workingLine.match(/\b(?:REV(?:ISION)?\s*[:.]?\s*)([A-Z0-9]{1,2})\b/i);
    if (standaloneRevMatch) {
      revision = standaloneRevMatch[1].toUpperCase();
    }
  }

  // Extract Quantity if not already resolved from column layout
  if (quantity === null) {
    // Strip currency values ($45.00) so prices are never mistaken for quantities
    const lineWithoutCurrency = workingLine.replace(/\$\s*\d+(?:,\d{3})*(?:\.\d{2})?/g, ' ').trim();
    const qtyMatch =
      lineWithoutCurrency.match(/(?:qty|quantity|shipped|delivered|supplied)\s*[:.\s]*(\d{1,4})\b/i) ||
      lineWithoutCurrency.match(/\b(\d{1,4})\s*(?:ea|pcs|units|off)\b/i) ||
      lineWithoutCurrency.match(/\b\d{1,4}\s*\/\s*(\d{1,4})\s*$/) ||
      lineWithoutCurrency.match(/\s+(\d{1,4})(?:\.00)?\s*$/);

    if (qtyMatch && qtyMatch[1]) {
      const q = parseInt(qtyMatch[1], 10);
      if (!Number.isNaN(q) && q > 0 && q <= 10000) {
        quantity = q;
      }
    } else {
      // Recover trailing OCR digit lookalikes (e.g. '8' read as 'B', '5' read as 'S', '10' read as '1O')
      // when immediately following a thickness or material specification at the end of the row
      const lookalikeMatch = lineWithoutCurrency.match(
        /\b(?:\d{1,2}(?:\.\d)?\s*mm|g250|g350|ha250|ha350|304ss|316ss)\s+([0-9OIlZSB]{1,3})\s*$/i
      );
      if (lookalikeMatch && lookalikeMatch[1]) {
        const normalized = lookalikeMatch[1]
          .toUpperCase()
          .replace(/O/g, '0')
          .replace(/[IL]/g, '1')
          .replace(/Z/g, '2')
          .replace(/S/g, '5')
          .replace(/B/g, '8');
        const q = parseInt(normalized, 10);
        if (!Number.isNaN(q) && q > 0 && q <= 10000) {
          quantity = q;
        }
      }
    }
  }

  const finalQuantity = quantity !== null ? quantity : 1;

  if (!itemNumber) {
    itemNumber =
      supplierProfile === 'gci' && /^BAR-\d+/i.test(partNumber)
        ? partNumber
        : String(lineIndex);
  }

  // Build clean description if not already extracted from dedicated description column
  if (!description || description.length < 2) {
    description = workingLine
      .replace(new RegExp(`["'“”‘’″′]?${partNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'“”‘’″′]?`, 'i'), '')
      .replace(/\.(?:dxf|dwg|nc1|step|stp)\b/gi, '')
      .replace(/\b(?:rev(?:ision)?\.?\s*[:\-]?\s*)[A-Z0-9]{1,3}\b/gi, '')
      .replace(/(?:qty|quantity|shipped|delivered|supplied)\s*[:.\s]*\d{1,4}\b/gi, '')
      .replace(/\b\d{1,4}\s*(?:ea|pcs|units|off)\b/gi, '')
      .replace(/\s+\d{1,4}(?:\.00)?\s*$/, '')
      .replace(/^[\s\-–—:|.,]+|[\s\-–—:|.,]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (!description || description.length < 2) {
    const specParts = [
      foundSteelKeyword ? `Laser Cut ${foundSteelKeyword}` : 'Laser Cut Part',
      dimensions,
      thickness,
      material,
    ].filter(Boolean);
    description = specParts.join(' · ');
  }

  const isLowConf = partNumber.length < 2 || ocrConfidence < 68 || quantity === null;
  const confidenceLevel: 'high' | 'medium' | 'low' = isLowConf
    ? 'low'
    : ocrConfidence >= 82
    ? 'high'
    : 'medium';

  const cleanDesc = description.slice(0, 100);

  return {
    partNumber,
    itemNumber,
    description: cleanDesc,
    revision,
    rev: revision,
    material,
    thickness,
    dimensions,
    weight,
    quantity: finalQuantity,
    palletNumber,
    confidence: confidenceLevel,
    notes: isLowConf ? 'Low confidence OCR — verify part details' : undefined,
    originalOcrValues: {
      partNumber,
      itemNumber,
      description: cleanDesc,
      revision,
      rev: revision,
      quantity: finalQuantity,
      material,
      thickness,
    },
  };
}

/**
 * Merges complementary parsed part rows from two extraction sources (e.g., native PDF selectable text
 * and Tesseract.js page OCR) without creating duplicate line items.
 * - Preserves page numbers, positional bounding boxes (`bbox`), and all valid rows from both sources.
 * - Does not discard valid rows if one source only captured partial rows.
 */
export function mergeComplementaryParsedItems(
  primaryItems: ExtractedDocketItem[],
  secondaryItems: ExtractedDocketItem[]
): ExtractedDocketItem[] {
  if (!primaryItems || primaryItems.length === 0) {
    return secondaryItems ? [...secondaryItems] : [];
  }
  if (!secondaryItems || secondaryItems.length === 0) {
    return [...primaryItems];
  }

  const confRank: Record<'high' | 'medium' | 'low', number> = {
    high: 3,
    medium: 2,
    low: 1,
  };

  const merged: ExtractedDocketItem[] = primaryItems.map((it) => ({ ...it }));

  const findMatchingIndex = (candidate: ExtractedDocketItem): number => {
    const candPart = String(candidate.partNumber || '').trim().toUpperCase();
    const candItemNo = String(candidate.itemNumber || '').trim().toUpperCase();
    const candRev = String(candidate.revision || candidate.rev || '').trim().toUpperCase();
    const candPallet = String(candidate.palletNumber || '').trim().toUpperCase();
    const candPage = candidate.pageNumber || 1;

    for (let i = 0; i < merged.length; i++) {
      const ex = merged[i];
      const exPart = String(ex.partNumber || '').trim().toUpperCase();
      const exItemNo = String(ex.itemNumber || '').trim().toUpperCase();
      const exRev = String(ex.revision || ex.rev || '').trim().toUpperCase();
      const exPallet = String(ex.palletNumber || '').trim().toUpperCase();
      const exPage = ex.pageNumber || 1;

      if (exPage !== candPage) continue;

      // Exact match on partNumber + compatible revision + compatible palletNumber
      if (candPart && exPart === candPart) {
        const revCompatible = !candRev || !exRev || candRev === exRev;
        const palletCompatible = !candPallet || !exPallet || candPallet === exPallet;
        const itemNoCompatible = !candItemNo || !exItemNo || candItemNo === exItemNo;
        if (revCompatible && palletCompatible && itemNoCompatible) {
          return i;
        }
      }

      // Or same explicit printed itemNumber on the same page with identical partNumber
      if (candItemNo && exItemNo === candItemNo && candPart === exPart && candRev === exRev && candPallet === exPallet) {
        return i;
      }
    }
    return -1;
  };

  for (const sec of secondaryItems) {
    const matchIdx = findMatchingIndex(sec);
    if (matchIdx >= 0) {
      const ex = merged[matchIdx];
      const secHigherConf = (confRank[sec.confidence] || 1) > (confRank[ex.confidence] || 1);
      const bestDesc =
        sec.description &&
        (!ex.description ||
          ex.description === 'Laser Cut Part' ||
          (sec.description.length > ex.description.length && !sec.description.includes('Laser Cut Part')))
          ? sec.description
          : ex.description;

      merged[matchIdx] = {
        ...ex,
        description: bestDesc,
        revision: ex.revision || sec.revision,
        rev: ex.rev || sec.rev || ex.revision || sec.revision,
        material: ex.material || sec.material,
        thickness: ex.thickness || sec.thickness,
        dimensions: ex.dimensions || sec.dimensions,
        weight: ex.weight || sec.weight,
        palletNumber: ex.palletNumber || sec.palletNumber,
        pageNumber: ex.pageNumber || sec.pageNumber,
        bbox: ex.bbox || sec.bbox,
        quantity: ex.quantity > 0 ? ex.quantity : sec.quantity,
        confidence: secHigherConf ? sec.confidence : ex.confidence,
        validationFlags: secHigherConf ? sec.validationFlags : ex.validationFlags,
        notes: secHigherConf ? sec.notes : ex.notes,
      };
    } else {
      merged.push({ ...sec });
    }
  }

  // Sort merged rows by pageNumber and numeric itemNumber when numeric
  merged.sort((a, b) => {
    const pageDiff = (a.pageNumber || 1) - (b.pageNumber || 1);
    if (pageDiff !== 0) return pageDiff;
    const numA = parseInt(String(a.itemNumber || ''), 10);
    const numB = parseInt(String(b.itemNumber || ''), 10);
    if (!Number.isNaN(numA) && !Number.isNaN(numB) && numA !== numB) {
      return numA - numB;
    }
    if (a.bbox && b.bbox && a.bbox.y0 !== b.bbox.y0) {
      return a.bbox.y0 - b.bbox.y0;
    }
    return 0;
  });

  return merged;
}

/**
 * Preserves manually edited or manually added rows (`manuallyEdited: true`) when a docket is reprocessed
 * by Tesseract or Gemini, keeping `originalOcrValues`, `lastEditedBy`, and `lastEditedAt` intact.
 */
export function preserveManualEditsDuringReprocess(
  existingItems: ExtractedDocketItem[],
  freshItems: ExtractedDocketItem[]
): ExtractedDocketItem[] {
  const manualRows = (existingItems || []).filter((it) => it.manuallyEdited);
  if (manualRows.length === 0) {
    return (freshItems || []).map((fresh) => ({
      ...fresh,
      originalOcrValues: fresh.originalOcrValues || {
        partNumber: fresh.partNumber,
        itemNumber: fresh.itemNumber,
        description: fresh.description,
        revision: fresh.rev || fresh.revision,
        quantity: Math.max(1, fresh.quantity || 1),
        material: fresh.material,
        thickness: fresh.thickness,
      },
    }));
  }

  const manualByItemNo = new Map<string, ExtractedDocketItem>();
  const extraManualRows: ExtractedDocketItem[] = [];

  for (const m of manualRows) {
    const key = String(m.itemNumber || '').trim();
    if (key && !manualByItemNo.has(key)) {
      manualByItemNo.set(key, m);
    } else {
      extraManualRows.push(m);
    }
  }

  const merged: ExtractedDocketItem[] = (freshItems || []).map((fresh) => {
    const key = String(fresh.itemNumber || '').trim();
    if (key && manualByItemNo.has(key)) {
      const preserved = manualByItemNo.get(key)!;
      manualByItemNo.delete(key);
      return {
        ...preserved,
        manuallyEdited: true,
        originalOcrValues: preserved.originalOcrValues || {
          partNumber: fresh.partNumber,
          itemNumber: fresh.itemNumber,
          description: fresh.description,
          revision: fresh.rev || fresh.revision,
          quantity: Math.max(1, fresh.quantity || 1),
          material: fresh.material,
          thickness: fresh.thickness,
        },
      };
    }
    return {
      ...fresh,
      originalOcrValues: fresh.originalOcrValues || {
        partNumber: fresh.partNumber,
        itemNumber: fresh.itemNumber,
        description: fresh.description,
        revision: fresh.rev || fresh.revision,
        quantity: Math.max(1, fresh.quantity || 1),
        material: fresh.material,
        thickness: fresh.thickness,
      },
    };
  });

  for (const remainingManual of manualByItemNo.values()) {
    merged.push(remainingManual);
  }
  for (const extra of extraManualRows) {
    merged.push(extra);
  }

  return merged;
}
