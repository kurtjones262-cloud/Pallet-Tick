import React, { useState } from 'react';
import {
  AlertTriangle,
  QrCode,
  Barcode,
  X,
  CheckCircle2,
  Trash2,
} from 'lucide-react';
import { Delivery, UnexpectedPart } from '../types/delivery';
import { updateDelivery } from '../utils/storage';

interface UnexpectedPartsModalProps {
  delivery: Delivery | null;
  onClose: () => void;
  onUpdateDelivery: (updated: Delivery) => void;
}

export const UnexpectedPartsModal: React.FC<UnexpectedPartsModalProps> = ({
  delivery,
  onClose,
  onUpdateDelivery,
}) => {
  const [unexpectedList, setUnexpectedList] = useState<UnexpectedPart[]>(
    delivery?.unexpectedParts || []
  );

  if (!delivery) return null;

  const handleResolve = (id: string) => {
    const next = unexpectedList.map((item) =>
      item.id === id ? { ...item, resolved: !item.resolved } : item
    );
    setUnexpectedList(next);
    const updated: Delivery = { ...delivery, unexpectedParts: next };
    updateDelivery(updated);
    onUpdateDelivery(updated);
  };

  const handleRemove = (id: string) => {
    const next = unexpectedList.filter((item) => item.id !== id);
    setUnexpectedList(next);
    const updated: Delivery = { ...delivery, unexpectedParts: next };
    updateDelivery(updated);
    onUpdateDelivery(updated);
  };

  const handleUpdateNotes = (id: string, notes: string) => {
    const next = unexpectedList.map((item) => (item.id === id ? { ...item, notes } : item));
    setUnexpectedList(next);
    const updated: Delivery = { ...delivery, unexpectedParts: next };
    updateDelivery(updated);
    onUpdateDelivery(updated);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4">
      <div className="w-full max-w-lg bg-white border border-gray-200 rounded-2xl shadow-xl flex flex-col max-h-[85vh] overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="p-4 border-b border-gray-100 flex items-center justify-between gap-3 bg-white">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-red-50 text-red-600 border border-red-200 flex items-center justify-center">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-gray-900">Unexpected Parts Discrepancies</h3>
              <p className="text-xs text-gray-500">
                Parts scanned that do not match docket {delivery.docketNumber}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 rounded-lg text-gray-400 hover:text-gray-700 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {unexpectedList.length === 0 ? (
            <div className="py-10 text-center text-gray-500">
              <CheckCircle2 className="w-8 h-8 text-emerald-600 mx-auto mb-2" />
              <p className="text-sm font-semibold text-gray-900">No Unexpected Parts</p>
              <p className="text-xs text-gray-500 mt-0.5">
                All scanned parts correspond to valid lines on this docket.
              </p>
            </div>
          ) : (
            unexpectedList.map((item) => (
              <div
                key={item.id}
                className={`p-3.5 rounded-xl border transition-all ${
                  item.resolved
                    ? 'bg-gray-50 border-gray-200 opacity-70'
                    : 'bg-white border-red-200/90 shadow-xs'
                }`}
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-6 h-6 rounded bg-red-50 text-red-700 border border-red-200 flex items-center justify-center text-xs font-mono flex-shrink-0">
                      {item.codeType === 'qr' ? (
                        <QrCode className="w-3.5 h-3.5" />
                      ) : (
                        <Barcode className="w-3.5 h-3.5" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <span className="font-mono font-bold text-sm text-gray-900 block truncate">
                        {item.code}
                      </span>
                      <span className="text-[10px] text-gray-500 font-mono">
                        Scanned at {new Date(item.scannedAt).toLocaleTimeString()} ({item.codeType.toUpperCase()})
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => handleResolve(item.id)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                        item.resolved
                          ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                          : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                      }`}
                    >
                      {item.resolved ? 'Resolved' : 'Mark Resolved'}
                    </button>
                    <button
                      onClick={() => handleRemove(item.id)}
                      className="p-1 rounded text-gray-400 hover:text-red-600 cursor-pointer"
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <input
                  type="text"
                  value={item.notes || ''}
                  placeholder="Notes (e.g. Quarantined on Pallet 2, extra supplier spare)..."
                  onChange={(e) => handleUpdateNotes(item.id, e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg bg-gray-50 border border-gray-200 text-xs text-gray-800 placeholder:text-gray-400 focus:border-red-500 focus:bg-white outline-none"
                />
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-gray-100 bg-gray-50 flex items-center justify-between text-xs text-gray-500">
          <span>{unexpectedList.length} recorded unexpected items</span>
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
