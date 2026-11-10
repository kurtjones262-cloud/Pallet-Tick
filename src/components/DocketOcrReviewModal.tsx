import React, { useState } from 'react';
import {
  AlertTriangle,
  Plus,
  Trash2,
  X,
  Eye,
  EyeOff,
  Check,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  FileText,
  RefreshCw,
} from 'lucide-react';
import { Delivery, DeliveryPart, DocketAttachment, SupplierRuleId } from '../types/delivery';
import { ExtractedDocketResult, ExtractedDocketItem } from '../server/docketOcr';
import {
  updateDelivery,
  setActiveDeliveryId,
  saveDocketImages,
  SUPPLIER_RULES,
} from '../utils/storage';
import { getStoredUser } from '../services/palletTrackApi';
import {
  performSmartDocketExtraction,
  PageTextHint,
} from '../utils/offlineOcr';

interface AttachedPage {
  pageNumber: number;
  dataUrl: string;
  name?: string;
  textHint?: PageTextHint;
}

interface DocketOcrReviewModalProps {
  extractedData: ExtractedDocketResult;
  initialSupplierRule?: SupplierRuleId;
  attachedPages?: AttachedPage[];
  onClose: () => void;
  onDeliveryCreated: (delivery: Delivery) => void;
}

export const DocketOcrReviewModal: React.FC<DocketOcrReviewModalProps> = ({
  extractedData,
  initialSupplierRule = 'laser_central',
  attachedPages = [],
  onClose,
  onDeliveryCreated,
}) => {
  const [supplierRule, setSupplierRule] = useState<SupplierRuleId>(
    /\bgci\b/i.test(extractedData.supplier || '') ? 'gci' : initialSupplierRule
  );
  const [docketNumber, setDocketNumber] = useState(extractedData.docketNumber || 'DK-0001');
  const [supplier, setSupplier] = useState(
    extractedData.supplier &&
      extractedData.supplier !== 'Laser Cutting Supplier' &&
      extractedData.supplier !== 'Steel Processing Supplier'
      ? extractedData.supplier
      : SUPPLIER_RULES[initialSupplierRule].name
  );
  const [deliveryDate, setDeliveryDate] = useState(
    extractedData.deliveryDate || new Date().toISOString().slice(0, 10)
  );
  const [carrier, setCarrier] = useState(extractedData.carrier || '');
  const [palletCount, setPalletCount] = useState<number>(extractedData.palletCount || 1);
  const [orderNumber, setOrderNumber] = useState(extractedData.orderNumber || '');
  const [notes, setNotes] = useState(extractedData.notes || '');

  const [items, setItems] = useState<ExtractedDocketItem[]>(() =>
    (extractedData.items || []).map((it) => ({
      ...it,
      originalOcrValues: it.originalOcrValues || {
        partNumber: it.partNumber,
        itemNumber: it.itemNumber,
        description: it.description,
        revision: it.rev,
        quantity: Math.max(1, it.quantity || 1),
      },
    }))
  );
  const [filterMode, setFilterMode] = useState<'all' | 'flagged'>('all');
  const [expandQuantities, setExpandQuantities] = useState(false);

  const [showPhotoViewer, setShowPhotoViewer] = useState(false);
  const [activePhotoIdx, setActivePhotoIdx] = useState(0);

  // Add Part Modal State inside Review Screen
  const [showAddPartForm, setShowAddPartForm] = useState(false);
  const [newPartDraft, setNewPartDraft] = useState({
    itemNumber: '',
    partNumber: '',
    description: '',
    rev: '',
    quantity: '1',
    material: '',
    thickness: '',
    palletNumber: 'Pallet 1',
  });
  const [addPartError, setAddPartError] = useState<string | null>(null);

  // Delete Row Confirmation State
  const [pendingDeleteIdx, setPendingDeleteIdx] = useState<number | null>(null);

  // Re-run OCR State (preserving manual edits)
  const [isRetryingOcr, setIsRetryingOcr] = useState(false);
  const [retryOcrStatus, setRetryOcrStatus] = useState<string | null>(null);
  const [retryOcrError, setRetryOcrError] = useState<string | null>(null);
  const [activeExtractionMeta, setActiveExtractionMeta] = useState({
    extractionMethod: extractedData.extractionMethod,
    extractionEngineLabel: extractedData.extractionEngineLabel,
    aiModelUsed: extractedData.aiModelUsed,
    fallbackUsed: extractedData.fallbackUsed,
    geminiFallbackReason: extractedData.geminiFallbackReason,
    processingTimeMs: extractedData.processingTimeMs,
    pagesFromCache: extractedData.pagesFromCache,
    missingRowNumbers: extractedData.missingRowNumbers || [],
    validationFlags: extractedData.validationFlags || [],
  });

  const getActorLabel = () => {
    const u = getStoredUser();
    return u ? `${u.employeeName} (${u.employeeCode})` : 'Workshop Operator';
  };

  const handleSelectSupplierRule = (ruleId: SupplierRuleId) => {
    setSupplierRule(ruleId);
    setSupplier(SUPPLIER_RULES[ruleId].name);
  };

  const handleItemChange = (index: number, field: keyof ExtractedDocketItem, value: any) => {
    const actor = getActorLabel();
    const now = new Date().toISOString();
    setItems((prev) => {
      const next = [...prev];
      const current = next[index];
      const origOcr = current.originalOcrValues || {
        partNumber: current.partNumber,
        itemNumber: current.itemNumber,
        description: current.description,
        revision: current.rev,
        quantity: Math.max(1, current.quantity || 1),
      };
      next[index] = {
        ...current,
        [field]: value,
        manuallyEdited: true,
        lastEditedBy: actor,
        lastEditedAt: now,
        originalOcrValues: origOcr,
      };
      if (field === 'partNumber' || field === 'itemNumber') {
        next[index].confidence = 'high';
      }
      return next;
    });
  };

  const handleOpenAddPartModal = () => {
    setAddPartError(null);
    const maxItemNo = items.reduce((max, it, idx) => {
      const parsed = parseInt(String(it.itemNumber || '').replace(/\D+/g, ''), 10);
      return Number.isNaN(parsed) ? Math.max(max, idx + 1) : Math.max(max, parsed);
    }, 0);
    setNewPartDraft({
      itemNumber: String(maxItemNo + 1),
      partNumber: '',
      description: '',
      rev: '',
      quantity: '1',
      material: '',
      thickness: '',
      palletNumber: 'Pallet 1',
    });
    setShowAddPartForm(true);
  };

  const handleConfirmAddPart = (e: React.FormEvent, keepOpenForAnother = false) => {
    e.preventDefault();
    setAddPartError(null);

    const cleanPartNo = newPartDraft.partNumber.trim().toUpperCase();
    if (!cleanPartNo) {
      setAddPartError('Part Number is required.');
      return;
    }

    const parsedQty = parseInt(newPartDraft.quantity, 10);
    if (Number.isNaN(parsedQty) || parsedQty < 1) {
      setAddPartError('Quantity is required and must be at least 1.');
      return;
    }

    const actor = getActorLabel();
    const now = new Date().toISOString();
    const cleanItemNo = newPartDraft.itemNumber.trim() || String(items.length + 1);

    const newItem: ExtractedDocketItem = {
      partNumber: cleanPartNo,
      itemNumber: cleanItemNo,
      description: newPartDraft.description.trim() || `Part ${cleanPartNo}`,
      rev: newPartDraft.rev.trim() || undefined,
      material: newPartDraft.material.trim() || undefined,
      thickness: newPartDraft.thickness.trim() || undefined,
      dimensions: '',
      quantity: parsedQty,
      palletNumber: newPartDraft.palletNumber.trim() || 'Pallet 1',
      confidence: 'high',
      manuallyEdited: true,
      lastEditedBy: actor,
      lastEditedAt: now,
    };

    const updatedItems = [...items, newItem];
    setItems(updatedItems);

    if (keepOpenForAnother) {
      const nextNo = parseInt(cleanItemNo.replace(/\D+/g, ''), 10);
      setNewPartDraft({
        itemNumber: Number.isNaN(nextNo) ? String(updatedItems.length + 1) : String(nextNo + 1),
        partNumber: '',
        description: '',
        rev: '',
        quantity: '1',
        material: newPartDraft.material,
        thickness: newPartDraft.thickness,
        palletNumber: newPartDraft.palletNumber,
      });
    } else {
      setShowAddPartForm(false);
    }
  };

  const handleConfirmRemoveItem = () => {
    if (pendingDeleteIdx === null) return;
    setItems((prev) => prev.filter((_, i) => i !== pendingDeleteIdx));
    setPendingDeleteIdx(null);
  };

  /**
   * Re-runs docket extraction (Tesseract-first by default, or forced Gemini AI fallback)
   * on the attached docket pages while preserving any rows that were manually edited
   * or added by the user (`manuallyEdited: true`).
   */
  const handleRerunOcrPreservingManualEdits = async (forceGemini = false) => {
    if (attachedPages.length === 0 || isRetryingOcr) return;
    setIsRetryingOcr(true);
    setRetryOcrError(null);
    setRetryOcrStatus(
      forceGemini
        ? 'Running Gemini AI extraction while preserving your manual edits...'
        : 'Re-running Tesseract.js OCR while preserving your manual edits...'
    );

    try {
      const imagesToProcess = attachedPages.map((p) => p.dataUrl);
      const pageTextHints = attachedPages.map((p) => p.textHint || {});
      const output = await performSmartDocketExtraction(
        imagesToProcess,
        (update) => {
          setRetryOcrStatus(update.statusText);
        },
        false,
        pageTextHints,
        {
          supplierHint: supplierRule,
          forceGemini,
        }
      );

      const freshItems = output.extractedData.items || [];
      const manualRows = items.filter((it) => it.manuallyEdited);
      const manualByItemNo = new Map<string, ExtractedDocketItem>();
      const extraManualRows: ExtractedDocketItem[] = [];

      for (const m of manualRows) {
        const key = String(m.itemNumber || '').trim();
        if (key && !manualByItemNo.has(key)) {
          manualByItemNo.set(key, m);
        } else {
          extraManualRows.push(m);
        }
      }

      const merged: ExtractedDocketItem[] = freshItems.map((fresh) => {
        const key = String(fresh.itemNumber || '').trim();
        if (key && manualByItemNo.has(key)) {
          const preserved = manualByItemNo.get(key)!;
          manualByItemNo.delete(key);
          return preserved;
        }
        return {
          ...fresh,
          originalOcrValues: {
            partNumber: fresh.partNumber,
            itemNumber: fresh.itemNumber,
            description: fresh.description,
            revision: fresh.rev,
            quantity: Math.max(1, fresh.quantity || 1),
          },
        };
      });

      // Append any remaining manually added rows that didn't match an OCR item number
      for (const remainingManual of manualByItemNo.values()) {
        merged.push(remainingManual);
      }
      for (const extra of extraManualRows) {
        merged.push(extra);
      }

      setItems(merged);
      setActiveExtractionMeta({
        extractionMethod: output.extractedData.extractionMethod,
        extractionEngineLabel: output.extractedData.extractionEngineLabel,
        aiModelUsed: output.extractedData.aiModelUsed,
        fallbackUsed: output.extractedData.fallbackUsed,
        geminiFallbackReason: output.extractedData.geminiFallbackReason,
        processingTimeMs: output.extractedData.processingTimeMs,
        pagesFromCache: output.extractedData.pagesFromCache,
        missingRowNumbers: output.extractedData.missingRowNumbers || [],
        validationFlags: output.extractedData.validationFlags || [],
      });
      setRetryOcrStatus(null);
    } catch (err: any) {
      setRetryOcrError(
        err?.message || 'Docket OCR retry failed. Your existing parts and manual edits are preserved.'
      );
      setRetryOcrStatus(null);
    } finally {
      setIsRetryingOcr(false);
    }
  };

  const totalExpandedParts = items.reduce((acc, it) => acc + Math.max(1, it.quantity || 1), 0);
  const lowConfidenceCount = items.filter((i) => i.confidence === 'low').length;
  const manuallyEditedCount = items.filter((i) => i.manuallyEdited).length;

  const filteredItems = items.filter((it) => {
    if (filterMode === 'flagged') return it.confidence === 'low';
    return true;
  });

  const handleConfirmImport = async () => {
    // Validate required fields before importing
    for (let i = 0; i < items.length; i++) {
      const row = items[i];
      if (!String(row.partNumber || '').trim()) {
        setRetryOcrError(`Row ${i + 1} (No. ${row.itemNumber || i + 1}) is missing a Part Number.`);
        return;
      }
    }

    const deliveryId = `del_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const finalParts: DeliveryPart[] = [];
    let lineIdx = 1;

    items.forEach((it, rowIdx) => {
      const qty = expandQuantities ? Math.max(1, it.quantity || 1) : 1;
      const isMultiple = qty > 1;
      const cleanDocketNo =
        it.itemNumber.trim().replace(/^(?:ITM|LINE|POS|NO\.?)\s*[-:]?\s*0*/i, '') ||
        String(rowIdx + 1);

      for (let q = 1; q <= qty; q++) {
        finalParts.push({
          id: `part_${deliveryId}_${lineIdx}`,
          docketLineIndex: rowIdx + 1,
          partNumber: it.partNumber.trim().toUpperCase(),
          itemNumber: cleanDocketNo.toUpperCase(),
          description: isMultiple
            ? `${it.description} (Piece ${q} of ${qty})`
            : it.description,
          revision: it.rev?.trim() || undefined,
          material: it.material?.trim() || undefined,
          thickness: it.thickness?.trim() || undefined,
          dimensions: it.dimensions?.trim() || undefined,
          weight: it.weight?.trim() || undefined,
          quantity: expandQuantities ? 1 : Math.max(1, it.quantity || 1),
          palletNumber: it.palletNumber || `Pallet 1`,
          status: 'outstanding',
          ocrConfidence: it.confidence,
          flaggedForReview: it.confidence === 'low',
          notes: it.notes,
          manuallyEdited: Boolean(it.manuallyEdited),
          lastEditedBy: it.lastEditedBy,
          lastEditedAt: it.lastEditedAt,
          originalOcrValues: it.originalOcrValues || {
            partNumber: it.partNumber.trim().toUpperCase(),
            itemNumber: cleanDocketNo.toUpperCase(),
            description: it.description,
            revision: it.rev?.trim() || undefined,
            quantity: expandQuantities ? 1 : Math.max(1, it.quantity || 1),
          },
        });

        lineIdx++;
      }
    });

    const attachments: DocketAttachment[] = attachedPages.map((p, idx) => ({
      id: `att_${deliveryId}_${idx + 1}`,
      name: p.name || `docket_${docketNumber}_p${idx + 1}.jpg`,
      uploadedAt: new Date().toISOString(),
      dataUrl: p.dataUrl,
    }));

    const newDelivery: Delivery = {
      id: deliveryId,
      docketNumber: docketNumber.trim().toUpperCase(),
      supplier: supplier.trim() || SUPPLIER_RULES[supplierRule].name,
      supplierProfile: supplierRule,
      deliveryDate,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      carrier: carrier.trim() || undefined,
      orderNumber: orderNumber.trim() || undefined,
      palletCount,
      notes: notes.trim() || undefined,
      status: 'receiving',
      docketAttachments: attachments,
      parts: finalParts,
      unexpectedParts: [],
      scanHistory: [],
    };

    updateDelivery(newDelivery);
    setActiveDeliveryId(newDelivery.id);

    if (attachedPages.length > 0) {
      await saveDocketImages(newDelivery.id, attachedPages);
    }

    onDeliveryCreated(newDelivery);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-0 sm:p-4">
      <div className="w-full max-w-6xl h-[100dvh] sm:h-[92vh] bg-[#F6F5F2] sm:border border-[#E4E3DE] sm:rounded-[6px] shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-[#E4E3DE] bg-white flex items-center justify-between gap-3 shrink-0">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-sm text-[#18181B]">
                Compiled Docket Parts List ({items.length} Part Rows · {totalExpandedParts} Total Quantities)
              </h3>
              {activeExtractionMeta.extractionMethod === 'ai-vision' ? (
                <span className="font-mono text-[10px] font-semibold text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-[3px] inline-flex items-center gap-1">
                  <Sparkles className="w-2.5 h-2.5 text-amber-600" />
                  <span>
                    {activeExtractionMeta.extractionEngineLabel ||
                      `Gemini AI Fallback (${activeExtractionMeta.aiModelUsed || 'gemini-3.8-flash'})`}
                  </span>
                </span>
              ) : activeExtractionMeta.extractionMethod === 'pdf-text' ? (
                <span className="font-mono text-[10px] font-semibold text-[#059669] bg-emerald-50 border border-emerald-200/60 px-2 py-0.5 rounded-[3px] inline-flex items-center gap-1">
                  <FileText className="w-2.5 h-2.5" />
                  <span>
                    {activeExtractionMeta.extractionEngineLabel || 'Tesseract.js OCR + PDF Layout'}
                  </span>
                </span>
              ) : (
                <span className="font-mono text-[10px] font-semibold text-[#059669] bg-emerald-50 border border-emerald-200/60 px-2 py-0.5 rounded-[3px] inline-flex items-center gap-1">
                  <Check className="w-2.5 h-2.5" />
                  <span>{activeExtractionMeta.extractionEngineLabel || 'Tesseract.js OCR'}</span>
                </span>
              )}
              {typeof activeExtractionMeta.processingTimeMs === 'number' && (
                <span className="font-mono text-[10px] text-zinc-500 bg-zinc-100 border border-zinc-200 px-1.5 py-0.5 rounded-[3px]">
                  {activeExtractionMeta.processingTimeMs}ms
                  {activeExtractionMeta.pagesFromCache
                    ? ` · ${activeExtractionMeta.pagesFromCache} cached`
                    : ''}
                </span>
              )}
              {manuallyEditedCount > 0 && (
                <span className="font-mono text-[10px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-[3px]">
                  {manuallyEditedCount} Manually Edited / Added
                </span>
              )}
            </div>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              Edit any part row, add missing parts, or remove unwanted rows before saving the docket.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {attachedPages.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => handleRerunOcrPreservingManualEdits(false)}
                  disabled={isRetryingOcr}
                  className="h-7 px-2.5 rounded-[4px] text-xs font-medium bg-white border border-[#E4E3DE] text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                  title="Re-run Tesseract.js OCR extraction while preserving any rows you have manually edited or added"
                >
                  <RefreshCw className={`w-3 h-3 ${isRetryingOcr ? 'animate-spin text-[#059669]' : ''}`} />
                  <span className="hidden sm:inline">Re-run OCR (Keep Edits)</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleRerunOcrPreservingManualEdits(true)}
                  disabled={isRetryingOcr}
                  className="h-7 px-2.5 rounded-[4px] text-xs font-medium bg-emerald-50 border border-emerald-200 text-[#059669] hover:bg-emerald-100 disabled:opacity-50 inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                  title="Run Gemini AI fallback extraction while preserving any rows you have manually edited or added"
                >
                  <Sparkles className="w-3 h-3" />
                  <span className="hidden md:inline">Use Gemini AI (Keep Edits)</span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowPhotoViewer(!showPhotoViewer)}
                  className={`h-7 px-2.5 rounded-[4px] text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
                    showPhotoViewer
                      ? 'bg-[#18181B] text-white'
                      : 'bg-white border border-[#E4E3DE] text-zinc-700 hover:bg-zinc-50'
                  }`}
                >
                  {showPhotoViewer ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  <span>{showPhotoViewer ? 'Hide docket' : 'View docket'}</span>
                </button>
              </>
            )}

            <button
              onClick={onClose}
              className="p-1 text-zinc-400 hover:text-[#18181B] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Gemini Fallback Notice Banner */}
        {activeExtractionMeta.geminiFallbackReason && (
          <div className="px-4 py-2 bg-amber-50/90 border-b border-amber-200 text-xs text-amber-900 flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              <span>
                <strong>Gemini AI Fallback Used:</strong> {activeExtractionMeta.geminiFallbackReason}
              </span>
            </div>
          </div>
        )}

        {/* Missing Row Sequence Warning Banner */}
        {activeExtractionMeta.missingRowNumbers.length > 0 && (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-900 flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              <span>
                <strong>Sequence Check:</strong> Potential missing docket row number(s):{' '}
                <span className="font-mono font-bold">
                  {activeExtractionMeta.missingRowNumbers.map((n) => `#${n}`).join(', ')}
                </span>
                . Please verify against the docket or click <strong>+ Add Part</strong>.
              </span>
            </div>
          </div>
        )}

        {/* Status / Error Banners */}
        {retryOcrStatus && (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-900 flex items-center gap-2 shrink-0">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-600 shrink-0" />
            <span className="font-semibold">{retryOcrStatus}</span>
          </div>
        )}
        {retryOcrError && (
          <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700 flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-red-600 shrink-0" />
              <span>{retryOcrError}</span>
            </div>
            <button
              type="button"
              onClick={() => setRetryOcrError(null)}
              className="text-red-500 hover:text-red-800 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Delete Row Confirmation Banner */}
        {pendingDeleteIdx !== null && items[pendingDeleteIdx] && (
          <div className="px-4 py-2.5 bg-red-600 text-white flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
            <div className="flex items-center gap-2">
              <Trash2 className="w-4 h-4 shrink-0" />
              <span>
                Confirm delete part row <strong>No. {items[pendingDeleteIdx].itemNumber}</strong> —{' '}
                <strong className="font-mono">{items[pendingDeleteIdx].partNumber}</strong> (
                {items[pendingDeleteIdx].description}, Qty {items[pendingDeleteIdx].quantity})?
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPendingDeleteIdx(null)}
                className="h-7 px-2.5 rounded bg-white/15 hover:bg-white/25 text-white font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmRemoveItem}
                className="h-7 px-3 rounded bg-white text-red-700 font-bold cursor-pointer"
              >
                Confirm Delete
              </button>
            </div>
          </div>
        )}

        {/* Content Area: Table Review + Optional Side-by-Side Docket Photo */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left / Main Section: Metadata & Compiled Parts Table */}
          <div className="flex-1 flex flex-col overflow-y-auto">
            {/* Header Metadata Form */}
            <div className="p-3.5 bg-white border-b border-[#E4E3DE] space-y-2.5 text-xs">
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                <div>
                  <label className="text-[10px] font-mono uppercase text-zinc-400 block mb-1">
                    Docket / Ref #
                  </label>
                  <input
                    type="text"
                    value={docketNumber}
                    onChange={(e) => setDocketNumber(e.target.value)}
                    className="w-full h-8 px-2.5 font-mono text-xs font-bold bg-white border border-[#E4E3DE] focus:border-zinc-500 rounded-[3px] text-[#18181B] uppercase outline-none"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-mono uppercase text-zinc-400 block mb-1">
                    Supplier
                  </label>
                  <select
                    value={supplierRule}
                    onChange={(e) =>
                      handleSelectSupplierRule(e.target.value as SupplierRuleId)
                    }
                    className="w-full h-8 px-2.5 text-xs font-semibold bg-white border border-[#E4E3DE] focus:border-zinc-500 rounded-[3px] text-[#18181B] outline-none cursor-pointer"
                  >
                    <option value="laser_central">Laser Central</option>
                    <option value="gci">GCI</option>
                    <option value="ocr_label">OCR Label Scanner</option>
                  </select>
                </div>

                <div>
                  <label className="text-[10px] font-mono uppercase text-zinc-400 block mb-1">
                    PO / Order #
                  </label>
                  <input
                    type="text"
                    value={orderNumber}
                    onChange={(e) => setOrderNumber(e.target.value)}
                    placeholder="Optional"
                    className="w-full h-8 px-2.5 font-mono text-xs bg-white border border-[#E4E3DE] focus:border-zinc-500 rounded-[3px] text-[#18181B] uppercase outline-none"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-mono uppercase text-zinc-400 block mb-1">
                    Delivery Date
                  </label>
                  <input
                    type="date"
                    value={deliveryDate}
                    onChange={(e) => setDeliveryDate(e.target.value)}
                    className="w-full h-8 px-2.5 text-xs bg-white border border-[#E4E3DE] focus:border-zinc-500 rounded-[3px] text-[#18181B] outline-none"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-mono uppercase text-zinc-400 block mb-1">
                    Pallets / Packs
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={palletCount}
                    onChange={(e) => setPalletCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="w-full h-8 px-2.5 text-xs font-mono bg-white border border-[#E4E3DE] focus:border-zinc-500 rounded-[3px] text-[#18181B] outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Table Controls & Filter Bar */}
            <div className="px-4 py-2 bg-[#F6F5F2] border-b border-[#E4E3DE] flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setFilterMode('all')}
                  className={`px-2.5 py-1 rounded-[3px] font-medium transition-colors cursor-pointer ${
                    filterMode === 'all'
                      ? 'bg-[#18181B] text-white'
                      : 'bg-white border border-[#E4E3DE] text-zinc-600 hover:text-[#18181B]'
                  }`}
                >
                  All Part Rows ({items.length})
                </button>

                {lowConfidenceCount > 0 && (
                  <button
                    onClick={() => setFilterMode('flagged')}
                    className={`px-2.5 py-1 rounded-[3px] font-medium flex items-center gap-1 cursor-pointer transition-colors ${
                      filterMode === 'flagged'
                        ? 'bg-amber-600 text-white'
                        : 'bg-amber-50 border border-amber-200 text-amber-800'
                    }`}
                  >
                    <AlertTriangle className="w-3 h-3 text-amber-500" />
                    <span>Flagged ({lowConfidenceCount})</span>
                  </button>
                )}
              </div>

              <div className="flex items-center gap-3">
                <label className="inline-flex items-center gap-1.5 cursor-pointer text-[11px] text-zinc-600">
                  <input
                    type="checkbox"
                    checked={expandQuantities}
                    onChange={(e) => setExpandQuantities(e.target.checked)}
                    className="accent-[#059669] rounded-[2px]"
                  />
                  <span>Expand multi-qty rows into individual checkable pieces ({totalExpandedParts} total)</span>
                </label>

                <button
                  type="button"
                  onClick={handleOpenAddPartModal}
                  className="h-7 px-3 bg-[#059669] hover:bg-[#047857] text-white rounded-[4px] font-bold text-xs flex items-center gap-1 cursor-pointer shadow-2xs"
                >
                  <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                  <span>+ Add Part</span>
                </button>
              </div>
            </div>

            {/* Inline / Modal Add Part Form */}
            {showAddPartForm && (
              <form
                onSubmit={(e) => handleConfirmAddPart(e, false)}
                className="p-3.5 bg-emerald-50/70 border-b-2 border-[#059669] space-y-2.5 text-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] font-bold uppercase text-[#059669]">
                    + Add Missing Part to Docket
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowAddPartForm(false)}
                    className="text-zinc-500 hover:text-[#18181B] cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {addPartError && (
                  <div className="p-2 rounded bg-red-50 border border-red-200 text-red-700 font-medium">
                    {addPartError}
                  </div>
                )}

                <div className="grid grid-cols-2 sm:grid-cols-8 gap-2">
                  <div>
                    <label className="block text-[10px] font-mono uppercase text-zinc-600 mb-0.5">
                      No
                    </label>
                    <input
                      type="text"
                      value={newPartDraft.itemNumber}
                      onChange={(e) =>
                        setNewPartDraft((p) => ({ ...p, itemNumber: e.target.value }))
                      }
                      className="w-full h-8 px-2 font-mono text-xs font-bold text-[#059669] bg-white border border-emerald-300 rounded-[3px] outline-none"
                    />
                  </div>
                  <div className=" sm:col-span-2">
                    <label className="block text-[10px] font-mono uppercase text-zinc-800 font-bold mb-0.5">
                      Part Number *
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. PLT-2048"
                      value={newPartDraft.partNumber}
                      onChange={(e) =>
                        setNewPartDraft((p) => ({ ...p, partNumber: e.target.value }))
                      }
                      className="w-full h-8 px-2 font-mono text-xs font-bold uppercase bg-white border border-emerald-300 rounded-[3px] outline-none"
                    />
                  </div>
                  <div className="col-span-2 sm:col-span-2">
                    <label className="block text-[10px] font-mono uppercase text-zinc-600 mb-0.5">
                      Description
                    </label>
                    <input
                      type="text"
                      placeholder="Part description"
                      value={newPartDraft.description}
                      onChange={(e) =>
                        setNewPartDraft((p) => ({ ...p, description: e.target.value }))
                      }
                      className="w-full h-8 px-2 text-xs bg-white border border-emerald-300 rounded-[3px] outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-mono uppercase text-zinc-600 mb-0.5">
                      Rev
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. A"
                      value={newPartDraft.rev}
                      onChange={(e) =>
                        setNewPartDraft((p) => ({ ...p, rev: e.target.value }))
                      }
                      className="w-full h-8 px-2 font-mono text-xs uppercase bg-white border border-emerald-300 rounded-[3px] outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-mono uppercase text-zinc-800 font-bold mb-0.5">
                      Qty *
                    </label>
                    <input
                      type="number"
                      min="1"
                      required
                      value={newPartDraft.quantity}
                      onChange={(e) =>
                        setNewPartDraft((p) => ({ ...p, quantity: e.target.value }))
                      }
                      className="w-full h-8 px-2 font-mono text-xs font-bold text-center bg-white border border-emerald-300 rounded-[3px] outline-none"
                    />
                  </div>
                  <div className="flex items-end gap-1.5">
                    <button
                      type="submit"
                      className="h-8 px-3 bg-[#059669] hover:bg-[#047857] text-white font-bold rounded-[3px] cursor-pointer whitespace-nowrap"
                    >
                      Save Part
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleConfirmAddPart(e, true)}
                      className="h-8 px-2.5 bg-white border border-[#059669] text-[#059669] hover:bg-emerald-50 font-semibold rounded-[3px] cursor-pointer whitespace-nowrap"
                      title="Save this part and immediately add another"
                    >
                      + Next
                    </button>
                  </div>
                </div>
              </form>
            )}

            {/* Extracted Individual Parts Table with ALL Details */}
            <div className="flex-1 overflow-x-auto bg-white">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-[#F6F5F2] text-[10px] font-mono uppercase text-zinc-500 sticky top-0 border-b border-[#E4E3DE] z-10">
                  <tr>
                    <th
                      className="py-2 px-2.5 w-20 text-center text-[#059669] font-bold"
                      title="The 'No' column on the delivery docket (matched by the numbers after '-' in ######-No barcodes)"
                    >
                      No (######-No)
                    </th>
                    <th className="py-2 px-2.5 min-w-[130px]">Part #</th>
                    <th className="py-2 px-2.5 min-w-[190px]">Part Description</th>
                    <th className="py-2 px-2 w-16 text-center">Rev</th>
                    <th className="py-2 px-2 min-w-[90px]">Material</th>
                    <th className="py-2 px-2 w-20">Thickness</th>
                    <th className="py-2 px-2 min-w-[100px]">Size / Dim</th>
                    <th className="py-2 px-2 w-16 text-center">Qty</th>
                    <th className="py-2 px-2 w-24">Pallet</th>
                    <th className="py-2 px-2 w-10 text-center"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E4E3DE]">
                  {filteredItems.map((item) => {
                    const originalIdx = items.indexOf(item);
                    const isFlagged = item.confidence === 'low';

                    return (
                      <tr
                        key={originalIdx}
                        className={`hover:bg-zinc-50/80 transition-colors ${
                          isFlagged
                            ? 'bg-amber-50/30'
                            : item.manuallyEdited
                            ? 'bg-blue-50/20'
                            : ''
                        }`}
                      >
                        {/* Docket "No" Column */}
                        <td className="py-1.5 px-2 text-center">
                          <div className="flex items-center gap-1">
                            {attachedPages.length > 1 && item.pageNumber && (
                              <span
                                className="px-1 py-0.5 rounded-[2px] bg-zinc-100 border border-zinc-200 font-mono text-[9px] text-zinc-500 shrink-0"
                                title={`Extracted from Page ${item.pageNumber}`}
                              >
                                P{item.pageNumber}
                              </span>
                            )}
                            <input
                              type="text"
                              value={item.itemNumber}
                              onChange={(e) =>
                                handleItemChange(originalIdx, 'itemNumber', e.target.value)
                              }
                              title="Part 'No' on the delivery docket / invoice"
                              className="w-full h-7 px-1.5 text-center font-mono text-xs font-bold text-[#059669] bg-emerald-50/70 border border-emerald-200 hover:border-emerald-400 focus:border-[#059669] rounded-[3px] outline-none"
                            />
                          </div>
                        </td>

                        {/* Part Number */}
                        <td className="py-1.5 px-2">
                          <input
                            type="text"
                            value={item.partNumber}
                            onChange={(e) =>
                              handleItemChange(originalIdx, 'partNumber', e.target.value)
                            }
                            className={`w-full h-7 px-2 font-mono text-xs font-bold uppercase rounded-[3px] outline-none ${
                              isFlagged
                                ? 'bg-amber-50 border border-amber-300 text-amber-900 focus:border-amber-500'
                                : 'bg-transparent border border-transparent hover:border-[#E4E3DE] focus:border-zinc-400 text-[#18181B]'
                            }`}
                          />
                        </td>

                        {/* Description */}
                        <td className="py-1.5 px-2">
                          <input
                            type="text"
                            value={item.description}
                            onChange={(e) =>
                              handleItemChange(originalIdx, 'description', e.target.value)
                            }
                            className="w-full h-7 px-2 text-xs text-zinc-800 bg-transparent border border-transparent hover:border-[#E4E3DE] focus:border-zinc-400 rounded-[3px] outline-none"
                          />
                        </td>

                        {/* Revision (Rev) */}
                        <td className="py-1.5 px-2 text-center">
                          <input
                            type="text"
                            value={item.rev || ''}
                            placeholder="—"
                            onChange={(e) =>
                              handleItemChange(originalIdx, 'rev', e.target.value)
                            }
                            className="w-full h-7 px-1.5 text-center font-mono text-xs uppercase text-zinc-700 bg-transparent border border-transparent hover:border-[#E4E3DE] focus:border-zinc-400 rounded-[3px] outline-none"
                          />
                        </td>

                        {/* Material */}
                        <td className="py-1.5 px-2">
                          <input
                            type="text"
                            value={item.material || ''}
                            placeholder="—"
                            onChange={(e) =>
                              handleItemChange(originalIdx, 'material', e.target.value)
                            }
                            className="w-full h-7 px-2 font-mono text-[11px] text-zinc-700 bg-transparent border border-transparent hover:border-[#E4E3DE] focus:border-zinc-400 rounded-[3px] outline-none"
                          />
                        </td>

                        {/* Thickness */}
                        <td className="py-1.5 px-2">
                          <input
                            type="text"
                            value={item.thickness || ''}
                            placeholder="—"
                            onChange={(e) =>
                              handleItemChange(originalIdx, 'thickness', e.target.value)
                            }
                            className="w-full h-7 px-2 font-mono text-[11px] text-zinc-700 bg-transparent border border-transparent hover:border-[#E4E3DE] focus:border-zinc-400 rounded-[3px] outline-none"
                          />
                        </td>

                        {/* Dimensions / Weight */}
                        <td className="py-1.5 px-2">
                          <input
                            type="text"
                            value={item.dimensions || item.weight || ''}
                            placeholder="—"
                            onChange={(e) =>
                              handleItemChange(originalIdx, 'dimensions', e.target.value)
                            }
                            className="w-full h-7 px-2 font-mono text-[11px] text-zinc-600 bg-transparent border border-transparent hover:border-[#E4E3DE] focus:border-zinc-400 rounded-[3px] outline-none"
                          />
                        </td>

                        {/* Quantity */}
                        <td className="py-1.5 px-2 text-center">
                          <input
                            type="number"
                            min="1"
                            max="99999"
                            value={item.quantity}
                            onChange={(e) =>
                              handleItemChange(
                                originalIdx,
                                'quantity',
                                Math.max(1, parseInt(e.target.value, 10) || 1)
                              )
                            }
                            className="w-14 h-7 px-1 text-center font-mono text-xs font-bold bg-zinc-50 border border-[#E4E3DE] focus:border-zinc-500 rounded-[3px] outline-none"
                          />
                        </td>

                        {/* Pallet */}
                        <td className="py-1.5 px-2">
                          <input
                            type="text"
                            value={item.palletNumber || `Pallet 1`}
                            onChange={(e) =>
                              handleItemChange(originalIdx, 'palletNumber', e.target.value)
                            }
                            className="w-full h-7 px-2 font-mono text-[11px] text-zinc-500 bg-transparent border border-transparent hover:border-[#E4E3DE] focus:border-zinc-400 rounded-[3px] outline-none"
                          />
                        </td>

                        {/* Delete action with confirmation */}
                        <td className="py-1.5 px-2 text-center">
                          <button
                            type="button"
                            onClick={() => setPendingDeleteIdx(originalIdx)}
                            className="p-1 text-zinc-300 hover:text-red-600 transition-colors cursor-pointer"
                            title="Delete part row"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {filteredItems.length === 0 && (
                <div className="py-12 px-4 text-center text-xs text-zinc-500">
                  <p className="font-semibold text-[#18181B] mb-1">
                    No individual parts in this view
                  </p>
                  <p className="text-[11px] text-zinc-400 mb-3">
                    Click &quot;+ Add Part&quot; above to add parts manually or re-run OCR extraction.
                  </p>
                  <button
                    type="button"
                    onClick={handleOpenAddPartModal}
                    className="h-8 px-3 bg-[#059669] text-white rounded-[4px] font-bold text-xs inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>+ Add Part</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Right Section: Original Photographed Docket Image Viewer */}
          {showPhotoViewer && attachedPages.length > 0 && (
            <div className="w-80 sm:w-96 border-l border-[#E4E3DE] bg-[#141413] flex flex-col shrink-0">
              <div className="px-3 py-2 bg-black/60 border-b border-white/10 flex items-center justify-between text-xs text-white">
                <span className="font-mono text-[11px]">
                  Page {activePhotoIdx + 1} of {attachedPages.length}
                </span>

                <div className="flex items-center gap-1">
                  {attachedPages.length > 1 && (
                    <>
                      <button
                        onClick={() =>
                          setActivePhotoIdx((prev) =>
                            prev > 0 ? prev - 1 : attachedPages.length - 1
                          )
                        }
                        className="p-1 hover:bg-white/10 rounded cursor-pointer"
                        title="Previous page"
                      >
                        <ChevronLeft className="w-3.5 h-3.5 text-white" />
                      </button>
                      <button
                        onClick={() =>
                          setActivePhotoIdx((prev) =>
                            prev < attachedPages.length - 1 ? prev + 1 : 0
                          )
                        }
                        className="p-1 hover:bg-white/10 rounded cursor-pointer"
                        title="Next page"
                      >
                        <ChevronRight className="w-3.5 h-3.5 text-white" />
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => setShowPhotoViewer(false)}
                    className="p-1 hover:bg-white/10 rounded text-zinc-400 hover:text-white cursor-pointer ml-1"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-auto p-2 flex items-center justify-center">
                <img
                  src={attachedPages[activePhotoIdx].dataUrl}
                  alt={`Docket Page ${activePhotoIdx + 1}`}
                  className="max-w-full max-h-full object-contain rounded-[2px]"
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer Confirmation Bar */}
        <div className="px-4 py-3 bg-white border-t border-[#E4E3DE] flex items-center justify-between gap-3 shrink-0">
          <div className="text-xs text-zinc-500 font-mono">
            <span>
              <strong className="text-[#18181B]">{items.length}</strong> part rows
            </span>
            <span className="mx-1.5 text-zinc-300">·</span>
            <span className="font-semibold text-[#059669]">
              {totalExpandedParts} total quantities
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="h-9 px-3.5 rounded-[4px] border border-[#E4E3DE] bg-white hover:bg-zinc-50 text-zinc-700 text-xs font-medium cursor-pointer"
            >
              Cancel
            </button>

            <button
              onClick={handleConfirmImport}
              disabled={items.length === 0}
              className="h-9 px-4 rounded-[4px] bg-[#059669] hover:bg-[#047857] disabled:opacity-50 text-white font-semibold text-xs flex items-center gap-1.5 cursor-pointer transition-colors shadow-xs"
            >
              <Check className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>
                Save &amp; Open Scanner ({expandQuantities ? totalExpandedParts : items.length} Parts)
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
