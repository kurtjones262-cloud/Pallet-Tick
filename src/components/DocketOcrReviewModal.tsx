import React, { useMemo, useRef, useState } from 'react';
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
  GitMerge,
  ShieldAlert,
} from 'lucide-react';
import { Delivery, DeliveryPart, DocketAttachment, SupplierRuleId } from '../types/delivery';
import {
  ExtractedDocketResult,
  ExtractedDocketItem,
  isGciExcludedNonPartItem,
} from '../server/docketOcr';
import {
  addDeliveryAuthoritative,
  getStoredDeliveries,
  setActiveDeliveryId,
  saveDocketImages,
  SUPPLIER_RULES,
} from '../utils/storage';
import { getStoredUser } from '../services/palletTrackApi';
import {
  performSmartDocketExtraction,
  PageTextHint,
} from '../utils/offlineOcr';
import { removePendingDocketUpload } from '../utils/offlineDocketQueue';

interface AttachedPage {
  pageNumber: number;
  sourceFileId?: string;
  dataUrl: string;
  name?: string;
  textHint?: PageTextHint;
}

interface DocketOcrReviewModalProps {
  extractedData: ExtractedDocketResult;
  initialSupplierRule?: SupplierRuleId;
  attachedPages?: AttachedPage[];
  pendingQueueId?: string;
  onClose: () => void;
  onDeliveryCreated: (delivery: Delivery | Delivery[]) => void;
}

interface DocketReviewDraft {
  draftId: string;
  docketNumber: string;
  supplierRule: SupplierRuleId;
  supplier: string;
  deliveryDate: string;
  carrier: string;
  palletCount: number;
  orderNumber: string;
  notes: string;
  separationUncertain: boolean;
  separationReason?: string;
  sourcePageNumbers: number[];
  missingRowNumbers: number[];
  validationFlags: string[];
  items: ExtractedDocketItem[];
}

function buildInitialDrafts(
  extractedData: ExtractedDocketResult,
  initialSupplierRule: SupplierRuleId,
  attachedPagesCount: number
): DocketReviewDraft[] {
  const sourceList =
    Array.isArray(extractedData.separatedDockets) && extractedData.separatedDockets.length > 0
      ? extractedData.separatedDockets
      : [extractedData];

  return sourceList.map((src, idx) => {
    const rule: SupplierRuleId = /\bgci\b/i.test(src.supplier || '')
      ? 'gci'
      : /\bocr\b/i.test(src.supplier || '')
      ? 'ocr_label'
      : initialSupplierRule;
    const defaultPages =
      Array.isArray(src.sourcePageNumbers) && src.sourcePageNumbers.length > 0
        ? src.sourcePageNumbers
        : attachedPagesCount > 0
        ? Array.from({ length: attachedPagesCount }, (_, i) => i + 1)
        : [1];

    const isGciMissingJobNo = rule === 'gci' && !String(src.docketNumber || '').trim();

    return {
      draftId: `draft_${idx}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      docketNumber: rule === 'gci' ? (src.docketNumber || '') : (src.docketNumber || `DK-${1001 + idx}`),
      supplierRule: rule,
      supplier:
        src.supplier &&
        src.supplier !== 'Laser Cutting Supplier' &&
        src.supplier !== 'Steel Processing Supplier'
          ? src.supplier
          : SUPPLIER_RULES[rule].name,
      deliveryDate: src.deliveryDate || new Date().toISOString().slice(0, 10),
      carrier: src.carrier || '',
      palletCount: src.palletCount || 1,
      orderNumber: src.orderNumber || '',
      notes: src.notes || '',
      separationUncertain: Boolean(src.separationUncertain) || isGciMissingJobNo,
      separationReason:
        src.separationReason ||
        (isGciMissingJobNo
          ? 'GCI Job No is missing or unreadable — enter the printed Job No into Docket / Ref # manually (Client Order No was not substituted).'
          : undefined),
      sourcePageNumbers: defaultPages,
      missingRowNumbers: Array.isArray(src.missingRowNumbers) ? src.missingRowNumbers : [],
      validationFlags: Array.from(
        new Set(
          [...(src.validationFlags || []), ...(src.validationWarnings || [])]
            .map((w) => String(w || '').trim())
            .filter(Boolean)
        )
      ),
      items: (src.items || [])
        .filter((it) => !(rule === 'gci' && isGciExcludedNonPartItem(it.partNumber, it.description)))
        .map((it) => ({
          ...it,
          originalOcrValues: it.originalOcrValues || {
            partNumber: it.partNumber,
            itemNumber: it.itemNumber,
            description: it.description,
            revision: it.rev || it.revision,
            quantity: Math.max(1, it.quantity || 1),
          },
        })),
    };
  });
}

export const DocketOcrReviewModal: React.FC<DocketOcrReviewModalProps> = ({
  extractedData,
  initialSupplierRule = 'laser_central',
  attachedPages = [],
  pendingQueueId,
  onClose,
  onDeliveryCreated,
}) => {
  const [drafts, setDrafts] = useState<DocketReviewDraft[]>(() =>
    buildInitialDrafts(extractedData, initialSupplierRule, attachedPages.length)
  );
  const [activeDraftIdx, setActiveDraftIdx] = useState(0);
  const safeDraftIdx = Math.min(activeDraftIdx, Math.max(0, drafts.length - 1));
  const activeDraft = drafts[safeDraftIdx];

  const [filterMode, setFilterMode] = useState<'all' | 'flagged'>('all');
  const [expandQuantities, setExpandQuantities] = useState(false);

  const [showPhotoViewer, setShowPhotoViewer] = useState(false);
  const [activePhotoIdx, setActivePhotoIdx] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const isSavingRef = useRef(false);

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
  const isRetryingRef = useRef(false);
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

  const existingStoredDockets = useMemo(() => {
    const existing = new Set<string>();
    for (const d of getStoredDeliveries()) {
      if (d.docketNumber) existing.add(d.docketNumber.trim().toUpperCase());
    }
    return existing;
  }, []);

  const updateActiveDraft = (updater: (draft: DocketReviewDraft) => DocketReviewDraft) => {
    setDrafts((prev) => prev.map((d, idx) => (idx === safeDraftIdx ? updater(d) : d)));
  };

  const getActorLabel = () => {
    const u = getStoredUser();
    return u ? `${u.employeeName} (${u.employeeCode})` : 'Workshop Operator';
  };

  const handleSelectSupplierRule = (ruleId: SupplierRuleId) => {
    updateActiveDraft((d) => ({
      ...d,
      supplierRule: ruleId,
      supplier: SUPPLIER_RULES[ruleId].name,
      items:
        ruleId === 'gci'
          ? d.items.filter((it) => !isGciExcludedNonPartItem(it.partNumber, it.description))
          : d.items,
    }));
  };

  const handleItemChange = (index: number, field: keyof ExtractedDocketItem, value: any) => {
    const actor = getActorLabel();
    const now = new Date().toISOString();
    updateActiveDraft((d) => {
      const next = [...d.items];
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
      return { ...d, items: next };
    });
  };

  const handleOpenAddPartModal = () => {
    setAddPartError(null);
    const maxItemNo = activeDraft.items.reduce((max, it, idx) => {
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
    const cleanItemNo =
      newPartDraft.itemNumber.trim() || String(activeDraft.items.length + 1);

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

    const nextLen = activeDraft.items.length + 1;
    updateActiveDraft((d) => ({ ...d, items: [...d.items, newItem] }));

    if (keepOpenForAnother) {
      const nextNo = parseInt(cleanItemNo.replace(/\D+/g, ''), 10);
      setNewPartDraft({
        itemNumber: Number.isNaN(nextNo) ? String(nextLen + 1) : String(nextNo + 1),
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
    const removeIdx = pendingDeleteIdx;
    updateActiveDraft((d) => ({
      ...d,
      items: d.items.filter((_, i) => i !== removeIdx),
    }));
    setPendingDeleteIdx(null);
  };

  const handleMergeWithPreviousDraft = () => {
    if (safeDraftIdx <= 0) return;
    setDrafts((prev) => {
      const current = prev[safeDraftIdx];
      const previous = prev[safeDraftIdx - 1];
      if (!current || !previous) return prev;
      const mergedPages = Array.from(
        new Set([...previous.sourcePageNumbers, ...current.sourcePageNumbers])
      ).sort((a, b) => a - b);
      const merged: DocketReviewDraft = {
        ...previous,
        sourcePageNumbers: mergedPages,
        missingRowNumbers: Array.from(
          new Set([...previous.missingRowNumbers, ...current.missingRowNumbers])
        ).sort((a, b) => a - b),
        validationFlags: Array.from(
          new Set([...previous.validationFlags, ...current.validationFlags])
        ),
        items: [...previous.items, ...current.items],
        palletCount: Math.max(previous.palletCount, current.palletCount),
        separationUncertain: false,
        separationReason: undefined,
      };
      const next = prev.filter((_, idx) => idx !== safeDraftIdx);
      next[safeDraftIdx - 1] = merged;
      return next;
    });
    setActiveDraftIdx(Math.max(0, safeDraftIdx - 1));
  };

  const handleRemoveDraft = (idxToRemove: number) => {
    if (drafts.length <= 1) return;
    setDrafts((prev) => prev.filter((_, i) => i !== idxToRemove));
    setActiveDraftIdx((prevIdx) => Math.max(0, Math.min(prevIdx, drafts.length - 2)));
  };

  const handleRerunOcrPreservingManualEdits = async () => {
    if (attachedPages.length === 0 || isRetryingOcr || isRetryingRef.current) return;
    isRetryingRef.current = true;
    setIsRetryingOcr(true);
    setRetryOcrError(null);
    setRetryOcrStatus('Re-running Gemini 4 Hydrogen extraction while preserving your manual edits...');

    try {
      const imagesToProcess = attachedPages.map((p) => p.dataUrl);
      const pageTextHints = attachedPages.map((p) => p.textHint || {});
      const sourceFileIds = attachedPages.map((p) => p.sourceFileId || `p_${p.pageNumber}`);
      const output = await performSmartDocketExtraction(
        imagesToProcess,
        (update) => {
          setRetryOcrStatus(update.statusText);
        },
        false,
        pageTextHints,
        {
          supplierHint: activeDraft.supplierRule,
          sourceFileIds,
          forceGemini: true,
        }
      );

      // Preserve any manual rows in current single active view if single-docket, else refresh drafts cleanly
      const rebuilt = buildInitialDrafts(
        output.extractedData,
        activeDraft.supplierRule,
        attachedPages.length
      );

      if (rebuilt.length === 1 && drafts.length === 1) {
        const freshItems = rebuilt[0].items;
        const manualRows = activeDraft.items.filter((it) => it.manuallyEdited);
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
          return fresh;
        });
        for (const remaining of manualByItemNo.values()) merged.push(remaining);
        for (const extra of extraManualRows) merged.push(extra);
        rebuilt[0].items = merged;
      }

      setDrafts(rebuilt);
      setActiveDraftIdx(0);
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
        err?.message ||
          'Docket OCR retry failed. Your existing parts and manual edits are preserved.'
      );
      setRetryOcrStatus(null);
    } finally {
      isRetryingRef.current = false;
      setIsRetryingOcr(false);
    }
  };

  const items = activeDraft.items;
  const totalExpandedParts = items.reduce((acc, it) => acc + Math.max(1, it.quantity || 1), 0);
  const lowConfidenceCount = items.filter((i) => i.confidence === 'low').length;
  const manuallyEditedCount = items.filter((i) => i.manuallyEdited).length;

  const filteredItems = items.filter((it) => {
    if (filterMode === 'flagged') return it.confidence === 'low';
    return true;
  });

  const duplicateInBatchSet = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of drafts) {
      const key = d.docketNumber.trim().toUpperCase();
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    const dups = new Set<string>();
    for (const [k, c] of counts.entries()) {
      if (c > 1) dups.add(k);
    }
    return dups;
  }, [drafts]);

  const activeDocketKey = activeDraft.docketNumber.trim().toUpperCase();
  const isDuplicateExisting = existingStoredDockets.has(activeDocketKey);
  const isDuplicateInBatch = duplicateInBatchSet.has(activeDocketKey);

  const handleConfirmImport = async () => {
    if (isSaving || isSavingRef.current) return;
    setRetryOcrError(null);

    // Validate all separated dockets before committing any
    const seenBatchDockets = new Set<string>();
    for (let dIdx = 0; dIdx < drafts.length; dIdx++) {
      const draft = drafts[dIdx];
      const cleanDk = draft.docketNumber.trim().toUpperCase();
      if (!cleanDk) {
        setActiveDraftIdx(dIdx);
        setRetryOcrError(`Docket ${dIdx + 1} is missing a Docket Number.`);
        return;
      }
      if (existingStoredDockets.has(cleanDk)) {
        setActiveDraftIdx(dIdx);
        setRetryOcrError(
          `Duplicate Docket # "${cleanDk}": This docket already exists in PalletTrack. Rename or delete the duplicate before saving.`
        );
        return;
      }
      if (seenBatchDockets.has(cleanDk)) {
        setActiveDraftIdx(dIdx);
        setRetryOcrError(
          `Duplicate Docket # "${cleanDk}" across uploaded tabs. Separate dockets must have unique docket numbers (or click "Merge with Previous" if they are pages of the same docket).`
        );
        return;
      }
      seenBatchDockets.add(cleanDk);

      if (draft.items.length === 0) {
        setActiveDraftIdx(dIdx);
        setRetryOcrError(`Docket "${cleanDk}" has 0 parts. Add at least one part or remove the empty tab.`);
        return;
      }
      for (let i = 0; i < draft.items.length; i++) {
        if (!String(draft.items[i].partNumber || '').trim()) {
          setActiveDraftIdx(dIdx);
          setRetryOcrError(
            `Docket "${cleanDk}", Row ${i + 1} is missing a Part Number.`
          );
          return;
        }
      }
    }

    isSavingRef.current = true;
    setIsSaving(true);
    const createdDeliveries: Delivery[] = [];
    try {
      for (let dIdx = 0; dIdx < drafts.length; dIdx++) {
        const draft = drafts[dIdx];
        const deliveryId = `del_${Date.now()}_${dIdx}_${Math.random().toString(36).slice(2, 6)}`;
        const finalParts: DeliveryPart[] = [];
        let lineIdx = 1;

        draft.items.forEach((it, rowIdx) => {
          if (draft.supplierRule === 'gci' && isGciExcludedNonPartItem(it.partNumber, it.description)) {
            return;
          }
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
              revision: it.rev?.trim() || it.revision?.trim() || undefined,
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

        const pageSet = new Set(draft.sourcePageNumbers);
        const draftPages = attachedPages.filter((p) => pageSet.has(p.pageNumber));
        const pagesForDocket = draftPages.length > 0 ? draftPages : attachedPages;

        const attachments: DocketAttachment[] = pagesForDocket.map((p, idx) => ({
          id: `att_${deliveryId}_${idx + 1}`,
          name: p.name || `docket_${draft.docketNumber}_p${p.pageNumber}.jpg`,
          uploadedAt: new Date().toISOString(),
          dataUrl: p.dataUrl,
        }));

        const newDelivery: Delivery = {
          id: deliveryId,
          docketNumber: draft.docketNumber.trim().toUpperCase(),
          supplier: draft.supplier.trim() || SUPPLIER_RULES[draft.supplierRule].name,
          supplierProfile: draft.supplierRule,
          deliveryDate: draft.deliveryDate,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          carrier: draft.carrier.trim() || undefined,
          orderNumber: draft.orderNumber.trim() || undefined,
          palletCount: draft.palletCount,
          notes: draft.notes.trim() || undefined,
          needsReview: draft.separationUncertain,
          separationReason: draft.separationReason,
          status: 'receiving',
          docketAttachments: attachments,
          parts: finalParts,
          unexpectedParts: [],
          scanHistory: [],
        };

        const persisted = await addDeliveryAuthoritative(newDelivery);
        if (pagesForDocket.length > 0) {
          await saveDocketImages(persisted.id, pagesForDocket);
        }
        createdDeliveries.push(persisted);
      }

      if (createdDeliveries.length > 0) {
        if (pendingQueueId) {
          await removePendingDocketUpload(pendingQueueId).catch(() => {});
        }
        setActiveDeliveryId(createdDeliveries[0].id);
        onDeliveryCreated(
          createdDeliveries.length === 1 ? createdDeliveries[0] : createdDeliveries
        );
      }
      onClose();
    } catch (err: any) {
      setRetryOcrError(
        err?.message || 'Failed to save one or more separated dockets. Please check docket numbers.'
      );
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4">
      <div className="pt-themed-modal w-full max-w-6xl h-[100dvh] sm:h-[92vh] bg-[var(--pt-bg-secondary,#101321)] sm:border border-[var(--pt-border,#29243D)] sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-[#E4E3DE] bg-white flex items-center justify-between gap-3 shrink-0">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-sm text-[#18181B]">
                {drafts.length > 1
                  ? `Separated Delivery Dockets (${drafts.length} Independent Dockets Detected)`
                  : `Compiled Docket Parts List (${items.length} Part Rows · ${totalExpandedParts} Total Quantities)`}
              </h3>
              <span className="font-mono text-[10px] font-semibold text-[#059669] bg-emerald-50 border border-emerald-200/80 px-2 py-0.5 rounded-[3px] inline-flex items-center gap-1">
                <Sparkles className="w-2.5 h-2.5 text-[#059669]" />
                <span>
                  {activeExtractionMeta.extractionEngineLabel ||
                    `Gemini Vision (${activeExtractionMeta.aiModelUsed || 'gemini-4-hydrogen'})`}
                </span>
              </span>
              {manuallyEditedCount > 0 && (
                <span className="font-mono text-[10px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-[3px]">
                  {manuallyEditedCount} Edited
                </span>
              )}
            </div>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              Each distinct docket number creates an independent delivery docket record. Review parts and metadata before saving.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {attachedPages.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={handleRerunOcrPreservingManualEdits}
                  disabled={isRetryingOcr}
                  className="h-7 px-2.5 rounded-[4px] text-xs font-medium bg-emerald-50 border border-emerald-200 text-[#059669] hover:bg-emerald-100 disabled:opacity-50 inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className={`w-3 h-3 ${isRetryingOcr ? 'animate-spin' : ''}`} />
                  <span className="hidden sm:inline">Re-run Gemini OCR</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowPhotoViewer(!showPhotoViewer)}
                  className={`h-7 px-2.5 rounded-[4px] text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer ${
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
            <button onClick={onClose} className="p-1 text-zinc-400 hover:text-[#18181B] cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Separated Dockets Tab Strip */}
        {drafts.length > 1 && (
          <div className="px-4 py-2 bg-[#F6F5F2] border-b border-[#E4E3DE] flex items-center justify-between gap-2 overflow-x-auto shrink-0">
            <div className="flex items-center gap-1.5">
              {drafts.map((d, idx) => {
                const isActive = idx === safeDraftIdx;
                const dKey = d.docketNumber.trim().toUpperCase();
                const hasIssue =
                  d.separationUncertain ||
                  existingStoredDockets.has(dKey) ||
                  duplicateInBatchSet.has(dKey);
                return (
                  <button
                    key={d.draftId}
                    type="button"
                    onClick={() => {
                      setActiveDraftIdx(idx);
                      if (d.sourcePageNumbers[0]) {
                        setActivePhotoIdx(Math.max(0, d.sourcePageNumbers[0] - 1));
                      }
                    }}
                    className={`px-2.5 py-1 rounded-[4px] text-xs font-mono font-bold flex items-center gap-1.5 border cursor-pointer transition-colors whitespace-nowrap ${
                      isActive
                        ? 'bg-[#18181B] text-white border-[#18181B]'
                        : 'bg-white text-zinc-700 border-[#E4E3DE] hover:border-zinc-400'
                    }`}
                  >
                    <FileText className="w-3 h-3" />
                    <span>{d.docketNumber || `Docket ${idx + 1}`}</span>
                    <span className="text-[10px] opacity-75">
                      ({d.items.length} parts · P{d.sourcePageNumbers.join(',')})
                    </span>
                    {hasIssue && <AlertTriangle className="w-3 h-3 text-amber-500" />}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {safeDraftIdx > 0 && (
                <button
                  type="button"
                  onClick={handleMergeWithPreviousDraft}
                  className="px-2 py-1 rounded-[4px] bg-white border border-amber-300 text-amber-800 hover:bg-amber-50 text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer"
                  title="Combine these pages with the previous docket if they actually belong to the same docket"
                >
                  <GitMerge className="w-3 h-3" />
                  <span>Merge with Prev</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => handleRemoveDraft(safeDraftIdx)}
                className="px-2 py-1 rounded-[4px] bg-white border border-red-200 text-red-600 hover:bg-red-50 text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer"
              >
                <Trash2 className="w-3 h-3" />
                <span>Drop Tab</span>
              </button>
            </div>
          </div>
        )}

        {/* Uncertain Separation / Duplicate Warning Banners */}
        {activeDraft.separationUncertain && (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-900 flex flex-wrap items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
              <span>
                <strong>Needs Review:</strong>{' '}
                {activeDraft.separationReason ||
                  'Page boundaries or docket number could not be separated with 100% certainty. Confirm docket number before saving.'}
              </span>
            </div>
            <button
              type="button"
              onClick={() =>
                updateActiveDraft((d) => ({
                  ...d,
                  separationUncertain: false,
                  separationReason: undefined,
                }))
              }
              className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white font-semibold text-[11px] cursor-pointer"
            >
              Mark Verified
            </button>
          </div>
        )}

        {(isDuplicateExisting || isDuplicateInBatch) && (
          <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700 flex items-center gap-2 shrink-0">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
            <span>
              <strong>Duplicate Docket Number:</strong>{' '}
              {isDuplicateExisting
                ? `Docket "${activeDocketKey}" already exists in PalletTrack. Rename the docket number or cancel to avoid duplicate docket creation.`
                : `Another separated tab already uses Docket "${activeDocketKey}". Use unique docket numbers or click "Merge with Prev".`}
            </span>
          </div>
        )}

        {(() => {
          const draftMissing =
            activeDraft.missingRowNumbers.length > 0
              ? activeDraft.missingRowNumbers
              : drafts.length === 1
              ? activeExtractionMeta.missingRowNumbers
              : [];
          const draftFlags =
            activeDraft.validationFlags.length > 0
              ? activeDraft.validationFlags
              : drafts.length === 1
              ? activeExtractionMeta.validationFlags
              : [];
          if (draftMissing.length === 0 && draftFlags.length === 0) return null;
          return (
            <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-900 flex items-center gap-2 shrink-0">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>
                <strong>Validation Notice:</strong>{' '}
                {draftFlags.length > 0
                  ? draftFlags.join(' · ')
                  : `Check row numbers ${draftMissing.join(', ')}`}
              </span>
            </div>
          );
        })()}

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
                <strong className="font-mono">{items[pendingDeleteIdx].partNumber}</strong>?
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

        {/* Content Area */}
        <div className="flex-1 flex overflow-hidden">
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
                    value={activeDraft.docketNumber}
                    placeholder={activeDraft.supplierRule === 'gci' ? 'Enter GCI Job No' : undefined}
                    onChange={(e) =>
                      updateActiveDraft((d) => ({ ...d, docketNumber: e.target.value }))
                    }
                    className={`w-full h-8 px-2.5 font-mono text-xs font-bold bg-white border rounded-[3px] text-[#18181B] uppercase outline-none ${
                      isDuplicateExisting || isDuplicateInBatch
                        ? 'border-red-500 focus:border-red-600'
                        : !activeDraft.docketNumber.trim()
                        ? 'border-amber-500 focus:border-amber-600'
                        : 'border-[#E4E3DE] focus:border-zinc-500'
                    }`}
                  />
                </div>

                <div>
                  <label className="text-[10px] font-mono uppercase text-zinc-400 block mb-1">
                    Supplier
                  </label>
                  <select
                    value={activeDraft.supplierRule}
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
                    value={activeDraft.orderNumber}
                    onChange={(e) =>
                      updateActiveDraft((d) => ({ ...d, orderNumber: e.target.value }))
                    }
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
                    value={activeDraft.deliveryDate}
                    onChange={(e) =>
                      updateActiveDraft((d) => ({ ...d, deliveryDate: e.target.value }))
                    }
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
                    value={activeDraft.palletCount}
                    onChange={(e) =>
                      updateActiveDraft((d) => ({
                        ...d,
                        palletCount: Math.max(1, parseInt(e.target.value, 10) || 1),
                      }))
                    }
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
                  className={`px-2.5 py-1 rounded-[3px] font-medium cursor-pointer ${
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
                    className={`px-2.5 py-1 rounded-[3px] font-medium flex items-center gap-1 cursor-pointer ${
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
                  <span>Expand multi-qty rows ({totalExpandedParts} pieces)</span>
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

            {showAddPartForm && (
              <form
                onSubmit={(e) => handleConfirmAddPart(e, false)}
                className="p-3.5 bg-emerald-50/70 border-b-2 border-[#059669] space-y-2.5 text-xs"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] font-bold uppercase text-[#059669]">
                    + Add Missing Part to Docket {activeDraft.docketNumber}
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
                    <label className="block text-[10px] font-mono uppercase text-zinc-600 mb-0.5">No</label>
                    <input
                      type="text"
                      value={newPartDraft.itemNumber}
                      onChange={(e) => setNewPartDraft((p) => ({ ...p, itemNumber: e.target.value }))}
                      className="w-full h-8 px-2 font-mono text-xs font-bold text-[#059669] bg-white border border-emerald-300 rounded-[3px] outline-none"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-[10px] font-mono uppercase text-zinc-800 font-bold mb-0.5">Part Number *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. PLT-2048"
                      value={newPartDraft.partNumber}
                      onChange={(e) => setNewPartDraft((p) => ({ ...p, partNumber: e.target.value }))}
                      className="w-full h-8 px-2 font-mono text-xs font-bold uppercase bg-white border border-emerald-300 rounded-[3px] outline-none"
                    />
                  </div>
                  <div className="col-span-2 sm:col-span-2">
                    <label className="block text-[10px] font-mono uppercase text-zinc-600 mb-0.5">Description</label>
                    <input
                      type="text"
                      placeholder="Part description"
                      value={newPartDraft.description}
                      onChange={(e) => setNewPartDraft((p) => ({ ...p, description: e.target.value }))}
                      className="w-full h-8 px-2 text-xs bg-white border border-emerald-300 rounded-[3px] outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-mono uppercase text-zinc-600 mb-0.5">Rev</label>
                    <input
                      type="text"
                      placeholder="e.g. A"
                      value={newPartDraft.rev}
                      onChange={(e) => setNewPartDraft((p) => ({ ...p, rev: e.target.value }))}
                      className="w-full h-8 px-2 font-mono text-xs uppercase bg-white border border-emerald-300 rounded-[3px] outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-mono uppercase text-zinc-800 font-bold mb-0.5">Qty *</label>
                    <input
                      type="number"
                      min="1"
                      required
                      value={newPartDraft.quantity}
                      onChange={(e) => setNewPartDraft((p) => ({ ...p, quantity: e.target.value }))}
                      className="w-full h-8 px-2 font-mono text-xs font-bold text-center bg-white border border-emerald-300 rounded-[3px] outline-none"
                    />
                  </div>
                  <div className="flex items-end gap-1.5">
                    <button type="submit" className="h-8 px-3 bg-[#059669] text-white font-bold rounded-[3px] cursor-pointer">
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleConfirmAddPart(e, true)}
                      className="h-8 px-2.5 bg-white border border-[#059669] text-[#059669] font-semibold rounded-[3px] cursor-pointer"
                    >
                      + Next
                    </button>
                  </div>
                </div>
              </form>
            )}

            {/* Parts Table */}
            <div className="flex-1 overflow-x-auto bg-white">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-[#F6F5F2] text-[10px] font-mono uppercase text-zinc-500 sticky top-0 border-b border-[#E4E3DE] z-10">
                  <tr>
                    <th className="py-2 px-2.5 w-20 text-center text-[#059669] font-bold">No</th>
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
                          isFlagged ? 'bg-amber-50/30' : item.manuallyEdited ? 'bg-blue-50/20' : ''
                        }`}
                      >
                        <td className="py-1.5 px-2 text-center">
                          <div className="flex items-center gap-1">
                            {attachedPages.length > 1 && item.pageNumber && (
                              <span className="px-1 py-0.5 rounded-[2px] bg-zinc-100 border border-zinc-200 font-mono text-[9px] text-zinc-500 shrink-0">
                                P{item.pageNumber}
                              </span>
                            )}
                            <input
                              type="text"
                              value={item.itemNumber}
                              onChange={(e) => handleItemChange(originalIdx, 'itemNumber', e.target.value)}
                              className="w-full h-7 px-1.5 text-center font-mono text-xs font-bold text-[#059669] bg-emerald-50/70 border border-emerald-200 rounded-[3px] outline-none"
                            />
                          </div>
                        </td>
                        <td className="py-1.5 px-2">
                          <input
                            type="text"
                            value={item.partNumber}
                            onChange={(e) => handleItemChange(originalIdx, 'partNumber', e.target.value)}
                            className={`w-full h-7 px-2 font-mono text-xs font-bold uppercase rounded-[3px] outline-none ${
                              isFlagged
                                ? 'bg-amber-50 border border-amber-300 text-amber-900'
                                : 'bg-transparent border border-transparent hover:border-[#E4E3DE] text-[#18181B]'
                            }`}
                          />
                        </td>
                        <td className="py-1.5 px-2">
                          <input
                            type="text"
                            value={item.description}
                            onChange={(e) => handleItemChange(originalIdx, 'description', e.target.value)}
                            className="w-full h-7 px-2 text-xs text-zinc-800 bg-transparent border border-transparent hover:border-[#E4E3DE] rounded-[3px] outline-none"
                          />
                        </td>
                        <td className="py-1.5 px-2 text-center">
                          <input
                            type="text"
                            value={item.rev || item.revision || ''}
                            placeholder="—"
                            onChange={(e) => handleItemChange(originalIdx, 'rev', e.target.value)}
                            className="w-full h-7 px-1.5 text-center font-mono text-xs uppercase text-zinc-700 bg-transparent border border-transparent hover:border-[#E4E3DE] rounded-[3px] outline-none"
                          />
                        </td>
                        <td className="py-1.5 px-2">
                          <input
                            type="text"
                            value={item.material || ''}
                            placeholder="—"
                            onChange={(e) => handleItemChange(originalIdx, 'material', e.target.value)}
                            className="w-full h-7 px-2 font-mono text-[11px] text-zinc-700 bg-transparent border border-transparent hover:border-[#E4E3DE] rounded-[3px] outline-none"
                          />
                        </td>
                        <td className="py-1.5 px-2">
                          <input
                            type="text"
                            value={item.thickness || ''}
                            placeholder="—"
                            onChange={(e) => handleItemChange(originalIdx, 'thickness', e.target.value)}
                            className="w-full h-7 px-2 font-mono text-[11px] text-zinc-700 bg-transparent border border-transparent hover:border-[#E4E3DE] rounded-[3px] outline-none"
                          />
                        </td>
                        <td className="py-1.5 px-2">
                          <input
                            type="text"
                            value={item.dimensions || item.weight || ''}
                            placeholder="—"
                            onChange={(e) => handleItemChange(originalIdx, 'dimensions', e.target.value)}
                            className="w-full h-7 px-2 font-mono text-[11px] text-zinc-600 bg-transparent border border-transparent hover:border-[#E4E3DE] rounded-[3px] outline-none"
                          />
                        </td>
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
                            className="w-14 h-7 px-1 text-center font-mono text-xs font-bold bg-zinc-50 border border-[#E4E3DE] rounded-[3px] outline-none"
                          />
                        </td>
                        <td className="py-1.5 px-2">
                          <input
                            type="text"
                            value={item.palletNumber || 'Pallet 1'}
                            onChange={(e) => handleItemChange(originalIdx, 'palletNumber', e.target.value)}
                            className="w-full h-7 px-2 font-mono text-[11px] text-zinc-500 bg-transparent border border-transparent hover:border-[#E4E3DE] rounded-[3px] outline-none"
                          />
                        </td>
                        <td className="py-1.5 px-2 text-center">
                          <button
                            type="button"
                            onClick={() => setPendingDeleteIdx(originalIdx)}
                            className="p-1 text-zinc-300 hover:text-red-600 cursor-pointer"
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
            </div>
          </div>

          {showPhotoViewer && attachedPages.length > 0 && (
            <div className="w-80 sm:w-96 border-l border-[#E4E3DE] bg-[#141413] flex flex-col shrink-0">
              <div className="px-3 py-2 bg-black/60 border-b border-white/10 flex items-center justify-between text-xs text-white">
                <span className="font-mono text-[11px]">
                  Page {Math.min(activePhotoIdx + 1, attachedPages.length)} of {attachedPages.length}
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
                  src={attachedPages[Math.min(activePhotoIdx, attachedPages.length - 1)].dataUrl}
                  alt={`Docket Page ${activePhotoIdx + 1}`}
                  className="max-w-full max-h-full object-contain rounded-[2px]"
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 bg-white border-t border-[#E4E3DE] flex items-center justify-between gap-3 shrink-0">
          <div className="text-xs text-zinc-500 font-mono">
            {drafts.length > 1 ? (
              <span>
                Saving <strong className="text-[#18181B]">{drafts.length}</strong> independent dockets · Active tab:{' '}
                <strong className="text-[#059669]">{items.length}</strong> rows
              </span>
            ) : (
              <span>
                <strong className="text-[#18181B]">{items.length}</strong> part rows ·{' '}
                <strong className="text-[#059669]">{totalExpandedParts}</strong> total quantities
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={isSaving}
              className="h-9 px-3.5 rounded-[4px] border border-[#E4E3DE] bg-white hover:bg-zinc-50 text-zinc-700 text-xs font-medium cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmImport}
              disabled={isSaving || items.length === 0 || isDuplicateExisting || isDuplicateInBatch}
              className="h-9 px-4 rounded-[4px] bg-[#059669] hover:bg-[#047857] disabled:opacity-50 text-white font-semibold text-xs flex items-center gap-1.5 cursor-pointer transition-colors shadow-xs"
            >
              <Check className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>
                {isSaving
                  ? 'Saving...'
                  : drafts.length > 1
                  ? `Save All ${drafts.length} Dockets`
                  : `Save & Open Docket (${expandQuantities ? totalExpandedParts : items.length} Parts)`}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
