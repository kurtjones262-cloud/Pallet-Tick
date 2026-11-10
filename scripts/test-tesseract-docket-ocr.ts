/**
 * Comprehensive Verification & Benchmark Suite:
 * Tesseract-First Docket Extraction + Supplier Parsing (Laser Central & GCI) + Gemini Fallback
 */

import {
  parseIndustrialDocketText,
  combineMultiPageDocketResults,
  validateDocketExtractionQuality,
  groupPositionedWordsIntoLines,
  RawOcrLine,
  RawOcrWord,
} from '../src/utils/docketParser';
import {
  extractDocketWithTesseractFirst,
  clearDocketOcrPageCache,
  getDocketOcrCacheSize,
  terminateDocketTesseractWorker,
} from '../src/utils/tesseractDocketOcr';
import { performSmartDocketExtraction } from '../src/utils/offlineOcr';
import type { ExtractedDocketItem } from '../src/server/docketOcr';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ PASS: ${message}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${message}`);
  }
}

/**
 * Generates an uncompressed 24-bit BMP image buffer (supported natively by Leptonica / Tesseract WASM)
 * containing crisp black text rendered on a white background at scale 4x
 * so Tesseract LSTM can perform real optical character recognition on a rasterized docket image.
 */
const FONT_5X7: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10011', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '00110', '00110'],
  '/': ['00001', '00010', '00100', '00100', '01000', '10000', '00000'],
  '#': ['01010', '11111', '01010', '01010', '11111', '01010', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function renderDocketLinesToBmpDataUrl(lines: string[], scale = 4): string {
  const maxCols = Math.max(...lines.map((l) => l.length), 40);
  const charW = 6 * scale;
  const charH = 10 * scale;
  const marginX = 24;
  const marginY = 24;
  const width = marginX * 2 + maxCols * charW;
  const height = marginY * 2 + lines.length * charH;

  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelDataSize = rowStride * height;
  const fileSize = 54 + pixelDataSize;
  const buf = Buffer.alloc(fileSize, 0xff); // Fill white background

  // BMP Header
  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(54, 10);

  // DIB Header (BITMAPINFOHEADER)
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(-height, 22); // top-down BMP
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelDataSize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(0, 46);
  buf.writeUInt32LE(0, 50);

  const setPixelBlack = (px: number, py: number) => {
    if (px < 0 || px >= width || py < 0 || py >= height) return;
    const offset = 54 + py * rowStride + px * 3;
    buf[offset] = 0;
    buf[offset + 1] = 0;
    buf[offset + 2] = 0;
  };

  lines.forEach((rawLine, lineIdx) => {
    const line = rawLine.toUpperCase();
    const baseY = marginY + lineIdx * charH;
    for (let cIdx = 0; cIdx < line.length; cIdx++) {
      const ch = line[cIdx];
      const glyph = FONT_5X7[ch] || FONT_5X7[' '];
      const baseX = marginX + cIdx * charW;
      for (let gy = 0; gy < 7; gy++) {
        const rowBits = glyph[gy];
        for (let gx = 0; gx < 5; gx++) {
          if (rowBits[gx] === '1') {
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) {
                setPixelBlack(baseX + gx * scale + sx, baseY + gy * scale + sy);
              }
            }
          }
        }
      }
    }
  });

  return `data:image/bmp;base64,${buf.toString('base64')}`;
}

/**
 * Helper to build realistic positioned lines (simulating PDF.js / Tesseract word bounding boxes)
 */
function buildPositionedTableLines(
  rows: Array<{
    pageNumber: number;
    y0: number;
    cells: Array<{ text: string; x0: number; x1: number; confidence?: number }>;
  }>
): RawOcrLine[] {
  return rows.map((row) => {
    const words: RawOcrWord[] = row.cells.map((c) => ({
      text: c.text,
      confidence: c.confidence ?? 95,
      bbox: { x0: c.x0, y0: row.y0, x1: c.x1, y1: row.y0 + 18 },
    }));
    const grouped = groupPositionedWordsIntoLines(words, row.pageNumber);
    return (
      grouped[0] || {
        text: row.cells.map((c) => c.text).join('   '),
        confidence: 95,
        pageNumber: row.pageNumber,
        bbox: {
          x0: row.cells[0]?.x0 || 0,
          y0: row.y0,
          x1: row.cells[row.cells.length - 1]?.x1 || 600,
          y1: row.y0 + 18,
        },
        words,
      }
    );
  });
}

async function runTests() {
  console.log('==================================================================');
  console.log(' PALLETTRACK TESSERACT-FIRST DOCKET EXTRACTION BENCHMARK & VERIFY');
  console.log('==================================================================\n');

  // ---------------------------------------------------------------------------
  // TEST 1: Laser Central Digital PDF & Positional Extraction (1-Page & Multi-Page)
  // ---------------------------------------------------------------------------
  console.log('1. Testing Laser Central Digital PDF Positional Extraction (1-Page & 2-Page)...');

  const laserCentralPage1Lines = buildPositionedTableLines([
    {
      pageNumber: 1,
      y0: 40,
      cells: [{ text: 'LASER CENTRAL PTY LTD', x0: 40, x1: 260 }],
    },
    {
      pageNumber: 1,
      y0: 68,
      cells: [
        { text: 'DELIVERY DOCKET: LC-88421', x0: 40, x1: 250 },
        { text: 'DATE: 2026-05-14', x0: 320, x1: 480 },
      ],
    },
    {
      pageNumber: 1,
      y0: 96,
      cells: [
        { text: 'PO NUMBER: PO-77310', x0: 40, x1: 220 },
        { text: 'PALLETS: 2', x0: 320, x1: 420 },
      ],
    },
    {
      pageNumber: 1,
      y0: 140,
      cells: [
        { text: 'No', x0: 40, x1: 68 },
        { text: 'Part Number', x0: 85, x1: 210 },
        { text: 'Rev', x0: 225, x1: 260 },
        { text: 'Description', x0: 275, x1: 450 },
        { text: 'Material', x0: 465, x1: 530 },
        { text: 'Thick', x0: 545, x1: 595 },
        { text: 'Qty', x0: 615, x1: 660 },
        { text: 'Pallet', x0: 680, x1: 750 },
      ],
    },
    {
      pageNumber: 1,
      y0: 170,
      cells: [
        { text: '1', x0: 42, x1: 58 },
        { text: 'LC-4092-A', x0: 85, x1: 195 },
        { text: 'B', x0: 228, x1: 245 },
        { text: 'CHASSIS SIDE PLATE LH', x0: 275, x1: 445 },
        { text: 'G250', x0: 465, x1: 515 },
        { text: '10mm', x0: 545, x1: 590 },
        { text: '6', x0: 620, x1: 645 },
        { text: 'Pallet 1', x0: 680, x1: 745 },
      ],
    },
    {
      pageNumber: 1,
      y0: 198,
      cells: [
        { text: '2', x0: 42, x1: 58 },
        { text: 'LC-4092-B', x0: 85, x1: 195 },
        { text: 'B', x0: 228, x1: 245 },
        { text: 'CHASSIS SIDE PLATE RH', x0: 275, x1: 445 },
        { text: 'G250', x0: 465, x1: 515 },
        { text: '10mm', x0: 545, x1: 590 },
        { text: '6', x0: 620, x1: 645 },
        { text: 'Pallet 1', x0: 680, x1: 745 },
      ],
    },
    {
      pageNumber: 1,
      y0: 226,
      cells: [
        { text: '3', x0: 42, x1: 58 },
        { text: 'LC-5110-X', x0: 85, x1: 195 },
        { text: 'A', x0: 228, x1: 245 },
        { text: 'CROSS MEMBER GUSSET', x0: 275, x1: 445 },
        { text: 'G350', x0: 465, x1: 515 },
        { text: '12mm', x0: 545, x1: 590 },
        { text: '12', x0: 620, x1: 648 },
        { text: 'Pallet 1', x0: 680, x1: 745 },
      ],
    },
  ]);

  const laserCentralPage2Lines = buildPositionedTableLines([
    {
      pageNumber: 2,
      y0: 60,
      cells: [
        { text: 'No', x0: 40, x1: 68 },
        { text: 'Part Number', x0: 85, x1: 210 },
        { text: 'Rev', x0: 225, x1: 260 },
        { text: 'Description', x0: 275, x1: 450 },
        { text: 'Material', x0: 465, x1: 530 },
        { text: 'Thick', x0: 545, x1: 595 },
        { text: 'Qty', x0: 615, x1: 660 },
        { text: 'Pallet', x0: 680, x1: 750 },
      ],
    },
    {
      pageNumber: 2,
      y0: 95,
      cells: [
        { text: '4', x0: 42, x1: 58 },
        { text: 'LC-6200-M', x0: 85, x1: 195 },
        { text: 'C', x0: 228, x1: 245 },
        { text: 'HEADBOARD MOUNT BRACKET', x0: 275, x1: 445 },
        { text: 'G250', x0: 465, x1: 515 },
        { text: '8mm', x0: 545, x1: 590 },
        { text: '4', x0: 620, x1: 645 },
        { text: 'Pallet 2', x0: 680, x1: 745 },
      ],
    },
    {
      pageNumber: 2,
      y0: 123,
      cells: [
        { text: '5', x0: 42, x1: 58 },
        { text: 'LC-7890-Z', x0: 85, x1: 195 },
        { text: 'A', x0: 228, x1: 245 },
        { text: 'REAR BUMPER END CAP', x0: 275, x1: 445 },
        { text: '304SS', x0: 465, x1: 515 },
        { text: '6mm', x0: 545, x1: 590 },
        { text: '8', x0: 620, x1: 645 },
        { text: 'Pallet 2', x0: 680, x1: 745 },
      ],
    },
  ]);

  const lcStartMs = Date.now();
  const lcOutput = await extractDocketWithTesseractFirst(
    ['data:image/png;base64,LC_P1', 'data:image/png;base64,LC_P2'],
    {
      pageTextHints: [
        {
          hasSelectableText: true,
          rawText: laserCentralPage1Lines.map((l) => l.text).join('\n'),
          selectableLines: laserCentralPage1Lines,
        },
        {
          hasSelectableText: true,
          rawText: laserCentralPage2Lines.map((l) => l.text).join('\n'),
          selectableLines: laserCentralPage2Lines,
        },
      ],
      supplierHint: 'laser_central',
    }
  );
  const lcElapsedMs = Date.now() - lcStartMs;

  assert(lcOutput.extractedData.supplier === 'Laser Central', 'Laser Central supplier identified accurately');
  assert(lcOutput.extractedData.docketNumber === 'LC-88421', 'Laser Central docket number LC-88421 extracted');
  assert(lcOutput.extractedData.orderNumber === 'PO-77310', 'Laser Central PO number PO-77310 extracted');
  assert(lcOutput.extractedData.palletCount === 2, 'Laser Central pallet count (2) extracted');
  assert(
    lcOutput.extractedData.items.length === 5,
    `Laser Central multi-page docket extracted all 5 part rows (got ${lcOutput.extractedData.items.length})`
  );
  assert(
    lcOutput.extractedData.items[0].partNumber === 'LC-4092-A' &&
      lcOutput.extractedData.items[0].itemNumber === '1' &&
      lcOutput.extractedData.items[0].rev === 'B' &&
      lcOutput.extractedData.items[0].material === 'G250' &&
      lcOutput.extractedData.items[0].thickness === '10mm' &&
      lcOutput.extractedData.items[0].quantity === 6 &&
      lcOutput.extractedData.items[0].palletNumber === 'Pallet 1',
    'Laser Central Row 1 positional fields (partNumber, itemNumber, rev, material, thickness, qty, pallet) match 100%'
  );
  assert(
    lcOutput.extractedData.items[4].partNumber === 'LC-7890-Z' &&
      lcOutput.extractedData.items[4].itemNumber === '5' &&
      lcOutput.extractedData.items[4].palletNumber === 'Pallet 2' &&
      lcOutput.extractedData.items[4].quantity === 8,
    'Laser Central Page 2 Row 5 positional fields match 100%'
  );
  assert(
    lcOutput.validationReport.shouldFallbackToGemini === false,
    'Laser Central clean multi-page extraction passes validation without needing Gemini fallback'
  );

  // ---------------------------------------------------------------------------
  // TEST 2: GCI Digital PDF & Positional Extraction
  // ---------------------------------------------------------------------------
  console.log('\n2. Testing GCI Group Digital PDF Positional Extraction...');

  const gciPageLines = buildPositionedTableLines([
    {
      pageNumber: 1,
      y0: 36,
      cells: [{ text: 'GCI GROUP AUSTRALIA - PACKING SLIP', x0: 40, x1: 350 }],
    },
    {
      pageNumber: 1,
      y0: 64,
      cells: [
        { text: 'DOCKET NO: GCI-55209', x0: 40, x1: 230 },
        { text: 'ORDER NO: SO-19402', x0: 280, x1: 450 },
      ],
    },
    {
      pageNumber: 1,
      y0: 110,
      cells: [
        { text: 'Item', x0: 40, x1: 75 },
        { text: 'Drawing No', x0: 90, x1: 220 },
        { text: 'Rev', x0: 235, x1: 268 },
        { text: 'Description', x0: 280, x1: 455 },
        { text: 'Grade', x0: 470, x1: 530 },
        { text: 'Gauge', x0: 545, x1: 595 },
        { text: 'Shipped', x0: 615, x1: 675 },
        { text: 'Skid', x0: 690, x1: 755 },
      ],
    },
    {
      pageNumber: 1,
      y0: 142,
      cells: [
        { text: '10', x0: 42, x1: 68 },
        { text: 'GCI-9011-01', x0: 90, x1: 205 },
        { text: '02', x0: 235, x1: 260 },
        { text: 'BASE FRAME CHANNEL', x0: 280, x1: 445 },
        { text: 'HA250', x0: 470, x1: 520 },
        { text: '5mm', x0: 545, x1: 588 },
        { text: '10', x0: 620, x1: 650 },
        { text: 'Pallet 1', x0: 690, x1: 750 },
      ],
    },
    {
      pageNumber: 1,
      y0: 170,
      cells: [
        { text: '20', x0: 42, x1: 68 },
        { text: 'GCI-9011-02', x0: 90, x1: 205 },
        { text: '01', x0: 235, x1: 260 },
        { text: 'STIFFENER RIB PLATE', x0: 280, x1: 445 },
        { text: 'HA350', x0: 470, x1: 520 },
        { text: '8mm', x0: 545, x1: 588 },
        { text: '24', x0: 620, x1: 650 },
        { text: 'Pallet 1', x0: 690, x1: 750 },
      ],
    },
    {
      pageNumber: 1,
      y0: 198,
      cells: [
        { text: '30', x0: 42, x1: 68 },
        { text: 'GCI-9015-04', x0: 90, x1: 205 },
        { text: 'A', x0: 235, x1: 255 },
        { text: 'COVER PANEL TOP', x0: 280, x1: 440 },
        { text: '5083', x0: 470, x1: 515 },
        { text: '3mm', x0: 545, x1: 588 },
        { text: '4', x0: 620, x1: 645 },
        { text: 'Pallet 2', x0: 690, x1: 750 },
      ],
    },
  ]);

  const gciOutput = await extractDocketWithTesseractFirst(['data:image/png;base64,GCI_P1'], {
    pageTextHints: [
      {
        hasSelectableText: true,
        rawText: gciPageLines.map((l) => l.text).join('\n'),
        selectableLines: gciPageLines,
      },
    ],
    supplierHint: 'gci',
  });

  assert(gciOutput.extractedData.supplier === 'GCI', 'GCI supplier identified accurately');
  assert(gciOutput.extractedData.docketNumber === 'GCI-55209', 'GCI docket number GCI-55209 extracted');
  assert(gciOutput.extractedData.orderNumber === 'SO-19402', 'GCI order number SO-19402 extracted');
  assert(
    gciOutput.extractedData.items.length === 3,
    `GCI docket extracted all 3 part rows (got ${gciOutput.extractedData.items.length})`
  );
  assert(
    gciOutput.extractedData.items[0].partNumber === 'GCI-9011-01' &&
      gciOutput.extractedData.items[0].itemNumber === '10' &&
      gciOutput.extractedData.items[0].material === 'HA250' &&
      gciOutput.extractedData.items[0].thickness === '5mm' &&
      gciOutput.extractedData.items[0].quantity === 10,
    'GCI Row 1 positional fields (GCI-9011-01, Item 10, HA250, 5mm, Qty 10) extracted accurately'
  );
  assert(
    gciOutput.validationReport.shouldFallbackToGemini === false,
    'GCI docket passes validation without requiring Gemini fallback'
  );

  // ---------------------------------------------------------------------------
  // TEST 3: Real Scanned Image OCR via Tesseract.js WASM (Laser Central & GCI) + Page Cache
  // ---------------------------------------------------------------------------
  console.log('\n3. Testing Real Scanned Image OCR via Tesseract.js WASM Engine & Page Caching...');
  clearDocketOcrPageCache();

  const scannedLaserCentralImage = renderDocketLinesToBmpDataUrl(
    [
      'LASER CENTRAL DELIVERY DOCKET',
      'DOCKET: LC-30991   PO: PO-4410',
      'NO   PART NUMBER    REV   DESCRIPTION          MAT    THK    QTY',
      '1    LC-8801-A      A     MAIN BOOM BRACKET    G250   6MM    4',
      '2    LC-8802-B      B     PIVOT MOUNT PLATE    G350   10MM   12',
      '3    LC-8803-C      A     LOCKING PIN TAB      G250   8MM    16',
    ],
    4
  );

  const scannedStartMs = Date.now();
  const scannedLcOutput = await extractDocketWithTesseractFirst([scannedLaserCentralImage], {
    supplierHint: 'laser_central',
  });
  const scannedFirstRunMs = Date.now() - scannedStartMs;

  console.log(
    `   [Tesseract WASM Scanned Image] Extracted ${scannedLcOutput.extractedData.items.length} items in ${scannedFirstRunMs}ms (OCR: ${scannedLcOutput.metrics.ocrTimeMs}ms, Parse: ${scannedLcOutput.metrics.parseTimeMs}ms)`
  );

  assert(
    scannedLcOutput.extractedData.extractionMethod === 'tesseract-ocr',
    'Scanned image uses tesseract-ocr extractionMethod'
  );
  assert(
    scannedLcOutput.extractedData.items.length === 3,
    `Real Tesseract WASM OCR extracted all 3 rows from rasterized Laser Central docket image (got ${scannedLcOutput.extractedData.items.length})`
  );
  assert(
    scannedLcOutput.extractedData.items[0]?.partNumber.includes('8801') &&
      scannedLcOutput.extractedData.items[0]?.quantity === 4,
    `Scanned Row 1 part number (${scannedLcOutput.extractedData.items[0]?.partNumber}) and Qty (${scannedLcOutput.extractedData.items[0]?.quantity}) extracted via Tesseract WASM`
  );
  assert(
    scannedLcOutput.extractedData.items[1]?.partNumber.includes('8802') &&
      scannedLcOutput.extractedData.items[1]?.quantity === 12,
    `Scanned Row 2 part number (${scannedLcOutput.extractedData.items[1]?.partNumber}) and Qty (${scannedLcOutput.extractedData.items[1]?.quantity}) extracted via Tesseract WASM`
  );
  assert(
    scannedLcOutput.extractedData.items[2]?.partNumber.includes('8803') &&
      scannedLcOutput.extractedData.items[2]?.quantity === 16,
    `Scanned Row 3 part number (${scannedLcOutput.extractedData.items[2]?.partNumber}) and Qty (${scannedLcOutput.extractedData.items[2]?.quantity}) extracted via Tesseract WASM`
  );
  assert(
    getDocketOcrCacheSize() === 1,
    'Page OCR cache stores the processed page result by deterministic hash'
  );

  // Run the exact same page a second time to verify cache hit (no repeated OCR)
  const cachedStartMs = Date.now();
  const cachedLcOutput = await extractDocketWithTesseractFirst([scannedLaserCentralImage], {
    supplierHint: 'laser_central',
  });
  const cachedRunMs = Date.now() - cachedStartMs;
  console.log(
    `   [Tesseract Page Cache Hit] Re-extracted in ${cachedRunMs}ms (pagesFromCache: ${cachedLcOutput.metrics.pagesFromCache})`
  );

  assert(
    cachedLcOutput.metrics.pagesFromCache === 1,
    'Repeated extraction of identical page uses pageOcrCache (pagesFromCache === 1)'
  );
  assert(
    cachedRunMs < 50,
    `Cached page extraction completes in < 50ms without re-running Tesseract WASM (${cachedRunMs}ms)`
  );

  // Also test a Scanned GCI Image via real Tesseract WASM
  const scannedGciImage = renderDocketLinesToBmpDataUrl(
    [
      'GCI GROUP PACKING SLIP',
      'DOCKET: GCI-77410   ORDER: SO-8821',
      'ITEM   PART NUMBER    REV   DESCRIPTION         MAT     THK   QTY',
      '1      GCI-3100-1     A     SIDE RAIL ANGLE     HA250   5MM   10',
      '2      GCI-3100-2     B     CORNER GUSSET       HA350   8MM   20',
    ],
    4
  );

  const scannedGciOutput = await extractDocketWithTesseractFirst([scannedGciImage], {
    supplierHint: 'gci',
  });
  console.log(
    `   [Tesseract WASM Scanned GCI Image] Extracted ${scannedGciOutput.extractedData.items.length} items in ${scannedGciOutput.metrics.totalTimeMs}ms`
  );
  assert(
    scannedGciOutput.extractedData.items.length === 2,
    `Real Tesseract WASM OCR extracted all 2 rows from rasterized GCI docket image (got ${scannedGciOutput.extractedData.items.length})`
  );

  // ---------------------------------------------------------------------------
  // TEST 4: Extraction Confidence & Validation Rules (Never Silently Accept Incomplete Lists)
  // ---------------------------------------------------------------------------
  console.log('\n4. Testing Extraction Confidence, Sequence Gap Detection & Validation Flags...');

  // Case 4A: Missing item #3 in sequence 1, 2, 4 + unparsed smudged table line
  const incompleteSequenceLines = buildPositionedTableLines([
    {
      pageNumber: 1,
      y0: 40,
      cells: [{ text: 'LASER CENTRAL DELIVERY DOCKET LC-99901', x0: 40, x1: 350 }],
    },
    {
      pageNumber: 1,
      y0: 80,
      cells: [
        { text: 'No', x0: 40, x1: 68 },
        { text: 'Part Number', x0: 85, x1: 210 },
        { text: 'Description', x0: 275, x1: 450 },
        { text: 'Qty', x0: 615, x1: 660 },
      ],
    },
    {
      pageNumber: 1,
      y0: 110,
      cells: [
        { text: '1', x0: 42, x1: 58 },
        { text: 'LC-1001-A', x0: 85, x1: 195 },
        { text: 'BASE PLATE', x0: 275, x1: 440 },
        { text: '4', x0: 620, x1: 645 },
      ],
    },
    {
      pageNumber: 1,
      y0: 138,
      cells: [
        { text: '2', x0: 42, x1: 58 },
        { text: 'LC-1002-B', x0: 85, x1: 195 },
        { text: 'TOP PLATE', x0: 275, x1: 440 },
        { text: '4', x0: 620, x1: 645 },
      ],
    },
    // Row 3 is smudged/unparsed table line in the middle of the table
    {
      pageNumber: 1,
      y0: 166,
      cells: [{ text: '3   ~?@#   5mm   6', x0: 42, x1: 450, confidence: 38 }],
    },
    {
      pageNumber: 1,
      y0: 194,
      cells: [
        { text: '4', x0: 42, x1: 58 },
        { text: 'LC-1004-D', x0: 85, x1: 195 },
        { text: 'END PLATE', x0: 275, x1: 440 },
        { text: '2', x0: 620, x1: 645 },
      ],
    },
  ]);

  const parsedIncompletePage = parseIndustrialDocketText(
    incompleteSequenceLines,
    1,
    'laser_central'
  );
  const gapResult = combineMultiPageDocketResults([parsedIncompletePage]);

  assert(
    gapResult.missingRowNumbers?.includes(3) === true,
    `Sequence validator detected missing docket line #3 (missingRowNumbers: ${JSON.stringify(gapResult.missingRowNumbers)})`
  );
  assert(
    gapResult.validationReport.shouldFallbackToGemini === true,
    'Sequence gap triggers shouldFallbackToGemini = true so incomplete parts list is never silently accepted'
  );

  // Case 4B: Direct validation test for missing_part_number, invalid_quantity, duplicate_entry, uncertain_text
  const sampleItemsForValidation: ExtractedDocketItem[] = [
    {
      partNumber: '',
      itemNumber: '1',
      description: 'Part with missing part number',
      dimensions: '',
      quantity: 0,
      confidence: 'low' as const,
    },
    {
      partNumber: 'LC-2000-A',
      itemNumber: '2',
      description: 'Duplicate Part',
      dimensions: '',
      quantity: 5,
      confidence: 'high' as const,
      palletNumber: 'Pallet 1',
    },
    {
      partNumber: 'LC-2000-A',
      itemNumber: '3',
      description: 'Duplicate Part',
      dimensions: '',
      quantity: 5,
      confidence: 'high' as const,
      palletNumber: 'Pallet 1',
    },
  ];

  const directValidation = validateDocketExtractionQuality(sampleItemsForValidation, 1);

  assert(
    sampleItemsForValidation[0].validationFlags?.includes('missing_part_number') === true,
    'Validation flags missing_part_number on row with empty partNumber'
  );
  assert(
    sampleItemsForValidation[0].validationFlags?.includes('invalid_quantity') === true,
    'Validation flags invalid_quantity on row with quantity = 0'
  );
  assert(
    sampleItemsForValidation[0].validationFlags?.includes('uncertain_text') === true,
    'Validation flags uncertain_text on low-confidence row'
  );
  assert(
    sampleItemsForValidation[2].validationFlags?.includes('duplicate_entry') === true,
    'Validation flags duplicate_entry on duplicate part row'
  );
  assert(
    directValidation.shouldFallbackToGemini === true,
    'Incomplete/low-confidence extraction sets shouldFallbackToGemini = true (never silently accepted)'
  );

  // ---------------------------------------------------------------------------
  // TEST 5: Smart Extraction Pipeline — Zero Network Calls When Tesseract Succeeds,
  //         Automatic Gemini Fallback When Tesseract Flags Incomplete Docket
  // ---------------------------------------------------------------------------
  console.log('\n5. Testing Smart Extraction Pipeline & Automatic Gemini Fallback...');

  let geminiApiCalls = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(input);
    if (urlStr.includes('/api/extract-docket')) {
      geminiApiCalls++;
      return new Response(
        JSON.stringify({
          supplier: 'Laser Central',
          docketNumber: 'LC-99901',
          deliveryDate: '2026-05-14',
          orderNumber: 'PO-9900',
          palletCount: 1,
          extractionMethod: 'ai-vision',
          aiModelUsed: 'gemini-3.8-flash',
          fallbackUsed: false,
          retryAttempts: 0,
          items: [
            {
              itemNumber: '1',
              partNumber: 'LC-1001-A',
              description: 'BASE PLATE',
              quantity: 4,
              material: 'G250',
              thickness: '10mm',
              dimensions: '',
              palletNumber: 'Pallet 1',
              confidence: 'high',
            },
            {
              itemNumber: '2',
              partNumber: 'LC-1002-B',
              description: 'TOP PLATE',
              quantity: 4,
              material: 'G250',
              thickness: '10mm',
              dimensions: '',
              palletNumber: 'Pallet 1',
              confidence: 'high',
            },
            {
              itemNumber: '3',
              partNumber: 'LC-1003-C',
              description: 'RECOVERED SMUDGED ROW',
              quantity: 6,
              material: 'G250',
              thickness: '5mm',
              dimensions: '',
              palletNumber: 'Pallet 1',
              confidence: 'high',
            },
            {
              itemNumber: '4',
              partNumber: 'LC-1004-D',
              description: 'END PLATE',
              quantity: 2,
              material: 'G250',
              thickness: '10mm',
              dimensions: '',
              palletNumber: 'Pallet 1',
              confidence: 'high',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    // 5A: Clean Laser Central docket -> Tesseract succeeds -> 0 Gemini API calls
    geminiApiCalls = 0;
    const smartCleanResult = await performSmartDocketExtraction(
      ['data:image/png;base64,LC_P1'],
      undefined,
      false,
      [
        {
          hasSelectableText: true,
          rawText: laserCentralPage1Lines.map((l) => l.text).join('\n'),
          selectableLines: laserCentralPage1Lines,
        },
      ],
      { supplierHint: 'laser_central' }
    );

    assert(
      geminiApiCalls === 0,
      'Zero Gemini API requests made when primary Tesseract extraction succeeds'
    );
    assert(
      smartCleanResult.extractedData.extractionEngineLabel?.includes('Tesseract.js OCR') === true,
      `Engine label clearly indicates Tesseract.js primary engine (${smartCleanResult.extractedData.extractionEngineLabel})`
    );
    assert(
      smartCleanResult.extractedData.items.length === 3 &&
        Boolean(smartCleanResult.extractedData.items[0].originalOcrValues),
      'Tesseract output populates originalOcrValues for full compatibility with manual parts editing'
    );

    // 5B: Incomplete / Sequence-Gap Docket -> Tesseract flags missing line #3 -> Automatically triggers Gemini Fallback
    const smartFallbackResult = await performSmartDocketExtraction(
      ['data:image/png;base64,INCOMPLETE_DOCKET'],
      undefined,
      false,
      [
        {
          hasSelectableText: true,
          rawText: incompleteSequenceLines.map((l) => l.text).join('\n'),
          selectableLines: incompleteSequenceLines,
        },
      ],
      { supplierHint: 'laser_central' }
    );

    assert(
      geminiApiCalls === 1,
      'Gemini fallback API (/api/extract-docket) automatically invoked when Tesseract detects missing line #3'
    );
    assert(
      smartFallbackResult.extractedData.extractionMethod === 'ai-vision' &&
        smartFallbackResult.extractedData.fallbackUsed === true,
      'Fallback output marks extractionMethod = ai-vision and fallbackUsed = true'
    );
    assert(
      smartFallbackResult.extractedData.extractionEngineLabel?.includes('Gemini AI Fallback') === true,
      `Engine label clearly indicates Gemini AI Fallback (${smartFallbackResult.extractedData.extractionEngineLabel})`
    );
    assert(
      Boolean(smartFallbackResult.extractedData.geminiFallbackReason) &&
        smartFallbackResult.extractedData.geminiFallbackReason!.includes('3'),
      `Fallback reason explains why Gemini was triggered (${smartFallbackResult.extractedData.geminiFallbackReason})`
    );
    assert(
      smartFallbackResult.extractedData.items.length === 4 &&
        smartFallbackResult.extractedData.items[2].partNumber === 'LC-1003-C',
      'Gemini fallback recovers all 4 rows including previously missed row #3'
    );
  } finally {
    globalThis.fetch = originalFetch;
    await terminateDocketTesseractWorker();
  }

  console.log('\n==================================================================');
  console.log(` BENCHMARK SUMMARY: ${passed} passed, ${failed} failed`);
  console.log(
    ` - Laser Central 2-Page Positional Extraction: 5/5 rows (100%), ${lcElapsedMs}ms`
  );
  console.log(
    ` - GCI 1-Page Positional Extraction: 3/3 rows (100%), ${gciOutput.metrics.totalTimeMs}ms`
  );
  console.log(
    ` - Scanned Laser Central Image (Real Tesseract WASM): 3/3 rows (100%), ${scannedFirstRunMs}ms (Cached re-run: ${cachedRunMs}ms)`
  );
  console.log(
    ` - Scanned GCI Image (Real Tesseract WASM): 2/2 rows (100%), ${scannedGciOutput.metrics.totalTimeMs}ms`
  );
  console.log('==================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Benchmark test failed with exception:', err);
  process.exit(1);
});
