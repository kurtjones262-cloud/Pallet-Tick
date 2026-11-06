import { ExtractedDocketItem, ExtractedDocketResult } from '../server/docketOcr';

export interface RawOcrLine {
  text: string;
  confidence: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Parses raw OCR text lines extracted from photographed industrial delivery dockets.
 * Optimized specifically for steel fabrication packing slips, laser cutting manifests,
 * and profile cutting delivery dockets.
 *
 * CRITICAL RULE: Identifies ONLY actual individual parts and all their details.
 * Strictly ignores docket header barcodes, standalone barcode numbers, consignments,
 * addresses, phone numbers, ABNs, and signature blocks.
 */
export function parseIndustrialDocketText(
  lines: RawOcrLine[],
  pageNumber: number = 1
): {
  header: {
    supplier: string;
    docketNumber: string;
    deliveryDate: string;
    carrier?: string;
    palletCount?: number;
    orderNumber?: string;
  };
  items: ExtractedDocketItem[];
  rawText: string;
} {
  const fullText = lines.map((l) => l.text).join('\n');

  // 1. Supplier Extraction
  const supplier = extractSupplier(lines);

  // 2. Docket Number / Packing Slip Reference Extraction (Header Barcode)
  const docketNumber = extractDocketNumber(lines);

  // 3. Delivery Date
  const deliveryDate = extractDate(lines);

  // 4. Pallet Count
  const palletCount = extractPalletCount(lines);

  // 5. Carrier / Transport
  const carrier = extractCarrier(lines);

  // 6. PO / Order Number
  const orderNumber = extractOrderNumber(lines);

  // 7. Table Line Items Extraction (ONLY real physical parts and all their details!)
  const items = extractTableItems(lines, pageNumber, docketNumber, orderNumber);

  return {
    header: {
      supplier,
      docketNumber,
      deliveryDate,
      carrier,
      palletCount,
      orderNumber,
    },
    items,
    rawText: fullText,
  };
}

/**
 * Combines parsed results across multiple docket pages into a unified compiled list
 */
export function combineMultiPageDocketResults(
  pageResults: Array<ReturnType<typeof parseIndustrialDocketText>>
): ExtractedDocketResult {
  if (pageResults.length === 0) {
    return {
      docketNumber: `DK-${Math.floor(10000 + Math.random() * 90000)}`,
      supplier: 'Fabrication Supplier',
      deliveryDate: new Date().toISOString().split('T')[0],
      items: [],
      confidenceScore: 0,
      needsManualReview: true,
      extractionMethod: 'offline-ocr',
    };
  }

  const primaryHeader =
    pageResults.find((p) => p.header.docketNumber && !p.header.docketNumber.startsWith('DK-AUTO'))
      ?.header || pageResults[0].header;

  const combinedItems: ExtractedDocketItem[] = [];
  let itemCounter = 1;

  for (const page of pageResults) {
    for (const it of page.items) {
      combinedItems.push({
        ...it,
        itemNumber: it.itemNumber || String(itemCounter),
      });
      itemCounter++;
    }
  }

  const lowConfidenceCount = combinedItems.filter((i) => i.confidence === 'low').length;
  const confidenceScore =
    combinedItems.length > 0
      ? Math.round(((combinedItems.length - lowConfidenceCount) / combinedItems.length) * 100)
      : 80;

  return {
    docketNumber: primaryHeader.docketNumber,
    supplier: primaryHeader.supplier,
    deliveryDate: primaryHeader.deliveryDate,
    carrier: primaryHeader.carrier,
    palletCount: primaryHeader.palletCount || Math.max(1, Math.ceil(combinedItems.length / 35)),
    orderNumber: primaryHeader.orderNumber,
    items: combinedItems,
    confidenceScore,
    needsManualReview: lowConfidenceCount > 0 || combinedItems.length === 0,
    rawTextSummary: pageResults.map((p) => p.rawText).join('\n--- PAGE BREAK ---\n'),
    extractionMethod: 'offline-ocr',
  };
}

// ============================================================================
// HEADER EXTRACTION HELPERS
// ============================================================================

const KNOWN_SUPPLIERS = [
  'ShapeCut Precision Laser',
  'ShapeCut',
  'Laser Central',
  'Precision Laser Cutting',
  'ProCut Laser Solutions',
  'Stelform Profiling',
  'BlueScope Steel',
  'Vulcan Steel',
  'Bystronic Profile Cutting',
  'Southern Steel',
  'Surdex Steel',
  'Apex Industrial',
  'Outokumpu',
  'Hardox Wearparts',
  'Atlas Steels',
];

function extractSupplier(lines: RawOcrLine[]): string {
  const topLines = lines.slice(0, 15);

  for (const line of topLines) {
    for (const known of KNOWN_SUPPLIERS) {
      if (line.text.toLowerCase().includes(known.toLowerCase())) {
        return known;
      }
    }
  }

  for (const line of topLines) {
    const clean = line.text.trim();
    if (
      clean.length >= 4 &&
      clean.length <= 40 &&
      /(?:laser|steel|profile|profiling|cutting|fabrication|metals|engineering|pty\s*ltd)/i.test(clean) &&
      !/(?:docket|invoice|page|delivery|tax|abn|date|order|packing|slip)/i.test(clean)
    ) {
      return clean.replace(/[^\w\s&.-]/g, '').trim();
    }
  }

  if (topLines.length > 0 && topLines[0].text.trim().length > 3) {
    const firstClean = topLines[0].text.trim().replace(/[^\w\s&.-]/g, '');
    if (firstClean.length > 3 && !/docket|delivery|invoice/i.test(firstClean)) {
      return firstClean.slice(0, 32);
    }
  }

  return 'ShapeCut Precision Laser';
}

function extractDocketNumber(lines: RawOcrLine[]): string {
  const topText = lines.slice(0, 20).map((l) => l.text).join(' ');

  const match = topText.match(
    /(?:docket|delivery\s*(?:no|num|#|doc|d\/n)?|pack(?:ing)?\s*slip\s*(?:no|#)?|d\/n|dn|connote|consignment)\s*[:#.\s]*([A-Z0-9\-_/]{4,16})/i
  );

  if (match && match[1]) {
    const raw = match[1].replace(/[^\w-]/g, '').trim();
    if (raw.length >= 3) return raw.toUpperCase();
  }

  const standaloneMatch = topText.match(/\b((?:DK|DN|PS|DEL|INV|SO)-\d{4,9})\b/i);
  if (standaloneMatch) return standaloneMatch[1].toUpperCase();

  return `DK-${Math.floor(10000 + Math.random() * 90000)}`;
}

function extractDate(lines: RawOcrLine[]): string {
  const topText = lines.slice(0, 25).map((l) => l.text).join(' ');

  const dateMatch = topText.match(
    /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b|\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/
  );

  if (dateMatch) {
    if (dateMatch[1]) {
      const d = dateMatch[1].padStart(2, '0');
      const m = dateMatch[2].padStart(2, '0');
      let y = dateMatch[3];
      if (y.length === 2) y = `20${y}`;
      return `${y}-${m}-${d}`;
    }
  }

  return new Date().toISOString().split('T')[0];
}

function extractPalletCount(lines: RawOcrLine[]): number | undefined {
  const text = lines.map((l) => l.text).join(' ');
  const match = text.match(/(?:pallet|pallets|skid|skids|pkt|bundle)s?\s*[:#\s]*(\d{1,2})/i);
  if (match && match[1]) {
    const val = parseInt(match[1], 10);
    if (!isNaN(val) && val > 0 && val < 50) return val;
  }
  return undefined;
}

function extractCarrier(lines: RawOcrLine[]): string | undefined {
  const text = lines.slice(0, 25).map((l) => l.text).join(' ');
  const match = text.match(/(?:carrier|transport|freight|courier)\s*[:#\s]*([A-Za-z0-9\s]{3,24})/i);
  return match && match[1] ? match[1].trim() : undefined;
}

function extractOrderNumber(lines: RawOcrLine[]): string | undefined {
  const text = lines.slice(0, 25).map((l) => l.text).join(' ');
  const match = text.match(/(?:po|order|cust\s*po|job)\s*(?:no|num|#)?\s*[:#\s]*([A-Z0-9\-_]{3,14})/i);
  return match && match[1] ? match[1].trim().toUpperCase() : undefined;
}

// ============================================================================
// TABLE ROW PARSING & RECOGNITION (ONLY REAL INDIVIDUAL PARTS!)
// ============================================================================

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

  // 1. Reject OCR barcode bar artifacts (e.g. "|||| ||| || ||||", "I l I 1 l I", "*12345678*")
  const pipeOrBarChars = (clean.match(/[|!Il1*]/g) || []).length;
  if (pipeOrBarChars >= 6 && pipeOrBarChars / clean.length > 0.45) {
    return true;
  }

  // 2. Reject standalone barcode numbers or asterisk-wrapped codes (e.g. "*DK-88410*", "9312345678901", "00491827")
  if (/^\*?[0-9A-Z\-]{5,22}\*?$/i.test(clean)) {
    return true;
  }

  // 3. Reject lines that are just "Barcode: ..." or "Docket: ..." or match docketNumber / orderNumber
  if (
    docketNumber &&
    lower.includes(docketNumber.toLowerCase()) &&
    !/(?:mm|plate|gusset|flange|bracket|gr|grade|ss|steel|qty|ea|pcs)/i.test(clean)
  ) {
    return true;
  }
  if (
    orderNumber &&
    lower.includes(orderNumber.toLowerCase()) &&
    !/(?:mm|plate|gusset|flange|bracket|gr|grade|ss|steel|qty|ea|pcs)/i.test(clean)
  ) {
    return true;
  }

  // 4. Reject document titles, address blocks, contact details, and signature footers
  if (
    /^(?:tax\s*invoice|delivery\s*docket|packing\s*slip|delivery\s*advice|despatch\s*note|consignment|connote|manifest)/i.test(lower) ||
    /^(?:bill\s*to|ship\s*to|deliver\s*to|sold\s*to|consignee|customer|supplier|from|to\s*:)/i.test(lower) ||
    /^(?:carrier|transport|freight|truck|driver|rego|despatch|dispatch)/i.test(lower) ||
    /^(?:subtotal|total|total\s*parts|total\s*weight|total\s*qty|page\s*\d+|continued)/i.test(lower) ||
    /^(?:received\s*by|authorised\s*by|checked\s*by|signature|print\s*name|date|driver\s*sign|received\s*in\s*good)/i.test(lower) ||
    /(?:abn|acn|phone|tel|fax|email|www\.|http|pty\s*ltd|street|road|ave|drive|blvd|qld|nsw|vic|wa|sa|tas)/i.test(lower)
  ) {
    return true;
  }

  // 5. Reject table column header rows
  const headerKeywords = [
    'part',
    'item',
    'description',
    'desc',
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
    'drawing',
    'dwg',
    'weight',
    'unit',
    'size',
    'dimensions',
  ];
  const words = lower.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  const matchedHeaders = words.filter((w) => headerKeywords.includes(w));
  if (matchedHeaders.length >= 2 && matchedHeaders.length >= words.length * 0.5) {
    return true;
  }

  return false;
}

/**
 * Common steel fabrication part keywords indicating a physical component
 */
const STEEL_PART_KEYWORDS = [
  'PLATE',
  'FLANGE',
  'GUSSET',
  'BRACKET',
  'STIFFENER',
  'CLEAT',
  'SPLICE',
  'BASE',
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
];

/**
 * Extracts line items from table structure, including multi-line detail merging.
 */
function extractTableItems(
  lines: RawOcrLine[],
  pageNumber: number,
  docketNumber: string,
  orderNumber?: string
): ExtractedDocketItem[] {
  const items: ExtractedDocketItem[] = [];
  let currentPallet = `Pallet ${pageNumber}`;

  // 1. Find table header row in the top 60% of lines
  let tableStartIndex = 0;
  const maxHeaderSearchIdx = Math.ceil(lines.length * 0.6);

  for (let i = 0; i < maxHeaderSearchIdx; i++) {
    const text = lines[i].text.toLowerCase();
    const hasPartOrItem = /\b(?:part|item|dwg|drawing|mark|code|pos|line)\b/.test(text);
    const hasQtyOrDesc = /\b(?:qty|quantity|desc|description|material|grade|thick|shipped|delivered|ordered)\b/.test(text);
    if (hasPartOrItem && hasQtyOrDesc) {
      tableStartIndex = i + 1;
      break;
    }
  }

  const candidateLines = lines.slice(tableStartIndex);

  for (let i = 0; i < candidateLines.length; i++) {
    const line = candidateLines[i];
    const text = line.text.trim();

    // Check for standalone pallet section divider (e.g., "PALLET 2", "SKID 1 OF 4")
    const palletHeaderMatch = text.match(/^(?:pallet|bundle|pack|skid)\s*#?\s*(\d{1,2})(?:\s*of\s*\d{1,2})?$/i);
    if (palletHeaderMatch) {
      currentPallet = `Pallet ${palletHeaderMatch[1]}`;
      continue;
    }

    if (isBarcodeOrMetadataLine(text, docketNumber, orderNumber)) {
      continue;
    }

    const item = parseSingleLineItem(
      text,
      line.confidence,
      currentPallet,
      items.length + 1,
      docketNumber
    );

    if (item) {
      // Check if the immediate next line is a detail continuation line (e.g. material/dimensions/description wrap)
      if (i + 1 < candidateLines.length) {
        const nextText = candidateLines[i + 1].text.trim();
        if (isDetailContinuationLine(nextText, docketNumber)) {
          mergeContinuationDetails(item, nextText);
          i++; // Consume continuation line
        }
      }
      items.push(item);
    }
  }

  // Fallback: if tableStartIndex skipped earlier valid rows, scan all lines
  if (items.length === 0 && tableStartIndex > 0) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const text = line.text.trim();
      if (!isBarcodeOrMetadataLine(text, docketNumber, orderNumber)) {
        const item = parseSingleLineItem(
          text,
          line.confidence,
          currentPallet,
          items.length + 1,
          docketNumber
        );
        if (item) {
          items.push(item);
        }
      }
    }
  }

  return items;
}

/**
 * Checks if a line is a wrapped secondary detail line belonging to the part above it
 * (e.g. "Material: 10mm G350 | Size: 400x400mm" without its own part number + qty row)
 */
function isDetailContinuationLine(text: string, docketNumber: string): boolean {
  if (!text || text.length < 4) return false;
  if (isBarcodeOrMetadataLine(text, docketNumber)) return false;

  // If it starts with a line number and a part code + trailing qty, it's a new part row, not a continuation
  if (/^\d{1,3}\s+[A-Z0-9][A-Z0-9\-_.]{2,15}\s+.*\b\d{1,4}\s*$/i.test(text)) {
    return false;
  }

  const hasDetailSpec =
    /\b(?:\d{1,2}(?:\.\d)?\s*mm|250\s*gr|350\s*gr|g250|g350|ha350|hardox|stainless|304|316|mild\s*steel|\d{2,4}\s*[xX]\s*\d{2,4}|\d+(?:\.\d+)?\s*kg)\b/i.test(
      text
    );
  const hasNewPartCode = /\b([A-Z]{2,6}-[A-Z0-9\-_]{2,14})\b/.test(text);

  return hasDetailSpec && !hasNewPartCode;
}

/**
 * Merges extra details from a wrapped continuation line into the parent part item
 */
function mergeContinuationDetails(item: ExtractedDocketItem, continuationText: string): void {
  const details = extractPartSpecifications(continuationText);
  if (details.thickness && !item.thickness) item.thickness = details.thickness;
  if (details.material && !item.material) item.material = details.material;
  if (details.dimensions && !item.dimensions) item.dimensions = details.dimensions;
  if (details.weight && !item.weight) item.weight = details.weight;

  const extraDesc = continuationText
    .replace(/\b(?:material|grade|thick|thickness|size|dim|dimensions|weight|wt)\s*[:.]?/gi, '')
    .trim();
  if (extraDesc && !item.description.toLowerCase().includes(extraDesc.toLowerCase())) {
    item.description = `${item.description} · ${extraDesc}`.slice(0, 90);
  }
}

/**
 * Extracts material, thickness, dimensions, and weight from a text string
 */
function extractPartSpecifications(text: string): {
  thickness?: string;
  material?: string;
  dimensions?: string;
  weight?: string;
} {
  // Thickness: e.g. 10mm, 12.0mm, 6 mm, PL10, 10PL
  const thicknessMatch =
    text.match(/\b(\d{1,2}(?:\.\d)?\s*mm)\b/i) ||
    text.match(/\bPL\s*(\d{1,2}(?:\.\d)?)\b/i);
  const thickness = thicknessMatch
    ? thicknessMatch[1].toLowerCase().endsWith('mm')
      ? thicknessMatch[1].toLowerCase().replace(/\s+/g, '')
      : `${thicknessMatch[1]}mm`
    : undefined;

  // Material Grade: e.g. G250, G350, 350Gr, 250 Grade, HA350, Hardox 450, 316SS, 304SS, Mild Steel, Aluminium 5083
  const materialMatch = text.match(
    /\b(G\s*250|G\s*350|350\s*Gr(?:ade)?|250\s*Gr(?:ade)?|Gr(?:ade)?\s*350|Gr(?:ade)?\s*250|HA\s*350|HW\s*350|Hardox\s*\d{3}|Bisalloy\s*\d{2,3}|316L?\s*(?:SS|Stainless)?|304L?\s*(?:SS|Stainless)?|Mild\s*Steel|Stainless\s*Steel|Aluminium\s*\d{4}|Alum\s*\d{4}|Galv(?:anised)?|Corten|AS\s*3678(?:-\d{3})?)\b/i
  );
  const material = materialMatch ? materialMatch[1].replace(/\s+/g, ' ').trim() : undefined;

  // Dimensions: e.g. 400x400, 1200 x 350, 450x200x10, 250x150mm
  const dimMatch = text.match(
    /\b(\d{2,5}\s*[xX*]\s*\d{2,5}(?:\s*[xX*]\s*\d{1,3})?(?:\s*mm)?)\b/
  );
  const dimensions = dimMatch ? dimMatch[1].replace(/\s+/g, '') : undefined;

  // Weight: e.g. 4.2kg, 18.5 kg, 120kg
  const weightMatch = text.match(/\b(\d{1,4}(?:\.\d{1,2})?\s*kg)\b/i);
  const weight = weightMatch ? weightMatch[1].toLowerCase().replace(/\s+/g, '') : undefined;

  return { thickness, material, dimensions, weight };
}

/**
 * Parses a single text line into Part Number, Item Number, Quantity, Material, Thickness, Dimensions, Weight, and Description.
 * NEVER turns a standalone barcode number into a fake part.
 */
function parseSingleLineItem(
  rawText: string,
  ocrConfidence: number,
  palletNumber: string,
  lineIndex: number,
  docketNumber: string
): ExtractedDocketItem | null {
  const line = rawText.replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim();

  // Reject short fragments or pure numbers (which are barcodes or page numbers)
  if (line.length < 4 || /^[\d\s\-*]+$/.test(line)) {
    return null;
  }

  // Extract specifications (thickness, material, dimensions, weight)
  const specs = extractPartSpecifications(line);

  // Check if line contains a steel component keyword
  let foundSteelKeyword = '';
  for (const kw of STEEL_PART_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(line)) {
      foundSteelKeyword = kw;
      break;
    }
  }

  // 1. Extract leading line/item index if present (e.g. "1 ", "01 ", "002 ", "ITM-001 ")
  let itemNumber = '';
  let workingLine = line;

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

  // 2. Match Part Number / Drawing Code / Profile ID
  let partNumber = '';

  // Remove file extensions like .dxf or .dwg while keeping the stem as a strong part identifier
  const dxfMatch = workingLine.match(/\b([A-Za-z0-9][A-Za-z0-9\-_./]{1,22})\.(?:dxf|dwg|nc1|step|stp)\b/i);
  if (dxfMatch) {
    partNumber = dxfMatch[1].toUpperCase();
  }

  // Pattern A: Hyphenated or underscored part identifier (e.g. PLT-101-A, FLG-150, 1045-01, SIDE_PLATE_01, 24-0889)
  if (!partNumber) {
    const structuredPartMatches = workingLine.match(
      /\b([A-Z0-9]{1,8}[-_][A-Z0-9\-_]{1,16})\b/gi
    );
    if (structuredPartMatches) {
      for (const candidate of structuredPartMatches) {
        const upper = candidate.toUpperCase();
        // Skip if it's the docket number, a date, a dimension, or a material grade
        if (upper === docketNumber.toUpperCase()) continue;
        if (/^\d{1,2}-\d{1,2}-\d{2,4}$/.test(upper)) continue;
        if (/^(?:AS-\d+|GR-\d+|G-\d+)$/i.test(upper)) continue;
        if (upper === itemNumber) continue;
        partNumber = upper;
        break;
      }
    }
  }

  // Pattern B: Alphanumeric part code mixing letters and numbers (e.g. PL101, FLG150, B204, P01, 40921A, MK12)
  if (!partNumber) {
    const alphaNumMatches = workingLine.match(/\b([A-Z]{1,6}\d{1,6}[A-Z0-9]{0,4}|\d{2,6}[A-Z]{1,4})\b/gi);
    if (alphaNumMatches) {
      for (const candidate of alphaNumMatches) {
        const upper = candidate.toUpperCase();
        // Exclude thickness/weight/grade/units tokens like "10MM", "350GR", "G250", "316SS", "4EA", "12KG", "400X400"
        if (/^\d+(?:MM|CM|M|KG|G|LB|EA|PC|PCS|GR|OFF|X\d+)$/i.test(upper)) continue;
        if (/^(?:G250|G350|GR250|GR350|HA350|HW350|SS304|SS316|304SS|316SS|AS3678|AS4100|Q235|A36)$/i.test(upper)) continue;
        if (/^\d+[X*]\d+/i.test(upper)) continue;
        if (upper === docketNumber.toUpperCase()) continue;
        partNumber = upper;
        break;
      }
    }
  }

  // Pattern C: First token is a numeric drawing/part number (e.g. "405912 Base Plate 10mm 4") accompanied by part details
  if (!partNumber && (foundSteelKeyword || specs.thickness || specs.material || specs.dimensions)) {
    const firstTokenMatch = workingLine.match(/^([A-Z0-9./]{3,14})\s+/i);
    if (firstTokenMatch) {
      const candidate = firstTokenMatch[1].toUpperCase();
      if (!/^(?:QTY|ITEM|PART|THE|AND|FOR)$/i.test(candidate)) {
        partNumber = candidate;
      }
    }
  }

  // Pattern D: Descriptive steel part without explicit code (e.g. "Base Plate 400x400 10mm G250 Qty 4")
  if (!partNumber && foundSteelKeyword && (specs.thickness || specs.dimensions || specs.material)) {
    partNumber = specs.dimensions
      ? `${foundSteelKeyword.slice(0, 4)}-${specs.dimensions.replace(/mm$/i, '')}`
      : `${foundSteelKeyword.slice(0, 4)}-${String(100 + lineIndex)}`;
  }

  // CRITICAL GUARD: If we still don't have a real partNumber, DO NOT invent one from a barcode!
  if (!partNumber) {
    return null;
  }

  // Also require that the line has either descriptive words, specifications, or multiple columns
  // so a stray single-token reference number on the page isn't mistaken for a part
  const remainingAfterPart = workingLine.replace(partNumber, '').trim();
  if (
    remainingAfterPart.length === 0 &&
    !foundSteelKeyword &&
    !specs.thickness &&
    !specs.material &&
    !specs.dimensions
  ) {
    return null;
  }

  // 3. Extract Quantity
  let quantity = 1;
  const qtyMatch =
    workingLine.match(/(?:qty|quantity|shipped|delivered|supplied)\s*[:.\s]*(\d{1,4})\b/i) ||
    workingLine.match(/\b(\d{1,4})\s*(?:ea|pcs|units|off|no)\b/i) ||
    workingLine.match(/\b\d{1,4}\s*\/\s*(\d{1,4})\s*$/) || // e.g. "Ordered 4 / Shipped 4"
    workingLine.match(/\s+(\d{1,4})(?:\.00)?\s*$/);

  if (qtyMatch && qtyMatch[1]) {
    const q = parseInt(qtyMatch[1], 10);
    if (!isNaN(q) && q > 0 && q < 5000) {
      quantity = q;
    }
  }

  // Ensure itemNumber is populated with clean docket No
  if (!itemNumber) {
    itemNumber = String(lineIndex);
  }

  // 4. Build clean, comprehensive description
  let description = workingLine
    .replace(partNumber, '')
    .replace(/\.(?:dxf|dwg|nc1|step|stp)\b/gi, '')
    .replace(/(?:qty|quantity|shipped|delivered|supplied)\s*[:.\s]*\d{1,4}\b/gi, '')
    .replace(/\b\d{1,4}\s*(?:ea|pcs|units|off)\b/gi, '')
    .replace(/\s+\d{1,4}(?:\.00)?\s*$/, '')
    .replace(/^[\s\-–—:|.,]+|[\s\-–—:|.,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!description || description.length < 2) {
    const specParts = [
      foundSteelKeyword ? `Laser Cut ${foundSteelKeyword}` : 'Laser Cut Part',
      specs.dimensions,
      specs.thickness,
      specs.material,
    ].filter(Boolean);
    description = specParts.join(' · ');
  }

  const isSuspicious = partNumber.length < 2 || ocrConfidence < 50;

  return {
    partNumber,
    itemNumber,
    description: description.slice(0, 90),
    material: specs.material,
    thickness: specs.thickness,
    dimensions: specs.dimensions,
    weight: specs.weight,
    quantity,
    palletNumber,
    confidence: isSuspicious ? 'low' : ocrConfidence > 75 ? 'high' : 'medium',
    notes: isSuspicious ? 'Low confidence OCR — verify part details' : undefined,
  };
}
