import React, { useState, useMemo, useEffect } from 'react';
import {
  Search,
  Check,
  X,
  Plus,
  Minus,
  Printer,
  RotateCcw,
  AlertTriangle,
  Edit3,
  Trash2,
  FileSpreadsheet,
  History,
} from 'lucide-react';
import { Delivery, DeliveryPart } from '../types/delivery';
import { setPartStatus, getPartVerificationState } from '../utils/storage';
import { exportDeliveryPdf } from '../utils/pdfExport';
import { playAudio, triggerHaptic } from '../utils/audioFeedback';
import { filterPartsSmart, HighlightMatch } from '../utils/partSearch';
import { PartsListEditorModal, PartsEditorMode } from './PartsListEditorModal';

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
  const [detailQtyInput, setDetailQtyInput] = useState<string>('1');
  const [editorMode, setEditorMode] = useState<PartsEditorMode | null>(null);

  useEffect(() => {
    if (initialPalletFilter) {
      setPalletFilter(initialPalletFilter);
    }
  }, [initialPalletFilter]);

  useEffect(() => {
    if (selectedPart) {
      const vState = getPartVerificationState(selectedPart);
      setDetailQtyInput(
        String(
          selectedPart.status === 'received' ? vState.receivedQty : vState.requiredQty
        )
      );
    }
  }, [selectedPart]);

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

  // Filtered & searched parts using Smart Substring & Keyword Search
  const filteredParts = useMemo(() => {
    const baseParts = parts.filter((part) => {
      if (statusFilter === 'outstanding' && part.status !== 'outstanding') return false;
      if (statusFilter === 'received' && part.status !== 'received') return false;
      if (statusFilter === 'unexpected') return false;
      if (palletFilter !== 'all' && String(part.palletNumber) !== palletFilter) return false;
      return true;
    });

    if (!searchQuery.trim()) return baseParts;

    return filterPartsSmart(baseParts, searchQuery, {
      docketNumber: delivery?.docketNumber,
      supplier: delivery?.supplier,
    });
  }, [parts, statusFilter, palletFilter, searchQuery, delivery?.docketNumber, delivery?.supplier]);

  const totalCount = parts.length;
  const totalQuantityPieces = useMemo(
    () => parts.reduce((sum, p) => sum + Math.max(1, p.quantity ?? 1), 0),
    [parts]
  );
  const receivedCount = parts.filter((p) => p.status === 'received').length;
  const outstandingCount = totalCount - receivedCount;
  const unexpectedCount = unexpectedParts.length;

  const handleToggleStatus = (
    part: DeliveryPart,
    e: React.MouseEvent,
    customQty?: number,
    forceStatus?: 'received' | 'outstanding'
  ) => {
    e.stopPropagation();
    if (!delivery) return;

    const reqQty = Math.max(1, part.quantity ?? 1);
    if (reqQty > 1 && customQty === undefined && !forceStatus) {
      setSelectedPart(part);
      return;
    }

    const newStatus = forceStatus ?? (part.status === 'received' ? 'outstanding' : 'received');
    const updated = setPartStatus(
      delivery.id,
      part.id,
      newStatus,
      'manual',
      undefined,
      newStatus === 'received' ? customQty : undefined
    );

    if (newStatus === 'received') {
      const entered = customQty ?? reqQty;
      if (entered === reqQty) {
        playAudio.success();
        triggerHaptic('success');
      } else {
        playAudio.duplicate();
        triggerHaptic('duplicate');
      }
    } else {
      playAudio.undo();
      triggerHaptic('undo');
    }

    if (updated) {
      onUpdateDelivery(updated);
      setSelectedPart(null);
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
        {/* Row 1: Compact Search + Pallet Selector + Export PDF */}
        <div className="px-4 pt-2.5 pb-2 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by last 4 digits (e.g. 2048), part #, keyword..."
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

          <button
            type="button"
            onClick={() => exportDeliveryPdf(delivery)}
            className="h-8 px-2.5 bg-white hover:bg-zinc-50 border border-[#E4E3DE] text-[#18181B] rounded-[4px] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors shrink-0 shadow-2xs"
            title="Export colour-coded PDF"
          >
            <Printer className="w-3.5 h-3.5 text-[#059669]" />
            <span className="hidden sm:inline">Export PDF</span>
          </button>
        </div>

        {/* Row 1.5: Parts List Summary & Manual Editing Actions (+ Add Part / Edit Parts List) */}
        <div className="px-4 pb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-600">
            <span>
              <strong className="text-[#18181B]">{totalCount}</strong> Part Rows
            </span>
            <span className="text-zinc-300">·</span>
            <span>
              <strong className="text-[#059669]">{totalQuantityPieces}</strong> Total Qty
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setEditorMode({ type: 'add' })}
              className="h-7 px-2.5 rounded-[4px] bg-[#059669] hover:bg-[#047857] text-white font-semibold text-xs inline-flex items-center gap-1 cursor-pointer shadow-2xs transition-colors"
            >
              <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>+ Add Part</span>
            </button>

            <button
              type="button"
              onClick={() => setEditorMode({ type: 'bulk-edit' })}
              className="h-7 px-2.5 rounded-[4px] bg-white hover:bg-zinc-50 border border-[#E4E3DE] text-[#18181B] font-medium text-xs inline-flex items-center gap-1 cursor-pointer transition-colors"
              title="Edit multiple part rows at once"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-zinc-600" />
              <span>Edit Parts List</span>
            </button>
          </div>
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
          <div className="px-4 py-12 text-center space-y-2">
            <p className="text-xs font-semibold text-zinc-700">No matching parts found</p>
            <p className="text-[11px] text-zinc-500 max-w-xs mx-auto">
              {searchQuery
                ? `No parts match "${searchQuery}". Try searching by the last 4 digits (e.g. 2048) or partial description.`
                : 'No items match the current filter.'}
            </p>
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="text-xs font-mono text-[#059669] hover:underline font-semibold cursor-pointer pt-1"
              >
                Clear search filter
              </button>
            )}
          </div>
        ) : (
          <div className="bg-white border-b border-[#E4E3DE] divide-y divide-[#E4E3DE]">
            {filteredParts.map((part) => {
              const vState = getPartVerificationState(part);
              const isReceived = part.status === 'received';
              const isMismatch = vState.state === 'quantity_mismatch';

              return (
                <div
                  key={part.id}
                  onClick={() => setSelectedPart(part)}
                  className={`px-4 py-2 flex items-center gap-2.5 transition-colors cursor-pointer ${
                    isMismatch
                      ? 'bg-amber-50/60 hover:bg-amber-50'
                      : isReceived
                      ? 'bg-emerald-50/25 hover:bg-zinc-50'
                      : 'hover:bg-zinc-50'
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
                        isMismatch
                          ? 'bg-amber-500 border border-amber-500 text-white'
                          : isReceived
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
                          isMismatch
                            ? 'bg-amber-100 text-amber-900 border border-amber-300'
                            : isReceived
                            ? 'bg-emerald-50 text-[#059669] border border-emerald-200'
                            : 'bg-amber-50 text-amber-800 border border-amber-200'
                        }`}
                        title={`Docket No. ${part.itemNumber} (matched by ######-${part.itemNumber})`}
                      >
                        No. {part.itemNumber}
                      </span>
                      <span
                        className={`font-mono text-[13px] font-bold tracking-tight truncate ${
                          isReceived ? 'text-zinc-700' : 'text-[#18181B]'
                        }`}
                      >
                        <HighlightMatch
                          text={part.partNumber}
                          query={searchQuery}
                          highlightClassName="bg-amber-200 text-amber-950 font-bold px-0.5 rounded"
                        />
                      </span>
                      {part.revision && (
                        <span className="px-1.5 py-0.2 rounded-[2px] font-mono text-[10px] font-bold bg-zinc-100 text-zinc-700 border border-zinc-300">
                          Rev {part.revision}
                        </span>
                      )}
                      <span
                        className={`px-1.5 py-0.2 rounded-[2px] font-mono text-[10px] font-semibold ${
                          isMismatch
                            ? 'bg-amber-100 text-amber-900 border border-amber-300'
                            : isReceived
                            ? 'bg-emerald-50 text-[#059669] border border-emerald-200'
                            : 'bg-zinc-100 text-zinc-700 border border-zinc-200'
                        }`}
                      >
                        {isReceived
                          ? `Qty ${vState.receivedQty}/${vState.requiredQty}`
                          : `Req Qty: ${vState.requiredQty}`}
                      </span>
                      {(part.material || part.thickness || part.dimensions) && (
                        <span className="font-mono text-[10px] px-1.5 py-0.2 rounded-[2px] bg-[#F6F5F2] border border-[#E4E3DE] text-zinc-600 truncate">
                          {[part.thickness, part.material, part.dimensions].filter(Boolean).join(' · ')}
                        </span>
                      )}
                      {part.manuallyEdited && (
                        <span
                          className="font-mono text-[9px] px-1.5 py-0.2 rounded-[2px] bg-blue-50 text-blue-700 border border-blue-200"
                          title={
                            part.originalOcrValues
                              ? `Edited by ${part.lastEditedBy || 'Operator'} · Original OCR: ${part.originalOcrValues.partNumber} (Qty ${part.originalOcrValues.quantity})`
                              : `Manually added/edited by ${part.lastEditedBy || 'Operator'}`
                          }
                        >
                          Edited
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 truncate leading-snug mt-0.5">
                      <span className="truncate">
                        <HighlightMatch
                          text={part.description}
                          query={searchQuery}
                          highlightClassName="bg-amber-200 text-amber-950 font-medium px-0.5 rounded"
                        />
                      </span>
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

                  {/* Compact Unboxed Status + Quick Edit & Delete Icons */}
                  <div className="shrink-0 flex items-center gap-1.5">
                    <div className="text-right font-mono text-[11px] mr-1">
                      {isMismatch ? (
                        <span className="text-amber-600 font-semibold flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" />
                          <span>Mismatch ({vState.receivedQty}/{vState.requiredQty})</span>
                        </span>
                      ) : isReceived ? (
                        <span className="text-[#059669] font-medium">Verified</span>
                      ) : (
                        <span className="text-red-600/80">Not Scanned</span>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditorMode({ type: 'edit-single', part });
                      }}
                      className="p-1.5 rounded text-zinc-400 hover:text-[#18181B] hover:bg-zinc-100 transition-colors cursor-pointer"
                      title={`Edit part ${part.partNumber}`}
                      aria-label={`Edit part ${part.partNumber}`}
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditorMode({ type: 'delete-confirm', part });
                      }}
                      className="p-1.5 rounded text-zinc-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                      title={`Delete part ${part.partNumber}`}
                      aria-label={`Delete part ${part.partNumber}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
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
                <div className="flex items-center gap-2">
                  <span className="font-mono text-base font-bold text-[#18181B]">
                    {selectedPart.partNumber}
                  </span>
                  {selectedPart.revision && (
                    <span className="px-1.5 py-0.5 rounded bg-zinc-200 font-mono text-[10px] font-bold text-zinc-800">
                      Rev {selectedPart.revision}
                    </span>
                  )}
                </div>
                <span className="font-mono text-xs text-zinc-500">
                  Docket No. {selectedPart.itemNumber} · Required Qty:{' '}
                  {Math.max(1, selectedPart.quantity ?? 1)}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    const target = selectedPart;
                    setSelectedPart(null);
                    setEditorMode({ type: 'edit-single', part: target });
                  }}
                  className="p-1.5 text-zinc-500 hover:text-[#18181B] hover:bg-zinc-200/60 rounded cursor-pointer"
                  title="Edit part details"
                >
                  <Edit3 className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const target = selectedPart;
                    setSelectedPart(null);
                    setEditorMode({ type: 'delete-confirm', part: target });
                  }}
                  className="p-1.5 text-zinc-500 hover:text-red-600 hover:bg-red-50 rounded cursor-pointer"
                  title="Delete part from docket"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setSelectedPart(null)}
                  className="p-1 text-zinc-400 hover:text-[#18181B] cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="py-3 space-y-2 text-xs border-b border-[#E4E3DE]">
              <div className="flex justify-between py-1 gap-4">
                <span className="text-zinc-500 shrink-0">Description</span>
                <span className="font-medium text-[#18181B] text-right">
                  {selectedPart.description}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-zinc-500">Revision</span>
                <span className="font-mono text-[#18181B]">
                  {selectedPart.revision || '—'}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-zinc-500">Material &amp; Thickness</span>
                <span className="font-mono text-[#18181B]">
                  {[selectedPart.material, selectedPart.thickness].filter(Boolean).join(' · ') || '—'}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-zinc-500">Required Quantity</span>
                <span className="font-mono font-bold text-[#18181B]">
                  {Math.max(1, selectedPart.quantity ?? 1)}
                </span>
              </div>
              {selectedPart.status === 'received' && (
                <div className="flex justify-between py-1">
                  <span className="text-zinc-500">Scanned / Received Quantity</span>
                  <span
                    className={`font-mono font-bold ${
                      getPartVerificationState(selectedPart).state === 'quantity_mismatch'
                        ? 'text-amber-600'
                        : 'text-[#059669]'
                    }`}
                  >
                    {getPartVerificationState(selectedPart).receivedQty}
                  </span>
                </div>
              )}
              <div className="flex justify-between py-1">
                <span className="text-zinc-500">Pallet</span>
                <span className="font-mono text-[#18181B]">
                  {selectedPart.palletNumber || '—'}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-zinc-500">Status</span>
                <span
                  className={`font-mono font-semibold ${
                    getPartVerificationState(selectedPart).state === 'quantity_mismatch'
                      ? 'text-amber-600'
                      : selectedPart.status === 'received'
                      ? 'text-[#059669]'
                      : 'text-red-600'
                  }`}
                >
                  {getPartVerificationState(selectedPart).state === 'quantity_mismatch'
                    ? `Quantity Mismatch (${getPartVerificationState(selectedPart).receivedQty}/${getPartVerificationState(selectedPart).requiredQty})`
                    : selectedPart.status === 'received'
                    ? `Verified (${getPartVerificationState(selectedPart).receivedQty}/${getPartVerificationState(selectedPart).requiredQty})`
                    : 'Not Scanned'}
                </span>
              </div>

              {selectedPart.manuallyEdited && (
                <div className="p-2 rounded bg-blue-50/70 border border-blue-200 text-[11px] text-blue-900 space-y-0.5">
                  <div className="flex items-center gap-1 font-semibold">
                    <History className="w-3 h-3" />
                    <span>Manually Edited by {selectedPart.lastEditedBy || 'Operator'}</span>
                  </div>
                  {selectedPart.originalOcrValues && (
                    <div className="font-mono text-[10px] text-blue-800">
                      Original OCR: {selectedPart.originalOcrValues.partNumber} · Qty{' '}
                      {selectedPart.originalOcrValues.quantity}
                    </div>
                  )}
                </div>
              )}

              {Math.max(1, selectedPart.quantity ?? 1) > 1 && (
                <div className="pt-2.5 border-t border-[#E4E3DE]">
                  <label className="block text-xs font-semibold text-[#18181B] mb-1.5">
                    {selectedPart.status === 'received'
                      ? `Edit Received Quantity (Required: ${Math.max(1, selectedPart.quantity ?? 1)}):`
                      : `Enter Actual Quantity Received (Required: ${Math.max(1, selectedPart.quantity ?? 1)}):`}
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const curr = parseInt(detailQtyInput, 10) || 0;
                        setDetailQtyInput(String(Math.max(0, curr - 1)));
                      }}
                      className="w-10 h-10 rounded-[4px] bg-white hover:bg-zinc-100 border border-[#E4E3DE] text-[#18181B] flex items-center justify-center cursor-pointer shrink-0"
                      aria-label="Decrease quantity"
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                    <input
                      type="number"
                      inputMode="numeric"
                      min="0"
                      value={detailQtyInput}
                      onChange={(e) => setDetailQtyInput(e.target.value)}
                      className="flex-1 h-10 px-3 bg-white border border-[#E4E3DE] focus:border-[#059669] rounded-[4px] font-mono text-base font-bold text-[#18181B] text-center outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const curr = parseInt(detailQtyInput, 10) || 0;
                        setDetailQtyInput(String(curr + 1));
                      }}
                      className="w-10 h-10 rounded-[4px] bg-white hover:bg-zinc-100 border border-[#E4E3DE] text-[#18181B] flex items-center justify-center cursor-pointer shrink-0"
                      aria-label="Increase quantity"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="pt-3 flex items-center gap-2">
              {Math.max(1, selectedPart.quantity ?? 1) > 1 ? (
                <>
                  {selectedPart.status === 'received' && (
                    <button
                      type="button"
                      onClick={(e) =>
                        handleToggleStatus(selectedPart, e, undefined, 'outstanding')
                      }
                      className="h-10 px-3 rounded-[4px] bg-white border border-[#E4E3DE] hover:bg-zinc-50 text-zinc-700 font-medium text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer shrink-0"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Mark Outstanding</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      const parsed = Math.max(0, parseInt(detailQtyInput, 10) || 0);
                      handleToggleStatus(selectedPart, e, parsed, 'received');
                    }}
                    className="flex-1 h-10 px-4 rounded-[4px] bg-[#059669] hover:bg-[#047857] text-white font-semibold text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                    <span>
                      {selectedPart.status === 'received'
                        ? 'Save Quantity'
                        : 'Confirm & Receive'}
                    </span>
                  </button>
                </>
              ) : (
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
                    {selectedPart.status === 'received'
                      ? 'Mark as Outstanding'
                      : 'Confirm & Mark as Received'}
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Parts List Editor Modal (Add Part, Edit Single Part, Delete Confirmation, or Bulk Edit) */}
      {editorMode && (
        <PartsListEditorModal
          delivery={delivery}
          mode={editorMode}
          onClose={() => setEditorMode(null)}
          onDeliveryUpdated={(updated) => {
            onUpdateDelivery(updated);
          }}
        />
      )}
    </div>
  );
};
