import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X, Ban, ShieldAlert, Layers, Hash, Calendar, CheckCircle2 } from 'lucide-react';

export interface DuplicateScanModalData {
  partNumber: string;
  description: string;
  code: string;
  itemNumber?: string;
  palletNumber?: string | number;
  scannedAt?: string;
  receivedQuantity?: number;
}

interface DuplicateScanModalProps {
  data: DuplicateScanModalData;
  onDismiss: () => void;
}

export const DuplicateScanModal: React.FC<DuplicateScanModalProps> = ({ data, onDismiss }) => {
  // Trap Escape, Enter, and Space keys to dismiss cleanly
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onDismiss]);

  // Lock background scrolling while warning is visible
  useEffect(() => {
    const origOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = origOverflow;
    };
  }, []);

  const formattedScannedTime = data.scannedAt
    ? (() => {
        try {
          return new Date(data.scannedAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
        } catch {
          return null;
        }
      })()
    : null;

  return createPortal(
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="duplicate-scan-title"
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-in fade-in duration-150"
      onClick={onDismiss}
    >
      <div
        className="relative w-full max-w-md bg-[#160609] border-2 border-red-500 rounded-3xl shadow-[0_0_60px_rgba(239,68,68,0.45)] overflow-hidden text-white animate-in zoom-in-95 duration-150 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Animated Red Warning Banner / Laser Strip at Top */}
        <div className="h-2.5 w-full bg-gradient-to-r from-red-600 via-rose-500 to-red-600 shadow-[0_0_15px_#ef4444]" />

        {/* Modal Content */}
        <div className="p-6 sm:p-7 flex flex-col items-center text-center space-y-4">
          {/* Prominent Red Warning Icon with Pulsing Halo */}
          <div className="relative">
            <div className="absolute -inset-2 rounded-3xl bg-red-600/30 blur-md animate-pulse" />
            <div className="relative w-18 h-18 rounded-2xl bg-gradient-to-b from-red-950 to-red-900 border-2 border-red-500 text-red-400 flex items-center justify-center shadow-[0_0_30px_rgba(239,68,68,0.6)]">
              <ShieldAlert className="w-10 h-10 stroke-[2.2] text-red-300" />
            </div>
          </div>

          {/* Warning Header */}
          <div className="space-y-1.5 w-full">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-950/90 border border-red-500/60 text-red-300 font-mono text-xs font-bold uppercase tracking-wider shadow-inner">
              <Ban className="w-3.5 h-3.5 text-red-400" />
              <span>Duplicate Part Rejected</span>
            </div>
            <h2
              id="duplicate-scan-title"
              className="text-2xl sm:text-3xl font-extrabold font-mono tracking-wider text-red-400 uppercase drop-shadow-[0_2px_10px_rgba(239,68,68,0.5)]"
            >
              DUPLICATE SCAN
            </h2>
          </div>

          {/* Exact Required Message */}
          <p className="text-base sm:text-lg font-bold text-white leading-snug max-w-xs">
            This part has already been scanned into this delivery.
          </p>

          {/* Part Identification Box (Red Warning Styling) */}
          <div className="w-full bg-red-950/40 border border-red-500/40 rounded-2xl p-4 text-left space-y-3 shadow-inner">
            {/* Part Number */}
            <div>
              <div className="text-[10px] font-mono uppercase tracking-wider text-red-300/80 font-bold mb-0.5">
                Part Number
              </div>
              <div className="text-xl sm:text-2xl font-mono font-black text-white tracking-wide break-all drop-shadow-sm">
                {data.partNumber}
              </div>
            </div>

            {/* Part Description */}
            {data.description ? (
              <div className="pt-2 border-t border-red-500/20">
                <div className="text-[10px] font-mono uppercase tracking-wider text-red-300/80 font-bold mb-0.5">
                  Description
                </div>
                <div className="text-sm font-sans text-red-100/90 font-medium leading-relaxed">
                  {data.description}
                </div>
              </div>
            ) : null}

            {/* Part Metadata Badges (Item / Line, Pallet, Prior Scan Time) */}
            <div className="pt-2 border-t border-red-500/20 flex flex-wrap items-center gap-2 text-xs font-mono">
              {data.itemNumber ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-red-900/60 text-red-200 border border-red-500/30">
                  <Hash className="w-3 h-3 text-red-400" />
                  No. {data.itemNumber.replace(/^ITM-0*/i, '')}
                </span>
              ) : null}
              {data.palletNumber ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-red-900/60 text-red-200 border border-red-500/30">
                  <Layers className="w-3 h-3 text-red-400" />
                  Pallet {data.palletNumber}
                </span>
              ) : null}
              {formattedScannedTime ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-red-900/60 text-red-200 border border-red-500/30">
                  <Calendar className="w-3 h-3 text-red-400" />
                  Scanned {formattedScannedTime}
                </span>
              ) : null}
            </div>
          </div>

          {/* Under-the-hood reassurance: No quantities or records modified */}
          <div className="text-[11px] font-mono text-red-300/80 flex items-center justify-center gap-1.5">
            <Ban className="w-3.5 h-3.5 text-red-400 shrink-0" />
            <span>Scan rejected · Delivery totals &amp; quantities unchanged</span>
          </div>

          {/* Unmistakable Dismiss Button */}
          <button
            type="button"
            autoFocus
            onClick={onDismiss}
            className="w-full h-13 rounded-2xl bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 active:scale-[0.98] text-white font-mono font-bold text-sm sm:text-base uppercase tracking-wider shadow-[0_0_30px_rgba(239,68,68,0.5)] transition-all cursor-pointer flex items-center justify-center gap-2.5 focus:outline-none focus:ring-4 focus:ring-red-500/40"
          >
            <X className="w-5 h-5 stroke-[2.5]" />
            <span>Dismiss</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
