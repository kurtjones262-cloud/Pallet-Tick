import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Database,
  ArrowRight,
  CheckCircle,
  AlertCircle,
  Loader2,
  X,
  ShieldCheck,
  HardDrive,
  Cloud,
} from 'lucide-react';
import { Delivery } from '../types/delivery.ts';
import { getStoredDeliveries } from '../utils/storage.ts';
import { getAllDeliveriesFromIndexedDb } from '../utils/indexedDb.ts';
import { apiFetchDeliveries, apiMigrateDeliveries } from '../services/palletTrackApi.ts';

interface DataMigrationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onMigrationComplete?: () => void;
}

interface LocalDeliveryCheck {
  delivery: Delivery;
  existsInCentral: boolean;
  selected: boolean;
}

export const DataMigrationModal: React.FC<DataMigrationModalProps> = ({
  isOpen,
  onClose,
  onMigrationComplete,
}) => {
  const [loading, setLoading] = useState(true);
  const [migrating, setMigrating] = useState(false);
  const [items, setItems] = useState<LocalDeliveryCheck[]>([]);
  const [migrationResult, setMigrationResult] = useState<{
    importedCount: number;
    skippedCount: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setMigrationResult(null);
      setError(null);
      return;
    }

    async function loadAndVerify() {
      setLoading(true);
      setError(null);
      try {
        // 1. Gather all local deliveries from both localStorage and IndexedDB
        const localFromStorage = getStoredDeliveries();
        const localFromIdb = await getAllDeliveriesFromIndexedDb().catch(() => []);

        const map = new Map<string, Delivery>();
        localFromStorage.forEach((d) => map.set(d.id, d));
        localFromIdb.forEach((d) => {
          if (!map.has(d.id)) map.set(d.id, d);
        });

        const allLocals = Array.from(map.values());

        // 2. Query central database to find existing IDs and dockets
        let centralDeliveries: Delivery[] = [];
        try {
          centralDeliveries = await apiFetchDeliveries();
        } catch (e: any) {
          console.warn('Central database query in migration preview:', e?.message);
        }

        const centralDocketSet = new Set(
          centralDeliveries.map((d) => (d.docketNumber || '').trim().toLowerCase())
        );
        const centralIdSet = new Set(centralDeliveries.map((d) => d.id));

        const checks: LocalDeliveryCheck[] = allLocals.map((d) => {
          const exists =
            centralIdSet.has(d.id) ||
            centralDocketSet.has((d.docketNumber || '').trim().toLowerCase());
          return {
            delivery: d,
            existsInCentral: exists,
            selected: !exists, // select only new ones by default
          };
        });

        setItems(checks);
      } catch (err: any) {
        setError(err?.message || 'Failed to inspect local deliveries');
      } finally {
        setLoading(false);
      }
    }

    loadAndVerify();
  }, [isOpen]);

  if (!isOpen) return null;

  const newDeliveriesCount = items.filter((i) => !i.existsInCentral).length;
  const alreadySyncedCount = items.filter((i) => i.existsInCentral).length;

  const handleToggleSelect = (id: string) => {
    setItems((prev) =>
      prev.map((i) =>
        i.delivery.id === id && !i.existsInCentral ? { ...i, selected: !i.selected } : i
      )
    );
  };

  const handleSelectAllNew = () => {
    setItems((prev) =>
      prev.map((i) => (!i.existsInCentral ? { ...i, selected: true } : i))
    );
  };

  const handleMigrate = async () => {
    const toMigrate = items.filter((i) => i.selected && !i.existsInCentral).map((i) => i.delivery);
    if (toMigrate.length === 0) return;

    setMigrating(true);
    setError(null);
    try {
      const res = await apiMigrateDeliveries(toMigrate);
      setMigrationResult({
        importedCount: res.importedCount,
        skippedCount: res.skippedCount,
      });
      // Refresh items list
      setItems((prev) =>
        prev.map((i) =>
          toMigrate.some((m) => m.id === i.delivery.id)
            ? { ...i, existsInCentral: true, selected: false }
            : i
        )
      );
      if (onMigrationComplete) {
        onMigrationComplete();
      }
    } catch (e: any) {
      setError(e?.message || 'Migration to central database failed.');
    } finally {
      setMigrating(false);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-[#0D1117] border border-cyan-800/60 rounded-xl shadow-2xl flex flex-col max-h-[88vh] overflow-hidden text-zinc-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-[#161B22] px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-cyan-950/80 border border-cyan-700/50 flex items-center justify-center text-cyan-400">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white tracking-wide">
                Central Database Migration
              </h2>
              <p className="text-xs text-zinc-400">
                Safely migrate on-device records into Cloudflare D1
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white p-1 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto space-y-4">
          {/* Safeguard Notice */}
          <div className="bg-cyan-950/30 border border-cyan-800/40 rounded-lg p-3.5 flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
            <div className="text-xs text-zinc-300 space-y-1">
              <p className="font-semibold text-cyan-300">Safe Multi-Device Transition</p>
              <p>
                To avoid overwriting conflicting records across devices, deliveries already in the
                central database are preserved. Local storage & IndexedDB data are never deleted.
              </p>
            </div>
          </div>

          {error && (
            <div className="bg-red-950/50 border border-red-500/50 text-red-200 text-xs p-3 rounded-lg flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {migrationResult && (
            <div className="bg-emerald-950/40 border border-emerald-500/50 text-emerald-200 text-xs p-3.5 rounded-lg flex items-start gap-2.5">
              <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-emerald-100">Migration Successful!</p>
                <p>
                  Imported {migrationResult.importedCount} delivery record(s) into the central
                  database. {migrationResult.skippedCount} existing record(s) kept safely.
                </p>
              </div>
            </div>
          )}

          {/* Stats Bar */}
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="bg-[#161B22] p-3 rounded-lg border border-zinc-800 flex items-center justify-between">
              <span className="text-zinc-400 flex items-center gap-1.5">
                <HardDrive className="w-4 h-4 text-amber-400" /> Ready to Import:
              </span>
              <span className="font-bold font-mono text-cyan-300 text-sm">
                {newDeliveriesCount}
              </span>
            </div>
            <div className="bg-[#161B22] p-3 rounded-lg border border-zinc-800 flex items-center justify-between">
              <span className="text-zinc-400 flex items-center gap-1.5">
                <Cloud className="w-4 h-4 text-emerald-400" /> Already Synced:
              </span>
              <span className="font-bold font-mono text-emerald-400 text-sm">
                {alreadySyncedCount}
              </span>
            </div>
          </div>

          {/* Deliveries List Preview */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-zinc-400 font-semibold px-1">
              <span>Local Delivery Records ({items.length})</span>
              {newDeliveriesCount > 0 && (
                <button
                  type="button"
                  onClick={handleSelectAllNew}
                  className="text-cyan-400 hover:text-cyan-300 underline"
                >
                  Select All New
                </button>
              )}
            </div>

            {loading ? (
              <div className="py-8 flex flex-col items-center justify-center text-zinc-400 text-xs gap-2">
                <Loader2 className="w-6 h-6 animate-spin text-cyan-400" />
                <span>Checking records against central database...</span>
              </div>
            ) : items.length === 0 ? (
              <div className="py-8 text-center text-zinc-500 text-xs">
                No local delivery records found.
              </div>
            ) : (
              <div className="space-y-2 max-h-[36vh] overflow-y-auto pr-1">
                {items.map(({ delivery: d, existsInCentral, selected }) => (
                  <div
                    key={d.id}
                    onClick={() => !existsInCentral && handleToggleSelect(d.id)}
                    className={`p-3 rounded-lg border transition-all text-xs flex items-center justify-between ${
                      existsInCentral
                        ? 'bg-zinc-900/40 border-zinc-800/80 opacity-70 cursor-not-allowed'
                        : selected
                        ? 'bg-cyan-950/30 border-cyan-500/70 cursor-pointer'
                        : 'bg-zinc-900/60 border-zinc-800 cursor-pointer hover:border-zinc-700'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={existsInCentral}
                        onChange={() => {}}
                        className="rounded border-zinc-700 text-cyan-500 focus:ring-0 shrink-0"
                      />
                      <div className="truncate">
                        <div className="font-bold font-mono text-zinc-100 truncate">
                          {d.docketNumber}
                        </div>
                        <div className="text-[11px] text-zinc-400 truncate">
                          {d.supplier} · {d.deliveryDate} · {d.parts?.length || 0} parts
                        </div>
                      </div>
                    </div>

                    <div className="shrink-0 ml-2">
                      {existsInCentral ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-500/40 text-[10px] text-emerald-300 font-mono">
                          <CheckCircle className="w-3 h-3" /> Synced
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-cyan-950/60 border border-cyan-500/40 text-[10px] text-cyan-300 font-mono">
                          Ready
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="bg-[#161B22] px-5 py-3.5 border-t border-zinc-800 flex items-center justify-between">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-zinc-400 hover:text-white transition-colors"
          >
            Close
          </button>

          <button
            type="button"
            onClick={handleMigrate}
            disabled={migrating || loading || newDeliveriesCount === 0}
            className="px-5 py-2.5 rounded-lg text-xs font-bold text-white bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 transition-colors shadow-lg"
          >
            {migrating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Migrating Records...</span>
              </>
            ) : (
              <>
                <span>Verify & Migrate to Central DB</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
