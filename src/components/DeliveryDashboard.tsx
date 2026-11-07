import React, { useState, useRef, useEffect } from 'react';
import confetti from 'canvas-confetti';
import {
  QrCode,
  FileSpreadsheet,
  Check,
  ChevronRight,
  ArrowLeft,
  Printer,
  MoreHorizontal,
  Barcode,
  RotateCcw,
  Plus,
  FileText,
  Archive,
  Loader2,
} from 'lucide-react';
import { Delivery, SupplierRuleId } from '../types/delivery';
import { exportDeliveryPdf, exportDeliveryCsv } from '../utils/pdfExport';
import { exportDeliveryZip } from '../utils/zipExport';
import {
  updateDelivery,
  getDeliverySupplierRule,
  setDeliverySupplierRule,
  getPreferredSupplierRuleId,
  setPreferredSupplierRuleId,
  SUPPLIER_RULES,
  getPartVerificationState,
} from '../utils/storage';
import { DocketPhotosModal } from './DocketPhotosModal';

interface DeliveryDashboardProps {
  delivery: Delivery | null;
  onUpdateDelivery: (updated: Delivery) => void;
  onOpenUnexpectedModal: () => void;
  onOpenTestSheet: () => void;
  onNavigateToChecklist: (palletFilter?: string) => void;
  onStartScanning: () => void;
  onOpenNewDelivery?: () => void;
}

export const DeliveryDashboard: React.FC<DeliveryDashboardProps> = ({
  delivery,
  onUpdateDelivery,
  onOpenUnexpectedModal,
  onOpenTestSheet,
  onNavigateToChecklist,
  onStartScanning,
  onOpenNewDelivery,
}) => {
  const [subView, setSubView] = useState<'overview' | 'pallets' | 'history'>('overview');
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [isDocketPhotosOpen, setIsDocketPhotosOpen] = useState(false);
  const [isExportingZip, setIsExportingZip] = useState(false);
  const [zipStatusText, setZipStatusText] = useState('');
  const [preferredRuleId, setPreferredRuleId] = useState<SupplierRuleId>(() =>
    getPreferredSupplierRuleId()
  );
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleRuleChanged = () => {
      setPreferredRuleId(getPreferredSupplierRuleId());
    };
    window.addEventListener('parttrack_supplier_rule_changed', handleRuleChanged);
    return () => window.removeEventListener('parttrack_supplier_rule_changed', handleRuleChanged);
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setActionsMenuOpen(false);
      }
    };
    if (actionsMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [actionsMenuOpen]);

  // Reset subview when switching deliveries
  useEffect(() => {
    setSubView('overview');
  }, [delivery?.id]);

  const parts = delivery?.parts || [];

  // Compute pallet groups for the separate Pallet Detail view (hook declared unconditionally)
  const palletGroups = React.useMemo(() => {
    const map = new Map<string, { total: number; received: number }>();
    parts.forEach((p) => {
      const palletName = String(p.palletNumber || 'Unassigned');
      const current = map.get(palletName) || { total: 0, received: 0 };
      current.total += 1;
      if (p.status === 'received') current.received += 1;
      map.set(palletName, current);
    });

    return Array.from(map.entries())
      .map(([name, stats]) => ({
        name,
        total: stats.total,
        received: stats.received,
        remaining: stats.total - stats.received,
        percent: stats.total > 0 ? Math.round((stats.received / stats.total) * 100) : 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [parts]);

  if (!delivery) {
    const emptyRule = SUPPLIER_RULES[preferredRuleId] || SUPPLIER_RULES.laser_central;
    return (
      <div className="flex-1 w-full max-w-md mx-auto px-6 py-16 flex flex-col items-center justify-center text-center">
        <div className="w-10 h-10 rounded-[4px] bg-white border border-[#E4E3DE] flex items-center justify-center mb-3.5 text-zinc-400">
          {emptyRule.id === 'gci' ? (
            <QrCode className="w-5 h-5 stroke-[1.8] text-[#059669]" />
          ) : (
            <Barcode className="w-5 h-5 stroke-[1.8] text-[#059669]" />
          )}
        </div>
        <h2 className="text-sm font-semibold text-[#18181B]">No Active Delivery</h2>
        <p className="text-xs text-zinc-500 mt-1 max-w-xs leading-relaxed">
          Select a supplier below, then photograph a delivery docket or upload a PDF or image to start receiving parts.
        </p>

        {/* Supplier Dropdown Menu when no delivery is loaded yet */}
        <div className="w-full max-w-xs mt-5 p-3 rounded-[4px] bg-white border border-[#E4E3DE] text-left">
          <label
            htmlFor="empty-dashboard-supplier-select"
            className="block text-[10px] font-mono uppercase tracking-wider text-zinc-500 font-semibold mb-1.5"
          >
            Supplier
          </label>
          <select
            id="empty-dashboard-supplier-select"
            value={emptyRule.id}
            onChange={(e) => {
              const nextRule = e.target.value as SupplierRuleId;
              setPreferredSupplierRuleId(nextRule);
              setPreferredRuleId(nextRule);
            }}
            className="w-full h-9 px-2.5 bg-[#F6F5F2] border border-[#E4E3DE] rounded-[4px] text-xs font-semibold text-[#18181B] focus:outline-none focus:border-[#059669] cursor-pointer"
          >
            <option value="laser_central">Laser Central</option>
            <option value="gci">GCI</option>
            <option value="ocr_label">OCR Label Scanner</option>
          </select>
        </div>

        {onOpenNewDelivery && (
          <button
            onClick={onOpenNewDelivery}
            className="mt-4 h-10 px-4 bg-[#059669] hover:bg-[#047857] text-white font-semibold text-xs tracking-wide rounded-[4px] inline-flex items-center gap-2 cursor-pointer transition-colors"
          >
            <Plus className="w-4 h-4 stroke-[2]" />
            <span>New Delivery Docket ({emptyRule.name})</span>
          </button>
        )}
      </div>
    );
  }

  const total = parts.length;
  const received = parts.filter((p) => p.status === 'received').length;
  const verifiedGreen = parts.filter(
    (p) => getPartVerificationState(p).state === 'verified'
  ).length;
  const mismatchOrange = parts.filter(
    (p) => getPartVerificationState(p).state === 'quantity_mismatch'
  ).length;
  const remaining = total - received;
  const unexpectedCount = delivery.unexpectedParts.length;
  const percentage = total > 0 ? Math.round((received / total) * 100) : 0;
  const isCompleted = delivery.status === 'completed' || (total > 0 && received === total);
  const activeSupplierRule = getDeliverySupplierRule(delivery);

  const handleSelectSupplier = (ruleId: SupplierRuleId) => {
    const updated = setDeliverySupplierRule(delivery, ruleId);
    setPreferredRuleId(ruleId);
    onUpdateDelivery(updated);
  };

  const handleMarkComplete = () => {
    setActionsMenuOpen(false);
    const updated: Delivery = {
      ...delivery,
      status: 'completed',
      updatedAt: new Date().toISOString(),
    };
    updateDelivery(updated);
    onUpdateDelivery(updated);

    confetti({
      particleCount: 40,
      spread: 55,
      origin: { y: 0.65 },
    });
  };

  const handleReopen = () => {
    setActionsMenuOpen(false);
    const updated: Delivery = {
      ...delivery,
      status: 'receiving',
      updatedAt: new Date().toISOString(),
    };
    updateDelivery(updated);
    onUpdateDelivery(updated);
  };

  /* =========================================================================
   * SEPARATE DETAIL VIEW 1: PALLET PROGRESS
   * ========================================================================= */
  if (subView === 'pallets') {
    return (
      <div className="flex-1 w-full max-w-2xl mx-auto pb-20">
        {/* Sub-view Header */}
        <div className="px-4 py-3 border-b border-[#E4E3DE] flex items-center justify-between">
          <button
            onClick={() => setSubView('overview')}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-600 hover:text-[#18181B] cursor-pointer py-1"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Delivery overview</span>
          </button>
          <span className="text-xs font-mono text-zinc-400 tabular-nums">
            {palletGroups.length} pallets
          </span>
        </div>

        <div className="px-4 pt-4 pb-2">
          <h2 className="text-sm font-semibold text-[#18181B]">Pallet Breakdown</h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Tap any pallet to inspect its individual parts in the checklist.
          </p>
        </div>

        {/* Hairline List of Pallets */}
        <div className="mt-2 border-t border-b border-[#E4E3DE] bg-white divide-y divide-[#E4E3DE]">
          {palletGroups.map((group) => {
            const done = group.remaining === 0;
            return (
              <button
                key={group.name}
                onClick={() => onNavigateToChecklist(group.name)}
                className="w-full px-4 py-3.5 flex items-center justify-between gap-4 hover:bg-zinc-50 transition-colors text-left cursor-pointer"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2 mb-1.5">
                    <span className="text-xs font-semibold text-[#18181B] truncate">
                      {group.name}
                    </span>
                    <span className="text-xs font-mono text-zinc-500 tabular-nums">
                      {group.received} / {group.total}
                    </span>
                  </div>

                  <div className="w-full h-[3px] bg-zinc-100 overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${
                        done ? 'bg-[#059669]' : 'bg-zinc-800'
                      }`}
                      style={{ width: `${group.percent}%` }}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`text-[11px] font-mono tabular-nums ${
                      done ? 'text-[#059669] font-medium' : 'text-zinc-400'
                    }`}
                  >
                    {done ? 'Complete' : `${group.remaining} left`}
                  </span>
                  <ChevronRight className="w-3.5 h-3.5 text-zinc-300" />
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  /* =========================================================================
   * SEPARATE DETAIL VIEW 2: SCAN ACTIVITY LOG
   * ========================================================================= */
  if (subView === 'history') {
    return (
      <div className="flex-1 w-full max-w-2xl mx-auto pb-20">
        <div className="px-4 py-3 border-b border-[#E4E3DE] flex items-center justify-between">
          <button
            onClick={() => setSubView('overview')}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-600 hover:text-[#18181B] cursor-pointer py-1"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Delivery overview</span>
          </button>
          <span className="text-xs font-mono text-zinc-400 tabular-nums">
            {delivery.scanHistory.length} events
          </span>
        </div>

        <div className="px-4 pt-4 pb-2">
          <h2 className="text-sm font-semibold text-[#18181B]">Scan Activity</h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Chronological log of Barcode, QR, OCR Pallet Label, and manual verifications.
          </p>
        </div>

        {delivery.scanHistory.length === 0 ? (
          <div className="px-4 py-12 text-center text-xs text-zinc-400">
            No parts scanned yet for this delivery.
          </div>
        ) : (
          <div className="mt-2 border-t border-b border-[#E4E3DE] bg-white divide-y divide-[#E4E3DE]">
            {delivery.scanHistory.map((ev) => (
              <div
                key={ev.id}
                className="px-4 py-2.5 flex flex-col gap-1 text-xs"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    {ev.codeType === 'qr' ? (
                      <QrCode className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                    ) : ev.codeType === 'ocr_label' ? (
                      <FileText className="w-3.5 h-3.5 text-[#059669] shrink-0" />
                    ) : (
                      <Barcode className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="font-mono font-bold text-[#18181B] truncate">
                          {ev.partNumber || ev.code}
                        </span>
                        {ev.itemNumber && (
                          <span className="font-mono text-[11px] text-zinc-400 truncate">
                            No. {ev.itemNumber}
                          </span>
                        )}
                        {ev.codeType === 'ocr_label' && (
                          <span className="px-1.5 py-0.2 rounded-[2px] bg-emerald-50 border border-emerald-200 font-mono text-[10px] font-semibold text-[#059669]">
                            OCR Label{ev.addedQuantity ? ` (+${ev.addedQuantity})` : ''}
                          </span>
                        )}
                      </div>
                      {ev.recognizedDescription && (
                        <p className="text-[11px] text-zinc-500 truncate mt-0.5">
                          {ev.recognizedDescription}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0 font-mono text-[11px]">
                    <span
                      className={
                        ev.status === 'match_success' || ev.status === 'manual_ticked'
                          ? 'text-[#059669]'
                          : ev.status === 'quantity_mismatch' ||
                            ev.status === 'duplicate_warning'
                          ? 'text-amber-600'
                          : ev.status === 'undo_performed'
                          ? 'text-zinc-500'
                          : 'text-red-600'
                      }
                    >
                      {ev.status === 'match_success' || ev.status === 'manual_ticked'
                        ? ev.requiredQuantity && ev.requiredQuantity > 1
                          ? `Verified (${ev.receivedQuantity}/${ev.requiredQuantity})`
                          : 'Verified'
                        : ev.status === 'quantity_mismatch'
                        ? `Qty ${ev.receivedQuantity}/${ev.requiredQuantity}`
                        : ev.status === 'duplicate_warning'
                        ? 'Duplicate'
                        : ev.status === 'undo_performed'
                        ? 'Undone'
                        : 'Unexpected'}
                    </span>
                    <span className="text-zinc-400 tabular-nums">
                      {new Date(ev.timestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                </div>

                {ev.rawOcrText && (
                  <details className="pl-6 text-[10px] text-zinc-500">
                    <summary className="cursor-pointer hover:text-zinc-800 font-mono">
                      View raw OCR text
                    </summary>
                    <pre className="mt-1 p-2 rounded bg-[#F6F5F2] border border-[#E4E3DE] font-mono text-[10px] text-zinc-700 whitespace-pre-wrap">
                      {ev.rawOcrText}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  /* =========================================================================
   * MAIN MINIMALIST DELIVERY OVERVIEW
   * ========================================================================= */
  return (
    <div className="flex-1 w-full max-w-2xl mx-auto pb-20 flex flex-col">
      {/* Packaging ZIP Banner */}
      {isExportingZip && (
        <div className="bg-[#18181B] text-white px-4 py-2 text-xs flex items-center justify-between border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 text-emerald-400 animate-spin" />
            <span className="font-mono">{zipStatusText || 'Packaging .zip archive...'}</span>
          </div>
          <span className="text-[10px] font-mono text-zinc-400">PDF + CSVs + Photos</span>
        </div>
      )}

      {/* 1. Compact Supplier & Delivery Reference Section */}
      <section className="px-4 py-3.5 border-b border-[#E4E3DE] flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-sm font-semibold text-[#18181B] truncate">
              {delivery.supplier}
            </h1>
            {isCompleted && (
              <span className="text-[11px] font-mono font-medium text-[#059669] shrink-0">
                · Completed
              </span>
            )}
          </div>
          <p className="text-xs font-mono text-zinc-500 mt-0.5 truncate">
            {delivery.docketNumber}
            <span className="mx-1.5 text-zinc-300">·</span>
            {delivery.deliveryDate}
            {delivery.palletCount ? (
              <>
                <span className="mx-1.5 text-zinc-300">·</span>
                {delivery.palletCount} pallets
              </>
            ) : null}
          </p>
        </div>

        {/* Secondary Actions Menu Trigger */}
        <div className="relative shrink-0" ref={menuRef}>
          <button
            onClick={() => setActionsMenuOpen((prev) => !prev)}
            className="h-8 px-2.5 inline-flex items-center gap-1 text-xs font-medium text-zinc-600 hover:text-[#18181B] hover:bg-black/[0.04] rounded transition-colors cursor-pointer"
            title="Delivery actions"
          >
            <span>Actions</span>
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>

          {actionsMenuOpen && (
            <div className="absolute right-0 mt-1 w-52 bg-white border border-[#E4E3DE] shadow-lg rounded py-1 z-30 text-xs">
              <button
                onClick={() => {
                  setActionsMenuOpen(false);
                  exportDeliveryPdf(delivery);
                }}
                className="w-full px-3 py-2 text-left text-[#18181B] hover:bg-zinc-50 flex items-center gap-2 cursor-pointer"
              >
                <Printer className="w-3.5 h-3.5 text-[#059669]" />
                <span>Export colour-coded PDF</span>
              </button>

              <button
                onClick={() => {
                  setActionsMenuOpen(false);
                  exportDeliveryCsv(delivery);
                }}
                className="w-full px-3 py-2 text-left text-[#18181B] hover:bg-zinc-50 flex items-center gap-2 cursor-pointer"
              >
                <FileSpreadsheet className="w-3.5 h-3.5 text-zinc-400" />
                <span>Export CSV data</span>
              </button>

              <button
                onClick={async () => {
                  setActionsMenuOpen(false);
                  setIsExportingZip(true);
                  try {
                    await exportDeliveryZip(delivery, (status) => setZipStatusText(status));
                  } catch (err) {
                    console.error('Failed to export zip:', err);
                  } finally {
                    setTimeout(() => {
                      setIsExportingZip(false);
                      setZipStatusText('');
                    }, 1200);
                  }
                }}
                disabled={isExportingZip}
                className="w-full px-3 py-2 text-left text-[#18181B] hover:bg-zinc-50 flex items-center gap-2 cursor-pointer"
              >
                {isExportingZip ? (
                  <Loader2 className="w-3.5 h-3.5 text-[#059669] animate-spin" />
                ) : (
                  <Archive className="w-3.5 h-3.5 text-zinc-400" />
                )}
                <span>Export package (.zip)</span>
              </button>

              <button
                onClick={() => {
                  setActionsMenuOpen(false);
                  onOpenTestSheet();
                }}
                className="w-full px-3 py-2 text-left text-[#18181B] hover:bg-zinc-50 flex items-center gap-2 cursor-pointer"
              >
                <QrCode className="w-3.5 h-3.5 text-zinc-400" />
                <span>Test barcode sheet</span>
              </button>

              <button
                onClick={() => {
                  setActionsMenuOpen(false);
                  setIsDocketPhotosOpen(true);
                }}
                className="w-full px-3 py-2 text-left text-[#18181B] hover:bg-zinc-50 flex items-center gap-2 cursor-pointer"
              >
                <FileText className="w-3.5 h-3.5 text-zinc-400" />
                <span>Original docket photo(s)</span>
              </button>

              <div className="my-1 border-t border-[#E4E3DE]" />

              {isCompleted ? (
                <button
                  onClick={handleReopen}
                  className="w-full px-3 py-2 text-left text-zinc-700 hover:bg-zinc-50 flex items-center gap-2 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-zinc-400" />
                  <span>Reopen delivery</span>
                </button>
              ) : (
                <button
                  onClick={handleMarkComplete}
                  className="w-full px-3 py-2 text-left text-[#059669] font-medium hover:bg-zinc-50 flex items-center gap-2 cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Complete delivery</span>
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      {/* 2. Prominent, Open-Air Receiving Progress */}
      <section className="px-4 pt-7 pb-6">
        <div className="flex items-baseline gap-2">
          <span className="text-5xl sm:text-6xl font-bold tracking-tight text-[#18181B] font-mono-numbers leading-none">
            {received}
          </span>
          <span className="text-2xl sm:text-3xl font-normal text-zinc-400 font-mono-numbers leading-none">
            / {total}
          </span>
        </div>

        <div className="flex items-baseline justify-between mt-2.5 mb-3">
          <span className="text-[11px] font-semibold tracking-[0.12em] text-zinc-500 uppercase">
            PARTS RECEIVED
          </span>
          <span className="text-xs font-mono font-semibold text-[#059669] tabular-nums">
            {percentage}% complete
          </span>
        </div>

        {/* Thin Progress Bar */}
        <div className="w-full h-1 bg-[#E4E3DE] overflow-hidden">
          <div
            className="h-full bg-[#059669] transition-all duration-300 ease-out"
            style={{ width: `${percentage}%` }}
          />
        </div>

        {/* Colour-coded Status Summary Line */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums">
          <span className="text-[#059669] font-semibold">{verifiedGreen} verified</span>
          <span className="text-zinc-300">·</span>
          {mismatchOrange > 0 && (
            <>
              <span className="text-amber-600 font-semibold">
                {mismatchOrange} qty mismatch
              </span>
              <span className="text-zinc-300">·</span>
            </>
          )}
          <span className="text-zinc-600">{remaining} unscanned</span>
          <span className="text-zinc-300">·</span>
          {unexpectedCount > 0 ? (
            <button
              onClick={onOpenUnexpectedModal}
              className="text-red-600 hover:underline font-medium cursor-pointer"
            >
              {unexpectedCount} unexpected
            </button>
          ) : (
            <span className="text-zinc-500">0 unexpected</span>
          )}
        </div>

        {/* Supplier Dropdown Menu Before Scanning */}
        <div className="mt-5 p-3 rounded-[4px] bg-white border border-[#E4E3DE]">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <label
              htmlFor="dashboard-supplier-select"
              className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 font-semibold"
            >
              Supplier
            </label>
          </div>
          <select
            id="dashboard-supplier-select"
            value={activeSupplierRule.id}
            onChange={(e) => handleSelectSupplier(e.target.value as SupplierRuleId)}
            className="w-full h-9 px-3 bg-[#F6F5F2] border border-[#E4E3DE] rounded-[4px] text-xs font-semibold text-[#18181B] focus:outline-none focus:border-[#059669] cursor-pointer"
          >
            <option value="laser_central">Laser Central</option>
            <option value="gci">GCI</option>
            <option value="ocr_label">OCR Label Scanner</option>
          </select>
        </div>

        {/* 3. Primary Actions: SCAN PARTS + UPLOAD INVOICE / DOCKET */}
        <div className="mt-4 space-y-2">
          <button
            onClick={onStartScanning}
            className="w-full h-11 px-4 bg-[#059669] hover:bg-[#047857] active:bg-[#065F46] text-white font-semibold text-xs tracking-[0.08em] uppercase rounded-[4px] flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            {activeSupplierRule.id === 'gci' ? (
              <QrCode className="w-4 h-4 stroke-[2]" />
            ) : (
              <Barcode className="w-4 h-4 stroke-[2]" />
            )}
            <span>SCAN PARTS ({activeSupplierRule.name.toUpperCase()})</span>
          </button>

          {onOpenNewDelivery && (
            <button
              type="button"
              onClick={onOpenNewDelivery}
              className="w-full h-10 px-4 bg-white hover:bg-emerald-50/50 border border-[#E4E3DE] hover:border-[#059669] text-[#18181B] font-semibold text-xs tracking-[0.04em] rounded-[4px] flex items-center justify-center gap-2 transition-colors cursor-pointer shadow-2xs"
            >
              <Plus className="w-4 h-4 text-[#059669] stroke-[2.2]" />
              <span>Upload Invoice / Docket (Camera · Gallery · Files)</span>
            </button>
          )}
        </div>
      </section>

      {/* 4. Separate Detail Disclosure Rows (Thin Hairline Dividers, Zero Cards) */}
      <section className="border-t border-b border-[#E4E3DE] divide-y divide-[#E4E3DE] bg-white/60">
        {/* Inventory Checklist Row */}
        <button
          onClick={() => onNavigateToChecklist()}
          className="w-full px-4 py-3.5 flex items-center justify-between text-xs hover:bg-white transition-colors cursor-pointer"
        >
          <span className="font-medium text-[#18181B]">Parts checklist</span>
          <div className="flex items-center gap-2 text-zinc-500 font-mono tabular-nums">
            <span>{remaining} outstanding</span>
            <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
          </div>
        </button>

        {/* Separate Pallet Breakdown Detail Trigger */}
        {palletGroups.length > 0 && (
          <button
            onClick={() => setSubView('pallets')}
            className="w-full px-4 py-3.5 flex items-center justify-between text-xs hover:bg-white transition-colors cursor-pointer"
          >
            <span className="font-medium text-[#18181B]">Pallet progress</span>
            <div className="flex items-center gap-2 text-zinc-500 font-mono tabular-nums">
              <span>
                {palletGroups.filter((g) => g.remaining === 0).length} of {palletGroups.length} complete
              </span>
              <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
            </div>
          </button>
        )}

        {/* Separate Scan Activity Detail Trigger */}
        <button
          onClick={() => setSubView('history')}
          className="w-full px-4 py-3.5 flex items-center justify-between text-xs hover:bg-white transition-colors cursor-pointer"
        >
          <span className="font-medium text-[#18181B]">Recent scan activity</span>
          <div className="flex items-center gap-2 text-zinc-500 font-mono tabular-nums">
            <span>{delivery.scanHistory.length} scans</span>
            <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
          </div>
        </button>

        {/* Original Photographed Docket Disclosure */}
        <button
          onClick={() => setIsDocketPhotosOpen(true)}
          className="w-full px-4 py-3.5 flex items-center justify-between text-xs hover:bg-white transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <span className="font-medium text-[#18181B]">Original docket photos</span>
          </div>
          <div className="flex items-center gap-2 text-zinc-500 font-mono tabular-nums">
            <span>Inspect</span>
            <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
          </div>
        </button>

        {/* Discrepancies row when unexpected items exist */}
        {unexpectedCount > 0 && (
          <button
            onClick={onOpenUnexpectedModal}
            className="w-full px-4 py-3.5 flex items-center justify-between text-xs hover:bg-white transition-colors cursor-pointer"
          >
            <span className="font-medium text-red-600">Unexpected parts</span>
            <div className="flex items-center gap-2 text-red-600 font-mono tabular-nums">
              <span>{unexpectedCount} flagged</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </div>
          </button>
        )}
      </section>

      {/* Fullscreen Docket Photo Inspector Modal */}
      {isDocketPhotosOpen && (
        <DocketPhotosModal
          delivery={delivery}
          onClose={() => setIsDocketPhotosOpen(false)}
        />
      )}
    </div>
  );
};
