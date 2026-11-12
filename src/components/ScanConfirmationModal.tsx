import React, { useState, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onDiscard();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onDiscard]);

  const parsedQty = useMemo(() => {
    const val = parseInt(quantityInput.trim(), 10);
    return !Number.isNaN(val) && val > 0 ? val : 0;
  }, [quantityInput]);

  // Live match detection against delivery parts based on partNumber
  const resolvedMatchedPart = useMemo(() => {
    if (!delivery || !delivery.parts || !partNumber.trim()) return null;
    const cleanNorm = partNumber.trim().toUpperCase().replace(/\s*-\s*/g, '-');

    const exact = delivery.parts.find(
      (p) => p.partNumber.trim().toUpperCase().replace(/\s*-\s*/g, '-') === cleanNorm
    );
    if (exact) return exact;

    const itemMatch = delivery.parts.find((p) => {
      const itmClean = (p.itemNumber || '').trim().toUpperCase();
      return itmClean && (itmClean === cleanNorm || itmClean.replace(/^ITM-0*/, '') === cleanNorm);
    });
    if (itemMatch) return itemMatch;

    return null;
  }, [delivery, partNumber]);

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

  const methodBadge = useMemo(() => {
    switch (scan.scanMethod) {
      case 'qr_code':
        return {
          label: '2D QR Code',
          icon: QrCode,
          color:
            'text-[var(--pt-primary-light,#C084FC)] bg-[var(--pt-bg,#080B12)] border-[var(--pt-primary,#A020F0)]/50',
        };
      case 'ocr_label':
        return {
          label: 'Pallet Label OCR',
          icon: FileText,
          color: 'text-[#F59E0B] bg-amber-950/70 border-[#F59E0B]/40',
        };
      case 'external_hid':
        return {
          label: 'Hardware Scanner',
          icon: Barcode,
          color: 'text-[#00D979] bg-emerald-950/70 border-[#00D979]/40',
        };
      case 'manual':
        return {
          label: 'Manual Entry',
          icon: Keyboard,
          color: 'text-zinc-200 bg-zinc-800 border-zinc-700',
        };
      default:
        return {
          label: '1D Barcode',
          icon: Barcode,
          color: 'text-[#078BFF] bg-sky-950/70 border-[#078BFF]/40',
        };
    }
  }, [scan.scanMethod]);

  const MethodIcon = methodBadge.icon;

  // Verification status & remaining quantity computation
  const verificationStatus = useMemo(() => {
    if (!resolvedMatchedPart) {
      return {
        type: 'unlisted' as const,
        title: 'DOCKET MISMATCH — UNLISTED PART',
        message: `Part "${scan.rawCode || partNumber}" is not listed on Docket #${scan.docketNumber}. Will be flagged for review.`,
        badgeClass: 'bg-[#F59E0B]/15 border-[#F59E0B]/50 text-[#F59E0B]',
        requiredQty: parsedQty,
        remainingQty: 0,
      };
    }

    const { requiredQty } = getPartVerificationState(resolvedMatchedPart);
    const itemNoBadge = resolvedMatchedPart.itemNumber
      ? resolvedMatchedPart.itemNumber.replace(/^ITM-0*/i, '')
      : String(resolvedMatchedPart.docketLineIndex || 1);
    const remainingAfterScan = Math.max(0, requiredQty - parsedQty);

    if (parsedQty === requiredQty) {
      return {
        type: 'exact_match' as const,
        title: `VERIFIED — DOCKET ITEM #${itemNoBadge}`,
        message: `Full quantity verified (${parsedQty} of ${requiredQty} required • 0 remaining)`,
        badgeClass: 'bg-[#00D979]/15 border-[#00D979]/50 text-[#00D979]',
        requiredQty,
        remainingQty: 0,
      };
    } else if (parsedQty > requiredQty) {
      const overage = parsedQty - requiredQty;
      return {
        type: 'overage' as const,
        title: `OVERAGE FLAG — DOCKET ITEM #${itemNoBadge}`,
        message: `Overage detected: +${overage} over required quantity (${parsedQty} entered vs ${requiredQty} required)`,
        badgeClass: 'bg-[#EF4444]/15 border-[#EF4444]/50 text-[#EF4444]',
        requiredQty,
        remainingQty: 0,
      };
    } else {
      return {
        type: 'partial_match' as const,
        title: `PARTIAL RECEIPT — DOCKET ITEM #${itemNoBadge}`,
        message: `${parsedQty} of ${requiredQty} received • ${remainingAfterScan} remaining`,
        badgeClass: 'bg-[#F59E0B]/15 border-[#F59E0B]/50 text-[#F59E0B]',
        requiredQty,
        remainingQty: remainingAfterScan,
      };
    }
  }, [resolvedMatchedPart, parsedQty, scan.docketNumber, scan.rawCode, partNumber]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-md p-3 sm:p-4 pb-6 sm:pb-4 animate-in fade-in duration-200"
      onClick={(e) => {
        e.stopPropagation();
      }}
    >
      <div
        className="w-full max-w-lg bg-[var(--pt-card,#15182A)] text-white rounded-2xl border border-[var(--pt-primary,#A020F0)]/50 shadow-[0_0_50px_var(--pt-glow,rgba(160,32,240,0.35))] flex flex-col max-h-[90dvh] sm:max-h-[88dvh] overflow-hidden animate-in zoom-in-95 duration-200 my-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header Bar: Scan Method + Docket Association + Discard Button */}
        <div className="px-4 py-3 bg-[var(--pt-bg-secondary,#101321)] border-b border-[var(--pt-border,#29243D)] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`px-2 py-0.5 rounded-md border text-[11px] font-mono font-bold uppercase tracking-wider inline-flex items-center gap-1.5 shrink-0 ${methodBadge.color}`}
            >
              <MethodIcon className="w-3 h-3 shrink-0" />
              <span>{methodBadge.label}</span>
            </span>
            <div className="text-xs text-[var(--pt-text-secondary,#A3A8BD)] font-mono truncate">
              <span>Docket #{scan.docketNumber}</span>
              {scan.customerOrSupplier && (
                <span className="text-[var(--pt-text-muted,#737B94)] ml-1.5 font-sans">
                  • {scan.customerOrSupplier}
                </span>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={onDiscard}
            className="w-8 h-8 rounded-full bg-[var(--pt-bg,#080B12)] hover:bg-white/10 text-zinc-400 hover:text-white flex items-center justify-center transition-colors cursor-pointer shrink-0 border border-[var(--pt-border,#29243D)]"
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
            className={`p-3.5 rounded-xl border flex items-start gap-2.5 transition-colors ${verificationStatus.badgeClass}`}
          >
            {verificationStatus.type === 'exact_match' ? (
              <ShieldCheck className="w-5 h-5 shrink-0 text-[#00D979] mt-0.5" />
            ) : verificationStatus.type === 'overage' ? (
              <AlertTriangle className="w-5 h-5 shrink-0 text-[#EF4444] mt-0.5" />
            ) : (
              <AlertCircle className="w-5 h-5 shrink-0 text-[#F59E0B] mt-0.5" />
            )}
            <div className="min-w-0 flex-1">
              <div className="font-mono font-extrabold text-xs uppercase tracking-wide flex items-center gap-1.5">
                <span>{verificationStatus.title}</span>
              </div>
              <p className="text-[11px] font-mono opacity-95 mt-0.5 leading-snug">
                {verificationStatus.message}
              </p>
            </div>
          </div>

          {/* Unconfident Field Warning if applicable */}
          {scan.unconfidentFields && scan.unconfidentFields.length > 0 && (
            <div className="px-3 py-2 rounded-lg bg-[#F59E0B]/15 border border-[#F59E0B]/40 text-amber-200 text-xs flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-[#F59E0B] shrink-0" />
              <span>
                Please check {scan.unconfidentFields.join(' and ')} — verification recommended.
              </span>
            </div>
          )}

          {/* Validation Error Message */}
          {validationError && (
            <div className="px-3 py-2 rounded-lg bg-[#EF4444]/20 border border-[#EF4444]/50 text-red-200 text-xs flex items-center gap-2 animate-shake">
              <AlertCircle className="w-4 h-4 text-[#EF4444] shrink-0" />
              <span>{validationError}</span>
            </div>
          )}

          {/* Primary Form Card: Part Number, Description, Quantity, Remaining */}
          <div className="bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] rounded-xl p-4 space-y-4 shadow-sm">
            {/* Field 1: Part Number */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[11px] font-mono uppercase tracking-wider text-[var(--pt-text-secondary,#A3A8BD)] font-semibold">
                  Part Number
                </label>
                {resolvedMatchedPart ? (
                  <span className="text-[10px] font-mono text-[#00D979] font-bold">
                    ✓ Matched on Docket
                  </span>
                ) : (
                  <span className="text-[10px] font-mono text-[#F59E0B] font-bold">
                    ! Unlisted / Mismatch
                  </span>
                )}
              </div>
              <input
                type="text"
                value={partNumber}
                onChange={(e) => {
                  setPartNumber(e.target.value.toUpperCase());
                  setValidationError(null);
                }}
                placeholder="e.g. PART-10293"
                className="w-full h-11 px-3.5 rounded-lg bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] focus:border-[var(--pt-primary,#A020F0)] text-white font-mono font-bold text-base tracking-wide uppercase outline-none shadow-inner transition-colors"
              />

              {/* Candidate suggestions if unlisted */}
              {candidateParts.length > 0 && (
                <div className="mt-2 p-2 rounded-lg bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)]">
                  <span className="text-[10px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] uppercase tracking-wider block mb-1.5">
                    Suggested docket matches:
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {candidateParts.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => handleSelectCandidate(c)}
                        className="h-6 px-2 rounded bg-[var(--pt-card,#15182A)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-white text-[10px] font-mono flex items-center gap-1 cursor-pointer transition-colors"
                      >
                        <span className="font-bold text-[var(--pt-primary-light,#C084FC)]">
                          {c.partNumber}
                        </span>
                        <span className="text-[var(--pt-text-muted,#737B94)]">
                          (Qty {c.quantity})
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Field 2: Description */}
            <div>
              <label className="text-[11px] font-mono uppercase tracking-wider text-[var(--pt-text-secondary,#A3A8BD)] font-semibold block mb-1.5">
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
                className="w-full h-10 px-3.5 rounded-lg bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] focus:border-[var(--pt-primary,#A020F0)] text-white text-xs outline-none shadow-inner transition-colors"
              />
            </div>

            {/* Field 3: Prominent Quantity Selector + Required vs Remaining Summary */}
            <div className="pt-1">
              <div className="flex items-center justify-between mb-2 font-mono text-[11px]">
                <label className="uppercase tracking-wider text-[var(--pt-primary-light,#C084FC)] font-bold">
                  Quantity Received
                </label>
                {resolvedMatchedPart && (
                  <div className="flex items-center gap-2 text-[var(--pt-text-secondary,#A3A8BD)]">
                    <span>
                      Required: <strong className="text-white">{verificationStatus.requiredQty}</strong>
                    </span>
                    <span>•</span>
                    <span>
                      Remaining:{' '}
                      <strong
                        className={
                          verificationStatus.remainingQty === 0
                            ? 'text-[#00D979]'
                            : 'text-[#F59E0B]'
                        }
                      >
                        {verificationStatus.remainingQty}
                      </strong>
                    </span>
                  </div>
                )}
              </div>

              {/* Quantity Stepper & Large Input */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleStepQuantity(-1)}
                  disabled={parsedQty <= 1}
                  className="w-14 h-14 rounded-xl bg-[var(--pt-card,#15182A)] hover:bg-white/10 disabled:opacity-30 border border-[var(--pt-border,#29243D)] text-white flex items-center justify-center text-xl font-bold cursor-pointer transition-all active:scale-95 shrink-0 select-none"
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
                    className="w-full h-14 rounded-xl bg-[var(--pt-bg,#080B12)] border-2 border-[var(--pt-primary,#A020F0)]/60 focus:border-[var(--pt-primary-light,#C084FC)] text-center font-mono font-black text-2xl text-white outline-none shadow-inner tabular-nums transition-colors"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--pt-text-muted,#737B94)] font-mono text-[10px] uppercase pointer-events-none">
                    PCS
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => handleStepQuantity(1)}
                  className="w-14 h-14 rounded-xl pt-btn-primary text-white flex items-center justify-center text-xl font-bold cursor-pointer transition-all active:scale-95 shrink-0 select-none"
                  aria-label="Increase quantity"
                >
                  <Plus className="w-6 h-6 stroke-[3]" />
                </button>
              </div>

              {/* Quick quantity presets */}
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
                        ? 'pt-btn-primary text-white'
                        : 'bg-[var(--pt-card,#15182A)] hover:bg-white/10 text-[var(--pt-text-secondary,#A3A8BD)] border border-[var(--pt-border,#29243D)]'
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
                      className="h-7 px-2.5 rounded-md bg-[#00D979]/20 hover:bg-[#00D979]/30 border border-[#00D979]/50 text-[#00D979] font-mono text-[11px] font-bold cursor-pointer transition-all"
                    >
                      Full ({resolvedMatchedPart.quantity})
                    </button>
                  )}
              </div>
            </div>
          </div>

          {/* Toggleable Advanced Details */}
          <div className="border border-[var(--pt-border,#29243D)] rounded-xl overflow-hidden bg-[var(--pt-bg-secondary,#101321)]">
            <button
              type="button"
              onClick={() => setIsEditingDetails((prev) => !prev)}
              className="w-full px-3.5 py-2.5 flex items-center justify-between text-xs text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-1.5 font-medium">
                <Edit3 className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)]" />
                <span>{isEditingDetails ? 'Hide additional details' : 'Edit details & notes'}</span>
              </div>
              {isEditingDetails ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </button>

            {isEditingDetails && (
              <div className="p-3.5 pt-1 space-y-3 border-t border-[var(--pt-border,#29243D)] text-xs">
                <div>
                  <label className="text-[10px] font-mono uppercase text-[var(--pt-text-secondary,#A3A8BD)] block mb-1">
                    Scan Notes / Pallet Notes
                  </label>
                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="e.g. Pallet #2, verified intact"
                    className="w-full h-9 px-3 rounded-lg bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] text-white text-xs outline-none focus:border-[var(--pt-primary,#A020F0)]"
                  />
                </div>

                {scan.rawCode && (
                  <div className="p-2 rounded bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] font-mono text-[10px] text-[var(--pt-text-secondary,#A3A8BD)] break-all">
                    <span className="text-[var(--pt-text-muted,#737B94)] block">
                      Raw Decoded String:
                    </span>
                    <span>{scan.rawCode}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Bottom Actions Bar */}
        <div className="p-4 bg-[var(--pt-bg-secondary,#101321)] border-t border-[var(--pt-border,#29243D)] flex flex-col gap-2 shrink-0">
          <button
            type="button"
            onClick={handleSaveAndScanNextClick}
            className="w-full h-12 rounded-xl bg-[#00D979] hover:bg-[#00c46d] text-black font-mono font-extrabold text-sm tracking-wide flex items-center justify-center gap-2 cursor-pointer shadow-[0_0_20px_rgba(0,217,121,0.4)] active:scale-[0.98] transition-all"
          >
            <Check className="w-5 h-5 stroke-[3]" />
            <span>CONFIRM &amp; SCAN NEXT</span>
            <ArrowRight className="w-4 h-4 ml-1 stroke-[2.5]" />
          </button>

          <button
            type="button"
            onClick={handleConfirmAndSaveClick}
            className="w-full h-11 px-4 rounded-xl pt-btn-primary text-white font-mono font-bold text-xs flex items-center justify-center gap-2 cursor-pointer transition-colors"
          >
            <Check className="w-4 h-4 stroke-[2.5]" />
            <span>CONFIRM</span>
          </button>

          <button
            type="button"
            onClick={onDiscard}
            className="w-full h-11 px-4 rounded-xl bg-[var(--pt-bg,#080B12)] hover:bg-white/5 border border-[var(--pt-border,#29243D)] text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white font-mono font-semibold text-xs flex items-center justify-center gap-2 cursor-pointer transition-colors"
          >
            <X className="w-4 h-4" />
            <span>CANCEL</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
