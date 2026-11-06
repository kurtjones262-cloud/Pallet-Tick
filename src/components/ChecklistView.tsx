import React, { useState, useMemo, useEffect } from 'react';
import {
  Search,
  Check,
  X,
  Plus,
} from 'lucide-react';
import { Delivery, DeliveryPart } from '../types/delivery';
import { setPartStatus } from '../utils/storage';
import { playAudio, triggerHaptic } from '../utils/audioFeedback';

interface ChecklistViewProps {
  delivery: Delivery | null;
  onUpdateDelivery: (updated: Delivery) => void;
  onOpenTestSheet: () => void;
  onOpenUnexpectedModal?: () => void;
  initialPalletFilter?: string;
  onOpenNewDelivery?: () => void;
}

export const ChecklistView: React.FC<ChecklistViewProps> = ({
  delivery,
  onUpdateDelivery,
  initialPalletFilter,
  onOpenNewDelivery,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'outstanding' | 'received' | 'unexpected'>('all');
  const [palletFilter, setPalletFilter] = useState<string>(initialPalletFilter || 'all');
  const [selectedPart, setSelectedPart] = useState<DeliveryPart | null>(null);

  useEffect(() => {
    if (initialPalletFilter) {
      setPalletFilter(initialPalletFilter);
    }
  }, [initialPalletFilter]);

  const parts = delivery?.parts || [];
  const unexpectedParts = delivery?.unexpectedParts || [];

  // Extract distinct pallets
  const pallets = useMemo(() => {
    const set = new Set<string>();
    parts.forEach((p) => {
      if (p.palletNumber) set.add(String(p.palletNumber));
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [parts]);

  // Filtered & searched parts
  const filteredParts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    return parts.filter((part) => {
      if (statusFilter === 'outstanding' && part.status !== 'outstanding') return false;
      if (statusFilter === 'received' && part.status !== 'received') return false;
      if (statusFilter === 'unexpected') return false;

      if (palletFilter !== 'all' && String(part.palletNumber) !== palletFilter) return false;

      if (!q) return true;
      return (
        part.partNumber.toLowerCase().includes(q) ||
        part.itemNumber.toLowerCase().includes(q) ||
        part.description.toLowerCase().includes(q) ||
        (part.material && part.material.toLowerCase().includes(q))
      );
    });
  }, [parts, statusFilter, palletFilter, searchQuery]);

  const totalCount = parts.length;
  const receivedCount = parts.filter((p) => p.status === 'received').length;
  const outstandingCount = totalCount - receivedCount;
  const unexpectedCount = unexpectedParts.length;

  const handleToggleStatus = (part: DeliveryPart, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!delivery) return;

    const newStatus = part.status === 'received' ? 'outstanding' : 'received';
    const updated = setPartStatus(delivery.id, part.id, newStatus, 'manual');

    if (newStatus === 'received') {
      playAudio.success();
      triggerHaptic('success');
    } else {
      playAudio.undo();
      triggerHaptic('undo');
    }

    if (updated) {
      onUpdateDelivery(updated);
      if (selectedPart && selectedPart.id === part.id) {
        setSelectedPart({
          ...selectedPart,
          status: newStatus,
          scannedAt: newStatus === 'received' ? new Date().toISOString() : undefined,
          scannedVia: newStatus === 'received' ? 'manual' : undefined,
        });
      }
    }
  };

  if (!delivery) {
    return (
      <div className="flex-1 w-full max-w-md mx-auto px-6 py-20 flex flex-col items-center justify-center text-center">
        <p className="text-sm font-semibold text-[#18181B]">No Active Delivery</p>
        <p className="text-xs text-zinc-500 mt-1 max-w-xs leading-relaxed">
          Create or select a delivery docket to view and verify its parts checklist.
        </p>
        {onOpenNewDelivery && (
          <button
            onClick={onOpenNewDelivery}
            className="mt-4 h-9 px-3.5 bg-white border border-[#E4E3DE] hover:bg-zinc-50 text-[#18181B] font-medium text-xs rounded-[4px] inline-flex items-center gap-1.5 cursor-pointer transition-colors"
          >
            <Plus className="w-3.5 h-3.5 text-zinc-500" />
            <span>New Delivery</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 w-full max-w-2xl mx-auto pb-16 flex flex-col">
      {/* Sticky Compact Search & Filter Header */}
      <div className="sticky top-11 z-20 bg-[#F6F5F2]/95 backdrop-blur-md border-b border-[#E4E3DE]">
        {/* Row 1: Compact Search + Pallet Selector */}
        <div className="px-4 pt-2.5 pb-2 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search part #, item #, description..."
              className="w-full h-8 pl-8 pr-7 bg-white border border-[#E4E3DE] focus:border-zinc-500 rounded-[4px] text-[#18181B] placeholder:text-zinc-400 text-xs outline-none transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 p-0.5 cursor-pointer"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {pallets.length > 1 && statusFilter !== 'unexpected' && (
            <select
              id="pallet-filter-select"
              aria-label="Filter parts by pallet"
              value={palletFilter}
              onChange={(e) => setPalletFilter(e.target.value)}
              className="h-8 px-2 bg-white border border-[#E4E3DE] focus:border-zinc-500 rounded-[4px] text-xs font-mono text-[#18181B] outline-none cursor-pointer shrink-0"
            >
              <option value="all">All pallets</option>
              {pallets.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Row 2: Minimalist Underline Filter Tabs */}
        <div className="px-4 flex items-center gap-5 overflow-x-auto no-scrollbar text-xs">
          <button
            onClick={() => setStatusFilter('all')}
            className={`pb-2 border-b-2 transition-colors whitespace-nowrap cursor-pointer ${
              statusFilter === 'all'
                ? 'border-[#18181B] text-[#18181B] font-semibold'
                : 'border-transparent text-zinc-500 hover:text-[#18181B]'
            }`}
          >
            All <span className="font-mono text-[11px] text-zinc-400 ml-0.5 tabular-nums">{totalCount}</span>
          </button>

          <button
            onClick={() => setStatusFilter('outstanding')}
            className={`pb-2 border-b-2 transition-colors whitespace-nowrap cursor-pointer ${
              statusFilter === 'outstanding'
                ? 'border-[#18181B] text-[#18181B] font-semibold'
                : 'border-transparent text-zinc-500 hover:text-[#18181B]'
            }`}
          >
            Outstanding <span className="font-mono text-[11px] text-zinc-400 ml-0.5 tabular-nums">{outstandingCount}</span>
          </button>

          <button
            onClick={() => setStatusFilter('received')}
            className={`pb-2 border-b-2 transition-colors whitespace-nowrap cursor-pointer ${
              statusFilter === 'received'
                ? 'border-[#059669] text-[#059669] font-semibold'
                : 'border-transparent text-zinc-500 hover:text-[#18181B]'
            }`}
          >
            Received <span className="font-mono text-[11px] opacity-75 ml-0.5 tabular-nums">{receivedCount}</span>
          </button>

          {unexpectedCount > 0 && (
            <button
              onClick={() => setStatusFilter('unexpected')}
              className={`pb-2 border-b-2 transition-colors whitespace-nowrap cursor-pointer ${
                statusFilter === 'unexpected'
                  ? 'border-red-600 text-red-600 font-semibold'
                  : 'border-transparent text-red-600/80 hover:text-red-700'
              }`}
            >
              Unexpected <span className="font-mono text-[11px] ml-0.5 tabular-nums">{unexpectedCount}</span>
            </button>
          )}
        </div>
      </div>

      {/* Dense Stock-Management Inventory List */}
      <div className="flex-1">
        {statusFilter === 'unexpected' ? (
          unexpectedParts.length === 0 ? (
            <div className="px-4 py-12 text-center text-xs text-zinc-400">
              No unexpected parts recorded.
            </div>
          ) : (
            <div className="bg-white border-b border-[#E4E3DE] divide-y divide-[#E4E3DE]">
              {unexpectedParts.map((unexp) => (
                <div
                  key={unexp.id}
                  className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs"
                >
                  <div className="min-w-0">
                    <span className="font-mono font-bold text-[#18181B] block truncate">
                      {unexp.code}
                    </span>
                    <span className="text-[11px] text-zinc-400 font-mono">
                      {unexp.codeType.toUpperCase()} · {new Date(unexp.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <span className="font-mono text-[11px] text-red-600 font-medium shrink-0">
                    Unexpected
                  </span>
                </div>
              ))}
            </div>
          )
        ) : filteredParts.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-xs font-medium text-zinc-600">No matching parts</p>
            <p className="text-[11px] text-zinc-400 mt-0.5">
              {searchQuery ? `No results for "${searchQuery}"` : 'No items match the current filter.'}
            </p>
          </div>
        ) : (
          <div className="bg-white border-b border-[#E4E3DE] divide-y divide-[#E4E3DE]">
            {filteredParts.map((part) => {
              const isReceived = part.status === 'received';

              return (
                <div
                  key={part.id}
                  onClick={() => setSelectedPart(part)}
                  className={`px-4 py-2 flex items-center gap-3 transition-colors cursor-pointer ${
                    isReceived ? 'bg-[#F6F5F2]/40 hover:bg-zinc-50' : 'hover:bg-zinc-50'
                  }`}
                >
                  {/* Small Check Indicator with Ergonomic Hit Area */}
                  <button
                    type="button"
                    aria-label={
                      isReceived
                        ? `Mark part ${part.partNumber} as outstanding`
                        : `Mark part ${part.partNumber} as received`
                    }
                    onClick={(e) => handleToggleStatus(part, e)}
                    className="w-7 h-7 -ml-1.5 flex items-center justify-center shrink-0 cursor-pointer"
                  >
                    <span
                      className={`w-4 h-4 rounded-[3px] flex items-center justify-center transition-colors ${
                        isReceived
                          ? 'bg-[#059669] border border-[#059669] text-white'
                          : 'bg-white border border-zinc-300 hover:border-[#059669]'
                      }`}
                    >
                      {isReceived && <Check className="w-3 h-3 stroke-[2.8]" />}
                    </span>
                  </button>

                  {/* Bold Docket No. + Part Number + Full Extracted Details */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        className={`px-1.5 py-0.5 rounded-[3px] font-mono text-[10px] font-bold shrink-0 ${
                          isReceived
                            ? 'bg-emerald-50 text-[#059669] border border-emerald-200'
                            : 'bg-amber-50 text-amber-800 border border-amber-200'
                        }`}
                        title={`Docket No. ${part.itemNumber} (matched by ######-${part.itemNumber})`}
                      >
                        No. {part.itemNumber}
                      </span>
                      <span
                        className={`font-mono text-[13px] font-bold tracking-tight truncate ${
                          isReceived ? 'text-zinc-500' : 'text-[#18181B]'
                        }`}
                      >
                        {part.partNumber}
                      </span>
                      {(part.material || part.thickness || part.dimensions) && (
                        <span className="font-mono text-[10px] px-1.5 py-0.2 rounded-[2px] bg-[#F6F5F2] border border-[#E4E3DE] text-zinc-600 truncate">
                          {[part.thickness, part.material, part.dimensions].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 truncate leading-snug mt-0.5">
                      <span className="truncate">{part.description}</span>
                      {part.weight && (
                        <>
                          <span className="text-zinc-300 shrink-0">·</span>
                          <span className="font-mono text-[10px] text-zinc-400 shrink-0">
                            {part.weight}
                          </span>
                        </>
                      )}
                      {part.palletNumber && (
                        <>
                          <span className="text-zinc-300 shrink-0">·</span>
                          <span className="font-mono text-[10px] text-zinc-400 shrink-0">
                            {part.palletNumber}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Compact Unboxed Status */}
                  <div className="shrink-0 text-right font-mono text-[11px]">
                    {isReceived ? (
                      <span className="text-[#059669] font-medium">Received</span>
                    ) : (
                      <span className="text-zinc-400">Outstanding</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Minimalist Part Detail Sheet */}
      {selectedPart && (
        <div
          className="fixed inset-0 z-50 bg-black/35 flex items-end sm:items-center justify-center"
          onClick={() => setSelectedPart(null)}
        >
          <div
            className="w-full max-w-md bg-[#F6F5F2] border-t sm:border border-[#E4E3DE] sm:rounded-[6px] p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 pb-3 border-b border-[#E4E3DE]">
              <div>
                <span className="font-mono text-base font-bold text-[#18181B] block">
                  {selectedPart.partNumber}
                </span>
                <span className="font-mono text-xs text-zinc-500">
                  Item {selectedPart.itemNumber}
                </span>
              </div>
              <button
                onClick={() => setSelectedPart(null)}
                className="p-1 text-zinc-400 hover:text-[#18181B] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="py-3 space-y-2 text-xs border-b border-[#E4E3DE]">
              <div className="flex justify-between py-1 gap-4">
                <span className="text-zinc-500 shrink-0">Description</span>
                <span className="font-medium text-[#18181B] text-right">
                  {selectedPart.description}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-zinc-500">Material & Thickness</span>
                <span className="font-mono text-[#18181B]">
                  {[selectedPart.material, selectedPart.thickness].filter(Boolean).join(' · ') || '—'}
                </span>
              </div>
              {selectedPart.dimensions && (
                <div className="flex justify-between py-1">
                  <span className="text-zinc-500">Dimensions / Size</span>
                  <span className="font-mono text-[#18181B]">{selectedPart.dimensions}</span>
                </div>
              )}
              {selectedPart.weight && (
                <div className="flex justify-between py-1">
                  <span className="text-zinc-500">Weight</span>
                  <span className="font-mono text-[#18181B]">{selectedPart.weight}</span>
                </div>
              )}
              <div className="flex justify-between py-1">
                <span className="text-zinc-500">Pallet</span>
                <span className="font-mono text-[#18181B]">
                  {selectedPart.palletNumber || '—'}
                </span>
              </div>
              {selectedPart.notes && (
                <div className="flex justify-between py-1 gap-4">
                  <span className="text-zinc-500 shrink-0">Notes</span>
                  <span className="text-[#18181B] text-right">{selectedPart.notes}</span>
                </div>
              )}
              <div className="flex justify-between py-1">
                <span className="text-zinc-500">Status</span>
                <span
                  className={`font-mono font-medium ${
                    selectedPart.status === 'received' ? 'text-[#059669]' : 'text-zinc-600'
                  }`}
                >
                  {selectedPart.status === 'received'
                    ? `Received${selectedPart.scannedVia ? ` (${selectedPart.scannedVia.toUpperCase()})` : ''}`
                    : 'Outstanding'}
                </span>
              </div>
            </div>

            <div className="pt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => handleToggleStatus(selectedPart, e)}
                className={`flex-1 h-10 px-4 rounded-[4px] font-semibold text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                  selectedPart.status === 'received'
                    ? 'bg-white border border-[#E4E3DE] text-[#18181B] hover:bg-zinc-50'
                    : 'bg-[#059669] hover:bg-[#047857] text-white'
                }`}
              >
                <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                <span>
                  {selectedPart.status === 'received' ? 'Mark as Outstanding' : 'Mark as Received'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
