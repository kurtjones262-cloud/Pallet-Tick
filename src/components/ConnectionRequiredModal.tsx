import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { WifiOff, RefreshCw, AlertTriangle, X } from 'lucide-react';
import { checkBackendConnection } from '../services/palletTrackApi.ts';

interface ConnectionRequiredModalProps {
  isOpen: boolean;
  onDismiss: () => void;
  onConnected?: () => void;
}

export const ConnectionRequiredModal: React.FC<ConnectionRequiredModalProps> = ({
  isOpen,
  onDismiss,
  onConnected,
}) => {
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleRetry = async () => {
    setIsRetrying(true);
    setRetryError(null);
    try {
      const health = await checkBackendConnection();
      if (health.connected) {
        if (onConnected) onConnected();
        onDismiss();
      } else {
        setRetryError(health.error || 'Could not establish connection to the central database.');
      }
    } catch (e: any) {
      setRetryError(e?.message || 'Network check failed.');
    } finally {
      setIsRetrying(false);
    }
  };

  return createPortal(
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="conn-req-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-md p-4 animate-fade-in"
      onClick={onDismiss}
    >
      <div
        className="w-full max-w-md bg-[#130E07] border-2 border-amber-600/80 rounded-xl shadow-2xl overflow-hidden text-amber-50"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-amber-950 via-amber-900 to-amber-950 px-5 py-4 border-b border-amber-600/50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0">
              <WifiOff className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h2
                id="conn-req-title"
                className="text-base font-bold text-amber-200 tracking-wider uppercase font-mono"
              >
                Connection Required
              </h2>
              <p className="text-xs text-amber-300/80">Central Database Offline</p>
            </div>
          </div>
          <button
            onClick={onDismiss}
            className="text-amber-400/70 hover:text-amber-200 p-1.5 rounded-lg transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          <div className="bg-amber-950/40 border border-amber-600/30 rounded-lg p-3.5 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-200 space-y-1 leading-relaxed">
              <p className="font-semibold text-amber-100">
                Online connection required for receiving
              </p>
              <p>
                PartTrack operates on a centralized database to coordinate warehouse operations.
                Scans cannot be recorded while disconnected to prevent conflicting or lost data.
              </p>
            </div>
          </div>

          {retryError && (
            <div className="bg-red-950/40 border border-red-500/40 text-red-200 text-xs p-3 rounded-lg font-mono">
              {retryError}
            </div>
          )}

          <div className="text-xs text-zinc-400 leading-relaxed space-y-1">
            <p>• Scanned quantity has not been recorded.</p>
            <p>• Delivery totals remain unchanged.</p>
            <p>• You may retry once network connectivity is restored.</p>
          </div>
        </div>

        {/* Footer */}
        <div className="bg-[#0B0804] px-5 py-3.5 border-t border-amber-900/60 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onDismiss}
            className="px-4 py-2.5 rounded-lg text-xs font-semibold text-zinc-300 hover:text-white bg-zinc-800/80 hover:bg-zinc-700 transition-colors"
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={handleRetry}
            disabled={isRetrying}
            className="px-5 py-2.5 rounded-lg text-xs font-bold text-amber-950 bg-amber-400 hover:bg-amber-300 active:bg-amber-500 flex items-center gap-1.5 transition-colors shadow-lg"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
            <span>{isRetrying ? 'Checking Connection...' : 'Retry Connection'}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
