import React, { useState, useEffect, useMemo } from 'react';
import {
  BarChart3,
  FileText,
  FileSpreadsheet,
  Archive,
  CheckCircle2,
  Clock,
  Boxes,
  Users,
  Calendar,
  TrendingUp,
  Printer,
  Loader2,
  AlertTriangle,
  ArrowUpRight,
  Layers,
} from 'lucide-react';
import { Delivery } from '../types/delivery';
import { getStoredDeliveries, getPartVerificationState } from '../utils/storage';
import { exportDeliveryPdf } from '../utils/pdfExport';
import { exportDeliveryCsv } from '../utils/csvExport';
import { exportAllDeliveriesBackupZip } from '../utils/zipExport';
import { BRANDING } from '../config/branding';

interface ReportsViewProps {
  activeDelivery: Delivery | null;
  onSelectDelivery?: (delivery: Delivery) => void;
  onOpenOrderDetails?: (delivery: Delivery) => void;
}

export const ReportsView: React.FC<ReportsViewProps> = ({
  activeDelivery,
  onSelectDelivery,
  onOpenOrderDetails,
}) => {
  const [deliveries, setDeliveries] = useState<Delivery[]>(() => getStoredDeliveries());
  const [selectedDocketId, setSelectedDocketId] = useState<string>(
    () => activeDelivery?.id || getStoredDeliveries()[0]?.id || ''
  );
  const [isExportingZip, setIsExportingZip] = useState(false);
  const [dateFilter, setDateFilter] = useState<'7d' | '30d' | 'all'>('all');

  useEffect(() => {
    const sync = () => {
      const latest = getStoredDeliveries();
      setDeliveries(latest);
      if (!selectedDocketId && latest.length > 0) {
        setSelectedDocketId(latest[0].id);
      }
    };
    window.addEventListener('parttrack_deliveries_updated', sync);
    return () => window.removeEventListener('parttrack_deliveries_updated', sync);
  }, [selectedDocketId]);

  useEffect(() => {
    if (activeDelivery?.id) {
      setSelectedDocketId(activeDelivery.id);
    }
  }, [activeDelivery?.id]);

  // Filter deliveries by selected date window
  const filteredDeliveries = useMemo(() => {
    if (dateFilter === 'all') return deliveries;
    const days = dateFilter === '7d' ? 7 : 30;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return deliveries.filter((d) => {
      const ts = new Date(d.updatedAt || d.createdAt || d.deliveryDate).getTime();
      return !Number.isNaN(ts) ? ts >= cutoff : true;
    });
  }, [deliveries, dateFilter]);

  // Real Database KPIs & Metrics
  const reportMetrics = useMemo(() => {
    let docketsProcessed = filteredDeliveries.length;
    let completedOrders = 0;
    let startedOrders = 0;
    let incompleteOrders = 0;
    let partsReceived = 0;
    let partsOutstanding = 0;
    let totalRequiredUnits = 0;
    let totalScanEvents = 0;
    let mismatchPartsCount = 0;
    let totalPallets = 0;

    const workerMap = new Map<
      string,
      { name: string; scans: number; unitsVerified: number; lastScanAt: string }
    >();

    const supplierMap = new Map<
      string,
      { supplier: string; dockets: number; partsReceived: number; partsRequired: number }
    >();

    filteredDeliveries.forEach((del) => {
      const parts = del.parts || [];
      const palletsSet = new Set<string>();
      let delReceivedRows = 0;

      parts.forEach((p) => {
        if (p.palletNumber) palletsSet.add(String(p.palletNumber));
        const vState = getPartVerificationState(p);
        totalRequiredUnits += vState.requiredQty;
        partsReceived += vState.receivedQty;
        const rem = Math.max(0, vState.requiredQty - vState.receivedQty);
        partsOutstanding += rem;

        if (p.status === 'received' || vState.receivedQty >= vState.requiredQty) {
          delReceivedRows += 1;
        }
        if (vState.state === 'quantity_mismatch') {
          mismatchPartsCount += 1;
        }
      });

      totalPallets += Math.max(del.palletCount || 0, palletsSet.size);

      if (del.status === 'completed' || (parts.length > 0 && delReceivedRows === parts.length)) {
        completedOrders += 1;
      } else if (delReceivedRows > 0 || (del.scanHistory && del.scanHistory.length > 0)) {
        startedOrders += 1;
      } else {
        incompleteOrders += 1;
      }

      // Supplier / Customer aggregation
      const supKey = (del.supplier || 'Unspecified Supplier').trim();
      const existingSup = supplierMap.get(supKey) || {
        supplier: supKey,
        dockets: 0,
        partsReceived: 0,
        partsRequired: 0,
      };
      existingSup.dockets += 1;
      parts.forEach((p) => {
        const vState = getPartVerificationState(p);
        existingSup.partsReceived += vState.receivedQty;
        existingSup.partsRequired += vState.requiredQty;
      });
      supplierMap.set(supKey, existingSup);

      // Scan History & Worker Activity aggregation
      (del.scanHistory || []).forEach((ev) => {
        totalScanEvents += 1;
        const workerName =
          ev.employeeName ||
          (ev as any).scannedByName ||
          (ev as any).workerName ||
          'Terminal Operator';
        const existingWorker = workerMap.get(workerName) || {
          name: workerName,
          scans: 0,
          unitsVerified: 0,
          lastScanAt: ev.timestamp || '',
        };
        existingWorker.scans += 1;
        existingWorker.unitsVerified += Math.max(1, ev.addedQuantity || ev.receivedQuantity || 1);
        if (
          ev.timestamp &&
          (!existingWorker.lastScanAt ||
            new Date(ev.timestamp).getTime() > new Date(existingWorker.lastScanAt).getTime())
        ) {
          existingWorker.lastScanAt = ev.timestamp;
        }
        workerMap.set(workerName, existingWorker);
      });
    });

    const completionRate =
      totalRequiredUnits > 0 ? Math.round((partsReceived / totalRequiredUnits) * 100) : 0;

    return {
      docketsProcessed,
      completedOrders,
      startedOrders,
      incompleteOrders,
      partsReceived,
      partsOutstanding,
      totalRequiredUnits,
      totalScanEvents,
      mismatchPartsCount,
      totalPallets,
      completionRate,
      workers: Array.from(workerMap.values()).sort((a, b) => b.scans - a.scans),
      suppliers: Array.from(supplierMap.values()).sort((a, b) => b.dockets - a.dockets),
    };
  }, [filteredDeliveries]);

  // Activity by Date (7-day breakdown)
  const activityByDate = useMemo(() => {
    const days: { dateStr: string; label: string; fullDate: string; scans: number; dockets: number }[] = [];
    const now = new Date();

    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString('en-AU', { weekday: 'short' });
      const fullDate = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
      days.push({ dateStr, label, fullDate, scans: 0, dockets: 0 });
    }

    deliveries.forEach((del) => {
      const createdDay = (del.createdAt || del.deliveryDate || '').slice(0, 10);
      const dMatch = days.find((d) => d.dateStr === createdDay);
      if (dMatch) dMatch.dockets += 1;

      (del.scanHistory || []).forEach((ev) => {
        if (!ev.timestamp) return;
        const evDay = ev.timestamp.slice(0, 10);
        const sMatch = days.find((d) => d.dateStr === evDay);
        if (sMatch) sMatch.scans += 1;
      });
    });

    const maxScans = Math.max(1, ...days.map((d) => d.scans));
    return { days, maxScans };
  }, [deliveries]);

  const targetExportDelivery = useMemo(() => {
    return (
      deliveries.find((d) => d.id === selectedDocketId) ||
      activeDelivery ||
      deliveries[0] ||
      null
    );
  }, [deliveries, selectedDocketId, activeDelivery]);

  const handleExportMasterZip = async () => {
    setIsExportingZip(true);
    try {
      await exportAllDeliveriesBackupZip();
    } finally {
      setIsExportingZip(false);
    }
  };

  return (
    <div className="flex-1 w-full bg-[var(--pt-bg,#080B12)] text-white flex flex-col pb-24">
      <div className="w-full max-w-6xl mx-auto px-3 sm:px-6 pt-3 sm:pt-6 space-y-4 sm:space-y-6">
        {/* =====================================================================
         * 1. REPORTS & ANALYTICS HEADER + DATE WINDOW SELECTOR
         * ===================================================================== */}
        <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 sm:p-5 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] shadow-lg">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] flex items-center justify-center text-[var(--pt-primary-light,#C084FC)]">
                <BarChart3 className="w-4 h-4" />
              </div>
              <h1 className="text-lg sm:text-xl font-extrabold tracking-tight text-white uppercase font-sans">
                REPORTS &amp; ANALYTICS
              </h1>
              <span className="px-2 py-0.5 rounded-md bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] text-[10px] font-mono font-bold text-[var(--pt-primary-light,#C084FC)]">
                LIVE D1 TELEMETRY
              </span>
            </div>
            <p className="text-xs text-[var(--pt-text-secondary,#A3A8BD)] font-mono">
              Real-time warehouse verification metrics, worker throughput &amp; audit exports
            </p>
          </div>

          {/* Date Range Filter */}
          <div className="flex items-center gap-1.5 bg-[var(--pt-bg,#080B12)] p-1 rounded-xl border border-[var(--pt-border,#29243D)] self-start sm:self-auto">
            {(
              [
                { id: 'all', label: 'All Time' },
                { id: '30d', label: 'Last 30 Days' },
                { id: '7d', label: 'Last 7 Days' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setDateFilter(tab.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all cursor-pointer ${
                  dateFilter === tab.id
                    ? 'pt-btn-primary text-white'
                    : 'text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </header>

        {/* =====================================================================
         * 2. PRIMARY KPI SUMMARY CARDS (Real Database Records)
         * ===================================================================== */}
        <section className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {/* Card 1: Dockets Processed */}
          <div className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] flex flex-col justify-between">
            <div className="flex items-center justify-between text-[var(--pt-text-secondary,#A3A8BD)] mb-2">
              <span className="text-[10px] font-mono uppercase tracking-wider font-bold">
                Dockets Processed
              </span>
              <FileText className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
            </div>
            <div>
              <div className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-white">
                {reportMetrics.docketsProcessed}
              </div>
              <div className="text-[11px] font-mono text-[var(--pt-text-muted,#737B94)] mt-1">
                {reportMetrics.totalPallets} total pallets tracked
              </div>
            </div>
          </div>

          {/* Card 2: Parts Received */}
          <div className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] flex flex-col justify-between">
            <div className="flex items-center justify-between text-[var(--pt-text-secondary,#A3A8BD)] mb-2">
              <span className="text-[10px] font-mono uppercase tracking-wider font-bold">
                Parts Received
              </span>
              <CheckCircle2 className="w-4 h-4 text-[#00D979]" />
            </div>
            <div>
              <div className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-[#00D979]">
                {reportMetrics.partsReceived}
              </div>
              <div className="text-[11px] font-mono text-[#00D979]/80 mt-1">
                {reportMetrics.completionRate}% of {reportMetrics.totalRequiredUnits} required
              </div>
            </div>
          </div>

          {/* Card 3: Parts Outstanding */}
          <div className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] flex flex-col justify-between">
            <div className="flex items-center justify-between text-[var(--pt-text-secondary,#A3A8BD)] mb-2">
              <span className="text-[10px] font-mono uppercase tracking-wider font-bold">
                Parts Outstanding
              </span>
              <Clock className="w-4 h-4 text-[#F59E0B]" />
            </div>
            <div>
              <div className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-[#F59E0B]">
                {reportMetrics.partsOutstanding}
              </div>
              <div className="text-[11px] font-mono text-[var(--pt-text-muted,#737B94)] mt-1">
                Awaiting scan verification
              </div>
            </div>
          </div>

          {/* Card 4: Completed Orders */}
          <div className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] flex flex-col justify-between">
            <div className="flex items-center justify-between text-[var(--pt-text-secondary,#A3A8BD)] mb-2">
              <span className="text-[10px] font-mono uppercase tracking-wider font-bold">
                Completed Orders
              </span>
              <Boxes className="w-4 h-4 text-[#078BFF]" />
            </div>
            <div>
              <div className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-white">
                {reportMetrics.completedOrders}
              </div>
              <div className="text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-1">
                {reportMetrics.startedOrders} started · {reportMetrics.incompleteOrders} incomplete
              </div>
            </div>
          </div>

          {/* Card 5: Scanning Activity */}
          <div className="col-span-2 lg:col-span-1 p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] flex flex-col justify-between">
            <div className="flex items-center justify-between text-[var(--pt-text-secondary,#A3A8BD)] mb-2">
              <span className="text-[10px] font-mono uppercase tracking-wider font-bold">
                Scanning Activity
              </span>
              <TrendingUp className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
            </div>
            <div>
              <div className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-[var(--pt-primary-light,#C084FC)]">
                {reportMetrics.totalScanEvents}
              </div>
              <div className="text-[11px] font-mono text-[var(--pt-text-muted,#737B94)] mt-1">
                Confirmed scan events
              </div>
            </div>
          </div>
        </section>

        {/* =====================================================================
         * 3. EXPORT & AUDIT REPORT SUITE (PDF, CSV, ZIP)
         * ===================================================================== */}
        <section className="p-4 sm:p-5 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[var(--pt-border,#29243D)] pb-3">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wider text-white font-mono">
                EXPORT VERIFICATION REPORTS &amp; ARCHIVES
              </h2>
              <p className="text-xs text-[var(--pt-text-secondary,#A3A8BD)] mt-0.5">
                Generate official colour-coded PartTrack PDF reports, CSV spreadsheets, or complete warehouse backups
              </p>
            </div>

            {deliveries.length > 0 && (
              <div className="flex items-center gap-2">
                <label className="text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] shrink-0">
                  Target Docket:
                </label>
                <select
                  value={selectedDocketId}
                  onChange={(e) => {
                    setSelectedDocketId(e.target.value);
                    const found = deliveries.find((d) => d.id === e.target.value);
                    if (found && onSelectDelivery) onSelectDelivery(found);
                  }}
                  className="h-9 px-3 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] text-xs font-mono font-bold text-white outline-none focus:border-[var(--pt-primary,#A020F0)]"
                >
                  {deliveries.map((d) => (
                    <option key={d.id} value={d.id}>
                      #{d.docketNumber} — {d.supplier} ({d.parts?.length || 0} parts)
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Export 1: Colour-Coded PDF Report */}
            <button
              type="button"
              disabled={!targetExportDelivery}
              onClick={() => targetExportDelivery && exportDeliveryPdf(targetExportDelivery)}
              className="h-12 px-4 rounded-xl pt-btn-primary font-mono font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2.5 cursor-pointer disabled:opacity-40 transition-all"
            >
              <Printer className="w-4 h-4" />
              <span>Export Docket PDF Report</span>
            </button>

            {/* Export 2: CSV Spreadsheet */}
            <button
              type="button"
              disabled={!targetExportDelivery}
              onClick={() => targetExportDelivery && exportDeliveryCsv(targetExportDelivery)}
              className="h-12 px-4 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/5 border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)] text-white font-mono font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2.5 cursor-pointer disabled:opacity-40 transition-all"
            >
              <FileSpreadsheet className="w-4 h-4 text-[#00D979]" />
              <span>Export Docket CSV</span>
            </button>

            {/* Export 3: Master ZIP Backup */}
            <button
              type="button"
              disabled={deliveries.length === 0 || isExportingZip}
              onClick={handleExportMasterZip}
              className="h-12 px-4 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/5 border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)] text-white font-mono font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2.5 cursor-pointer disabled:opacity-40 transition-all"
            >
              {isExportingZip ? (
                <Loader2 className="w-4 h-4 animate-spin text-[var(--pt-primary-light,#C084FC)]" />
              ) : (
                <Archive className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
              )}
              <span>{isExportingZip ? 'Packaging ZIP...' : 'Export All Dockets (.ZIP)'}</span>
            </button>
          </div>
        </section>

        {/* =====================================================================
         * 4. ACTIVITY BY DATE & ACTIVITY BY WORKER (Side-by-Side)
         * ===================================================================== */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
          {/* Activity by Date */}
          <section className="p-4 sm:p-5 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] flex flex-col justify-between">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-white flex items-center gap-1.5">
                  <Calendar className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
                  <span>ACTIVITY BY DATE (LAST 7 DAYS)</span>
                </h3>
                <p className="text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-0.5">
                  Daily scan events and dockets logged across warehouse terminals
                </p>
              </div>
            </div>

            <div className="h-44 flex items-end justify-between gap-2 pt-4 px-2">
              {activityByDate.days.map((d) => {
                const heightPct = Math.max(8, Math.round((d.scans / activityByDate.maxScans) * 100));
                return (
                  <div
                    key={d.dateStr}
                    className="flex-1 flex flex-col items-center justify-end h-full gap-1.5 group"
                  >
                    <span className="text-[10px] font-mono font-bold text-[var(--pt-primary-light,#C084FC)]">
                      {d.scans}
                    </span>
                    <div
                      className="w-full rounded-t-lg transition-all duration-300 group-hover:brightness-125"
                      style={{
                        height: `${heightPct}%`,
                        background:
                          d.scans > 0
                            ? 'linear-gradient(180deg, var(--pt-primary-light, #C084FC) 0%, var(--pt-primary, #A020F0) 100%)'
                            : 'var(--pt-bg-secondary, #101321)',
                        border: '1px solid var(--pt-border, #29243D)',
                      }}
                    />
                    <div className="text-center">
                      <div className="text-[10px] font-mono font-bold text-white leading-tight">
                        {d.label}
                      </div>
                      <div className="text-[9px] font-mono text-[var(--pt-text-muted,#737B94)]">
                        {d.fullDate}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Activity by Worker */}
          <section className="p-4 sm:p-5 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-white flex items-center gap-1.5">
                  <Users className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
                  <span>ACTIVITY BY WORKER</span>
                </h3>
                <p className="text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-0.5">
                  Verified scans and part quantities recorded per operator
                </p>
              </div>
              <span className="text-[11px] font-mono font-bold text-[var(--pt-primary-light,#C084FC)]">
                {reportMetrics.workers.length}{' '}
                {reportMetrics.workers.length === 1 ? 'Operator' : 'Operators'}
              </span>
            </div>

            {reportMetrics.workers.length > 0 ? (
              <div className="space-y-2.5 overflow-y-auto max-h-52 pr-1">
                {reportMetrics.workers.map((w, idx) => (
                  <div
                    key={w.name + idx}
                    className="p-3 rounded-xl bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] font-mono font-bold text-xs text-[var(--pt-primary-light,#C084FC)] flex items-center justify-center shrink-0">
                        {w.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-white truncate">{w.name}</div>
                        <div className="text-[10px] font-mono text-[var(--pt-text-secondary,#A3A8BD)]">
                          {w.unitsVerified} total units verified
                        </div>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <div className="text-xs font-mono font-bold text-[#00D979]">
                        {w.scans} {w.scans === 1 ? 'scan' : 'scans'}
                      </div>
                      {w.lastScanAt && (
                        <div className="text-[10px] font-mono text-[var(--pt-text-muted,#737B94)]">
                          {new Date(w.lastScanAt).toLocaleDateString('en-AU', {
                            day: 'numeric',
                            month: 'short',
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex-1 py-8 px-4 rounded-xl border border-dashed border-[var(--pt-border,#29243D)] flex flex-col items-center justify-center text-center">
                <Users className="w-6 h-6 text-[var(--pt-text-muted,#737B94)] mb-1.5" />
                <p className="text-xs font-semibold text-white">No worker scan events logged yet</p>
                <p className="text-[11px] font-mono text-[var(--pt-text-muted,#737B94)] mt-0.5 max-w-xs">
                  Operator scan history will populate automatically as parts are verified.
                </p>
              </div>
            )}
          </section>
        </div>

        {/* =====================================================================
         * 5. DOCKET COMPLETION BREAKDOWN TABLE
         * ===================================================================== */}
        <section className="p-4 sm:p-5 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-white flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
                <span>DOCKET VERIFICATION BREAKDOWN</span>
              </h3>
              <p className="text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-0.5">
                Click any docket row to inspect parts, pallets or export its verification report
              </p>
            </div>
            {reportMetrics.mismatchPartsCount > 0 && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#EF4444]/15 border border-[#EF4444]/40 text-[#EF4444] font-mono text-[11px] font-bold">
                <AlertTriangle className="w-3.5 h-3.5" />
                {reportMetrics.mismatchPartsCount} Qty Mismatches
              </span>
            )}
          </div>

          {filteredDeliveries.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[var(--pt-border,#29243D)] text-[10px] font-mono uppercase text-[var(--pt-text-muted,#737B94)]">
                    <th className="py-2.5 px-3">Docket #</th>
                    <th className="py-2.5 px-3">Customer / Supplier</th>
                    <th className="py-2.5 px-3">Date</th>
                    <th className="py-2.5 px-3 text-right">Received / Req</th>
                    <th className="py-2.5 px-3 text-right">Status</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--pt-border,#29243D)]/60 font-mono">
                  {filteredDeliveries.map((del) => {
                    const parts = del.parts || [];
                    const totalLines = parts.length;
                    const rcvdLines = parts.filter((p) => p.status === 'received').length;
                    const pct = totalLines > 0 ? Math.round((rcvdLines / totalLines) * 100) : 0;
                    const isComplete =
                      del.status === 'completed' || (totalLines > 0 && rcvdLines === totalLines);
                    const isStarted =
                      !isComplete &&
                      (rcvdLines > 0 || (del.scanHistory && del.scanHistory.length > 0));

                    return (
                      <tr
                        key={del.id}
                        className="hover:bg-[var(--pt-bg-secondary,#101321)] transition-colors"
                      >
                        <td className="py-3 px-3 font-bold text-white">#{del.docketNumber}</td>
                        <td className="py-3 px-3 font-sans text-[var(--pt-text-secondary,#A3A8BD)]">
                          {del.supplier}
                        </td>
                        <td className="py-3 px-3 text-[var(--pt-text-muted,#737B94)]">
                          {del.deliveryDate}
                        </td>
                        <td className="py-3 px-3 text-right tabular-nums text-white">
                          {rcvdLines} / {totalLines} ({pct}%)
                        </td>
                        <td className="py-3 px-3 text-right">
                          {isComplete ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded bg-[#00D979]/15 border border-[#00D979]/40 text-[#00D979] text-[10px] font-bold uppercase">
                              COMPLETE
                            </span>
                          ) : isStarted ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded bg-[#078BFF]/15 border border-[#078BFF]/40 text-[#078BFF] text-[10px] font-bold uppercase">
                              STARTED
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded bg-[#F59E0B]/15 border border-[#F59E0B]/40 text-[#F59E0B] text-[10px] font-bold uppercase">
                              INCOMPLETE
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => exportDeliveryPdf(del)}
                              className="px-2 py-1 rounded bg-[var(--pt-bg,#080B12)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-[10px] font-bold text-[var(--pt-primary-light,#C084FC)] cursor-pointer"
                              title="Export PDF Report"
                            >
                              PDF
                            </button>
                            {onOpenOrderDetails && (
                              <button
                                type="button"
                                onClick={() => onOpenOrderDetails(del)}
                                className="px-2 py-1 rounded bg-[var(--pt-bg,#080B12)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-[10px] font-bold text-white inline-flex items-center gap-0.5 cursor-pointer"
                              >
                                <span>OPEN</span>
                                <ArrowUpRight className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-8 text-center text-xs font-mono text-[var(--pt-text-muted,#737B94)]">
              No dockets recorded for the selected time window.
            </div>
          )}
        </section>

        {/* Footer Brand Stamp */}
        <div className="text-center pt-2 text-[10px] font-mono text-[var(--pt-text-muted,#737B94)] uppercase tracking-widest">
          {BRANDING.appNameUppercase} · {BRANDING.tagline}
        </div>
      </div>
    </div>
  );
};
