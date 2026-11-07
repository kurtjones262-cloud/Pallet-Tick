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
    // If operator manually edited the part number or clicked a candidate, treat confidence as operator-verified ('high')
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
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
    >
      <div className="w-full max-w-md bg-[#1C1C1E] border border-zinc-700 rounded-[8px] shadow-2xl text-white overflow-hidden animate-in fade-in zoom-in-95 duration-150 my-auto max-h-[94dvh] flex flex-col">
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
              <h3 className="font-bold text-xs uppercase tracking-wider truncate">
                {isGreen
                  ? 'Matched · Exact Expected Quantity'
                  : isOrange
                  ? 'Matched · Partial or Mismatched Quantity'
                  : 'Unmatched or Uncertain Part Number'}
              </h3>
              <p className="text-[11px] opacity-95 truncate">
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
            className="p-1 rounded hover:bg-black/20 text-white/90 hover:text-white cursor-pointer shrink-0"
            aria-label="Cancel OCR scan"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Body */}
        <form onSubmit={handleConfirm} className="p-4 space-y-3.5 overflow-y-auto flex-1">
          {/* Captured Label Thumbnail + Raw OCR Toggle */}
          <div className="flex items-center gap-3 p-2.5 rounded-[5px] bg-black/40 border border-zinc-800">
            {extraction.croppedPreviewDataUrl && (
              <img
                src={extraction.croppedPreviewDataUrl}
                alt="Captured pallet label"
                className="w-20 h-14 object-cover rounded-[3px] border border-zinc-700 shrink-0 bg-zinc-900"
              />
            )}
            <div className="min-w-0 flex-1 text-xs">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-semibold">
                  On-Device Offline OCR
                </span>
                {Math.abs(extraction.detectedSkewDegrees) >= 1 && (
                  <span className="font-mono text-[10px] text-zinc-400">
                    Deskewed {extraction.detectedSkewDegrees > 0 ? '+' : ''}
                    {extraction.detectedSkewDegrees}°
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowRawOcr((prev) => !prev)}
                className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-mono text-emerald-400 hover:underline cursor-pointer"
              >
                <Eye className="w-3 h-3" />
                <span>{showRawOcr ? 'Hide raw OCR text' : 'Inspect raw OCR text'}</span>
              </button>
            </div>
          </div>

          {showRawOcr && (
            <div className="p-2.5 rounded-[4px] bg-black/60 border border-zinc-800 text-left">
              <span className="block font-mono text-[10px] uppercase text-zinc-400 mb-1">
                Raw OCR Text (Troubleshooting):
              </span>
              <pre className="font-mono text-[11px] text-zinc-300 whitespace-pre-wrap max-h-28 overflow-y-auto">
                {extraction.rawOcrText || '(No raw text detected)'}
              </pre>
            </div>
          )}

          {/* Duplicate Pallet Label Warning (Does NOT auto-reject since separate pallets can have identical labels) */}
          {previousIdenticalScans.length > 0 && (
            <div className="p-3 rounded-[5px] bg-amber-950/70 border border-amber-500/50 text-amber-200 text-xs flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <span className="font-semibold text-amber-300 block">
                  Previously Scanned Label Warning ({previousIdenticalScans.length}x)
                </span>
                <p className="text-[11px] text-amber-200/90 mt-0.5 leading-snug">
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
            {/* Field 1: Extracted Part Number (Treated strictly as string to preserve leading zeros & hyphens) */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label
                  htmlFor="ocr-label-part-number-input"
                  className="text-[11px] font-mono uppercase tracking-wider text-zinc-300 font-semibold"
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
                    className="h-6 px-1.5 rounded bg-zinc-800 border border-zinc-700 text-[10px] font-mono text-emerald-300 outline-none cursor-pointer"
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
                className={`w-full h-10 px-3 bg-[#0F0F0E] border rounded-[5px] font-mono text-sm font-bold text-white outline-none ${
                  evaluation.matchedPart
                    ? 'border-emerald-500/70 focus:border-emerald-400'
                    : 'border-red-500/70 focus:border-red-400'
                }`}
              />

              {/* If unmatched or uncertain, show close candidate suggestions from docket */}
              {!evaluation.matchedPart && evaluation.candidateParts.length > 0 && (
                <div className="mt-1.5 p-2 rounded bg-zinc-900 border border-zinc-700">
                  <span className="block text-[10px] font-mono text-amber-300 mb-1">
                    Similar part numbers on docket (tap to select — never auto-confirmed):
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {evaluation.candidateParts.map((cand) => (
                      <button
                        key={cand.id}
                        type="button"
                        onClick={() => handleSelectCandidatePart(cand)}
                        className="px-2 py-1 rounded bg-zinc-800 hover:bg-emerald-950 border border-zinc-600 hover:border-emerald-500 font-mono text-xs text-white cursor-pointer"
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
                className="block text-[11px] font-mono uppercase tracking-wider text-zinc-300 font-semibold mb-1"
              >
                2. Extracted Description
              </label>
              <input
                id="ocr-label-description-input"
                type="text"
                value={descriptionInput}
                onChange={(e) => setDescriptionInput(e.target.value)}
                placeholder="Part description from label"
                className="w-full h-9 px-3 bg-[#0F0F0E] border border-zinc-700 focus:border-emerald-400 rounded-[5px] text-xs text-white outline-none"
              />
            </div>

            {/* Field 3: Extracted Pallet Quantity */}
            <div>
              <label
                htmlFor="ocr-label-quantity-input"
                className="block text-[11px] font-mono uppercase tracking-wider text-zinc-300 font-semibold mb-1"
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
                  className="w-10 h-10 rounded-[5px] bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-white flex items-center justify-center cursor-pointer shrink-0"
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
                  className="flex-1 h-10 px-3 bg-[#0F0F0E] border border-zinc-700 focus:border-emerald-400 rounded-[5px] font-mono text-lg font-bold text-white text-center outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    const curr = parseInt(quantityInput, 10) || 0;
                    setQuantityInput(String(curr + 1));
                    setValidationError(null);
                  }}
                  className="w-10 h-10 rounded-[5px] bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-white flex items-center justify-center cursor-pointer shrink-0"
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
              className={`p-3 rounded-[6px] border ${
                isGreen
                  ? 'bg-emerald-950/50 border-emerald-500/40'
                  : 'bg-amber-950/50 border-amber-500/40'
              }`}
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Layers className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="font-mono text-xs font-bold text-white truncate">
                    Matched: {evaluation.matchedPart.partNumber}
                  </span>
                </div>
                <span className="px-1.5 py-0.5 rounded bg-black/40 font-mono text-[10px] text-zinc-300 shrink-0">
                  Docket No. {evaluation.matchedPart.itemNumber}
                </span>
              </div>

              <p className="text-xs text-zinc-300 truncate mb-2.5">
                {evaluation.matchedPart.description}
              </p>

              {/* Cumulative Quantity Math Box: Prior + This Pallet = New Total / Expected */}
              <div className="grid grid-cols-3 gap-2 p-2 rounded bg-black/40 border border-white/10 text-center font-mono">
                <div>
                  <span className="block text-[9px] uppercase text-zinc-400">
                    Prior Scanned
                  </span>
                  <span className="text-sm font-bold text-zinc-200">
                    {evaluation.existingScannedQty}
                  </span>
                </div>
                <div>
                  <span className="block text-[9px] uppercase text-zinc-400">
                    This Pallet
                  </span>
                  <span className="text-sm font-bold text-emerald-400">
                    +{evaluation.addedPalletQty}
                  </span>
                </div>
                <div>
                  <span className="block text-[9px] uppercase text-zinc-400">
                    Total / Expected
                  </span>
                  <span
                    className={`text-sm font-bold ${
                      isGreen ? 'text-emerald-400' : 'text-amber-400'
                    }`}
                  >
                    {evaluation.newTotalScannedQty} / {evaluation.expectedQty}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-3 rounded-[6px] bg-red-950/50 border border-red-500/40 text-xs text-red-200">
              <div className="flex items-center gap-1.5 font-semibold text-red-300 mb-1">
                <XCircle className="w-4 h-4 shrink-0" />
                <span>No Exact Match on Compiled Parts List</span>
              </div>
              <p className="text-[11px] leading-snug">
                Part number <strong className="font-mono">{partNumberInput || '—'}</strong> was not
                found on this delivery docket. Edit the part number above if OCR misread a character,
                or log this label as an Unexpected Part.
              </p>
            </div>
          )}

          {validationError && (
            <p className="text-xs text-red-400 font-medium">{validationError}</p>
          )}

          {/* Action Buttons */}
          <div className="pt-2 flex flex-col gap-2">
            {evaluation.matchedPart ? (
              <button
                type="submit"
                className={`w-full h-11 px-4 rounded-[5px] font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer transition-colors shadow-lg ${
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
                className="w-full h-10 px-4 rounded-[5px] bg-red-600 hover:bg-red-700 text-white font-semibold text-xs flex items-center justify-center gap-2 cursor-pointer transition-colors"
              >
                <FileText className="w-4 h-4" />
                <span>Record as Unexpected Part (Red)</span>
              </button>
            )}

            <button
              type="button"
              onClick={onCancel}
              className="w-full h-9 px-4 rounded-[5px] border border-zinc-700 bg-transparent hover:bg-zinc-800 text-zinc-300 font-medium text-xs cursor-pointer transition-colors"
            >
              Retake / Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
