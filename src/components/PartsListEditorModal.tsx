import React, { useState } from 'react';
import {
  Plus,
  Trash2,
  Edit3,
  AlertTriangle,
  Check,
  X,
  History,
  FileSpreadsheet,
} from 'lucide-react';
import { Delivery, DeliveryPart } from '../types/delivery';
import {
  addPartToDelivery,
  editPartInDelivery,
  deletePartFromDelivery,
  saveDeliveryPartsBatch,
  getPartVerificationState,
} from '../utils/storage';

export type PartsEditorMode =
  | { type: 'add' }
  | { type: 'edit-single'; part: DeliveryPart }
  | { type: 'delete-confirm'; part: DeliveryPart }
  | { type: 'bulk-edit' };

interface PartsListEditorModalProps {
  delivery: Delivery;
  mode: PartsEditorMode;
  onClose: () => void;
  onDeliveryUpdated: (updated: Delivery) => void;
}

interface NewPartDraft {
  key: string;
  itemNumber: string;
  partNumber: string;
  description: string;
  revision: string;
  quantity: string;
  material: string;
  thickness: string;
  palletNumber: string;
}

interface BulkEditRowDraft {
  key: string;
  id?: string;
  itemNumber: string;
  partNumber: string;
  description: string;
  revision: string;
  quantity: string;
  material: string;
  thickness: string;
  palletNumber: string;
  status?: 'outstanding' | 'received';
  receivedQuantity?: number;
  originalOcrValues?: DeliveryPart['originalOcrValues'];
  manuallyEdited?: boolean;
  lastEditedBy?: string;
  lastEditedAt?: string;
}

export const PartsListEditorModal: React.FC<PartsListEditorModalProps> = ({
  delivery,
  mode,
  onClose,
  onDeliveryUpdated,
}) => {
  const existingParts = delivery.parts || [];

  // Calculate next default item number
  const getNextItemNo = (offset = 0) => {
    const maxNo = existingParts.reduce((max, p, idx) => {
      const n = parseInt(String(p.itemNumber || '').replace(/\D+/g, ''), 10);
      return Number.isNaN(n) ? Math.max(max, idx + 1) : Math.max(max, n);
    }, 0);
    return String(maxNo + 1 + offset);
  };

  // ---------------------------------------------------------------------------
  // 1. State for ADD PART mode (supports adding one or multiple missing parts)
  // ---------------------------------------------------------------------------
  const [addDrafts, setAddDrafts] = useState<NewPartDraft[]>(() => [
    {
      key: `draft_${Date.now()}_0`,
      itemNumber: getNextItemNo(0),
      partNumber: '',
      description: '',
      revision: '',
      quantity: '1',
      material: '',
      thickness: '',
      palletNumber: 'Pallet 1',
    },
  ]);

  // ---------------------------------------------------------------------------
  // 2. State for EDIT SINGLE PART mode
  // ---------------------------------------------------------------------------
  const singleTarget = mode.type === 'edit-single' ? mode.part : null;
  const [singleForm, setSingleForm] = useState({
    itemNumber: singleTarget?.itemNumber || '1',
    partNumber: singleTarget?.partNumber || '',
    description: singleTarget?.description || '',
    revision: singleTarget?.revision || '',
    quantity: String(Math.max(1, singleTarget?.quantity ?? 1)),
    material: singleTarget?.material || '',
    thickness: singleTarget?.thickness || '',
    palletNumber: singleTarget?.palletNumber ? String(singleTarget.palletNumber) : 'Pallet 1',
  });
  const [acknowledgedSingleScanWarning, setAcknowledgedSingleScanWarning] = useState(false);

  // ---------------------------------------------------------------------------
  // 3. State for BULK / MULTI-ROW EDIT mode
  // ---------------------------------------------------------------------------
  const [bulkRows, setBulkRows] = useState<BulkEditRowDraft[]>(() =>
    existingParts.map((p, idx) => ({
      key: p.id || `row_${idx}`,
      id: p.id,
      itemNumber: p.itemNumber || String(idx + 1),
      partNumber: p.partNumber || '',
      description: p.description || '',
      revision: p.revision || '',
      quantity: String(Math.max(1, p.quantity ?? 1)),
      material: p.material || '',
      thickness: p.thickness || '',
      palletNumber: p.palletNumber ? String(p.palletNumber) : 'Pallet 1',
      status: p.status,
      receivedQuantity: p.receivedQuantity,
      originalOcrValues: p.originalOcrValues,
      manuallyEdited: p.manuallyEdited,
      lastEditedBy: p.lastEditedBy,
      lastEditedAt: p.lastEditedAt,
    }))
  );
  const [pendingBulkDeleteRow, setPendingBulkDeleteRow] = useState<BulkEditRowDraft | null>(null);
  const [acknowledgedBulkScanWarning, setAcknowledgedBulkScanWarning] = useState(false);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Helper to check if a part has already been scanned
  const isPartAlreadyScanned = (part?: {
    status?: 'outstanding' | 'received';
    receivedQuantity?: number;
  } | null): boolean => {
    if (!part) return false;
    return part.status === 'received' || (part.receivedQuantity ?? 0) > 0;
  };

  // ===========================================================================
  // HANDLERS: ADD PART(S)
  // ===========================================================================
  const handleAddDraftRow = () => {
    setErrorMsg(null);
    setAddDrafts((prev) => [
      ...prev,
      {
        key: `draft_${Date.now()}_${prev.length}`,
        itemNumber: getNextItemNo(prev.length),
        partNumber: '',
        description: '',
        revision: '',
        quantity: '1',
        material: '',
        thickness: '',
        palletNumber: 'Pallet 1',
      },
    ]);
  };

  const handleRemoveDraftRow = (key: string) => {
    if (addDrafts.length <= 1) return;
    setAddDrafts((prev) => prev.filter((d) => d.key !== key));
  };

  const handleUpdateDraft = (key: string, field: keyof NewPartDraft, value: string) => {
    setErrorMsg(null);
    setAddDrafts((prev) =>
      prev.map((d) => (d.key === key ? { ...d, [field]: value } : d))
    );
  };

  const handleSaveNewParts = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    // Validate required fields across all draft rows before saving
    for (let i = 0; i < addDrafts.length; i++) {
      const row = addDrafts[i];
      if (!row.partNumber.trim()) {
        setErrorMsg(
          addDrafts.length > 1
            ? `Row ${i + 1}: Part Number is required.`
            : 'Part Number is required.'
        );
        return;
      }
      const parsedQty = parseInt(row.quantity, 10);
      if (Number.isNaN(parsedQty) || parsedQty < 1) {
        setErrorMsg(
          addDrafts.length > 1
            ? `Row ${i + 1} (${row.partNumber.trim()}): Quantity must be at least 1.`
            : 'Quantity is required and must be at least 1.'
        );
        return;
      }
    }

    try {
      let latestDelivery: Delivery | null = delivery;
      for (const row of addDrafts) {
        latestDelivery = addPartToDelivery(delivery.id, {
          itemNumber: row.itemNumber.trim() || undefined,
          partNumber: row.partNumber.trim().toUpperCase(),
          description: row.description.trim() || `Part ${row.partNumber.trim().toUpperCase()}`,
          revision: row.revision.trim() || undefined,
          quantity: Math.max(1, parseInt(row.quantity, 10) || 1),
          material: row.material.trim() || undefined,
          thickness: row.thickness.trim() || undefined,
          palletNumber: row.palletNumber.trim() || 'Pallet 1',
        });
      }
      if (latestDelivery) {
        onDeliveryUpdated(latestDelivery);
      }
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to add part.');
    }
  };

  // ===========================================================================
  // HANDLERS: EDIT SINGLE PART
  // ===========================================================================
  const handleSaveSinglePart = (e: React.FormEvent) => {
    e.preventDefault();
    if (!singleTarget) return;
    setErrorMsg(null);

    const cleanPartNo = singleForm.partNumber.trim().toUpperCase();
    if (!cleanPartNo) {
      setErrorMsg('Part Number is required and cannot be empty.');
      return;
    }

    const parsedQty = parseInt(singleForm.quantity, 10);
    if (Number.isNaN(parsedQty) || parsedQty < 1) {
      setErrorMsg('Quantity must be a valid positive number (at least 1).');
      return;
    }

    const isScanned = isPartAlreadyScanned(singleTarget);
    const hasCriticalChange =
      cleanPartNo !== singleTarget.partNumber ||
      parsedQty !== Math.max(1, singleTarget.quantity ?? 1) ||
      singleForm.itemNumber.trim() !== singleTarget.itemNumber;

    if (isScanned && hasCriticalChange && !acknowledgedSingleScanWarning) {
      setAcknowledgedSingleScanWarning(true);
      setErrorMsg(
        'This part has already been scanned. Please review the warning below and click "Confirm & Save Scanned Part" to apply changes.'
      );
      return;
    }

    try {
      const updated = editPartInDelivery(delivery.id, singleTarget.id, {
        itemNumber: singleForm.itemNumber.trim() || singleTarget.itemNumber,
        partNumber: cleanPartNo,
        description: singleForm.description.trim() || `Part ${cleanPartNo}`,
        revision: singleForm.revision.trim(),
        quantity: parsedQty,
        material: singleForm.material.trim(),
        thickness: singleForm.thickness.trim(),
        palletNumber: singleForm.palletNumber.trim(),
      });
      if (updated) {
        onDeliveryUpdated(updated);
      }
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to save part changes.');
    }
  };

  // ===========================================================================
  // HANDLERS: DELETE PART CONFIRMATION
  // ===========================================================================
  const handleConfirmDeleteSingle = () => {
    if (mode.type !== 'delete-confirm') return;
    setErrorMsg(null);
    try {
      const updated = deletePartFromDelivery(delivery.id, mode.part.id);
      if (updated) {
        onDeliveryUpdated(updated);
      }
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to delete part.');
    }
  };

  // ===========================================================================
  // HANDLERS: BULK MULTI-ROW PARTS LIST EDITOR
  // ===========================================================================
  const handleBulkRowChange = (
    key: string,
    field: keyof BulkEditRowDraft,
    value: string
  ) => {
    setErrorMsg(null);
    setBulkRows((prev) =>
      prev.map((row) => (row.key === key ? { ...row, [field]: value } : row))
    );
  };

  const handleBulkAddPartRow = () => {
    setErrorMsg(null);
    const maxItem = bulkRows.reduce((max, r, idx) => {
      const n = parseInt(String(r.itemNumber || '').replace(/\D+/g, ''), 10);
      return Number.isNaN(n) ? Math.max(max, idx + 1) : Math.max(max, n);
    }, 0);

    const newRow: BulkEditRowDraft = {
      key: `new_bulk_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      itemNumber: String(maxItem + 1),
      partNumber: '',
      description: '',
      revision: '',
      quantity: '1',
      material: '',
      thickness: '',
      palletNumber: 'Pallet 1',
      status: 'outstanding',
      manuallyEdited: true,
    };
    setBulkRows((prev) => [...prev, newRow]);
  };

  const handleConfirmBulkRowDelete = () => {
    if (!pendingBulkDeleteRow) return;
    setBulkRows((prev) => prev.filter((r) => r.key !== pendingBulkDeleteRow.key));
    setPendingBulkDeleteRow(null);
  };

  // Check if any already-scanned part was modified or removed in bulk mode
  const getModifiedScannedPartsCount = (): number => {
    const existingById = new Map<string, DeliveryPart>(existingParts.map((p) => [p.id, p]));
    const currentIds = new Set(bulkRows.map((r) => r.id).filter(Boolean) as string[]);
    let affected = 0;

    for (const oldPart of existingParts) {
      if (isPartAlreadyScanned(oldPart) && !currentIds.has(oldPart.id)) {
        affected++;
      }
    }

    for (const row of bulkRows) {
      if (!row.id) continue;
      const orig = existingById.get(row.id);
      if (orig && isPartAlreadyScanned(orig)) {
        const cleanQty = parseInt(row.quantity, 10) || 1;
        if (
          row.partNumber.trim().toUpperCase() !== orig.partNumber ||
          cleanQty !== Math.max(1, orig.quantity ?? 1) ||
          row.itemNumber.trim() !== orig.itemNumber
        ) {
          affected++;
        }
      }
    }
    return affected;
  };

  const handleSaveBulkParts = () => {
    setErrorMsg(null);

    for (let i = 0; i < bulkRows.length; i++) {
      const r = bulkRows[i];
      if (!r.partNumber.trim()) {
        setErrorMsg(`Row ${i + 1} (No. ${r.itemNumber || i + 1}): Part Number is required.`);
        return;
      }
      const q = parseInt(r.quantity, 10);
      if (Number.isNaN(q) || q < 1) {
        setErrorMsg(`Row ${i + 1} (${r.partNumber}): Quantity must be at least 1.`);
        return;
      }
    }

    const modifiedScannedCount = getModifiedScannedPartsCount();
    if (modifiedScannedCount > 0 && !acknowledgedBulkScanWarning) {
      setAcknowledgedBulkScanWarning(true);
      setErrorMsg(
        `${modifiedScannedCount} already-scanned part(s) have been modified or removed. Please review the warning banner below and click "Confirm & Save All Changes" again.`
      );
      return;
    }

    try {
      const updated = saveDeliveryPartsBatch(
        delivery.id,
        bulkRows.map((r, idx) => ({
          id: r.id,
          itemNumber: r.itemNumber.trim() || String(idx + 1),
          docketLineIndex: idx + 1,
          partNumber: r.partNumber.trim().toUpperCase(),
          description: r.description.trim() || `Part ${r.partNumber.trim().toUpperCase()}`,
          revision: r.revision.trim() || undefined,
          quantity: Math.max(1, parseInt(r.quantity, 10) || 1),
          material: r.material.trim() || undefined,
          thickness: r.thickness.trim() || undefined,
          palletNumber: r.palletNumber.trim() || undefined,
        }))
      );
      if (updated) {
        onDeliveryUpdated(updated);
      }
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to save parts list changes.');
    }
  };

  // ===========================================================================
  // RENDER 1: DELETE CONFIRMATION MODAL
  // ===========================================================================
  if (mode.type === 'delete-confirm') {
    const part = mode.part;
    const isScanned = isPartAlreadyScanned(part);
    const vState = getPartVerificationState(part);

    return (
      <div
        className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
        onClick={onClose}
      >
        <div
          className="pt-themed-modal w-full max-w-md bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] rounded-2xl shadow-2xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-4 py-3 bg-red-600 text-white flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Trash2 className="w-4 h-4" />
              <h3 className="font-bold text-sm">Confirm Delete Part from Docket</h3>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-red-100 hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-4 space-y-3 text-xs text-[#18181B]">
            <p className="text-zinc-600 leading-relaxed">
              Are you sure you want to permanently remove this part row from Docket{' '}
              <span className="font-mono font-bold text-[#18181B]">#{delivery.docketNumber}</span>?
            </p>

            <div className="p-3 rounded-[5px] bg-[#F6F5F2] border border-[#E4E3DE] space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-mono font-bold text-sm text-[#18181B]">
                  {part.partNumber}
                </span>
                <span className="px-2 py-0.5 rounded bg-zinc-200 font-mono text-[10px] font-bold text-zinc-800">
                  No. {part.itemNumber}
                  {part.revision ? ` · Rev ${part.revision}` : ''}
                </span>
              </div>
              <p className="text-zinc-700 font-medium">{part.description}</p>
              <div className="text-[11px] font-mono text-zinc-500 pt-0.5">
                Required Qty: <strong className="text-[#18181B]">{vState.requiredQty}</strong>
                {part.palletNumber ? ` · ${part.palletNumber}` : ''}
              </div>
            </div>

            {isScanned && (
              <div className="p-3 rounded-[5px] bg-amber-50 border-2 border-amber-400 text-amber-950 space-y-1">
                <div className="flex items-center gap-1.5 font-bold text-amber-900">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>WARNING: Part Already Scanned ({vState.receivedQty}/{vState.requiredQty})</span>
                </div>
                <p className="text-[11px] leading-relaxed text-amber-800">
                  This part has already been scanned into this delivery. Deleting it will remove it
                  from the active checklist and adjust the delivery&apos;s total parts count, while
                  recording a deletion entry in the audit log.
                </p>
              </div>
            )}

            {errorMsg && (
              <div className="p-2.5 rounded bg-red-50 border border-red-200 text-red-700 font-medium">
                {errorMsg}
              </div>
            )}
          </div>

          <div className="px-4 py-3 bg-[#F6F5F2] border-t border-[#E4E3DE] flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-3.5 rounded-[4px] bg-white border border-[#E4E3DE] hover:bg-zinc-50 text-zinc-700 text-xs font-semibold cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmDeleteSingle}
              className="h-9 px-4 rounded-[4px] bg-red-600 hover:bg-red-700 text-white text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer shadow-xs"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{isScanned ? 'Confirm Delete Scanned Part' : 'Delete Part'}</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ===========================================================================
  // RENDER 2: ADD MISSING PART(S) MODAL
  // ===========================================================================
  if (mode.type === 'add') {
    const draftTotalQty = addDrafts.reduce(
      (sum, d) => sum + Math.max(0, parseInt(d.quantity, 10) || 0),
      0
    );

    return (
      <div
        className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
        onClick={onClose}
      >
        <form
          onSubmit={handleSaveNewParts}
          className="pt-themed-modal w-full max-w-2xl max-h-[92dvh] bg-[var(--pt-bg-secondary,#101321)] sm:border border-[var(--pt-border,#29243D)] rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-4 py-3 bg-white border-b border-[#E4E3DE] flex items-center justify-between shrink-0">
            <div>
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded bg-emerald-100 text-[#059669] flex items-center justify-center">
                  <Plus className="w-4 h-4 stroke-[2.5]" />
                </span>
                <h3 className="font-bold text-sm text-[#18181B]">
                  Add Missing Part(s) to Docket #{delivery.docketNumber}
                </h3>
              </div>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                Manually add parts missed by OCR or extra items delivered. Changes save directly to the database.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-zinc-400 hover:text-[#18181B] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {errorMsg && (
              <div className="p-3 rounded-[4px] bg-red-50 border border-red-200 text-xs text-red-700 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            {addDrafts.map((draft, idx) => (
              <div
                key={draft.key}
                className="p-3.5 rounded-[6px] bg-white border border-[#E4E3DE] shadow-2xs space-y-3"
              >
                <div className="flex items-center justify-between border-b border-[#E4E3DE] pb-2">
                  <span className="font-mono text-[11px] font-bold uppercase text-[#059669]">
                    New Part #{idx + 1}
                  </span>
                  {addDrafts.length > 1 && (
                    <button
                      type="button"
                      onClick={() => handleRemoveDraftRow(draft.key)}
                      className="text-[11px] text-red-600 hover:text-red-700 inline-flex items-center gap-1 cursor-pointer font-medium"
                    >
                      <Trash2 className="w-3 h-3" />
                      <span>Remove</span>
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-12 gap-2.5 text-xs">
                  <div className="col-span-3 sm:col-span-2">
                    <label className="block text-[10px] font-mono uppercase text-zinc-500 mb-1">
                      Docket No
                    </label>
                    <input
                      type="text"
                      value={draft.itemNumber}
                      onChange={(e) => handleUpdateDraft(draft.key, 'itemNumber', e.target.value)}
                      className="w-full h-9 px-2.5 font-mono text-xs font-bold text-[#059669] bg-emerald-50/50 border border-emerald-200 focus:border-[#059669] rounded-[4px] outline-none"
                    />
                  </div>

                  <div className="col-span-9 sm:col-span-5">
                    <label className="block text-[10px] font-mono uppercase text-zinc-700 font-bold mb-1">
                      Part Number <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. PLT-2048-A"
                      value={draft.partNumber}
                      onChange={(e) => handleUpdateDraft(draft.key, 'partNumber', e.target.value)}
                      className="w-full h-9 px-2.5 font-mono text-xs font-bold uppercase bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[4px] text-[#18181B] outline-none"
                    />
                  </div>

                  <div className="col-span-6 sm:col-span-2">
                    <label className="block text-[10px] font-mono uppercase text-zinc-500 mb-1">
                      Rev
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. A, B, 01"
                      value={draft.revision}
                      onChange={(e) => handleUpdateDraft(draft.key, 'revision', e.target.value)}
                      className="w-full h-9 px-2.5 font-mono text-xs uppercase bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[4px] text-[#18181B] outline-none"
                    />
                  </div>

                  <div className="col-span-6 sm:col-span-3">
                    <label className="block text-[10px] font-mono uppercase text-zinc-700 font-bold mb-1">
                      Quantity <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="number"
                      inputMode="numeric"
                      required
                      min="1"
                      max="99999"
                      value={draft.quantity}
                      onChange={(e) => handleUpdateDraft(draft.key, 'quantity', e.target.value)}
                      className="w-full h-9 px-2.5 font-mono text-xs font-bold text-center bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[4px] text-[#18181B] outline-none"
                    />
                  </div>

                  <div className="col-span-12 sm:col-span-6">
                    <label className="block text-[10px] font-mono uppercase text-zinc-500 mb-1">
                      Part Description
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Base Mounting Bracket 10mm"
                      value={draft.description}
                      onChange={(e) => handleUpdateDraft(draft.key, 'description', e.target.value)}
                      className="w-full h-9 px-2.5 text-xs bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[4px] text-[#18181B] outline-none"
                    />
                  </div>

                  <div className="col-span-4 sm:col-span-2">
                    <label className="block text-[10px] font-mono uppercase text-zinc-500 mb-1">
                      Material
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 250Gr"
                      value={draft.material}
                      onChange={(e) => handleUpdateDraft(draft.key, 'material', e.target.value)}
                      className="w-full h-9 px-2 font-mono text-xs bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[4px] text-[#18181B] outline-none"
                    />
                  </div>

                  <div className="col-span-4 sm:col-span-2">
                    <label className="block text-[10px] font-mono uppercase text-zinc-500 mb-1">
                      Thickness
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 10mm"
                      value={draft.thickness}
                      onChange={(e) => handleUpdateDraft(draft.key, 'thickness', e.target.value)}
                      className="w-full h-9 px-2 font-mono text-xs bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[4px] text-[#18181B] outline-none"
                    />
                  </div>

                  <div className="col-span-4 sm:col-span-2">
                    <label className="block text-[10px] font-mono uppercase text-zinc-500 mb-1">
                      Pallet
                    </label>
                    <input
                      type="text"
                      placeholder="Pallet 1"
                      value={draft.palletNumber}
                      onChange={(e) => handleUpdateDraft(draft.key, 'palletNumber', e.target.value)}
                      className="w-full h-9 px-2 font-mono text-xs bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[4px] text-[#18181B] outline-none"
                    />
                  </div>
                </div>
              </div>
            ))}

            <button
              type="button"
              onClick={handleAddDraftRow}
              className="w-full h-9 px-3 rounded-[5px] border border-dashed border-[#059669] bg-emerald-50/40 hover:bg-emerald-50 text-[#059669] font-semibold text-xs inline-flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
            >
              <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>+ Add Another Missing Part Row</span>
            </button>
          </div>

          {/* Footer */}
          <div className="px-4 py-3 bg-white border-t border-[#E4E3DE] flex items-center justify-between gap-3 shrink-0">
            <div className="text-xs font-mono text-zinc-500">
              Adding <strong className="text-[#18181B]">{addDrafts.length}</strong>{' '}
              {addDrafts.length === 1 ? 'part row' : 'part rows'} ·{' '}
              <strong className="text-[#059669]">{draftTotalQty}</strong> total qty
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-9 px-3.5 rounded-[4px] bg-white border border-[#E4E3DE] hover:bg-zinc-50 text-zinc-700 text-xs font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="h-9 px-4 rounded-[4px] bg-[#059669] hover:bg-[#047857] text-white text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer shadow-xs"
              >
                <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                <span>
                  Save {addDrafts.length === 1 ? 'Part' : `${addDrafts.length} Parts`}
                </span>
              </button>
            </div>
          </div>
        </form>
      </div>
    );
  }

  // ===========================================================================
  // RENDER 3: EDIT SINGLE PART MODAL
  // ===========================================================================
  if (mode.type === 'edit-single' && singleTarget) {
    const isScanned = isPartAlreadyScanned(singleTarget);
    const vState = getPartVerificationState(singleTarget);
    const origOcr = singleTarget.originalOcrValues;

    return (
      <div
        className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
        onClick={onClose}
      >
        <form
          onSubmit={handleSaveSinglePart}
          className="pt-themed-modal w-full max-w-lg max-h-[92dvh] bg-[var(--pt-bg-secondary,#101321)] sm:border border-[var(--pt-border,#29243D)] rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-4 py-3 bg-white border-b border-[#E4E3DE] flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded bg-zinc-100 text-[#18181B] flex items-center justify-center">
                <Edit3 className="w-3.5 h-3.5" />
              </span>
              <div>
                <h3 className="font-bold text-sm text-[#18181B]">
                  Edit Docket Part — {singleTarget.partNumber}
                </h3>
                <p className="text-[11px] text-zinc-500">
                  Docket #{delivery.docketNumber} · Line No. {singleTarget.itemNumber}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-zinc-400 hover:text-[#18181B] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 text-xs">
            {isScanned && (
              <div className="p-3 rounded-[5px] bg-amber-50 border-2 border-amber-400 text-amber-950 space-y-1">
                <div className="flex items-center gap-1.5 font-bold text-amber-900">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>
                    Scanned Part Warning (Received Qty: {vState.receivedQty}/{vState.requiredQty})
                  </span>
                </div>
                <p className="text-[11px] leading-relaxed text-amber-800">
                  This part has already been scanned. Updating the required quantity will
                  automatically recalculate its verification status ({vState.receivedQty} received vs
                  new required quantity) while preserving its scanned history.
                </p>
              </div>
            )}

            {origOcr && (
              <div className="p-2.5 rounded-[4px] bg-zinc-100 border border-[#E4E3DE] text-[11px] text-zinc-600 flex items-start gap-2">
                <History className="w-3.5 h-3.5 text-zinc-500 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-[#18181B]">Original OCR Values: </span>
                  <span className="font-mono">
                    No. {origOcr.itemNumber || singleTarget.itemNumber} · Part# {origOcr.partNumber}
                    {origOcr.revision ? ` · Rev ${origOcr.revision}` : ''} · Qty {origOcr.quantity}
                  </span>
                  <div className="text-zinc-500 truncate">
                    Desc: &quot;{origOcr.description}&quot;
                  </div>
                  {singleTarget.lastEditedBy && (
                    <div className="text-[10px] text-zinc-500 mt-0.5">
                      Last edited by <strong>{singleTarget.lastEditedBy}</strong>
                      {singleTarget.lastEditedAt
                        ? ` at ${new Date(singleTarget.lastEditedAt).toLocaleString()}`
                        : ''}
                    </div>
                  )}
                </div>
              </div>
            )}

            {errorMsg && (
              <div className="p-3 rounded-[4px] bg-red-50 border border-red-200 text-red-700 font-medium">
                {errorMsg}
              </div>
            )}

            <div className="p-3.5 rounded-[6px] bg-white border border-[#E4E3DE] grid grid-cols-12 gap-3">
              <div className="col-span-4">
                <label className="block text-[10px] font-mono uppercase text-zinc-500 mb-1">
                  Docket No
                </label>
                <input
                  type="text"
                  value={singleForm.itemNumber}
                  onChange={(e) => {
                    setErrorMsg(null);
                    setSingleForm((prev) => ({ ...prev, itemNumber: e.target.value }));
                  }}
                  className="w-full h-9 px-2.5 font-mono text-xs font-bold text-[#059669] bg-emerald-50/50 border border-emerald-200 focus:border-[#059669] rounded-[4px] outline-none"
                />
              </div>

              <div className="col-span-8">
                <label className="block text-[10px] font-mono uppercase text-zinc-700 font-bold mb-1">
                  Part Number <span className="text-red-600">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={singleForm.partNumber}
                  onChange={(e) => {
                    setErrorMsg(null);
                    setSingleForm((prev) => ({ ...prev, partNumber: e.target.value }));
                  }}
                  className="w-full h-9 px-2.5 font-mono text-xs font-bold uppercase bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[4px] text-[#18181B] outline-none"
                />
              </div>

              <div className="col-span-12">
                <label className="block text-[10px] font-mono uppercase text-zinc-500 mb-1">
                  Part Description
                </label>
                <input
                  type="text"
                  value={singleForm.description}
                  onChange={(e) => {
                    setErrorMsg(null);
                    setSingleForm((prev) => ({ ...prev, description: e.target.value }));
                  }}
                  className="w-full h-9 px-2.5 text-xs bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[4px] text-[#18181B] outline-none"
                />
              </div>

              <div className="col-span-6">
                <label className="block text-[10px] font-mono uppercase text-zinc-500 mb-1">
                  Revision (Rev)
                </label>
                <input
                  type="text"
                  placeholder="e.g. A, B, 01"
                  value={singleForm.revision}
                  onChange={(e) => {
                    setErrorMsg(null);
                    setSingleForm((prev) => ({ ...prev, revision: e.target.value }));
                  }}
                  className="w-full h-9 px-2.5 font-mono text-xs uppercase bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[4px] text-[#18181B] outline-none"
                />
              </div>

              <div className="col-span-6">
                <label className="block text-[10px] font-mono uppercase text-zinc-700 font-bold mb-1">
                  Required Quantity <span className="text-red-600">*</span>
                </label>
                <input
                  type="number"
                  inputMode="numeric"
                  required
                  min="1"
                  max="99999"
                  value={singleForm.quantity}
                  onChange={(e) => {
                    setErrorMsg(null);
                    setSingleForm((prev) => ({ ...prev, quantity: e.target.value }));
                  }}
                  className="w-full h-9 px-2.5 font-mono text-xs font-bold text-center bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[4px] text-[#18181B] outline-none"
                />
              </div>

              <div className="col-span-4">
                <label className="block text-[10px] font-mono uppercase text-zinc-500 mb-1">
                  Material
                </label>
                <input
                  type="text"
                  value={singleForm.material}
                  onChange={(e) =>
                    setSingleForm((prev) => ({ ...prev, material: e.target.value }))
                  }
                  className="w-full h-9 px-2 font-mono text-xs bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[4px] text-[#18181B] outline-none"
                />
              </div>

              <div className="col-span-4">
                <label className="block text-[10px] font-mono uppercase text-zinc-500 mb-1">
                  Thickness
                </label>
                <input
                  type="text"
                  value={singleForm.thickness}
                  onChange={(e) =>
                    setSingleForm((prev) => ({ ...prev, thickness: e.target.value }))
                  }
                  className="w-full h-9 px-2 font-mono text-xs bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[4px] text-[#18181B] outline-none"
                />
              </div>

              <div className="col-span-4">
                <label className="block text-[10px] font-mono uppercase text-zinc-500 mb-1">
                  Pallet
                </label>
                <input
                  type="text"
                  value={singleForm.palletNumber}
                  onChange={(e) =>
                    setSingleForm((prev) => ({ ...prev, palletNumber: e.target.value }))
                  }
                  className="w-full h-9 px-2 font-mono text-xs bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[4px] text-[#18181B] outline-none"
                />
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-4 py-3 bg-white border-t border-[#E4E3DE] flex items-center justify-end gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-3.5 rounded-[4px] bg-white border border-[#E4E3DE] hover:bg-zinc-50 text-zinc-700 text-xs font-semibold cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className={`h-9 px-4 rounded-[4px] text-white text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer shadow-xs ${
                acknowledgedSingleScanWarning
                  ? 'bg-amber-600 hover:bg-amber-700'
                  : 'bg-[#059669] hover:bg-[#047857]'
              }`}
            >
              <Check className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>
                {acknowledgedSingleScanWarning
                  ? 'Confirm & Save Scanned Part'
                  : 'Save Changes'}
              </span>
            </button>
          </div>
        </form>
      </div>
    );
  }

  // ===========================================================================
  // RENDER 4: BULK MULTI-ROW PARTS LIST EDITOR MODAL
  // ===========================================================================
  const totalPartRows = bulkRows.length;
  const totalQuantityPieces = bulkRows.reduce(
    (sum, r) => sum + Math.max(0, parseInt(r.quantity, 10) || 0),
    0
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="pt-themed-modal w-full max-w-6xl h-[100dvh] sm:h-[90vh] bg-[var(--pt-bg-secondary,#101321)] sm:border border-[var(--pt-border,#29243D)] sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 bg-white border-b border-[#E4E3DE] flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <FileSpreadsheet className="w-4 h-4 text-[#059669]" />
              <h3 className="font-bold text-sm text-[#18181B]">
                Edit Imported Parts List — Docket #{delivery.docketNumber}
              </h3>
              <span className="px-2 py-0.5 rounded bg-emerald-50 border border-emerald-200 font-mono text-[11px] font-bold text-[#059669]">
                {totalPartRows} Part Rows · {totalQuantityPieces} Total Qty
              </span>
            </div>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              Edit part numbers, descriptions, revisions, and quantities across multiple rows, add missing parts, or remove unwanted rows.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleBulkAddPartRow}
              className="h-8 px-3 rounded-[4px] bg-[#059669] hover:bg-[#047857] text-white font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer shadow-2xs"
            >
              <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>+ Add Part</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-zinc-400 hover:text-[#18181B] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Warning / Error Banner */}
        {errorMsg && (
          <div className="px-4 py-2.5 bg-red-50 border-b border-red-200 text-xs text-red-800 flex items-center gap-2 shrink-0">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
            <span className="font-medium">{errorMsg}</span>
          </div>
        )}

        {/* Inline Confirmation Banner when Deleting a Row in Bulk Editor */}
        {pendingBulkDeleteRow && (
          <div className="px-4 py-3 bg-red-600 text-white flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                Delete row <strong>No. {pendingBulkDeleteRow.itemNumber}</strong> —{' '}
                <strong className="font-mono">{pendingBulkDeleteRow.partNumber || 'Untitled'}</strong>{' '}
                (Qty {pendingBulkDeleteRow.quantity})?
                {isPartAlreadyScanned(pendingBulkDeleteRow) && (
                  <strong className="ml-1 underline">
                    WARNING: This part has already been scanned!
                  </strong>
                )}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPendingBulkDeleteRow(null)}
                className="h-7 px-2.5 rounded bg-white/15 hover:bg-white/25 text-white font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmBulkRowDelete}
                className="h-7 px-3 rounded bg-white text-red-700 font-bold cursor-pointer"
              >
                Confirm Delete Row
              </button>
            </div>
          </div>
        )}

        {/* Table Editor */}
        <div className="flex-1 overflow-auto bg-white">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-[#F6F5F2] text-[10px] font-mono uppercase text-zinc-500 sticky top-0 border-b border-[#E4E3DE] z-10">
              <tr>
                <th className="py-2 px-2 w-16 text-center text-[#059669] font-bold">No</th>
                <th className="py-2 px-2 min-w-[140px]">Part Number *</th>
                <th className="py-2 px-2 min-w-[200px]">Description</th>
                <th className="py-2 px-2 w-20 text-center">Rev</th>
                <th className="py-2 px-2 w-20 text-center">Qty *</th>
                <th className="py-2 px-2 w-24">Material</th>
                <th className="py-2 px-2 w-20">Thickness</th>
                <th className="py-2 px-2 w-24">Pallet</th>
                <th className="py-2 px-2 w-28 text-center">Status / Audit</th>
                <th className="py-2 px-2 w-12 text-center">Del</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E4E3DE]">
              {bulkRows.map((row) => {
                const isScanned = isPartAlreadyScanned(row);
                return (
                  <tr
                    key={row.key}
                    className={`hover:bg-zinc-50/90 transition-colors ${
                      isScanned ? 'bg-emerald-50/20' : ''
                    }`}
                  >
                    <td className="py-1.5 px-2">
                      <input
                        type="text"
                        value={row.itemNumber}
                        onChange={(e) =>
                          handleBulkRowChange(row.key, 'itemNumber', e.target.value)
                        }
                        className="w-full h-8 px-1.5 text-center font-mono text-xs font-bold text-[#059669] bg-emerald-50/70 border border-emerald-200 focus:border-[#059669] rounded-[3px] outline-none"
                      />
                    </td>
                    <td className="py-1.5 px-2">
                      <input
                        type="text"
                        required
                        placeholder="Required"
                        value={row.partNumber}
                        onChange={(e) =>
                          handleBulkRowChange(row.key, 'partNumber', e.target.value)
                        }
                        className="w-full h-8 px-2 font-mono text-xs font-bold uppercase bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[3px] text-[#18181B] outline-none"
                      />
                    </td>
                    <td className="py-1.5 px-2">
                      <input
                        type="text"
                        placeholder="Part description"
                        value={row.description}
                        onChange={(e) =>
                          handleBulkRowChange(row.key, 'description', e.target.value)
                        }
                        className="w-full h-8 px-2 text-xs bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[3px] text-[#18181B] outline-none"
                      />
                    </td>
                    <td className="py-1.5 px-2">
                      <input
                        type="text"
                        placeholder="—"
                        value={row.revision}
                        onChange={(e) =>
                          handleBulkRowChange(row.key, 'revision', e.target.value)
                        }
                        className="w-full h-8 px-1.5 text-center font-mono text-xs uppercase bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[3px] text-[#18181B] outline-none"
                      />
                    </td>
                    <td className="py-1.5 px-2">
                      <input
                        type="number"
                        inputMode="numeric"
                        min="1"
                        max="99999"
                        value={row.quantity}
                        onChange={(e) =>
                          handleBulkRowChange(row.key, 'quantity', e.target.value)
                        }
                        className="w-full h-8 px-1.5 text-center font-mono text-xs font-bold bg-zinc-50 border border-[#E4E3DE] focus:border-[#059669] rounded-[3px] text-[#18181B] outline-none"
                      />
                    </td>
                    <td className="py-1.5 px-2">
                      <input
                        type="text"
                        placeholder="—"
                        value={row.material}
                        onChange={(e) =>
                          handleBulkRowChange(row.key, 'material', e.target.value)
                        }
                        className="w-full h-8 px-1.5 font-mono text-[11px] bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[3px] text-zinc-700 outline-none"
                      />
                    </td>
                    <td className="py-1.5 px-2">
                      <input
                        type="text"
                        placeholder="—"
                        value={row.thickness}
                        onChange={(e) =>
                          handleBulkRowChange(row.key, 'thickness', e.target.value)
                        }
                        className="w-full h-8 px-1.5 font-mono text-[11px] bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[3px] text-zinc-700 outline-none"
                      />
                    </td>
                    <td className="py-1.5 px-2">
                      <input
                        type="text"
                        placeholder="Pallet 1"
                        value={row.palletNumber}
                        onChange={(e) =>
                          handleBulkRowChange(row.key, 'palletNumber', e.target.value)
                        }
                        className="w-full h-8 px-1.5 font-mono text-[11px] bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[3px] text-zinc-700 outline-none"
                      />
                    </td>
                    <td className="py-1.5 px-2 text-center font-mono text-[10px]">
                      {isScanned ? (
                        <span
                          className="inline-block px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-900 font-bold"
                          title="Already scanned in this delivery"
                        >
                          Scanned ({row.receivedQuantity ?? row.quantity})
                        </span>
                      ) : row.manuallyEdited ? (
                        <span
                          className="inline-block px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200"
                          title={
                            row.originalOcrValues
                              ? `Original OCR: ${row.originalOcrValues.partNumber} (Qty ${row.originalOcrValues.quantity})`
                              : 'Manually added/edited'
                          }
                        >
                          Edited
                        </span>
                      ) : (
                        <span className="text-zinc-400">OCR</span>
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-center">
                      <button
                        type="button"
                        onClick={() => setPendingBulkDeleteRow(row)}
                        className="p-1.5 text-zinc-400 hover:text-red-600 rounded hover:bg-red-50 transition-colors cursor-pointer"
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

        {/* Footer */}
        <div className="px-4 py-3 bg-white border-t border-[#E4E3DE] flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="text-xs font-mono text-zinc-600">
            Total Rows: <strong className="text-[#18181B]">{totalPartRows}</strong>
            <span className="mx-2 text-zinc-300">·</span>
            Total Quantities: <strong className="text-[#059669]">{totalQuantityPieces}</strong>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-3.5 rounded-[4px] bg-white border border-[#E4E3DE] hover:bg-zinc-50 text-zinc-700 text-xs font-semibold cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSaveBulkParts}
              className={`h-9 px-4 rounded-[4px] text-white text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer shadow-xs ${
                acknowledgedBulkScanWarning
                  ? 'bg-amber-600 hover:bg-amber-700'
                  : 'bg-[#059669] hover:bg-[#047857]'
              }`}
            >
              <Check className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>
                {acknowledgedBulkScanWarning
                  ? 'Confirm & Save All Changes'
                  : 'Save Changes'}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
