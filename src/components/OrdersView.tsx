import React, { useState, useEffect, useMemo } from 'react';
import {
  ClipboardList,
  Search,
  Plus,
  Trash2,
  CheckCircle2,
  Clock,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  QrCode,
  ListChecks,
  FileText,
  Calendar,
  Boxes,
  Truck,
  Check,
  RotateCcw,
  AlertTriangle,
  ArrowUpRight,
  X,
  Edit3,
  FileSpreadsheet,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { Delivery, DeliveryPart } from '../types/delivery';
import {
  getStoredDeliveries,
  setActiveDeliveryId,
  updateDelivery,
  deleteDelivery,
  getPartVerificationState,
} from '../utils/storage';
import { exportDeliveryPdf } from '../utils/pdfExport';
import {
  matchPartWithQuery,
  filterPartsSmart,
  searchAllDeliveriesParts,
  HighlightMatch,
  PartSearchResult,
} from '../utils/partSearch';
import { PartsListEditorModal, PartsEditorMode } from './PartsListEditorModal';

interface OrdersViewProps {
  activeDelivery: Delivery | null;
  onSelectDelivery: (delivery: Delivery) => void;
  onNavigateToChecklist: (palletFilter?: string) => void;
  onStartScanning: () => void;
  onOpenNewDelivery: () => void;
}

type OrderCategoryFilter = 'all' | 'incomplete' | 'started' | 'finished';

export const OrdersView: React.FC<OrdersViewProps> = ({
  activeDelivery,
  onSelectDelivery,
  onNavigateToChecklist,
  onStartScanning,
  onOpenNewDelivery,
}) => {
  const [deliveries, setDeliveries] = useState<Delivery[]>(() => getStoredDeliveries());
  const [categoryFilter, setCategoryFilter] = useState<OrderCategoryFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(() => activeDelivery?.id || null);
  const [partsFilter, setPartsFilter] = useState<'all' | 'outstanding' | 'received'>('all');
  const [editorState, setEditorState] = useState<{
    delivery: Delivery;
    mode: PartsEditorMode;
  } | null>(null);

  // Debounce search input for high performance live filtering
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery.trim());
    }, 120);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Direct cross-docket part matches (matches last 4 digits, partial numbers, keywords anywhere)
  const matchingParts = useMemo<PartSearchResult[]>(() => {
    if (!debouncedQuery) return [];
    return searchAllDeliveriesParts(deliveries, debouncedQuery);
  }, [deliveries, debouncedQuery]);

  const refreshDeliveries = () => {
    setDeliveries(getStoredDeliveries());
  };

  useEffect(() => {
    const handleDeliveriesUpdated = () => refreshDeliveries();
    const handleActiveChanged = () => refreshDeliveries();

    window.addEventListener('parttrack_deliveries_updated', handleDeliveriesUpdated);
    window.addEventListener('parttrack_active_delivery_changed', handleActiveChanged);

    return () => {
      window.removeEventListener('parttrack_deliveries_updated', handleDeliveriesUpdated);
      window.removeEventListener('parttrack_active_delivery_changed', handleActiveChanged);
    };
  }, []);

  // Compute order state: 'incomplete' (0% scanned), 'started' (>0% and <100%), 'finished' (100% or completed)
  const categorizedOrders = useMemo(() => {
    return deliveries.map((d) => {
      const parts = d.parts || [];
      const total = parts.length;
      const received = parts.filter((p) => p.status === 'received').length;
      const percentage = total > 0 ? Math.round((received / total) * 100) : 0;

      let category: 'incomplete' | 'started' | 'finished';
      if (d.status === 'completed' || (total > 0 && received === total)) {
        category = 'finished';
      } else if (received > 0) {
        category = 'started';
      } else {
        category = 'incomplete';
      }

      return {
        delivery: d,
        total,
        received,
        remaining: total - received,
        percentage,
        category,
        isActive: activeDelivery?.id === d.id,
      };
    });
  }, [deliveries, activeDelivery?.id]);

  // Counts for filter pills
  const counts = useMemo(() => {
    let incomplete = 0;
    let started = 0;
    let finished = 0;

    categorizedOrders.forEach((o) => {
      if (o.category === 'finished') finished += 1;
      else if (o.category === 'started') started += 1;
      else incomplete += 1;
    });

    return {
      all: categorizedOrders.length,
      incomplete,
      started,
      finished,
    };
  }, [categorizedOrders]);

  // Filtered orders list
  const filteredOrders = useMemo(() => {
    const q = debouncedQuery.toLowerCase();

    return categorizedOrders
      .filter((item) => {
        // Category filter
        if (categoryFilter !== 'all' && item.category !== categoryFilter) {
          return false;
        }

        // Search query filter
        if (q) {
          const d = item.delivery;
          const matchesDocket = (d.docketNumber || '').toLowerCase().includes(q);
          const matchesSupplier = (d.supplier || '').toLowerCase().includes(q);
          const matchesOrder = (d.orderNumber || '').toLowerCase().includes(q);
          const matchesCarrier = (d.carrier || '').toLowerCase().includes(q);
          const matchesParts = (d.parts || []).some(
            (p) => matchPartWithQuery(p, q, { docketNumber: d.docketNumber, supplier: d.supplier, carrier: d.carrier }).isMatch
          );
          return matchesDocket || matchesSupplier || matchesOrder || matchesCarrier || matchesParts;
        }

        return true;
      })
      .map((item) => {
        if (!debouncedQuery) {
          return { ...item, matchingPartsCount: 0 };
        }
        const d = item.delivery;
        const count = (d.parts || []).filter(
          (p) => matchPartWithQuery(p, debouncedQuery, { docketNumber: d.docketNumber, supplier: d.supplier, carrier: d.carrier }).isMatch
        ).length;
        return { ...item, matchingPartsCount: count };
      });
  }, [categorizedOrders, categoryFilter, debouncedQuery]);

  // Handle deleting an order
  const handleDeleteOrder = (order: Delivery, e: React.MouseEvent) => {
    e.stopPropagation();
    const docketName = order.docketNumber || 'Untitled Docket';
    const supplier = order.supplier || 'Unknown Supplier';
    const partsCount = (order.parts || []).length;

    if (
      confirm(
        `Permanently remove order "${docketName}" (${supplier})?\n\nAll ${partsCount} parts and scan history records will be completely deleted.`
      )
    ) {
      deleteDelivery(order.id);
      refreshDeliveries();
      if (activeDelivery?.id === order.id) {
        const remaining = getStoredDeliveries();
        if (remaining.length > 0) {
          onSelectDelivery(remaining[0]);
        }
      }
    }
  };

  // Toggle order completion status at any time (complete or reopen to continue scanning)
  const handleToggleComplete = (order: Delivery, e: React.MouseEvent) => {
    e.stopPropagation();
    const isNowComplete = order.status !== 'completed';
    const updated: Delivery = {
      ...order,
      status: isNowComplete ? 'completed' : 'receiving',
      updatedAt: new Date().toISOString(),
    };
    updateDelivery(updated);
    refreshDeliveries();
    if (activeDelivery?.id === order.id) {
      onSelectDelivery(updated);
    }
    if (isNowComplete) {
      try {
        confetti({
          particleCount: 50,
          spread: 60,
          origin: { y: 0.6 },
          colors: ['#00A8FF', '#00D2FF', '#10B981', '#ffffff'],
        });
      } catch {}
    }
  };

  // Select an order and make it active
  const handleSelectOrder = (order: Delivery) => {
    setActiveDeliveryId(order.id);
    onSelectDelivery(order);
    setExpandedOrderId(order.id);
  };

  // Toggle order expansion
  const toggleExpand = (orderId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setExpandedOrderId((prev) => (prev === orderId ? null : orderId));
  };

  return (
    <div className="flex-1 w-full bg-[#070A0F] text-slate-100 flex flex-col pb-24 selection:bg-cyan-500/30 selection:text-cyan-200">
      <div className="w-full max-w-5xl mx-auto px-3 sm:px-6 pt-4 sm:pt-6 space-y-4 sm:space-y-6">

        {/* =========================================================================
         * 1. ORDERS HEADER & NEW ORDER CTA
         * ========================================================================= */}
        <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 sm:p-5 rounded-xl bg-[#0E1626] border border-[#1E2D44] shadow-md">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ClipboardList className="w-5 h-5 text-cyan-400 shrink-0" />
              <h1 className="text-lg sm:text-xl font-bold tracking-tight text-white font-sans">
                Orders &amp; Shipments
              </h1>
              <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-500/30">
                {counts.all} Total
              </span>
            </div>
            <p className="text-xs font-mono text-slate-400 mt-1">
              Select any order to inspect individual parts, launch scanning, or remove completed dockets.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onOpenNewDelivery}
              className="h-10 px-4 rounded-xl bg-gradient-to-r from-cyan-400 to-blue-600 hover:from-cyan-300 hover:to-blue-500 text-black font-bold text-xs tracking-wider uppercase inline-flex items-center gap-2 shadow-[0_0_15px_rgba(0,168,255,0.35)] transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4 stroke-[2.5]" />
              <span>New Order</span>
            </button>
          </div>
        </header>

        {/* =========================================================================
         * 2. SEARCH & STATUS CATEGORY FILTERS (Incomplete / Started / Finished)
         * ========================================================================= */}
        <div className="space-y-3">
          {/* Search bar */}
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id="orders-smart-search-input"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by last 4 digits (e.g. 2048), part #, keyword, or docket #..."
              className="w-full h-11 pl-10 pr-10 rounded-xl bg-[#0E1626] border border-[#1E2D44] focus:border-cyan-500 focus:outline-none text-xs text-white placeholder-slate-500 font-sans shadow-sm transition-colors"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md bg-white/10 hover:bg-white/20 text-slate-300 flex items-center justify-center cursor-pointer text-xs"
                title="Clear search"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Category Filter Tabs: All, Incomplete, Started, Finished */}
          <div className="flex items-center gap-1.5 p-1 rounded-xl bg-[#0E1626] border border-[#1E2D44] overflow-x-auto no-scrollbar">
            {/* All */}
            <button
              type="button"
              onClick={() => setCategoryFilter('all')}
              className={`flex-1 min-w-[70px] py-2 px-3 rounded-lg text-xs font-mono font-bold tracking-wide transition-all cursor-pointer text-center ${
                categoryFilter === 'all'
                  ? 'bg-cyan-500 text-black shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}
            >
              All ({counts.all})
            </button>

            {/* Incomplete */}
            <button
              type="button"
              onClick={() => setCategoryFilter('incomplete')}
              className={`flex-1 min-w-[95px] py-2 px-3 rounded-lg text-xs font-mono font-bold tracking-wide transition-all cursor-pointer text-center ${
                categoryFilter === 'incomplete'
                  ? 'bg-amber-500 text-black shadow-sm'
                  : 'text-slate-400 hover:text-amber-400 hover:bg-white/5'
              }`}
            >
              Incomplete ({counts.incomplete})
            </button>

            {/* Started / In Progress */}
            <button
              type="button"
              onClick={() => setCategoryFilter('started')}
              className={`flex-1 min-w-[85px] py-2 px-3 rounded-lg text-xs font-mono font-bold tracking-wide transition-all cursor-pointer text-center ${
                categoryFilter === 'started'
                  ? 'bg-blue-500 text-white shadow-sm'
                  : 'text-slate-400 hover:text-cyan-400 hover:bg-white/5'
              }`}
            >
              Started ({counts.started})
            </button>

            {/* Finished / Completed */}
            <button
              type="button"
              onClick={() => setCategoryFilter('finished')}
              className={`flex-1 min-w-[85px] py-2 px-3 rounded-lg text-xs font-mono font-bold tracking-wide transition-all cursor-pointer text-center ${
                categoryFilter === 'finished'
                  ? 'bg-emerald-500 text-black shadow-sm'
                  : 'text-slate-400 hover:text-emerald-400 hover:bg-white/5'
              }`}
            >
              Finished ({counts.finished})
            </button>
          </div>
        </div>

        {/* =========================================================================
         * 3. DIRECT MATCHING PARTS (From Smart Search: Last 4 digits, keywords, etc.)
         * ========================================================================= */}
        {debouncedQuery && matchingParts.length > 0 && (
          <div className="space-y-2.5 p-4 rounded-2xl bg-[#090E17] border border-cyan-500/40 shadow-[0_0_25px_rgba(0,168,255,0.12)]">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <Search className="w-4 h-4 text-cyan-400" />
                <h2 className="text-sm font-bold text-white tracking-tight">
                  Matching Parts
                </h2>
                <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-500/30">
                  {matchingParts.length} {matchingParts.length === 1 ? 'part' : 'parts'}
                </span>
              </div>
              <span className="text-[11px] font-mono text-slate-400">
                Matched by last 4 digits, part #, or keywords
              </span>
            </div>

            <div className="divide-y divide-[#1E2D44] border border-[#1E2D44] rounded-xl overflow-hidden bg-[#070A0F]">
              {matchingParts.slice(0, 10).map((item) => {
                const { part } = item;
                const verState = getPartVerificationState(part);
                const parentDelivery = deliveries.find((d) => d.id === item.deliveryId);

                return (
                  <div
                    key={`${item.deliveryId}_${part.id}`}
                    onClick={() => {
                      if (parentDelivery) {
                        handleSelectOrder(parentDelivery);
                      }
                    }}
                    className="p-3 sm:p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-white/[0.03] transition-colors cursor-pointer"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-bold text-sm text-white">
                          <HighlightMatch text={part.partNumber} query={searchQuery} />
                        </span>
                        {item.docketNumber && (
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[#131E33] text-cyan-300 border border-cyan-500/30">
                            Docket #{item.docketNumber}
                          </span>
                        )}
                        {item.supplier && (
                          <span className="text-[10px] font-mono text-slate-400">
                            {item.supplier}
                          </span>
                        )}
                        {part.palletNumber && (
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-black/40 text-slate-400 border border-slate-700">
                            Pallet {part.palletNumber}
                          </span>
                        )}
                      </div>

                      <p className="text-xs text-slate-300 font-sans leading-snug">
                        <HighlightMatch text={part.description || 'Laser-cut item'} query={searchQuery} />
                      </p>

                      {(part.material || part.thickness) && (
                        <div className="text-[11px] font-mono text-slate-400">
                          {[part.thickness, part.material].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-3 self-end sm:self-auto shrink-0">
                      <div className="text-right font-mono">
                        <div className="text-xs font-bold text-white tabular-nums">
                          {verState.receivedQty} / {verState.requiredQty}
                        </div>
                        <div className="text-[10px] text-slate-500 uppercase">Qty</div>
                      </div>

                      <div>
                        {verState.state === 'verified' ? (
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-950/80 text-emerald-400 border border-emerald-500/30">
                            VERIFIED
                          </span>
                        ) : verState.state === 'quantity_mismatch' ? (
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-950/80 text-amber-400 border border-amber-500/30">
                            MISMATCH
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-800 text-slate-400 border border-slate-700">
                            OUTSTANDING
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (parentDelivery) {
                              handleSelectOrder(parentDelivery);
                            }
                            onNavigateToChecklist(part.palletNumber ? String(part.palletNumber) : undefined);
                          }}
                          className="h-8 px-2.5 rounded-lg bg-[#142036] hover:bg-[#1E2E4A] border border-[#1E2D44] text-xs font-mono font-medium text-slate-300 hover:text-white inline-flex items-center gap-1 cursor-pointer transition-colors"
                          title="Open part in Checklist"
                        >
                          <ListChecks className="w-3.5 h-3.5 text-cyan-400" />
                          <span className="hidden sm:inline">Checklist</span>
                        </button>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (parentDelivery) {
                              handleSelectOrder(parentDelivery);
                            }
                            onStartScanning();
                          }}
                          className="h-8 px-2.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black font-bold text-xs font-mono inline-flex items-center gap-1 cursor-pointer shadow-sm transition-colors"
                          title="Scan this part"
                        >
                          <QrCode className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">Scan</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* =========================================================================
         * 4. ORDERS LIST
         * ========================================================================= */}
        <div className="space-y-3.5">
          {debouncedQuery && filteredOrders.length > 0 && (
            <div className="flex items-center gap-2 pt-1">
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-slate-400">
                Matching Orders ({filteredOrders.length})
              </span>
            </div>
          )}
          {filteredOrders.length > 0 ? (
            filteredOrders.map(({ delivery: d, total, received, remaining, percentage, category, isActive, matchingPartsCount }) => {
              const isExpanded = expandedOrderId === d.id;

              return (
                <div
                  key={d.id}
                  className={`rounded-2xl transition-all border overflow-hidden ${
                    isActive
                      ? 'bg-[#101C31] border-cyan-500/60 shadow-[0_0_20px_rgba(0,168,255,0.15)]'
                      : 'bg-[#0E1626] border-[#1E2D44] hover:border-slate-600'
                  }`}
                >
                  {/* Order Summary Header / Card Row */}
                  <div
                    onClick={() => handleSelectOrder(d)}
                    className="p-4 sm:p-5 cursor-pointer flex flex-col gap-3"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                      {/* Left: Docket Number & Supplier */}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono font-bold text-base text-cyan-300">
                            #{d.docketNumber}
                          </span>
                          <span className="text-sm font-bold text-white font-sans">
                            {d.supplier}
                          </span>
                          {isActive && (
                            <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-cyan-400 text-black">
                              ACTIVE
                            </span>
                          )}
                        </div>

                        {/* Order Metadata */}
                        <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-slate-400 mt-1">
                          <span className="inline-flex items-center gap-1">
                            <Calendar className="w-3.5 h-3.5 text-slate-500" />
                            {d.deliveryDate || 'No date'}
                          </span>
                          {d.palletCount ? (
                            <span className="inline-flex items-center gap-1">
                              <Boxes className="w-3.5 h-3.5 text-slate-500" />
                              {d.palletCount} Pallets
                            </span>
                          ) : null}
                          {d.carrier ? (
                            <span className="inline-flex items-center gap-1">
                              <Truck className="w-3.5 h-3.5 text-slate-500" />
                              {d.carrier}
                            </span>
                          ) : null}
                        </div>
                      </div>

                      {/* Right: Status Pill, Complete/Reopen, PDF Export, Delete Order, Parts Toggle */}
                      <div className="flex items-center gap-2 self-start sm:self-auto shrink-0 flex-wrap">
                        {/* Status Pill */}
                        {category === 'finished' ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-mono font-bold bg-emerald-950/80 text-emerald-400 border border-emerald-500/40">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            FINISHED
                          </span>
                        ) : category === 'started' ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-mono font-bold bg-cyan-950/80 text-cyan-300 border border-cyan-500/40">
                            <Clock className="w-3.5 h-3.5" />
                            STARTED ({percentage}%)
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-mono font-bold bg-amber-950/80 text-amber-400 border border-amber-500/40">
                            <AlertCircle className="w-3.5 h-3.5" />
                            INCOMPLETE
                          </span>
                        )}

                        {/* Complete / Reopen Button (Can be completed at any time even with outstanding parts, or reopened later to edit/continue scanning) */}
                        {d.status === 'completed' ? (
                          <button
                            type="button"
                            onClick={(e) => handleToggleComplete(d, e)}
                            className="h-8 px-2.5 rounded-lg bg-amber-950/50 hover:bg-amber-900/70 border border-amber-500/40 text-xs font-mono font-bold text-amber-300 hover:text-amber-200 inline-flex items-center gap-1.5 cursor-pointer transition-colors shadow-sm"
                            title="Reopen order to edit or continue scanning"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>Reopen</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => handleToggleComplete(d, e)}
                            className="h-8 px-2.5 rounded-lg bg-emerald-950/60 hover:bg-emerald-900/80 border border-emerald-500/40 text-xs font-mono font-bold text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1.5 cursor-pointer transition-colors shadow-sm"
                            title={
                              remaining > 0
                                ? `Complete order now (${remaining} parts outstanding)`
                                : 'Complete order'
                            }
                          >
                            <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                            <span>Complete</span>
                          </button>
                        )}

                        {/* PDF Export Button (Displayed directly in the orders screen next to every order before opening parts) */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            exportDeliveryPdf(d);
                          }}
                          className="h-8 px-2.5 rounded-lg bg-[#142036] hover:bg-[#1C2C4A] border border-[#1E2D44] hover:border-cyan-500/50 text-xs font-mono font-bold text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1.5 cursor-pointer transition-colors shadow-sm"
                          title={`Export PDF report for Docket #${d.docketNumber}`}
                        >
                          <FileText className="w-3.5 h-3.5" />
                          <span>PDF</span>
                        </button>

                        {/* Delete Order Button */}
                        <button
                          type="button"
                          onClick={(e) => handleDeleteOrder(d, e)}
                          className="h-8 w-8 rounded-lg bg-red-950/40 hover:bg-red-900/60 border border-red-500/30 text-red-400 hover:text-red-200 flex items-center justify-center transition-colors cursor-pointer"
                          title="Remove entire order"
                          aria-label="Delete order"
                        >
                          <Trash2 className="w-4 h-4 stroke-[1.8]" />
                        </button>

                        {/* Expand / Collapse parts chevron */}
                        <button
                          type="button"
                          onClick={(e) => toggleExpand(d.id, e)}
                          className={`h-8 px-2.5 rounded-lg border text-xs font-mono inline-flex items-center gap-1 cursor-pointer transition-colors ${
                            matchingPartsCount > 0
                              ? 'bg-cyan-950/80 hover:bg-cyan-900 border-cyan-500/50 text-cyan-300 font-bold'
                              : 'bg-[#142036] hover:bg-[#1C2C4A] border-[#1E2D44] text-slate-300 hover:text-white'
                          }`}
                          title={isExpanded ? 'Collapse parts' : 'View individual parts'}
                        >
                          <span>
                            {isExpanded
                              ? 'Hide'
                              : matchingPartsCount > 0
                              ? `Parts (${matchingPartsCount} matched)`
                              : 'Parts'}
                          </span>
                          {isExpanded ? (
                            <ChevronUp className="w-3.5 h-3.5 text-cyan-400" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5 text-cyan-400" />
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Progress Bar */}
                    <div className="space-y-1.5 pt-1">
                      <div className="flex items-center justify-between text-xs font-mono">
                        <span className="text-slate-400">
                          {received} of {total} parts received
                        </span>
                        <span className="font-bold text-white tabular-nums">
                          {percentage}% complete
                        </span>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-[#142036] overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            category === 'finished'
                              ? 'bg-emerald-400'
                              : category === 'started'
                              ? 'bg-gradient-to-r from-cyan-400 to-blue-500'
                              : 'bg-amber-400/50'
                          }`}
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                    </div>
                  </div>

                  {/* =========================================================================
                   * EXPANDED INDIVIDUAL PARTS LIST (When Order is Opened)
                   * ========================================================================= */}
                  {isExpanded && (
                    <div className="border-t border-[#1E2D44] bg-[#0A101C] p-4 sm:p-5 space-y-4">
                      {/* Action Bar for this Order */}
                      <div className="flex flex-wrap items-center justify-between gap-2.5 pb-3 border-b border-white/5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-mono font-bold uppercase tracking-wider text-slate-300">
                            {(d.parts || []).length} Part Rows
                          </span>
                          <span className="text-slate-600">·</span>
                          <span className="text-xs font-mono font-bold text-emerald-400">
                            {(d.parts || []).reduce((sum, p) => sum + Math.max(1, p.quantity ?? 1), 0)} Total Qty
                          </span>
                          <span className="text-slate-600">·</span>
                          <span className="text-xs font-mono text-cyan-400">
                            {remaining} Outstanding
                          </span>
                        </div>

                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            type="button"
                            onClick={() =>
                              setEditorState({
                                delivery: d,
                                mode: { type: 'add' },
                              })
                            }
                            className="h-8 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs font-mono inline-flex items-center gap-1.5 cursor-pointer shadow-sm transition-colors"
                          >
                            <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                            <span>+ Add Part</span>
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              setEditorState({
                                delivery: d,
                                mode: { type: 'bulk-edit' },
                              })
                            }
                            className="h-8 px-3 rounded-lg bg-[#142036] hover:bg-[#1C2C4A] border border-[#1E2D44] text-xs font-mono font-medium text-slate-200 inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                          >
                            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
                            <span>Edit Parts List</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              if (d.status === 'completed') {
                                const updated: Delivery = {
                                  ...d,
                                  status: 'receiving',
                                  updatedAt: new Date().toISOString(),
                                };
                                updateDelivery(updated);
                                refreshDeliveries();
                                onSelectDelivery(updated);
                              } else {
                                handleSelectOrder(d);
                              }
                              onStartScanning();
                            }}
                            className="h-8 px-3 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black font-bold text-xs font-mono tracking-wider uppercase inline-flex items-center gap-1.5 cursor-pointer shadow-sm"
                          >
                            <QrCode className="w-3.5 h-3.5 stroke-[2.2]" />
                            <span>Scan Parts</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              handleSelectOrder(d);
                              onNavigateToChecklist();
                            }}
                            className="h-8 px-3 rounded-lg bg-[#142036] hover:bg-[#1C2C4A] border border-[#1E2D44] text-xs font-mono font-medium text-slate-200 inline-flex items-center gap-1.5 cursor-pointer"
                          >
                            <ListChecks className="w-3.5 h-3.5 text-cyan-400" />
                            <span>Full Checklist</span>
                          </button>
                        </div>
                      </div>

                      {/* Parts Quick Status Filter */}
                      <div className="flex items-center gap-1.5 text-xs font-mono">
                        <span className="text-slate-500 text-[11px] uppercase tracking-wider mr-1">Filter:</span>
                        <button
                          type="button"
                          onClick={() => setPartsFilter('all')}
                          className={`px-2 py-0.5 rounded text-[11px] cursor-pointer ${
                            partsFilter === 'all'
                              ? 'bg-cyan-950 text-cyan-300 border border-cyan-500/40'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          All ({total})
                        </button>
                        <button
                          type="button"
                          onClick={() => setPartsFilter('outstanding')}
                          className={`px-2 py-0.5 rounded text-[11px] cursor-pointer ${
                            partsFilter === 'outstanding'
                              ? 'bg-amber-950 text-amber-300 border border-amber-500/40'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          Outstanding ({remaining})
                        </button>
                        <button
                          type="button"
                          onClick={() => setPartsFilter('received')}
                          className={`px-2 py-0.5 rounded text-[11px] cursor-pointer ${
                            partsFilter === 'received'
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          Received ({received})
                        </button>
                      </div>

                      {/* Parts Rows */}
                      <div className="divide-y divide-white/5 border border-[#1E2D44] rounded-xl overflow-hidden bg-[#070A0F]">
                        {(() => {
                          const baseParts = d.parts || [];
                          let partsList = baseParts;
                          if (debouncedQuery) {
                            const smartList = filterPartsSmart(baseParts, debouncedQuery, {
                              docketNumber: d.docketNumber,
                              supplier: d.supplier,
                            });
                            if (smartList.length > 0) {
                              partsList = smartList;
                            }
                          }


                          const filteredList = partsList.filter((p) => {
                            if (partsFilter === 'outstanding') return p.status !== 'received';
                            if (partsFilter === 'received') return p.status === 'received';
                            return true;
                          });

                          if (filteredList.length === 0) {
                            return (
                              <div className="p-4 text-center text-xs font-mono text-slate-500">
                                No parts match the selected filter.
                              </div>
                            );
                          }

                          return filteredList.slice(0, 100).map((part) => {
                            const verState = getPartVerificationState(part);

                            return (
                              <div
                                key={part.id}
                                className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:bg-white/[0.02] transition-colors"
                              >
                                <div className="min-w-0 space-y-0.5">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 border border-slate-700">
                                      No. {part.itemNumber}
                                    </span>
                                    <span className="font-mono font-bold text-xs text-white">
                                      <HighlightMatch text={part.partNumber} query={searchQuery} />
                                    </span>
                                    {part.revision ? (
                                      <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-800 text-amber-300 border border-amber-500/30">
                                        Rev {part.revision}
                                      </span>
                                    ) : null}
                                    {part.palletNumber ? (
                                      <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[#131E33] text-cyan-300 border border-cyan-500/30">
                                        Pallet {part.palletNumber}
                                      </span>
                                    ) : null}
                                    {part.thickness ? (
                                      <span className="text-[10px] font-mono text-slate-500">
                                        {part.thickness}
                                      </span>
                                    ) : null}
                                    {part.manuallyEdited ? (
                                      <span
                                        className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-blue-950/80 text-blue-300 border border-blue-500/30"
                                        title={
                                          part.originalOcrValues
                                            ? `Edited by ${part.lastEditedBy || 'Operator'} · Original OCR: ${part.originalOcrValues.partNumber} (Qty ${part.originalOcrValues.quantity})`
                                            : `Manually edited by ${part.lastEditedBy || 'Operator'}`
                                        }
                                      >
                                        Edited
                                      </span>
                                    ) : null}
                                  </div>
                                  <p className="text-xs text-slate-400 truncate font-sans">
                                    <HighlightMatch text={part.description || 'Laser-cut item'} query={searchQuery} />
                                  </p>
                                </div>

                                <div className="flex items-center gap-2.5 self-end sm:self-auto shrink-0">
                                  <div className="text-right font-mono">
                                    <div className="text-xs font-bold text-white tabular-nums">
                                      {verState.receivedQty} / {verState.requiredQty}
                                    </div>
                                    <div className="text-[10px] text-slate-500">Qty</div>
                                  </div>

                                  <div>
                                    {verState.state === 'verified' ? (
                                      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-950/80 text-emerald-400 border border-emerald-500/30">
                                        VERIFIED
                                      </span>
                                    ) : verState.state === 'quantity_mismatch' ? (
                                      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-950/80 text-amber-400 border border-amber-500/30">
                                        MISMATCH
                                      </span>
                                    ) : (
                                      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-800 text-slate-400 border border-slate-700">
                                        UNSCANNED
                                      </span>
                                    )}
                                  </div>

                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setEditorState({
                                          delivery: d,
                                          mode: { type: 'edit-single', part },
                                        })
                                      }
                                      className="p-1.5 rounded-lg bg-[#142036] hover:bg-[#1E2E4A] border border-[#1E2D44] text-slate-300 hover:text-white cursor-pointer transition-colors"
                                      title={`Edit part ${part.partNumber}`}
                                      aria-label={`Edit part ${part.partNumber}`}
                                    >
                                      <Edit3 className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setEditorState({
                                          delivery: d,
                                          mode: { type: 'delete-confirm', part },
                                        })
                                      }
                                      className="p-1.5 rounded-lg bg-red-950/40 hover:bg-red-900/60 border border-red-500/30 text-red-400 hover:text-red-200 cursor-pointer transition-colors"
                                      title={`Delete part ${part.partNumber}`}
                                      aria-label={`Delete part ${part.partNumber}`}
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </div>
                              </div>
                            );
                          });
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            /* Empty State */
            <div className="py-16 px-6 rounded-2xl bg-[#0E1626] border border-dashed border-[#1E2D44] text-center flex flex-col items-center justify-center space-y-3">
              <ClipboardList className="w-10 h-10 text-slate-500" />
              <h3 className="text-base font-bold text-white">
                {searchQuery ? 'No Matching Parts or Orders' : 'No Orders Found'}
              </h3>
              <p className="text-xs font-mono text-slate-400 max-w-md leading-relaxed">
                {searchQuery
                  ? `No parts or orders match "${searchQuery}". You can search by the last 4 digits (e.g. 2048), partial part numbers (e.g. 048, BRK), descriptions (e.g. bracket, mount, stainless), or docket numbers.`
                  : categoryFilter !== 'all'
                  ? `No orders currently in the "${categoryFilter}" category.`
                  : 'No delivery orders or dockets logged in the system yet.'}
              </p>
              {searchQuery ? (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="mt-2 h-9 px-4 rounded-xl bg-[#142036] hover:bg-[#1C2C4A] border border-[#1E2D44] text-cyan-300 font-mono text-xs inline-flex items-center gap-1.5 cursor-pointer shadow-sm transition-colors"
                >
                  <X className="w-4 h-4" />
                  <span>Clear Search Query</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onOpenNewDelivery}
                  className="mt-2 h-10 px-4 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-bold text-xs uppercase tracking-wider inline-flex items-center gap-1.5 shadow-sm cursor-pointer"
                >
                  <Plus className="w-4 h-4 stroke-[2.5]" />
                  <span>Upload New Docket</span>
                </button>
              )}
            </div>
          )}
        </div>

      </div>

      {/* Parts List Editor Modal for Orders View */}
      {editorState && (
        <PartsListEditorModal
          delivery={editorState.delivery}
          mode={editorState.mode}
          onClose={() => setEditorState(null)}
          onDeliveryUpdated={(updated) => {
            refreshDeliveries();
            if (activeDelivery?.id === updated.id) {
              onSelectDelivery(updated);
            }
          }}
        />
      )}
    </div>
  );
};

