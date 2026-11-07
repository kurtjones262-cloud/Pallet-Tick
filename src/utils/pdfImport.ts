import { RawOcrLine } from './docketParser';

export interface ExtractedPdfPage {
  pageNumber: number;
  name: string;
  dataUrl: string;
  width: number;
  height: number;
  selectableLines: RawOcrLine[];
  rawText: string;
  hasSelectableText: boolean;
}

/**
 * Checks if a File is a PDF document by MIME type or file extension.
 */
export function isPdfFile(file: File): boolean {
  if (!file) return false;
  if (file.type === 'application/pdf') return true;
  return /\.pdf$/i.test(file.name || '');
}

/**
 * Loads a PDF file in the browser using PDF.js:
 * 1. Extracts selectable text directly from each page (preserving table row Y/X order).
 * 2. Renders each page to a high-resolution image dataUrl so:
 *    - Scanned PDF pages without selectable text can be processed with OCR / Gemini AI Vision.
 *    - The user can preview the PDF page side-by-side while reviewing the compiled parts list.
 */
export async function extractPagesFromPdfFile(
  file: File,
  onPageProgress?: (currentPage: number, totalPages: number) => void
): Promise<ExtractedPdfPage[]> {
  let pdfjsLib: any;
  try {
    pdfjsLib = await import('pdfjs-dist');
  } catch (err) {
    throw new Error('PDF reader library could not be loaded.');
  }

  if (pdfjsLib.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  }

  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch {
    throw new Error(`Could not read PDF file "${file.name}". The file may be corrupted or unreadable.`);
  }

  let pdfDoc: any;
  try {
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
      useSystemFonts: true,
      isEvalSupported: false,
    });
    pdfDoc = await loadingTask.promise;
  } catch (err: any) {
    const msg = String(err?.message || err || '');
    if (/password/i.test(msg)) {
      throw new Error(`PDF "${file.name}" is password-protected. Please upload an unlocked PDF.`);
    }
    throw new Error(`Invalid or corrupted PDF file "${file.name}". Please upload a valid PDF or image.`);
  }

  const numPages = pdfDoc.numPages || 0;
  if (numPages === 0) {
    throw new Error(`PDF "${file.name}" contains no pages.`);
  }

  const extractedPages: ExtractedPdfPage[] = [];

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    onPageProgress?.(pageNum, numPages);
    const page = await pdfDoc.getPage(pageNum);

    // 1. Extract selectable digital text items and reconstruct horizontal table lines
    const selectableLines: RawOcrLine[] = [];
    let rawText = '';

    try {
      const textContent = await page.getTextContent();
      const rawItems: Array<{ str: string; x: number; y: number; width: number }> = [];

      for (const item of textContent.items || []) {
        const str = String(item.str || '');
        if (!str.trim()) continue;
        const transform = Array.isArray(item.transform) ? item.transform : [1, 0, 0, 1, 0, 0];
        const x = Number(transform[4]) || 0;
        const y = Number(transform[5]) || 0;
        const w = Number(item.width) || str.length * 5;
        rawItems.push({ str, x, y, width: w });
      }

      // Sort top-to-bottom (descending Y in PDF coordinate space), then left-to-right (ascending X)
      rawItems.sort((a, b) => {
        if (Math.abs(b.y - a.y) > 4.5) {
          return b.y - a.y;
        }
        return a.x - b.x;
      });

      // Group items that share approximately the same Y coordinate into a single table row line
      const rowClusters: Array<{ y: number; items: typeof rawItems }> = [];
      for (const it of rawItems) {
        const existingCluster = rowClusters.find((c) => Math.abs(c.y - it.y) <= 4.5);
        if (existingCluster) {
          existingCluster.items.push(it);
        } else {
          rowClusters.push({ y: it.y, items: [it] });
        }
      }

      for (const cluster of rowClusters) {
        cluster.items.sort((a, b) => a.x - b.x);
        let lineText = '';
        let prevEndX: number | null = null;

        for (const token of cluster.items) {
          if (prevEndX !== null) {
            const gap = token.x - prevEndX;
            if (gap > 12) {
              lineText += '   ';
            } else if (gap > 1.5 && !lineText.endsWith(' ') && !token.str.startsWith(' ')) {
              lineText += ' ';
            }
          }
          lineText += token.str;
          prevEndX = token.x + token.width;
        }

        const cleanedLine = lineText.trim();
        if (cleanedLine) {
          selectableLines.push({
            text: cleanedLine,
            confidence: 98,
          });
        }
      }

      rawText = selectableLines.map((l) => l.text).join('\n');
    } catch (textErr) {
      console.warn(`PDF page ${pageNum} text extraction note:`, textErr);
    }

    // 2. Render PDF page to high-resolution canvas for preview & OCR fallback
    const baseViewport = page.getViewport({ scale: 1.0 });
    const maxDim = Math.max(baseViewport.width || 600, baseViewport.height || 800);
    const targetScale = Math.min(2.6, Math.max(1.5, 2000 / maxDim));
    const viewport = page.getViewport({ scale: targetScale });

    const canvas = document.createElement('canvas');
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    let dataUrl = '';
    if (ctx) {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, width, height);
      await page.render({
        canvasContext: ctx,
        viewport,
      }).promise;
      dataUrl = canvas.toDataURL('image/jpeg', 0.88);
    }

    // Determine whether this page has real selectable text or is a scanned image page
    const alphanumericCount = (rawText.match(/[A-Za-z0-9]/g) || []).length;
    const hasSelectableText = alphanumericCount >= 25 && selectableLines.length >= 2;

    const baseName = (file.name || 'Docket.pdf').replace(/\.pdf$/i, '');
    extractedPages.push({
      pageNumber: pageNum,
      name: numPages > 1 ? `${baseName} (Page ${pageNum})` : `${baseName}.pdf`,
      dataUrl,
      width,
      height,
      selectableLines,
      rawText,
      hasSelectableText,
    });
  }

  return extractedPages;
}
