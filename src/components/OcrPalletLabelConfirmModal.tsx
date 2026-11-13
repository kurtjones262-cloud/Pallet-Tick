import React, { useState, useMemo } from 'react';
import {
  Check,
  X,
  AlertTriangle,
  XCircle,
  Plus,
  Minus,
  FileText,
  Layers,
  Eye,
} from 'lucide-react';
import { Delivery, DeliveryPart } from '../types/delivery';
import {
  PalletLabelExtractionResult,
  evaluatePalletLabelMatch,
} from '../utils/palletLabelOcr';
import { findPreviousIdenticalLabelScans } from '../utils/storage';

interface OcrPalletLabelConfirmModalProps {
  delivery: Delivery;
  extraction: PalletLabelExtractionResult;
  onConfirmMatchedLabel: (params: {
    part: DeliveryPart;
    recognizedPartNumber: string;
    recognizedDescription: string;
    palletQuantity: number;
    rawOcrText: string;
  }) => void;
  onRecordUnexpectedLabel: (params: {
    recognizedPartNumber: string;
    recognizedDescription: string;
    palletQuantity: number;
    rawOcrText: string;
  }) => void;
  onCancel: () => void;
}

export const OcrPalletLabelConfirmModal: React.FC<OcrPalletLabelConfirmModalProps> = ({
  delivery,
  extraction,
  onConfirmMatchedLabel,
  onRecordUnexpectedLabel,
  onCancel,
}) => {
  const [partNumberInput, setPartNumberInput] = useState<string>(
    extraction.partNumber || ''
  );
  const [descriptionInput, setDescriptionInput] = useState<string>(
    extraction.description || ''
  );
  const [quantityInput, setQuantityInput] = useState<string>(
    extraction.quantity !== null && extraction.quantity > 0
      ? String(extraction.quantity)
      : '1'
  );
  const [manualOverrideConfirmed, setManualOverrideConfirmed] = useState<boolean>(
    false
  );
  const [showRawOcr, setShowRawOcr] = useState<boolean>(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const parsedQty = useMemo(() => {
    const n = parseInt(quantityInput.trim(), 10);
    return !Number.isNaN(n) && n > 0 ? n : 0;
  }, [quantityInput]);

  // Live evaluation against the compiled parts list
  const evaluation = useMemo(() => {
    const effectiveConfidence = manualOverrideConfirmed
      ? 'high'
      : extraction.ocrConfidence;
    return evaluatePalletLabelMatch(
      partNumberInput,
      parsedQty,
      delivery.parts,
      effectiveConfidence
    );
  }, [
    partNumberInput,
    parsedQty,
    delivery.parts,
    extraction.ocrConfidence,
    manualOverrideConfirmed,
  ]);

  // Check if an identical pallet label was previously scanned in this delivery
  const previousIdenticalScans = useMemo(() => {
    return findPreviousIdenticalLabelScans(delivery, partNumberInput, parsedQty);
  }, [delivery, partNumberInput, parsedQty]);

  const handleSelectCandidatePart = (part: DeliveryPart) => {
    setPartNumberInput(part.partNumber);
    if (!descriptionInput.trim()) {
      setDescriptionInput(part.description);
    }
    setManualOverrideConfirmed(true);
    setValidationError(null);
  };

  const handleConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!partNumberInput.trim()) {
      setValidationError('Please enter or verify the Part Number from the label.');
      return;
    }
    if (parsedQty <= 0) {
      setValidationError('Please enter a valid pallet quantity greater than 0.');
      return;
    }

    if (evaluation.matchedPart) {
      onConfirmMatchedLabel({
        part: evaluation.matchedPart,
        recognizedPartNumber: partNumberInput.trim(),
        recognizedDescription:
          descriptionInput.trim() || evaluation.matchedPart.description,
        palletQuantity: parsedQty,
        rawOcrText: extraction.rawOcrText,
      });
    } else {
      setValidationError(
        'Part number does not match any item on the compiled parts list. Correct the part number above, select a matching docket part, or record as an Unexpected Part.'
      );
    }
  };

  const isGreen =
    evaluation.matchedPart !== null &&
    evaluation.statusColor === 'green' &&
    parsedQty > 0;
  const isOrange =
    evaluation.matchedPart !== null &&
    evaluation.statusColor === 'orange' &&
    parsedQty > 0;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
    >
      <div className="w-full max-w-md bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] rounded-2xl shadow-2xl text-[var(--pt-text,#FFFFFF)] overflow-hidden animate-in fade-in zoom-in-95 duration-150 my-auto max-h-[94dvh] flex flex-col">
        {/* Top Status Indicator Header (GREEN / ORANGE / RED) */}
        <div
          className={`px-4 py-3 border-b flex items-center justify-between gap-2 shrink-0 ${
            isGreen
              ? 'bg-[#059669] border-[#047857] text-white'
              : isOrange
              ? 'bg-amber-600 border-amber-700 text-white'
              : 'bg-red-600 border-red-700 text-white'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            {isGreen ? (
              <Check className="w-4 h-4 stroke-[2.5] shrink-0" />
            ) : isOrange ? (
              <AlertTriangle className="w-4 h-4 shrink-0" />
            ) : (
              <XCircle className="w-4 h-4 shrink-0" />
            )}
            <div className="min-w-0">
              <h3 className="font-bold text-xs uppercase tracking-wider truncate pt-keep-white">
                {isGreen
                  ? 'Matched · Exact Expected Quantity'
                  : isOrange
                  ? 'Matched · Partial or Mismatched Quantity'
                  : 'Unmatched or Uncertain Part Number'}
              </h3>
              <p className="text-[11px] opacity-95 truncate pt-keep-white">
                {isGreen
                  ? `Total scanned (${evaluation.newTotalScannedQty}/${evaluation.expectedQty}) matches expected quantity`
                  : isOrange
                  ? `Total scanned will be ${evaluation.newTotalScannedQty} of ${evaluation.expectedQty} expected`
                  : 'Review and correct OCR fields below before confirming'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onCancel}
            className="p-1 rounded hover:bg-black/20 text-white/90 hover:text-white cursor-pointer shrink-0 pt-keep-white"
            aria-label="Cancel OCR scan"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Body */}
        <form onSubmit={handleConfirm} className="p-4 space-y-3.5 overflow-y-auto flex-1">
          {/* Captured Label Thumbnail + Raw OCR Toggle */}
          <div className="flex items-center gap-3 p-2.5 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)]">
            {extraction.croppedPreviewDataUrl && (
              <img
                src={extraction.croppedPreviewDataUrl}
                alt="Captured pallet label"
                className="w-20 h-14 object-cover rounded-lg border border-[var(--pt-border,#29243D)] shrink-0 bg-black"
              />
            )}
            <div className="min-w-0 flex-1 text-xs">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#00D979]/15 text-[#00D979] border border-[#00D979]/30 font-semibold">
                  {extraction.engineUsed === 'mlkit-native' ? 'Native ML Kit OCR' : 'Gemini Vision OCR'}
                </span>
                {Math.abs(extraction.detectedSkewDegrees) >= 1 && (
                  <span className="font-mono text-[10px] text-[var(--pt-text-secondary,#A3A8BD)]">
                    Deskewed {extraction.detectedSkewDegrees > 0 ? '+' : ''}
                    {extraction.detectedSkewDegrees}°
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowRawOcr((prev) => !prev)}
                className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-mono text-[var(--pt-primary-light,#C084FC)] hover:underline cursor-pointer"
              >
                <Eye className="w-3 h-3" />
                <span>{showRawOcr ? 'Hide raw OCR text' : 'Inspect raw OCR text'}</span>
              </button>
            </div>
          </div>

          {showRawOcr && (
            <div className="p-2.5 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] text-left">
              <span className="block font-mono text-[10px] uppercase text-[var(--pt-text-secondary,#A3A8BD)] mb-1">
                Raw OCR Text (Troubleshooting):
              </span>
              <pre className="font-mono text-[11px] text-[var(--pt-text,#FFFFFF)] whitespace-pre-wrap max-h-28 overflow-y-auto">
                {extraction.rawOcrText || '(No raw text detected)'}
              </pre>
            </div>
          )}

          {/* Duplicate Pallet Label Warning */}
          {previousIdenticalScans.length > 0 && (
            <div className="p-3 rounded-xl bg-[#F59E0B]/15 border border-[#F59E0B]/50 text-[#F59E0B] text-xs flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-[#F59E0B] shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <span className="font-semibold block">
                  Previously Scanned Label Warning ({previousIdenticalScans.length}x)
                </span>
                <p className="text-[11px] text-[var(--pt-text,#FFFFFF)] mt-0.5 leading-snug">
                  A pallet label for <strong className="font-mono">{partNumberInput}</strong> with
                  quantity <strong className="font-mono">{parsedQty}</strong> was already confirmed
                  at{' '}
                  {new Date(previousIdenticalScans[0].timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                  . Confirm only if this is a separate physical pallet.
                </p>
              </div>
            </div>
          )}

          {/* Editable OCR Fields */}
          <div className="space-y-3">
            {/* Field 1: Extracted Part Number */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label
                  htmlFor="ocr-label-part-number-input"
                  className="text-[11px] font-mono uppercase tracking-wider text-[var(--pt-text-secondary,#A3A8BD)] font-semibold"
                >
                  1. Extracted Part Number
                </label>
                {delivery.parts.length > 0 && (
                  <select
                    aria-label="Pick part number from compiled list"
                    value=""
                    onChange={(e) => {
                      const found = delivery.parts.find((p) => p.id === e.target.value);
                      if (found) handleSelectCandidatePart(found);
                    }}
                    className="h-6 px-1.5 rounded bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] text-[10px] font-mono text-[var(--pt-primary-light,#C084FC)] outline-none cursor-pointer"
                  >
                    <option value="">Select from docket list...</option>
                    {delivery.parts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.partNumber} (No. {p.itemNumber} · Exp: {p.quantity ?? 1})
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <input
                id="ocr-label-part-number-input"
                type="text"
                value={partNumberInput}
                onChange={(e) => {
                  setPartNumberInput(e.target.value);
                  setManualOverrideConfirmed(true);
                  setValidationError(null);
                }}
                placeholder="e.g. 0045-PLT-102"
                className={`w-full h-10 px-3 bg-[var(--pt-input-bg,#080B12)] border rounded-xl font-mono text-sm font-bold text-[var(--pt-text,#FFFFFF)] outline-none ${
                  evaluation.matchedPart
                    ? 'border-[#00D979]/70 focus:border-[#00D979]'
                    : 'border-[#EF4444]/70 focus:border-[#EF4444]'
                }`}
              />

              {/* Candidate suggestions from docket */}
              {!evaluation.matchedPart && evaluation.candidateParts.length > 0 && (
                <div className="mt-1.5 p-2 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)]">
                  <span className="block text-[10px] font-mono text-[#F59E0B] mb-1">
                    Similar part numbers on docket (tap to select — never auto-confirmed):
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {evaluation.candidateParts.map((cand) => (
                      <button
                        key={cand.id}
                        type="button"
                        onClick={() => handleSelectCandidatePart(cand)}
                        className="px-2 py-1 rounded bg-[var(--pt-bg-secondary,#101321)] hover:bg-[var(--pt-hover-bg)] border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)] font-mono text-xs text-[var(--pt-text,#FFFFFF)] cursor-pointer"
                      >
                        {cand.partNumber} (Exp: {cand.quantity ?? 1})
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Field 2: Extracted Description */}
            <div>
              <label
                htmlFor="ocr-label-description-input"
                className="block text-[11px] font-mono uppercase tracking-wider text-[var(--pt-text-secondary,#A3A8BD)] font-semibold mb-1"
              >
                2. Extracted Description
              </label>
              <input
                id="ocr-label-description-input"
                type="text"
                value={descriptionInput}
                onChange={(e) => setDescriptionInput(e.target.value)}
                placeholder="Part description from label"
                className="w-full h-9 px-3 bg-[var(--pt-input-bg,#080B12)] border border-[var(--pt-border,#29243D)] focus:border-[var(--pt-primary,#A020F0)] rounded-xl text-xs text-[var(--pt-text,#FFFFFF)] outline-none"
              />
            </div>

            {/* Field 3: Extracted Pallet Quantity */}
            <div>
              <label
                htmlFor="ocr-label-quantity-input"
                className="block text-[11px] font-mono uppercase tracking-wider text-[var(--pt-text-secondary,#A3A8BD)] font-semibold mb-1"
              >
                3. Extracted Pallet Quantity (Added to Scanned Total)
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const curr = parseInt(quantityInput, 10) || 0;
                    setQuantityInput(String(Math.max(1, curr - 1)));
                    setValidationError(null);
                  }}
                  className="w-10 h-10 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-[var(--pt-hover-bg)] border border-[var(--pt-border,#29243D)] text-[var(--pt-text,#FFFFFF)] flex items-center justify-center cursor-pointer shrink-0"
                  aria-label="Decrease quantity"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <input
                  id="ocr-label-quantity-input"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  value={quantityInput}
                  onChange={(e) => {
                    setQuantityInput(e.target.value);
                    setValidationError(null);
                  }}
                  className="flex-1 h-10 px-3 bg-[var(--pt-input-bg,#080B12)] border border-[var(--pt-border,#29243D)] focus:border-[var(--pt-primary,#A020F0)] rounded-xl font-mono text-lg font-bold text-[var(--pt-text,#FFFFFF)] text-center outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    const curr = parseInt(quantityInput, 10) || 0;
                    setQuantityInput(String(curr + 1));
                    setValidationError(null);
                  }}
                  className="w-10 h-10 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-[var(--pt-hover-bg)] border border-[var(--pt-border,#29243D)] text-[var(--pt-text,#FFFFFF)] flex items-center justify-center cursor-pointer shrink-0"
                  aria-label="Increase quantity"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Matched Docket Part & Cumulative Multi-Pallet Quantity Summary */}
          {evaluation.matchedPart ? (
            <div
              className={`p-3 rounded-xl border ${
                isGreen
                  ? 'bg-[#00D979]/10 border-[#00D979]/40'
                  : 'bg-[#F59E0B]/10 border-[#F59E0B]/40'
              }`}
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Layers className="w-3.5 h-3.5 text-[#00D979] shrink-0" />
                  <span className="font-mono text-xs font-bold text-[var(--pt-text,#FFFFFF)] truncate">
                    Matched: {evaluation.matchedPart.partNumber}
                  </span>
                </div>
                <span className="px-1.5 py-0.5 rounded bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] font-mono text-[10px] text-[var(--pt-text-secondary,#A3A8BD)] shrink-0">
                  Docket No. {evaluation.matchedPart.itemNumber}
                </span>
              </div>

              <p className="text-xs text-[var(--pt-text-secondary,#A3A8BD)] truncate mb-2.5">
                {evaluation.matchedPart.description}
              </p>

              <div className="grid grid-cols-3 gap-2 p-2 rounded-lg bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] text-center font-mono">
                <div>
                  <span className="block text-[9px] uppercase text-[var(--pt-text-muted,#737B94)]">
                    Prior Scanned
                  </span>
                  <span className="text-sm font-bold text-[var(--pt-text,#FFFFFF)]">
                    {evaluation.existingScannedQty}
                  </span>
                </div>
                <div>
                  <span className="block text-[9px] uppercase text-[var(--pt-text-muted,#737B94)]">
                    This Pallet
                  </span>
                  <span className="text-sm font-bold text-[#00D979]">
                    +{evaluation.addedPalletQty}
                  </span>
                </div>
                <div>
                  <span className="block text-[9px] uppercase text-[var(--pt-text-muted,#737B94)]">
                    Total / Expected
                  </span>
                  <span
                    className={`text-sm font-bold ${
                      isGreen ? 'text-[#00D979]' : 'text-[#F59E0B]'
                    }`}
                  >
                    {evaluation.newTotalScannedQty} / {evaluation.expectedQty}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-3 rounded-xl bg-[#EF4444]/15 border border-[#EF4444]/40 text-xs text-[#EF4444]">
              <div className="flex items-center gap-1.5 font-semibold mb-1">
                <XCircle className="w-4 h-4 shrink-0" />
                <span>No Exact Match on Compiled Parts List</span>
              </div>
              <p className="text-[11px] leading-snug text-[var(--pt-text,#FFFFFF)]">
                Part number <strong className="font-mono">{partNumberInput || '—'}</strong> was not
                found on this delivery docket. Edit the part number above if OCR misread a character,
                or log this label as an Unexpected Part.
              </p>
            </div>
          )}

          {validationError && (
            <p className="text-xs text-[#EF4444] font-medium">{validationError}</p>
          )}

          {/* Action Buttons */}
          <div className="pt-2 flex flex-col gap-2">
            {evaluation.matchedPart ? (
              <button
                type="submit"
                className={`w-full h-11 px-4 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer transition-colors shadow-lg ${
                  isGreen
                    ? 'bg-[#059669] hover:bg-[#047857] text-white'
                    : 'bg-amber-600 hover:bg-amber-700 text-white'
                }`}
              >
                <Check className="w-4 h-4 stroke-[2.5]" />
                <span>
                  Confirm Label Scan (+{evaluation.addedPalletQty} → {evaluation.newTotalScannedQty}/
                  {evaluation.expectedQty})
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  onRecordUnexpectedLabel({
                    recognizedPartNumber: partNumberInput.trim() || 'UNKNOWN-LABEL',
                    recognizedDescription: descriptionInput.trim(),
                    palletQuantity: Math.max(1, parsedQty),
                    rawOcrText: extraction.rawOcrText,
                  });
                }}
                className="w-full h-10 px-4 rounded-xl bg-red-600 hover:bg-red-700 text-white font-semibold text-xs flex items-center justify-center gap-2 cursor-pointer transition-colors"
              >
                <FileText className="w-4 h-4" />
                <span>Record as Unexpected Part (Red)</span>
              </button>
            )}

            <button
              type="button"
              onClick={onCancel}
              className="w-full h-9 px-4 rounded-xl border border-[var(--pt-border,#29243D)] bg-[var(--pt-bg-secondary,#101321)] hover:bg-[var(--pt-hover-bg)] text-[var(--pt-text-secondary,#A3A8BD)] font-medium text-xs cursor-pointer transition-colors"
            >
              Retake / Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
