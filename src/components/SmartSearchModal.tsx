import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Search,
  X,
  QrCode,
  ListChecks,
  Boxes,
  Truck,
  CheckCircle2,
  AlertTriangle,
  Clock,
  ArrowRight,
  Filter,
  Check,
  ChevronRight,
} from 'lucide-react';
import { Delivery, DeliveryPart } from '../types/delivery';
import {
  getStoredDeliveries,
  getPartVerificationState,
  setActiveDeliveryId,
} from '../utils/storage';
import {
  searchAllDeliveriesParts,
  filterPartsSmart,
  HighlightMatch,
  PartSearchResult,
} from '../utils/partSearch';

interface SmartSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeDelivery: Delivery | null;
  onSelectPart?: (part: DeliveryPart, delivery: Delivery) => void;
  onNavigateToChecklist?: (palletFilter?: string) => void;
  onStartScanning?: () => void;
  onSelectDelivery?: (delivery: Delivery) => void;
}

export const SmartSearchModal: React.FC<SmartSearchModalProps> = ({
  isOpen,
  onClose,
  activeDelivery,
  onSelectPart,
  onNavigateToChecklist,
  onStartScanning,
  onSelectDelivery,
}) => {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'active'>('all');
  const [selectedResult, setSelectedResult] = useState<PartSearchResult | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>(() => getStoredDeliveries());

  // Focus input and refresh deliveries on open
  useEffect(() => {
    if (isOpen) {
      setDeliveries(getStoredDeliveries());
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    } else {
      setQuery('');
      setDebouncedQuery('');
      setSelectedResult(null);
    }
  }, [isOpen]);

  // Debounce search input by 120ms for instant feel without excessive processing
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, 120);
    return () => clearTimeout(timer);
  }, [query]);

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Compute total parts count
  const totalPartsInSystem = useMemo(() => {
    return deliveries.reduce((acc, d) => acc + (d.parts?.length || 0), 0);
  }, [deliveries]);

  // Calculate matching results
  const searchResults = useMemo<PartSearchResult[]>(() => {
    const q = debouncedQuery.trim();
    if (!q) return [];

    if (scope === 'active' && activeDelivery) {
      const matched = filterPartsSmart(activeDelivery.parts || [], q, {
        docketNumber: activeDelivery.docketNumber,
        supplier: activeDelivery.supplier,
      });

      return matched.map((part) => ({
        part,
        deliveryId: activeDelivery.id,
        docketNumber: activeDelivery.docketNumber,
        supplier: activeDelivery.supplier,
        carrier: activeDelivery.carrier,
        orderNumber: activeDelivery.orderNumber,
        score: 100,
        matchedFields: ['partNumber'],
      }));
    }

    return searchAllDeliveriesParts(deliveries, q);
  }, [debouncedQuery, scope, activeDelivery, deliveries]);

  if (!isOpen) return null;
  if (typeof document === 'undefined') return null;

  const handleChooseResult = (item: PartSearchResult) => {
    // Find parent delivery
    const parentDelivery = deliveries.find((d) => d.id === item.deliveryId) || activeDelivery;
    if (parentDelivery) {
      setActiveDeliveryId(parentDelivery.id);
      onSelectDelivery?.(parentDelivery);
    }

    if (onSelectPart && parentDelivery) {
      onSelectPart(item.part, parentDelivery);
    }
    setSelectedResult(item);
  };

  const handleJumpToChecklist = (item: PartSearchResult) => {
    const parentDelivery = deliveries.find((d) => d.id === item.deliveryId) || activeDelivery;
    if (parentDelivery) {
      setActiveDeliveryId(parentDelivery.id);
      onSelectDelivery?.(parentDelivery);
    }
    onClose();
    onNavigateToChecklist?.(item.part.palletNumber ? String(item.part.palletNumber) : undefined);
  };

  const handleLaunchScan = (item: PartSearchResult) => {
    const parentDelivery = deliveries.find((d) => d.id === item.deliveryId) || activeDelivery;
    if (parentDelivery) {
      setActiveDeliveryId(parentDelivery.id);
      onSelectDelivery?.(parentDelivery);
    }
    onClose();
    onStartScanning?.();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/85 backdrop-blur-md p-2 sm:p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-[#090E17] text-slate-100 rounded-2xl border border-cyan-500/30 shadow-[0_0_60px_rgba(0,168,255,0.25)] flex flex-col max-h-[90dvh] overflow-hidden animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header / Search Input Bar */}
        <div className="p-3 sm:p-4 bg-[#0E1626] border-b border-[#1E2D44] space-y-3 shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-cyan-950/80 border border-cyan-500/30 text-cyan-400 flex items-center justify-center">
                <Search className="w-4 h-4" />
              </div>
              <h2 className="text-sm sm:text-base font-bold text-white tracking-tight font-sans">
                Smart Part Search
              </h2>
              <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-500/30">
                {totalPartsInSystem} Parts Indexed
              </span>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="w-8 h-8 rounded-lg bg-[#142036] hover:bg-[#1E2E4A] text-slate-400 hover:text-white flex items-center justify-center cursor-pointer transition-colors"
              aria-label="Close search"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Search Box Input */}
          <div className="relative">
            <Search className="w-5 h-5 text-cyan-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Type last 4 digits (e.g. "2048"), part #, keyword ("bracket", "plate")...'
              className="w-full h-12 pl-11 pr-10 rounded-xl bg-[#070A0F] border border-cyan-500/40 focus:border-cyan-400 text-white font-mono font-bold text-sm sm:text-base placeholder-slate-500 outline-none shadow-inner transition-colors"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setDebouncedQuery('');
                  inputRef.current?.focus();
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md bg-white/10 hover:bg-white/20 text-slate-300 flex items-center justify-center cursor-pointer text-xs"
                title="Clear search"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Scope Filters: All Dockets vs Active Docket */}
          <div className="flex items-center justify-between text-xs font-mono">
            <div className="flex items-center gap-1.5">
              <span className="text-slate-500 text-[11px] uppercase mr-1">Scope:</span>
              <button
                type="button"
                onClick={() => setScope('all')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold cursor-pointer transition-colors ${
                  scope === 'all'
                    ? 'bg-cyan-500 text-black shadow-xs'
                    : 'bg-[#142036] text-slate-400 hover:text-white'
                }`}
              >
                All Dockets ({deliveries.length})
              </button>
              {activeDelivery && (
                <button
                  type="button"
                  onClick={() => setScope('active')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-bold cursor-pointer transition-colors truncate max-w-[170px] ${
                    scope === 'active'
                      ? 'bg-cyan-500 text-black shadow-xs'
                      : 'bg-[#142036] text-slate-400 hover:text-white'
                  }`}
                  title={`Docket #${activeDelivery.docketNumber} (${activeDelivery.supplier})`}
                >
                  Docket #{activeDelivery.docketNumber}
                </button>
              )}
            </div>

            {debouncedQuery.trim() && (
              <span className="text-[11px] text-cyan-300 font-bold">
                {searchResults.length} {searchResults.length === 1 ? 'match' : 'matches'}
              </span>
            )}
          </div>
        </div>

        {/* Results List or Empty State */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4 space-y-2.5">
          {!debouncedQuery.trim() ? (
            /* Idle Helper State */
            <div className="py-12 px-4 text-center flex flex-col items-center justify-center space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-cyan-950/40 border border-cyan-500/20 text-cyan-400 flex items-center justify-center">
                <Search className="w-6 h-6 stroke-[1.8]" />
              </div>
              <h3 className="text-sm font-bold text-white">Fast Partial Search Active</h3>
              <p className="text-xs font-mono text-slate-400 max-w-md leading-relaxed">
                Type the <strong className="text-cyan-300">last four digits</strong> of a part number (e.g.{' '}
                <span className="text-cyan-300 underline cursor-pointer" onClick={() => setQuery('2048')}>
                  2048
                </span>
                ), middle digits (<span className="text-cyan-300 underline cursor-pointer" onClick={() => setQuery('048')}>048</span>), or part keywords like{' '}
                <span className="text-cyan-300 underline cursor-pointer" onClick={() => setQuery('bracket')}>
                  bracket
                </span>
                ,{' '}
                <span className="text-cyan-300 underline cursor-pointer" onClick={() => setQuery('plate')}>
                  plate
                </span>
                , or{' '}
                <span className="text-cyan-300 underline cursor-pointer" onClick={() => setQuery('stainless')}>
                  stainless
                </span>
                .
              </p>

              {/* Sample Quick Chips */}
              <div className="flex flex-wrap items-center justify-center gap-1.5 pt-2">
                {['2048', '048', 'BRK', 'bracket', 'mount', 'plate', 'stainless'].map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => setQuery(chip)}
                    className="px-2.5 py-1 rounded-lg bg-[#142036] hover:bg-[#1E2E4A] border border-[#1E2D44] text-[11px] font-mono text-cyan-300 cursor-pointer transition-colors"
                  >
                    "{chip}"
                  </button>
                ))}
              </div>
            </div>
          ) : searchResults.length === 0 ? (
            /* No Matches State */
            <div className="py-12 px-4 text-center flex flex-col items-center justify-center space-y-2.5">
              <div className="w-10 h-10 rounded-xl bg-amber-950/40 border border-amber-500/30 text-amber-400 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <h3 className="text-sm font-bold text-white">No Parts Found</h3>
              <p className="text-xs font-mono text-slate-400 max-w-sm leading-relaxed">
                No parts match <span className="text-amber-300 font-bold">"{debouncedQuery}"</span> across{' '}
                {scope === 'all' ? 'all delivery dockets' : `Docket #${activeDelivery?.docketNumber}`}.
              </p>
              <div className="text-[11px] font-mono text-slate-500 pt-1 space-y-1">
                <div>• Try searching by just the last 4 digits</div>
                <div>• Search by partial description (e.g. "plate" or "brk")</div>
                {scope === 'active' && (
                  <button
                    type="button"
                    onClick={() => setScope('all')}
                    className="text-cyan-400 hover:underline font-bold block mx-auto pt-1 cursor-pointer"
                  >
                    Switch to search All Dockets
                  </button>
                )}
              </div>
            </div>
          ) : (
            /* Matched Results List */
            searchResults.map((item) => {
              const { part } = item;
              const vState = getPartVerificationState(part);
              const isSelected = selectedResult?.part.id === part.id;

              return (
                <div
                  key={`${item.deliveryId}_${part.id}`}
                  onClick={() => handleChooseResult(item)}
                  className={`p-3 sm:p-3.5 rounded-xl border transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-[#121E33] border-cyan-500/70 shadow-[0_0_15px_rgba(0,168,255,0.2)]'
                      : 'bg-[#0E1626] border-[#1E2D44] hover:border-slate-600 hover:bg-[#121B2D]'
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                    {/* Left: Part Number & Description */}
                    <div className="min-w-0 space-y-1 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {/* Part Number with Highlight */}
                        <span className="font-mono font-bold text-sm text-white tracking-wide">
                          <HighlightMatch text={part.partNumber} query={debouncedQuery} />
                        </span>

                        {/* Docket Line / Item number */}
                        {part.itemNumber && (
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[#131E33] text-cyan-300 border border-cyan-500/30">
                            Item #<HighlightMatch text={part.itemNumber} query={debouncedQuery} />
                          </span>
                        )}

                        {/* Pallet Number */}
                        {part.palletNumber && (
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-black/40 text-slate-400 border border-slate-700">
                            Pallet {part.palletNumber}
                          </span>
                        )}
                      </div>

                      {/* Part Description with Highlight */}
                      <p className="text-xs text-slate-300 font-sans leading-snug">
                        <HighlightMatch text={part.description} query={debouncedQuery} />
                      </p>

                      {/* Customer / Supplier Association & Docket Metadata */}
                      <div className="flex flex-wrap items-center gap-2.5 text-[11px] font-mono text-slate-400 pt-0.5">
                        {item.supplier && (
                          <span className="text-cyan-400/90 font-semibold truncate max-w-[150px]">
                            {item.supplier}
                          </span>
                        )}
                        {item.docketNumber && (
                          <span className="text-slate-500">
                            Docket #{item.docketNumber}
                          </span>
                        )}
                        {part.thickness && (
                          <span className="text-slate-500">
                            {part.thickness}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Right: Quantity Info & Direct Action */}
                    <div className="flex items-center gap-3 self-end sm:self-auto shrink-0">
                      {/* Quantity Metric */}
                      <div className="text-right font-mono">
                        <div className="text-xs font-bold text-white tabular-nums">
                          {vState.receivedQty} / {vState.requiredQty}
                        </div>
                        <div className="text-[10px] text-slate-500 uppercase">Qty</div>
                      </div>

                      {/* Verification Status Pill */}
                      {vState.state === 'verified' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-950/80 text-emerald-400 border border-emerald-500/30">
                          <CheckCircle2 className="w-3 h-3" />
                          VERIFIED
                        </span>
                      ) : vState.state === 'quantity_mismatch' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-950/80 text-amber-400 border border-amber-500/30">
                          <AlertTriangle className="w-3 h-3" />
                          MISMATCH
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-800 text-slate-400 border border-slate-700">
                          <Clock className="w-3 h-3" />
                          OUTSTANDING
                        </span>
                      )}

                      {/* Quick Actions */}
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleJumpToChecklist(item);
                          }}
                          className="h-8 px-2.5 rounded-lg bg-[#142036] hover:bg-[#1E2E4A] border border-[#1E2D44] text-xs font-mono font-medium text-slate-300 hover:text-white inline-flex items-center gap-1 cursor-pointer transition-colors"
                          title="Open in checklist"
                        >
                          <ListChecks className="w-3.5 h-3.5 text-cyan-400" />
                          <span className="hidden sm:inline">Checklist</span>
                        </button>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleLaunchScan(item);
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
                </div>
              );
            })
          )}
        </div>

        {/* Footer info bar */}
        <div className="px-4 py-2.5 bg-[#0A0F1A] border-t border-[#1E2D44] flex items-center justify-between text-[11px] font-mono text-slate-400 shrink-0">
          <div className="flex items-center gap-2">
            <span>Search matches any 4 digits, partial codes &amp; keywords</span>
          </div>
          <div className="hidden sm:flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-[10px] text-zinc-300">
              ESC
            </kbd>
            <span>to close</span>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
