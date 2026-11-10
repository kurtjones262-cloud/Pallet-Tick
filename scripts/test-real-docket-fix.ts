import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createWorker, OEM, PSM } from 'tesseract.js';
import {
  parseTsvToPositionedWords,
} from '../src/utils/tesseractDocketOcr.ts';
import {
  groupPositionedWordsIntoLines,
} from '../src/utils/docketParser.ts';
import { preprocessRgbaImageBufferInPlace } from '../src/utils/imagePreprocessing.ts';

async function testFix() {
  const imgPath = path.resolve(process.cwd(), 'public/assets/aistudio/20261110_145129_65392c1d.jpg');
  const inputBuf = fs.readFileSync(imgPath);

  const { data, info } = await sharp(inputBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const uint8Clamped = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  preprocessRgbaImageBufferInPlace(uint8Clamped, info.width, info.height);

  const preprocessedJpg = await sharp(Buffer.from(uint8Clamped), {
    raw: { width: info.width, height: info.height, channels: 4 }
  }).jpeg({ quality: 92 }).toBuffer();

  const worker = await createWorker('eng', OEM.LSTM_ONLY, { langPath: './public/tesseract/lang-data', gzip: true });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
  const r = await worker.recognize(preprocessedJpg, {}, { text: true, tsv: true });
  const words = parseTsvToPositionedWords(r.data.tsv || '');
  const lines = groupPositionedWordsIntoLines(words, 1);
  await worker.terminate();

  console.log(`Extracted ${lines.length} lines:`);
  lines.forEach((l, idx) => console.log(`  Line ${idx + 1}: ${l.text}`));

  // Tabular line regex:
  // <line_no> <ord_qty> <desp_qty> <back_qty> <unit> | <part_code> [<rev>] | <description>
  const tabularRowRegex = /^\s*(\d{1,3})\s+(\d{1,4})\s+(\d{1,4}[\]\)]?)\s*(\d*)[|\]};/]?\s*(?:EA|PCS|UNITS|M|KG|OFF|NO)?\s*[|\]};/]?\s*(?:\|\s*)?([A-Za-z0-9\-_./]{3,24})(?:\s+([A-Z0-9]{1,2})\b(?!\w))?(?:\s+[|\]};/])?\s*(.*)$/i;

  const parsedItems: any[] = [];
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const text = rawLine.text.trim();
    const match = text.match(tabularRowRegex);
    if (match) {
      const lineNo = match[1];
      const ordQty = parseInt(match[2], 10);
      const despQty = parseInt(match[3].replace(/\D/g, ''), 10) || ordQty;
      let partCode = match[5].toUpperCase();
      let rev = match[6] ? match[6].toUpperCase() : '';
      let desc = match[7] || '';

      // If rev is more like the first word of description (e.g. length > 1 or in non-rev set)
      if (rev && /^(?:EA|PCS|THE|AND|FOR|GCI|NO|OF)$/i.test(rev)) {
        desc = `${rev} ${desc}`.trim();
        rev = '';
      }

      parsedItems.push({
        itemNumber: lineNo,
        partNumber: partCode,
        revision: rev,
        quantity: despQty,
        description: desc,
        rawIndex: i,
      });
    }
  }

  console.log('\nParsed Tabular Rows:');

  // Multi-line continuation consumption
  for (let idx = 0; idx < parsedItems.length; idx++) {
    const item = parsedItems[idx];
    const nextStart = idx + 1 < parsedItems.length ? parsedItems[idx + 1].rawIndex : lines.length;
    let continuationText = '';
    for (let j = item.rawIndex + 1; j < nextStart; j++) {
      const lineText = lines[j].text.trim();
      // Skip barcode artifacts or footers
      if (/^(?:received\s*in|customer\s*signature)/i.test(lineText)) break;
      continuationText += ' ' + lineText;
    }
    if (continuationText) {
      item.description = (item.description + ' ' + continuationText).trim();
    }
  }

  // Prefix inheritance and description clean up
  // Sibling part numbers with letter prefixes (e.g. J160799102, J160799103)
  const letterPrefixParts = parsedItems
    .map((it) => it.partNumber)
    .filter((pn) => /^[A-Z]{1,4}\d+$/.test(pn));

  for (const item of parsedItems) {
    // 1. Inherit missing letter prefix if pure numeric and matches sibling suffix
    if (/^\d{6,12}$/.test(item.partNumber)) {
      for (const prefPart of letterPrefixParts) {
        const letterPref = prefPart.match(/^([A-Z]{1,4})/)?.[1] || '';
        const numPart = prefPart.slice(letterPref.length);
        // If candidate shares the first 4-8 digits with the sibling numeric portion
        if (letterPref && item.partNumber.slice(0, 4) === numPart.slice(0, 4) && item.partNumber.length === numPart.length) {
          item.partNumber = `${letterPref}${item.partNumber}`;
          break;
        }
      }
    }

    // 2. Clean description noise:
    let d = item.description;
    // Replace OCR artifact ™ with **
    d = d.replace(/™/g, '**');
    // Normalize OCR [3160799102 or 3160799104 at start of desc to J160799102 / J160799104
    d = d.replace(/^\[?3(\d{8,10})\b/i, 'J$1');
    d = d.replace(/\.s\*/g, ' **');
    d = d.replace(/\*\*OFFCUT\.?\s*/i, '**OFFCUT ');
    // Clean Delivery description
    d = d.replace(/Deliverylincluded,\s*\(FIS\)/i, 'Delivery included (FIS)');
    d = d.replace(/GCI\s+Group's\s+truck,Pl\s+on/i, 'on GCI Group\'s truck.');
    d = d.replace(/note;\s*Delivery\s*timing\s*is\s*subject\s*to\s*ourtruck's[§,]+/i, 'Please note: Delivery timing is subject to our truck\'s');
    d = d.replace(/availability[,\s]+ees$/i, 'availability.');
    // Clean Customer labels noise
    d = d.replace(/\s*["'“]?5\s*<a.*$/i, '');
    d = d.replace(/\s+/g, ' ').trim();

    item.description = d;
  }

  console.log(JSON.stringify(parsedItems, null, 2));
}

testFix().catch(console.error);
