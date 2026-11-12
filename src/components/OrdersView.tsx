import React, { useState, useEffect, useMemo } from 'react';
import {
  Search,
  Plus,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Clock,
  Layers,
  Trash2,
  Printer,
  QrCode,
  Calendar,
  ArrowUpRight,
  RotateCcw,
  Check,
  X,
  ClipboardList,
  Boxes,
  Edit3,
  FileSpreadsheet,
} from 'lucide-react';
import { Delivery, DeliveryPart } from '../types/delivery';
import {
  getStoredDeliveries,
  updateDelivery,
  deleteDelivery,
  getPartVerificationState,
} from '../utils/storage';
import { exportDeliveryPdf } from '../utils/pdfExport';
import { filterPartsSmart, deliveryMatchesSmartQuery, HighlightMatch } from '../utils/partSearch';
import { PartsListEditorModal, PartsEditorMode } from './PartsListEditorModal';

interface OrdersViewProps {
  activeDelivery: Delivery | null;
  onSelectDelivery: (delivery: Delivery) => void;
  onUpdateDelivery?: (updated: Delivery) => void;
  onDeleteDelivery?: (id: string) => void;
  onOpenNewDelivery: () => void;
  onStartScanning: (delivery?: Delivery) => void;
  onOpenChecklist?: (delivery: Delivery) => void;
  onNavigateToChecklist?: (pallet?: string) => void;
}

type OrderFilterTab = 'incomplete' | 'started' | 'finished' | 'all';

export const OrdersView: React.FC<OrdersViewProps> = ({
  activeDelivery,
  onSelectDelivery,
  onUpdateDelivery,
  onDeleteDelivery,
  onOpenNewDelivery,
  onStartScanning,
  onOpenChecklist,
  onNavigateToChecklist,
}) => {
  const [deliveries, setDeliveries] = useState<Delivery[]>(() => getStoredDeliveries());
  const [filterTab, setFilterTab] = useState<OrderFilterTab>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(
    activeDelivery?.id || null
  );
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editorTarget, setEditorTarget] = useState<{
    delivery: Delivery;
    mode: PartsEditorMode;
  } | null>(null);

  // Sync with storage updates
  useEffect(() => {
    const syncDeliveries = () => {
      setDeliveries(getStoredDeliveries());
    };
    window.addEventListener('parttrack_deliveries_updated', syncDeliveries);
    return () => window.removeEventListener('parttrack_deliveries_updated', syncDeliveries);
  }, []);

  // Categorise deliveries into Incomplete, Started, Finished
  const getOrderCategory = (del: Delivery): 'incomplete' | 'started' | 'finished' => {
    const parts = del.parts || [];
    const total = parts.length;
    const received = parts.filter((p) => p.status === 'received').length;

    if (del.status === 'completed' || (total > 0 && received === total)) {
      return 'finished';
    }
    if (received > 0 || (del.scanHistory && del.scanHistory.length > 0)) {
      return 'started';
    }
    return 'incomplete';
  };

  // Accurate live tab counts
  const tabCounts = useMemo(() => {
    let incomplete = 0;
    let started = 0;
    let finished = 0;

    deliveries.forEach((d) => {
      const cat = getOrderCategory(d);
      if (cat === 'finished') finished += 1;
      else if (cat === 'started') started += 1;
      else incomplete += 1;
    });

    return {
      all: deliveries.length,
      incomplete,
      started,
      finished,
    };
  }, [deliveries]);

  // Filtered & Smart-Searched Orders
  const filteredOrders = useMemo(() => {
    return deliveries.filter((del) => {
      const cat = getOrderCategory(del);
      if (filterTab !== 'all' && cat !== filterTab) {
        return false;
      }
      if (!searchQuery.trim()) return true;
      return deliveryMatchesSmartQuery(del, searchQuery);
    });
  }, [deliveries, filterTab, searchQuery]);

  const handleToggleExpand = (del: Delivery) => {
    if (expandedOrderId === del.id) {
      setExpandedOrderId(null);
    } else {
      setExpandedOrderId(del.id);
      onSelectDelivery(del);
    }
  };

  const handleMarkOrderComplete = (del: Delivery, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated: Delivery = {
      ...del,
      status: 'completed',
      updatedAt: new Date().toISOString(),
    };
    updateDelivery(updated);
    if (onUpdateDelivery) onUpdateDelivery(updated);
    else onSelectDelivery(updated);
    setDeliveries(getStoredDeliveries());
  };

  const handleReopenOrder = (del: Delivery, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated: Delivery = {
      ...del,
      status: 'receiving',
      updatedAt: new Date().toISOString(),
    };
    updateDelivery(updated);
    if (onUpdateDelivery) onUpdateDelivery(updated);
    else onSelectDelivery(updated);
    setDeliveries(getStoredDeliveries());
  };

  const handleConfirmDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    deleteDelivery(id);
    if (onDeleteDelivery) {
      onDeleteDelivery(id);
    }
    setDeliveries(getStoredDeliveries());
    setConfirmDeleteId(null);
  };

  const handleTogglePartManualStatus = (del: Delivery, part: DeliveryPart) => {
    const nextStatus = part.status === 'received' ? 'outstanding' : 'received';
    const nextParts = (del.parts || []).map((p) => {
      if (p.id !== part.id) return p;
      return {
        ...p,
        status: nextStatus as 'outstanding' | 'received',
        receivedQuantity: nextStatus === 'received' ? p.quantity || 1 : undefined,
        scannedAt: nextStatus === 'received' ? new Date().toISOString() : undefined,
        verifiedBy: nextStatus === 'received' ? ('manual' as const) : undefined,
      };
    });

    const allDone = nextParts.length > 0 && nextParts.every((p) => p.status === 'received');
    const updated: Delivery = {
      ...del,
      parts: nextParts,
      status: allDone ? 'completed' : 'receiving',
      updatedAt: new Date().toISOString(),
    };

    updateDelivery(updated);
    if (onUpdateDelivery) onUpdateDelivery(updated);
    else onSelectDelivery(updated);
    setDeliveries(getStoredDeliveries());
  };

  return (
    <div className="flex-1 w-full bg-[var(--pt-bg,#080B12)] text-white flex flex-col pb-24">
      <div className="w-full max-w-6xl mx-auto px-3 sm:px-6 pt-3 sm:pt-6 space-y-4 sm:space-y-5">
        {/* =========================================================================
         * 1. ORDERS & SHIPMENTS HEADER + NEW ORDER BUTTON
         * ========================================================================= */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 sm:p-5 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] shadow-lg">
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-lg sm:text-xl font-extrabold tracking-tight text-white uppercase font-sans">
                ORDERS &amp; SHIPMENTS
              </h1>
              <span className="text-xs font-mono font-bold px-2.5 py-0.5 rounded-lg bg-[var(--pt-bg-secondary,#101321)] text-[var(--pt-primary-light,#C084FC)] border border-[var(--pt-border,#29243D)]">
                {deliveries.length} {deliveries.length === 1 ? 'Docket' : 'Dockets'}
              </span>
            </div>
            <p className="text-xs font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-1">
              Track dockets, pallets, parts received vs required, and verification progress
            </p>
          </div>

          <button
            type="button"
            onClick={onOpenNewDelivery}
            className="h-11 px-5 rounded-xl pt-btn-primary font-mono font-extrabold text-xs tracking-wider uppercase inline-flex items-center justify-center gap-2 cursor-pointer transition-all shrink-0"
          >
            <Plus className="w-4 h-4 stroke-[2.6]" />
            <span>NEW ORDER</span>
          </button>
        </div>

        {/* =========================================================================
         * 2. SMART SEARCH & FILTER TABS (All / Incomplete / Started / Finished)
         * ========================================================================= */}
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          {/* Filter Tabs with Accurate Live Counts */}
          <div className="grid grid-cols-4 gap-1.5 p-1 rounded-xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)]">
            {(
              [
                { id: 'all', label: 'All', count: tabCounts.all },
                { id: 'incomplete', label: 'Incomplete', count: tabCounts.incomplete },
                { id: 'started', label: 'Started', count: tabCounts.started },
                { id: 'finished', label: 'Finished', count: tabCounts.finished },
              ] as const
            ).map((tab) => {
              const isActive = filterTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilterTab(tab.id)}
                  className={`py-2 px-2 sm:px-3 rounded-lg text-xs font-mono font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                    isActive
                      ? 'pt-btn-primary text-white'
                      : 'text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white hover:bg-white/5'
                  }`}
                >
                  <span className="truncate">{tab.label}</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.2 rounded-full tabular-nums ${
                      isActive
                        ? 'bg-black/30 text-white'
                        : 'bg-[var(--pt-bg-secondary,#101321)] text-[var(--pt-text-secondary,#A3A8BD)]'
                    }`}
                  >
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Smart Search Input */}
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-[var(--pt-text-muted,#737B94)] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search last 4 digits, part #, docket # or supplier..."
              className="w-full h-11 pl-10 pr-9 rounded-xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] focus:border-[var(--pt-primary,#A020F0)] text-xs font-mono text-white placeholder:text-[var(--pt-text-muted,#737B94)] outline-none transition-colors"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--pt-text-muted,#737B94)] hover:text-white p-1 cursor-pointer"
                title="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* =========================================================================
         * 3. ORDERS LIST CARDS
         * ========================================================================= */}
        {filteredOrders.length > 0 ? (
          <div className="space-y-3">
            {filteredOrders.map((del) => {
              const parts = del.parts || [];
              const totalParts = parts.length;
              const receivedParts = parts.filter((p) => p.status === 'received').length;
              const remainingParts = totalParts - receivedParts;
              const progressPct =
                totalParts > 0 ? Math.round((receivedParts / totalParts) * 100) : 0;
              const category = getOrderCategory(del);
              const isExpanded = expandedOrderId === del.id;
              const isActive = activeDelivery?.id === del.id;

              // Calculate distinct pallets count
              const uniquePallets = new Set(
                parts.map((p) => p.palletNumber).filter(Boolean)
              );
              const palletTotal = Math.max(del.palletCount || 0, uniquePallets.size, 1);

              // Filter parts inside expanded card when user searches
              const displayedParts = searchQuery.trim()
                ? filterPartsSmart(parts, searchQuery, {
                    docketNumber: del.docketNumber,
                    supplier: del.supplier,
                  })
                : parts;

              return (
                <div
                  key={del.id}
                  className={`rounded-2xl bg-[var(--pt-card,#15182A)] border transition-all overflow-hidden ${
                    isActive
                      ? 'border-[var(--pt-primary,#A020F0)] shadow-[0_0_24px_var(--pt-glow-soft,rgba(160,32,240,0.16))]'
                      : 'border-[var(--pt-border,#29243D)] hover:border-white/25'
                  }`}
                >
                  {/* Order Summary Header */}
                  <div
                    onClick={() => handleToggleExpand(del)}
                    className="p-4 sm:p-5 cursor-pointer select-none space-y-3.5"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                      <div className="flex items-start sm:items-center gap-3 min-w-0">
                        {/* Status Icon */}
                        <div
                          className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${
                            category === 'finished'
                              ? 'bg-[#00D979]/15 text-[#00D979] border-[#00D979]/40'
                              : category === 'started'
                              ? 'bg-[#078BFF]/15 text-[#078BFF] border-[#078BFF]/40'
                              : 'bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/40'
                          }`}
                        >
                          {category === 'finished' ? (
                            <CheckCircle2 className="w-5 h-5" />
                          ) : category === 'started' ? (
                            <QrCode className="w-5 h-5" />
                          ) : (
                            <Clock className="w-5 h-5" />
                          )}
                        </div>

                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-extrabold text-sm sm:text-base text-white">
                              Docket #{del.docketNumber}
                            </span>
                            <span className="text-[var(--pt-text-muted,#737B94)]">•</span>
                            <span className="font-bold text-sm text-[var(--pt-primary-light,#C084FC)] truncate">
                              {del.supplier}
                            </span>
                            {isActive && (
                              <span className="text-[10px] font-mono font-bold uppercase px-2 py-0.5 rounded bg-[var(--pt-bg-secondary,#101321)] text-[var(--pt-primary-light,#C084FC)] border border-[var(--pt-primary,#A020F0)]/50">
                                ACTIVE DOCKET
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-1">
                            <span className="inline-flex items-center gap-1">
                              <Calendar className="w-3.5 h-3.5 text-[var(--pt-text-muted,#737B94)]" />
                              {del.deliveryDate}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Boxes className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)]" />
                              {palletTotal} {palletTotal === 1 ? 'Pallet' : 'Pallets'}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Layers className="w-3.5 h-3.5 text-[var(--pt-text-muted,#737B94)]" />
                              {receivedParts} / {totalParts} Parts Received
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Right Status Badge (INCOMPLETE = Amber, STARTED = Blue, COMPLETE = Green) & Quick Actions */}
                      <div className="flex items-center justify-between sm:justify-end gap-2 pt-2 sm:pt-0 border-t sm:border-t-0 border-[var(--pt-border,#29243D)]">
                        {category === 'finished' ? (
                          <span className="px-2.5 py-1 rounded-lg bg-[#00D979]/15 border border-[#00D979]/50 text-[#00D979] text-[10px] font-mono font-extrabold uppercase tracking-wider">
                            COMPLETE
                          </span>
                        ) : category === 'started' ? (
                          <span className="px-2.5 py-1 rounded-lg bg-[#078BFF]/15 border border-[#078BFF]/50 text-[#078BFF] text-[10px] font-mono font-extrabold uppercase tracking-wider">
                            STARTED
                          </span>
                        ) : (
                          <span className="px-2.5 py-1 rounded-lg bg-[#F59E0B]/15 border border-[#F59E0B]/50 text-[#F59E0B] text-[10px] font-mono font-extrabold uppercase tracking-wider">
                            INCOMPLETE
                          </span>
                        )}

                        <div className="flex items-center gap-1.5">
                          {/* Open Full Order Details & Parts Management */}
                          {onOpenChecklist && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onSelectDelivery(del);
                                onOpenChecklist(del);
                              }}
                              className="h-9 px-3 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-white font-mono font-bold text-[11px] inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                              title="Open Order Details, Parts, Pallets & Activity"
                            >
                              <ClipboardList className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)]" />
                              <span className="hidden xs:inline">Details</span>
                            </button>
                          )}

                          {/* Scan Button */}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectDelivery(del);
                              onStartScanning(del);
                            }}
                            className="h-9 px-3 rounded-xl pt-btn-primary font-mono font-bold text-[11px] uppercase inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                            title="Scan parts for this docket"
                          >
                            <QrCode className="w-3.5 h-3.5" />
                            <span>Scan</span>
                          </button>

                          {/* Expand/Collapse Chevron */}
                          <div className="w-8 h-8 rounded-lg bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] flex items-center justify-center text-[var(--pt-text-secondary,#A3A8BD)]">
                            {isExpanded ? (
                              <ChevronUp className="w-4 h-4" />
                            ) : (
                              <ChevronDown className="w-4 h-4" />
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Progress Bar */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-[11px] font-mono">
                        <span className="text-[var(--pt-text-secondary,#A3A8BD)]">
                          Completion:{' '}
                          <strong className="text-white tabular-nums">{progressPct}%</strong> (
                          {receivedParts} of {totalParts} parts)
                        </span>
                        <span
                          className={
                            remainingParts === 0
                              ? 'text-[#00D979] font-bold'
                              : 'text-[#F59E0B] font-semibold'
                          }
                        >
                          {remainingParts === 0
                            ? 'All parts verified'
                            : `${remainingParts} remaining`}
                        </span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-300"
                          style={{
                            width: `${progressPct}%`,
                            backgroundColor:
                              category === 'finished'
                                ? '#00D979'
                                : category === 'started'
                                ? '#078BFF'
                                : '#F59E0B',
                          }}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Expanded Order Details & Parts Preview */}
                  {isExpanded && (
                    <div className="border-t border-[var(--pt-border,#29243D)] bg-[var(--pt-bg-secondary,#101321)] p-4 sm:p-5 space-y-4">
                      {/* Action Toolbar */}
                      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[var(--pt-border,#29243D)]">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              exportDeliveryPdf(del);
                            }}
                            className="h-8 px-3 rounded-lg bg-[var(--pt-card,#15182A)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-xs font-mono font-semibold text-white inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                          >
                            <Printer className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)]" />
                            <span>Export PDF</span>
                          </button>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectDelivery(del);
                              setEditorTarget({ delivery: del, mode: { type: 'add' } });
                            }}
                            className="h-8 px-3 rounded-lg bg-[var(--pt-card,#15182A)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-xs font-mono font-bold text-[#00D979] inline-flex items-center gap-1 cursor-pointer transition-colors"
                          >
                            <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                            <span>+ Add Part</span>
                          </button>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectDelivery(del);
                              setEditorTarget({ delivery: del, mode: { type: 'bulk-edit' } });
                            }}
                            className="h-8 px-3 rounded-lg bg-[var(--pt-card,#15182A)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-xs font-mono font-semibold text-white inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                          >
                            <FileSpreadsheet className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)]" />
                            <span>Edit Parts List</span>
                          </button>

                          {category === 'finished' ? (
                            <button
                              type="button"
                              onClick={(e) => handleReopenOrder(del, e)}
                              className="h-8 px-3 rounded-lg bg-[#F59E0B]/15 hover:bg-[#F59E0B]/25 border border-[#F59E0B]/40 text-xs font-mono font-semibold text-[#F59E0B] inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              <span>Reopen Order</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={(e) => handleMarkOrderComplete(del, e)}
                              className="h-8 px-3 rounded-lg bg-[#00D979]/15 hover:bg-[#00D979]/25 border border-[#00D979]/40 text-xs font-mono font-semibold text-[#00D979] inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>Mark Complete</span>
                            </button>
                          )}

                          {(onOpenChecklist || onNavigateToChecklist) && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onSelectDelivery(del);
                                if (onOpenChecklist) onOpenChecklist(del);
                                else if (onNavigateToChecklist) onNavigateToChecklist('all');
                              }}
                              className="h-8 px-3 rounded-lg bg-[var(--pt-card,#15182A)] hover:bg-white/10 border border-[var(--pt-primary,#A020F0)]/50 text-xs font-mono font-bold text-[var(--pt-primary-light,#C084FC)] inline-flex items-center gap-1 cursor-pointer transition-colors"
                            >
                              <span>Open Full Order View</span>
                              <ArrowUpRight className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>

                        {/* Delete Order Action */}
                        {confirmDeleteId === del.id ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-mono text-[#EF4444]">
                              Delete docket?
                            </span>
                            <button
                              type="button"
                              onClick={(e) => handleConfirmDelete(del.id, e)}
                              className="h-7 px-2.5 rounded bg-[#EF4444] hover:bg-red-500 text-white text-[11px] font-mono font-bold cursor-pointer"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteId(null);
                              }}
                              className="h-7 px-2 rounded bg-[var(--pt-card,#15182A)] text-slate-300 text-[11px] font-mono cursor-pointer"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteId(del.id);
                            }}
                            className="h-8 px-2.5 rounded-lg bg-[#EF4444]/10 hover:bg-[#EF4444]/20 border border-[#EF4444]/30 text-[#EF4444] text-xs font-mono inline-flex items-center gap-1 cursor-pointer transition-colors"
                            title="Delete order"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Delete</span>
                          </button>
                        )}
                      </div>

                      {/* Parts List Inside Expanded Order */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] uppercase tracking-wider">
                          <span>Parts Manifest ({displayedParts.length} items)</span>
                          <span>Tap checkbox to verify or edit part row</span>
                        </div>

                        {displayedParts.length > 0 ? (
                          <div className="divide-y divide-[var(--pt-border,#29243D)] rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] max-h-96 overflow-y-auto">
                            {displayedParts.map((part) => {
                              const vState = getPartVerificationState(part);
                              const isReceived = part.status === 'received';
                              const isMismatch = vState.state === 'quantity_mismatch';

                              return (
                                <div
                                  key={part.id}
                                  onClick={() => handleTogglePartManualStatus(del, part)}
                                  className="p-3 flex items-center justify-between gap-3 hover:bg-white/[0.02] cursor-pointer transition-colors"
                                >
                                  <div className="flex items-center gap-3 min-w-0">
                                    <div
                                      className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 border transition-colors ${
                                        isReceived
                                          ? 'bg-[#00D979] border-[#00D979] text-black'
                                          : isMismatch
                                          ? 'bg-[#EF4444]/20 border-[#EF4444] text-[#EF4444]'
                                          : 'border-[var(--pt-border,#29243D)] bg-[var(--pt-card,#15182A)]'
                                      }`}
                                    >
                                      {isReceived && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                                    </div>

                                    <div className="min-w-0">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span
                                          className={`font-mono font-bold text-xs ${
                                            isReceived
                                              ? 'text-[#00D979]'
                                              : isMismatch
                                              ? 'text-[#EF4444]'
                                              : 'text-white'
                                          }`}
                                        >
                                          <HighlightMatch
                                            text={part.partNumber}
                                            query={searchQuery}
                                          />
                                        </span>
                                        {part.itemNumber && (
                                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[var(--pt-card,#15182A)] text-[var(--pt-text-secondary,#A3A8BD)] border border-[var(--pt-border,#29243D)]">
                                            No.{' '}
                                            <HighlightMatch
                                              text={String(part.itemNumber)}
                                              query={searchQuery}
                                            />
                                          </span>
                                        )}
                                        {part.palletNumber && (
                                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[var(--pt-card,#15182A)] text-[var(--pt-primary-light,#C084FC)] border border-[var(--pt-border,#29243D)]">
                                            {part.palletNumber}
                                          </span>
                                        )}
                                      </div>
                                      <p className="text-xs text-[var(--pt-text-secondary,#A3A8BD)] truncate mt-0.5">
                                        <HighlightMatch
                                          text={part.description}
                                          query={searchQuery}
                                        />
                                      </p>
                                    </div>
                                  </div>

                                  <div className="text-right shrink-0 font-mono flex items-center gap-2">
                                    <div>
                                      <div
                                        className={`text-xs font-bold tabular-nums ${
                                          isReceived
                                            ? 'text-[#00D979]'
                                            : isMismatch
                                            ? 'text-[#EF4444]'
                                            : 'text-[#F59E0B]'
                                        }`}
                                      >
                                        {vState.receivedQty} / {vState.requiredQty}
                                      </div>
                                      <div className="text-[10px] text-[var(--pt-text-muted,#737B94)]">
                                        {isReceived
                                          ? 'Verified'
                                          : isMismatch
                                          ? 'Mismatch'
                                          : `${Math.max(
                                              0,
                                              vState.requiredQty - vState.receivedQty
                                            )} left`}
                                      </div>
                                    </div>

                                    <div
                                      className="flex items-center gap-1 pl-1 border-l border-[var(--pt-border,#29243D)]"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <button
                                        type="button"
                                        onClick={() => {
                                          onSelectDelivery(del);
                                          setEditorTarget({
                                            delivery: del,
                                            mode: { type: 'edit-single', part },
                                          });
                                        }}
                                        className="w-7 h-7 rounded bg-[var(--pt-card,#15182A)] hover:bg-white/10 text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white flex items-center justify-center cursor-pointer"
                                        title={`Edit part ${part.partNumber}`}
                                      >
                                        <Edit3 className="w-3.5 h-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          onSelectDelivery(del);
                                          setEditorTarget({
                                            delivery: del,
                                            mode: { type: 'delete-confirm', part },
                                          });
                                        }}
                                        className="w-7 h-7 rounded bg-[var(--pt-card,#15182A)] hover:bg-[#EF4444]/20 text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[#EF4444] flex items-center justify-center cursor-pointer"
                                        title={`Delete part ${part.partNumber}`}
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="p-4 text-center text-xs font-mono text-[var(--pt-text-muted,#737B94)]">
                            No parts match your search criteria.
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          /* Empty State */
          <div className="rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] p-10 text-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] text-[var(--pt-primary-light,#C084FC)] flex items-center justify-center mx-auto">
              <Layers className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-white">
                {searchQuery
                  ? 'No Matching Orders Found'
                  : filterTab === 'incomplete'
                  ? 'No Incomplete Orders'
                  : filterTab === 'started'
                  ? 'No Started Orders In Progress'
                  : filterTab === 'finished'
                  ? 'No Completed Orders Yet'
                  : 'No Orders Logged'}
              </h3>
              <p className="text-xs font-mono text-[var(--pt-text-secondary,#A3A8BD)] max-w-sm mx-auto">
                {searchQuery
                  ? 'Try clearing your search filter or switching tabs.'
                  : 'Upload a delivery docket photo or PDF to extract parts automatically and begin verification.'}
              </p>
            </div>
            <div className="pt-2">
              <button
                type="button"
                onClick={onOpenNewDelivery}
                className="h-10 px-5 rounded-xl pt-btn-primary font-mono font-bold text-xs uppercase tracking-wider inline-flex items-center gap-2 cursor-pointer"
              >
                <Plus className="w-4 h-4 stroke-[2.5]" />
                <span>NEW ORDER</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Manual Parts List Editor Modal (Add / Edit / Bulk Edit / Delete) */}
      {editorTarget && (
        <PartsListEditorModal
          delivery={editorTarget.delivery}
          mode={editorTarget.mode}
          onClose={() => setEditorTarget(null)}
          onDeliveryUpdated={(updated) => {
            if (onUpdateDelivery) onUpdateDelivery(updated);
            else onSelectDelivery(updated);
            setDeliveries(getStoredDeliveries());
          }}
        />
      )}
    </div>
  );
};
