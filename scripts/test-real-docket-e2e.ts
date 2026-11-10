import fs from 'node:fs';
import path from 'node:path';
import {
  extractDocketWithTesseractFirst,
  clearDocketOcrPageCache,
  terminateDocketTesseractWorker,
} from '../src/utils/tesseractDocketOcr.ts';

async function runEndToEnd() {
  clearDocketOcrPageCache();
  await terminateDocketTesseractWorker();

  const imgPath = path.resolve(process.cwd(), 'public/assets/aistudio/20261110_145129_65392c1d.jpg');
  const buf = fs.readFileSync(imgPath);

  console.log(`Running extractDocketWithTesseractFirst on real docket (${buf.byteLength} bytes)...`);
  const result = await extractDocketWithTesseractFirst([buf], {
    supplierHint: 'gci',
  });

  console.log('\n--- PIPELINE DIAGNOSTICS ---');
  console.log('Outcome Code:', result.diagnostics.outcomeCode);
  console.log('Outcome Label:', result.diagnostics.outcomeLabel);
  console.log('Total Time (ms):', result.metrics.totalTimeMs);
  console.log('OCR Time (ms):', result.metrics.ocrTimeMs);
  console.log('Parse Time (ms):', result.metrics.parseTimeMs);
  console.log('Overall Confidence Score:', result.validationReport.overallConfidenceScore);
  console.log('Should Fallback To Gemini:', result.validationReport.shouldFallbackToGemini);
  console.log('Fallback Reason:', result.validationReport.fallbackReason);
  console.log('Flags Summary:', JSON.stringify(result.validationReport.flagsSummary));

  console.log('\n--- EXTRACTED DOCKET HEADER ---');
  console.log('Supplier:', result.extractedData.supplier);
  console.log('Docket Number:', result.extractedData.docketNumber);
  console.log('Order Number:', result.extractedData.orderNumber);
  console.log('Delivery Date:', result.extractedData.deliveryDate);
  console.log('Carrier:', result.extractedData.carrier);

  console.log(`\n--- EXTRACTED ITEMS (${result.extractedData.items.length}) ---`);
  result.extractedData.items.forEach((item, idx) => {
    console.log(`Row ${idx + 1}: Line ${item.itemNumber} | Part: "${item.partNumber}" | Rev: "${item.revision || item.rev || ''}" | Qty: ${item.quantity} | Desc: "${item.description}" | Conf: ${item.confidence}`);
  });

  await terminateDocketTesseractWorker();
}

runEndToEnd().catch(console.error);
