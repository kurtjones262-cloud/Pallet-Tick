import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createWorker, OEM, PSM } from 'tesseract.js';
import {
  parseTsvToPositionedWords,
} from '../src/utils/tesseractDocketOcr.ts';
import { preprocessRgbaImageBufferInPlace } from '../src/utils/imagePreprocessing.ts';
import { RawOcrWord, RawOcrLine } from '../src/utils/docketParser.ts';

function improvedGroupWords(words: RawOcrWord[], pageNumber: number = 1): RawOcrLine[] {
  const validWords = (words || []).filter((w) => w && String(w.text || '').trim().length > 0 && w.bbox);
  if (validWords.length === 0) return [];

  // Sort by vertical center, then horizontal x0
  const sorted = [...validWords].sort((a, b) => {
    const cyA = (a.bbox.y0 + a.bbox.y1) / 2;
    const cyB = (b.bbox.y0 + b.bbox.y1) / 2;
    const avgH = Math.max(8, ((a.bbox.y1 - a.bbox.y0) + (b.bbox.y1 - b.bbox.y0)) / 2);
    if (Math.abs(cyA - cyB) > avgH * 0.5) {
      return cyA - cyB;
    }
    return a.bbox.x0 - b.bbox.x0;
  });

  const wordHeights = validWords
    .map((w) => w.bbox.y1 - w.bbox.y0)
    .filter((h) => h >= 10 && h <= 120)
    .sort((a, b) => a - b);
  const medianWordHeight =
    wordHeights.length > 0 ? wordHeights[Math.floor(wordHeights.length / 2)] : 36;
  const maxCenterDist = Math.max(16, Math.round(medianWordHeight * 0.55));

  const clusters: Array<{ cy: number; words: RawOcrWord[] }> = [];
  for (const w of sorted) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;

    const existing = clusters.find((c) => Math.abs(c.cy - cy) <= maxCenterDist);

    if (existing) {
      existing.words.push(w);
      const totalY = existing.words.reduce(
        (acc, item) => acc + (item.bbox.y0 + item.bbox.y1) / 2,
        0
      );
      existing.cy = totalY / existing.words.length;
    } else {
      clusters.push({ cy, words: [w] });
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
          text += '   ';
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

async function testClustering() {
  const imgPath = path.resolve(process.cwd(), 'public/assets/aistudio/20261106_073253_1f5d5eac.jpg');
  const rotatedBuf = await sharp(imgPath).rotate().toBuffer();

  const { data, info } = await sharp(rotatedBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const uint8Clamped = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  preprocessRgbaImageBufferInPlace(uint8Clamped, info.width, info.height);

  const preprocessedJpg = await sharp(Buffer.from(uint8Clamped), {
    raw: { width: info.width, height: info.height, channels: 4 }
  }).jpeg({ quality: 92 }).toBuffer();

  const worker = await createWorker('eng', OEM.LSTM_ONLY, { langPath: './public/tesseract/lang-data', gzip: true });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
  const r = await worker.recognize(preprocessedJpg, {}, { tsv: true });
  const words = parseTsvToPositionedWords(r.data.tsv || '');
  await worker.terminate();

  const lines = improvedGroupWords(words, 1);
  console.log(`Improved grouping: ${words.length} words -> ${lines.length} lines:`);
  lines.forEach((l, idx) => {
    console.log(`[L${idx + 1} | y=${l.bbox?.y0}..${l.bbox?.y1} | conf=${l.confidence}%] ${l.text}`);
  });
}

testClustering().catch(console.error);
