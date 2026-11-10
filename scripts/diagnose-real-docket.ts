import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createWorker, OEM, PSM } from 'tesseract.js';
import {
  parseTsvToPositionedWords,
  clearDocketOcrPageCache,
  terminateDocketTesseractWorker,
} from '../src/utils/tesseractDocketOcr.ts';
import {
  groupPositionedWordsIntoLines,
  parseIndustrialDocketText,
  detectTableColumnLayout,
  validateDocketExtractionQuality,
  combineMultiPageDocketResults,
} from '../src/utils/docketParser.ts';
import { preprocessRgbaImageBufferInPlace } from '../src/utils/imagePreprocessing.ts';

async function diagnose() {
  const imgPath = path.resolve(process.cwd(), 'public/assets/aistudio/20261110_145129_65392c1d.jpg');
  const inputBuf = fs.readFileSync(imgPath);

  // 1. Let's see what happens with browser Canvas 2D preprocessing
  const { data, info } = await sharp(inputBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const uint8Clamped = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  const diag = preprocessRgbaImageBufferInPlace(uint8Clamped, info.width, info.height);
  console.log('Preprocess diag:', diag);

  const preprocessedJpg = await sharp(Buffer.from(uint8Clamped), {
    raw: { width: info.width, height: info.height, channels: 4 }
  }).jpeg({ quality: 92 }).toBuffer();

  const worker = await createWorker('eng', OEM.LSTM_ONLY, { langPath: './public/tesseract/lang-data', gzip: true });

  for (const psm of [PSM.SINGLE_BLOCK, PSM.AUTO, PSM.SPARSE_TEXT]) {
    console.log(`\n=================== TESTING PSM ${psm} ON PREPROCESSED IMAGE ===================`);
    await worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' });
    const r = await worker.recognize(preprocessedJpg, {}, { text: true, tsv: true });
    const words = parseTsvToPositionedWords(r.data.tsv || '');
    const lines = groupPositionedWordsIntoLines(words, 1);
    console.log(`PSM ${psm}: recognized ${words.length} words, grouped into ${lines.length} lines`);
    lines.forEach((l, i) => {
      console.log(`  [Line ${i + 1} | y=${l.bbox?.y0}..${l.bbox?.y1} | conf=${l.confidence}%] ${l.text}`);
    });

    const parsed = parseIndustrialDocketText(lines, 1, 'gci');
    console.log(`  Parsed ${parsed.items.length} items (unparsed: ${parsed.unparsedCandidateCount}):`);
    parsed.items.forEach((it) => {
      console.log(`    Item ${it.itemNumber}: Part="${it.partNumber}" Rev="${it.revision || it.rev || ''}" Qty=${it.quantity} Desc="${it.description}" Conf=${it.confidence} Flags=${JSON.stringify(it.validationFlags || [])}`);
    });

    const combined = combineMultiPageDocketResults([parsed]);
    console.log(`  Validation report for PSM ${psm}:`);
    console.log(`    shouldFallbackToGemini: ${combined.validationReport.shouldFallbackToGemini}`);
    console.log(`    fallbackReason: ${combined.validationReport.fallbackReason}`);
    console.log(`    overallConfidenceScore: ${combined.validationReport.overallConfidenceScore}`);
    console.log(`    flagsSummary: ${JSON.stringify(combined.validationReport.flagsSummary)}`);
    break; // Test PSM 6 only
  }

  await worker.terminate();
}

diagnose().catch(console.error);

