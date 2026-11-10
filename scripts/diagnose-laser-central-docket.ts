import fs from 'node:fs';
import path from 'node:path';
import {
  extractDocketWithTesseractFirst,
  clearDocketOcrPageCache,
  terminateDocketTesseractWorker,
} from '../src/utils/tesseractDocketOcr.ts';

async function diagnoseLaserCentral() {
  clearDocketOcrPageCache();
  await terminateDocketTesseractWorker();

  const imgPath = path.resolve(process.cwd(), 'public/assets/aistudio/20261106_073253_1f5d5eac.jpg');
  const sharpMod = await import('sharp');
  const sharp = (sharpMod.default || sharpMod) as any;
  const buf = await sharp(imgPath).rotate().toBuffer();

  console.log(`Processing Laser Central real docket (${buf.byteLength} bytes)...`);
  const result = await extractDocketWithTesseractFirst([buf], {
    supplierHint: 'laser_central',
  });

  console.log('\n--- DIAGNOSTICS ---');
  console.log('Outcome Code:', result.diagnostics.outcomeCode);
  console.log('Outcome Label:', result.diagnostics.outcomeLabel);
  console.log('Exact Trigger Condition:', result.diagnostics.exactTriggerCondition);
  console.log('Total Elapsed Ms:', result.metrics.totalTimeMs);
  console.log('OCR Time Ms:', result.metrics.ocrTimeMs);
  console.log('Words Count:', result.diagnostics.totalWordsCount);
  console.log('Lines Count:', result.diagnostics.totalLinesCount);
  console.log('Items Count:', result.extractedData.items.length);
  console.log('Overall Confidence Score:', result.validationReport.overallConfidenceScore);
  console.log('Should Fallback:', result.validationReport.shouldFallbackToGemini);
  console.log('Fallback Reason:', result.validationReport.fallbackReason);
  console.log('Missing Row Numbers:', result.validationReport.missingRowNumbers);
  console.log('Unparsed Candidate Count:', result.validationReport.unparsedCandidateCount);
  console.log('Flagged Row Count:', result.validationReport.flaggedRowCount);
  console.log('Flags Summary:', JSON.stringify(result.validationReport.flagsSummary, null, 2));

  console.log('\n--- ITEMS BREAKDOWN ---');
  result.extractedData.items.forEach((it, idx) => {
    console.log(
      `[#${idx + 1}] ItemNo=${it.itemNumber} | Part=${it.partNumber} | Rev=${it.revision || it.rev || ''} | Qty=${it.quantity} | Conf=${it.confidence} | Flags=${JSON.stringify(it.validationFlags || [])} | Notes="${it.notes || ''}" | Desc="${it.description}"`
    );
  });

  await terminateDocketTesseractWorker();
}

diagnoseLaserCentral().catch(console.error);
