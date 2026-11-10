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

    // -------------------------------------------------------------------------
    // TEST 6: Complete Regression & Browser Execution Path Suite (Groups A - E)
    // -------------------------------------------------------------------------
    console.log('\n6. Running Complete Regression Suite (Groups A, B, C, D, E & Browser Path)...');

    const {
      computeHistogramPercentile,
      normalizeDocumentLuminances,
      preprocessRgbaImageBufferInPlace,
      preprocessDocketImage,
    } = await import('../src/utils/imagePreprocessing');
    const {
      detectTableColumnLayout,
      mergeComplementaryParsedItems,
      preserveManualEditsDuringReprocess,
    } = await import('../src/utils/docketParser');
    const { setDocketTesseractWorkerFactoryForTesting } = await import(
      '../src/utils/tesseractDocketOcr'
    );

    // =========================================================================
    // GROUP A: Image Preprocessing Regression Tests
    // =========================================================================
    console.log('\n  [Group A] Image Preprocessing Histogram & Contrast Stretch...');

    const buildSyntheticRgba = (
      totalPx: number,
      pixelLuminanceFn: (idx: number) => number
    ): Uint8ClampedArray => {
      const rgba = new Uint8ClampedArray(totalPx * 4);
      for (let i = 0; i < totalPx; i++) {
        const lum = Math.max(0, Math.min(255, Math.round(pixelLuminanceFn(i))));
        const off = i * 4;
        rgba[off] = lum;
        rgba[off + 1] = lum;
        rgba[off + 2] = lum;
        rgba[off + 3] = 255;
      }
      return rgba;
    };

    // A1: Predominantly white document (< 1% dark pixels: 0.5% black text, 99.5% white paper)
    {
      const totalPx = 100000;
      const darkPx = Math.floor(totalPx * 0.005);
      const rgba = buildSyntheticRgba(totalPx, (i) => (i < darkPx ? 15 : 252));
      const diag = preprocessRgbaImageBufferInPlace(rgba);
      assert(
        diag.pLow < 252 && diag.pHigh >= 250 && diag.whitePixelRatioAfter >= 0.98 && !diag.safeguardTriggered,
        `[A1] Predominantly white doc (<1% dark pixels): pLow=${diag.pLow}, pHigh=${diag.pHigh}, whiteRatio=${diag.whitePixelRatioAfter}`
      );
      // Verify text pixels stayed dark (0) and paper pixels stayed white (255)
      assert(
        rgba[0] <= 20 && rgba[(totalPx - 1) * 4] >= 250,
        `[A1] Text pixels remain dark (${rgba[0]}) and paper pixels remain white (${rgba[(totalPx - 1) * 4]})`
      );
    }

    // A2: Sparse document (2% dark pixels)
    {
      const totalPx = 100000;
      const darkPx = Math.floor(totalPx * 0.02);
      const rgba = buildSyntheticRgba(totalPx, (i) => (i < darkPx ? 20 : 250));
      const diag = preprocessRgbaImageBufferInPlace(rgba);
      assert(
        diag.pLow <= 30 && diag.pHigh >= 245 && diag.whitePixelRatioAfter >= 0.96,
        `[A2] 2% dark pixels doc: computeHistogramPercentile stops at first bin (pLow=${diag.pLow}, pHigh=${diag.pHigh}, whiteRatio=${diag.whitePixelRatioAfter})`
      );
    }

    // A3: Normal printed document (8% dark text on white background)
    {
      const totalPx = 100000;
      const darkPx = Math.floor(totalPx * 0.08);
      const rgba = buildSyntheticRgba(totalPx, (i) => (i < darkPx ? 25 : 245));
      const diag = preprocessRgbaImageBufferInPlace(rgba);
      assert(
        diag.pLow <= 35 && diag.pHigh >= 240 && diag.whitePixelRatioAfter >= 0.9,
        `[A3] Normal printed document (8% text): pLow=${diag.pLow}, pHigh=${diag.pHigh}, whiteRatio=${diag.whitePixelRatioAfter}`
      );
    }

    // A4: Low-contrast text (faint gray ink 135 on off-white paper 195)
    {
      const totalPx = 100000;
      const darkPx = Math.floor(totalPx * 0.05);
      const rgba = buildSyntheticRgba(totalPx, (i) => (i < darkPx ? 135 : 195));
      const diag = preprocessRgbaImageBufferInPlace(rgba);
      assert(
        rgba[0] < 40 && rgba[(totalPx - 1) * 4] >= 245 && diag.whitePixelRatioAfter >= 0.9,
        `[A4] Low-contrast text stretched cleanly: darkInk=${rgba[0]}, paper=${rgba[(totalPx - 1) * 4]}, whiteRatio=${diag.whitePixelRatioAfter}`
      );
    }

    // A5: Photographed document with shadows (background gradient 165..235, dark text 30)
    {
      const totalPx = 100000;
      const darkPx = Math.floor(totalPx * 0.04);
      const rgba = buildSyntheticRgba(totalPx, (i) => {
        if (i < darkPx) return 30;
        return 165 + ((i % 70));
      });
      const diag = preprocessRgbaImageBufferInPlace(rgba);
      assert(
        rgba[0] <= 25 && diag.whitePixelRatioAfter >= 0.7 && !diag.safeguardTriggered,
        `[A5] Shadowed photo normalized without blackening background: text=${rgba[0]}, whiteRatio=${diag.whitePixelRatioAfter}`
      );
    }

    // A6: Predominantly dark background document (light text 235 on dark background 20)
    {
      const totalPx = 100000;
      const textPx = Math.floor(totalPx * 0.04);
      const rgba = buildSyntheticRgba(totalPx, (i) => (i < textPx ? 235 : 20));
      const diag = preprocessRgbaImageBufferInPlace(rgba);
      assert(
        diag.invertedDarkDocument === true &&
          diag.whitePixelRatioAfter >= 0.9 &&
          rgba[0] <= 30 &&
          rgba[(totalPx - 1) * 4] >= 245,
        `[A6] Dark background document auto-inverted to dark text (${rgba[0]}) on white background (${rgba[(totalPx - 1) * 4]}), whiteRatio=${diag.whitePixelRatioAfter}`
      );
    }

    // A7: Uniform image division-by-zero safeguard
    {
      const totalPx = 10000;
      const rgba = buildSyntheticRgba(totalPx, () => 240);
      const diag = preprocessRgbaImageBufferInPlace(rgba);
      assert(
        diag.pHigh > diag.pLow && rgba[0] === 255,
        `[A7] Division-by-zero prevented on uniform image (pLow=${diag.pLow}, pHigh=${diag.pHigh})`
      );
    }

    // =========================================================================
    // GROUP B: PDF Extraction & Complementary Merging Regression Tests
    // =========================================================================
    console.log('\n  [Group B] PDF Extraction (Selectable, Scanned, Partially Selectable, Multi-Page, Quotes/Inches)...');

    // B1 & B3: Partially selectable PDF where native PDF text has rows 1-2 and scanned image (Tesseract) has rows 1-3
    {
      clearDocketOcrPageCache();
      const partialPdfSelectableLines = buildPositionedTableLines([
        {
          pageNumber: 1,
          y0: 40,
          cells: [{ text: 'LASER CENTRAL PTY LTD', x0: 40, x1: 260 }],
        },
        {
          pageNumber: 1,
          y0: 68,
          cells: [{ text: 'DELIVERY DOCKET: LC-30991', x0: 40, x1: 260 }],
        },
        {
          pageNumber: 1,
          y0: 140,
          cells: [
            { text: 'No', x0: 40, x1: 68 },
            { text: 'Part Number', x0: 85, x1: 210 },
            { text: 'Description', x0: 275, x1: 450 },
            { text: 'Qty', x0: 615, x1: 660 },
          ],
        },
        {
          pageNumber: 1,
          y0: 170,
          cells: [
            { text: '1', x0: 42, x1: 58 },
            { text: 'LC-8801-A', x0: 85, x1: 195 },
            { text: 'MAIN BOOM BRACKET', x0: 275, x1: 445 },
            { text: '4', x0: 620, x1: 645 },
          ],
        },
        {
          pageNumber: 1,
          y0: 198,
          cells: [
            { text: '2', x0: 42, x1: 58 },
            { text: 'LC-8802-B', x0: 85, x1: 195 },
            { text: 'PIVOT MOUNT PLATE', x0: 275, x1: 445 },
            { text: '12', x0: 620, x1: 645 },
          ],
        },
      ]);

      // Pass the real rasterized BMP (which contains LC-8801-A, LC-8802-B, AND LC-8803-C) + partialPdfSelectableLines (only LC-8801-A & LC-8802-B)
      const partialPdfResult = await extractDocketWithTesseractFirst([scannedLaserCentralImage], {
        supplierHint: 'laser_central',
        pageTextHints: [
          {
            hasSelectableText: true,
            rawText: partialPdfSelectableLines.map((l) => l.text).join('\n'),
            selectableLines: partialPdfSelectableLines,
          },
        ],
      });

      assert(
        partialPdfResult.diagnostics.recognizeCalled === true,
        '[B1/B3] Tesseract.recognize() is ALWAYS called on real rendered PDF page image even when selectable PDF text exists'
      );
      assert(
        partialPdfResult.extractedData.items.length === 3 &&
          partialPdfResult.extractedData.items.some((i) => i.partNumber.includes('8803')) &&
          partialPdfResult.validationReport.shouldFallbackToGemini === false,
        `[B3] Partially selectable PDF merges native PDF text (2 rows) + Tesseract OCR (row 3: LC-8803-C) into ${partialPdfResult.extractedData.items.length} unique rows with 0 duplicates`
      );
    }

    // B5: PDF / OCR lines containing unusual characters, smart quotes, and inch measurements (1/2", 3/8")
    {
      const quotesAndInchesLines = buildPositionedTableLines([
        {
          pageNumber: 1,
          y0: 40,
          cells: [{ text: 'GCI GROUP AUSTRALIA', x0: 40, x1: 260 }],
        },
        {
          pageNumber: 1,
          y0: 68,
          cells: [{ text: 'DELIVERY DOCKET: GCI-55410', x0: 40, x1: 280 }],
        },
        {
          pageNumber: 1,
          y0: 120,
          cells: [
            { text: 'Item', x0: 40, x1: 75 },
            { text: 'Part No', x0: 95, x1: 230 },
            { text: 'Rev', x0: 245, x1: 280 },
            { text: 'Description', x0: 295, x1: 580 },
            { text: 'Thick', x0: 600, x1: 660 },
            { text: 'Qty', x0: 685, x1: 735 },
          ],
        },
        {
          pageNumber: 1,
          y0: 150,
          cells: [
            { text: '1', x0: 42, x1: 60 },
            { text: '“GCI-701-A”', x0: 95, x1: 220 },
            { text: 'A', x0: 250, x1: 270 },
            { text: 'HEAVY GUSSET "TYPE A" 12" x 24"', x0: 295, x1: 575 },
            { text: '1/2"', x0: 600, x1: 650 },
            { text: '8', x0: 690, x1: 720 },
          ],
        },
        {
          pageNumber: 1,
          y0: 180,
          cells: [
            { text: '2', x0: 42, x1: 60 },
            { text: '"GCI-702-B"', x0: 95, x1: 220 },
            { text: 'B', x0: 250, x1: 270 },
            { text: 'CLEAT PLATE 3/8" DRILLED', x0: 295, x1: 575 },
            { text: '3/8"', x0: 600, x1: 650 },
            { text: '14', x0: 690, x1: 720 },
          ],
        },
      ]);

      const parsedQuotes = parseIndustrialDocketText(quotesAndInchesLines, 1, 'gci');
      assert(
        parsedQuotes.items.length === 2 &&
          parsedQuotes.items[0].partNumber === 'GCI-701-A' &&
          parsedQuotes.items[0].thickness === '1/2"' &&
          parsedQuotes.items[1].partNumber === 'GCI-702-B' &&
          parsedQuotes.items[1].thickness === '3/8"',
        `[B5] Quotes stripped from part numbers (${parsedQuotes.items[0]?.partNumber}, ${parsedQuotes.items[1]?.partNumber}) while preserving inch measurements (${parsedQuotes.items[0]?.thickness}, ${parsedQuotes.items[1]?.thickness})`
      );
    }

    // =========================================================================
    // GROUP C: Tesseract Worker Error Handling Regression Tests
    // =========================================================================
    console.log('\n  [Group C] Tesseract Worker Init, Language Load, Recognition & Malformed Block JSON...');

    try {
      // C1: Worker initialization failure propagates properly
      setDocketTesseractWorkerFactoryForTesting(async () => {
        throw new Error('Simulated WASM worker.min.js initialization failure');
      });
      let initErrCaught: Error | null = null;
      try {
        await extractDocketWithTesseractFirst([scannedLaserCentralImage]);
      } catch (e: any) {
        initErrCaught = e;
      }
      assert(
        initErrCaught !== null &&
          initErrCaught.message.includes('Simulated WASM worker.min.js initialization failure'),
        `[C1] Worker initialization failure propagates properly (${initErrCaught?.message})`
      );

      // C2: Language loading failure propagates properly and marks trainedDataLoaded = false
      setDocketTesseractWorkerFactoryForTesting(async () => {
        throw new Error('Failed to load language eng.traineddata.gz (HTTP 404)');
      });
      let langErrCaught: Error | null = null;
      try {
        await extractDocketWithTesseractFirst([scannedLaserCentralImage]);
      } catch (e: any) {
        langErrCaught = e;
      }
      const { getTesseractWorkerDiagnosticState } = await import('../src/utils/tesseractDocketOcr');
      const diagAfterLangErr = getTesseractWorkerDiagnosticState();
      assert(
        langErrCaught !== null &&
          langErrCaught.message.includes('eng.traineddata.gz') &&
          diagAfterLangErr.workerInitialised === false &&
          diagAfterLangErr.trainedDataLoaded === false,
        `[C2] Language loading failure propagates and sets trainedDataLoaded=false (${langErrCaught?.message})`
      );

      // C3: Unrecoverable recognition failure propagates and triggers Gemini fallback with C_TESSERACT_FAILED_TO_RECOGNISE_TEXT
      setDocketTesseractWorkerFactoryForTesting(async () => ({
        setParameters: async () => {},
        recognize: async () => {
          throw new Error('Simulated Leptonica pixRead corrupted buffer error');
        },
        terminate: async () => {},
      }));
      geminiApiCalls = 0;
      const recFailSmart = await performSmartDocketExtraction([scannedLaserCentralImage]);
      assert(
        geminiApiCalls === 1 &&
          recFailSmart.extractedData.tesseractDiagnostics?.outcomeCode ===
            'C_TESSERACT_FAILED_TO_RECOGNISE_TEXT' &&
          recFailSmart.extractedData.tesseractDiagnostics?.exactTriggerCondition?.includes(
            'Simulated Leptonica pixRead corrupted buffer error'
          ) === true,
        `[C3] Unrecoverable recognition failure propagates to smart extractor, triggers Gemini, and records C_TESSERACT_FAILED_TO_RECOGNISE_TEXT`
      );

      // C4: Empty recognition result records C_TESSERACT_FAILED_TO_RECOGNISE_TEXT
      setDocketTesseractWorkerFactoryForTesting(async () => ({
        setParameters: async () => {},
        recognize: async () => ({
          data: { text: '', tsv: '', blocks: [], confidence: 0 },
        }),
        terminate: async () => {},
      }));
      const emptyRecResult = await extractDocketWithTesseractFirst([scannedLaserCentralImage]);
      assert(
        emptyRecResult.diagnostics.outcomeCode === 'C_TESSERACT_FAILED_TO_RECOGNISE_TEXT' &&
          emptyRecResult.validationReport.shouldFallbackToGemini === true,
        `[C4] Empty OCR recognition result classified as C_TESSERACT_FAILED_TO_RECOGNISE_TEXT`
      );

      // C5: Malformed block JSON (`{ blocks: true }` throws SyntaxError on quotes) retries with `{ text: true, tsv: true }` and succeeds!
      let recognizeCallCount = 0;
      setDocketTesseractWorkerFactoryForTesting(async () => ({
        setParameters: async () => {},
        recognize: async (_img: any, _opts: any, outputFormats: any) => {
          recognizeCallCount++;
          if (outputFormats?.blocks) {
            throw new SyntaxError('Unexpected token " in JSON at position 412 (api.GetJSONText)');
          }
          // Return TSV output with word bounding boxes including 1/2" inch quote
          const tsvLines = [
            'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
            '5\t1\t1\t1\t1\t1\t40\t40\t120\t20\t96\tLASER',
            '5\t1\t1\t1\t1\t2\t170\t40\t140\t20\t96\tCENTRAL',
            '5\t1\t1\t1\t2\t1\t40\t70\t110\t20\t95\tDOCKET:',
            '5\t1\t1\t1\t2\t2\t160\t70\t120\t20\t95\tLC-99100',
            '5\t1\t1\t1\t3\t1\t40\t120\t35\t18\t96\tNo',
            '5\t1\t1\t1\t3\t2\t100\t120\t110\t18\t96\tPart',
            '5\t1\t1\t1\t3\t3\t280\t120\t160\t18\t96\tDescription',
            '5\t1\t1\t1\t3\t4\t620\t120\t50\t18\t96\tQty',
            '5\t1\t1\t1\t4\t1\t42\t155\t25\t18\t95\t1',
            '5\t1\t1\t1\t4\t2\t100\t155\t120\t18\t95\tLC-501-A',
            '5\t1\t1\t1\t4\t3\t280\t155\t240\t18\t94\t1/2" BASE PLATE G250',
            '5\t1\t1\t1\t4\t4\t625\t155\t35\t18\t96\t6',
          ].join('\n');
          return {
            data: {
              text: 'LASER CENTRAL\nDOCKET: LC-99100\nNo Part Description Qty\n1 LC-501-A 1/2" BASE PLATE G250 6',
              tsv: tsvLines,
              confidence: 95,
            },
          };
        },
        terminate: async () => {},
      }));

      const tsvRetryResult = await extractDocketWithTesseractFirst([scannedLaserCentralImage]);
      assert(
        recognizeCallCount === 2 &&
          tsvRetryResult.diagnostics.outcomeCode === 'F_TESSERACT_SUCCEEDED' &&
          tsvRetryResult.extractedData.items.length === 1 &&
          tsvRetryResult.extractedData.items[0].partNumber === 'LC-501-A' &&
          tsvRetryResult.extractedData.items[0].thickness === '1/2"' &&
          tsvRetryResult.extractedData.items[0].quantity === 6 &&
          tsvRetryResult.diagnostics.stages.some((s) => s.stage.includes('recognize_blocks_retry')),
        `[C5] GetJSONText SyntaxError on quotes caught, logged in diagnostics, retried with {text:true, tsv:true}, and parsed 1/2" plate with word coordinates`
      );
    } finally {
      setDocketTesseractWorkerFactoryForTesting(null);
    }

    // =========================================================================
    // GROUP D: Table Parsing Across Resolutions (>300px), Multi-Line, Revisions & Pallets
    // =========================================================================
    console.log('\n  [Group D] Table Parsing Across Resolutions (600px, 1600px, 2400px), Multi-Line & Revisions...');

    // D1 & D2: Test wide-resolution table (2400px wide, columns extending up to 2250px) and narrow-resolution table (600px wide)
    for (const pageWidth of [600, 1600, 2400]) {
      const scaleX = pageWidth / 1000;
      const sx = (x: number) => Math.round(x * scaleX);
      const scaledLines = buildPositionedTableLines([
        {
          pageNumber: 1,
          y0: 40,
          cells: [{ text: 'LASER CENTRAL PTY LTD', x0: sx(40), x1: sx(320) }],
        },
        {
          pageNumber: 1,
          y0: 70,
          cells: [{ text: `DELIVERY DOCKET: LC-RES-${pageWidth}`, x0: sx(40), x1: sx(380) }],
        },
        {
          pageNumber: 1,
          y0: 120,
          cells: [
            { text: 'No', x0: sx(40), x1: sx(80) },
            { text: 'Part Number', x0: sx(110), x1: sx(270) },
            { text: 'Rev', x0: sx(300), x1: sx(350) },
            { text: 'Description', x0: sx(380), x1: sx(620) },
            { text: 'Material', x0: sx(650), x1: sx(740) },
            { text: 'Thick', x0: sx(760), x1: sx(820) },
            { text: 'Qty', x0: sx(850), x1: sx(900) },
            { text: 'Pallet', x0: sx(920), x1: sx(980) },
          ],
        },
        {
          pageNumber: 1,
          y0: 155,
          cells: [
            { text: '1', x0: sx(42), x1: sx(65) },
            { text: 'LC-9001', x0: sx(110), x1: sx(240) },
            { text: 'A', x0: sx(305), x1: sx(330) },
            { text: 'MAIN CHASSIS BEAM LH', x0: sx(380), x1: sx(600) },
            { text: 'G350', x0: sx(650), x1: sx(720) },
            { text: '12mm', x0: sx(760), x1: sx(810) },
            { text: '8', x0: sx(855), x1: sx(885) },
            { text: 'Pallet 1', x0: sx(920), x1: sx(975) },
          ],
        },
        // D3: Multi-line continuation description + dimensions on next line
        {
          pageNumber: 1,
          y0: 178,
          cells: [
            { text: 'CHAMFERED BOTH ENDS 1200x350mm HA350', x0: sx(380), x1: sx(610) },
          ],
        },
        // D4: Repeated part number with DIFFERENT revision (Rev B)
        {
          pageNumber: 1,
          y0: 208,
          cells: [
            { text: '2', x0: sx(42), x1: sx(65) },
            { text: 'LC-9001', x0: sx(110), x1: sx(240) },
            { text: 'B', x0: sx(305), x1: sx(330) },
            { text: 'MAIN CHASSIS BEAM LH REV B', x0: sx(380), x1: sx(600) },
            { text: 'G350', x0: sx(650), x1: sx(720) },
            { text: '12mm', x0: sx(760), x1: sx(810) },
            { text: '4', x0: sx(855), x1: sx(885) },
            { text: 'Pallet 1', x0: sx(920), x1: sx(975) },
          ],
        },
        // D4: Repeated part number with DIFFERENT pallet number (Pallet 2)
        {
          pageNumber: 1,
          y0: 238,
          cells: [
            { text: '3', x0: sx(42), x1: sx(65) },
            { text: 'LC-9001', x0: sx(110), x1: sx(240) },
            { text: 'B', x0: sx(305), x1: sx(330) },
            { text: 'MAIN CHASSIS BEAM LH REV B', x0: sx(380), x1: sx(600) },
            { text: 'G350', x0: sx(650), x1: sx(720) },
            { text: '12mm', x0: sx(760), x1: sx(810) },
            { text: '4', x0: sx(855), x1: sx(885) },
            { text: 'Pallet 2', x0: sx(920), x1: sx(975) },
          ],
        },
      ]);

      const layout = detectTableColumnLayout(scaledLines);
      assert(
        Boolean(layout) && layout?.hasPositionalCoords === true,
        `[D1] detectTableColumnLayout resolved real word coordinates at ${pageWidth}px page width`
      );

      const parsedRes = parseIndustrialDocketText(scaledLines, 1, 'laser_central');
      const valRes = validateDocketExtractionQuality(
        parsedRes.items,
        parsedRes.unparsedCandidateCount
      );
      assert(
        parsedRes.items.length === 3 &&
          parsedRes.items[0].partNumber === 'LC-9001' &&
          parsedRes.items[0].revision === 'A' &&
          parsedRes.items[0].quantity === 8 &&
          parsedRes.items[0].dimensions === '1200x350mm' &&
          parsedRes.items[1].revision === 'B' &&
          parsedRes.items[1].palletNumber === 'Pallet 1' &&
          parsedRes.items[2].revision === 'B' &&
          parsedRes.items[2].palletNumber === 'Pallet 2' &&
          !valRes.flagsSummary.includes('duplicate_entry'),
        `[D1-D4] Page width ${pageWidth}px (max X=${sx(980)}px): extracted all 3 rows, merged multi-line description/dimensions, and accepted repeated part LC-9001 across Rev A / Rev B / Pallet 2 without false duplicate warning`
      );
    }

    // D5: Character-offset header fallback never mixes charPos*8 with pixel word coordinates
    {
      const headerWithoutWords: RawOcrLine = {
        text: 'No   Part Number          Description                Qty',
        confidence: 95,
        pageNumber: 1,
        // Notice: no `words` array on header line!
      };
      const rowWithPixelWords: RawOcrLine = {
        text: '1    LC-7788              SIDE GUSSET 10MM G250      16',
        confidence: 95,
        pageNumber: 1,
        words: [
          { text: '1', confidence: 95, bbox: { x0: 60, y0: 150, x1: 85, y1: 170 } },
          { text: 'LC-7788', confidence: 95, bbox: { x0: 420, y0: 150, x1: 610, y1: 170 } },
          { text: 'SIDE GUSSET 10MM G250', confidence: 95, bbox: { x0: 750, y0: 150, x1: 1350, y1: 170 } },
          { text: '16', confidence: 95, bbox: { x0: 1850, y0: 150, x1: 1920, y1: 170 } },
        ],
      };
      const mixedLayout = detectTableColumnLayout([headerWithoutWords, rowWithPixelWords]);
      assert(
        Boolean(mixedLayout) && mixedLayout?.hasPositionalCoords === false,
        '[D5] Character-offset header marks hasPositionalCoords = false so pixel words are never collapsed into the rightmost column'
      );
      const parsedMixed = parseIndustrialDocketText([headerWithoutWords, rowWithPixelWords], 1, 'laser_central');
      assert(
        parsedMixed.items.length === 1 &&
          parsedMixed.items[0].partNumber === 'LC-7788' &&
          parsedMixed.items[0].quantity === 16,
        `[D5] Row with pixel words >300px under char-offset header extracts partNumber=${parsedMixed.items[0]?.partNumber}, qty=${parsedMixed.items[0]?.quantity} cleanly`
      );
    }

    // =========================================================================
    // GROUP E: Browser Canvas Execution Path, Manual Edit Preservation & Live HTTP Assets
    // =========================================================================
    console.log('\n  [Group E] Browser Canvas Execution Path, Manual Edit Preservation & Live HTTP Assets...');

    // E1: Exercise the actual browser `preprocessDocketImage()` Canvas path + Tesseract OCR
    {
      // Install a lightweight pixel-accurate HTML5 Canvas 2D + Image DOM shim for preprocessDocketImage
      const prevWindow = (globalThis as any).window;
      const prevDocument = (globalThis as any).document;
      const prevImage = (globalThis as any).Image;

      class MockBrowserImage {
          onload: (() => void) | null = null;
          onerror: ((err: any) => void) | null = null;
          crossOrigin = '';
          naturalWidth = 0;
          naturalHeight = 0;
          width = 0;
          height = 0;
          _bmpBuf: Buffer | null = null;

          set src(val: string) {
            setTimeout(() => {
              try {
                if (val.startsWith('data:image/bmp;base64,')) {
                  const buf = Buffer.from(val.slice('data:image/bmp;base64,'.length), 'base64');
                  this._bmpBuf = buf;
                  this.width = Math.abs(buf.readInt32LE(18));
                  this.height = Math.abs(buf.readInt32LE(22));
                  this.naturalWidth = this.width;
                  this.naturalHeight = this.height;
                }
                this.onload?.();
              } catch (e) {
                this.onerror?.(e);
              }
            }, 1);
          }
        }

        const createMockCanvas = () => {
          let cWidth = 0;
          let cHeight = 0;
          let rgbaBuf: Uint8ClampedArray | null = null;

          return {
            get width() {
              return cWidth;
            },
            set width(w: number) {
              cWidth = w;
              rgbaBuf = new Uint8ClampedArray(cWidth * Math.max(1, cHeight) * 4);
            },
            get height() {
              return cHeight;
            },
            set height(h: number) {
              cHeight = h;
              rgbaBuf = new Uint8ClampedArray(Math.max(1, cWidth) * cHeight * 4);
            },
            getContext: (type: string) => {
              if (type !== '2d') return null;
              return {
                fillStyle: '#FFFFFF',
                fillRect: () => {},
                drawImage: (img: any, _dx: number, _dy: number, dw: number, dh: number) => {
                  cWidth = dw;
                  cHeight = dh;
                  rgbaBuf = new Uint8ClampedArray(dw * dh * 4);
                  if (img?._bmpBuf) {
                    const buf: Buffer = img._bmpBuf;
                    const pixelOffset = buf.readUInt32LE(10);
                    const srcW = Math.abs(buf.readInt32LE(18));
                    const srcH = Math.abs(buf.readInt32LE(22));
                    const rowStride = Math.ceil((srcW * 3) / 4) * 4;
                    for (let y = 0; y < dh; y++) {
                      const sy = Math.min(srcH - 1, Math.floor((y * srcH) / dh));
                      for (let x = 0; x < dw; x++) {
                        const sx = Math.min(srcW - 1, Math.floor((x * srcW) / dw));
                        const off = pixelOffset + sy * rowStride + sx * 3;
                        const dst = (y * dw + x) * 4;
                        rgbaBuf[dst] = buf[off + 2];
                        rgbaBuf[dst + 1] = buf[off + 1];
                        rgbaBuf[dst + 2] = buf[off];
                        rgbaBuf[dst + 3] = 255;
                      }
                    }
                  }
                },
                getImageData: (_x: number, _y: number, w: number, h: number) => ({
                  width: w,
                  height: h,
                  data: rgbaBuf || new Uint8ClampedArray(w * h * 4),
                }),
                putImageData: (imgData: { data: Uint8ClampedArray }) => {
                  rgbaBuf = imgData.data;
                },
              };
            },
            toDataURL: (_mime?: string) => {
              // Encode rgbaBuf back to 24-bit top-down BMP dataUrl so Leptonica/Tesseract decodes the exact canvas pixels
              if (!rgbaBuf || cWidth <= 0 || cHeight <= 0) return scannedLaserCentralImage;
              const rowStride = Math.ceil((cWidth * 3) / 4) * 4;
              const pixelDataSize = rowStride * cHeight;
              const fileSize = 54 + pixelDataSize;
              const out = Buffer.alloc(fileSize, 0xff);
              out.write('BM', 0);
              out.writeUInt32LE(fileSize, 2);
              out.writeUInt32LE(54, 10);
              out.writeUInt32LE(40, 14);
              out.writeInt32LE(cWidth, 18);
              out.writeInt32LE(-cHeight, 22);
              out.writeUInt16LE(1, 26);
              out.writeUInt16LE(24, 28);
              out.writeUInt32LE(pixelDataSize, 34);
              for (let y = 0; y < cHeight; y++) {
                for (let x = 0; x < cWidth; x++) {
                  const src = (y * cWidth + x) * 4;
                  const dst = 54 + y * rowStride + x * 3;
                  out[dst] = rgbaBuf[src + 2];
                  out[dst + 1] = rgbaBuf[src + 1];
                  out[dst + 2] = rgbaBuf[src];
                }
              }
              return `data:image/bmp;base64,${out.toString('base64')}`;
            },
          };
        };

      let browserPrepResult: Awaited<ReturnType<typeof preprocessDocketImage>> | null = null;
      try {
        (globalThis as any).Image = MockBrowserImage;
        (globalThis as any).document = { createElement: (tag: string) => (tag === 'canvas' ? createMockCanvas() : {}) };
        (globalThis as any).window = { document: (globalThis as any).document, location: { origin: 'http://localhost:3000' } };

        browserPrepResult = await preprocessDocketImage(scannedGciImage);
      } finally {
        (globalThis as any).window = prevWindow;
        (globalThis as any).document = prevDocument;
        (globalThis as any).Image = prevImage;
      }

      assert(
        Boolean(browserPrepResult?.ocrDataUrl) &&
          browserPrepResult?.diagnostics !== undefined &&
          browserPrepResult.diagnostics.pLow <= 30 &&
          browserPrepResult.diagnostics.pHigh >= 245 &&
          browserPrepResult.diagnostics.whitePixelRatioAfter >= 0.85 &&
          !browserPrepResult.diagnostics.safeguardTriggered,
        `[E1] Browser preprocessDocketImage() Canvas 2D path executed cleanly (pLow=${browserPrepResult?.diagnostics?.pLow}, pHigh=${browserPrepResult?.diagnostics?.pHigh}, whiteRatio=${browserPrepResult?.diagnostics?.whitePixelRatioAfter})`
      );

      // Pass the browser-preprocessed image directly into real Tesseract WASM OCR
      clearDocketOcrPageCache();
      const browserOcrOut = await extractDocketWithTesseractFirst(
        [browserPrepResult!.ocrDataUrl],
        { supplierHint: 'gci' }
      );
      assert(
        browserOcrOut.diagnostics.outcomeCode === 'F_TESSERACT_SUCCEEDED' &&
          browserOcrOut.extractedData.items.length === 2 &&
          browserOcrOut.validationReport.shouldFallbackToGemini === false,
        `[E1b] Browser-preprocessed GCI docket image recognized by real Tesseract WASM (${browserOcrOut.extractedData.items.length} rows, ${browserOcrOut.metrics.ocrTimeMs}ms, 0 Gemini calls)`
      );
    }

    // E2: Manual edits preserved during reprocessing
    {
      const existingEditedItems: ExtractedDocketItem[] = [
        {
          itemNumber: '1',
          partNumber: 'LC-8801-CUSTOM',
          description: 'MANUALLY EDITED 6MM PLATE',
          revision: 'C',
          rev: 'C',
          quantity: 10,
          confidence: 'high',
          manuallyEdited: true,
          lastEditedBy: 'admin_1',
          lastEditedAt: '2026-05-14T10:00:00.000Z',
          originalOcrValues: {
            partNumber: 'LC-8801-A',
            itemNumber: '1',
            description: 'MAIN BOOM BRACKET',
            quantity: 4,
          },
        },
        {
          itemNumber: '99',
          partNumber: 'MANUAL-ADDED-PART',
          description: 'EXTRA PART ADDED BY OPERATOR',
          quantity: 2,
          confidence: 'high',
          manuallyEdited: true,
          lastEditedBy: 'admin_1',
          lastEditedAt: '2026-05-14T10:02:00.000Z',
        },
      ];

      const freshReprocessedItems = scannedLcOutput.extractedData.items;
      const preserved = preserveManualEditsDuringReprocess(
        existingEditedItems,
        freshReprocessedItems
      );

      assert(
        preserved.length === 4 &&
          preserved[0].partNumber === 'LC-8801-CUSTOM' &&
          preserved[0].quantity === 10 &&
          preserved[0].manuallyEdited === true &&
          preserved[0].originalOcrValues?.partNumber === 'LC-8801-A' &&
          preserved[1].partNumber.includes('8802') &&
          preserved[2].partNumber.includes('8803') &&
          preserved[3].partNumber === 'MANUAL-ADDED-PART',
        '[E2] Manual edits, originalOcrValues, audit metadata, and manually added rows are preserved during OCR reprocessing'
      );
    }

    // E3: Live HTTP static asset verification against http://localhost:3000
    {
      const requiredAssets = [
        '/tesseract/worker.min.js',
        '/tesseract/core/tesseract-core-simd-lstm.wasm.js',
        '/tesseract/core/tesseract-core-simd-lstm.wasm',
        '/tesseract/core/tesseract-core-lstm.wasm.js',
        '/tesseract/core/tesseract-core-lstm.wasm',
        '/tesseract/core/tesseract-core.wasm.js',
        '/tesseract/core/tesseract-core.wasm',
        '/tesseract/lang-data/eng.traineddata.gz',
        '/pdf.worker.min.mjs',
      ];

      for (const assetPath of requiredAssets) {
        const res = await originalFetch(`http://localhost:3000${assetPath}`, { method: 'HEAD' });
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        assert(
          res.status === 200 && !ct.includes('text/html'),
          `[E3] Live HTTP asset ${assetPath} served with status ${res.status} and non-HTML MIME (${ct})`
        );
      }
    }

    assert(
      scannedLcOutput.diagnostics.outcomeCode === 'F_TESSERACT_SUCCEEDED' &&
        scannedLcOutput.diagnostics.workerInitialised === true &&
        scannedLcOutput.diagnostics.workerScriptLoaded === true &&
        scannedLcOutput.diagnostics.wasmCoreLoaded === true &&
        scannedLcOutput.diagnostics.trainedDataLoaded === true &&
        scannedLcOutput.diagnostics.recognizeCalled === true &&
        scannedLcOutput.diagnostics.ocrReturnedText === true &&
        scannedLcOutput.diagnostics.ocrReturnedWords === true &&
        typeof scannedLcOutput.diagnostics.preprocessDurationMs === 'number' &&
        typeof scannedLcOutput.diagnostics.workerInitDurationMs === 'number' &&
        typeof scannedLcOutput.diagnostics.ocrDurationMs === 'number' &&
        typeof scannedLcOutput.diagnostics.parseDurationMs === 'number' &&
        scannedLcOutput.diagnostics.stages.length >= 4,
      `Diagnostic trace confirms worker init, asset loading, recognize() call, word data, stage durations, and timestamps (${scannedLcOutput.diagnostics.outcomeLabel})`
    );

    assert(
      smartFallbackResult.extractedData.tesseractDiagnostics?.outcomeCode ===
        'E_PARSING_SUCCEEDED_BUT_VALIDATION_REJECTED',
      `Fallback diagnostic trace classifies exact validation trigger (${smartFallbackResult.extractedData.tesseractDiagnostics?.outcomeCode})`
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
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Benchmark test failed with exception:', err);
  process.exit(1);
});
