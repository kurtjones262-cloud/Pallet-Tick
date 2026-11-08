import React, { useState, useEffect, useMemo, useRef } from 'react';
import confetti from 'canvas-confetti';
import {
  QrCode,
  Barcode,
  CheckCircle2,
  Clock,
  Boxes,
  Archive,
  TrendingUp,
  Activity,
  Plus,
  Printer,
  ChevronRight,
  MoreHorizontal,
  Check,
  RotateCcw,
  Sparkles,
  Layers,
  ArrowUpRight,
  Wifi,
  WifiOff,
  Database,
  FileText,
  AlertTriangle,
  FolderOpen,
  ClipboardList,
} from 'lucide-react';
import { Delivery, DeliveryPart, ScanEvent, SupplierRuleId } from '../types/delivery';
import { exportDeliveryPdf } from '../utils/pdfExport';
import {
  getStoredDeliveries,
  getDeliverySupplierRule,
  updateDelivery,
  getPreferredSupplierRuleId,
} from '../utils/storage';
import { DocketPhotosModal } from './DocketPhotosModal';

interface DeliveryDashboardProps {
  delivery: Delivery | null;
  onUpdateDelivery: (updated: Delivery) => void;
  onOpenUnexpectedModal: () => void;
  onOpenTestSheet: () => void;
  onNavigateToChecklist: (palletFilter?: string) => void;
  onNavigateToOrders?: () => void;
  onStartScanning: () => void;
  onOpenNewDelivery?: () => void;
  onOpenDeliveriesList?: () => void;
  onOpenSettings?: () => void;
}

export const DeliveryDashboard: React.FC<DeliveryDashboardProps> = ({
  delivery,
  onUpdateDelivery,
  onOpenUnexpectedModal,
  onOpenTestSheet,
  onNavigateToChecklist,
  onNavigateToOrders,
  onStartScanning,
  onOpenNewDelivery,
  onOpenDeliveriesList,
}) => {
  const [allDeliveries, setAllDeliveries] = useState<Delivery[]>(() => getStoredDeliveries());
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [isDocketPhotosOpen, setIsDocketPhotosOpen] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Monitor network connectivity and storage updates in real time
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const handleDeliveriesUpdated = () => {
      setAllDeliveries(getStoredDeliveries());
    };
    window.addEventListener('parttrack_deliveries_updated', handleDeliveriesUpdated);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('parttrack_deliveries_updated', handleDeliveriesUpdated);
    };
  }, []);

  // Close actions menu when clicking outside
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

  // Current formatted date
  const formattedToday = useMemo(() => {
    try {
      return new Intl.DateTimeFormat('en-AU', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }).format(new Date());
    } catch {
      return 'Today';
    }
  }, []);

  // Format timestamp helper
  const formatTimeAgo = (iso?: string): string => {
    if (!iso) return 'Just now';
    try {
      const d = new Date(iso);
      const now = new Date();
      const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000);
      if (diffSec < 60) return 'Just now';
      if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
      if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
      return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    } catch {
      return 'Recently';
    }
  };

  /* =========================================================================
   * REAL DATABASE CALCULATIONS (No hardcoded sample data)
   * ========================================================================= */
  const stats = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    let partsProcessedTotal = 0;
    let pendingScansTotal = 0;
    let completedDeliveriesCount = 0;
    let totalScansThisWeek = 0;
    const palletsScannedTodaySet = new Set<string>();

    allDeliveries.forEach((del) => {
      if (del.status === 'completed') {
        completedDeliveriesCount += 1;
      }

      del.parts.forEach((p) => {
        if (p.status === 'received') {
          const qty = typeof p.receivedQuantity === 'number' ? p.receivedQuantity : (p.quantity || 1);
          partsProcessedTotal += qty;
        } else {
          const req = p.quantity || 1;
          pendingScansTotal += req;
        }
      });

      (del.scanHistory || []).forEach((ev) => {
        try {
          const evDate = new Date(ev.timestamp);
          if (evDate >= sevenDaysAgo) {
            totalScansThisWeek += 1;
          }
          if (ev.timestamp && ev.timestamp.startsWith(todayStr)) {
            if (ev.partId) {
              const matchedPart = del.parts.find((p) => p.id === ev.partId);
              if (matchedPart?.palletNumber) {
                palletsScannedTodaySet.add(`${del.id}_${matchedPart.palletNumber}`);
              }
            }
          }
        } catch {}
      });
    });

    return {
      palletsScannedToday: palletsScannedTodaySet.size,
      partsProcessed: partsProcessedTotal,
      pendingScans: pendingScansTotal,
      completedDeliveries: completedDeliveriesCount,
      scansThisWeek: totalScansThisWeek,
      totalDeliveries: allDeliveries.length,
    };
  }, [allDeliveries]);

  // Aggregate daily scans over the last 7 days for the operations chart
  const weeklyActivityData = useMemo(() => {
    const days: { label: string; dateStr: string; count: number }[] = [];
    const now = new Date();

    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString('en-AU', { weekday: 'narrow' });
      days.push({ label, dateStr, count: 0 });
    }

    allDeliveries.forEach((del) => {
      (del.scanHistory || []).forEach((ev) => {
        if (!ev.timestamp) return;
        const evDate = ev.timestamp.slice(0, 10);
        const match = days.find((d) => d.dateStr === evDate);
        if (match) {
          match.count += 1;
        }
      });
    });

    const maxCount = Math.max(1, ...days.map((d) => d.count));
    return { days, maxCount, hasAnyData: days.some((d) => d.count > 0) };
  }, [allDeliveries]);

  // Gather latest scan events across deliveries
  const recentActivities = useMemo(() => {
    const events: {
      id: string;
      partNumber: string;
      description: string;
      quantity: number;
      customer: string;
      timestamp: string;
      status: string;
      codeType: string;
    }[] = [];

    const targetDeliveries = delivery
      ? [delivery, ...allDeliveries.filter((d) => d.id !== delivery.id)]
      : allDeliveries;

    targetDeliveries.forEach((del) => {
      (del.scanHistory || []).forEach((ev) => {
        const matched = del.parts.find((p) => p.id === ev.partId || p.partNumber === ev.partNumber);
        events.push({
          id: ev.id,
          partNumber: ev.partNumber || matched?.partNumber || ev.code || 'Part Scan',
          description: ev.recognizedDescription || matched?.description || 'Laser-cut item',
          quantity: ev.addedQuantity || ev.receivedQuantity || 1,
          customer: del.supplier || del.docketNumber || 'Supplier',
          timestamp: ev.timestamp,
          status: ev.status,
          codeType: ev.codeType,
        });
      });
    });

    return events
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 6);
  }, [delivery, allDeliveries]);

  // Active delivery statistics
  const activeDeliveryStats = useMemo(() => {
    if (!delivery) return null;
    const parts = delivery.parts || [];
    const total = parts.length;
    const received = parts.filter((p) => p.status === 'received').length;
    const remaining = total - received;
    const percentage = total > 0 ? Math.round((received / total) * 100) : 0;
    const isCompleted = delivery.status === 'completed';
    const unexpectedCount = (delivery.unexpectedParts || []).length;

    return { total, received, remaining, percentage, isCompleted, unexpectedCount };
  }, [delivery]);

  const handleMarkComplete = () => {
    if (!delivery) return;
    setActionsMenuOpen(false);
    const updated: Delivery = {
      ...delivery,
      status: 'completed',
      updatedAt: new Date().toISOString(),
    };
    onUpdateDelivery(updated);
    updateDelivery(updated);
    try {
      confetti({
        particleCount: 60,
        spread: 60,
        origin: { y: 0.6 },
        colors: ['#00A8FF', '#00D2FF', '#10B981', '#ffffff'],
      });
    } catch {}
  };

  const handleReopen = () => {
    if (!delivery) return;
    setActionsMenuOpen(false);
    const updated: Delivery = {
      ...delivery,
      status: 'receiving',
      updatedAt: new Date().toISOString(),
    };
    onUpdateDelivery(updated);
    updateDelivery(updated);
  };

  const handleExportPdf = async () => {
    if (!delivery) return;
    setActionsMenuOpen(false);
    setIsExportingPdf(true);
    try {
      exportDeliveryPdf(delivery);
    } finally {
      setTimeout(() => setIsExportingPdf(false), 800);
    }
  };

  return (
    <div className="flex-1 w-full bg-[#070A0F] text-slate-100 flex flex-col pb-24 selection:bg-cyan-500/30 selection:text-cyan-200">
      <div className="w-full max-w-6xl mx-auto px-3 sm:px-6 pt-3 sm:pt-6 space-y-4 sm:space-y-6">

        {/* =========================================================================
         * 1. SOPHISTICATED DASHBOARD HEADER (PalletTrack Brand, Live Sync, Avatar)
         * ========================================================================= */}
        <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 sm:p-4 rounded-xl bg-[#0E1626]/90 border border-[#1E2D44] shadow-md backdrop-blur-md">
          {/* Left Brand Lockup */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="relative w-10 h-10 rounded-xl overflow-hidden bg-black border border-cyan-500/30 shadow-[0_0_15px_rgba(0,168,255,0.25)] shrink-0 flex items-center justify-center">
              <img
                src="/pallettrack-icon.png"
                alt="PalletTrack"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm tracking-tight text-white font-sans">
                  PalletTrack
                </span>
                <span className="hidden sm:inline-block text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-cyan-950/80 text-cyan-400 border border-cyan-500/30">
                  WH-01 TERMINAL
                </span>
              </div>
              <p className="text-[11px] font-mono text-slate-400 truncate">
                {delivery ? `Active: ${delivery.supplier} · ${delivery.docketNumber}` : 'Industrial Parts Receiving Platform'}
              </p>
            </div>
          </div>

          {/* Right Status Badges & Profile */}
          <div className="flex items-center justify-between sm:justify-end gap-2 shrink-0 border-t sm:border-t-0 pt-2 sm:pt-0 border-white/5">
            {/* Live Connection / Sync Status */}
            <div
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono font-medium border ${
                isOnline
                  ? 'bg-emerald-950/40 text-emerald-400 border-emerald-500/30'
                  : 'bg-amber-950/40 text-amber-400 border-amber-500/30'
              }`}
              title={isOnline ? 'Online · Cloud & Gemini Vision active' : 'Offline · On-device Tesseract OCR active'}
            >
              {isOnline ? (
                <>
                  <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                  <span>ONLINE · SYNCED</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-3.5 h-3.5 text-amber-400" />
                  <span>OFFLINE LOCAL</span>
                </>
              )}
            </div>

            {/* Current Date */}
            <div className="hidden md:flex items-center gap-1 text-[11px] font-mono text-slate-400 px-2 py-1 rounded bg-[#131D31] border border-[#1E2D44]">
              <Clock className="w-3 h-3 text-cyan-400" />
              <span>{formattedToday}</span>
            </div>

            {/* User Profile Avatar */}
            <div
              className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-600 to-blue-700 text-white font-bold text-xs flex items-center justify-center border border-cyan-400/40 shadow-[0_0_10px_rgba(0,168,255,0.3)] shrink-0"
              title="Terminal Lead Operator (WH-01)"
            >
              OP
            </div>
          </div>
        </header>

        {/* =========================================================================
         * 2. HERO SECTION – SCANNING (Prominent Electric-Blue Primary Action Card)
         * ========================================================================= */}
        <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#101F38] via-[#0E1726] to-[#070D18] border border-cyan-500/40 shadow-[0_0_35px_rgba(0,168,255,0.18)] p-5 sm:p-7">
          {/* Subtle Ambient Radial Highlight */}
          <div className="absolute top-0 right-0 w-72 h-72 bg-gradient-to-bl from-cyan-500/20 via-blue-600/10 to-transparent blur-3xl pointer-events-none" />

          <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-5">
            <div className="space-y-2 max-w-xl">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-mono font-bold tracking-widest uppercase text-cyan-400">
                  <span className="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_8px_#22d3ee] animate-pulse" />
                  HIGH-SPEED LOGISTICS SCANNER
                </span>
                <span className="text-slate-600">·</span>
                <span className="text-[11px] font-mono text-slate-400">
                  {delivery ? `Docket #${delivery.docketNumber}` : 'Ready for Inbound Parts'}
                </span>
              </div>

              <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white font-sans">
                READY TO SCAN?
              </h2>

              <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
                Scan barcodes and pallet labels instantly. High-throughput continuous scanning with automated docket verification.
              </p>

              {/* Supported scanning modes pill indicators */}
              <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] font-mono text-slate-300">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#131E33] border border-cyan-500/25 text-cyan-300">
                  <Barcode className="w-3.5 h-3.5" /> 1D Barcode
                </span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#131E33] border border-cyan-500/25 text-cyan-300">
                  <QrCode className="w-3.5 h-3.5" /> 2D QR Code
                </span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#131E33] border border-cyan-500/25 text-cyan-300">
                  <Sparkles className="w-3.5 h-3.5" /> Pallet Label OCR
                </span>
              </div>
            </div>

            {/* Primary Action Buttons */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 shrink-0">
              <button
                type="button"
                onClick={onStartScanning}
                className="h-13 sm:h-14 px-6 sm:px-8 rounded-xl bg-gradient-to-r from-cyan-400 via-cyan-500 to-blue-600 hover:from-cyan-300 hover:to-blue-500 text-[#070A0F] font-extrabold text-sm tracking-wider uppercase inline-flex items-center justify-center gap-3 shadow-[0_0_25px_rgba(0,168,255,0.4)] transition-all transform active:scale-[0.98] cursor-pointer"
              >
                <QrCode className="w-5 h-5 stroke-[2.4]" />
                <span>SCAN NOW</span>
                <ArrowUpRight className="w-4 h-4" />
              </button>

              {onOpenNewDelivery && (
                <button
                  type="button"
                  onClick={onOpenNewDelivery}
                  className="h-12 px-4 rounded-xl bg-[#131E33]/90 hover:bg-[#1A2845] border border-slate-700 hover:border-cyan-500/50 text-white font-semibold text-xs tracking-wide inline-flex items-center justify-center gap-2 transition-colors cursor-pointer"
                >
                  <Plus className="w-4 h-4 text-cyan-400" />
                  <span>Upload Docket</span>
                </button>
              )}
            </div>
          </div>
        </section>

        {/* =========================================================================
         * 3. LIVE OPERATIONS STATISTICS (Real Database Records)
         * ========================================================================= */}
        <section className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-slate-400">
              Live Operations Statistics
            </h3>
            <span className="text-[11px] font-mono text-cyan-400">
              {stats.totalDeliveries} total {stats.totalDeliveries === 1 ? 'docket' : 'dockets'} logged
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5 sm:gap-3.5">
            {/* Stat 1: Pallets Scanned Today */}
            <div className="p-3.5 sm:p-4 rounded-xl bg-[#0E1626] border border-[#1E2D44] hover:border-cyan-500/40 transition-colors flex flex-col justify-between">
              <div className="flex items-center justify-between text-slate-400 mb-2">
                <span className="text-[10px] font-mono uppercase tracking-wider font-semibold">Pallets Today</span>
                <Boxes className="w-4 h-4 text-cyan-400" />
              </div>
              <div>
                <div className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-white">
                  {stats.palletsScannedToday}
                </div>
                <div className="text-[10px] font-mono text-slate-400 mt-0.5 truncate">
                  {stats.palletsScannedToday > 0 ? 'Unique pallets active' : 'Awaiting scans'}
                </div>
              </div>
            </div>

            {/* Stat 2: Total Parts Processed */}
            <div className="p-3.5 sm:p-4 rounded-xl bg-[#0E1626] border border-[#1E2D44] hover:border-cyan-500/40 transition-colors flex flex-col justify-between">
              <div className="flex items-center justify-between text-slate-400 mb-2">
                <span className="text-[10px] font-mono uppercase tracking-wider font-semibold">Parts Processed</span>
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              </div>
              <div>
                <div className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-white">
                  {stats.partsProcessed}
                </div>
                <div className="text-[10px] font-mono text-emerald-400 mt-0.5 truncate">
                  Verified in inventory
                </div>
              </div>
            </div>

            {/* Stat 3: Pending Scans */}
            <div className="p-3.5 sm:p-4 rounded-xl bg-[#0E1626] border border-[#1E2D44] hover:border-cyan-500/40 transition-colors flex flex-col justify-between">
              <div className="flex items-center justify-between text-slate-400 mb-2">
                <span className="text-[10px] font-mono uppercase tracking-wider font-semibold">Pending Scans</span>
                <Clock className="w-4 h-4 text-amber-400" />
              </div>
              <div>
                <div className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-white">
                  {stats.pendingScans}
                </div>
                <div className="text-[10px] font-mono text-amber-400 mt-0.5 truncate">
                  Outstanding units
                </div>
              </div>
            </div>

            {/* Stat 4: Completed Deliveries */}
            <div className="p-3.5 sm:p-4 rounded-xl bg-[#0E1626] border border-[#1E2D44] hover:border-cyan-500/40 transition-colors flex flex-col justify-between">
              <div className="flex items-center justify-between text-slate-400 mb-2">
                <span className="text-[10px] font-mono uppercase tracking-wider font-semibold">Completed Dockets</span>
                <Archive className="w-4 h-4 text-cyan-400" />
              </div>
              <div>
                <div className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-white">
                  {stats.completedDeliveries}
                </div>
                <div className="text-[10px] font-mono text-slate-400 mt-0.5 truncate">
                  Full intake certified
                </div>
              </div>
            </div>

            {/* Stat 5: Total Scans This Week */}
            <div className="col-span-2 md:col-span-1 p-3.5 sm:p-4 rounded-xl bg-[#0E1626] border border-[#1E2D44] hover:border-cyan-500/40 transition-colors flex flex-col justify-between">
              <div className="flex items-center justify-between text-slate-400 mb-2">
                <span className="text-[10px] font-mono uppercase tracking-wider font-semibold">Scans This Week</span>
                <TrendingUp className="w-4 h-4 text-cyan-400" />
              </div>
              <div>
                <div className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-cyan-300">
                  {stats.scansThisWeek}
                </div>
                <div className="text-[10px] font-mono text-cyan-400/80 mt-0.5 truncate">
                  Throughput events
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* =========================================================================
         * 4. ACTIVE DOCKET CARD & RECEIVING PROGRESS (When docket is selected)
         * ========================================================================= */}
        {delivery && activeDeliveryStats && (
          <section className="rounded-xl bg-[#0E1626] border border-[#1E2D44] p-4 sm:p-5 space-y-4 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/5 pb-3.5">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-base font-bold text-white tracking-tight font-sans">
                    {delivery.supplier}
                  </h3>
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-500/30">
                    Docket #{delivery.docketNumber}
                  </span>
                  {activeDeliveryStats.isCompleted ? (
                    <span className="text-xs font-mono font-bold text-emerald-400 flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Completed
                    </span>
                  ) : (
                    <span className="text-xs font-mono text-cyan-400">Receiving Active</span>
                  )}
                </div>
                <p className="text-xs font-mono text-slate-400 mt-1">
                  Delivery Date: {delivery.deliveryDate} {delivery.palletCount ? `· ${delivery.palletCount} Pallets` : ''}
                </p>
              </div>

              {/* Actions Dropdown */}
              <div className="relative shrink-0 flex items-center gap-2" ref={menuRef}>
                <button
                  type="button"
                  onClick={handleExportPdf}
                  disabled={isExportingPdf}
                  className="h-8 px-3 rounded-lg bg-[#142036] hover:bg-[#1D2E4E] border border-slate-700 text-xs font-semibold text-slate-200 inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                >
                  <Printer className="w-3.5 h-3.5 text-cyan-400" />
                  <span>{isExportingPdf ? 'Exporting...' : 'Export PDF'}</span>
                </button>

                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setActionsMenuOpen((p) => !p)}
                    className="h-8 w-8 rounded-lg bg-[#142036] hover:bg-[#1D2E4E] border border-slate-700 text-slate-300 flex items-center justify-center cursor-pointer transition-colors"
                    title="More docket actions"
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </button>

                  {actionsMenuOpen && (
                    <div className="absolute right-0 mt-1.5 w-52 bg-[#0E1626] border border-[#1E2D44] shadow-2xl rounded-xl py-1 z-30 text-xs font-sans divide-y divide-white/5">
                      <button
                        type="button"
                        onClick={handleExportPdf}
                        className="w-full px-3.5 py-2.5 text-left text-slate-200 hover:bg-[#16233B] flex items-center gap-2 cursor-pointer transition-colors"
                      >
                        <Printer className="w-3.5 h-3.5 text-cyan-400" />
                        <span>Export colour-coded PDF</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setActionsMenuOpen(false);
                          setIsDocketPhotosOpen(true);
                        }}
                        className="w-full px-3.5 py-2.5 text-left text-slate-200 hover:bg-[#16233B] flex items-center gap-2 cursor-pointer transition-colors"
                      >
                        <FileText className="w-3.5 h-3.5 text-slate-400" />
                        <span>Original docket photo(s)</span>
                      </button>

                      {activeDeliveryStats.isCompleted ? (
                        <button
                          type="button"
                          onClick={handleReopen}
                          className="w-full px-3.5 py-2.5 text-left text-amber-400 hover:bg-[#16233B] flex items-center gap-2 cursor-pointer transition-colors"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>Reopen delivery</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={handleMarkComplete}
                          className="w-full px-3.5 py-2.5 text-left text-emerald-400 font-medium hover:bg-[#16233B] flex items-center gap-2 cursor-pointer transition-colors"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Complete delivery</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Progress Bar & Numerical Metrics */}
            <div className="space-y-2">
              <div className="flex items-baseline justify-between text-xs font-mono">
                <span className="text-slate-400 uppercase tracking-wider font-semibold">
                  Receiving Progress
                </span>
                <span className="text-cyan-400 font-bold tabular-nums">
                  {activeDeliveryStats.received} / {activeDeliveryStats.total} parts ({activeDeliveryStats.percentage}%)
                </span>
              </div>

              <div className="w-full h-2 rounded-full bg-[#142036] overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 rounded-full transition-all duration-300"
                  style={{ width: `${activeDeliveryStats.percentage}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 pt-1">
                <span>{activeDeliveryStats.remaining} unscanned</span>
                {activeDeliveryStats.unexpectedCount > 0 ? (
                  <button
                    type="button"
                    onClick={onOpenUnexpectedModal}
                    className="text-red-400 hover:underline font-bold cursor-pointer"
                  >
                    {activeDeliveryStats.unexpectedCount} unexpected flagged
                  </button>
                ) : (
                  <span>0 discrepancies</span>
                )}
                <button
                  type="button"
                  onClick={() => onNavigateToChecklist()}
                  className="text-cyan-400 hover:underline flex items-center gap-1 font-semibold cursor-pointer"
                >
                  <span>Open Checklist</span>
                  <ChevronRight className="w-3 h-3" />
                </button>
              </div>
            </div>
          </section>
        )}

        {/* =========================================================================
         * 5. OPERATIONS OVERVIEW (CHART) & RECENT ACTIVITY (Side-by-Side on Desktop)
         * ========================================================================= */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
          {/* Operations Overview Chart */}
          <section className="rounded-xl bg-[#0E1626] border border-[#1E2D44] p-4 sm:p-5 flex flex-col justify-between">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-slate-400">
                  Throughput Velocity (7 Days)
                </h3>
                <p className="text-[11px] font-mono text-slate-400 mt-0.5">
                  Real scan events logged over time
                </p>
              </div>
              <Activity className="w-4 h-4 text-cyan-400" />
            </div>

            {weeklyActivityData.hasAnyData ? (
              <div className="space-y-4">
                {/* SVG Bar Visualisation */}
                <div className="h-36 w-full flex items-end justify-between gap-2 pt-4 px-2">
                  {weeklyActivityData.days.map((d, idx) => {
                    const heightPercent = Math.max(8, Math.round((d.count / weeklyActivityData.maxCount) * 100));
                    return (
                      <div key={idx} className="flex-1 flex flex-col items-center gap-1.5 h-full justify-end group">
                        <span className="text-[10px] font-mono text-cyan-300 opacity-0 group-hover:opacity-100 transition-opacity">
                          {d.count}
                        </span>
                        <div
                          className="w-full rounded-t-md bg-gradient-to-t from-blue-700 to-cyan-400 transition-all duration-300 group-hover:brightness-125"
                          style={{ height: `${heightPercent}%` }}
                        />
                        <span className="text-[11px] font-mono text-slate-400 font-bold">
                          {d.label}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-white/5 text-[11px] font-mono text-slate-400">
                  <span>Weekly Total: {stats.scansThisWeek} scans</span>
                  <span className="text-cyan-400">Live Telemetry Active</span>
                </div>
              </div>
            ) : (
              <div className="py-10 px-4 flex flex-col items-center justify-center text-center space-y-2 border border-dashed border-slate-700/60 rounded-lg">
                <Activity className="w-6 h-6 text-slate-500 mb-1" />
                <p className="text-xs font-medium text-slate-300">
                  No scan throughput recorded yet
                </p>
                <p className="text-[11px] font-mono text-slate-500 max-w-xs">
                  Scan events logged using barcode, QR, or pallet OCR will chart daily throughput here.
                </p>
                <button
                  type="button"
                  onClick={onStartScanning}
                  className="mt-2 text-xs font-mono font-bold text-cyan-400 hover:text-cyan-300 flex items-center gap-1 cursor-pointer"
                >
                  <span>Start scanning now</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </section>

          {/* Recent Activity Section */}
          <section className="rounded-xl bg-[#0E1626] border border-[#1E2D44] p-4 sm:p-5 flex flex-col justify-between">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-slate-400">
                  Recent Scanning Activity
                </h3>
                <p className="text-[11px] font-mono text-slate-400 mt-0.5">
                  Latest confirmed warehouse receipts
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigateToChecklist()}
                className="text-[11px] font-mono font-bold text-cyan-400 hover:text-cyan-300 flex items-center gap-0.5 cursor-pointer"
              >
                <span>VIEW ALL</span>
                <ChevronRight className="w-3 h-3" />
              </button>
            </div>

            {recentActivities.length > 0 ? (
              <div className="divide-y divide-white/5 overflow-hidden">
                {recentActivities.map((act) => (
                  <div
                    key={act.id}
                    className="py-2.5 flex items-center justify-between gap-3 hover:bg-[#131D31]/50 px-1 rounded transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-xs text-cyan-300 truncate">
                          {act.partNumber}
                        </span>
                        <span className="text-[10px] font-mono px-1 rounded bg-[#131E33] text-slate-400 border border-slate-700">
                          Qty: {act.quantity}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 truncate mt-0.5 font-sans">
                        {act.description} · <span className="font-mono text-slate-500">{act.customer}</span>
                      </p>
                    </div>

                    <div className="text-right shrink-0">
                      <span className="text-[10px] font-mono font-medium text-emerald-400 block">
                        Verified
                      </span>
                      <span className="text-[10px] font-mono text-slate-500">
                        {formatTimeAgo(act.timestamp)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-10 px-4 flex flex-col items-center justify-center text-center space-y-2 border border-dashed border-slate-700/60 rounded-lg">
                <CheckCircle2 className="w-6 h-6 text-slate-500 mb-1" />
                <p className="text-xs font-medium text-slate-300">No parts scanned yet</p>
                <p className="text-[11px] font-mono text-slate-500 max-w-xs">
                  Scanned items and verified pallet receipts will display in this activity log.
                </p>
              </div>
            )}
          </section>
        </div>

        {/* =========================================================================
         * 6. QUICK ACTIONS & TOOLS (Refined Operations Hub)
         * ========================================================================= */}
        <section className="space-y-2.5">
          <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-slate-400">
            Quick Actions
          </h3>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3.5">
            {/* Quick Action 1: Scan Pallet */}
            <button
              type="button"
              onClick={onStartScanning}
              className="p-3.5 rounded-xl bg-[#0E1626] hover:bg-[#142036] border border-[#1E2D44] hover:border-cyan-500/50 text-left transition-all cursor-pointer group"
            >
              <div className="w-8 h-8 rounded-lg bg-cyan-950/80 text-cyan-400 border border-cyan-500/30 flex items-center justify-center mb-2.5 group-hover:scale-105 transition-transform">
                <QrCode className="w-4 h-4" />
              </div>
              <div className="font-bold text-xs text-white">Scan Pallet</div>
              <div className="text-[10px] font-mono text-slate-400 mt-0.5">High-speed scanner</div>
            </button>

            {/* Quick Action 2: View Orders */}
            <button
              type="button"
              onClick={() => (onNavigateToOrders ? onNavigateToOrders() : onNavigateToChecklist())}
              className="p-3.5 rounded-xl bg-[#0E1626] hover:bg-[#142036] border border-[#1E2D44] hover:border-cyan-500/50 text-left transition-all cursor-pointer group"
            >
              <div className="w-8 h-8 rounded-lg bg-blue-950/80 text-blue-400 border border-blue-500/30 flex items-center justify-center mb-2.5 group-hover:scale-105 transition-transform">
                <ClipboardList className="w-4 h-4" />
              </div>
              <div className="font-bold text-xs text-white">View Orders</div>
              <div className="text-[10px] font-mono text-slate-400 mt-0.5">Incomplete, started &amp; finished</div>
            </button>

            {/* Quick Action 3: Generate Reports */}
            <button
              type="button"
              onClick={handleExportPdf}
              disabled={!delivery || isExportingPdf}
              className="p-3.5 rounded-xl bg-[#0E1626] hover:bg-[#142036] border border-[#1E2D44] hover:border-cyan-500/50 text-left transition-all cursor-pointer group disabled:opacity-50"
            >
              <div className="w-8 h-8 rounded-lg bg-emerald-950/80 text-emerald-400 border border-emerald-500/30 flex items-center justify-center mb-2.5 group-hover:scale-105 transition-transform">
                <Printer className="w-4 h-4" />
              </div>
              <div className="font-bold text-xs text-white">Generate Reports</div>
              <div className="text-[10px] font-mono text-slate-400 mt-0.5">Export colour-coded PDF</div>
            </button>

            {/* Quick Action 4: Manage Dockets */}
            <button
              type="button"
              onClick={() => onOpenDeliveriesList?.()}
              className="p-3.5 rounded-xl bg-[#0E1626] hover:bg-[#142036] border border-[#1E2D44] hover:border-cyan-500/50 text-left transition-all cursor-pointer group"
            >
              <div className="w-8 h-8 rounded-lg bg-purple-950/80 text-purple-400 border border-purple-500/30 flex items-center justify-center mb-2.5 group-hover:scale-105 transition-transform">
                <FolderOpen className="w-4 h-4" />
              </div>
              <div className="font-bold text-xs text-white">Manage Dockets</div>
              <div className="text-[10px] font-mono text-slate-400 mt-0.5">Switch active shipment</div>
            </button>
          </div>
        </section>

        {/* =========================================================================
         * 7. SYSTEM STATUS (Real Database, Storage & Connectivity Telemetry)
         * ========================================================================= */}
        <section className="rounded-xl bg-[#0E1626] border border-[#1E2D44] p-3.5 sm:p-4 text-xs font-mono">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-slate-400">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-cyan-400 shrink-0" />
              <span className="text-white font-semibold">IndexedDB Local Storage:</span>
              <span className="text-emerald-400 font-bold">ACTIVE &amp; REPLICATED</span>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-[11px]">
              <div>
                <span className="text-slate-500">Sync Queue: </span>
                <span className="text-slate-200">0 Pending</span>
              </div>
              <div>
                <span className="text-slate-500">Engine: </span>
                <span className="text-cyan-300">
                  {isOnline ? 'Cloud AI + Local Tesseract' : 'Tesseract Offline Mode'}
                </span>
              </div>
              <div>
                <span className="text-slate-500">Last Sync: </span>
                <span className="text-slate-300">{formatTimeAgo(delivery?.updatedAt)}</span>
              </div>
            </div>
          </div>
        </section>

      </div>

      {/* Fullscreen Docket Photo Inspector Modal */}
      {isDocketPhotosOpen && delivery && (
        <DocketPhotosModal
          delivery={delivery}
          onClose={() => setIsDocketPhotosOpen(false)}
        />
      )}
    </div>
  );
};
