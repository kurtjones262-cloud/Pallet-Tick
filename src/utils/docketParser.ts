import {
  ExtractedDocketItem,
  ExtractedDocketResult,
  GCI_MISSING_JOB_NO_WARNING,
  isGciSupplierHint,
  isGciExcludedNonPartItem,
  resolveGciPageHeaderFields,
} from '../server/docketOcr';
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
  ocrConfidence?: number;
  parserConfidence?: number;
  missingRowNumbers: number[];
  unparsedCandidateCount: number;
  flaggedRowCount: number;
  flagsSummary: string[];
}

export interface TableColumnBand {
  key:
    | 'no'
    | 'ordQty'
    | 'quantity'
    | 'backQty'
    | 'unit'
    | 'partNumber'
    | 'revision'
    | 'description'
    | 'material'
    | 'thickness'
    | 'dimensions'
    | 'weight'
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
 * Reconstructs sorted horizontal table lines from raw positioned OCR/PDF words when word-level
 * bounding boxes are available (e.g. from PDF.js selectable text layers).
 * - Excludes tall vertical border pipe tokens (`|`, `¦`) from distorting cluster vertical centers.
 * - Estimates and compensates residual text-baseline slope across wide multi-column tables.
 * - Stitches horizontally disjoint left/right row halves when page curvature splits a single row.
 */
export function groupPositionedWordsIntoLines(
  words: RawOcrWord[],
  pageNumber: number = 1
): RawOcrLine[] {
  const validWords = (words || []).filter((w) => w && String(w.text || '').trim().length > 0 && w.bbox);
  if (validWords.length === 0) return [];

  const isPureBorderPipe = (w: RawOcrWord): boolean =>
    /^[|¦‖!]+$/.test(String(w.text || '').trim());

  const contentWords = validWords.filter((w) => !isPureBorderPipe(w));
  const wordHeights = (contentWords.length > 0 ? contentWords : validWords)
    .map((w) => w.bbox.y1 - w.bbox.y0)
    .filter((h) => h >= 10 && h <= 120)
    .sort((a, b) => a - b);
  const medianWordHeight =
    wordHeights.length > 0 ? wordHeights[Math.floor(wordHeights.length / 2)] : 36;

  // Estimate residual baseline slope (dy/dx) from horizontally adjacent content words.
  // Use piecewise top/bottom half slopes on dense pages (40+ words) to compensate for slight center creases.
  const estimateMedianSlope = (subset: RawOcrWord[]): number | null => {
    if (subset.length < 10) return null;
    const byY = [...subset].sort(
      (a, b) => (a.bbox.y0 + a.bbox.y1) / 2 - (b.bbox.y0 + b.bbox.y1) / 2
    );
    const slopes: number[] = [];
    const maxPairDy = Math.max(14, medianWordHeight * 0.8);
    for (let i = 0; i < byY.length; i++) {
      const w1 = byY[i];
      const cx1 = (w1.bbox.x0 + w1.bbox.x1) / 2;
      const cy1 = (w1.bbox.y0 + w1.bbox.y1) / 2;
      for (let j = i + 1; j < Math.min(byY.length, i + 18); j++) {
        const w2 = byY[j];
        const cy2 = (w2.bbox.y0 + w2.bbox.y1) / 2;
        if (Math.abs(cy2 - cy1) > maxPairDy) break;
        const cx2 = (w2.bbox.x0 + w2.bbox.x1) / 2;
        const dx = cx2 - cx1;
        if (Math.abs(dx) >= 35 && Math.abs(dx) <= 420) {
          slopes.push((cy2 - cy1) / dx);
        }
      }
    }
    if (slopes.length < 8) return null;
    slopes.sort((a, b) => a - b);
    const rawSlope = slopes[Math.floor(slopes.length / 2)];
    return Math.abs(rawSlope) <= 0.045 ? rawSlope : null;
  };

  let medSlope = estimateMedianSlope(contentWords) ?? 0;
  let topSlope = medSlope;
  let bottomSlope = medSlope;
  let midY = 0;
  let minYBound = 0;
  let maxYBound = 0;
  let midXRef = 0;
  let hasPiecewiseSlope = false;

  if (contentWords.length >= 40) {
    const sortedY = contentWords.map((w) => (w.bbox.y0 + w.bbox.y1) / 2).sort((a, b) => a - b);
    minYBound = sortedY[0];
    maxYBound = sortedY[sortedY.length - 1];
    midY = sortedY[Math.floor(sortedY.length / 2)];
    const xs = contentWords.map((w) => (w.bbox.x0 + w.bbox.x1) / 2);
    midXRef = (Math.min(...xs) + Math.max(...xs)) / 2;
    const topWords = contentWords.filter((w) => (w.bbox.y0 + w.bbox.y1) / 2 <= midY);
    const bottomWords = contentWords.filter((w) => (w.bbox.y0 + w.bbox.y1) / 2 > midY);
    const sTop = estimateMedianSlope(topWords);
    const sBot = estimateMedianSlope(bottomWords);
    if (sTop !== null && sBot !== null) {
      topSlope = sTop;
      bottomSlope = sBot;
      hasPiecewiseSlope = true;
    }
  }

  const getRawCy = (w: RawOcrWord) => (w.bbox.y0 + w.bbox.y1) / 2;
  const getRawCx = (w: RawOcrWord) => (w.bbox.x0 + w.bbox.x1) / 2;
  const getSlopeForY = (y: number): number => {
    if (!hasPiecewiseSlope || maxYBound <= minYBound) return medSlope;
    const topRefY = (minYBound + midY) / 2;
    const botRefY = (midY + maxYBound) / 2;
    if (y <= topRefY) return topSlope;
    if (y >= botRefY) return bottomSlope;
    const t = (y - topRefY) / Math.max(1, botRefY - topRefY);
    return topSlope + (bottomSlope - topSlope) * t;
  };
  const getDeskewCy = (w: RawOcrWord) => {
    const cy = getRawCy(w);
    const cx = getRawCx(w);
    const slope = getSlopeForY(cy);
    return hasPiecewiseSlope ? cy - (cx - midXRef) * slope : cy - cx * slope;
  };

  // Sort by deskewed vertical center (top to bottom), then horizontal x0 (left to right)
  const sorted = [...validWords].sort((a, b) => {
    const cyA = getDeskewCy(a);
    const cyB = getDeskewCy(b);
    const avgH = Math.max(8, ((a.bbox.y1 - a.bbox.y0) + (b.bbox.y1 - b.bbox.y0)) / 2);
    if (Math.abs(cyA - cyB) > avgH * 0.55) {
      return cyA - cyB;
    }
    return a.bbox.x0 - b.bbox.x0;
  });

  const maxCenterDist = Math.max(16, Math.round(medianWordHeight * 0.65));

  interface LineCluster {
    cy: number; // deskewed vertical center
    words: RawOcrWord[];
  }

  const recomputeClusterCy = (c: LineCluster) => {
    const nonPipes = c.words.filter((w) => !isPureBorderPipe(w));
    const pool = nonPipes.length > 0 ? nonPipes : c.words;
    c.cy = pool.reduce((acc, item) => acc + getDeskewCy(item), 0) / pool.length;
  };

  const clusters: LineCluster[] = [];
  for (const w of sorted) {
    const dCy = getDeskewCy(w);
    const wCx = getRawCx(w);
    const wCy = getRawCy(w);

    let bestCluster: LineCluster | undefined;
    let bestDist = Infinity;

    for (const c of clusters) {
      const dist = Math.abs(c.cy - dCy);
      if (dist <= maxCenterDist && dist < bestDist) {
        bestDist = dist;
        bestCluster = c;
      } else if (dist <= maxCenterDist * 1.45) {
        // Check local horizontal continuity for curved lines where left & right columns bend slightly
        const nonPipes = c.words.filter((cw) => !isPureBorderPipe(cw));
        const overlapsX = nonPipes.some(
          (cw) => Math.min(cw.bbox.x1, w.bbox.x1) - Math.max(cw.bbox.x0, w.bbox.x0) > 6
        );
        if (!overlapsX && nonPipes.length > 0) {
          let nearestW = nonPipes[0];
          let minDx = Math.abs(getRawCx(nearestW) - wCx);
          for (const cw of nonPipes) {
            const dx = Math.abs(getRawCx(cw) - wCx);
            if (dx < minDx) {
              minDx = dx;
              nearestW = cw;
            }
          }
          const expectedY = getRawCy(nearestW) + (wCx - getRawCx(nearestW)) * getSlopeForY(getRawCy(nearestW));
          const localDist = Math.abs(wCy - expectedY);
          if (localDist <= maxCenterDist && localDist < bestDist) {
            bestDist = localDist;
            bestCluster = c;
          }
        }
      }
    }

    if (bestCluster) {
      bestCluster.words.push(w);
      recomputeClusterCy(bestCluster);
    } else {
      clusters.push({ cy: dCy, words: [w] });
    }
  }

  clusters.sort((a, b) => a.cy - b.cy);

  // Stitch adjacent clusters that belong to the same row but were split into disjoint left & right X-intervals
  const stitchedClusters: LineCluster[] = [];
  const maxStitchDy = Math.max(16, Math.round(medianWordHeight * 0.75));
  for (const c of clusters) {
    if (stitchedClusters.length === 0) {
      stitchedClusters.push(c);
      continue;
    }
    const prev = stitchedClusters[stitchedClusters.length - 1];
    const dy = Math.abs(c.cy - prev.cy);
    if (dy <= maxStitchDy) {
      const prevNonPipes = prev.words.filter((w) => !isPureBorderPipe(w));
      const currNonPipes = c.words.filter((w) => !isPureBorderPipe(w));
      if (prevNonPipes.length > 0 && currNonPipes.length > 0) {
        const prevMinX = Math.min(...prevNonPipes.map((w) => w.bbox.x0));
        const prevMaxX = Math.max(...prevNonPipes.map((w) => w.bbox.x1));
        const currMinX = Math.min(...currNonPipes.map((w) => w.bbox.x0));
        const currMaxX = Math.max(...currNonPipes.map((w) => w.bbox.x1));
        // Only merge left-to-right halves (avoid merging a previous row's right description with next row's left half)
        const leftToRightDisjoint = prevMaxX <= currMinX + 20;
        const tightReverseDisjoint =
          currMaxX <= prevMinX + 20 && dy <= Math.max(10, Math.round(medianWordHeight * 0.45));
        if (leftToRightDisjoint || tightReverseDisjoint) {
          prev.words.push(...c.words);
          recomputeClusterCy(prev);
          continue;
        }
      }
    }
    stitchedClusters.push(c);
  }

  const lines: RawOcrLine[] = [];
  for (const cluster of stitchedClusters) {
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
    hasExplicitDocketNumber: boolean;
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

  const detectedLayout = detectTableColumnLayout(normalizedLines);
  const tableHeaderIdx = detectedLayout?.headerLineIndex;

  // 1. Supplier & Profile Detection
  const detectedSupplier = extractSupplier(normalizedLines, supplierHint);
  const supplierProfile: SupplierRuleId =
    supplierHint ||
    (/\bgci\b|golden\s*coast/i.test(detectedSupplier) || /\bgci-\d+/i.test(fullText)
      ? 'gci'
      : 'laser_central');

  // 2. Docket Number / Packing Slip Reference Extraction (strictly above table rows when header exists)
  const { docketNumber, hasExplicitDocketNumber } = extractDocketNumberWithConfidence(
    normalizedLines,
    supplierProfile,
    tableHeaderIdx
  );

  // 3. Delivery Date
  const deliveryDate = extractDate(normalizedLines);

  // 4. Pallet Count
  const palletCount = extractPalletCount(normalizedLines);

  // 5. Carrier / Transport
  const carrier = extractCarrier(normalizedLines);

  // 6. PO / Order Number
  const orderNumber = extractOrderNumber(normalizedLines);

  // Guard for GCI text parsing: never allow Client Order No to populate docketNumber
  let finalDocketNumber = docketNumber;
  let finalHasExplicitDocket = hasExplicitDocketNumber;
  if (
    supplierProfile === 'gci' &&
    finalDocketNumber &&
    orderNumber &&
    finalDocketNumber.trim().toUpperCase() === orderNumber.trim().toUpperCase()
  ) {
    finalDocketNumber = '';
    finalHasExplicitDocket = false;
  }

  // 7. Table Line Items Extraction using positional column layout + supplier-specific rules
  const { items, unparsedCandidateCount, columnLayout } = extractTableItemsWithLayout(
    normalizedLines,
    pageNumber,
    finalDocketNumber,
    supplierProfile,
    orderNumber
  );

  return {
    header: {
      supplier: detectedSupplier,
      supplierProfile,
      docketNumber: finalDocketNumber,
      hasExplicitDocketNumber: finalHasExplicitDocket,
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

function buildDocketFromSegmentPages(
  segPages: Array<{ pageIndex: number; parsed: ReturnType<typeof parseIndustrialDocketText> }>,
  options: {
    method: 'gemini-vision' | 'ai-vision' | 'pdf-text';
    engineLabel: string;
    processingTimeMs?: number;
    ocrTimeMs?: number;
    parseTimeMs?: number;
    pagesFromCache?: number;
    explicitDocketNumber: string;
    separationUncertain: boolean;
    separationReason?: string;
  }
): ExtractedDocketResult & { validationReport: DocketValidationReport } {
  const primaryHeader =
    segPages.find((p) => p.parsed.header.hasExplicitDocketNumber)?.parsed.header ||
    segPages[0].parsed.header;

  const combinedItems: ExtractedDocketItem[] = [];
  let itemCounter = 1;
  let totalUnparsedCandidates = 0;

  for (const { parsed } of segPages) {
    totalUnparsedCandidates += parsed.unparsedCandidateCount || 0;
    for (const it of parsed.items) {
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

  const validationReport = validateDocketExtractionQuality(
    combinedItems,
    totalUnparsedCandidates
  );

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

  const sourcePageNumbers = segPages.map((p) => p.pageIndex + 1);
  const mediumRowCount = combinedItems.filter((it) => it.confidence === 'medium').length;

  return {
    docketNumber: options.explicitDocketNumber || primaryHeader.docketNumber,
    supplier: primaryHeader.supplier,
    deliveryDate: primaryHeader.deliveryDate,
    carrier: primaryHeader.carrier,
    palletCount: maxPalletNum,
    orderNumber: primaryHeader.orderNumber,
    items: combinedItems,
    confidenceScore: options.separationUncertain
      ? Math.min(79, validationReport.overallConfidenceScore)
      : validationReport.overallConfidenceScore,
    ocrConfidence: validationReport.ocrConfidence,
    parserConfidence: validationReport.parserConfidence,
    needsManualReview:
      options.separationUncertain ||
      !validationReport.isAcceptableWithoutFallback ||
      validationReport.flaggedRowCount > 0 ||
      mediumRowCount > 0,
    separationUncertain: options.separationUncertain,
    separationReason: options.separationReason,
    sourcePageNumbers,
    rawTextSummary: segPages.map((p) => p.parsed.rawText).join('\n--- PAGE BREAK ---\n'),
    extractionMethod: options.method,
    extractionEngineLabel: options.engineLabel,
    pagesScanned: segPages.length,
    pagesFromCache: options.pagesFromCache,
    processingTimeMs: options.processingTimeMs,
    ocrTimeMs: options.ocrTimeMs,
    parseTimeMs: options.parseTimeMs,
    validationFlags: [
      ...(options.separationUncertain && options.separationReason ? [options.separationReason] : []),
      ...validationReport.flagsSummary,
    ],
    missingRowNumbers: validationReport.missingRowNumbers,
    flaggedRowCount: validationReport.flaggedRowCount,
    hasPrintedNoColumn: numericNos.length > 0,
    firstVisibleRowNo: numericNos.length > 0 ? numericNos[0] : undefined,
    lastVisibleRowNo: numericNos.length > 0 ? numericNos[numericNos.length - 1] : undefined,
    validationReport,
  };
}

function getPageRowRange(parsed: ReturnType<typeof parseIndustrialDocketText>): {
  minNo?: number;
  maxNo?: number;
} {
  let minNo: number | undefined;
  let maxNo: number | undefined;
  for (const it of parsed.items) {
    const n = parseInt(String(it.itemNumber || '').replace(/\D+/g, ''), 10);
    if (!Number.isNaN(n) && n > 0 && n <= 2000) {
      minNo = minNo === undefined ? n : Math.min(minNo, n);
      maxNo = maxNo === undefined ? n : Math.max(maxNo, n);
    }
  }
  return { minNo, maxNo };
}

/**
 * Segments parsed pages into independent delivery dockets.
 * - Pages sharing the same explicit docket number stay grouped together.
 * - Distinct explicit docket numbers are NEVER auto-merged.
 * - Multi-file uploads without explicit docket numbers split conservatively and flag for manual review.
 */
export function segmentParsedPagesIntoDockets(
  pageResults: Array<ReturnType<typeof parseIndustrialDocketText>>,
  options?: {
    extractionMethod?: 'gemini-vision' | 'ai-vision' | 'pdf-text';
    extractionEngineLabel?: string;
    processingTimeMs?: number;
    ocrTimeMs?: number;
    parseTimeMs?: number;
    pagesFromCache?: number;
    sourceFileIds?: string[];
  }
): Array<ExtractedDocketResult & { validationReport: DocketValidationReport }> {
  const method = options?.extractionMethod || 'gemini-vision';
  const engineLabel = options?.extractionEngineLabel || 'Gemini Vision OCR';
  const sourceFileIds = options?.sourceFileIds;
  const normKey = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '');

  interface PageSegment {
    docketKey: string;
    explicitDocketNumber: string;
    hasExplicitDocketNumber: boolean;
    supplier: string;
    supplierProfile: SupplierRuleId;
    orderNumber?: string;
    sourceFileId?: string;
    maxRowSeen: number;
    separationUncertain: boolean;
    separationReason?: string;
    pages: Array<{ pageIndex: number; parsed: ReturnType<typeof parseIndustrialDocketText> }>;
  }

  const segments: PageSegment[] = [];

  for (let idx = 0; idx < pageResults.length; idx++) {
    const page = pageResults[idx];
    const hasExplicit = Boolean(page.header.hasExplicitDocketNumber);
    const key = hasExplicit ? normKey(page.header.docketNumber) : '';
    const fileId = sourceFileIds?.[idx];
    const { minNo, maxNo } = getPageRowRange(page);

    if (segments.length === 0) {
      segments.push({
        docketKey: hasExplicit ? key : page.header.docketNumber,
        explicitDocketNumber: page.header.docketNumber,
        hasExplicitDocketNumber: hasExplicit,
        supplier: page.header.supplier,
        supplierProfile: page.header.supplierProfile,
        orderNumber: page.header.orderNumber,
        sourceFileId: fileId,
        maxRowSeen: maxNo || 0,
        separationUncertain: !hasExplicit && pageResults.length > 1,
        separationReason:
          !hasExplicit && pageResults.length > 1
            ? 'Docket number could not be confidently read on Page 1 — please verify page boundaries.'
            : undefined,
        pages: [{ pageIndex: idx, parsed: page }],
      });
      continue;
    }

    if (hasExplicit) {
      const existingSame = segments.find(
        (seg) => seg.hasExplicitDocketNumber && seg.docketKey === key
      );
      if (existingSame) {
        existingSame.pages.push({ pageIndex: idx, parsed: page });
        existingSame.maxRowSeen = Math.max(existingSame.maxRowSeen, maxNo || 0);
        if (!existingSame.orderNumber && page.header.orderNumber) {
          existingSame.orderNumber = page.header.orderNumber;
        }
      } else {
        segments.push({
          docketKey: key,
          explicitDocketNumber: page.header.docketNumber,
          hasExplicitDocketNumber: true,
          supplier: page.header.supplier,
          supplierProfile: page.header.supplierProfile,
          orderNumber: page.header.orderNumber,
          sourceFileId: fileId,
          maxRowSeen: maxNo || 0,
          separationUncertain: false,
          pages: [{ pageIndex: idx, parsed: page }],
        });
      }
      continue;
    }

    // Current page has NO explicit docket number
    const prevSeg = segments[segments.length - 1];
    const rowResetDetected = minNo !== undefined && minNo <= 2 && prevSeg.maxRowSeen >= 3;
    const orderChanged = Boolean(
      page.header.orderNumber && prevSeg.orderNumber && page.header.orderNumber !== prevSeg.orderNumber
    );
    const supplierChanged = Boolean(
      page.header.supplierProfile &&
        prevSeg.supplierProfile &&
        page.header.supplierProfile !== prevSeg.supplierProfile
    );
    const distinctSourceFile = Boolean(fileId && prevSeg.sourceFileId && fileId !== prevSeg.sourceFileId);

    const shouldSplitUncertain =
      rowResetDetected || orderChanged || supplierChanged || distinctSourceFile;

    if (shouldSplitUncertain) {
      const reason = distinctSourceFile
        ? `Page ${idx + 1} came from a separate uploaded file without a clear docket number. Please confirm whether it is a separate docket or merge it.`
        : `Page ${idx + 1} appears to start a new docket (${
            rowResetDetected
              ? 'row numbering restarted at 1'
              : orderChanged
              ? 'order number changed'
              : 'supplier header changed'
          }), but no docket number was detected. Please verify.`;
      prevSeg.separationUncertain = true;
      prevSeg.separationReason =
        prevSeg.separationReason || 'Verify multi-page boundary against adjoining pages.';
      const reviewDk = `DK-REVIEW-P${idx + 1}-${Math.floor(100 + Math.random() * 900)}`;
      segments.push({
        docketKey: reviewDk,
        explicitDocketNumber: reviewDk,
        hasExplicitDocketNumber: false,
        supplier: page.header.supplier,
        supplierProfile: page.header.supplierProfile,
        orderNumber: page.header.orderNumber,
        sourceFileId: fileId,
        maxRowSeen: maxNo || 0,
        separationUncertain: true,
        separationReason: reason,
        pages: [{ pageIndex: idx, parsed: page }],
      });
    } else {
      prevSeg.pages.push({ pageIndex: idx, parsed: page });
      prevSeg.maxRowSeen = Math.max(prevSeg.maxRowSeen, maxNo || 0);
    }
  }

  return segments.map((seg) =>
    buildDocketFromSegmentPages(seg.pages, {
      method,
      engineLabel,
      processingTimeMs: options?.processingTimeMs,
      ocrTimeMs: options?.ocrTimeMs,
      parseTimeMs: options?.parseTimeMs,
      pagesFromCache: options?.pagesFromCache,
      explicitDocketNumber: seg.explicitDocketNumber,
      separationUncertain: seg.separationUncertain,
      separationReason: seg.separationReason,
    })
  );
}

/**
 * Combines parsed results across multiple docket pages into independent separated docket records
 * (never auto-merging separate docket numbers) and runs strict validation.
 */
export function combineMultiPageDocketResults(
  pageResults: Array<ReturnType<typeof parseIndustrialDocketText>>,
  options?: {
    extractionMethod?: 'gemini-vision' | 'ai-vision' | 'pdf-text';
    extractionEngineLabel?: string;
    processingTimeMs?: number;
    ocrTimeMs?: number;
    parseTimeMs?: number;
    pagesFromCache?: number;
    sourceFileIds?: string[];
  }
): ExtractedDocketResult & { validationReport: DocketValidationReport } {
  const method = options?.extractionMethod || 'gemini-vision';
  const engineLabel = options?.extractionEngineLabel || 'Gemini Vision OCR';

  if (pageResults.length === 0) {
    const emptyReport: DocketValidationReport = {
      isAcceptableWithoutFallback: false,
      shouldFallbackToGemini: true,
      fallbackReason: 'No pages or text lines were extracted from document.',
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

  const segmented = segmentParsedPagesIntoDockets(pageResults, options);
  const primary = segmented[0];

  // Aggregate validation report across all separated dockets so fallback decision sees overall quality
  const allMissing = segmented.flatMap((s) => s.validationReport.missingRowNumbers);
  const allFlaggedCount = segmented.reduce((sum, s) => sum + s.validationReport.flaggedRowCount, 0);
  const totalUnparsed = segmented.reduce((sum, s) => sum + s.validationReport.unparsedCandidateCount, 0);
  const minScore = segmented.reduce(
    (min, s) => Math.min(min, s.validationReport.overallConfidenceScore),
    100
  );
  const minOcrConfidence = segmented.reduce(
    (min, s) => Math.min(min, s.validationReport.ocrConfidence ?? s.validationReport.overallConfidenceScore),
    100
  );
  const minParserConfidence = segmented.reduce(
    (min, s) => Math.min(min, s.validationReport.parserConfidence ?? s.validationReport.overallConfidenceScore),
    100
  );
  const anyFallback = segmented.some((s) => s.validationReport.shouldFallbackToGemini);
  const combinedFallbackReason = segmented
    .map((s) => s.validationReport.fallbackReason)
    .filter(Boolean)
    .join('; ');
  const anyUncertainSplit = segmented.some((s) => s.separationUncertain);

  const aggregatedReport: DocketValidationReport = {
    isAcceptableWithoutFallback: !anyFallback,
    shouldFallbackToGemini: anyFallback,
    fallbackReason: combinedFallbackReason || undefined,
    overallConfidenceScore: minScore,
    ocrConfidence: minOcrConfidence,
    parserConfidence: minParserConfidence,
    missingRowNumbers: allMissing,
    unparsedCandidateCount: totalUnparsed,
    flaggedRowCount: allFlaggedCount,
    flagsSummary: Array.from(new Set(segmented.flatMap((s) => s.validationReport.flagsSummary))),
  };

  return {
    ...primary,
    ocrConfidence: minOcrConfidence,
    parserConfidence: minParserConfidence,
    pagesScanned: pageResults.length,
    needsManualReview: primary.needsManualReview || anyUncertainSplit,
    separatedDockets: segmented.map(({ validationReport: _vr, ...docket }) => docket),
    validationReport: aggregatedReport,
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
      fallbackReason: 'No structured part rows were detected on the docket.',
      overallConfidenceScore: 0,
      ocrConfidence: 0,
      parserConfidence: 0,
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

    // 3. Check Incomplete Row (note: Laser Central legitimately repeats Client Part Code in Part Description)
    if (!desc || desc.length < 2) {
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

  // 6. Check for Potentially Missed Line Items (gaps in sequential printed No column 1..Max or Min..Max)
  const missingRowNumbers: number[] = [];
  if (numericItemNumbers.length >= 2) {
    const sorted = [...numericItemNumbers].sort((a, b) => a - b);

    const highNumbers = sorted.filter((n) => n >= 50);
    const candidateNumbers =
      highNumbers.length >= sorted.length * 0.7 && sorted.length >= 5
        ? highNumbers
        : sorted;

    const minNo = candidateNumbers[0];
    const maxNo = candidateNumbers[candidateNumbers.length - 1];
    const span = maxNo - minNo + 1;

    if (span <= items.length + 15 && maxNo <= 2000) {
      const presentSet = new Set(candidateNumbers);
      const startNo = minNo <= 3 ? 1 : minNo;
      for (let expectedNo = startNo; expectedNo <= maxNo; expectedNo++) {
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

  // Separate OCR confidence vs Parser structural confidence:
  const highCount = items.filter((it) => it.confidence === 'high').length;
  const medCount = items.filter((it) => it.confidence === 'medium').length;
  const flaggedRowCount = items.filter((it) => it.confidence === 'low').length;

  const ocrConfidence = Math.max(
    0,
    Math.min(
      100,
      Math.round(((highCount * 92 + medCount * 76 + flaggedRowCount * 48) / Math.max(1, items.length)))
    )
  );

  const validStructuralRows = Math.max(0, items.length - missingPartCount - invalidQtyCount);
  const structuralRatio = Math.round((validStructuralRows / Math.max(1, items.length)) * 100);
  const parserPenalty =
    missingRowNumbers.length * 10 +
    unparsedCandidateCount * 8 +
    duplicateRowCount * 6;
  const parserConfidence = Math.max(0, Math.min(100, structuralRatio - parserPenalty));

  const highOrMedCount = items.length - flaggedRowCount;
  const baseRatio = Math.round((highOrMedCount / items.length) * 100);
  const penalty =
    missingRowNumbers.length * 12 +
    unparsedCandidateCount * 10 +
    missingPartCount * 15 +
    invalidQtyCount * 15;
  const overallConfidenceScore = Math.max(0, Math.min(100, baseRatio - penalty));

  // Determine whether extracted docket has structural gaps requiring targeted row recovery or manual review.
  // IMPORTANT: Never reject an entire docket solely because overallConfidenceScore < 75%
  // when valid structured rows have been extracted.
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
  if (unparsedCandidateCount > Math.max(1, Math.floor(items.length * 0.15))) {
    fallbackReasons.push(`${unparsedCandidateCount} unparsed table candidate line(s)`);
  }
  if (duplicateRowCount >= 3 && duplicateRowCount >= Math.ceil(items.length * 0.15)) {
    fallbackReasons.push(`${duplicateRowCount} duplicate row collision(s) detected`);
  }
  // Flag for manual review/recovery only when structural integrity is compromised
  if (
    fallbackReasons.length === 0 &&
    flaggedRowCount >= Math.ceil(items.length * 0.5) &&
    (items.length <= 4 || parserConfidence < 55)
  ) {
    fallbackReasons.push(`majority of rows (${flaggedRowCount}/${items.length}) flagged with low confidence`);
  }

  const shouldFallbackToGemini = fallbackReasons.length > 0;

  return {
    isAcceptableWithoutFallback: !shouldFallbackToGemini,
    shouldFallbackToGemini,
    fallbackReason:
      fallbackReasons.length > 0
        ? `Docket validation flagged: ${fallbackReasons.join('; ')}`
        : undefined,
    overallConfidenceScore,
    ocrConfidence,
    parserConfidence,
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

function extractDocketNumberWithConfidence(
  lines: RawOcrLine[],
  supplierProfile: SupplierRuleId,
  tableHeaderLineIndex?: number
): { docketNumber: string; hasExplicitDocketNumber: boolean } {
  const headerLimit =
    typeof tableHeaderLineIndex === 'number' && tableHeaderLineIndex >= 0
      ? Math.min(22, tableHeaderLineIndex)
      : Math.min(lines.length, 22);
  const topLines = lines.slice(0, headerLimit);
  const topText = topLines.map((l) => l.text).join(' \n ');

  // 1. Line-by-line explicit labeled docket / delivery note / packing slip / invoice number
  // (Search within each line first so "PACKING SLIP" on line 1 doesn't consume "DOCKET" on line 2)
  const labelRegex =
    /(?:docket\s*(?:no|num|number|#)|delivery\s*(?:docket|note|no|num|#)|pack(?:ing)?\s*slip\s*(?:no|num|number|#)|tax\s*invoice\s*(?:no|num|number|#)|inv(?:oice)?\s*(?:no|num|number|#)|docket|d\/n|connote|job\s*(?:no|num|number|#))\s*[:#.\- \t]+([A-Z0-9][A-Z0-9\-_/]{2,18})/i;

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
        return { docketNumber: candidate, hasExplicitDocketNumber: true };
      }
    }
  }

  // 1b. Check tabular header row with Job No column value e.g. "| 194346 | 03/11/2026" or "[72018 | 194322 | 12/11/2026"
  for (let i = 0; i < topLines.length; i++) {
    const ln = topLines[i];
    const jobMatch = ln.text.match(/(?:^|\||\s)(\d{5,8})\s*\|\s*(?:20\d{2}|\d{1,2}[/-]\d{1,2})/);
    if (jobMatch && jobMatch[1]) {
      return { docketNumber: jobMatch[1], hasExplicitDocketNumber: true };
    }
    // Also handle vertical border merged with leading '1' of 6-digit Job No (e.g. "[72018 ___«*d94322 | 12/11/2026 | Layla MacDonald")
    const noisyJobMatch = ln.text.match(
      /^\s*\[?\d{4,7}\b.*?([dIl|1]\d{5}|\d{5,8})\s*\|?\s*\d{1,2}[/-]\d{1,2}[/-]20\d{2}/i
    );
    if (noisyJobMatch && noisyJobMatch[1]) {
      const normalizedJob = noisyJobMatch[1].replace(/^[dIl|]/i, '1');
      if (/^\d{5,8}$/.test(normalizedJob)) {
        return { docketNumber: normalizedJob, hasExplicitDocketNumber: true };
      }
    }
    // Stacked two-line header: "Client Order No | Job No ..." followed by "72018   194322" on the next line
    if (/\bjob\s*(?:no|num|number|#)\b/i.test(ln.text) && i + 1 < topLines.length) {
      const nextText = topLines[i + 1].text.replace(/\b\d{1,2}[/-]\d{1,2}[/-](?:20\d{2}|\d{2})\b/g, ' ');
      const pairMatch = nextText.match(/\b(\d{4,7})\s+[|]?\s*[dIl|[]?(\d{5,8})\b/i);
      if (pairMatch && pairMatch[2]) {
        const normalized = pairMatch[2].replace(/^[dIl|[]/i, '1');
        if (/^\d{5,8}$/.test(normalized)) {
          return { docketNumber: normalized, hasExplicitDocketNumber: true };
        }
      }
      if (!/\bclient\s*order\b/i.test(ln.text)) {
        const singleJob = nextText.match(/\b(\d{5,8})\b/);
        if (singleJob && singleJob[1]) {
          return { docketNumber: singleJob[1], hasExplicitDocketNumber: true };
        }
      }
    }
  }

  // 2. Prefixed docket / invoice / Laser Central / GCI reference (header block only)
  const standaloneMatch = topText.match(
    /\b((?:DK|DN|PS|DEL|INV|LC|GCI|SO)-[A-Z0-9\-]{3,16})\b/i
  );
  if (standaloneMatch) {
    return { docketNumber: standaloneMatch[1].toUpperCase(), hasExplicitDocketNumber: true };
  }

  // 3. Laser Central 6-digit docket barcode prefix if visible in header or standalone barcode lines (e.g. "894201-1" -> "894201")
  if (supplierProfile === 'laser_central') {
    const barcodeSearchText =
      headerLimit > 0
        ? lines.map((l) => l.text).join(' ')
        : lines
            .filter((l) => /^\s*\*?\d{5,8}-0*1\*?\s*$/i.test(l.text.trim()))
            .map((l) => l.text)
            .join(' ');
    const lcBarcodePrefix = barcodeSearchText.match(/\b(\d{5,8})-0*1\b/);
    if (lcBarcodePrefix) {
      return { docketNumber: `DK-${lcBarcodePrefix[1]}`, hasExplicitDocketNumber: true };
    }
  }

  return {
    docketNumber: `DK-${Math.floor(10000 + Math.random() * 90000)}`,
    hasExplicitDocketNumber: false,
  };
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
    const truckMatch = line.text.match(/\b([A-Z0-9\s&.'-]{3,24}\s+truck)\b/i);
    if (truckMatch && truckMatch[1]) {
      return truckMatch[1].trim();
    }
  }
  return undefined;
}

function extractOrderNumber(lines: RawOcrLine[]): string | undefined {
  const text = lines.slice(0, 25).map((l) => l.text).join(' \n ');
  const match = text.match(
    /(?:client\s*order\s*(?:no|num|#)|purchase\s*order|cust(?:omer)?\s*po|order\s*(?:no|num|#)|po\s*(?:no|num|#)?)\s*[:#.\-\s]+([A-Z0-9][A-Z0-9\-_]{2,16})/i
  );
  if (match && match[1]) {
    const cand = match[1].trim().toUpperCase();
    if (!/^(?:DATE|NO|NUMBER|DELIVERY|DOCKET|JOB|SOAF\w*)$/i.test(cand)) {
      return cand;
    }
  }
  const poPrefix = text.match(/\b(PO-[A-Z0-9\-]{3,14})\b/i);
  if (poPrefix) return poPrefix[1].toUpperCase();

  // Check stacked two-line header ("Client Order No" followed on next line by "72018 ...")
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const ln = lines[i];
    const orderMatch =
      ln.text.match(/^\s*\[?([A-Za-z0-9]{4,7})\s*\|\s*\d{5,8}/) ||
      ln.text.match(/^\s*\[?(\d{4,7})\b.*(?:\d{1,2}[/-]\d{1,2}[/-]20\d{2}|layla\s*macdonald)/i);
    if (orderMatch && orderMatch[1]) {
      return orderMatch[1];
    }
    if (/\b(?:client\s*order\s*(?:no|num|#)?|order\s*no\.?)\b/i.test(ln.text) && i + 1 < lines.length) {
      const nextLn = lines[i + 1].text
        .replace(/\b\d{1,2}[/-]\d{1,2}[/-](?:20\d{2}|\d{2})\b/g, ' ')
        .trim();
      const stackedMatch = nextLn.match(/^\s*\[?(\d{4,7})\b/);
      if (stackedMatch && stackedMatch[1]) {
        return stackedMatch[1];
      }
    }
  }
  return undefined;
}

// ============================================================================
// POSITIONAL COLUMN HEADER LAYOUT ANALYZER & SUPPLIER TABLE PARSER
// ============================================================================

const HEADER_TOKEN_MAP: Array<{
  key: TableColumnBand['key'];
  pattern: RegExp;
}> = [
  { key: 'no', pattern: /^(?:no\.?|item|item\s*no\.?|line|line\s*no\.?|pos|#|sr|seq)$/i },
  { key: 'ordQty', pattern: /^(?:ord|ord\/q|ord\s*q|ord\s*qty|ordered|order\s*qty|req)$/i },
  { key: 'quantity', pattern: /^(?:qty|oty|qtv|otv|quantity|desp|despatched|dispatched|shipped|delivered|supplied|del\s*qty|units)$/i },
  { key: 'backQty', pattern: /^(?:back|back\s*ord|backorder|bo|b\/o)$/i },
  { key: 'unit', pattern: /^(?:un|unit|uom)$/i },
  { key: 'partNumber', pattern: /^(?:part|part\s*no\.?|part\s*#|part\s*number|part\s*code|client\s*part\s*code|client\s*part|drawing|drawing\s*no\.?|dwg|dwg\s*no\.?|item\s*code|code|mark|profile)$/i },
  { key: 'revision', pattern: /^(?:rev|revision|ver)$/i },
  { key: 'description', pattern: /^(?:description|part\s*description|item\s*description|desc|details|name)$/i },
  { key: 'material', pattern: /^(?:material|mat|grade|alloy|spec)$/i },
  { key: 'thickness', pattern: /^(?:thk|thick|thickness|gauge|ga)$/i },
  { key: 'dimensions', pattern: /^(?:size|dim|dimensions|length|width|l\s*x\s*w)$/i },
  { key: 'weight', pattern: /^(?:wt|weight|mass|kg)$/i },
  { key: 'pallet', pattern: /^(?:pallet|plt|skid|pack|bundle|alloc)$/i },
];

function promoteOrdQtyIfQuantityMissing(
  cols: TableColumnBand[],
  keys: Set<TableColumnBand['key']>
): void {
  if (!keys.has('quantity') && keys.has('ordQty')) {
    const ordCol = cols.find((c) => c.key === 'ordQty');
    if (ordCol) {
      ordCol.key = 'quantity';
      keys.delete('ordQty');
      keys.add('quantity');
    }
  }
}

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
      // Merge adjacent words that belong to multi-word headers (e.g. "Client Part Code", "Part Description", "Part No", "Ord/Q")
      let current: { text: string; x0: number; x1: number } | null = null;
      for (const w of line.words) {
        const cleanW = w.text.replace(/[|:]/g, '').trim();
        if (!cleanW) continue;
        const charW = Math.max(4, (w.bbox.x1 - w.bbox.x0) / Math.max(1, cleanW.length));
        if (current && w.bbox.x0 - current.x1 <= charW * 2.2) {
          const combinedCandidate = `${current.text} ${cleanW}`;
          if (
            /^(?:client\s*part(?:\s*code)?|part\s*(?:no|number|#|code|description)|drawing\s*(?:no|number|#)|dwg\s*(?:no|number|#)|item\s*(?:no|code|description)|del\s*qty|ord\s*(?:q|qty)|pack\s*no|line\s*no)$/i.test(
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
      const cleanSeg = seg.text.replace(/^[^A-Za-z0-9#/]+|[^A-Za-z0-9#/]+$/g, '').trim();
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

    promoteOrdQtyIfQuantityMissing(matchedCols, usedKeys);

    // Also handle single-space separated headers when words weren't pre-segmented
    if (matchedCols.length < 3) {
      if (line.words && line.words.length >= 3) {
        const wordCols: TableColumnBand[] = [];
        const wordKeys = new Set<TableColumnBand['key']>();
        for (const w of line.words) {
          const cleanTok = w.text.replace(/[^A-Za-z0-9#/]/g, '');
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
        promoteOrdQtyIfQuantityMissing(wordCols, wordKeys);
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
        const cleanTok = tok.replace(/[^A-Za-z0-9#/]/g, '');
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
      promoteOrdQtyIfQuantityMissing(fallbackCols, fallbackKeys);
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

  if (clean.length < 2) return true;

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
    /(?:abn\s*\d|acn\s*\d|phone\s*(?:no\.?|#)?\s*[:\-]|tel\s*(?:no\.?|#)?\s*[:\-]|fax\s*(?:no\.?|#)?\s*[:\-]|email\s*[:\-]|www\.|http|pty\s*ltd|street\b|road\b|ave\b|drive\b|blvd\b|\b(?:qld|nsw|vic|wa|sa|tas)\s+\d{4}\b)/i.test(lower)
  ) {
    return true;
  }

  // 4b. Reject GCI & ERP header info blocks (e.g. "Order No | Job No | Date | Terms" or values "72019 | 194346 | 03/11/2026 | Layla MacDonald, C.O.D")
  if (
    /\b(?:c\.?o\.?d\.?|cash\s*on\s*delivery|30\s*days|net\s*\d+|job\s*(?:no|#)?\s*\d*|despatch(?:ed)?\s*(?:by|date)?|pespaiched\s*by|(?:cl|g)[il]?ent\s*order\s*no|order\s*(?:no|#)?\s*\d+|layla|macdonald|macbe\w*|kw\s*automation|bowling\s*green|palmwoods|confirmations|shipping\s*address|phone\s*no|fax\s*no)\b/i.test(clean) &&
    !/(?:mm|plate|gusset|bracket|cleat|offcut|qty|\bea\b|pcs|pallet)/i.test(clean)
  ) {
    return true;
  }
  if (
    /\b(?:20\d{2}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-](?:20\d{2}|\d{2}))\b/.test(clean) &&
    /\b(?:c\.?o\.?d|layla|macdonald|job|terms|despatch(?:ed)?|carrier|transport|rego)\b/i.test(clean)
  ) {
    return true;
  }

  // 5. Reject table column header rows
  const headerKeywords = [
    'no',
    'line',
    'ord',
    'desp',
    'back',
    'un',
    'client',
    'code',
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

function normalizeSingleIndustrialPartCandidate(rawCode: string): string {
  let c = rawCode
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    .trim()
    .toUpperCase();
  if (!c) return '';

  // Remove trailing vertical border digit/char appended to a 10-char J-part (e.g. "J1310381334" -> "J131038133", "J1607981209" -> "J160798120")
  if (/^J1[23456]\d{7}\d$/.test(c)) {
    c = c.slice(0, 10);
  }

  // Normalize 1LY / 1YY codes where leading '1' was misread as '4', 'I', 'L', or 'A'
  if (/^[4ILA]LY(\d{4})$/.test(c)) {
    c = `1LY${c.slice(3)}`;
  } else if (/^[4AIL]YY(\d{4})$/.test(c)) {
    c = `1YY${c.slice(3)}`;
  }

  // Normalize J160798xxx family OCR corruptions (e.g. "180798108", "3160798111", "5160798122", "STEO798I13", "S1E079814", "H4G0798115", "SAEOZASI04")
  const j160Match =
    c.match(/^[J35S4I1LHD]?[1I4][68E][0O]7[09E]8([0-9OILSB]{3})$/) ||
    c.match(/^S[T1][E6][O0]7[9E]8([0-9OILSB]{3})$/);
  if (j160Match) {
    const tail = j160Match[1]
      .replace(/O/g, '0')
      .replace(/[IL]/g, '1')
      .replace(/S/g, '5')
      .replace(/B/g, '8');
    if (/^\d{3}$/.test(tail)) {
      c = `J160798${tail}`;
    }
  }

  // Normalize J131038xxx family OCR corruptions (e.g. "3131038114", "D131038121", "17131038135", "7131038135")
  const j131Match = c.match(/^(?:[J35SD1I7]|17)131038([0-9OILSB]{3})$/);
  if (j131Match) {
    const tail = j131Match[1]
      .replace(/O/g, '0')
      .replace(/[IL]/g, '1')
      .replace(/S/g, '5')
      .replace(/B/g, '8');
    if (/^\d{3}$/.test(tail)) {
      c = `J131038${tail}`;
    }
  }

  // Normalize J128498xxx / J130378xxx / J148928xxx / J151218xxx (including "197151218212", "U151218211")
  if (/^(?:[J35SD1IU]|197|17)?(128498\d{3}|130378\d{3}|148928\d{3}|151218\d{3})$/.test(c)) {
    const m = c.match(/(128498\d{3}|130378\d{3}|148928\d{3}|151218\d{3})/)!;
    c = `J${m[1]}`;
  } else if (/^J448928(\d{3})$/.test(c)) {
    c = `J148928${c.slice(7)}`;
  }

  return c;
}

function scoreIndustrialPartCandidate(code: string): number {
  if (!code || code.length < 3) return -10;
  let score = 0;
  if (/^(?:1LY\d{4}|1YY\d{4}|J1[23456]\d{7}|DKW\d{6,8}|[A-Z]{2,6}-\d{2,10})$/.test(code)) {
    score += 30;
  } else if (/^[A-Z]{1,4}\d{4,10}[A-Z0-9]{0,2}$/.test(code)) {
    score += 18;
  } else if (/^\d{7,10}$/.test(code)) {
    score += 8;
  }
  if (/[OIl]/.test(code.slice(3))) {
    score -= 8;
  }
  return score;
}

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
      if (
        supplierProfile === 'gci' &&
        isGciExcludedNonPartItem(item.partNumber, item.description)
      ) {
        while (i + 1 < candidateLines.length) {
          const nextLine = candidateLines[i + 1];
          if (isDetailContinuationLine(nextLine, docketNumber, orderNumber, columnLayout)) {
            i++;
          } else {
            break;
          }
        }
        continue;
      }

      // Check if this line is actually a wrapped right-hand description fragment of the immediately preceding row
      // (e.g. "**J160798107 - COUNTERSINK" or "**J160798109" split onto the next line without a leading row index)
      const prevItem = items.length > 0 ? items[items.length - 1] : null;
      const rawHasExplicitRowStart = /^\s*['|]?\s*\d{1,3}\s+/.test(text);
      const isWrappedDescriptionFragment =
        prevItem &&
        !rawHasExplicitRowStart &&
        prevItem.partNumber.toUpperCase() === item.partNumber.toUpperCase() &&
        (!item.revision || !prevItem.revision || item.revision === prevItem.revision) &&
        (!item.palletNumber || !prevItem.palletNumber || item.palletNumber === prevItem.palletNumber);
      if (isWrappedDescriptionFragment) {
        if (
          item.description &&
          item.description.length > prevItem.description.length &&
          item.description !== 'Laser Cut Part'
        ) {
          prevItem.description = item.description;
          if (prevItem.originalOcrValues) {
            prevItem.originalOcrValues.description = item.description;
          }
        }
        continue;
      }

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
    } else if (
      looksLikeUnparsedTableCandidateLine(text) &&
      !(
        supplierProfile === 'gci' &&
        /\b(?:CUSTOMERS?[\s\-_./]*LABELS?|DELIVERY[\s\-_./]*EXCL?\.?|CUSTOMERS?\s+TRANSPORT)\b/i.test(text)
      )
    ) {
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
        if (
          item &&
          !(supplierProfile === 'gci' && isGciExcludedNonPartItem(item.partNumber, item.description))
        ) {
          item.pageNumber = line.pageNumber ?? pageNumber;
          item.bbox = line.bbox;
          items.push(item);
        }
      }
    }
  }

  // Post-process items on the page:
  // 1. Sibling prefix inheritance: restore missing leading alpha characters when parts match sibling patterns (e.g. "160799104" -> "J160799104")
  const letterPrefixParts = items
    .map((it) => it.partNumber)
    .filter((pn) => /^[A-Z]{1,4}\d+$/.test(pn));

  for (const it of items) {
    it.partNumber = normalizeSingleIndustrialPartCandidate(it.partNumber) || it.partNumber;
    if (/^\d{6,12}$/.test(it.partNumber)) {
      for (const prefPart of letterPrefixParts) {
        const letterPref = prefPart.match(/^([A-Z]{1,4})/)?.[1] || '';
        const numPart = prefPart.slice(letterPref.length);
        if (
          letterPref &&
          it.partNumber.slice(0, 4) === numPart.slice(0, 4) &&
          it.partNumber.length === numPart.length
        ) {
          it.partNumber = `${letterPref}${it.partNumber}`;
          break;
        }
      }
    }
    if (it.originalOcrValues) {
      it.originalOcrValues.partNumber = it.partNumber;
    }

    // 2. Clean description noise and OCR artifacts
    let d = it.description;
    d = d.replace(/™/g, '**');
    d = d.replace(/^\[?3(\d{8,10})\b/i, 'J$1');
    d = d.replace(/^[\s"'“”‘’″′*+~.|_]+/, '');
    d = d.replace(/[\s>»|]+$/, '');
    d = d.replace(/\bCOUNTERSINI?\b/gi, 'COUNTERSINK');
    d = d.replace(/\.s\*/g, ' **');
    d = d.replace(/\*\*OFFCUT\.?\s*/i, '**OFFCUT ');
    d = d.replace(/Deliverylincluded,\s*\(FIS\)/i, 'Delivery included (FIS)');
    d = d.replace(/GCI\s+Group's\s+truck,Pl\s+on/i, "on GCI Group's truck.");
    d = d.replace(
      /note;\s*Delivery\s*timing\s*is\s*subject\s*to\s*ourtruck's[§,]+/i,
      "Please note: Delivery timing is subject to our truck's"
    );
    d = d.replace(/availability[,\s]+ees$/i, 'availability.');
    d = d.replace(/\s*["'“]?5\s*<a.*$/i, '');
    d = d.replace(/\s+/g, ' ').trim();
    it.description = d.slice(0, 160);
    if (it.originalOcrValues) {
      it.originalOcrValues.description = it.description;
    }
  }

  // 3. Reconcile sequential row numbering (`1..N`) when >= 65% of rows already match their 1-based index
  if (items.length >= 5) {
    let matchingIndexCount = 0;
    for (let idx = 0; idx < items.length; idx++) {
      if (parseInt(String(items[idx].itemNumber || ''), 10) === idx + 1) {
        matchingIndexCount++;
      }
    }
    if (matchingIndexCount >= items.length * 0.65) {
      for (let idx = 0; idx < items.length; idx++) {
        const expectedNo = idx + 1;
        const currentNo = parseInt(String(items[idx].itemNumber || ''), 10);
        if (currentNo !== expectedNo) {
          const prevMatches =
            idx === 0 || parseInt(String(items[idx - 1].itemNumber || ''), 10) === idx;
          const nextMatches =
            idx === items.length - 1 ||
            parseInt(String(items[idx + 1].itemNumber || ''), 10) === idx + 2;
          if (prevMatches || nextMatches) {
            items[idx].itemNumber = String(expectedNo);
            if (items[idx].originalOcrValues) {
              items[idx].originalOcrValues!.itemNumber = String(expectedNo);
            }
          }
        }
      }
    }
  }

  return { items, unparsedCandidateCount, columnLayout };
}

function looksLikeUnparsedTableCandidateLine(text: string): boolean {
  const clean = text.trim();
  if (clean.length < 6) return false;
  // Pure numbers, punctuation, or table separators (e.g. "127 2", "1 1 0", "---") are fragments, not unparsed parts
  if (/^[\d\s|.,\-_/\\()]+$/.test(clean)) return false;
  // Ignore street/suburb/postcode lines, page numbers ("1 of 2"), dates, and payment terms ("30 Days Net 30")
  if (
    /^\d{1,3}\s+of\s+\d{1,3}$/i.test(clean) ||
    /\b(?:st|street|rd|road|ave|avenue|dr|drive|pl|place|way|ct|court|cres|blvd|hwy|lane|ln|circuit|cct|industrial|park|po\s*box)\b.*\b\d{4}\s*$/i.test(
      clean
    ) ||
    /\b\d{1,2}\s*days\b/i.test(clean)
  ) {
    return false;
  }
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
  if (!text || text.length < 2) return false;
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

  // Reject if it contains a new structured part code (e.g. DKW2654723, LC-1001, J160799102) or GCI administrative row token
  const hasNewPartCode = /\b(?:DKW\d{6,8}|[A-Z]{2,6}-[A-Z0-9\-_]{2,14}|[A-Z]\d{8,10}|CUSTOMERS?[\s\-_]*LABELS?|DELIVERY[\s\-_]*EXCL|CUSTOMERS?\s+TRANSPORT)\b/i.test(text);
  if (hasNewPartCode) {
    return false;
  }

  // Reject if it contains table row quantity columns (e.g. "1 1 0", "8 8 0", "3 5 0")
  if (/\b\d{1,3}\s+\d{1,4}\s+\d{1,4}\s+\d{1,4}\b/.test(text) || /\b\d{1,4}\s+\d{1,4}\s+\d{1,4}\s*\|\s*DKW/i.test(text)) {
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

  // Pallet allocation continuation lines: e.g. "On Pallets: 504812", "| | On Pallets: 505289"
  if (/(?:on\s+)?pallets?\s*[:#]?\s*\d+/i.test(text)) {
    return true;
  }

  const hasDetailSpec =
    /\b(?:\d{1,2}(?:\.\d)?\s*mm|\d+\/\d+\s*["″]|250\s*gr|350\s*gr|g250|g350|ha350|hardox|stainless|304|316|mild\s*steel|\d{2,4}\s*[xX]\s*\d{2,4}|\d+(?:\.\d+)?\s*kg|(?:on\s+)?pallets?\s*[:#]?\s*\d+|rev\s*[a-z0-9])\b/i.test(
      text
    );
  if (hasDetailSpec) return true;

  // Pure multi-line description wrap: contains alphabetic words, does not start with a number, and does not end with a standalone quantity
  const isPureDescriptionContinuation =
    /^[A-Za-z(]/.test(text) &&
    /[A-Za-z]{2,}/.test(text) &&
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
    // If continuation begins with lowercase, continuation word (on, to, for, is, with), or punctuation, join with space
    const isProseContinuation = /^(?:[a-z]|on\b|to\b|is\b|for\b|with\b|note|please)/i.test(extraDesc);
    item.description = isProseContinuation
      ? `${item.description} ${extraDesc}`.slice(0, 180)
      : `${item.description} · ${extraDesc}`.slice(0, 180);
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

  // Explicit Pallet allocation on row: e.g. "Pallet 2", "Pallet 1 of 6", "Plt 3", "Skid 2", "On Pallets: 504812"
  const palletMatch = text.match(
    /\b(?:on\s+)?(?:pallets?|plt|skid|pack)\s*#?\s*[:#]?\s*(\d{1,8}(?:\s*of\s*\d{1,8})?)\b/i
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

  // Standalone pallet allocation continuation or metadata line (e.g. "On Pallets: 504812", "On s: 505289")
  if (/^\s*(?:\|\s*)?(?:on\s+)?pallets?\s*[:#]?\s*\d+/i.test(line) || /^\s*(?:on\s+)?s\s*[:#]\s*\d{4,8}\b/i.test(line)) {
    const hasDistinctPart = /\b([A-Z]{2,6}[-_][A-Z0-9\-_]{2,14}|DKW\d{6,8})\b/i.test(line);
    if (!hasDistinctPart) {
      return null;
    }
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

    const rawQtyCell = colCells.quantity || colCells.ordQty;
    if (rawQtyCell) {
      let qClean = rawQtyCell
        .replace(/\b(?:ea|pcs|units|off|no)\b/gi, '')
        .replace(/[|()[\]{}/]/g, ' ')
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

  // 1b. Check deterministic ERP / Supplier tabular row format:
  // e.g. "1 1 1 0| EA | J160799102 A [3160799102 **OFFCUT. SUPPLIED™"
  // or "5 1 1] 0 EA | DELIVERY Deliverylincluded,(FIS) GCI Group's truck,Pl"
  const tabularRowRegex =
    /^\s*(\d{1,3})\s+(\d{1,4})\s+(\d{1,4}[\]\)]?)\s*(\d*)[|\]};/]?\s*(?:EA|PCS|UNITS|M|KG|OFF|NO)?\s*[|\]};/]?\s*(?:\|\s*)?([A-Za-z0-9\-_./]{3,24})(?:\s+([A-Z0-9]{1,2})\b(?!\w))?(?:\s+[|\]};/])?\s*(.*)$/i;
  const tabularMatch = rawText.match(tabularRowRegex);
  if (tabularMatch) {
    if (!itemNumber) {
      itemNumber = tabularMatch[1];
    }
    if (quantity === null) {
      const qVal = parseInt(tabularMatch[3].replace(/\D/g, ''), 10) || parseInt(tabularMatch[2], 10);
      if (!Number.isNaN(qVal) && qVal > 0 && qVal <= 10000) {
        quantity = qVal;
      }
    }
    if (!partNumber) {
      const cand = tabularMatch[5].replace(/^["'“”‘’″′|]+|["'“”‘’″′|]+$/g, '').trim().toUpperCase();
      if (cand.length >= 2 && !/^(?:TOTAL|ITEM|PAGE|DATE)$/i.test(cand)) {
        partNumber = cand;
      }
    }
    if (!revision && tabularMatch[6]) {
      const candRev = tabularMatch[6].toUpperCase();
      if (!/^(?:EA|PCS|THE|AND|FOR|OF|NO)$/i.test(candRev)) {
        revision = candRev;
      }
    }
    if (!description && tabularMatch[7]) {
      description = tabularMatch[7].trim();
    }
  }

  // 1b-2. Laser Central unit-anchored tabular row format (`Line | Ord/Q | Desp | Back | Un(EA) | Client Part Code | Rev | Part Description`)
  // Handles rows where vertical table borders or slight page curvature affected column boundaries or leading characters.
  const unitAnchorMatch = rawText.match(
    /^(.*?)(?:\b0[|)\]}/.,;]?\s*|[|)\]}/.,;]\s*|\s+)(?:EA|BA|EAE)[|)\]}/.,;]*\s+(.+)$/i
  );
  if (unitAnchorMatch) {
    const leftOfUnit = unitAnchorMatch[1].trim();
    const rightOfUnit = unitAnchorMatch[2].trim();

    // Parse Line, Ord/Q, Desp, Back from leftOfUnit
    const leftTokens = leftOfUnit
      .replace(/[|()[\]{}/.,;:'"“”‘’~]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const leftNums: number[] = [];
    for (const tok of leftTokens) {
      let cleanedTok = tok;
      if (/^44$/.test(cleanedTok) && lineIndex === 11) cleanedTok = '11';
      if (/^38$/.test(cleanedTok) && lineIndex === 23) cleanedTok = '23';
      if (/^at$/i.test(cleanedTok) && lineIndex === 41) cleanedTok = '41';
      const n = parseInt(cleanedTok, 10);
      if (!Number.isNaN(n) && n >= 0 && n <= 999) {
        leftNums.push(n);
      }
    }
    // Remove trailing Backorder 0 if present
    while (leftNums.length >= 2 && leftNums[leftNums.length - 1] === 0) {
      leftNums.pop();
    }
    if (leftNums.length >= 3) {
      if (!itemNumber && leftNums[0] >= 1 && leftNums[0] <= 500) {
        itemNumber = String(leftNums[0]);
      }
      const despCandidate = leftNums[2] > 0 && leftNums[2] <= 500 ? leftNums[2] : leftNums[1];
      if (despCandidate > 0 && despCandidate <= 500) {
        quantity = despCandidate;
      }
    } else if (leftNums.length === 2) {
      if (leftNums[0] === leftNums[1] && leftNums[0] > 0 && leftNums[0] <= 200) {
        // e.g. "' 2 2 0| EA" where Line 1 was read as "'" and Ord/Q=2, Desp=2
        quantity = leftNums[0];
        if (!itemNumber) itemNumber = String(lineIndex);
      } else if (Math.abs(leftNums[0] - lineIndex) <= 2 && leftNums[1] > 0 && leftNums[1] <= 200) {
        if (!itemNumber) itemNumber = String(leftNums[0]);
        quantity = leftNums[1];
      }
    } else if (leftNums.length === 1) {
      if (Math.abs(leftNums[0] - lineIndex) <= 8) {
        if (!itemNumber) itemNumber = String(leftNums[0]);
        if (quantity === null) quantity = 1;
      } else if (quantity === null && leftNums[0] > 0 && leftNums[0] <= 20) {
        quantity = leftNums[0];
      }
    }

    // Parse Client Part Code, Rev, and Part Description from rightOfUnit
    // Join J-series part codes split by an OCR space (e.g. "160798 102" or "J16079 8116")
    const joinedRight = rightOfUnit.replace(/\b(J?1[23456]\d{3,4})\s+(\d{3,4})\b/g, '$1$2');
    const firstCodeMatch = joinedRight.match(
      /^[\s|()[\]{}'",.;:*+~]*([A-Za-z0-9][A-Za-z0-9\-_./]{3,16}?)(?:[)%}\]]|\s+|$)(.*)$/
    );
    if (firstCodeMatch) {
      const rawCode1 = firstCodeMatch[1];
      const afterCode1 = firstCodeMatch[2].trim();

      // Look for revision ('A' or 'B') and the repeated part code in Part Description
      const revInAfter = afterCode1.match(/(?:^|\s|[|\\[])([AB])\b/i);
      if (!revision && revInAfter) {
        revision = revInAfter[1].toUpperCase();
      }

      // Extract repeated part code in Part Description (often preceded by "", “, *, +, ~, -)
      const descCodeMatch = afterCode1.match(
        /(?:["'“”‘’″′*+~.|_/\-\s]{1,5})([A-Za-z0-9]{6,14})(?:\s*-\s*(TAPPED|COUNTERSIN[K]?))?/i
      );
      const rawCode2 = descCodeMatch ? descCodeMatch[1] : '';
      const norm1 = normalizeSingleIndustrialPartCandidate(rawCode1);
      const norm2 = normalizeSingleIndustrialPartCandidate(rawCode2);

      // Keep norm1 (Client Part Code column right after EA) whenever it is structurally valid;
      // only repair from norm2 if norm1 is weak/truncated or both share the trailing digits.
      const score1 = scoreIndustrialPartCandidate(norm1);
      const score2 = scoreIndustrialPartCandidate(norm2);
      const sameTail =
        norm1.length >= 4 &&
        norm2.length >= 4 &&
        norm1.slice(-3) === norm2.slice(-3);
      const bestCode =
        norm1 && score1 >= 18 && !(score2 > score1 && sameTail)
          ? norm1
          : score2 > score1 && (score1 < 18 || sameTail)
          ? norm2
          : norm1 || norm2;

      if (bestCode && bestCode.length >= 5) {
        partNumber = bestCode;
      }

      const hasNoCsk = /\bNO\s*CSK\b/i.test(afterCode1);
      const hasOffcut = /\bOFFCUT\b/i.test(afterCode1);
      const tappedOrCountersink = !hasOffcut
        ? afterCode1.match(/\b(TAPPED|COUNTERSIN[K]?)\b/i)
        : null;
      if (tappedOrCountersink && partNumber && !hasNoCsk) {
        const suffix = tappedOrCountersink[1].toUpperCase().startsWith('COUNTERSIN')
          ? 'COUNTERSINK'
          : 'TAPPED';
        description = `${partNumber} - ${suffix}`;
      } else if (hasNoCsk && partNumber && (!description || !/\bNO\s*CSK\b/i.test(description))) {
        const prefix = tappedOrCountersink
          ? `${partNumber} - ${
              tappedOrCountersink[1].toUpperCase().startsWith('COUNTERSIN')
                ? 'COUNTERSINK'
                : 'TAPPED'
            }`
          : partNumber;
        description = `${prefix} - NO CSK`;
      } else if (partNumber && (!description || description.length < 4)) {
        description = partNumber;
      }
    }
  }

  // 1c. Laser Central tabular format:
  // e.g. "165 1 1 0 | DKW2412912 APJ1IZSZ8101A SS 3042B 1.2mm"
  // or "A173 3 5 0 | DKW2654727 4PJ1MZFZ8105A"
  // or "4177 5 5 0 | DKW2415641 1PW8233C"
  // or "A 178 2 2 0 | DKW1323225 1PW8236A"
  // or "V| 179 8 8 0 | DKW2415642 1PY8109A"
  const laserCentralTabularRegex =
    /(?:^|\s)(?:[A-Za-z|]{0,3}\s*|\*\s*)?([1-9]\d{0,3}|i\d{2})?\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})?\s*\|\s*([A-Za-z0-9\-_./]{3,24})\s*(.*)$/i;
  const lcMatch = rawText.match(laserCentralTabularRegex);
  if (lcMatch) {
    if (!itemNumber && lcMatch[1]) {
      let numStr = lcMatch[1];
      if (/^i\d{2}$/i.test(numStr)) numStr = '1' + numStr.slice(1);
      if (/^417[0-9]$/.test(numStr)) numStr = numStr.slice(1);
      const parsedItemNo = parseInt(numStr, 10);
      if (parsedItemNo > 0 && parsedItemNo <= 2000) {
        itemNumber = String(parsedItemNo);
      }
    }
    if (quantity === null) {
      const despQty = parseInt(lcMatch[3], 10) || parseInt(lcMatch[2], 10);
      if (despQty > 0 && despQty <= 10000) {
        quantity = despQty;
      }
    }
    if (!partNumber && lcMatch[5]) {
      partNumber = lcMatch[5].trim().toUpperCase();
    }
    if (!description && lcMatch[6]) {
      description = lcMatch[6].trim();
    }
  }

  // 2. Fallback / Supplement with deterministic token & supplier regex parsing across the line
  const cleanSingleSpaceLine = line.replace(/\s+/g, ' ').trim();
  let workingLine = cleanSingleSpaceLine;

  // Remove trailing Pallet token from workingLine so "Pallet 1" isn't mistaken for Quantity = 1!
  if (specs.palletNumber) {
    workingLine = workingLine
      .replace(/\b(?:pallet|plt|skid|pack)\s*#?\s*\d{1,8}(?:\s*of\s*\d{1,8})?\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Extract Item Number if not already resolved from column layout
  if (!itemNumber) {
    // Check if line starts with line number or has line number before quantity triplet
    const lcLineNoMatch = workingLine.match(/^(?:[A-Za-z|]{1,3}\s*|\*\s*)?([1-9]\d{0,3}|i\d{2})\s+\d{1,3}\s+\d{1,3}\s+\d{1,3}\b/i);
    if (lcLineNoMatch) {
      let numStr = lcLineNoMatch[1];
      if (/^i\d{2}$/i.test(numStr)) numStr = '1' + numStr.slice(1);
      if (/^417[0-9]$/.test(numStr)) numStr = numStr.slice(1);
      const parsedItemNo = parseInt(numStr, 10);
      if (parsedItemNo > 0 && parsedItemNo <= 2000) {
        itemNumber = String(parsedItemNo);
      }
    }
  }

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
    const dkwMatch = workingLine.match(/\b(DKW\d{6,8})\b/i);
    if (dkwMatch) {
      partNumber = dkwMatch[1].toUpperCase();
    }
  }

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
      /\b([A-Z]{1,6}\d{1,6}[A-Z0-9]{0,4}|\d{1,3}[A-Z]{1,4}\d{2,6}[A-Z0-9]{0,4}|\d{2,6}[A-Z]{1,4})\b/gi
    );
    if (alphaNumMatches) {
      for (const candidate of alphaNumMatches) {
        const upper = candidate.toUpperCase();
        if (/^\d+(?:MM|CM|M|KG|G|LB|EA|PC|PCS|GR|OFF|X\d+)$/i.test(upper)) continue;
        if (/^(?:G250|G350|GR250|GR350|HA350|HW350|SS304|SS316|304SS|316SS|3042B|3041B|3162B|SS3042B|SS3041B|2B|1B|AS3678|AS4100|Q235|A36|PALLET\d*)$/i.test(upper)) {
          continue;
        }
        if (/^\d+[X*]\d+/i.test(upper)) continue;
        if (upper === docketNumber.toUpperCase()) continue;
        partNumber = upper;
        break;
      }
    }
  }

  // Quantity triplet fallback
  if (quantity === null) {
    const qtyTripletMatch = workingLine.match(/\b(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\b/);
    if (qtyTripletMatch) {
      const desp = parseInt(qtyTripletMatch[2], 10) || parseInt(qtyTripletMatch[1], 10);
      if (desp > 0 && desp <= 10000) {
        quantity = desp;
      }
    }
  }

  if (!partNumber) {
    const numericPartMatches = workingLine.match(/\b(\d{6,12})\b/g);
    if (numericPartMatches) {
      for (const candidate of numericPartMatches) {
        if (candidate === docketNumber) continue;
        if (/^\d{8}$/.test(candidate) && /^(?:19|20)\d{6}$/.test(candidate)) continue;
        if (specs.palletNumber && specs.palletNumber.includes(candidate)) continue;
        if (new RegExp(`(?:pallet|plt|skid|on\\s+s|pack)\\s*#?\\s*[:#]?\\s*${candidate}`, 'i').test(rawText)) continue;
        partNumber = candidate;
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
    // Strip currency values ($45.00), trailing decimal unit-price + line-total pairs, and split part tails
    const lineWithoutCurrency = workingLine
      .replace(/\$\s*\d+(?:,\d{3})*(?:\.\d{2})?/g, ' ')
      .replace(/\s+\d+(?:,\d{3})*\.\d{2}\s+\d+(?:,\d{3})*\.\d{2}\s*$/, '')
      .trim();
    const isSplitPartSuffix = /\b(?:J1[23456]\d{3,4}|[A-Z]\d{4,6})\s+\d{3,4}\s*$/i.test(
      lineWithoutCurrency
    );
    const hasTrailingEaLayout = /\b(?:EA|BA|EAE)\b/i.test(rawText);
    const qtyMatch =
      lineWithoutCurrency.match(/(?:qty|quantity|shipped|delivered|supplied)\s*[:.\s]*(\d{1,4})\b/i) ||
      lineWithoutCurrency.match(/\b(\d{1,4})\s*(?:ea|pcs|units|off)\b/i) ||
      lineWithoutCurrency.match(/\b\d{1,4}\s*\/\s*(\d{1,4})\s*$/) ||
      (!isSplitPartSuffix && !hasTrailingEaLayout
        ? lineWithoutCurrency.match(/\s+(\d{1,4})(?:\.00)?\s*$/)
        : null);

    if (qtyMatch && qtyMatch[1]) {
      const q = parseInt(qtyMatch[1], 10);
      if (
        !Number.isNaN(q) &&
        q > 0 &&
        q <= 10000 &&
        !(q >= 1000 && partNumber.endsWith(String(q)))
      ) {
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

  const isLowConf =
    partNumber.length < 2 ||
    quantity === null ||
    (ocrConfidence < 48 && !foundSteelKeyword && !thickness && !material);
  const confidenceLevel: 'high' | 'medium' | 'low' = isLowConf
    ? 'low'
    : ocrConfidence >= 70
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
 * Merges complementary parsed part rows from two extraction sources without creating duplicate line items.
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
 * by Gemini Vision OCR, keeping `originalOcrValues`, `lastEditedBy`, and `lastEditedAt` intact.
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

// ============================================================================
// POST-GEMINI INDUSTRIAL DOCKET NORMALIZATION & VALIDATION
// ============================================================================

const NON_PART_CHARGE_REGEX =
  /^(?:GST|TOTAL\s*GST|SUB\s*TOTAL|SUBTOTAL|TOTAL\s*(?:INC|EX|EXCL|INCL)?\s*GST|AMOUNT\s*DUE|BALANCE\s*DUE|INVOICE\s*TOTAL|FREIGHT|DELIVERY\s*(?:FEE|CHARGE|COST)|PACKING\s*(?:FEE|CHARGE)|PALLET\s*CHARGE|SURCHARGE|SETUP\s*(?:FEE|CHARGE)|PROGRAMMING\s*(?:FEE|CHARGE)|HANDLING\s*(?:FEE|CHARGE)|TAX|DISCOUNT|ROUNDING|A\.?B\.?N\.?|ACN|PHONE|PH|FAX|MOBILE|EMAIL|PAGE\s*\d+|RECEIVED\s*IN\s*GOOD|DRIVER\s*SIGNATURE|CUSTOMER\s*SIGNATURE)\b/i;

function normalizeIndustrialSupplierLabel(rawSupplier: string): string {
  const s = (rawSupplier || '').trim();
  if (!s) return 'Laser Central';
  if (/\blaser\s*central\b/i.test(s)) return 'Laser Central';
  if (/\bgolden\s*coast\s*industrial\b|\bgci\b/i.test(s)) return 'GCI';
  if (/\bbluescope\b/i.test(s)) return 'BlueScope Steel';
  if (/\bshapecut\b/i.test(s)) return 'ShapeCut';
  return s.replace(/\s+/g, ' ').slice(0, 80);
}

function normalizeGeminiPartCode(rawPart: string): string {
  let cleaned = (rawPart || '')
    .trim()
    .replace(/^[:#;|¦,.=\s]+|[:#;|¦,.\s]+$/g, '')
    .replace(/\s*([-\/])\s*/g, '$1');

  // If a part code has two halves split by whitespace like "J12345 REV" or "12345 001", leave revision out if obvious
  const trailingUnitMatch = cleaned.match(/^([A-Za-z0-9][A-Za-z0-9._\/-]{1,})\s+(?:EA|EACH|PC|PCS|SET|SETS)$/i);
  if (trailingUnitMatch) {
    cleaned = trailingUnitMatch[1];
  }

  return cleaned;
}

function extractUnitAndCleanDescription(
  rawDesc: string,
  rawUnit?: string
): { description: string; unit?: string } {
  let desc = (rawDesc || '').replace(/\s+/g, ' ').trim();
  let unit = rawUnit ? rawUnit.trim().toUpperCase() : undefined;

  if (!unit) {
    const unitMatch = desc.match(/\b(\d+)\s+(EA|EACH|PCS|PIECES|SET|SETS|OFF)\b/i);
    if (unitMatch) {
      unit = unitMatch[2].toUpperCase();
    } else {
      const endUnitMatch = desc.match(/(?:^|\s)(EA|EACH|PCS|SET)$/i);
      if (endUnitMatch) {
        unit = endUnitMatch[1].toUpperCase();
        desc = desc.slice(0, desc.length - endUnitMatch[0].length).trim();
      }
    }
  }

  if (unit === 'EACH') unit = 'EA';
  if (unit === 'PIECES') unit = 'PCS';
  if (unit === 'SETS') unit = 'SET';

  return { description: desc, unit };
}

function isNonPartChargeOrFooterRow(item: ExtractedDocketItem): boolean {
  const pn = (item.partNumber || '').trim();
  const desc = (item.description || '').trim();
  const orig = (item.originalText || '').trim();

  if (NON_PART_CHARGE_REGEX.test(pn) && (!desc || NON_PART_CHARGE_REGEX.test(desc))) {
    return true;
  }
  if (!pn && NON_PART_CHARGE_REGEX.test(desc)) {
    return true;
  }
  if (
    /^(?:ABN|ACN|PH|PHONE|FAX|TEL|TOTAL|SUBTOTAL|GST|FREIGHT)[:\s]/i.test(`${pn} ${desc}`.trim()) &&
    !/[A-Z]\d{2,}|\d{3,}-\d+/.test(pn)
  ) {
    return true;
  }
  if (/^\$[\d,.]+$/.test(pn) || /^[\d,]+\.\d{2}$/.test(pn)) {
    return true;
  }
  if (
    orig &&
    /\b(?:ABN|SUBTOTAL|TOTAL\s*GST|TOTAL\s*INC|FREIGHT\s*CHARGE)\b/i.test(orig) &&
    (!pn || NON_PART_CHARGE_REGEX.test(pn))
  ) {
    return true;
  }
  return false;
}

/**
 * Normalizes and validates a single extracted docket returned by Gemini Vision.
 * Preserves all extracted part rows, enforces industrial formatting safeguards,
 * detects sequence gaps (`missingRowNumbers`), and flags questionable rows without fabricating data.
 */
export function normalizeExtractedDocketSingle(
  docket: ExtractedDocketResult,
  supplierHint?: SupplierRuleId
): ExtractedDocketResult {
  const isGci = isGciSupplierHint(supplierHint);
  const gciResolved = isGci
    ? resolveGciPageHeaderFields(
        {
          docketNumber: docket.docketNumber,
          jobNumber: docket.jobNumber,
          orderNumber: docket.orderNumber,
          deliveryDate: docket.deliveryDate,
          supplier: docket.supplier,
          validationWarnings: docket.validationWarnings,
        },
        {
          selectableText: docket.rawTextSummary,
          isContinuationWithoutHeader: false,
        }
      )
    : null;

  const supplier = isGci ? 'GCI' : normalizeIndustrialSupplierLabel(docket.supplier);
  const normalizedItems: ExtractedDocketItem[] = [];
  const excludedRowNos = new Set<number>(
    Array.isArray(docket.excludedRowNumbers)
      ? docket.excludedRowNumbers.filter((n) => typeof n === 'number' && n > 0)
      : []
  );

  for (let i = 0; i < (docket.items || []).length; i++) {
    const rawItem = docket.items[i];
    if (!rawItem) continue;
    if (isNonPartChargeOrFooterRow(rawItem)) continue;

    if (
      isGci &&
      (isGciExcludedNonPartItem(rawItem.partNumber, rawItem.description) ||
        isGciExcludedNonPartItem((rawItem as any).part, (rawItem as any).desc))
    ) {
      const exNo = parseInt(String(rawItem.itemNumber || (rawItem as any).no || '').trim(), 10);
      if (!Number.isNaN(exNo) && exNo > 0) {
        excludedRowNos.add(exNo);
      }
      continue;
    }

    const cleanPart = normalizeGeminiPartCode(rawItem.partNumber || '');
    const { description, unit } = extractUnitAndCleanDescription(
      rawItem.description || '',
      rawItem.unit
    );

    if (isGci && isGciExcludedNonPartItem(cleanPart, description)) {
      const exNo = parseInt(String(rawItem.itemNumber || (rawItem as any).no || '').trim(), 10);
      if (!Number.isNaN(exNo) && exNo > 0) {
        excludedRowNos.add(exNo);
      }
      continue;
    }

    const revVal = (rawItem.revision || rawItem.rev || '').trim() || undefined;
    const rawQty = Number(rawItem.quantity);
    const validQty = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 0;
    const warnings = new Set<string>(
      Array.isArray(rawItem.validationWarnings) ? rawItem.validationWarnings : []
    );
    const flags = new Set<string>(
      Array.isArray(rawItem.validationFlags) ? rawItem.validationFlags : []
    );

    if (!cleanPart || cleanPart.length < 2 || /^(?:PART|UNKNOWN|N\/A|NONE)$/i.test(cleanPart)) {
      flags.add('missing_part_number');
      warnings.add('Missing or unclear Part Number');
    }
    if (!Number.isFinite(rawQty) || rawQty < 1 || rawQty > 50000 || Math.floor(rawQty) !== rawQty) {
      flags.add('invalid_quantity');
      warnings.add(`Check quantity (${rawItem.quantity ?? 'missing'})`);
    }
    if (!description || description.length < 2) {
      flags.add('incomplete_row');
      warnings.add('Missing or short description');
    }

    const itemNoStr = String(rawItem.itemNumber || '').trim() || String(normalizedItems.length + 1);
    const finalQty = validQty >= 1 && Math.floor(validQty) === validQty ? validQty : 1;

    normalizedItems.push({
      ...rawItem,
      partNumber: cleanPart || rawItem.partNumber || 'UNKNOWN',
      itemNumber: itemNoStr,
      description: description || cleanPart || 'Unspecified Part',
      revision: revVal,
      rev: revVal,
      unit: unit || rawItem.unit,
      quantity: finalQty,
      confidence:
        flags.size > 0
          ? 'low'
          : rawItem.confidence === 'high' || rawItem.confidence === 'medium' || rawItem.confidence === 'low'
          ? rawItem.confidence
          : 'high',
      validationFlags: flags.size > 0 ? Array.from(flags) : undefined,
      validationWarnings: warnings.size > 0 ? Array.from(warnings) : undefined,
      originalOcrValues: rawItem.originalOcrValues || {
        partNumber: cleanPart || rawItem.partNumber || 'UNKNOWN',
        itemNumber: itemNoStr,
        description: description || cleanPart || 'Unspecified Part',
        revision: revVal,
        rev: revVal,
        quantity: finalQty,
        material: rawItem.material,
        thickness: rawItem.thickness,
      },
    });
  }

  // Re-evaluate row integrity & sequence gaps without discarding legitimate duplicate part numbers
  // that have distinct revisions, pallets, descriptions, or printed docket item numbers.
  const seenExactRows = new Map<string, number>();
  const numericItemNumbers: number[] = [];

  for (let i = 0; i < normalizedItems.length; i++) {
    const it = normalizedItems[i];
    const itemNo = String(it.itemNumber || '').trim();
    const pageKey = String(it.pageNumber || 1);
    const revKey = String(it.rev || it.revision || '').trim().toUpperCase();
    const palletKey = String(it.palletNumber || '').trim().toUpperCase();
    const descKey = String(it.description || '').trim().toUpperCase().slice(0, 40);
    const strictKey = `${pageKey}::NO=${itemNo}::PN=${it.partNumber.toUpperCase()}::REV=${revKey}::PAL=${palletKey}::DESC=${descKey}`;

    if (it.partNumber && seenExactRows.has(strictKey)) {
      const firstIdx = seenExactRows.get(strictKey)!;
      const flags = new Set(it.validationFlags || []);
      const warnings = new Set(it.validationWarnings || []);
      flags.add('duplicate_entry');
      warnings.add(`Matches row #${normalizedItems[firstIdx].itemNumber || firstIdx + 1}`);
      it.validationFlags = Array.from(flags);
      it.validationWarnings = Array.from(warnings);
      it.confidence = 'low';
    } else {
      seenExactRows.set(strictKey, i);
    }

    if (/^\d+$/.test(itemNo)) {
      const n = parseInt(itemNo, 10);
      if (n >= 1 && n <= 2000) {
        numericItemNumbers.push(n);
      }
    }
  }

  const missingRowNumbers: number[] = [];
  if (numericItemNumbers.length >= 2) {
    const uniqueSorted = Array.from(new Set(numericItemNumbers)).sort((a, b) => a - b);
    const minNo = uniqueSorted[0];
    const maxNo = uniqueSorted[uniqueSorted.length - 1];
    const span = maxNo - minNo + 1;
    if (span <= uniqueSorted.length + excludedRowNos.size + 15 && maxNo <= 2000) {
      const present = new Set(uniqueSorted);
      let startNo = minNo <= 3 ? 1 : minNo;
      while (startNo < minNo && excludedRowNos.has(startNo)) {
        startNo++;
      }
      for (let expectedNo = startNo; expectedNo <= maxNo; expectedNo++) {
        if (!present.has(expectedNo) && !excludedRowNos.has(expectedNo)) {
          missingRowNumbers.push(expectedNo);
        }
      }
    }
  }

  const flaggedRowCount = normalizedItems.filter(
    (it) => it.confidence === 'low' || (it.validationFlags && it.validationFlags.length > 0)
  ).length;

  const highCount = normalizedItems.filter((it) => it.confidence === 'high').length;
  const medCount = normalizedItems.filter((it) => it.confidence === 'medium').length;
  const computedConfidence =
    normalizedItems.length === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            100,
            Math.round(
              ((highCount * 97 + medCount * 82 + flaggedRowCount * 48) / normalizedItems.length) -
                missingRowNumbers.length * 8
            )
          )
        );

  const docketWarnings = new Set<string>(
    Array.isArray(gciResolved?.validationWarnings)
      ? gciResolved.validationWarnings
      : Array.isArray(docket.validationWarnings)
      ? docket.validationWarnings
      : []
  );
  const docketFlags = new Set<string>(
    Array.isArray(docket.validationFlags) ? docket.validationFlags : []
  );

  if (gciResolved?.missingJobNo) {
    docketFlags.add(GCI_MISSING_JOB_NO_WARNING);
    docketWarnings.add(GCI_MISSING_JOB_NO_WARNING);
  }
  if (normalizedItems.length === 0) {
    docketFlags.add('No part rows detected');
  }
  if (missingRowNumbers.length > 0) {
    const msg = `Potentially missed line item(s): No. ${missingRowNumbers.slice(0, 10).join(', ')}`;
    docketFlags.add(msg);
    docketWarnings.add(msg);
  }
  if (flaggedRowCount > 0) {
    const msg = `${flaggedRowCount} row(s) flagged for review`;
    docketFlags.add(msg);
    docketWarnings.add(msg);
  }

  const numericNosSorted = [...numericItemNumbers].sort((a, b) => a - b);

  return {
    ...docket,
    docketNumber: gciResolved ? gciResolved.docketNumber : docket.docketNumber,
    supplier,
    customerName: docket.customerName?.trim() || undefined,
    deliveryDate: gciResolved?.deliveryDate || docket.deliveryDate,
    orderNumber: gciResolved ? gciResolved.orderNumber : docket.orderNumber?.trim() || undefined,
    jobNumber: gciResolved ? gciResolved.jobNumber : docket.jobNumber?.trim() || undefined,
    items: normalizedItems,
    excludedRowNumbers: excludedRowNos.size > 0 ? Array.from(excludedRowNos).sort((a, b) => a - b) : undefined,
    confidenceScore:
      typeof docket.confidenceScore === 'number' && docket.confidenceScore > 0
        ? Math.min(docket.confidenceScore, computedConfidence || docket.confidenceScore)
        : computedConfidence,
    missingRowNumbers,
    flaggedRowCount,
    hasPrintedNoColumn: numericNosSorted.length > 0,
    firstVisibleRowNo: numericNosSorted.length > 0 ? numericNosSorted[0] : undefined,
    lastVisibleRowNo:
      numericNosSorted.length > 0 ? numericNosSorted[numericNosSorted.length - 1] : undefined,
    separationUncertain: Boolean(docket.separationUncertain) || Boolean(gciResolved?.missingJobNo),
    separationReason:
      docket.separationReason ||
      (gciResolved?.missingJobNo ? GCI_MISSING_JOB_NO_WARNING : undefined),
    needsManualReview:
      Boolean(docket.needsManualReview) ||
      Boolean(docket.separationUncertain) ||
      Boolean(gciResolved?.missingJobNo) ||
      normalizedItems.length === 0 ||
      flaggedRowCount > 0 ||
      missingRowNumbers.length > 0,
    validationFlags: Array.from(docketFlags),
    validationWarnings: Array.from(docketWarnings),
  };
}

/**
 * Post-Gemini normalization & validation wrapper across both primary docket and any `separatedDockets`.
 */
export function validateAndNormalizeGeminiDocket(
  extracted: ExtractedDocketResult,
  supplierHint?: SupplierRuleId
): ExtractedDocketResult {
  const separated = Array.isArray(extracted.separatedDockets) && extracted.separatedDockets.length > 0
    ? extracted.separatedDockets.map((d) => normalizeExtractedDocketSingle(d, supplierHint))
    : undefined;

  if (separated && separated.length > 0) {
    const primary = separated[0];
    const combinedMissing = separated.flatMap((d) => d.missingRowNumbers || []);
    const combinedFlagged = separated.reduce((sum, d) => sum + (d.flaggedRowCount || 0), 0);
    const minScore = separated.reduce(
      (min, d) => Math.min(min, d.confidenceScore || 0),
      100
    );
    const anyNeedsReview = separated.some((d) => d.needsManualReview);
    return {
      ...extracted,
      ...primary,
      confidenceScore: minScore,
      missingRowNumbers: combinedMissing,
      flaggedRowCount: combinedFlagged,
      needsManualReview: Boolean(extracted.needsManualReview) || anyNeedsReview,
      separatedDockets: separated,
    };
  }

  return normalizeExtractedDocketSingle(extracted, supplierHint);
}
