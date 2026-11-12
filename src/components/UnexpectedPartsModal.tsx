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
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
      <div className="w-full max-w-lg bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] rounded-2xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden animate-in fade-in zoom-in-95 duration-150 text-[var(--pt-text,#FFFFFF)]">
        {/* Header */}
        <div className="p-4 border-b border-[var(--pt-border,#29243D)] flex items-center justify-between gap-3 bg-[var(--pt-bg-secondary,#101321)]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#EF4444]/15 text-[#EF4444] border border-[#EF4444]/40 flex items-center justify-center">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-[var(--pt-text,#FFFFFF)]">
                Unexpected Parts Discrepancies
              </h3>
              <p className="text-xs text-[var(--pt-text-secondary,#A3A8BD)]">
                Parts scanned that do not match docket {delivery.docketNumber}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 rounded-lg text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[var(--pt-text,#FFFFFF)] cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {unexpectedList.length === 0 ? (
            <div className="py-10 text-center text-[var(--pt-text-secondary,#A3A8BD)]">
              <CheckCircle2 className="w-8 h-8 text-[#00D979] mx-auto mb-2" />
              <p className="text-sm font-semibold text-[var(--pt-text,#FFFFFF)]">No Unexpected Parts</p>
              <p className="text-xs text-[var(--pt-text-secondary,#A3A8BD)] mt-0.5">
                All scanned parts correspond to valid lines on this docket.
              </p>
            </div>
          ) : (
            unexpectedList.map((item) => (
              <div
                key={item.id}
                className={`p-3.5 rounded-xl border transition-all ${
                  item.resolved
                    ? 'bg-[var(--pt-bg,#080B12)]/60 border-[var(--pt-border,#29243D)] opacity-75'
                    : 'bg-[var(--pt-bg-secondary,#101321)] border-[#EF4444]/40 shadow-xs'
                }`}
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-6 h-6 rounded bg-[#EF4444]/15 text-[#EF4444] border border-[#EF4444]/40 flex items-center justify-center text-xs font-mono flex-shrink-0">
                      {item.codeType === 'qr' ? (
                        <QrCode className="w-3.5 h-3.5" />
                      ) : (
                        <Barcode className="w-3.5 h-3.5" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <span className="font-mono font-bold text-sm text-[var(--pt-text,#FFFFFF)] block truncate">
                        {item.code}
                      </span>
                      <span className="text-[10px] text-[var(--pt-text-secondary,#A3A8BD)] font-mono">
                        Scanned at {new Date(item.scannedAt).toLocaleTimeString()} ({item.codeType.toUpperCase()})
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => handleResolve(item.id)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-mono font-semibold transition-all cursor-pointer ${
                        item.resolved
                          ? 'bg-[#00D979]/15 text-[#00D979] border border-[#00D979]/40'
                          : 'bg-[var(--pt-bg,#080B12)] hover:bg-[var(--pt-hover-bg)] border border-[var(--pt-border,#29243D)] text-[var(--pt-text-secondary,#A3A8BD)]'
                      }`}
                    >
                      {item.resolved ? 'Resolved' : 'Mark Resolved'}
                    </button>
                    <button
                      onClick={() => handleRemove(item.id)}
                      className="p-1 rounded text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[#EF4444] cursor-pointer"
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
                  className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--pt-input-bg,#080B12)] border border-[var(--pt-border,#29243D)] text-xs text-[var(--pt-text,#FFFFFF)] placeholder:text-[var(--pt-text-muted,#737B94)] focus:border-[var(--pt-primary,#A020F0)] outline-none"
                />
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-[var(--pt-border,#29243D)] bg-[var(--pt-bg-secondary,#101321)] flex items-center justify-between text-xs text-[var(--pt-text-secondary,#A3A8BD)]">
          <span>{unexpectedList.length} recorded unexpected items</span>
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
