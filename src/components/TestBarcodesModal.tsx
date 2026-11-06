import React, { useState } from 'react';
import {
  Sparkles,
  QrCode,
  Barcode,
  Layers,
  Printer,
  X,
  AlertTriangle,
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
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 print:p-0 print:bg-white print:fixed print:inset-0">
      <div className="w-full max-w-4xl max-h-[90vh] bg-white border border-gray-200 rounded-2xl shadow-xl flex flex-col overflow-hidden print:max-h-none print:border-none print:bg-white print:text-black animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="p-4 border-b border-gray-100 flex items-center justify-between gap-3 bg-white print:hidden">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-50 text-amber-600 border border-amber-200/60 flex items-center justify-center">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-gray-900">QR & Barcode Test Sheet</h3>
              <p className="text-xs text-gray-500">
                Aim phone camera at these codes or tap &quot;Scan&quot; to test the verification pipeline
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handlePrint}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-medium transition-all cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Print Sheet</span>
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-gray-400 hover:text-gray-700 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Pallet Select & Discrepancy Simulator */}
        <div className="p-3 bg-gray-50 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2 print:hidden">
          <div className="flex items-center gap-1.5 text-xs text-gray-600">
            <Layers className="w-3.5 h-3.5 text-emerald-600" />
            <span className="font-medium">Filter Pallet:</span>
            <select
              value={selectedPallet}
              onChange={(e) => setSelectedPallet(e.target.value)}
              className="px-2.5 py-1 bg-white border border-gray-200 rounded-md text-xs text-gray-800 font-medium outline-none cursor-pointer"
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
            className="px-2.5 py-1 rounded-md bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 font-medium text-xs flex items-center gap-1 cursor-pointer transition-colors"
          >
            <AlertTriangle className="w-3 h-3 text-red-500" />
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
                      ? 'bg-gray-50/60 border-gray-200'
                      : 'bg-white border-gray-200/90 shadow-xs'
                  } print:bg-white print:border-gray-300`}
                >
                  <div className="flex items-start justify-between gap-1 mb-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 font-mono font-bold text-[10px]">
                          No. {docketNo}
                        </span>
                        <span className="font-mono font-bold text-xs text-gray-900 truncate">
                          {part.partNumber}
                        </span>
                      </div>
                      <span className="font-mono text-[11px] text-gray-500 block truncate mt-0.5">
                        Barcode: {partBarcodeValue} (Docket No. {docketNo})
                      </span>
                    </div>

                    {isReceived && (
                      <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-semibold flex-shrink-0">
                        Received
                      </span>
                    )}
                  </div>

                  {/* QR & Barcode SVGs */}
                  <div className="grid grid-cols-2 gap-2 my-2 bg-gray-50/70 p-2 rounded-lg border border-gray-100">
                    <div className="bg-white p-1.5 rounded flex flex-col items-center justify-center shadow-xs">
                      <div
                        className="w-full flex justify-center"
                        dangerouslySetInnerHTML={{
                          __html: generateQrSvg(part.partNumber, 90),
                        }}
                      />
                      <span className="text-[9px] font-mono text-gray-600 font-semibold mt-1">
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
                      <span className="text-[9px] font-mono text-gray-600 font-semibold mt-1">
                        {partBarcodeValue} → No. {docketNo}
                      </span>
                    </div>
                  </div>

                  {/* Simulation Buttons */}
                  <div className="flex items-center justify-end gap-1.5 pt-1.5 border-t border-gray-100 print:hidden">
                    <button
                      onClick={() => {
                        onSimulateScan(part.partNumber);
                        onClose();
                      }}
                      className="px-2 py-1 rounded bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-[11px] font-medium border border-emerald-200 flex items-center gap-1 cursor-pointer"
                      title="Simulate QR scan"
                    >
                      <QrCode className="w-3 h-3" />
                      <span>Scan QR</span>
                    </button>

                    <button
                      onClick={() => {
                        onSimulateScan(partBarcodeValue);
                        onClose();
                      }}
                      className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200 text-gray-700 text-[11px] font-medium border border-gray-200 flex items-center gap-1 cursor-pointer"
                      title={`Simulate Barcode scan (${partBarcodeValue} -> No. ${docketNo})`}
                    >
                      <Barcode className="w-3 h-3" />
                      <span>Scan {partBarcodeValue}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-gray-100 bg-gray-50 flex items-center justify-between text-xs text-gray-500 print:hidden">
          <span className="font-mono text-[11px]">
            Labels for {delivery?.docketNumber}
          </span>
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-lg bg-gray-900 hover:bg-gray-800 text-white font-medium cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
