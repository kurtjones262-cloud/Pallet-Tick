import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Check,
  X,
  Plus,
  Minus,
  QrCode,
  Barcode,
  FileText,
  AlertTriangle,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Edit3,
  Trash2,
  ArrowRight,
  ShieldCheck,
  AlertCircle,
  Keyboard,
} from 'lucide-react';
import { Delivery, DeliveryPart } from '../types/delivery';
import { getPartVerificationState } from '../utils/storage';

export type ScanMethodType = 'barcode' | 'qr_code' | 'ocr_label' | 'external_hid' | 'manual';

export interface ActiveScanData {
  scanMethod: ScanMethodType;
  rawCode: string;
  detectedPartNumber: string;
  detectedDescription: string;
  detectedQuantity: number;
  matchedPart: DeliveryPart | null;
  docketNumber: string;
  customerOrSupplier: string;
  rawOcrText?: string;
  isUnlisted?: boolean;
  unconfidentFields?: string[];
}

export interface ConfirmedScanPayload {
  partNumber: string;
  description: string;
  quantity: number;
  scanMethod: ScanMethodType;
  rawCode: string;
  matchedPart: DeliveryPart | null;
  notes?: string;
}

interface ScanConfirmationModalProps {
  scan: ActiveScanData;
  delivery: Delivery;
  onSaveAndScanNext: (payload: ConfirmedScanPayload) => void;
  onConfirmAndSave: (payload: ConfirmedScanPayload) => void;
  onDiscard: () => void;
}

export const ScanConfirmationModal: React.FC<ScanConfirmationModalProps> = ({
  scan,
  delivery,
  onSaveAndScanNext,
  onConfirmAndSave,
  onDiscard,
}) => {
  const [partNumber, setPartNumber] = useState<string>(scan.detectedPartNumber || '');
  const [description, setDescription] = useState<string>(scan.detectedDescription || '');
  const [quantityInput, setQuantityInput] = useState<string>(
    String(scan.detectedQuantity && scan.detectedQuantity > 0 ? scan.detectedQuantity : 1)
  );
  const [notes, setNotes] = useState<string>('');
  const [isEditingDetails, setIsEditingDetails] = useState<boolean>(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const quantityInputRef = useRef<HTMLInputElement | null>(null);

  const parsedQty = useMemo(() => {
    const val = parseInt(quantityInput.trim(), 10);
    return !Number.isNaN(val) && val > 0 ? val : 0;
  }, [quantityInput]);

  // Live match detection against delivery parts based on partNumber
  const resolvedMatchedPart = useMemo(() => {
    if (!delivery || !delivery.parts || !partNumber.trim()) return null;
    const cleanNorm = partNumber.trim().toUpperCase().replace(/\s*-\s*/g, '-');

    // 1. Exact partNumber match
    const exact = delivery.parts.find(
      (p) => p.partNumber.trim().toUpperCase().replace(/\s*-\s*/g, '-') === cleanNorm
    );
    if (exact) return exact;

    // 2. Barcode item number match
    const itemMatch = delivery.parts.find((p) => {
      const itmClean = (p.itemNumber || '').trim().toUpperCase();
      return itmClean && (itmClean === cleanNorm || itmClean.replace(/^ITM-0*/, '') === cleanNorm);
    });
    if (itemMatch) return itemMatch;

    return null;
  }, [delivery, partNumber]);

  // Candidate suggestions if not exact match
  const candidateParts = useMemo(() => {
    if (resolvedMatchedPart || !delivery || !delivery.parts) return [];
    const q = partNumber.trim().toUpperCase();
    if (q.length < 2) return [];

    return delivery.parts
      .filter((p) => {
        const pNum = p.partNumber.toUpperCase();
        const pDesc = p.description.toUpperCase();
        return pNum.includes(q) || pDesc.includes(q);
      })
      .slice(0, 4);
  }, [delivery, partNumber, resolvedMatchedPart]);

  // When matched part changes or user selects candidate, auto-fill description if blank
  const handleSelectCandidate = (candidate: DeliveryPart) => {
    setPartNumber(candidate.partNumber);
    if (!description.trim() || description === 'Unlisted Part') {
      setDescription(candidate.description);
    }
    if (candidate.quantity && candidate.quantity > 0 && parsedQty <= 1) {
      setQuantityInput(String(candidate.quantity));
    }
    setValidationError(null);
  };

  const handleStepQuantity = (delta: number) => {
    const current = parsedQty || 1;
    const next = Math.max(1, current + delta);
    setQuantityInput(String(next));
    setValidationError(null);
  };

  const validate = (): ConfirmedScanPayload | null => {
    const cleanPart = partNumber.trim();
    if (!cleanPart) {
      setValidationError('Part number cannot be blank.');
      return null;
    }
    if (parsedQty <= 0) {
      setValidationError('Please enter a valid whole quantity (1 or greater).');
      return null;
    }
    setValidationError(null);

    return {
      partNumber: cleanPart,
      description: description.trim() || (resolvedMatchedPart?.description ?? 'Unlisted Part'),
      quantity: parsedQty,
      scanMethod: scan.scanMethod,
      rawCode: scan.rawCode || cleanPart,
      matchedPart: resolvedMatchedPart,
      notes: notes.trim(),
    };
  };

  const handleSaveAndScanNextClick = () => {
    const payload = validate();
    if (payload) {
      onSaveAndScanNext(payload);
    }
  };

  const handleConfirmAndSaveClick = () => {
    const payload = validate();
    if (payload) {
      onConfirmAndSave(payload);
    }
  };

  // Determine badge styling and label
  const methodBadge = useMemo(() => {
    switch (scan.scanMethod) {
      case 'qr_code':
        return { label: '2D QR Code', icon: QrCode, color: 'text-cyan-400 bg-cyan-950/70 border-cyan-500/40' };
      case 'ocr_label':
        return { label: 'Pallet Label OCR', icon: FileText, color: 'text-amber-400 bg-amber-950/70 border-amber-500/40' };
      case 'external_hid':
        return { label: 'Hardware Scanner', icon: Barcode, color: 'text-emerald-400 bg-emerald-950/70 border-emerald-500/40' };
      case 'manual':
        return { label: 'Manual Entry', icon: Keyboard, color: 'text-zinc-300 bg-zinc-800 border-zinc-700' };
      default:
        return { label: '1D Barcode', icon: Barcode, color: 'text-blue-400 bg-blue-950/70 border-blue-500/40' };
    }
  }, [scan.scanMethod]);

  const MethodIcon = methodBadge.icon;

  // Verification state badge
  const verificationStatus = useMemo(() => {
    if (!resolvedMatchedPart) {
      return {
        type: 'unlisted',
        title: 'Unlisted Item',
        message: `Code "${scan.rawCode || partNumber}" is not on docket #${scan.docketNumber}`,
        badgeClass: 'bg-amber-500/15 border-amber-500/40 text-amber-300',
      };
    }

    const { state, requiredQty, receivedQty } = getPartVerificationState(resolvedMatchedPart);
    const itemNoBadge = resolvedMatchedPart.itemNumber
      ? resolvedMatchedPart.itemNumber.replace(/^ITM-0*/i, '')
      : String(resolvedMatchedPart.docketLineIndex || 1);

    if (parsedQty === requiredQty) {
      return {
        type: 'exact_match',
        title: `Matched Docket Item #${itemNoBadge}`,
        message: `Full quantity verified (${parsedQty} of ${requiredQty} required)`,
        badgeClass: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300',
      };
    } else {
      const diff = parsedQty - requiredQty;
      return {
        type: 'quantity_mismatch',
        title: `Matched Docket Item #${itemNoBadge}`,
        message: `Quantity mismatch: ${parsedQty} entered vs ${requiredQty} required (${diff > 0 ? `+${diff}` : diff})`,
        badgeClass: 'bg-orange-500/15 border-orange-500/40 text-orange-300',
      };
    }
  }, [resolvedMatchedPart, parsedQty, scan.docketNumber, scan.rawCode, partNumber]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-sm p-0 sm:p-4 animate-in fade-in duration-200"
      onClick={(e) => {
        // Prevent background clicks from closing unintentionally without user choosing Discard
        e.stopPropagation();
      }}
    >
      <div
        className="w-full max-w-lg bg-[#0B0F17] text-white rounded-t-2xl sm:rounded-2xl border border-cyan-500/30 shadow-[0_0_50px_rgba(0,168,255,0.2)] flex flex-col max-h-[92vh] sm:max-h-[88vh] overflow-hidden animate-in slide-in-from-bottom-6 sm:zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header Bar: Scan Method + Docket Association + Discard Button */}
        <div className="px-4 py-3 bg-[#0F1624] border-b border-zinc-800/80 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`px-2 py-0.5 rounded-[4px] border text-[11px] font-mono font-bold uppercase tracking-wider inline-flex items-center gap-1.5 shrink-0 ${methodBadge.color}`}
            >
              <MethodIcon className="w-3 h-3 shrink-0" />
              <span>{methodBadge.label}</span>
            </span>
            <div className="text-xs text-zinc-400 font-mono truncate">
              <span>Docket #{scan.docketNumber}</span>
              {scan.customerOrSupplier && (
                <span className="text-zinc-500 ml-1.5 font-sans">• {scan.customerOrSupplier}</span>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={onDiscard}
            className="w-8 h-8 rounded-full bg-zinc-800/70 hover:bg-zinc-700 text-zinc-400 hover:text-white flex items-center justify-center transition-colors cursor-pointer shrink-0"
            title="Discard this scan"
            aria-label="Discard scan"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Content Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
          {/* Validation Status Card */}
          <div
            className={`p-3 rounded-xl border flex items-start gap-2.5 transition-colors ${verificationStatus.badgeClass}`}
          >
            {verificationStatus.type === 'exact_match' ? (
              <ShieldCheck className="w-5 h-5 shrink-0 text-emerald-400 mt-0.5" />
            ) : verificationStatus.type === 'quantity_mismatch' ? (
              <AlertTriangle className="w-5 h-5 shrink-0 text-orange-400 mt-0.5" />
            ) : (
              <AlertCircle className="w-5 h-5 shrink-0 text-amber-400 mt-0.5" />
            )}
            <div className="min-w-0 flex-1">
              <div className="font-bold text-xs uppercase tracking-wide flex items-center gap-1.5">
                <span>{verificationStatus.title}</span>
              </div>
              <p className="text-[11px] opacity-90 mt-0.5 leading-snug">
                {verificationStatus.message}
              </p>
            </div>
          </div>

          {/* Unconfident Field Warning if applicable */}
          {scan.unconfidentFields && scan.unconfidentFields.length > 0 && (
            <div className="px-3 py-2 rounded-lg bg-amber-950/40 border border-amber-500/30 text-amber-200 text-xs flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>
                Please check {scan.unconfidentFields.join(' and ')} — verification recommended.
              </span>
            </div>
          )}

          {/* Validation Error Message */}
          {validationError && (
            <div className="px-3 py-2 rounded-lg bg-red-950/60 border border-red-500/40 text-red-200 text-xs flex items-center gap-2 animate-shake">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{validationError}</span>
            </div>
          )}

          {/* Primary Form Card: Part Number, Description, Quantity */}
          <div className="bg-[#111722] border border-zinc-800 rounded-xl p-4 space-y-4 shadow-sm">
            {/* Field 1: Part Number */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 font-semibold">
                  Part Number
                </label>
                {resolvedMatchedPart ? (
                  <span className="text-[10px] font-mono text-emerald-400 font-medium">
                    ✓ Verified on Docket
                  </span>
                ) : (
                  <span className="text-[10px] font-mono text-amber-400 font-medium">
                    New / Unlisted Part
                  </span>
                )}
              </div>
              <div className="relative">
                <input
                  type="text"
                  value={partNumber}
                  onChange={(e) => {
                    setPartNumber(e.target.value.toUpperCase());
                    setValidationError(null);
                  }}
                  placeholder="e.g. PART-10293"
                  className="w-full h-11 px-3.5 rounded-lg bg-[#070A0F] border border-zinc-700/80 focus:border-cyan-400 text-white font-mono font-bold text-base tracking-wide uppercase outline-none shadow-inner transition-colors"
                />
              </div>

              {/* Candidate suggestions if unlisted */}
              {candidateParts.length > 0 && (
                <div className="mt-2 p-2 rounded-lg bg-black/40 border border-zinc-800">
                  <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-wider block mb-1.5">
                    Suggested docket matches:
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {candidateParts.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => handleSelectCandidate(c)}
                        className="h-6 px-2 rounded bg-zinc-800/90 hover:bg-cyan-950/60 border border-zinc-700 hover:border-cyan-500/50 text-zinc-200 text-[10px] font-mono flex items-center gap-1 cursor-pointer transition-colors"
                      >
                        <span className="font-bold text-cyan-300">{c.partNumber}</span>
                        <span className="text-zinc-500">(Qty {c.quantity})</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Field 2: Description */}
            <div>
              <label className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 font-semibold block mb-1.5">
                Description / Material Spec
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setValidationError(null);
                }}
                placeholder="Description or material spec"
                className="w-full h-10 px-3.5 rounded-lg bg-[#070A0F] border border-zinc-700/80 focus:border-cyan-400 text-zinc-200 text-xs outline-none shadow-inner transition-colors"
              />
            </div>

            {/* Field 3: Prominent Quantity Selector */}
            <div className="pt-1">
              <div className="flex items-center justify-between mb-2">
                <label className="text-[11px] font-mono uppercase tracking-wider text-cyan-400 font-bold">
                  Received Quantity
                </label>
                {resolvedMatchedPart && (
                  <span className="text-[11px] font-mono text-zinc-400">
                    Required on docket:{' '}
                    <strong className="text-white">{resolvedMatchedPart.quantity}</strong>
                  </span>
                )}
              </div>

              {/* Quantity Stepper & Large Input */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleStepQuantity(-1)}
                  disabled={parsedQty <= 1}
                  className="w-14 h-14 rounded-xl bg-zinc-800/90 hover:bg-zinc-700 disabled:opacity-30 border border-zinc-700 text-white flex items-center justify-center text-xl font-bold cursor-pointer transition-all active:scale-95 shrink-0 select-none shadow-sm"
                  aria-label="Decrease quantity"
                >
                  <Minus className="w-6 h-6 stroke-[2.5]" />
                </button>

                <div className="flex-1 relative">
                  <input
                    ref={quantityInputRef}
                    type="number"
                    min="1"
                    step="1"
                    value={quantityInput}
                    onChange={(e) => {
                      setQuantityInput(e.target.value);
                      setValidationError(null);
                    }}
                    className="w-full h-14 rounded-xl bg-[#070A0F] border-2 border-cyan-500/40 focus:border-cyan-400 text-center font-mono font-black text-2xl text-cyan-300 outline-none shadow-inner tabular-nums transition-colors"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 font-mono text-[10px] uppercase pointer-events-none">
                    PCS
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => handleStepQuantity(1)}
                  className="w-14 h-14 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-black flex items-center justify-center text-xl font-bold cursor-pointer transition-all active:scale-95 shrink-0 select-none shadow-[0_0_15px_rgba(6,182,212,0.4)]"
                  aria-label="Increase quantity"
                >
                  <Plus className="w-6 h-6 stroke-[3]" />
                </button>
              </div>

              {/* Quick quantity presets for fast shopfloor tapping */}
              <div className="flex items-center gap-1.5 mt-2.5 justify-center flex-wrap">
                {[1, 2, 5, 10, 20, 50].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => {
                      setQuantityInput(String(preset));
                      setValidationError(null);
                    }}
                    className={`h-7 px-2.5 rounded-md font-mono text-[11px] font-bold cursor-pointer transition-all ${
                      parsedQty === preset
                        ? 'bg-cyan-400 text-black shadow-xs'
                        : 'bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300'
                    }`}
                  >
                    {preset}
                  </button>
                ))}
                {resolvedMatchedPart &&
                  typeof resolvedMatchedPart.quantity === 'number' &&
                  resolvedMatchedPart.quantity > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setQuantityInput(String(resolvedMatchedPart.quantity));
                        setValidationError(null);
                      }}
                      className="h-7 px-2.5 rounded-md bg-emerald-600/30 hover:bg-emerald-600/50 border border-emerald-500/40 text-emerald-300 font-mono text-[11px] font-bold cursor-pointer transition-all"
                    >
                      Full ({resolvedMatchedPart.quantity})
                    </button>
                  )}
              </div>
            </div>
          </div>

          {/* Toggleable Advanced Details: Pallet assignment, notes, raw code */}
          <div className="border border-zinc-800/80 rounded-xl overflow-hidden bg-[#0D121B]">
            <button
              type="button"
              onClick={() => setIsEditingDetails((prev) => !prev)}
              className="w-full px-3.5 py-2.5 flex items-center justify-between text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-1.5 font-medium">
                <Edit3 className="w-3.5 h-3.5 text-cyan-400" />
                <span>{isEditingDetails ? 'Hide additional details' : 'Edit details & notes'}</span>
              </div>
              {isEditingDetails ? (
                <ChevronUp className="w-4 h-4 text-zinc-400" />
              ) : (
                <ChevronDown className="w-4 h-4 text-zinc-400" />
              )}
            </button>

            {isEditingDetails && (
              <div className="p-3.5 pt-1 space-y-3 border-t border-zinc-800/60 text-xs">
                <div>
                  <label className="text-[10px] font-mono uppercase text-zinc-400 block mb-1">
                    Scan Notes / Pallet Notes
                  </label>
                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="e.g. Pallet #2, slight scratch on corner, etc."
                    className="w-full h-9 px-3 rounded-lg bg-[#070A0F] border border-zinc-700 text-zinc-200 text-xs outline-none focus:border-cyan-400"
                  />
                </div>

                {scan.rawCode && (
                  <div className="p-2 rounded bg-black/40 border border-zinc-800 font-mono text-[10px] text-zinc-400 break-all">
                    <span className="text-zinc-500 block">Raw Decoded String:</span>
                    <span>{scan.rawCode}</span>
                  </div>
                )}

                {scan.rawOcrText && (
                  <div className="p-2 rounded bg-black/40 border border-zinc-800 font-mono text-[10px] text-zinc-400 max-h-24 overflow-y-auto">
                    <span className="text-zinc-500 block">Full OCR Text Output:</span>
                    <pre className="whitespace-pre-wrap">{scan.rawOcrText}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Bottom Actions Bar (Mobile Sticky & Touch-Optimised) */}
        <div className="p-4 bg-[#0D131F] border-t border-zinc-800/80 flex flex-col gap-2 shrink-0">
          {/* Primary Action Button: SAVE & SCAN NEXT (Continuous Scanning Workflow) */}
          <button
            type="button"
            onClick={handleSaveAndScanNextClick}
            className="w-full h-12 rounded-xl bg-gradient-to-r from-cyan-500 via-cyan-400 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-black font-bold text-sm tracking-wide flex items-center justify-center gap-2 cursor-pointer shadow-[0_0_20px_rgba(6,182,212,0.4)] active:scale-[0.98] transition-all"
          >
            <Check className="w-5 h-5 stroke-[3]" />
            <span>SAVE &amp; SCAN NEXT</span>
            <ArrowRight className="w-4 h-4 ml-1 stroke-[2.5]" />
          </button>

          {/* Secondary Actions Row: CONFIRM & SAVE and DISCARD */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handleConfirmAndSaveClick}
              className="h-10 px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white font-semibold text-xs flex items-center justify-center gap-1.5 cursor-pointer border border-zinc-700 transition-colors"
            >
              <Check className="w-4 h-4 text-emerald-400" />
              <span>CONFIRM &amp; SAVE</span>
            </button>

            <button
              type="button"
              onClick={onDiscard}
              className="h-10 px-3 rounded-xl bg-red-950/30 hover:bg-red-950/50 border border-red-500/30 text-red-300 font-semibold text-xs flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5 text-red-400" />
              <span>DISCARD</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
