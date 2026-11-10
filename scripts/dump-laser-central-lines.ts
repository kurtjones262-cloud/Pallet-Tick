import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createWorker, OEM, PSM } from 'tesseract.js';
import {
  parseTsvToPositionedWords,
} from '../src/utils/tesseractDocketOcr.ts';
import {
  groupPositionedWordsIntoLines,
  detectTableColumnLayout,
} from '../src/utils/docketParser.ts';
import { preprocessRgbaImageBufferInPlace } from '../src/utils/imagePreprocessing.ts';

async function dumpLines() {
  const imgPath = path.resolve(process.cwd(), 'public/assets/aistudio/20261106_073253_1f5d5eac.jpg');
  const rotatedBuf = await sharp(imgPath).rotate().toBuffer();

  const { data, info } = await sharp(rotatedBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const uint8Clamped = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  const diag = preprocessRgbaImageBufferInPlace(uint8Clamped, info.width, info.height);
  console.log('Preprocess diag:', diag);

  const preprocessedJpg = await sharp(Buffer.from(uint8Clamped), {
    raw: { width: info.width, height: info.height, channels: 4 }
  }).jpeg({ quality: 92 }).toBuffer();

  const worker = await createWorker('eng', OEM.LSTM_ONLY, { langPath: './public/tesseract/lang-data', gzip: true });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
  const r = await worker.recognize(preprocessedJpg, {}, { text: true, tsv: true });
  const words = parseTsvToPositionedWords(r.data.tsv || '');
  const lines = groupPositionedWordsIntoLines(words, 1);
  await worker.terminate();

  console.log(`Recognized ${words.length} words, grouped into ${lines.length} lines:`);
  lines.forEach((l, idx) => {
    console.log(`[L${idx + 1} | y=${l.bbox?.y0}..${l.bbox?.y1} | conf=${l.confidence}%] ${l.text}`);
  });

  const layout = detectTableColumnLayout(lines);
  console.log('Layout:', layout);
}

dumpLines().catch(console.error);
