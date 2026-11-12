import React, { useState } from 'react';
import {
  Sparkles,
  QrCode,
  Barcode,
  Layers,
  Printer,
  X,
  AlertTriangle,
  FileText,
} from 'lucide-react';
import { Delivery } from '../types/delivery';
import { generateCode128Svg, generateQrSvg } from '../utils/codeRenderer';

interface TestBarcodesModalProps {
  delivery: Delivery | null;
  onClose: () => void;
  onSimulateScan: (code: string) => void;
}

export const TestBarcodesModal: React.FC<TestBarcodesModalProps> = ({
  delivery,
  onClose,
  onSimulateScan,
}) => {
  const [selectedPallet, setSelectedPallet] = useState<string>('all');

  const parts = delivery?.parts || [];

  const pallets = React.useMemo(() => {
    const set = new Set<string>();
    parts.forEach((p) => {
      if (p.palletNumber) set.add(String(p.palletNumber));
    });
    return Array.from(set).sort();
  }, [parts]);

  const displayParts = React.useMemo(() => {
    if (selectedPallet === 'all') {
      return parts.slice(0, 24);
    }
    return parts.filter((p) => String(p.palletNumber) === selectedPallet).slice(0, 24);
  }, [parts, selectedPallet]);

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 print:p-0 print:bg-white print:fixed print:inset-0">
      <div className="w-full max-w-4xl max-h-[90vh] bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] rounded-2xl shadow-2xl flex flex-col overflow-hidden print:max-h-none print:border-none print:bg-white print:text-black animate-in fade-in zoom-in-95 duration-150 text-[var(--pt-text,#FFFFFF)]">
        {/* Header */}
        <div className="p-4 border-b border-[var(--pt-border,#29243D)] flex items-center justify-between gap-3 bg-[var(--pt-card,#15182A)] print:hidden">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[var(--pt-bg,#080B12)] text-[var(--pt-primary-light,#C084FC)] border border-[var(--pt-border,#29243D)] flex items-center justify-center">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-[var(--pt-text,#FFFFFF)]">
                QR, Barcode &amp; Pallet Label Test Sheet
              </h3>
              <p className="text-xs text-[var(--pt-text-secondary,#A3A8BD)]">
                Aim phone camera at these codes or tap &quot;Scan&quot; / &quot;OCR Label&quot; to test verification
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handlePrint}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--pt-bg,#080B12)] hover:bg-[var(--pt-hover-bg)] border border-[var(--pt-border,#29243D)] text-[var(--pt-text,#FFFFFF)] text-xs font-mono font-semibold transition-all cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Print Sheet</span>
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[var(--pt-text,#FFFFFF)] cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Pallet Select & Discrepancy Simulator */}
        <div className="p-3 bg-[var(--pt-bg,#080B12)] border-b border-[var(--pt-border,#29243D)] flex flex-wrap items-center justify-between gap-2 print:hidden">
          <div className="flex items-center gap-1.5 text-xs text-[var(--pt-text-secondary,#A3A8BD)]">
            <Layers className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)]" />
            <span className="font-medium">Filter Pallet:</span>
            <select
              value={selectedPallet}
              onChange={(e) => setSelectedPallet(e.target.value)}
              className="px-2.5 py-1 bg-[var(--pt-input-bg,#080B12)] border border-[var(--pt-border,#29243D)] rounded-md text-xs text-[var(--pt-text,#FFFFFF)] font-mono font-semibold outline-none cursor-pointer"
            >
              <option value="all">All Pallets</option>
              {pallets.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          <button
            onClick={() => {
              onSimulateScan('UNEXPECTED-STEEL-99X');
              onClose();
            }}
            className="px-2.5 py-1 rounded-md bg-[#EF4444]/15 hover:bg-[#EF4444]/25 text-[#EF4444] border border-[#EF4444]/40 font-mono font-semibold text-xs flex items-center gap-1 cursor-pointer transition-colors"
          >
            <AlertTriangle className="w-3 h-3 text-[#EF4444]" />
            <span>Test Unexpected Code</span>
          </button>
        </div>

        {/* Barcode Grid */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 print:p-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {displayParts.map((part, idx) => {
              const isReceived = part.status === 'received';
              const rawNo = (part.itemNumber || '')
                .trim()
                .replace(/^(?:ITM|ITEM|LINE|NO|ROW|BC|BAR|LCR)[-_.\s#]*/i, '')
                .replace(/^0+(?=\d)/, '');
              const docketNo = /^\d+$/.test(rawNo)
                ? rawNo
                : String(part.docketLineIndex || idx + 1);
              const docketPrefix = (
                (delivery?.docketNumber || '482910').replace(/\D/g, '') + '482910'
              ).slice(0, 6);
              const partBarcodeValue = `${docketPrefix}-${docketNo}`;

              return (
                <div
                  key={part.id}
                  className={`p-3 rounded-xl border transition-all ${
                    isReceived
                      ? 'bg-[var(--pt-bg,#080B12)]/70 border-[var(--pt-border,#29243D)]'
                      : 'bg-[var(--pt-card,#15182A)] border-[var(--pt-border,#29243D)] shadow-xs'
                  } print:bg-white print:border-gray-300`}
                >
                  <div className="flex items-start justify-between gap-1 mb-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="px-1.5 py-0.5 rounded bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] text-[var(--pt-primary-light,#C084FC)] font-mono font-bold text-[10px]">
                          No. {docketNo}
                        </span>
                        <span className="font-mono font-bold text-xs text-[var(--pt-text,#FFFFFF)] truncate">
                          {part.partNumber}
                        </span>
                      </div>
                      <span className="font-mono text-[11px] text-[var(--pt-text-secondary,#A3A8BD)] block truncate mt-0.5">
                        Barcode: {partBarcodeValue} · Expected Qty: {Math.max(1, part.quantity ?? 1)}
                      </span>
                    </div>

                    {isReceived && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#00D979]/15 text-[#00D979] border border-[#00D979]/40 font-semibold flex-shrink-0">
                        Received
                      </span>
                    )}
                  </div>

                  {/* QR & Barcode SVGs (Kept white for optical contrast when scanning with phone camera) */}
                  <div className="grid grid-cols-2 gap-2 my-2 bg-[var(--pt-bg,#080B12)] p-2 rounded-lg border border-[var(--pt-border,#29243D)]">
                    <div className="bg-white p-1.5 rounded flex flex-col items-center justify-center shadow-xs">
                      <div
                        className="w-full flex justify-center"
                        dangerouslySetInnerHTML={{
                          __html: generateQrSvg(part.partNumber, 90),
                        }}
                      />
                      <span className="text-[9px] font-mono text-gray-800 font-semibold mt-1">
                        QR ({part.partNumber})
                      </span>
                    </div>

                    <div className="bg-white p-1.5 rounded flex flex-col items-center justify-center shadow-xs">
                      <div
                        className="w-full flex justify-center"
                        dangerouslySetInnerHTML={{
                          __html: generateCode128Svg(partBarcodeValue, 36, 1.4),
                        }}
                      />
                      <span className="text-[9px] font-mono text-gray-800 font-semibold mt-1">
                        {partBarcodeValue} → No. {docketNo}
                      </span>
                    </div>
                  </div>

                  {/* Simulation Buttons */}
                  <div className="flex flex-wrap items-center justify-end gap-1.5 pt-1.5 border-t border-[var(--pt-border,#29243D)] print:hidden">
                    <button
                      onClick={() => {
                        onSimulateScan(part.partNumber);
                        onClose();
                      }}
                      className="px-2 py-1 rounded bg-[#00D979]/15 hover:bg-[#00D979]/25 text-[#00D979] text-[11px] font-mono font-semibold border border-[#00D979]/40 flex items-center gap-1 cursor-pointer"
                      title="Simulate QR scan"
                    >
                      <QrCode className="w-3 h-3" />
                      <span>QR</span>
                    </button>

                    <button
                      onClick={() => {
                        onSimulateScan(partBarcodeValue);
                        onClose();
                      }}
                      className="px-2 py-1 rounded bg-[var(--pt-bg,#080B12)] hover:bg-[var(--pt-hover-bg)] text-[var(--pt-text,#FFFFFF)] text-[11px] font-mono font-semibold border border-[var(--pt-border,#29243D)] flex items-center gap-1 cursor-pointer"
                      title={`Simulate Barcode scan (${partBarcodeValue} -> No. ${docketNo})`}
                    >
                      <Barcode className="w-3 h-3" />
                      <span>{partBarcodeValue}</span>
                    </button>

                    <button
                      onClick={() => {
                        onClose();
                        window.dispatchEvent(
                          new CustomEvent('parttrack_simulate_ocr_label', {
                            detail: { partId: part.id },
                          })
                        );
                      }}
                      className="px-2 py-1 rounded bg-[#F59E0B]/15 hover:bg-[#F59E0B]/25 text-[#F59E0B] text-[11px] font-mono font-semibold border border-[#F59E0B]/40 flex items-center gap-1 cursor-pointer"
                      title="Simulate Offline OCR Pallet Label scan for this part"
                    >
                      <FileText className="w-3 h-3" />
                      <span>OCR Label</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-[var(--pt-border,#29243D)] bg-[var(--pt-card,#15182A)] flex items-center justify-between text-xs text-[var(--pt-text-secondary,#A3A8BD)] print:hidden">
          <span className="font-mono text-[11px]">
            Labels for {delivery?.docketNumber}
          </span>
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-lg pt-btn-primary font-mono font-bold text-xs cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
