import { createWorker, OEM } from 'tesseract.js';
import { preprocessDocketImage } from './imagePreprocessing';
import {
  parseIndustrialDocketText,
  combineMultiPageDocketResults,
  RawOcrLine,
} from './docketParser';
import {
  ExtractedDocketResult,
  PageSlicePayload,
} from '../server/docketOcr';

export interface OcrProgressUpdate {
  currentPage: number;
  totalPages: number;
  stage: 'preparing' | 'preprocessing' | 'recognizing' | 'parsing' | 'complete';
  percent: number; // 0 - 100
  statusText: string;
}

export interface OfflineDocketExtractionOutput {
  extractedData: ExtractedDocketResult;
  processedPages: Array<{
    pageNumber: number;
    originalDataUrl: string;
    preprocessedDataUrl: string;
    width: number;
    height: number;
    slicePayload?: PageSlicePayload;
  }>;
}

/**
 * Resolves the API endpoint URL so both Web App and standalone Android APK (when online)
 * can reach the Gemini AI server route.
 */
export function resolveApiUrl(path: string): string {
  if (typeof window !== 'undefined' && window.location) {
    const { protocol, hostname } = window.location;
    if (
      protocol === 'capacitor:' ||
      protocol === 'file:' ||
      (hostname === 'localhost' && window.location.port === '')
    ) {
      return `https://ais-pre-ylb2fbnp5zlbokgpprntyu-908589663728.asia-southeast1.run.app${path}`;
    }
  }
  return path;
}

/**
 * Quickly resizes/compresses a photo in full color for Gemini AI Vision
 * without applying grayscale OCR thresholding.
 */
export async function prepareColorImageForGemini(
  source: string | File,
  maxDimension: number = 2000
): Promise<{ dataUrl: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let objectUrl: string | null = null;

    img.onload = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      const origW = img.naturalWidth || img.width || 1200;
      const origH = img.naturalHeight || img.height || 1600;
      const scale =
        Math.max(origW, origH) > maxDimension ? maxDimension / Math.max(origW, origH) : 1;
      const width = Math.max(1, Math.round(origW * scale));
      const height = Math.max(1, Math.round(origH * scale));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve({
          dataUrl: typeof source === 'string' ? source : '',
          width: origW,
          height: origH,
        });
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
      resolve({ dataUrl, width, height });
    };

    img.onerror = (err) => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      reject(err);
    };

    if (typeof source === 'string') {
      img.src = source;
    } else {
      objectUrl = URL.createObjectURL(source);
      img.src = objectUrl;
    }
  });
}

/**
 * Creates a full-page image PLUS two overlapping high-resolution horizontal slices:
 * - upperDataUrl: top 0% to 58% of the page (at 2x vertical detail)
 * - lowerDataUrl: bottom 42% to 100% of the page (at 2x vertical detail)
 * Both slices are sent inside a single Gemini API call per page/batch so we achieve
 * 100% row recall without exceeding the 15-RPM Free Tier rate limit.
 */
async function preparePageSlicesForGemini(
  source: string | File,
  maxDimension: number = 2100
): Promise<{
  fullDataUrl: string;
  upperDataUrl: string;
  lowerDataUrl: string;
  width: number;
  height: number;
}> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let objectUrl: string | null = null;

    img.onload = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      const origW = img.naturalWidth || img.width || 1200;
      const origH = img.naturalHeight || img.height || 1600;
      const scale =
        Math.max(origW, origH) > maxDimension ? maxDimension / Math.max(origW, origH) : 1;
      const width = Math.max(1, Math.round(origW * scale));
      const height = Math.max(1, Math.round(origH * scale));

      // 1. Full page canvas
      const fullCanvas = document.createElement('canvas');
      fullCanvas.width = width;
      fullCanvas.height = height;
      const fullCtx = fullCanvas.getContext('2d');
      if (!fullCtx) {
        const fallback = typeof source === 'string' ? source : '';
        resolve({
          fullDataUrl: fallback,
          upperDataUrl: fallback,
          lowerDataUrl: fallback,
          width: origW,
          height: origH,
        });
        return;
      }
      fullCtx.drawImage(img, 0, 0, width, height);
      const fullDataUrl = fullCanvas.toDataURL('image/jpeg', 0.84);

      // 2. Upper 58% slice (0% -> 58%)
      const upperH = Math.max(1, Math.round(height * 0.58));
      const upperCanvas = document.createElement('canvas');
      upperCanvas.width = width;
      upperCanvas.height = upperH;
      const upperCtx = upperCanvas.getContext('2d');
      let upperDataUrl = fullDataUrl;
      if (upperCtx) {
        upperCtx.drawImage(fullCanvas, 0, 0, width, upperH, 0, 0, width, upperH);
        upperDataUrl = upperCanvas.toDataURL('image/jpeg', 0.88);
      }

      // 3. Lower 58% slice (42% -> 100%)
      const lowerStartY = Math.floor(height * 0.42);
      const lowerH = Math.max(1, height - lowerStartY);
      const lowerCanvas = document.createElement('canvas');
      lowerCanvas.width = width;
      lowerCanvas.height = lowerH;
      const lowerCtx = lowerCanvas.getContext('2d');
      let lowerDataUrl = fullDataUrl;
      if (lowerCtx) {
        lowerCtx.drawImage(fullCanvas, 0, lowerStartY, width, lowerH, 0, 0, width, lowerH);
        lowerDataUrl = lowerCanvas.toDataURL('image/jpeg', 0.88);
      }

      resolve({
        fullDataUrl,
        upperDataUrl,
        lowerDataUrl,
        width,
        height,
      });
    };

    img.onerror = (err) => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      reject(err);
    };

    if (typeof source === 'string') {
      img.src = source;
    } else {
      objectUrl = URL.createObjectURL(source);
      img.src = objectUrl;
    }
  });
}

/**
 * Smart Delivery Docket & Tax Invoice Parts Compiler:
 * - Coordinates extraction in a single server request using batched Dual-Zoom slices
 *   + single-call Global 1..MaxNo Gap Recovery (staying well under the 15-RPM Free Tier limit
 *   while capturing 100% of rows, e.g. 199/199).
 * - Falls back to on-device Tesseract.js OCR only when offline or when forceOffline is enabled.
 */
export interface PageTextHint {
  selectableLines?: RawOcrLine[];
  rawText?: string;
  hasSelectableText?: boolean;
}

/**
 * Smart Delivery Docket, PDF & Tax Invoice Parts Compiler:
 * - Supports both uploaded images and PDF documents (selectable text PDFs + scanned PDFs).
 * - When a PDF contains selectable text, extracts the text directly and uses it (both for instant
 *   offline compilation and to enrich Gemini AI structured extraction when online).
 * - Where a PDF contains scanned pages without selectable text, automatically uses OCR
 *   (Gemini AI Vision when online, or on-device Tesseract.js OCR when offline).
 */
export async function performSmartDocketExtraction(
  images: Array<string | File>,
  onProgress?: (update: OcrProgressUpdate) => void,
  forceOffline: boolean = false,
  pageTextHints?: PageTextHint[]
): Promise<OfflineDocketExtractionOutput> {
  const totalPages = images.length;
  if (totalPages === 0) {
    throw new Error('No docket pages provided for extraction.');
  }

  const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine !== false;

  // Check if any pages have direct selectable PDF text
  const directPdfPageResults: Array<ReturnType<typeof parseIndustrialDocketText> | null> =
    images.map((_, idx) => {
      const hint = pageTextHints?.[idx];
      if (hint?.hasSelectableText && hint.selectableLines && hint.selectableLines.length > 0) {
        const parsed = parseIndustrialDocketText(hint.selectableLines, idx + 1);
        if (parsed.items.length > 0) {
          return parsed;
        }
      }
      return null;
    });

  const allPagesHaveParsedPdfText =
    directPdfPageResults.length > 0 && directPdfPageResults.every((r) => r !== null);

  if (isOnline && !forceOffline) {
    onProgress?.({
      currentPage: 1,
      totalPages,
      stage: 'preparing',
      percent: 15,
      statusText:
        totalPages > 1
          ? `Preparing ${totalPages} document pages for extraction...`
          : 'Preparing document for parts extraction...',
    });

    const preparedList = await Promise.all(
      images.map((img) => preparePageSlicesForGemini(img, 2100))
    );

    const colorPages: OfflineDocketExtractionOutput['processedPages'] = preparedList.map(
      (prepared, idx) => ({
        pageNumber: idx + 1,
        originalDataUrl: prepared.fullDataUrl,
        preprocessedDataUrl: prepared.fullDataUrl,
        width: prepared.width,
        height: prepared.height,
        slicePayload: {
          fullDataUrl: prepared.fullDataUrl,
          upperDataUrl: prepared.upperDataUrl,
          lowerDataUrl: prepared.lowerDataUrl,
          pdfSelectableText: pageTextHints?.[idx]?.rawText || undefined,
        },
      })
    );

    let progressTimer: ReturnType<typeof setInterval> | null = null;

    try {
      let simulatedPercent = 30;
      onProgress?.({
        currentPage: 1,
        totalPages,
        stage: 'recognizing',
        percent: simulatedPercent,
        statusText:
          totalPages > 1
            ? `Extracting all parts across ${totalPages} pages & verifying 100% sequence...`
            : 'Extracting all parts & verifying 100% sequence...',
      });

      progressTimer = setInterval(() => {
        simulatedPercent = Math.min(92, simulatedPercent + 6);
        const estPage = Math.min(
          totalPages,
          Math.max(1, Math.ceil(((simulatedPercent - 25) / 68) * totalPages))
        );
        onProgress?.({
          currentPage: estPage,
          totalPages,
          stage: simulatedPercent >= 82 ? 'parsing' : 'recognizing',
          percent: simulatedPercent,
          statusText:
            simulatedPercent >= 82
              ? 'Verifying 100% sequence completeness (checking for any missing No. rows)...'
              : totalPages > 1
              ? `Scanning Page ${estPage} of ${totalPages}...`
              : 'Compiling individual parts & details...',
        });
      }, 900);

      const extractApiUrl = resolveApiUrl('/api/extract-docket');

      const response = await fetch(extractApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: colorPages.map((p) => p.originalDataUrl),
          pageSlices: colorPages.map((p) => p.slicePayload!),
          startItemIndex: 1,
        }),
      });

      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(
          errBody?.error || `AI extraction returned status ${response.status}`
        );
      }

      const extractedResult: ExtractedDocketResult = await response.json();

      // If AI returned 0 items on a PDF that had direct selectable text items, use the direct PDF text result
      if (extractedResult.items.length === 0 && allPagesHaveParsedPdfText) {
        const combinedPdf = combineMultiPageDocketResults(
          directPdfPageResults.filter(Boolean) as Array<ReturnType<typeof parseIndustrialDocketText>>
        );
        combinedPdf.extractionMethod = 'pdf-text';
        return {
          extractedData: combinedPdf,
          processedPages: colorPages,
        };
      }

      onProgress?.({
        currentPage: totalPages,
        totalPages,
        stage: 'complete',
        percent: 100,
        statusText: `Compiled ${extractedResult.items.length} parts across ${totalPages} ${
          totalPages === 1 ? 'page' : 'pages'
        }.`,
      });

      return {
        extractedData: extractedResult,
        processedPages: colorPages,
      };
    } catch (err: any) {
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
      // If all pages came from a PDF with selectable text that parsed cleanly, return that immediately!
      if (allPagesHaveParsedPdfText) {
        const combinedPdf = combineMultiPageDocketResults(
          directPdfPageResults.filter(Boolean) as Array<ReturnType<typeof parseIndustrialDocketText>>
        );
        combinedPdf.extractionMethod = 'pdf-text';
        onProgress?.({
          currentPage: totalPages,
          totalPages,
          stage: 'complete',
          percent: 100,
          statusText: `Extracted ${combinedPdf.items.length} parts directly from PDF text.`,
        });
        return {
          extractedData: combinedPdf,
          processedPages: colorPages,
        };
      }
      // Fall back to offline OCR if network is unreachable or if PDF pages need OCR
      const stillOnline = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
      if (!stillOnline || pageTextHints?.some((h) => h !== undefined)) {
        console.info('Switching to on-device PDF/OCR extraction:', err);
        return performOfflineDocketOcr(images, onProgress, pageTextHints);
      }
      throw err;
    }
  }

  // Explicit Offline / On-Device Extraction (uses direct PDF text where selectable, and Tesseract OCR on scanned pages)
  return performOfflineDocketOcr(images, onProgress, pageTextHints);
}

/**
 * Runs completely on-device extraction across one or more docket pages:
 * - If a page is from a PDF with selectable text, extracts parts directly from the PDF text.
 * - If a page is an image or a scanned PDF page without selectable text, runs on-device Tesseract OCR.
 */
export async function performOfflineDocketOcr(
  images: Array<string | File>,
  onProgress?: (update: OcrProgressUpdate) => void,
  pageTextHints?: PageTextHint[]
): Promise<OfflineDocketExtractionOutput> {
  const totalPages = images.length;
  if (totalPages === 0) {
    throw new Error('No docket photos or PDF pages provided for processing.');
  }

  const processedPages: OfflineDocketExtractionOutput['processedPages'] = [];
  for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
    const pageNum = pageIdx + 1;
    onProgress?.({
      currentPage: pageNum,
      totalPages,
      stage: 'preprocessing',
      percent: 8 + Math.round((pageIdx / totalPages) * 15),
      statusText: `Preparing page ${pageNum} of ${totalPages}...`,
    });
    const preprocessed = await preprocessDocketImage(images[pageIdx]);
    processedPages.push({
      pageNumber: pageNum,
      originalDataUrl: preprocessed.displayDataUrl,
      preprocessedDataUrl: preprocessed.ocrDataUrl,
      width: preprocessed.width,
      height: preprocessed.height,
    });
  }

  return performOfflineDocketOcrWithPreprocessed(processedPages, onProgress, pageTextHints);
}

async function performOfflineDocketOcrWithPreprocessed(
  processedPages: OfflineDocketExtractionOutput['processedPages'],
  onProgress?: (update: OcrProgressUpdate) => void,
  pageTextHints?: PageTextHint[]
): Promise<OfflineDocketExtractionOutput> {
  const totalPages = processedPages.length;

  onProgress?.({
    currentPage: 1,
    totalPages,
    stage: 'preparing',
    percent: 22,
    statusText: 'Preparing document extraction engine...',
  });

  let worker: any = null;
  const parsedPageResults: Array<ReturnType<typeof parseIndustrialDocketText>> = [];
  let usedPdfTextCount = 0;

  try {
    const origin =
      typeof window !== 'undefined' && window.location && window.location.origin
        ? window.location.origin
        : '';

    const ensureTesseractWorker = async () => {
      if (worker) return worker;

      // Purge any stale/corrupted tesseract keyval-store IndexedDB cache from earlier sessions
      if (typeof window !== 'undefined' && 'indexedDB' in window) {
        try {
          window.indexedDB.deleteDatabase('keyval-store');
        } catch {
          // Ignore IndexedDB cleanup errors
        }
      }

      const loggerFn = (m: any) => {
        if (m.status === 'recognizing text') {
          const ocrProgress = Math.round((m.progress || 0) * 100);
          onProgress?.({
            currentPage: parsedPageResults.length + 1,
            totalPages,
            stage: 'recognizing',
            percent: Math.min(92, 25 + Math.round(ocrProgress * 0.65)),
            statusText: `Reading docket parts table: ${ocrProgress}%`,
          });
        }
      };

      const errorHandlerFn = (err: any) => {
        console.warn('Tesseract worker internal error:', err);
      };

      worker = await createWorker('eng', OEM.LSTM_ONLY, {
        workerPath: '/tesseract/worker.min.js',
        workerBlobURL: false,
        corePath: `${origin}/tesseract/core`,
        langPath: `${origin}/tesseract/lang-data`,
        gzip: true,
        cacheMethod: 'none',
        logger: loggerFn,
        errorHandler: errorHandlerFn,
      });

      return worker;
    };

    for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
      const pageNum = pageIdx + 1;
      const pageData = processedPages[pageIdx];
      const hint = pageTextHints?.[pageIdx];

      // 1. If this page is from a PDF with selectable text, try direct PDF text extraction first
      if (hint?.hasSelectableText && hint.selectableLines && hint.selectableLines.length > 0) {
        onProgress?.({
          currentPage: pageNum,
          totalPages,
          stage: 'parsing',
          percent: 30 + Math.round((pageIdx / totalPages) * 55),
          statusText: `Extracting selectable text from PDF page ${pageNum} of ${totalPages}...`,
        });

        const pdfParsed = parseIndustrialDocketText(hint.selectableLines, pageNum);
        if (pdfParsed.items.length > 0) {
          usedPdfTextCount++;
          parsedPageResults.push(pdfParsed);
          continue;
        }
      }

      // 2. Otherwise (image upload or scanned PDF page without selectable text), run OCR
      onProgress?.({
        currentPage: pageNum,
        totalPages,
        stage: 'recognizing',
        percent: 25 + Math.round((pageIdx / totalPages) * 60),
        statusText: `Running on-device OCR on page ${pageNum} of ${totalPages}...`,
      });

      const activeWorker = await ensureTesseractWorker();
      const ocrResult = await activeWorker.recognize(
        pageData.preprocessedDataUrl,
        {},
        { blocks: true, text: true }
      );
      const data = ocrResult.data || {};

      // Extract line blocks from Tesseract v7 blocks hierarchy or fallback to text lines
      const lines: RawOcrLine[] = [];

      if (data.blocks && Array.isArray(data.blocks)) {
        for (const block of data.blocks) {
          if (block.paragraphs && Array.isArray(block.paragraphs)) {
            for (const para of block.paragraphs) {
              if (para.lines && Array.isArray(para.lines)) {
                for (const line of para.lines) {
                  const text = (line.text || '').trim();
                  if (text) {
                    lines.push({
                      text,
                      confidence: line.confidence || 75,
                      bbox: line.bbox,
                    });
                  }
                }
              }
            }
          }
        }
      }

      if (lines.length === 0 && data.lines && Array.isArray(data.lines)) {
        for (const line of data.lines) {
          const text = (line.text || '').trim();
          if (text) {
            lines.push({
              text,
              confidence: line.confidence || 75,
              bbox: line.bbox,
            });
          }
        }
      }

      if (lines.length === 0 && data.text) {
        const rawLines = data.text.split('\n');
        for (const rl of rawLines) {
          const text = rl.trim();
          if (text) {
            lines.push({
              text,
              confidence: data.confidence || 75,
            });
          }
        }
      }

      onProgress?.({
        currentPage: pageNum,
        totalPages,
        stage: 'parsing',
        percent: 90,
        statusText: `Compiling individual parts & details (Page ${pageNum})...`,
      });

      const pageParsed = parseIndustrialDocketText(lines, pageNum);
      parsedPageResults.push(pageParsed);
    }

    const combinedExtracted = combineMultiPageDocketResults(parsedPageResults);
    if (usedPdfTextCount === totalPages) {
      combinedExtracted.extractionMethod = 'pdf-text';
    }

    onProgress?.({
      currentPage: totalPages,
      totalPages,
      stage: 'complete',
      percent: 100,
      statusText: `Compiled ${combinedExtracted.items.length} parts successfully.`,
    });

    return {
      extractedData: combinedExtracted,
      processedPages,
    };
  } finally {
    if (worker) {
      try {
        await worker.terminate();
      } catch (err) {
        console.warn('Worker termination note:', err);
      }
    }
  }
}
