import React, { useState, useMemo, useEffect } from 'react';
import {
  Search,
  Check,
  Printer,
  Edit3,
  Plus,
  Trash2,
  FileSpreadsheet,
  QrCode,
  Boxes,
  FileText,
  Activity,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Layers,
  Calendar,
  RotateCcw,
  Loader2,
  UserCheck,
  X,
} from 'lucide-react';
import {
  Delivery,
  DeliveryPart,
  PendingQuantityConfirmation,
  UserRole,
} from '../types/delivery';
import {
  updateDelivery,
  deleteDeliveryAuthoritative,
  getPartVerificationState,
} from '../utils/storage';
import { apiUpdateDelivery } from '../services/palletTrackApi';
import { exportDeliveryPdf, formatPartScannersSummary } from '../utils/pdfExport';
import { exportDeliveryCsv } from '../utils/csvExport';
import { filterPartsSmart, HighlightMatch } from '../utils/partSearch';
import { PartsListEditorModal, PartsEditorMode } from './PartsListEditorModal';
import { DocketPhotosModal } from './DocketPhotosModal';

interface ChecklistViewProps {
  delivery: Delivery | null;
  onUpdateDelivery: (updated: Delivery) => void;
  initialPalletFilter?: string;
  onClearPalletFilter?: () => void;
  onRequestPartQuantityConfirm?: (pending: PendingQuantityConfirmation) => void;
  onStartScanning?: () => void;
  onBackToOrders?: () => void;
  onNavigateToOrders?: () => void;
  onDeleteDelivery?: (id: string) => void;
  onOpenTestSheet?: () => void;
  onOpenUnexpectedModal?: () => void;
  onOpenNewDelivery?: () => void;
  userRole?: UserRole;
}

type OrderDetailsTab = 'parts' | 'pallets' | 'details' | 'activity';

export const ChecklistView: React.FC<ChecklistViewProps> = ({
  delivery,
  onUpdateDelivery,
  initialPalletFilter = 'all',
  onClearPalletFilter,
  onRequestPartQuantityConfirm,
  onStartScanning,
  onBackToOrders,
  onNavigateToOrders,
  onDeleteDelivery,
  userRole,
}) => {
  const canManageDeletion =
    userRole === 'super_admin' || userRole === 'admin' || userRole === 'supervisor';
  const handleBackToOrders = onBackToOrders || onNavigateToOrders;
  const [activeSubTab, setActiveSubTab] = useState<OrderDetailsTab>('parts');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'outstanding' | 'received' | 'mismatch'>(
    'all'
  );
  const [selectedPallet, setSelectedPallet] = useState<string>(initialPalletFilter || 'all');
  const [editorMode, setEditorMode] = useState<PartsEditorMode | null>(null);
  const [editingQtyPartId, setEditingQtyPartId] = useState<string | null>(null);
  const [inlineReceivedQty, setInlineReceivedQty] = useState<string>('');
  const [isDocketPhotosOpen, setIsDocketPhotosOpen] = useState(false);
  const [expandedAttributionPartId, setExpandedAttributionPartId] = useState<string | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [isDeletingDocket, setIsDeletingDocket] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isMarkingReviewed, setIsMarkingReviewed] = useState(false);

  useEffect(() => {
    if (initialPalletFilter) {
      setSelectedPallet(initialPalletFilter);
    }
  }, [initialPalletFilter]);

  const parts = delivery?.parts || [];

  const pallets = useMemo(() => {
    const set = new Set<string>();
    parts.forEach((p) => {
      if (p.palletNumber) set.add(String(p.palletNumber));
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [parts]);

  // Order summary metrics
  const orderStats = useMemo(() => {
    let totalLines = parts.length;
    let receivedLines = 0;
    let mismatchLines = 0;
    let partialOrPendingLines = 0;
    let totalRequiredUnits = 0;
    let totalReceivedUnits = 0;

    parts.forEach((p) => {
      const vState = getPartVerificationState(p);
      totalRequiredUnits += vState.requiredQty;
      totalReceivedUnits += vState.receivedQty;

      if (vState.state === 'quantity_mismatch') {
        mismatchLines += 1;
      } else if (vState.state === 'verified' || p.status === 'received') {
        receivedLines += 1;
      } else {
        partialOrPendingLines += 1;
      }
    });

    const remainingUnits = Math.max(0, totalRequiredUnits - totalReceivedUnits);
    const completionPct =
      totalLines > 0 ? Math.round((receivedLines / totalLines) * 100) : 0;

    return {
      totalLines,
      receivedLines,
      mismatchLines,
      partialOrPendingLines,
      totalRequiredUnits,
      totalReceivedUnits,
      remainingUnits,
      completionPct,
    };
  }, [parts]);

  // Filtered parts list
  const filteredParts = useMemo(() => {
    const statusAndPalletFiltered = parts.filter((part) => {
      const vState = getPartVerificationState(part);
      if (statusFilter === 'received' && part.status !== 'received') return false;
      if (statusFilter === 'outstanding' && part.status === 'received') return false;
      if (statusFilter === 'mismatch' && vState.state !== 'quantity_mismatch') return false;

      if (selectedPallet !== 'all' && String(part.palletNumber) !== selectedPallet) {
        return false;
      }
      return true;
    });

    if (!searchQuery.trim()) return statusAndPalletFiltered;

    return filterPartsSmart(statusAndPalletFiltered, searchQuery, {
      docketNumber: delivery?.docketNumber,
      supplier: delivery?.supplier,
    });
  }, [
    parts,
    searchQuery,
    statusFilter,
    selectedPallet,
    delivery?.docketNumber,
    delivery?.supplier,
  ]);

  // Group parts by pallet for the Pallets tab
  const palletGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        palletName: string;
        parts: DeliveryPart[];
        receivedCount: number;
        totalUnitsReq: number;
        totalUnitsRcvd: number;
      }
    >();

    parts.forEach((p) => {
      const pName = p.palletNumber ? String(p.palletNumber) : 'Pallet 1';
      const existing = map.get(pName) || {
        palletName: pName,
        parts: [],
        receivedCount: 0,
        totalUnitsReq: 0,
        totalUnitsRcvd: 0,
      };
      const vState = getPartVerificationState(p);
      existing.parts.push(p);
      if (p.status === 'received' || vState.state === 'verified') {
        existing.receivedCount += 1;
      }
      existing.totalUnitsReq += vState.requiredQty;
      existing.totalUnitsRcvd += vState.receivedQty;
      map.set(pName, existing);
    });

    return Array.from(map.values());
  }, [parts]);

  const handleToggleManualVerify = (part: DeliveryPart) => {
    if (!delivery) return;
    if (part.status === 'outstanding') {
      if ((part.quantity || 1) > 1 && onRequestPartQuantityConfirm) {
        onRequestPartQuantityConfirm({
          part,
          code: part.partNumber,
          detectedType: 'manual',
          matchedMode: 'exact-part',
        });
        return;
      }
      const nextParts = delivery.parts.map((p) =>
        p.id === part.id
          ? {
              ...p,
              status: 'received' as const,
              receivedQuantity: p.quantity || 1,
              scannedAt: new Date().toISOString(),
              scannedVia: 'manual' as const,
            }
          : p
      );
      const allDone = nextParts.every((p) => p.status === 'received');
      const updated: Delivery = {
        ...delivery,
        parts: nextParts,
        status: allDone ? 'completed' : 'receiving',
        updatedAt: new Date().toISOString(),
      };
      updateDelivery(updated);
      onUpdateDelivery(updated);
    } else {
      const nextParts = delivery.parts.map((p) =>
        p.id === part.id
          ? {
              ...p,
              status: 'outstanding' as const,
              receivedQuantity: undefined,
              scannedAt: undefined,
              scannedVia: undefined,
            }
          : p
      );
      const updated: Delivery = {
        ...delivery,
        parts: nextParts,
        status: 'receiving',
        updatedAt: new Date().toISOString(),
      };
      updateDelivery(updated);
      onUpdateDelivery(updated);
    }
  };

  const handleSaveInlineReceivedQty = (part: DeliveryPart) => {
    if (!delivery) return;
    const parsed = parseInt(inlineReceivedQty, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      setEditingQtyPartId(null);
      return;
    }
    const nextParts = delivery.parts.map((p) => {
      if (p.id !== part.id) return p;
      return {
        ...p,
        status: parsed > 0 ? ('received' as const) : ('outstanding' as const),
        receivedQuantity: parsed > 0 ? parsed : undefined,
        scannedAt: parsed > 0 ? p.scannedAt || new Date().toISOString() : undefined,
        scannedVia: parsed > 0 ? p.scannedVia || ('manual' as const) : undefined,
      };
    });
    const allDone = nextParts.length > 0 && nextParts.every((p) => p.status === 'received');
    const updated: Delivery = {
      ...delivery,
      parts: nextParts,
      status: allDone ? 'completed' : 'receiving',
      updatedAt: new Date().toISOString(),
    };
    updateDelivery(updated);
    onUpdateDelivery(updated);
    setEditingQtyPartId(null);
  };

  const handleMarkDocketReviewed = async () => {
    if (!delivery) return;
    setIsMarkingReviewed(true);
    try {
      const updated: Delivery = {
        ...delivery,
        needsReview: false,
        separationReason: undefined,
        updatedAt: new Date().toISOString(),
      };
      await apiUpdateDelivery(delivery.id, { needsReview: false }).catch(() => {});
      updateDelivery(updated);
      onUpdateDelivery(updated);
    } finally {
      setIsMarkingReviewed(false);
    }
  };

  const handleConfirmDeleteDocket = async () => {
    if (!delivery || !canManageDeletion) return;
    setActionError(null);
    setIsDeletingDocket(true);
    try {
      await deleteDeliveryAuthoritative(delivery.id);
      setConfirmDeleteOpen(false);
      onDeleteDelivery?.(delivery.id);
    } catch (err: any) {
      setActionError(err?.message || 'Failed to delete completed docket.');
    } finally {
      setIsDeletingDocket(false);
    }
  };

  if (!delivery) {
    return (
      <div className="flex-1 w-full bg-[var(--pt-bg,#080B12)] text-white p-8 text-center">
        <p className="text-xs font-mono text-[var(--pt-text-secondary,#A3A8BD)]">
          No delivery docket selected. Select a docket from Delivery Dockets.
        </p>
      </div>
    );
  }

  const isCompleted =
    delivery.status === 'completed' ||
    (orderStats.totalLines > 0 && orderStats.receivedLines === orderStats.totalLines);

  return (
    <div className="flex-1 w-full bg-[var(--pt-bg,#080B12)] text-white flex flex-col pb-24">
      <div className="w-full max-w-6xl mx-auto px-3 sm:px-6 pt-3 sm:pt-6 space-y-4">
        {/* =====================================================================
         * 1. ORDER DETAILS HEADER + PROMINENT SCAN PARTS BUTTON
         * ===================================================================== */}
        <header className="p-4 sm:p-5 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] shadow-lg space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="flex items-start sm:items-center gap-3 min-w-0">
              {handleBackToOrders && (
                <button
                  type="button"
                  onClick={handleBackToOrders}
                  className="w-9 h-9 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-white flex items-center justify-center shrink-0 cursor-pointer transition-colors"
                  title="Return to Orders & Shipments"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
              )}

              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-extrabold text-base sm:text-lg text-white">
                    Docket #{delivery.docketNumber}
                  </span>
                  <span className="text-[var(--pt-text-muted,#737B94)]">•</span>
                  <span className="font-bold text-sm sm:text-base text-[var(--pt-primary-light,#C084FC)]">
                    {delivery.supplier}
                  </span>
                  {isCompleted ? (
                    <span className="px-2.5 py-0.5 rounded-md bg-[#00D979]/15 border border-[#00D979]/50 text-[#00D979] font-mono text-[10px] font-extrabold uppercase">
                      COMPLETE
                    </span>
                  ) : orderStats.receivedLines > 0 ? (
                    <span className="px-2.5 py-0.5 rounded-md bg-[#078BFF]/15 border border-[#078BFF]/50 text-[#078BFF] font-mono text-[10px] font-extrabold uppercase">
                      STARTED
                    </span>
                  ) : (
                    <span className="px-2.5 py-0.5 rounded-md bg-[#F59E0B]/15 border border-[#F59E0B]/50 text-[#F59E0B] font-mono text-[10px] font-extrabold uppercase">
                      INCOMPLETE
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-1">
                  <span>Date: {delivery.deliveryDate}</span>
                  <span>•</span>
                  <span>
                    {orderStats.receivedLines} / {orderStats.totalLines} Part Lines (
                    {orderStats.completionPct}%)
                  </span>
                  <span>•</span>
                  <span>
                    Units: {orderStats.totalReceivedUnits} / {orderStats.totalRequiredUnits} rcvd (
                    {orderStats.remainingUnits} remaining)
                  </span>
                </div>
              </div>
            </div>

            {/* Primary Order Actions: SCAN PARTS + Add Part + Bulk Edit + Export */}
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {onStartScanning && (
                <button
                  type="button"
                  onClick={onStartScanning}
                  className="h-10 px-4 rounded-xl pt-btn-primary font-mono font-extrabold text-xs uppercase tracking-wider inline-flex items-center gap-2 cursor-pointer transition-all"
                >
                  <QrCode className="w-4 h-4 stroke-[2.4]" />
                  <span>SCAN PARTS</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setEditorMode({ type: 'add' })}
                className="h-10 px-3.5 rounded-xl bg-[#00D979]/15 hover:bg-[#00D979]/25 border border-[#00D979]/50 text-[#00D979] font-mono font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer transition-colors"
              >
                <Plus className="w-4 h-4 stroke-[2.5]" />
                <span>+ Add Part</span>
              </button>

              <button
                type="button"
                onClick={() => setEditorMode({ type: 'bulk-edit' })}
                className="h-10 px-3.5 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-white font-mono font-semibold text-xs inline-flex items-center gap-1.5 cursor-pointer transition-colors"
              >
                <FileSpreadsheet className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)]" />
                <span>Edit Parts List</span>
              </button>

              <button
                type="button"
                onClick={() => exportDeliveryPdf(delivery)}
                className="h-10 px-3 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-white font-mono font-semibold text-xs inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                title="Export colour-coded PDF report"
              >
                <Printer className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)]" />
                <span className="hidden sm:inline">PDF</span>
              </button>

              {canManageDeletion && isCompleted && (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteOpen(true)}
                  className="h-10 px-3 rounded-xl bg-[#EF4444]/10 hover:bg-[#EF4444]/20 border border-[#EF4444]/40 text-[#EF4444] font-mono font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                  title="Delete completed docket (Supervisor/Admin only)"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Delete Docket</span>
                </button>
              )}
            </div>
          </div>

          {delivery.needsReview && (
            <div className="p-3 rounded-xl bg-[#F59E0B]/15 border border-[#F59E0B]/40 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-start gap-2 text-xs font-mono text-[#F59E0B]">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <span className="font-extrabold uppercase">Needs Review: </span>
                  <span className="text-white/90">
                    {delivery.separationReason ||
                      'Multi-page or docket separation could not be fully confirmed automatically. Verify docket number & parts list.'}
                  </span>
                </div>
              </div>
              <button
                type="button"
                disabled={isMarkingReviewed}
                onClick={handleMarkDocketReviewed}
                className="h-8 px-3 rounded-lg bg-[#F59E0B] hover:brightness-110 text-black font-mono font-extrabold text-[11px] uppercase shrink-0 cursor-pointer disabled:opacity-50"
              >
                {isMarkingReviewed ? 'Saving...' : 'Mark Reviewed'}
              </button>
            </div>
          )}

          {actionError && (
            <div className="p-3 rounded-xl bg-[#EF4444]/15 border border-[#EF4444]/40 text-[#EF4444] text-xs font-mono flex items-center justify-between gap-2">
              <span>{actionError}</span>
              <button type="button" onClick={() => setActionError(null)} className="cursor-pointer">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Progress Bar */}
          <div className="w-full h-2 rounded-full bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${orderStats.completionPct}%`,
                backgroundColor: isCompleted
                  ? '#00D979'
                  : orderStats.receivedLines > 0
                  ? '#078BFF'
                  : '#F59E0B',
              }}
            />
          </div>

          {/* 4 Organised Order Details Tabs: Parts | Pallets | Details | Activity */}
          <div className="grid grid-cols-4 gap-1.5 p-1 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)]">
            {(
              [
                {
                  id: 'parts',
                  label: 'Parts',
                  count: parts.length,
                  icon: Layers,
                },
                {
                  id: 'pallets',
                  label: 'Pallets',
                  count: palletGroups.length,
                  icon: Boxes,
                },
                {
                  id: 'details',
                  label: 'Details',
                  count: null,
                  icon: FileText,
                },
                {
                  id: 'activity',
                  label: 'Activity',
                  count: (delivery.scanHistory || []).length,
                  icon: Activity,
                },
              ] as const
            ).map((tab) => {
              const Icon = tab.icon;
              const isActive = activeSubTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveSubTab(tab.id)}
                  className={`py-2 px-2 sm:px-3 rounded-lg text-xs font-mono font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                    isActive
                      ? 'pt-btn-primary text-white'
                      : 'text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white hover:bg-white/5'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{tab.label}</span>
                  {tab.count !== null && (
                    <span
                      className={`text-[10px] px-1.5 py-0.2 rounded-full tabular-nums hidden xs:inline ${
                        isActive
                          ? 'bg-black/30 text-white'
                          : 'bg-[var(--pt-card,#15182A)] text-[var(--pt-text-secondary,#A3A8BD)]'
                      }`}
                    >
                      {tab.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </header>

        {/* =====================================================================
         * TAB 1: PARTS LIST & MANUAL EDITING
         * ===================================================================== */}
        {activeSubTab === 'parts' && (
          <section className="space-y-3">
            {/* Search & Status Filters */}
            <div className="p-3.5 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] space-y-3">
              <div className="flex flex-col sm:flex-row gap-2.5">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-[var(--pt-text-muted,#737B94)] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search last 4 digits, part #, description or item No..."
                    className="w-full h-10 pl-9 pr-4 bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] focus:border-[var(--pt-primary,#A020F0)] rounded-xl text-xs font-mono text-white placeholder:text-[var(--pt-text-muted,#737B94)] outline-none"
                  />
                </div>

                {/* Status Filter Pills */}
                <div className="flex items-center gap-1 bg-[var(--pt-bg,#080B12)] p-1 rounded-xl border border-[var(--pt-border,#29243D)] overflow-x-auto">
                  {(
                    [
                      { id: 'all', label: `All (${orderStats.totalLines})` },
                      {
                        id: 'outstanding',
                        label: `Pending (${orderStats.partialOrPendingLines})`,
                      },
                      { id: 'received', label: `Verified (${orderStats.receivedLines})` },
                      { id: 'mismatch', label: `Mismatch (${orderStats.mismatchLines})` },
                    ] as const
                  ).map((st) => (
                    <button
                      key={st.id}
                      type="button"
                      onClick={() => setStatusFilter(st.id)}
                      className={`px-2.5 py-1.5 rounded-lg text-[11px] font-mono font-bold whitespace-nowrap cursor-pointer transition-colors ${
                        statusFilter === st.id
                          ? 'pt-btn-primary text-white'
                          : 'text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white'
                      }`}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Pallet Filter Pills if multiple pallets exist */}
              {pallets.length > 0 && (
                <div className="flex items-center gap-1.5 overflow-x-auto pt-1">
                  <span className="text-[10px] font-mono uppercase text-[var(--pt-text-muted,#737B94)] shrink-0 mr-1">
                    Pallet Filter:
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedPallet('all');
                      onClearPalletFilter?.();
                    }}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-mono font-semibold cursor-pointer border ${
                      selectedPallet === 'all'
                        ? 'bg-[var(--pt-bg-secondary,#101321)] border-[var(--pt-primary,#A020F0)] text-[var(--pt-primary-light,#C084FC)]'
                        : 'bg-[var(--pt-bg,#080B12)] border-[var(--pt-border,#29243D)] text-[var(--pt-text-secondary,#A3A8BD)]'
                    }`}
                  >
                    All Pallets
                  </button>
                  {pallets.map((pal) => (
                    <button
                      key={pal}
                      type="button"
                      onClick={() => setSelectedPallet(pal)}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-mono font-semibold cursor-pointer border whitespace-nowrap ${
                        selectedPallet === pal
                          ? 'bg-[var(--pt-bg-secondary,#101321)] border-[var(--pt-primary,#A020F0)] text-[var(--pt-primary-light,#C084FC)]'
                          : 'bg-[var(--pt-bg,#080B12)] border-[var(--pt-border,#29243D)] text-[var(--pt-text-secondary,#A3A8BD)]'
                      }`}
                    >
                      {pal}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Parts Rows */}
            <div className="rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] divide-y divide-[var(--pt-border,#29243D)] overflow-hidden">
              {filteredParts.length === 0 ? (
                <div className="p-10 text-center space-y-2">
                  <p className="text-xs font-mono text-[var(--pt-text-secondary,#A3A8BD)]">
                    No parts match the active filter.
                  </p>
                </div>
              ) : (
                filteredParts.map((part) => {
                  const vState = getPartVerificationState(part);
                  const requiredQty = vState.requiredQty;
                  const receivedQty = vState.receivedQty;
                  const remainingQty = Math.max(0, requiredQty - receivedQty);

                  // Determine semantic status colour:
                  // Green (#00D979) = Fully received
                  // Amber (#F59E0B) = Partially received / pending
                  // Red   (#EF4444) = Quantity mismatch or error
                  const isMismatch = vState.state === 'quantity_mismatch';
                  const isFullyVerified =
                    !isMismatch &&
                    (vState.state === 'verified' ||
                      (part.status === 'received' && receivedQty === requiredQty));

                  const discrepancy = receivedQty - requiredQty;
                  const statusBadge = isMismatch
                    ? {
                        label: `MISMATCH (${
                          discrepancy > 0 ? `+${discrepancy}` : discrepancy
                        })`,
                        className: 'bg-[#EF4444]/15 border-[#EF4444]/50 text-[#EF4444]',
                        rowBorder: 'border-l-4 border-l-[#EF4444]',
                      }
                    : isFullyVerified
                    ? {
                        label: 'VERIFIED',
                        className: 'bg-[#00D979]/15 border-[#00D979]/50 text-[#00D979]',
                        rowBorder: 'border-l-4 border-l-[#00D979]',
                      }
                    : {
                        label: receivedQty > 0 ? 'PARTIAL' : 'PENDING',
                        className: 'bg-[#F59E0B]/15 border-[#F59E0B]/50 text-[#F59E0B]',
                        rowBorder: 'border-l-4 border-l-[#F59E0B]',
                      };

                  return (
                    <div
                      key={part.id}
                      className={`p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-white/[0.02] transition-colors ${statusBadge.rowBorder}`}
                    >
                      {/* Left: Checkbox + Part Number + Description + Metadata */}
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <button
                          type="button"
                          onClick={() => handleToggleManualVerify(part)}
                          className={`mt-0.5 w-6 h-6 rounded-lg flex items-center justify-center shrink-0 border transition-colors cursor-pointer ${
                            isFullyVerified
                              ? 'bg-[#00D979] border-[#00D979] text-black'
                              : isMismatch
                              ? 'bg-[#EF4444] border-[#EF4444] text-white'
                              : 'bg-[var(--pt-bg,#080B12)] border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)]'
                          }`}
                          title="Toggle verification status"
                        >
                          {(isFullyVerified || isMismatch) && (
                            <Check className="w-3.5 h-3.5 stroke-[3]" />
                          )}
                        </button>

                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            {part.itemNumber && (
                              <span className="px-1.5 py-0.5 rounded bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] font-mono text-[10px] font-bold text-[var(--pt-primary-light,#C084FC)]">
                                No.{' '}
                                <HighlightMatch
                                  text={String(part.itemNumber)}
                                  query={searchQuery}
                                />
                              </span>
                            )}
                            <span className="font-mono font-extrabold text-sm text-white tracking-tight">
                              <HighlightMatch text={part.partNumber} query={searchQuery} />
                            </span>
                            {part.revision && (
                              <span className="px-1.5 py-0.5 rounded bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] font-mono text-[10px] text-[var(--pt-text-secondary,#A3A8BD)]">
                                Rev {part.revision}
                              </span>
                            )}
                            <span
                              className={`px-2 py-0.5 rounded border font-mono text-[10px] font-extrabold uppercase ${statusBadge.className}`}
                            >
                              {statusBadge.label}
                            </span>
                            {part.manuallyEdited && (
                              <span className="px-1.5 py-0.5 rounded bg-purple-950/60 border border-[#A020F0]/40 font-mono text-[9px] text-[#C084FC]">
                                EDITED
                              </span>
                            )}
                          </div>

                          <p className="text-xs text-[var(--pt-text-secondary,#A3A8BD)]">
                            <HighlightMatch text={part.description} query={searchQuery} />
                          </p>

                          <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono text-[var(--pt-text-muted,#737B94)]">
                            {part.palletNumber && (
                              <span className="text-[var(--pt-primary-light,#C084FC)]">
                                {part.palletNumber}
                              </span>
                            )}
                            {part.material && <span>• Mat: {part.material}</span>}
                            {part.thickness && <span>• Thk: {part.thickness}</span>}
                            {(() => {
                              const scannersSummary = formatPartScannersSummary(
                                part,
                                delivery.scanHistory
                              );
                              if (scannersSummary === '—') return null;
                              const attributions = Array.isArray(part.scannedByUsers)
                                ? part.scannedByUsers
                                : [];
                              const isExpandedAttr = expandedAttributionPartId === part.id;
                              return (
                                <>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (attributions.length > 0) {
                                        setExpandedAttributionPartId(
                                          isExpandedAttr ? null : part.id
                                        );
                                      }
                                    }}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#00D979]/10 border border-[#00D979]/30 text-[#00D979] font-semibold cursor-pointer hover:bg-[#00D979]/20 transition-colors"
                                    title={
                                      attributions.length > 0
                                        ? 'Click to view per-operator scan breakdown'
                                        : undefined
                                    }
                                  >
                                    <UserCheck className="w-3 h-3" />
                                    <span>Scanned by: {scannersSummary}</span>
                                  </button>
                                  {isExpandedAttr && attributions.length > 0 && (
                                    <div className="w-full mt-1.5 p-2 rounded-lg bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] space-y-1">
                                      <div className="text-[9px] uppercase tracking-wider text-[var(--pt-text-muted,#737B94)] font-bold">
                                        Operator Attribution Breakdown
                                      </div>
                                      {attributions.map((attr, aIdx) => (
                                        <div
                                          key={`${attr.userId || attr.employeeName}_${aIdx}`}
                                          className="flex items-center justify-between gap-2 text-[10px] text-white/90"
                                        >
                                          <span className="font-semibold text-[#00D979]">
                                            {attr.employeeName}
                                          </span>
                                          <span className="text-[var(--pt-text-secondary,#A3A8BD)] tabular-nums">
                                            {attr.quantityScanned} units · {attr.scanCount}{' '}
                                            {attr.scanCount === 1 ? 'scan' : 'scans'} ·{' '}
                                            {attr.lastScannedAt
                                              ? new Date(attr.lastScannedAt).toLocaleString([], {
                                                  month: 'short',
                                                  day: 'numeric',
                                                  hour: '2-digit',
                                                  minute: '2-digit',
                                                })
                                              : ''}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        </div>
                      </div>

                      {/* Right: Required Qty | Received Qty | Remaining Qty + Edit/Delete */}
                      <div className="flex items-center justify-between sm:justify-end gap-3 pt-2 sm:pt-0 border-t sm:border-t-0 border-[var(--pt-border,#29243D)] shrink-0">
                        <div className="grid grid-cols-3 gap-2 text-center font-mono">
                          <div className="px-2.5 py-1 rounded-lg bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)]">
                            <div className="text-[9px] text-[var(--pt-text-muted,#737B94)] uppercase">
                              Required
                            </div>
                            <div className="text-xs font-bold text-white tabular-nums">
                              {requiredQty}
                            </div>
                          </div>

                          {/* Clickable Received Quantity for Instant Manual Correction */}
                          <div
                            onClick={() => {
                              setEditingQtyPartId(part.id);
                              setInlineReceivedQty(String(receivedQty));
                            }}
                            className="px-2.5 py-1 rounded-lg bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)] cursor-pointer"
                            title="Click to edit received quantity"
                          >
                            <div className="text-[9px] text-[var(--pt-text-muted,#737B94)] uppercase">
                              Received
                            </div>
                            {editingQtyPartId === part.id ? (
                              <input
                                type="number"
                                min="0"
                                autoFocus
                                value={inlineReceivedQty}
                                onChange={(e) => setInlineReceivedQty(e.target.value)}
                                onBlur={() => handleSaveInlineReceivedQty(part)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleSaveInlineReceivedQty(part);
                                  if (e.key === 'Escape') setEditingQtyPartId(null);
                                }}
                                onClick={(e) => e.stopPropagation()}
                                className="w-12 h-5 text-center bg-[var(--pt-card,#15182A)] border border-[var(--pt-primary,#A020F0)] rounded text-xs font-bold text-white outline-none"
                              />
                            ) : (
                              <div
                                className={`text-xs font-bold tabular-nums ${
                                  isMismatch
                                    ? 'text-[#EF4444]'
                                    : isFullyVerified
                                    ? 'text-[#00D979]'
                                    : 'text-[#F59E0B]'
                                }`}
                              >
                                {receivedQty}
                              </div>
                            )}
                          </div>

                          <div className="px-2.5 py-1 rounded-lg bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)]">
                            <div className="text-[9px] text-[var(--pt-text-muted,#737B94)] uppercase">
                              Remaining
                            </div>
                            <div
                              className={`text-xs font-bold tabular-nums ${
                                remainingQty === 0 ? 'text-[#00D979]' : 'text-[#F59E0B]'
                              }`}
                            >
                              {remainingQty}
                            </div>
                          </div>
                        </div>

                        {/* Edit & Delete Buttons */}
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setEditorMode({ type: 'edit-single', part })}
                            className="w-8 h-8 rounded-lg bg-[var(--pt-bg,#080B12)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white flex items-center justify-center cursor-pointer transition-colors"
                            title={`Edit ${part.partNumber}`}
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditorMode({ type: 'delete-confirm', part })}
                            className="w-8 h-8 rounded-lg bg-[var(--pt-bg,#080B12)] hover:bg-[#EF4444]/20 border border-[var(--pt-border,#29243D)] hover:border-[#EF4444]/40 text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[#EF4444] flex items-center justify-center cursor-pointer transition-colors"
                            title={`Delete ${part.partNumber}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        )}

        {/* =====================================================================
         * TAB 2: PALLETS BREAKDOWN
         * ===================================================================== */}
        {activeSubTab === 'pallets' && (
          <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
            {palletGroups.map((pg) => {
              const totalLines = pg.parts.length;
              const pct =
                totalLines > 0 ? Math.round((pg.receivedCount / totalLines) * 100) : 0;
              const isPalletDone = totalLines > 0 && pg.receivedCount === totalLines;

              return (
                <div
                  key={pg.palletName}
                  className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] flex flex-col justify-between gap-3"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-9 h-9 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] text-[var(--pt-primary-light,#C084FC)] flex items-center justify-center">
                        <Boxes className="w-4 h-4" />
                      </div>
                      <div>
                        <h3 className="font-mono font-bold text-sm text-white">{pg.palletName}</h3>
                        <p className="text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)]">
                          {totalLines} part lines • {pg.totalUnitsRcvd}/{pg.totalUnitsReq} units
                        </p>
                      </div>
                    </div>

                    <span
                      className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase border ${
                        isPalletDone
                          ? 'bg-[#00D979]/15 border-[#00D979]/40 text-[#00D979]'
                          : pg.receivedCount > 0
                          ? 'bg-[#078BFF]/15 border-[#078BFF]/40 text-[#078BFF]'
                          : 'bg-[#F59E0B]/15 border-[#F59E0B]/40 text-[#F59E0B]'
                      }`}
                    >
                      {isPalletDone ? 'COMPLETE' : pg.receivedCount > 0 ? 'STARTED' : 'INCOMPLETE'}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex justify-between text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)]">
                      <span>Progress</span>
                      <span className="text-white font-bold">{pct}%</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${pct}%`,
                          backgroundColor: isPalletDone ? '#00D979' : '#A020F0',
                        }}
                      />
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedPallet(pg.palletName);
                      setActiveSubTab('parts');
                    }}
                    className="w-full h-9 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-xs font-mono font-bold text-[var(--pt-primary-light,#C084FC)] cursor-pointer transition-colors"
                  >
                    Filter Parts on {pg.palletName}
                  </button>
                </div>
              );
            })}
          </section>
        )}

        {/* =====================================================================
         * TAB 3: DOCKET DETAILS & EXPORT ACTIONS
         * ===================================================================== */}
        {activeSubTab === 'details' && (
          <section className="p-4 sm:p-5 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] space-y-4">
            <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-white">
              SHIPMENT &amp; DOCKET METADATA
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 font-mono text-xs">
              <div className="p-3.5 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)]">
                <div className="text-[10px] text-[var(--pt-text-muted,#737B94)] uppercase">
                  Docket Number
                </div>
                <div className="text-sm font-bold text-white mt-0.5">#{delivery.docketNumber}</div>
              </div>
              <div className="p-3.5 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)]">
                <div className="text-[10px] text-[var(--pt-text-muted,#737B94)] uppercase">
                  Customer / Supplier
                </div>
                <div className="text-sm font-bold text-[var(--pt-primary-light,#C084FC)] mt-0.5">
                  {delivery.supplier}
                </div>
              </div>
              <div className="p-3.5 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)]">
                <div className="text-[10px] text-[var(--pt-text-muted,#737B94)] uppercase">
                  Delivery Date
                </div>
                <div className="text-sm font-bold text-white mt-0.5">{delivery.deliveryDate}</div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => exportDeliveryPdf(delivery)}
                className="h-10 px-4 rounded-xl pt-btn-primary font-mono font-bold text-xs uppercase inline-flex items-center gap-2 cursor-pointer"
              >
                <Printer className="w-4 h-4" />
                <span>Export Colour-Coded PDF</span>
              </button>

              <button
                type="button"
                onClick={() => exportDeliveryCsv(delivery)}
                className="h-10 px-4 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] font-mono font-bold text-xs text-white inline-flex items-center gap-2 cursor-pointer"
              >
                <FileSpreadsheet className="w-4 h-4 text-[#00D979]" />
                <span>Export CSV Spreadsheet</span>
              </button>

              <button
                type="button"
                onClick={() => setIsDocketPhotosOpen(true)}
                className="h-10 px-4 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] font-mono font-bold text-xs text-white inline-flex items-center gap-2 cursor-pointer"
              >
                <FileText className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
                <span>View Original Docket Photo(s)</span>
              </button>
            </div>
          </section>
        )}

        {/* =====================================================================
         * TAB 4: DOCKET SCANNING & EDIT ACTIVITY LOG
         * ===================================================================== */}
        {activeSubTab === 'activity' && (
          <section className="p-4 sm:p-5 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-white">
                DOCKET VERIFICATION &amp; AUDIT LOG
              </h3>
              <span className="text-[11px] font-mono text-[var(--pt-primary-light,#C084FC)]">
                {(delivery.scanHistory || []).length} events recorded
              </span>
            </div>

            {(delivery.scanHistory || []).length > 0 ? (
              <div className="divide-y divide-[var(--pt-border,#29243D)] rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] overflow-hidden">
                {(delivery.scanHistory || []).map((ev) => (
                  <div
                    key={ev.id}
                    className="p-3 flex items-center justify-between gap-3 font-mono text-xs"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white">
                          {ev.partNumber || ev.code}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-[#00D979]/15 border border-[#00D979]/40 text-[#00D979] text-[10px] font-bold">
                          Qty: {ev.addedQuantity || ev.receivedQuantity || 1}
                        </span>
                      </div>
                      <p className="text-[11px] font-sans text-[var(--pt-text-secondary,#A3A8BD)] truncate mt-0.5">
                        {ev.recognizedDescription || 'Scanned item'} • {ev.codeType}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[10px] text-[var(--pt-primary-light,#C084FC)] font-bold">
                        {ev.employeeName || 'Terminal Operator'}
                      </div>
                      <div className="text-[10px] text-[var(--pt-text-muted,#737B94)]">
                        {ev.timestamp
                          ? new Date(ev.timestamp).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                            })
                          : 'Just now'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-xs font-mono text-[var(--pt-text-muted,#737B94)]">
                No scan events logged for this docket yet.
              </div>
            )}
          </section>
        )}
      </div>

      {/* Manual Parts List Editor Modal */}
      {editorMode && delivery && (
        <PartsListEditorModal
          delivery={delivery}
          mode={editorMode}
          onClose={() => setEditorMode(null)}
          onDeliveryUpdated={(updated) => {
            onUpdateDelivery(updated);
          }}
        />
      )}

      {/* Original Docket Photo Modal */}
      {isDocketPhotosOpen && delivery && (
        <DocketPhotosModal
          delivery={delivery}
          onClose={() => setIsDocketPhotosOpen(false)}
        />
      )}

      {/* Role-Restricted Delete Completed Docket Modal */}
      {confirmDeleteOpen && delivery && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => !isDeletingDocket && setConfirmDeleteOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-[var(--pt-card,#15182A)] border border-[#EF4444]/40 p-5 shadow-2xl space-y-4 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#EF4444]/15 border border-[#EF4444]/40 text-[#EF4444] flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-mono font-extrabold text-sm uppercase text-white">
                  Delete Completed Docket #{delivery.docketNumber}?
                </h3>
                <p className="text-xs text-[var(--pt-text-secondary,#A3A8BD)] mt-1 leading-relaxed">
                  This permanently deletes Docket #{delivery.docketNumber} ({delivery.supplier}), all of its parts, scan history, and removes it from any Docket Groups.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={isDeletingDocket}
                onClick={() => setConfirmDeleteOpen(false)}
                className="h-9 px-4 rounded-xl bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] text-xs font-mono font-bold text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isDeletingDocket}
                onClick={handleConfirmDeleteDocket}
                className="h-9 px-4 rounded-xl bg-[#EF4444] hover:bg-red-500 text-white text-xs font-mono font-extrabold uppercase inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {isDeletingDocket ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
                <span>{isDeletingDocket ? 'Deleting...' : 'Confirm Delete'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
