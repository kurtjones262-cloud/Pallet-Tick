import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Camera,
  Images,
  FolderOpen,
  X,
  AlertCircle,
  Trash2,
  Sparkles,
  Check,
  ChevronDown,
  Clock,
  RefreshCw,
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
  DocketOfflineError,
  OcrProgressUpdate,
  PageTextHint,
} from '../utils/offlineOcr';
import {
  PendingDocketUpload,
  enqueuePendingDocketUpload,
  listPendingDocketUploads,
  removePendingDocketUpload,
  retryPendingDocketUpload,
  PENDING_DOCKET_QUEUE_UPDATED_EVENT,
} from '../utils/offlineDocketQueue';
import { isPdfFile, extractPagesFromPdfFile } from '../utils/pdfImport';
import { DocketOcrReviewModal } from './DocketOcrReviewModal';
import { apiNotifyDocketProcessing } from '../services/palletTrackApi';

interface NewDeliveryModalProps {
  onClose: () => void;
  onDeliveryCreated: (delivery: Delivery | Delivery[]) => void;
}

export type UploadOrigin = 'camera' | 'gallery' | 'files';

interface CapturedPage {
  id: string;
  sourceFileId: string;
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
  const isExtractingRef = useRef(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [ocrProgress, setOcrProgress] = useState<OcrProgressUpdate | null>(null);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [offlineQueueNotice, setOfflineQueueNotice] = useState<string | null>(null);
  const [reviewData, setReviewData] = useState<ExtractedDocketResult | null>(null);
  const [reviewQueueId, setReviewQueueId] = useState<string | undefined>(undefined);
  const [reviewSupplierRule, setReviewSupplierRule] = useState<SupplierRuleId | undefined>(undefined);
  const [reviewAttachedPages, setReviewAttachedPages] = useState<
    Array<{
      pageNumber: number;
      sourceFileId?: string;
      dataUrl: string;
      name?: string;
      textHint?: PageTextHint;
    }> | null
  >(null);
  const [pendingUploads, setPendingUploads] = useState<PendingDocketUpload[]>([]);

  useEffect(() => {
    if (!isProcessing) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const id = setInterval(() => {
      setElapsedSeconds(Math.max(1, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [isProcessing]);

  const refreshPendingUploads = useCallback(() => {
    listPendingDocketUploads()
      .then((items) => setPendingUploads(items))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshPendingUploads();
    window.addEventListener(PENDING_DOCKET_QUEUE_UPDATED_EVENT, refreshPendingUploads);
    return () => {
      window.removeEventListener(PENDING_DOCKET_QUEUE_UPDATED_EVENT, refreshPendingUploads);
    };
  }, [refreshPendingUploads]);

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

        const filePrefix =
          filesArray.length > 1 ? `(${i + 1}/${filesArray.length}) ` : '';

        const sourceFileId = `file_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`;

        // 1. Handle PDF documents
        if (isPdfFile(file)) {
          setLoadingFileStatus(`${filePrefix}Staging PDF "${file.name}"...`);
          try {
            const pdfPages = await extractPagesFromPdfFile(file, (curr, total) => {
              setLoadingFileStatus(
                `${filePrefix}Staging PDF "${file.name}" (Page ${curr} of ${total})...`
              );
            });
            for (const pdfPage of pdfPages) {
              newPages.push({
                id: `pdf_${Date.now()}_${i}_p${pdfPage.pageNumber}_${Math.random().toString(36).slice(2, 5)}`,
                sourceFileId,
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
          setLoadingFileStatus(
            `${filePrefix}Staging image "${file.name || `Photo ${i + 1}`}"...`
          );
          try {
            const prepared = await prepareColorImageForGemini(file, 2600, 0.92);
            newPages.push({
              id: `page_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
              sourceFileId,
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
                sourceFileId,
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
          setLoadingFileStatus(`${filePrefix}Staging document "${file.name}"...`);
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
              sourceFileId,
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
          const prepared = await prepareColorImageForGemini(file, 2600, 0.92);
          newPages.push({
            id: `file_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
            sourceFileId,
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
    if (capturedPages.length === 0 || isExtractingRef.current) return;
    isExtractingRef.current = true;

    setOcrError(null);
    setOfflineQueueNotice(null);

    const queueCurrentPagesOffline = async (reason?: string) => {
      const { record, deduplicated } = await enqueuePendingDocketUpload({
        supplierHint: selectedSupplierRule,
        pages: capturedPages.map((p) => ({
          id: p.id,
          sourceFileId: p.sourceFileId || p.id,
          dataUrl: p.dataUrl,
          name: p.name,
          sourceType: p.sourceType === 'pdf' ? 'pdf' : 'photo',
          fileSize: p.fileSize,
          fileFormat: p.fileFormat,
          textHint: p.textHint
            ? {
                rawText: p.textHint.rawText,
                hasSelectableText: p.textHint.hasSelectableText,
              }
            : undefined,
        })),
      });
      setIsProcessing(false);
      setCapturedPages([]);
      refreshPendingUploads();
      setOfflineQueueNotice(
        deduplicated
          ? `These docket pages are already queued offline (${record.pages.length} page${
              record.pages.length === 1 ? '' : 's'
            }). They will automatically extract with Gemini 4 Hydrogen when reconnected.`
          : reason ||
              `Offline mode: Saved ${record.pages.length} docket page${
                record.pages.length === 1 ? '' : 's'
              } locally to IndexedDB. They will automatically process with Gemini 4 Hydrogen once connectivity returns.`
      );
    };

    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        await queueCurrentPagesOffline();
        return;
      }

      setIsProcessing(true);
      setOcrProgress({
        currentPage: 1,
        totalPages: capturedPages.length,
        stage: 'preparing',
        percent: 5,
        statusText: 'Preparing docket for Gemini 4 Hydrogen Vision...',
      });

      apiNotifyDocketProcessing({
        fileName: capturedPages[0]?.name || 'Delivery Docket',
        fileCount: capturedPages.length,
        supplier: SUPPLIER_RULES[selectedSupplierRule]?.name,
        status: 'processing',
      }).catch(() => {});

      const imagesToProcess = capturedPages.map((p) => p.dataUrl);
      const pageTextHints = capturedPages.map((p) => p.textHint || {});
      const sourceFileIds = capturedPages.map((p) => p.sourceFileId || p.id);
      const output = await performSmartDocketExtraction(
        imagesToProcess,
        (update) => {
          setOcrProgress(update);
        },
        false,
        pageTextHints,
        {
          supplierHint: selectedSupplierRule,
          sourceFileIds,
        }
      );

      setIsProcessing(false);
      const detectedSupplier = output.extractedData.supplier;
      const resolvedSupplier =
        detectedSupplier &&
        detectedSupplier !== 'Laser Cutting Supplier' &&
        detectedSupplier !== 'Steel Processing Supplier'
          ? detectedSupplier
          : SUPPLIER_RULES[selectedSupplierRule].name;

      setReviewQueueId(undefined);
      setReviewSupplierRule(undefined);
      setReviewAttachedPages(null);
      setReviewData({
        ...output.extractedData,
        supplier: resolvedSupplier,
      });
    } catch (err: any) {
      console.error('Docket extraction error:', err);
      if (
        err instanceof DocketOfflineError ||
        (typeof navigator !== 'undefined' && navigator.onLine === false)
      ) {
        await queueCurrentPagesOffline(err?.message);
        return;
      }
      setIsProcessing(false);
      setOcrError(
        err?.message ||
          'Docket extraction failed. Ensure docket image or PDF is legible.'
      );
    } finally {
      isExtractingRef.current = false;
    }
  };

  const handleOpenQueuedForReview = (item: PendingDocketUpload) => {
    if (!item.extractedData) return;
    setReviewQueueId(item.id);
    setReviewSupplierRule(item.supplierHint);
    setReviewAttachedPages(
      item.pages.map((p, idx) => ({
        pageNumber: idx + 1,
        sourceFileId: p.sourceFileId,
        dataUrl: p.dataUrl,
        name: p.name,
        textHint: p.textHint,
      }))
    );
    setReviewData(item.extractedData);
  };

  return (
    <>
      {reviewData ? (
        <DocketOcrReviewModal
          extractedData={reviewData}
          initialSupplierRule={reviewSupplierRule || selectedSupplierRule}
          pendingQueueId={reviewQueueId}
          attachedPages={
            reviewAttachedPages ||
            capturedPages.map((p, idx) => ({
              pageNumber: idx + 1,
              sourceFileId: p.sourceFileId,
              dataUrl: p.dataUrl,
              name: p.name,
              textHint: p.textHint,
            }))
          }
          onClose={() => {
            setReviewData(null);
            setReviewQueueId(undefined);
            setReviewSupplierRule(undefined);
            setReviewAttachedPages(null);
          }}
          onDeliveryCreated={(newDels) => {
            refreshPendingUploads();
            onDeliveryCreated(newDels);
            onClose();
          }}
        />
      ) : (
        <div
          className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={onClose}
        >
          <div
            className="w-full max-w-lg bg-[var(--pt-bg-secondary,#101321)] border-t sm:border border-[var(--pt-border,#29243D)] rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden max-h-[92dvh] flex flex-col text-[var(--pt-text,#FFFFFF)]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-[var(--pt-border,#29243D)] flex items-center justify-between bg-[var(--pt-card,#15182A)] shrink-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-semibold text-sm text-[var(--pt-text,#FFFFFF)]">
                  Upload Invoice / Docket (Camera, Gallery or Files)
                </h3>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--pt-bg,#080B12)] text-[var(--pt-primary-light,#C084FC)] font-mono text-[10px] font-semibold border border-[var(--pt-border,#29243D)]">
                  <Sparkles className="w-2.5 h-2.5" />
                  <span>Gemini 4 Hydrogen Vision</span>
                </span>
              </div>
              <button
                onClick={onClose}
                className="p-1 text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[var(--pt-text,#FFFFFF)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* ============================================================ */}
            {/* DEDICATED HTML FILE INPUTS FOR MOBILE & DESKTOP              */}
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
            <input
              id="invoice-upload-gallery-input"
              ref={galleryInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/jpg,image/heic,image/*"
              multiple
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
                  <div className="w-10 h-10 rounded-full border-2 border-[var(--pt-border,#29243D)] border-t-[var(--pt-primary,#A020F0)] animate-spin mb-4 flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
                  </div>

                  <span className="text-[11px] font-mono uppercase tracking-widest text-[var(--pt-primary-light,#C084FC)] font-semibold mb-1">
                    Gemini 4 Hydrogen · Vision Extraction
                  </span>

                  <h4
                    className={`text-sm font-bold mb-1 ${
                      (ocrProgress?.statusText || '').toLowerCase().includes('retrying')
                        ? 'text-[#F59E0B] bg-[#F59E0B]/15 border border-[#F59E0B]/40 px-3 py-1 rounded-md'
                        : 'text-[var(--pt-text,#FFFFFF)]'
                    }`}
                  >
                    {ocrProgress?.statusText || 'Analyzing your delivery docket...'}
                  </h4>

                  <p className="text-xs text-[var(--pt-text-secondary,#A3A8BD)] max-w-xs leading-relaxed mb-5">
                    Reading high-resolution docket tables, part codes, revisions, and quantities with Gemini 4 Hydrogen Vision and automatic row verification.
                  </p>

                  {/* Progress Bar */}
                  <div className="w-full max-w-xs h-1.5 bg-[var(--pt-bg,#080B12)] rounded-full overflow-hidden mb-2 border border-[var(--pt-border,#29243D)]">
                    <div
                      className="h-full bg-[var(--pt-primary,#A020F0)] transition-all duration-300"
                      style={{ width: `${ocrProgress?.percent || 20}%` }}
                    />
                  </div>

                  <span className="font-mono text-xs text-[var(--pt-text-muted,#737B94)] tabular-nums">
                    {ocrProgress?.percent || 20}% complete · Page {ocrProgress?.currentPage || 1} of{' '}
                    {ocrProgress?.totalPages || 1} · {elapsedSeconds}s elapsed
                  </span>
                </div>
              ) : (
                <div className="divide-y divide-[var(--pt-border,#29243D)]">
                  {offlineQueueNotice && (
                    <div className="px-4 py-3 bg-[#00D979]/15 border-b border-[#00D979]/30 text-xs text-[#00D979] flex items-start gap-2">
                      <Clock className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{offlineQueueNotice}</span>
                    </div>
                  )}

                  {ocrError && (
                    <div className="px-4 py-3 bg-[#EF4444]/15 text-xs text-[#EF4444] space-y-2">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 text-[#EF4444] shrink-0 mt-0.5" />
                        <span>{ocrError}</span>
                      </div>
                      {capturedPages.length > 0 && (
                        <div className="flex items-center justify-between gap-2 pl-6 pt-1">
                          <span className="text-[11px] text-[#EF4444] font-mono">
                            Your {capturedPages.length} uploaded page(s) are preserved.
                          </span>
                          <button
                            type="button"
                            disabled={isProcessing}
                            onClick={handleExtractPartsFromDocket}
                            className="px-3 py-1.5 rounded-lg pt-btn-primary font-mono font-bold text-xs cursor-pointer shadow-2xs disabled:opacity-50"
                          >
                            Retry Extraction
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Offline Queued Dockets awaiting processing or manual review */}
                  {pendingUploads.length > 0 && (
                    <div className="p-4 bg-[var(--pt-bg-secondary,#101321)] space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.1em] text-[var(--pt-primary-light,#C084FC)]">
                          Queued Offline Dockets ({pendingUploads.length})
                        </span>
                      </div>
                      <div className="space-y-2">
                        {pendingUploads.map((item) => {
                          const statusLabel =
                            item.status === 'awaiting_manual_review'
                              ? 'Ready for Review'
                              : item.status === 'processing'
                              ? 'Processing (Gemini 4 Hydrogen)'
                              : item.status === 'recovering_rows'
                              ? 'Recovering Rows'
                              : item.status === 'failed'
                              ? 'Failed'
                              : 'Awaiting Processing (Offline)';
                          const badgeCls =
                            item.status === 'awaiting_manual_review'
                              ? 'bg-[#00D979]/15 text-[#00D979] border-[#00D979]/40'
                              : item.status === 'failed'
                              ? 'bg-[#EF4444]/15 text-[#EF4444] border-[#EF4444]/40'
                              : 'bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/40';

                          return (
                            <div
                              key={item.id}
                              className="p-2.5 rounded-xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] flex flex-col gap-2"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="text-xs font-semibold text-white truncate">
                                    {item.pages[0]?.name || 'Queued Docket'} ({item.pages.length}{' '}
                                    {item.pages.length === 1 ? 'page' : 'pages'})
                                  </div>
                                  <div className="text-[10px] font-mono text-[var(--pt-text-secondary,#A3A8BD)]">
                                    {SUPPLIER_RULES[item.supplierHint]?.name} ·{' '}
                                    {new Date(item.createdAt).toLocaleTimeString([], {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                    })}
                                  </div>
                                </div>
                                <span
                                  className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold border shrink-0 ${badgeCls}`}
                                >
                                  {statusLabel}
                                </span>
                              </div>
                              {item.errorMessage && (
                                <p className="text-[11px] text-[#EF4444] leading-snug">
                                  {item.errorMessage}
                                </p>
                              )}
                              <div className="flex items-center justify-end gap-2">
                                {item.status === 'awaiting_manual_review' && item.extractedData && (
                                  <button
                                    type="button"
                                    onClick={() => handleOpenQueuedForReview(item)}
                                    className="px-2.5 py-1 rounded-lg bg-[#059669] hover:bg-[#047857] text-white font-mono text-[10px] font-bold cursor-pointer"
                                  >
                                    Review &amp; Save
                                  </button>
                                )}
                                {item.status === 'failed' && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      retryPendingDocketUpload(item.id).catch(() => {});
                                    }}
                                    className="px-2.5 py-1 rounded-lg pt-btn-primary font-mono text-[10px] font-bold inline-flex items-center gap-1 cursor-pointer"
                                  >
                                    <RefreshCw className="w-3 h-3" />
                                    <span>Retry</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => {
                                    removePendingDocketUpload(item.id).catch(() => {});
                                  }}
                                  className="px-2 py-1 rounded-lg bg-black/30 hover:bg-red-950/60 text-zinc-300 hover:text-[#EF4444] font-mono text-[10px] cursor-pointer"
                                >
                                  Remove
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Step 1: Supplier Dropdown Menu */}
                  <div className="p-4 bg-[var(--pt-card,#15182A)]">
                    <div className="flex items-center justify-between mb-2">
                      <label
                        htmlFor="new-delivery-supplier-select"
                        className="text-[10px] font-mono font-semibold uppercase tracking-[0.1em] text-[var(--pt-text-secondary,#A3A8BD)]"
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
                        className="w-full h-10 pl-3 pr-9 rounded-xl bg-[var(--pt-input-bg,#080B12)] border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)] focus:border-[var(--pt-primary,#A020F0)] text-xs font-mono font-bold text-[var(--pt-text,#FFFFFF)] outline-none cursor-pointer appearance-none shadow-2xs transition-colors"
                      >
                        <option value="laser_central">Laser Central</option>
                        <option value="gci">GCI</option>
                        <option value="ocr_label">OCR Label Scanner</option>
                      </select>
                      <ChevronDown className="w-4 h-4 text-[var(--pt-text-secondary,#A3A8BD)] pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" />
                    </div>
                  </div>

                  {/* Step 2: 3-Option Mobile & Desktop Upload Selection Interface */}
                  <div
                    className="p-4 bg-[var(--pt-card,#15182A)]"
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onDrop={async (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!isLoadingFiles && e.dataTransfer?.files?.length) {
                        await handleFilesAdded(e.dataTransfer.files, 'files');
                      }
                    }}
                  >
                    <div className="flex items-center justify-between mb-2.5">
                      <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.1em] text-[var(--pt-text-secondary,#A3A8BD)]">
                        2. Upload Invoice / Docket (Multi-File Supported)
                      </span>
                      <span className="px-1.5 py-0.5 rounded-md bg-[var(--pt-bg,#080B12)] text-[var(--pt-primary-light,#C084FC)] border border-[var(--pt-border,#29243D)] font-mono text-[9px] font-semibold">
                        Select 1 or Multiple Files
                      </span>
                    </div>

                    <p className="text-xs text-[var(--pt-text-secondary,#A3A8BD)] mb-3 leading-relaxed">
                      Tap <span className="font-semibold text-[var(--pt-text,#FFFFFF)]">1. Camera</span> to capture photos,{' '}
                      <span className="font-semibold text-[var(--pt-primary-light,#C084FC)]">2. Gallery</span> to select multiple photos from your gallery (JPG, JPEG, PNG, WebP), or{' '}
                      <span className="font-semibold text-[var(--pt-text,#FFFFFF)]">3. Files</span> to select multiple PDFs, images, or documents at once.
                    </p>

                    {/* Three Clear Mobile Upload Options: 1. CAMERA, 2. GALLERY, 3. FILES */}
                    <div className="grid grid-cols-3 gap-2 mb-2.5">
                      {/* Option 1: CAMERA */}
                      <button
                        type="button"
                        onClick={() => cameraInputRef.current?.click()}
                        className={`p-3 rounded-xl pt-btn-primary flex flex-col items-center justify-center text-center gap-1.5 cursor-pointer transition-colors shadow-xs select-none ${
                          isLoadingFiles ? 'opacity-60 pointer-events-none' : ''
                        }`}
                      >
                        <div className="w-9 h-9 rounded-full bg-black/15 flex items-center justify-center">
                          <Camera className="w-4 h-4" />
                        </div>
                        <div>
                          <span className="block font-mono text-[11px] font-bold uppercase tracking-wider">
                            1. Camera
                          </span>
                          <span className="block text-[10px] opacity-85 leading-tight mt-0.5">
                            Capture new photo
                          </span>
                        </div>
                      </button>

                      {/* Option 2: GALLERY */}
                      <button
                        type="button"
                        onClick={() => galleryInputRef.current?.click()}
                        className={`p-3 rounded-xl bg-[var(--pt-bg,#080B12)] hover:bg-[var(--pt-hover-bg)] border-2 border-[var(--pt-primary,#A020F0)] text-[var(--pt-text,#FFFFFF)] flex flex-col items-center justify-center text-center gap-1.5 cursor-pointer transition-colors shadow-xs select-none ${
                          isLoadingFiles ? 'opacity-60 pointer-events-none' : ''
                        }`}
                      >
                        <div
                          className="w-9 h-9 rounded-full flex items-center justify-center shadow-2xs"
                          style={{
                            backgroundColor: 'var(--pt-primary)',
                            color: 'var(--pt-primary-contrast)',
                          }}
                        >
                          <Images className="w-4 h-4" />
                        </div>
                        <div>
                          <span className="block font-mono text-[11px] font-bold uppercase tracking-wider text-[var(--pt-primary-light,#C084FC)]">
                            2. Gallery
                          </span>
                          <span className="block text-[10px] text-[var(--pt-text-secondary,#A3A8BD)] leading-tight mt-0.5">
                            Select 1 or more photos
                          </span>
                        </div>
                      </button>

                      {/* Option 3: FILES */}
                      <button
                        type="button"
                        onClick={() => filesInputRef.current?.click()}
                        className={`p-3 rounded-xl bg-[var(--pt-bg,#080B12)] hover:bg-[var(--pt-hover-bg)] border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)] text-[var(--pt-text,#FFFFFF)] flex flex-col items-center justify-center text-center gap-1.5 cursor-pointer transition-colors shadow-2xs select-none ${
                          isLoadingFiles ? 'opacity-60 pointer-events-none' : ''
                        }`}
                      >
                        <div className="w-9 h-9 rounded-full bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] flex items-center justify-center">
                          <FolderOpen className="w-4 h-4 text-[var(--pt-text,#FFFFFF)]" />
                        </div>
                        <div>
                          <span className="block font-mono text-[11px] font-bold uppercase tracking-wider text-[var(--pt-text,#FFFFFF)]">
                            3. Files
                          </span>
                          <span className="block text-[10px] text-[var(--pt-text-secondary,#A3A8BD)] leading-tight mt-0.5">
                            Select multiple files
                          </span>
                        </div>
                      </button>
                    </div>

                    {isLoadingFiles && (
                      <div className="py-3 px-3 mb-2 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] flex items-center gap-2.5 text-xs text-[var(--pt-text,#FFFFFF)]">
                        <div className="w-4 h-4 rounded-full border-2 border-[var(--pt-border,#29243D)] border-t-[var(--pt-primary,#A020F0)] animate-spin shrink-0" />
                        <span className="font-mono text-[11px]">
                          {loadingFileStatus || 'Staging selected files...'}
                        </span>
                      </div>
                    )}

                    {/* Staged / Selected Files Queue */}
                    {capturedPages.length > 0 && (
                      <div className="pt-3 border-t border-[var(--pt-border,#29243D)] space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-bold text-[var(--pt-text,#FFFFFF)]">
                              Selected Files Ready ({capturedPages.length}{' '}
                              {capturedPages.length === 1 ? 'Page' : 'Pages'})
                            </span>
                            <span className="px-1.5 py-0.5 rounded bg-[#F59E0B]/15 text-[#F59E0B] border border-[#F59E0B]/40 font-mono text-[9px] font-semibold">
                              Awaiting Confirmation
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => galleryInputRef.current?.click()}
                              disabled={isLoadingFiles}
                              className="px-2 py-1 rounded-md bg-[var(--pt-bg,#080B12)] hover:bg-[var(--pt-hover-bg)] text-[var(--pt-primary-light,#C084FC)] border border-[var(--pt-border,#29243D)] text-[10px] font-mono font-semibold cursor-pointer"
                            >
                              + Add Photos
                            </button>
                            <button
                              type="button"
                              onClick={() => filesInputRef.current?.click()}
                              disabled={isLoadingFiles}
                              className="px-2 py-1 rounded-md bg-[var(--pt-bg,#080B12)] hover:bg-[var(--pt-hover-bg)] text-[var(--pt-text,#FFFFFF)] border border-[var(--pt-border,#29243D)] text-[10px] font-mono font-semibold cursor-pointer"
                            >
                              + Add Files
                            </button>
                            <button
                              type="button"
                              onClick={handleClearAllPages}
                              className="text-[11px] font-medium text-[#EF4444] hover:underline cursor-pointer ml-1"
                            >
                              Clear All
                            </button>
                          </div>
                        </div>

                        {/* Thumbnail & File Metadata Grid */}
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {capturedPages.map((page, idx) => (
                            <div
                              key={page.id}
                              className="relative group rounded-xl border border-[var(--pt-border,#29243D)] bg-[var(--pt-bg,#080B12)] overflow-hidden flex flex-col"
                            >
                              <div className="relative aspect-[4/3] bg-black/40 overflow-hidden">
                                <img
                                  src={page.dataUrl}
                                  alt={page.name || `Page ${idx + 1}`}
                                  className="w-full h-full object-cover"
                                />
                                <div className="absolute top-1 left-1 flex items-center gap-1 flex-wrap">
                                  <span className="px-1.5 py-0.5 bg-black/75 backdrop-blur-xs text-white font-mono text-[10px] rounded pt-keep-white">
                                    P{idx + 1}
                                  </span>
                                  <span
                                    className="px-1.5 py-0.5 font-mono text-[9px] font-semibold rounded uppercase"
                                    style={{
                                      backgroundColor: 'var(--pt-primary)',
                                      color: 'var(--pt-primary-contrast)',
                                    }}
                                  >
                                    {page.fileFormat || (page.sourceType === 'pdf' ? 'PDF' : 'IMG')}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleRemovePage(page.id)}
                                  className="absolute top-1 right-1 p-1 bg-red-600/90 text-white rounded hover:bg-red-700 cursor-pointer pt-keep-white"
                                  title="Remove file"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                              <div className="px-2 py-1.5 bg-[var(--pt-bg-secondary,#101321)] border-t border-[var(--pt-border,#29243D)] flex items-center justify-between gap-1 text-[10px]">
                                <span
                                  className="font-medium text-[var(--pt-text,#FFFFFF)] truncate"
                                  title={page.name}
                                >
                                  {page.name}
                                </span>
                                {page.fileSize ? (
                                  <span className="font-mono text-[9px] text-[var(--pt-text-muted,#737B94)] shrink-0">
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
                          disabled={isProcessing || capturedPages.length === 0}
                          onClick={handleExtractPartsFromDocket}
                          className="w-full h-11 px-4 pt-btn-primary font-mono font-bold text-xs tracking-wider uppercase rounded-xl flex items-center justify-center gap-2 cursor-pointer transition-colors shadow-sm disabled:opacity-50"
                        >
                          <Check className="w-4 h-4 stroke-[2.5]" />
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
