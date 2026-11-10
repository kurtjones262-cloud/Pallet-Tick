import React, { useState, useRef } from 'react';
import {
  Camera,
  Images,
  FolderOpen,
  FileText,
  X,
  AlertCircle,
  ChevronRight,
  Trash2,
  Sparkles,
  Check,
  ChevronDown,
} from 'lucide-react';
import { Delivery, SupplierRuleId } from '../types/delivery';
import {
  SUPPLIER_RULES,
  getPreferredSupplierRuleId,
  setPreferredSupplierRuleId,
} from '../utils/storage';
import { ExtractedDocketResult } from '../server/docketOcr';
import {
  performSmartDocketExtraction,
  prepareColorImageForGemini,
  OcrProgressUpdate,
  PageTextHint,
} from '../utils/offlineOcr';
import { isPdfFile, extractPagesFromPdfFile } from '../utils/pdfImport';
import { DocketOcrReviewModal } from './DocketOcrReviewModal';

interface NewDeliveryModalProps {
  onClose: () => void;
  onDeliveryCreated: (delivery: Delivery) => void;
}

export type UploadOrigin = 'camera' | 'gallery' | 'files';

interface CapturedPage {
  id: string;
  dataUrl: string;
  name: string;
  sourceType?: 'image' | 'pdf';
  uploadOrigin?: UploadOrigin;
  fileSize?: number;
  fileFormat?: string;
  textHint?: PageTextHint;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function detectFileFormatLabel(file: File): string {
  const mime = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  if (mime.includes('pdf') || name.endsWith('.pdf')) return 'PDF';
  if (mime.includes('webp') || name.endsWith('.webp')) return 'WEBP';
  if (mime.includes('png') || name.endsWith('.png')) return 'PNG';
  if (mime.includes('jpeg') || mime.includes('jpg') || name.endsWith('.jpg') || name.endsWith('.jpeg')) {
    return 'JPG';
  }
  const ext = name.includes('.') ? name.split('.').pop()?.toUpperCase() : '';
  return ext || 'FILE';
}

function isSupportedImageFile(file: File): boolean {
  const mime = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  return (
    mime.startsWith('image/') ||
    name.endsWith('.jpg') ||
    name.endsWith('.jpeg') ||
    name.endsWith('.png') ||
    name.endsWith('.webp') ||
    name.endsWith('.bmp') ||
    name.endsWith('.heic') ||
    name.endsWith('.heif')
  );
}

export const NewDeliveryModal: React.FC<NewDeliveryModalProps> = ({
  onClose,
  onDeliveryCreated,
}) => {
  const [selectedSupplierRule, setSelectedSupplierRule] = useState<SupplierRuleId>(() =>
    getPreferredSupplierRuleId()
  );

  const handleSelectSupplier = (ruleId: SupplierRuleId) => {
    setSelectedSupplierRule(ruleId);
    setPreferredSupplierRuleId(ruleId);
  };
  const [capturedPages, setCapturedPages] = useState<CapturedPage[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [loadingFileStatus, setLoadingFileStatus] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<OcrProgressUpdate | null>(null);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [reviewData, setReviewData] = useState<ExtractedDocketResult | null>(null);

  // Three distinct hidden file inputs for Mobile & Desktop:
  // 1. CAMERA: Captures a new photo directly using the rear camera
  const cameraInputRef = useRef<HTMLInputElement>(null);
  // 2. GALLERY: Opens the native Android / iOS photo gallery picker (pure image MIME types, no capture attribute)
  const galleryInputRef = useRef<HTMLInputElement>(null);
  // 3. FILES: Opens the native system file browser for PDFs, images, and documents
  const filesInputRef = useRef<HTMLInputElement>(null);

  /**
   * Stages selected files (from Camera, Gallery, or Files) into the preview queue.
   * Does NOT upload or run OCR processing until the user explicitly clicks Confirm & Compile.
   */
  const handleFilesAdded = async (
    fileList: FileList | null,
    origin: UploadOrigin = 'files'
  ) => {
    if (!fileList || fileList.length === 0) return;

    setOcrError(null);
    setIsLoadingFiles(true);
    const filesArray = Array.from(fileList);
    const newPages: CapturedPage[] = [];

    try {
      for (let i = 0; i < filesArray.length; i++) {
        const file = filesArray[i];
        const formatLabel = detectFileFormatLabel(file);

        // 1. Handle PDF documents
        if (isPdfFile(file)) {
          setLoadingFileStatus(`Staging PDF "${file.name}"...`);
          try {
            const pdfPages = await extractPagesFromPdfFile(file, (curr, total) => {
              setLoadingFileStatus(`Staging PDF "${file.name}" (Page ${curr} of ${total})...`);
            });
            for (const pdfPage of pdfPages) {
              newPages.push({
                id: `pdf_${Date.now()}_${i}_p${pdfPage.pageNumber}_${Math.random().toString(36).slice(2, 5)}`,
                dataUrl: pdfPage.dataUrl,
                name: pdfPage.name,
                sourceType: 'pdf',
                uploadOrigin: origin,
                fileSize: file.size,
                fileFormat: 'PDF',
                textHint: {
                  selectableLines: pdfPage.selectableLines,
                  rawText: pdfPage.rawText,
                  hasSelectableText: pdfPage.hasSelectableText,
                },
              });
            }
          } catch (pdfErr: any) {
            console.error('PDF staging error:', pdfErr);
            setOcrError(
              pdfErr?.message ||
                `Could not read PDF "${file.name}". Please ensure it is a valid PDF document.`
            );
          }
          continue;
        }

        // 2. Handle Images (JPG, JPEG, PNG, WebP, etc.)
        if (isSupportedImageFile(file) || origin === 'camera' || origin === 'gallery') {
          setLoadingFileStatus(`Staging image "${file.name || `Photo ${i + 1}`}"...`);
          try {
            const prepared = await prepareColorImageForGemini(file, 1800);
            newPages.push({
              id: `page_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
              dataUrl: prepared.dataUrl,
              name:
                file.name ||
                `${origin === 'camera' ? 'Camera Photo' : 'Gallery Image'} ${
                  capturedPages.length + i + 1
                }`,
              sourceType: 'image',
              uploadOrigin: origin,
              fileSize: file.size,
              fileFormat: formatLabel,
            });
          } catch (err) {
            console.error('Failed preparing image, falling back to raw reader:', err);
            try {
              const dataUrl = await readFileAsDataUrl(file);
              newPages.push({
                id: `page_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
                dataUrl,
                name: file.name || `Page ${capturedPages.length + i + 1}`,
                sourceType: 'image',
                uploadOrigin: origin,
                fileSize: file.size,
                fileFormat: formatLabel,
              });
            } catch (innerErr) {
              console.error('Fallback file read failed:', innerErr);
              setOcrError(`Could not read image "${file.name}".`);
            }
          }
          continue;
        }

        // 3. Handle text / CSV / TSV / other supported text documents selected via FILES
        if (
          file.type.startsWith('text/') ||
          /\.(txt|csv|tsv|json)$/i.test(file.name || '')
        ) {
          setLoadingFileStatus(`Staging document "${file.name}"...`);
          try {
            const rawText = await file.text();
            const rawLines = rawText
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean)
              .map((text) => ({ text, confidence: 99 }));
            const docPreviewDataUrl = renderTextDocumentPreviewDataUrl(file.name, rawText);
            newPages.push({
              id: `doc_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
              dataUrl: docPreviewDataUrl,
              name: file.name,
              sourceType: 'pdf',
              uploadOrigin: 'files',
              fileSize: file.size,
              fileFormat: formatLabel,
              textHint: {
                selectableLines: rawLines,
                rawText,
                hasSelectableText: rawLines.length > 0,
              },
            });
            continue;
          } catch (docErr) {
            console.error('Document read error:', docErr);
          }
        }

        // 4. Generic fallback: attempt image/dataUrl load
        try {
          const prepared = await prepareColorImageForGemini(file, 1800);
          newPages.push({
            id: `file_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
            dataUrl: prepared.dataUrl,
            name: file.name || `File ${capturedPages.length + i + 1}`,
            sourceType: 'image',
            uploadOrigin: origin,
            fileSize: file.size,
            fileFormat: formatLabel,
          });
        } catch {
          setOcrError(
            `Unsupported file "${file.name}". Please select a PDF, JPG, JPEG, PNG, WebP, or text document.`
          );
        }
      }

      if (newPages.length > 0) {
        setCapturedPages((prev) => [...prev, ...newPages]);
      }
    } finally {
      setIsLoadingFiles(false);
      setLoadingFileStatus('');
    }
  };

  const handleRemovePage = (id: string) => {
    setCapturedPages((prev) => prev.filter((p) => p.id !== id));
  };

  const handleClearAllPages = () => {
    setCapturedPages([]);
    setOcrError(null);
  };

  const handleExtractPartsFromDocket = async () => {
    if (capturedPages.length === 0) return;

    setIsProcessing(true);
    setOcrError(null);
    setOcrProgress({
      currentPage: 1,
      totalPages: capturedPages.length,
      stage: 'preparing',
      percent: 5,
      statusText: 'Analyzing delivery docket for individual parts...',
    });

    try {
      const imagesToProcess = capturedPages.map((p) => p.dataUrl);
      const pageTextHints = capturedPages.map((p) => p.textHint || {});
      const output = await performSmartDocketExtraction(
        imagesToProcess,
        (update) => {
          setOcrProgress(update);
        },
        false,
        pageTextHints
      );

      setIsProcessing(false);
      setReviewData({
        ...output.extractedData,
        supplier: SUPPLIER_RULES[selectedSupplierRule].name,
      });
    } catch (err: any) {
      console.error('Docket extraction error:', err);
      setIsProcessing(false);
      setOcrError(
        err?.message ||
          'Docket extraction failed. Ensure docket image or PDF is legible.'
      );
    }
  };

  return (
    <>
      {reviewData ? (
        <DocketOcrReviewModal
          extractedData={reviewData}
          initialSupplierRule={selectedSupplierRule}
          attachedPages={capturedPages.map((p, idx) => ({
            pageNumber: idx + 1,
            dataUrl: p.dataUrl,
            name: p.name,
            textHint: p.textHint,
          }))}
          onClose={() => setReviewData(null)}
          onDeliveryCreated={(newDel) => {
            onDeliveryCreated(newDel);
            onClose();
          }}
        />
      ) : (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={onClose}
        >
          <div
            className="w-full max-w-lg bg-[#F6F5F2] border-t sm:border border-[#E4E3DE] sm:rounded-[6px] shadow-xl overflow-hidden max-h-[92dvh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-[#E4E3DE] flex items-center justify-between bg-white shrink-0">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-sm text-[#18181B]">
                  Upload Invoice / Docket (Camera, Gallery or Files)
                </h3>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[3px] bg-emerald-50 text-[#059669] font-mono text-[10px] font-semibold border border-emerald-200">
                  <Sparkles className="w-2.5 h-2.5" />
                  <span>Gemini AI Active</span>
                </span>
              </div>
              <button
                onClick={onClose}
                className="p-1 text-zinc-400 hover:text-[#18181B] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* ============================================================ */}
            {/* DEDICATED HTML FILE INPUTS FOR MOBILE & DESKTOP              */}
            {/* 1. CAMERA: Rear camera photo capture (accept="image/*" + capture="environment") */}
            {/* 2. GALLERY: Pure accept="image/*" (NO capture, NO comma-separated subtypes, NO multiple on primary) so Android & Samsung One UI always show native Gallery / Photo Picker */}
            {/* 3. FILES: System file picker for PDFs, images & documents    */}
            {/* ============================================================ */}
            <input
              id="invoice-upload-camera-input"
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              disabled={isLoadingFiles}
              className="sr-only"
              onChange={async (e) => {
                await handleFilesAdded(e.target.files, 'camera');
                e.target.value = '';
              }}
            />
            {/* 2. GALLERY: Explicit image MIME types WITHOUT multiple attribute, ensuring Android & iOS open the native Photo Gallery / Photos app instead of Files */}
            <input
              id="invoice-upload-gallery-input"
              ref={galleryInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/jpg,image/heic,image/*"
              disabled={isLoadingFiles}
              className="sr-only"
              onChange={async (e) => {
                await handleFilesAdded(e.target.files, 'gallery');
                e.target.value = '';
              }}
            />
            <input
              id="invoice-upload-files-input"
              ref={filesInputRef}
              type="file"
              accept=".pdf,application/pdf,image/*,.txt,.csv,*/*"
              multiple
              disabled={isLoadingFiles}
              className="sr-only"
              onChange={async (e) => {
                await handleFilesAdded(e.target.files, 'files');
                e.target.value = '';
              }}
            />

            {/* Main Modal Body */}
            <div className="flex-1 overflow-y-auto">
              {isProcessing ? (
                <div className="py-12 px-6 flex flex-col items-center justify-center text-center">
                  <div className="w-10 h-10 rounded-full border-2 border-[#E4E3DE] border-t-[#059669] animate-spin mb-4 flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-[#059669]" />
                  </div>

                  <span className="text-[11px] font-mono uppercase tracking-widest text-[#059669] font-semibold mb-1">
                    Gemini AI &amp; PDF Compiler · Compiling Parts List
                  </span>

                  <h4
                    className={`text-sm font-bold mb-1 ${
                      (ocrProgress?.statusText || '').toLowerCase().includes('retrying')
                        ? 'text-amber-700 bg-amber-50 border border-amber-200 px-3 py-1 rounded-[4px]'
                        : 'text-[#18181B]'
                    }`}
                  >
                    {ocrProgress?.statusText || 'Analyzing your delivery docket...'}
                  </h4>

                  <p className="text-xs text-zinc-500 max-w-xs leading-relaxed mb-5">
                    Identifying every individual part number, item code, description, revision, material, thickness, dimensions, and quantity into a compiled checklist.
                  </p>

                  {/* Progress Bar */}
                  <div className="w-full max-w-xs h-1.5 bg-[#E4E3DE] rounded-full overflow-hidden mb-2">
                    <div
                      className="h-full bg-[#059669] transition-all duration-300"
                      style={{ width: `${ocrProgress?.percent || 20}%` }}
                    />
                  </div>

                  <span className="font-mono text-xs text-zinc-400 tabular-nums">
                    {ocrProgress?.percent || 20}% complete · Page {ocrProgress?.currentPage || 1} of{' '}
                    {ocrProgress?.totalPages || 1}
                  </span>
                </div>
              ) : (
                <div className="divide-y divide-[#E4E3DE]">
                  {ocrError && (
                    <div className="px-4 py-3 bg-red-50 text-xs text-red-700 space-y-2">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                        <span>{ocrError}</span>
                      </div>
                      {capturedPages.length > 0 && (
                        <div className="flex items-center justify-between gap-2 pl-6 pt-1">
                          <span className="text-[11px] text-red-600/90 font-mono">
                            Your {capturedPages.length} uploaded page(s) are preserved.
                          </span>
                          <button
                            onClick={handleExtractPartsFromDocket}
                            className="px-3 py-1.5 rounded-[4px] bg-[#059669] hover:bg-[#047857] text-white font-semibold text-xs cursor-pointer shadow-2xs"
                          >
                            Retry Extraction
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Step 1: Supplier Dropdown Menu */}
                  <div className="p-4 bg-white">
                    <div className="flex items-center justify-between mb-2">
                      <label
                        htmlFor="new-delivery-supplier-select"
                        className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500"
                      >
                        1. Select Supplier
                      </label>
                    </div>

                    <div className="relative">
                      <select
                        id="new-delivery-supplier-select"
                        value={selectedSupplierRule}
                        onChange={(e) =>
                          handleSelectSupplier(e.target.value as SupplierRuleId)
                        }
                        className="w-full h-10 pl-3 pr-9 rounded-[4px] bg-white border border-[#E4E3DE] hover:border-[#059669] focus:border-[#059669] text-xs font-bold text-[#18181B] outline-none cursor-pointer appearance-none shadow-2xs transition-colors"
                      >
                        <option value="laser_central">Laser Central</option>
                        <option value="gci">GCI</option>
                        <option value="ocr_label">OCR Label Scanner</option>
                      </select>
                      <ChevronDown className="w-4 h-4 text-zinc-500 pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" />
                    </div>
                  </div>

                  {/* Step 2: 3-Option Mobile & Desktop Upload Selection Interface */}
                  <div className="p-4 bg-white">
                    <div className="flex items-center justify-between mb-2.5">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500">
                        2. Upload Invoice / Docket (Choose Camera, Gallery or Files)
                      </span>
                    </div>

                    <p className="text-xs text-zinc-500 mb-3 leading-relaxed">
                      Tap <span className="font-semibold text-[#18181B]">1. Camera</span> to capture a new photo,{' '}
                      <span className="font-semibold text-[#059669]">2. Gallery</span> to select existing photos from your device gallery (JPG, JPEG, PNG, WebP), or{' '}
                      <span className="font-semibold text-[#18181B]">3. Files</span> to browse PDFs, images, and documents.
                    </p>

                    {/* Three Clear Mobile Upload Options: 1. CAMERA, 2. GALLERY, 3. FILES */}
                    <div className="grid grid-cols-3 gap-2 mb-2.5">
                      {/* Option 1: CAMERA */}
                      <button
                        type="button"
                        onClick={() => cameraInputRef.current?.click()}
                        className={`p-3 rounded-[5px] bg-[#059669] hover:bg-[#047857] text-white flex flex-col items-center justify-center text-center gap-1.5 cursor-pointer transition-colors shadow-xs select-none ${
                          isLoadingFiles ? 'opacity-60 pointer-events-none' : ''
                        }`}
                      >
                        <div className="w-9 h-9 rounded-full bg-white/15 flex items-center justify-center">
                          <Camera className="w-4 h-4 text-white" />
                        </div>
                        <div>
                          <span className="block font-mono text-[11px] font-bold uppercase tracking-wider">
                            1. Camera
                          </span>
                          <span className="block text-[10px] text-emerald-100 leading-tight mt-0.5">
                            Capture new photo
                          </span>
                        </div>
                      </button>

                      {/* Option 2: GALLERY */}
                      <button
                        type="button"
                        onClick={() => galleryInputRef.current?.click()}
                        className={`p-3 rounded-[5px] bg-emerald-50/70 hover:bg-emerald-100/70 border-2 border-[#059669] text-[#18181B] flex flex-col items-center justify-center text-center gap-1.5 cursor-pointer transition-colors shadow-xs select-none ${
                          isLoadingFiles ? 'opacity-60 pointer-events-none' : ''
                        }`}
                      >
                        <div className="w-9 h-9 rounded-full bg-[#059669] text-white flex items-center justify-center shadow-2xs">
                          <Images className="w-4 h-4" />
                        </div>
                        <div>
                          <span className="block font-mono text-[11px] font-bold uppercase tracking-wider text-[#059669]">
                            2. Gallery
                          </span>
                          <span className="block text-[10px] text-zinc-600 leading-tight mt-0.5">
                            Choose from photo gallery
                          </span>
                        </div>
                      </button>

                      {/* Option 3: FILES */}
                      <button
                        type="button"
                        onClick={() => filesInputRef.current?.click()}
                        className={`p-3 rounded-[5px] bg-white hover:bg-zinc-50 border border-[#E4E3DE] hover:border-[#059669] text-[#18181B] flex flex-col items-center justify-center text-center gap-1.5 cursor-pointer transition-colors shadow-2xs select-none ${
                          isLoadingFiles ? 'opacity-60 pointer-events-none' : ''
                        }`}
                      >
                        <div className="w-9 h-9 rounded-full bg-zinc-100 border border-zinc-200 flex items-center justify-center">
                          <FolderOpen className="w-4 h-4 text-[#18181B]" />
                        </div>
                        <div>
                          <span className="block font-mono text-[11px] font-bold uppercase tracking-wider text-[#18181B]">
                            3. Files
                          </span>
                          <span className="block text-[10px] text-zinc-500 leading-tight mt-0.5">
                            PDFs, docs &amp; multi-files
                          </span>
                        </div>
                      </button>
                    </div>

                    {isLoadingFiles && (
                      <div className="py-3 px-3 mb-2 rounded-[4px] bg-emerald-50/70 border border-emerald-200 flex items-center gap-2.5 text-xs text-emerald-900">
                        <div className="w-4 h-4 rounded-full border-2 border-emerald-300 border-t-[#059669] animate-spin shrink-0" />
                        <span className="font-mono text-[11px]">
                          {loadingFileStatus || 'Staging selected files...'}
                        </span>
                      </div>
                    )}

                    {/* Staged / Selected Files Queue (Shown Before Processing — Requires Confirmation) */}
                    {capturedPages.length > 0 && (
                      <div className="pt-3 border-t border-[#E4E3DE] space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-bold text-[#18181B]">
                              Selected Files Ready ({capturedPages.length}{' '}
                              {capturedPages.length === 1 ? 'Page' : 'Pages'})
                            </span>
                            <span className="px-1.5 py-0.5 rounded-[3px] bg-amber-100 text-amber-800 font-mono text-[9px] font-semibold">
                              Awaiting Confirmation
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={handleClearAllPages}
                            className="text-[11px] font-medium text-red-600 hover:text-red-700 cursor-pointer"
                          >
                            Clear All
                          </button>
                        </div>

                        {/* Thumbnail & File Metadata Grid */}
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {capturedPages.map((page, idx) => (
                            <div
                              key={page.id}
                              className="relative group rounded-[4px] border border-[#E4E3DE] bg-zinc-50 overflow-hidden flex flex-col"
                            >
                              <div className="relative aspect-[4/3] bg-zinc-100 overflow-hidden">
                                <img
                                  src={page.dataUrl}
                                  alt={page.name || `Page ${idx + 1}`}
                                  className="w-full h-full object-cover"
                                />
                                <div className="absolute top-1 left-1 flex items-center gap-1 flex-wrap">
                                  <span className="px-1.5 py-0.5 bg-black/75 backdrop-blur-xs text-white font-mono text-[10px] rounded">
                                    P{idx + 1}
                                  </span>
                                  <span className="px-1.5 py-0.5 bg-[#059669]/90 text-white font-mono text-[9px] font-semibold rounded uppercase">
                                    {page.fileFormat || (page.sourceType === 'pdf' ? 'PDF' : 'IMG')}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleRemovePage(page.id)}
                                  className="absolute top-1 right-1 p-1 bg-red-600/90 text-white rounded hover:bg-red-700 cursor-pointer"
                                  title="Remove file"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                              <div className="px-2 py-1.5 bg-white border-t border-[#E4E3DE] flex items-center justify-between gap-1 text-[10px]">
                                <span
                                  className="font-medium text-[#18181B] truncate"
                                  title={page.name}
                                >
                                  {page.name}
                                </span>
                                {page.fileSize ? (
                                  <span className="font-mono text-[9px] text-zinc-400 shrink-0">
                                    {formatBytes(page.fileSize)}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          ))}
                        </div>

                        {/* Explicit User Confirmation Button to Start Processing */}
                        <button
                          type="button"
                          onClick={handleExtractPartsFromDocket}
                          className="w-full h-11 px-4 bg-[#18181B] hover:bg-zinc-800 text-white font-semibold text-xs tracking-wider uppercase rounded-[4px] flex items-center justify-center gap-2 cursor-pointer transition-colors shadow-sm"
                        >
                          <Check className="w-4 h-4 text-emerald-400 stroke-[2.5]" />
                          <span>
                            Confirm &amp; Compile Parts List ({capturedPages.length}{' '}
                            {capturedPages.length === 1 ? 'Page' : 'Pages'})
                          </span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (e) => reject(e);
    reader.readAsDataURL(file);
  });
}

function renderTextDocumentPreviewDataUrl(fileName: string, rawText: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 800;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#E4E3DE';
  ctx.lineWidth = 4;
  ctx.strokeRect(16, 16, canvas.width - 32, canvas.height - 32);

  ctx.fillStyle = '#059669';
  ctx.font = 'bold 20px monospace';
  ctx.fillText(`DOCUMENT: ${fileName.slice(0, 32)}`, 36, 56);

  ctx.fillStyle = '#18181B';
  ctx.font = '15px monospace';
  const lines = rawText.split(/\r?\n/).slice(0, 28);
  lines.forEach((line, idx) => {
    ctx.fillText(line.slice(0, 56), 36, 96 + idx * 24);
  });

  return canvas.toDataURL('image/jpeg', 0.85);
}
