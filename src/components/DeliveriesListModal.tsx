import React, { useState } from 'react';
import {
  Plus,
  Trash2,
  X,
  Archive,
  Loader2,
  Database,
} from 'lucide-react';
import { Delivery, UserRole } from '../types/delivery';
import {
  getStoredDeliveries,
  setActiveDeliveryId,
  deleteDelivery,
} from '../utils/storage';
import { exportDeliveryZip, exportAllDeliveriesBackupZip } from '../utils/zipExport';

interface DeliveriesListModalProps {
  activeDeliveryId: string | null;
  onSelectDelivery: (delivery: Delivery) => void;
  onOpenNewDelivery: () => void;
  onOpenMigration?: () => void;
  onClose: () => void;
  userRole?: UserRole;
}

export const DeliveriesListModal: React.FC<DeliveriesListModalProps> = ({
  activeDeliveryId,
  onSelectDelivery,
  onOpenNewDelivery,
  onOpenMigration,
  onClose,
  userRole,
}) => {
  const [deliveries, setDeliveries] = useState<Delivery[]>(getStoredDeliveries());
  const [filter, setFilter] = useState<'all' | 'receiving' | 'completed'>('all');
  const [exportingId, setExportingId] = useState<string | null>(null);

  const filtered = deliveries.filter((d) => {
    if (filter === 'all') return true;
    return d.status === filter;
  });

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('Delete this delivery and its scan history?')) {
      deleteDelivery(id);
      const remaining = getStoredDeliveries();
      setDeliveries(remaining);
      if (activeDeliveryId === id && remaining.length > 0) {
        onSelectDelivery(remaining[0]);
      }
    }
  };

  const handleExportZip = async (d: Delivery, e: React.MouseEvent) => {
    e.stopPropagation();
    setExportingId(d.id);
    try {
      await exportDeliveryZip(d);
    } catch (err) {
      console.error('Failed to export delivery zip:', err);
    } finally {
      setExportingId(null);
    }
  };

  const handleExportAllZip = async () => {
    setExportingId('all');
    try {
      await exportAllDeliveriesBackupZip();
    } catch (err) {
      console.error('Failed to export all deliveries backup zip:', err);
    } finally {
      setExportingId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-[var(--pt-bg-secondary,#101321)] border-t sm:border border-[var(--pt-border,#29243D)] rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[85dvh] overflow-hidden text-[var(--pt-text,#FFFFFF)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 bg-[var(--pt-card,#15182A)] border-b border-[var(--pt-border,#29243D)] flex items-center justify-between gap-3">
          <h3 className="font-mono font-bold text-sm uppercase tracking-wider text-[var(--pt-text,#FFFFFF)]">
            Deliveries
          </h3>

          <div className="flex items-center gap-2">
            {deliveries.length > 0 && (
              <button
                onClick={handleExportAllZip}
                disabled={exportingId === 'all'}
                className="h-7 px-2.5 inline-flex items-center gap-1 rounded-lg border border-[var(--pt-border,#29243D)] bg-[var(--pt-bg,#080B12)] hover:bg-[var(--pt-hover-bg)] text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[var(--pt-text,#FFFFFF)] text-xs font-mono font-semibold cursor-pointer transition-colors"
                title="Backup all deliveries as .zip archive"
              >
                {exportingId === 'all' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--pt-primary,#A020F0)]" />
                ) : (
                  <Archive className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)]" />
                )}
                <span className="hidden xs:inline">Backup .zip</span>
              </button>
            )}

            {onOpenMigration && (
              <button
                onClick={() => {
                  onClose();
                  onOpenMigration();
                }}
                className="h-7 px-2.5 inline-flex items-center gap-1 rounded-lg border border-[var(--pt-border,#29243D)] bg-[var(--pt-bg,#080B12)] hover:bg-[var(--pt-hover-bg)] text-[var(--pt-primary-light,#C084FC)] text-xs font-mono font-semibold cursor-pointer transition-colors"
                title="Migrate or sync local deliveries to central Cloudflare D1 database"
              >
                <Database className="w-3.5 h-3.5 text-[var(--pt-primary,#A020F0)]" />
                <span className="hidden xs:inline">D1 Sync</span>
              </button>
            )}

            {userRole !== 'employee' && userRole !== 'operator' && (
              <button
                onClick={() => {
                  onClose();
                  onOpenNewDelivery();
                }}
                className="h-7 px-2.5 inline-flex items-center gap-1 rounded-lg pt-btn-primary text-xs font-mono font-bold cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New docket</span>
              </button>
            )}

            <button
              onClick={onClose}
              className="p-1 text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[var(--pt-text,#FFFFFF)] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Underline Filter Tabs */}
        <div className="px-4 pt-2 bg-[var(--pt-bg-secondary,#101321)] border-b border-[var(--pt-border,#29243D)] flex items-center gap-5 text-xs font-mono">
          <button
            onClick={() => setFilter('all')}
            className={`pb-2 border-b-2 transition-colors cursor-pointer ${
              filter === 'all'
                ? 'border-[var(--pt-primary,#A020F0)] text-[var(--pt-text,#FFFFFF)] font-bold'
                : 'border-transparent text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[var(--pt-text,#FFFFFF)]'
            }`}
          >
            All <span className="font-mono text-[11px] text-[var(--pt-text-muted,#737B94)] ml-0.5">{deliveries.length}</span>
          </button>
          <button
            onClick={() => setFilter('receiving')}
            className={`pb-2 border-b-2 transition-colors cursor-pointer ${
              filter === 'receiving'
                ? 'border-[var(--pt-primary,#A020F0)] text-[var(--pt-text,#FFFFFF)] font-bold'
                : 'border-transparent text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[var(--pt-text,#FFFFFF)]'
            }`}
          >
            Receiving
          </button>
          <button
            onClick={() => setFilter('completed')}
            className={`pb-2 border-b-2 transition-colors cursor-pointer ${
              filter === 'completed'
                ? 'border-[var(--pt-primary,#A020F0)] text-[var(--pt-text,#FFFFFF)] font-bold'
                : 'border-transparent text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[var(--pt-text,#FFFFFF)]'
            }`}
          >
            Completed
          </button>
        </div>

        {/* Hairline List */}
        <div className="flex-1 overflow-y-auto bg-[var(--pt-card,#15182A)] divide-y divide-[var(--pt-border,#29243D)]">
          {filtered.length === 0 ? (
            <div className="py-14 px-6 text-center">
              <p className="text-xs font-semibold text-[var(--pt-text,#FFFFFF)]">No deliveries on file</p>
              <p className="text-[11px] text-[var(--pt-text-secondary,#A3A8BD)] mt-1 max-w-xs mx-auto leading-relaxed">
                Tap &quot;New docket&quot; above to photograph a paper packing slip, or upload an image or PDF.
              </p>
            </div>
          ) : (
            filtered.map((d) => {
              const parts = d.parts || [];
              const total = (d as any).stats?.totalParts ?? parts.length;
              const received =
                (d as any).stats?.receivedParts ??
                parts.filter((p) => p.status === 'received').length;
              const percent = total > 0 ? Math.round((received / total) * 100) : 0;
              const isActive = d.id === activeDeliveryId;

              return (
                <div
                  key={d.id}
                  onClick={() => {
                    setActiveDeliveryId(d.id);
                    onSelectDelivery(d);
                    onClose();
                  }}
                  className={`px-4 py-3 cursor-pointer transition-colors ${
                    isActive
                      ? 'bg-[var(--pt-bg,#080B12)]/80 border-l-2 border-l-[var(--pt-primary,#A020F0)]'
                      : 'hover:bg-[var(--pt-hover-bg)]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-xs font-bold text-[var(--pt-text,#FFFFFF)]">
                          {d.docketNumber}
                        </span>
                        {isActive && (
                          <span className="font-mono text-[10px] text-[var(--pt-primary-light,#C084FC)] font-semibold">
                            · Active
                          </span>
                        )}
                      </div>
                      <p className="text-xs font-medium text-[var(--pt-text-secondary,#A3A8BD)] mt-0.5 truncate">
                        {d.supplier}
                      </p>
                    </div>

                    <div className="flex items-center gap-2.5 shrink-0">
                      <span className="font-mono text-xs text-[var(--pt-text,#FFFFFF)] tabular-nums">
                        {received}/{total} ({percent}%)
                      </span>
                      <button
                        onClick={(e) => handleExportZip(d, e)}
                        disabled={exportingId === d.id}
                        className="p-1 text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[var(--pt-text,#FFFFFF)] transition-colors cursor-pointer"
                        title="Export delivery package (.zip)"
                      >
                        {exportingId === d.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--pt-primary,#A020F0)]" />
                        ) : (
                          <Archive className="w-3.5 h-3.5" />
                        )}
                      </button>
                      {userRole !== 'employee' && userRole !== 'operator' && (
                        <button
                          onClick={(e) => handleDelete(d.id, e)}
                          className="p-1 text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[#EF4444] transition-colors cursor-pointer"
                          title="Delete delivery"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="w-full h-[3px] bg-[var(--pt-bg,#080B12)] mt-2 overflow-hidden rounded-full">
                    <div
                      className="h-full bg-[var(--pt-primary,#A020F0)]"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
