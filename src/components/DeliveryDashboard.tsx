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
  ArrowUpRight,
  Wifi,
  WifiOff,
  Database,
  FileText,
  FolderOpen,
  ClipboardList,
  Users,
  Settings,
  LogOut,
  Bell,
  ShieldAlert,
  Shield,
  UserCheck,
  HardHat,
  BarChart3,
  RefreshCw,
  FolderKanban,
} from 'lucide-react';
import { Delivery, UserAccount, UserRole } from '../types/delivery';
import { exportDeliveryPdf } from '../utils/pdfExport';
import {
  getStoredDeliveries,
  updateDelivery,
  getPartVerificationState,
  reconnectAndSyncWithCentralDb,
} from '../utils/storage';
import { DocketPhotosModal } from './DocketPhotosModal';
import { PartTrackLogo } from './PartTrackLogo';
import { BRANDING } from '../config/branding';
import { realtimeClient, RealtimeClientState } from '../services/realtimeSync';
import { subscribeToBackendHealth, BackendHealth } from '../services/palletTrackApi';

interface DeliveryDashboardProps {
  delivery: Delivery | null;
  onUpdateDelivery: (updated: Delivery) => void;
  onOpenUnexpectedModal: () => void;
  onOpenTestSheet: () => void;
  onNavigateToChecklist: (palletFilter?: string) => void;
  onNavigateToOrders?: () => void;
  onNavigateToGroups?: () => void;
  onNavigateToReports?: () => void;
  groupsCount?: number;
  onOpenNewDelivery?: () => void;
  onOpenDeliveriesList?: () => void;
  onOpenSettings?: () => void;
  currentUser?: UserAccount | null;
  onOpenUserManagement?: () => void;
  onLogout?: () => void;
}

export const DeliveryDashboard: React.FC<DeliveryDashboardProps> = ({
  delivery,
  onUpdateDelivery,
  onOpenUnexpectedModal,
  onNavigateToChecklist,
  onNavigateToOrders,
  onNavigateToGroups,
  onNavigateToReports,
  groupsCount = 0,
  onOpenNewDelivery,
  onOpenDeliveriesList,
  onOpenSettings,
  currentUser,
  onOpenUserManagement,
  onLogout,
}) => {
  const [allDeliveries, setAllDeliveries] = useState<Delivery[]>(() => getStoredDeliveries());
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [backendHealth, setBackendHealth] = useState<BackendHealth>({ connected: true });
  const [rtState, setRtState] = useState<RealtimeClientState>(() => realtimeClient.getState());
  const [isSyncingNow, setIsSyncingNow] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [isDocketPhotosOpen, setIsDocketPhotosOpen] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleManualSync = async () => {
    if (isSyncingNow) return;
    setIsSyncingNow(true);
    try {
      await reconnectAndSyncWithCentralDb();
      setAllDeliveries(getStoredDeliveries());
    } finally {
      setIsSyncingNow(false);
    }
  };

  // Monitor network connectivity, real-time WebSocket state, and storage updates
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      reconnectAndSyncWithCentralDb().catch(() => {});
    };
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const handleDeliveriesUpdated = () => {
      setAllDeliveries(getStoredDeliveries());
    };
    window.addEventListener('parttrack_deliveries_updated', handleDeliveriesUpdated);

    const unsubHealth = subscribeToBackendHealth(setBackendHealth);
    const unsubRt = realtimeClient.onStateChange((state, presence) => {
      const currentRt = realtimeClient.getState();
      setRtState({
        status: state,
        presence,
        pendingOfflineScansCount: currentRt.pendingOfflineScansCount,
        lastSyncedAt: currentRt.lastSyncedAt,
        lastError: currentRt.lastError,
      });
    });

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('parttrack_deliveries_updated', handleDeliveriesUpdated);
      unsubHealth();
      unsubRt();
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

  // Connection status resolution:
  // Distinctly separates API connectivity from WebSocket connectivity.
  // Never falsely marks HTTP fallback as realtime connectivity.
  const syncStatusInfo = useMemo(() => {
    if (!isOnline || !backendHealth.connected) {
      return {
        label: 'API OFFLINE',
        badgeClass: 'bg-[#EF4444]/15 text-[#EF4444] border-[#EF4444]/40',
        dotClass: 'bg-[#EF4444]',
        icon: WifiOff,
      };
    }
    if (rtState.status === 'connected') {
      return {
        label: 'REALTIME ONLINE',
        badgeClass: 'bg-[#00D979]/15 text-[#00D979] border-[#00D979]/40',
        dotClass: 'bg-[#00D979] shadow-[0_0_8px_#00D979]',
        icon: Wifi,
      };
    }
    if (rtState.status === 'connecting' || rtState.status === 'reconnecting') {
      return {
        label: 'API ONLINE • RT CONNECTING',
        badgeClass: 'bg-[#078BFF]/15 text-[#078BFF] border-[#078BFF]/40',
        dotClass: 'bg-[#078BFF] animate-ping',
        icon: RefreshCw,
      };
    }
    return {
      label: 'API ONLINE • RT OFFLINE',
      badgeClass: 'bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/40',
      dotClass: 'bg-[#F59E0B]',
      icon: WifiOff,
    };
  }, [isOnline, backendHealth, rtState.status]);

  /* =========================================================================
   * REAL DATABASE CALCULATIONS (Zero hardcoded sample data)
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
      const parts = del.parts || [];
      let receivedLines = 0;

      parts.forEach((p) => {
        const vState = getPartVerificationState(p);
        if (p.status === 'received' || vState.receivedQty > 0) {
          partsProcessedTotal += vState.receivedQty;
        }
        const rem = Math.max(0, vState.requiredQty - vState.receivedQty);
        pendingScansTotal += rem;
        if (p.status === 'received' || vState.receivedQty >= vState.requiredQty) {
          receivedLines += 1;
        }
      });

      if (del.status === 'completed' || (parts.length > 0 && receivedLines === parts.length)) {
        completedDeliveriesCount += 1;
      }

      (del.scanHistory || []).forEach((ev) => {
        try {
          const evDate = new Date(ev.timestamp);
          if (evDate >= sevenDaysAgo) {
            totalScansThisWeek += 1;
          }
          if (ev.timestamp && ev.timestamp.startsWith(todayStr)) {
            if (ev.partId) {
              const matchedPart = parts.find((p) => p.id === ev.partId);
              if (matchedPart?.palletNumber) {
                palletsScannedTodaySet.add(`${del.id}_${matchedPart.palletNumber}`);
              } else {
                palletsScannedTodaySet.add(`${del.id}_Pallet1`);
              }
            } else {
              palletsScannedTodaySet.add(`${del.id}_Pallet1`);
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

  // Gather latest operational events across deliveries (scans, docket creations, completions)
  const recentActivities = useMemo(() => {
    const events: {
      id: string;
      eventType: 'part_verified' | 'part_scanned' | 'docket_uploaded' | 'docket_completed';
      title: string;
      subtitle: string;
      badgeLabel: string;
      badgeColor: string;
      workerName: string;
      timestamp: string;
    }[] = [];

    const targetDeliveries = delivery
      ? [delivery, ...allDeliveries.filter((d) => d.id !== delivery.id)]
      : allDeliveries;

    targetDeliveries.forEach((del) => {
      // Docket upload event
      if (del.createdAt) {
        events.push({
          id: `docket_${del.id}`,
          eventType:
            del.status === 'completed' ? 'docket_completed' : 'docket_uploaded',
          title:
            del.status === 'completed'
              ? `Docket #${del.docketNumber} Completed`
              : `Docket #${del.docketNumber} Uploaded`,
          subtitle: `${del.supplier} · ${del.parts?.length || 0} part lines`,
          badgeLabel: del.status === 'completed' ? 'DOCKET COMPLETE' : 'NEW DOCKET',
          badgeColor:
            del.status === 'completed'
              ? 'text-[#00D979] bg-[#00D979]/15 border-[#00D979]/40'
              : 'text-[#078BFF] bg-[#078BFF]/15 border-[#078BFF]/40',
          workerName: 'Warehouse Intake',
          timestamp: del.updatedAt || del.createdAt,
        });
      }

      // Scan history events
      (del.scanHistory || []).forEach((ev) => {
        const matched = (del.parts || []).find(
          (p) => p.id === ev.partId || p.partNumber === ev.partNumber
        );
        const partNo = ev.partNumber || matched?.partNumber || ev.code || 'Part Scan';
        const desc = ev.recognizedDescription || matched?.description || 'Verified item';
        const qty = ev.addedQuantity || ev.receivedQuantity || 1;
        const worker = ev.employeeName || 'Operator';
        const isMatched = ev.status === 'match_success' || ev.status === 'manual_ticked';

        events.push({
          id: ev.id,
          eventType: isMatched ? 'part_verified' : 'part_scanned',
          title: `${partNo} (Qty: ${qty})`,
          subtitle: `${desc} · #${del.docketNumber} (${del.supplier})`,
          badgeLabel: isMatched ? 'VERIFIED' : 'SCANNED',
          badgeColor: isMatched
            ? 'text-[#00D979] bg-[#00D979]/15 border-[#00D979]/40'
            : 'text-[#F59E0B] bg-[#F59E0B]/15 border-[#F59E0B]/40',
          workerName: worker,
          timestamp: ev.timestamp,
        });
      });
    });

    return events
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 7);
  }, [delivery, allDeliveries]);

  // Active delivery statistics
  const activeDeliveryStats = useMemo(() => {
    if (!delivery) return null;
    const parts = delivery.parts || [];
    const total = parts.length;
    const received = parts.filter((p) => p.status === 'received').length;
    const remaining = total - received;
    const percentage = total > 0 ? Math.round((received / total) * 100) : 0;
    const isCompleted = delivery.status === 'completed' || (total > 0 && received === total);
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
        colors: ['#A020F0', '#C084FC', '#00D979', '#ffffff'],
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

  const renderRoleBadge = (role?: UserRole) => {
    switch (role) {
      case 'super_admin':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono font-bold uppercase bg-amber-950/90 border border-[#F59E0B]/40 text-[#F59E0B]">
            <ShieldAlert className="w-3 h-3" />
            SUPER ADMIN
          </span>
        );
      case 'admin':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono font-bold uppercase bg-purple-950/90 border border-[#A020F0]/50 text-[#C084FC]">
            <Shield className="w-3 h-3" />
            ADMIN
          </span>
        );
      case 'supervisor':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono font-bold uppercase bg-sky-950/90 border border-[#078BFF]/40 text-[#38BDF8]">
            <UserCheck className="w-3 h-3" />
            SUPERVISOR
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono font-bold uppercase bg-emerald-950/90 border border-[#00D979]/40 text-[#00D979]">
            <HardHat className="w-3 h-3" />
            OPERATOR
          </span>
        );
    }
  };

  const SyncIcon = syncStatusInfo.icon;

  return (
    <div className="flex-1 w-full bg-[var(--pt-bg,#080B12)] text-white flex flex-col pb-24">
      <div className="w-full max-w-6xl mx-auto px-3 sm:px-6 pt-3 sm:pt-6 space-y-4 sm:space-y-6">
        {/* =========================================================================
         * 1. INDUSTRIAL OPERATIONS CONTROL CENTRE HEADER & CONNECTION STATUS
         * ========================================================================= */}
        <header className="p-4 sm:p-5 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] shadow-lg space-y-3.5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            {/* Left: PartTrack Brand + Company/Site */}
            <div className="flex items-center gap-3 min-w-0">
              <PartTrackLogo size="md" showTagline />
              <div className="hidden sm:block h-8 w-px bg-[var(--pt-border,#29243D)] mx-1" />
              <div className="hidden sm:flex flex-col min-w-0">
                <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--pt-text-muted,#737B94)]">
                  Company &amp; Site
                </span>
                <span className="text-xs font-mono font-bold text-white truncate">
                  Main Manufacturing Facility · WH-01
                </span>
              </div>
            </div>

            {/* Right: Logged-in User, Role Badge, Activity Indicator, Shortcuts */}
            <div className="flex flex-wrap items-center justify-between md:justify-end gap-2">
              {currentUser && (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)]">
                  <div className="text-left">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-mono font-bold text-white">
                        {currentUser.employeeName}
                      </span>
                      {renderRoleBadge(currentUser.role)}
                    </div>
                    <div className="text-[10px] font-mono text-[var(--pt-text-secondary,#A3A8BD)]">
                      {currentUser.employeeCode} · Main Manufacturing Facility
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-1.5">
                {/* Activity / Notifications Indicator */}
                <button
                  type="button"
                  onClick={() => (onNavigateToReports ? onNavigateToReports() : onNavigateToChecklist())}
                  className="h-9 px-2.5 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/5 border border-[var(--pt-border,#29243D)] text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white inline-flex items-center gap-1.5 cursor-pointer transition-colors text-xs font-mono"
                  title="Recent Scanning Activity & Telemetry"
                >
                  <Bell className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)]" />
                  <span className="font-bold text-white">{recentActivities.length}</span>
                </button>

                {/* User Management Shortcut (Permitted Admins) */}
                {(currentUser?.role === 'super_admin' || currentUser?.role === 'admin') &&
                  onOpenUserManagement && (
                    <button
                      type="button"
                      onClick={onOpenUserManagement}
                      className="h-9 px-3 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/5 border border-[var(--pt-border,#29243D)] text-[var(--pt-primary-light,#C084FC)] hover:text-white inline-flex items-center gap-1.5 cursor-pointer transition-colors text-xs font-mono font-bold"
                      title="User Management (RBAC)"
                    >
                      <Users className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Users</span>
                    </button>
                  )}

                {/* Settings Shortcut */}
                {onOpenSettings && (
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="w-9 h-9 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/5 border border-[var(--pt-border,#29243D)] text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white inline-flex items-center justify-center cursor-pointer transition-colors"
                    title="Settings & App Theme"
                    aria-label="Open Settings"
                  >
                    <Settings className="w-4 h-4" />
                  </button>
                )}

                {/* Logout Shortcut */}
                {onLogout && (
                  <button
                    type="button"
                    onClick={onLogout}
                    className="w-9 h-9 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-[#EF4444]/15 border border-[var(--pt-border,#29243D)] hover:border-[#EF4444]/40 text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[#EF4444] inline-flex items-center justify-center cursor-pointer transition-colors"
                    title="Sign Out"
                    aria-label="Sign Out"
                  >
                    <LogOut className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Connection & Live Synchronisation Status Bar inside Header */}
          <div className="pt-3 border-t border-[var(--pt-border,#29243D)] flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-bold uppercase tracking-wider ${syncStatusInfo.badgeClass}`}
              >
                <span className={`w-2 h-2 rounded-full ${syncStatusInfo.dotClass}`} />
                <SyncIcon className="w-3.5 h-3.5" />
                <span>{syncStatusInfo.label}</span>
              </span>

              <span className="text-[11px] text-[var(--pt-text-secondary,#A3A8BD)]">
                Last Sync:{' '}
                <strong className="text-white">
                  {formatTimeAgo(
                    backendHealth.lastSyncedAt ||
                      rtState.lastSyncedAt ||
                      backendHealth.lastChecked ||
                      delivery?.updatedAt
                  )}
                </strong>
              </span>

              <button
                type="button"
                onClick={handleManualSync}
                disabled={isSyncingNow}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-[10px] font-mono font-bold text-[var(--pt-primary-light,#C084FC)] hover:text-white transition-colors cursor-pointer"
                title="Synchronise with central Cloudflare D1 database and reconnect live WebSocket"
              >
                <RefreshCw className={`w-3 h-3 ${isSyncingNow ? 'animate-spin' : ''}`} />
                <span>{isSyncingNow ? 'Syncing...' : !backendHealth.connected ? 'Retry' : 'Sync'}</span>
              </button>
            </div>

            <div className="flex items-center gap-3 text-[11px] text-[var(--pt-text-secondary,#A3A8BD)]">
              <span>
                Active Docket:{' '}
                <strong className="text-white">
                  {delivery ? `#${delivery.docketNumber} (${delivery.supplier})` : 'None Selected'}
                </strong>
              </span>
              {rtState.pendingOfflineScansCount > 0 && (
                <span className="text-[#F59E0B] font-bold">
                  • {rtState.pendingOfflineScansCount} Queued Offline
                </span>
              )}
            </div>
          </div>
        </header>

        {/* =========================================================================
         * 2. MAIN SCANNING HERO PANEL (READY TO SCAN?)
         * ========================================================================= */}
        <section
          className="relative overflow-hidden rounded-2xl bg-[var(--pt-card,#15182A)] border p-5 sm:p-7 shadow-xl"
          style={{
            borderColor: 'var(--pt-primary, #A020F0)',
            boxShadow: '0 0 36px var(--pt-glow-soft, rgba(160, 32, 240, 0.16))',
          }}
        >
          {/* Ambient Theme Glow */}
          <div
            className="absolute -top-24 -right-24 w-80 h-80 rounded-full blur-3xl pointer-events-none opacity-35"
            style={{
              background:
                'radial-gradient(circle, var(--pt-primary, #A020F0) 0%, transparent 70%)',
            }}
          />

          <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
            <div className="space-y-2.5 max-w-2xl">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-mono font-bold tracking-widest uppercase text-[var(--pt-primary-light,#C084FC)]">
                  <span
                    className="w-2 h-2 rounded-full animate-pulse"
                    style={{ backgroundColor: 'var(--pt-primary-light, #C084FC)' }}
                  />
                  INDUSTRIAL OPTICAL VERIFICATION ENGINE
                </span>
                <span className="text-[var(--pt-text-muted,#737B94)]">•</span>
                <span className="text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)]">
                  {delivery ? `Docket #${delivery.docketNumber}` : 'Ready for Inbound Shipments'}
                </span>
              </div>

              <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white font-sans">
                {allDeliveries.length === 0 ? 'NO DOCKETS ON FILE' : 'DOCKET RECEIVING CONTROL'}
              </h2>

              <p className="text-xs sm:text-sm text-[var(--pt-text-secondary,#A3A8BD)] leading-relaxed">
                {allDeliveries.length === 0
                  ? 'Upload one or more delivery dockets to create independent shipments, or group existing dockets to scan parts.'
                  : 'Open an individual delivery docket or a docket group to verify barcodes, QR codes and pallet labels in real time.'}
              </p>

              {/* Supported Scanning Methods */}
              <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] font-mono">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] text-[var(--pt-primary-light,#C084FC)] font-semibold">
                  <Barcode className="w-3.5 h-3.5" />
                  <span>1D Barcode</span>
                </span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] text-[var(--pt-primary-light,#C084FC)] font-semibold">
                  <QrCode className="w-3.5 h-3.5" />
                  <span>2D QR Code</span>
                </span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] text-[var(--pt-primary-light,#C084FC)] font-semibold">
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Pallet Label OCR / GCI</span>
                </span>
              </div>
            </div>

            {/* Primary & Secondary Action Buttons (Never global scan — open a docket or upload) */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 shrink-0">
              {delivery ? (
                <button
                  type="button"
                  onClick={() => onNavigateToChecklist()}
                  className="h-13 sm:h-14 px-6 sm:px-7 rounded-xl pt-btn-primary font-mono font-extrabold text-sm tracking-wider uppercase inline-flex items-center justify-center gap-3 transition-all transform active:scale-[0.98] cursor-pointer"
                >
                  <ClipboardList className="w-5 h-5 stroke-[2.4]" />
                  <span>OPEN DOCKET #{delivery.docketNumber}</span>
                  <ArrowUpRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => (onNavigateToOrders ? onNavigateToOrders() : onNavigateToChecklist())}
                  className="h-13 sm:h-14 px-6 sm:px-7 rounded-xl pt-btn-primary font-mono font-extrabold text-sm tracking-wider uppercase inline-flex items-center justify-center gap-3 transition-all transform active:scale-[0.98] cursor-pointer"
                >
                  <ClipboardList className="w-5 h-5 stroke-[2.4]" />
                  <span>VIEW DOCKETS</span>
                  <ArrowUpRight className="w-4 h-4" />
                </button>
              )}

              {onOpenNewDelivery && (
                <button
                  type="button"
                  onClick={onOpenNewDelivery}
                  className="h-13 sm:h-14 px-5 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)] text-white font-mono font-bold text-xs uppercase tracking-wider inline-flex items-center justify-center gap-2 transition-colors cursor-pointer"
                >
                  <Plus className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)] stroke-[2.5]" />
                  <span>UPLOAD DOCKETS</span>
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
            <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-[var(--pt-text-secondary,#A3A8BD)]">
              LIVE OPERATIONS STATISTICS
            </h3>
            <span className="text-[11px] font-mono text-[var(--pt-primary-light,#C084FC)] font-semibold">
              {stats.totalDeliveries} {stats.totalDeliveries === 1 ? 'docket' : 'dockets'} in database
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5 sm:gap-3.5">
            {/* Stat 1: Pallets Today */}
            <div className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)]/50 transition-colors flex flex-col justify-between">
              <div className="flex items-center justify-between text-[var(--pt-text-secondary,#A3A8BD)] mb-2">
                <span className="text-[10px] font-mono uppercase tracking-wider font-bold">
                  Pallets Today
                </span>
                <Boxes className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
              </div>
              <div>
                <div className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-white">
                  {stats.palletsScannedToday}
                </div>
                <div className="text-[10px] font-mono text-[var(--pt-text-muted,#737B94)] mt-0.5 truncate">
                  {stats.palletsScannedToday > 0 ? 'Active pallets today' : 'Awaiting scans'}
                </div>
              </div>
            </div>

            {/* Stat 2: Parts Processed */}
            <div className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)]/50 transition-colors flex flex-col justify-between">
              <div className="flex items-center justify-between text-[var(--pt-text-secondary,#A3A8BD)] mb-2">
                <span className="text-[10px] font-mono uppercase tracking-wider font-bold">
                  Parts Processed
                </span>
                <CheckCircle2 className="w-4 h-4 text-[#00D979]" />
              </div>
              <div>
                <div className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-[#00D979]">
                  {stats.partsProcessed}
                </div>
                <div className="text-[10px] font-mono text-[#00D979]/80 mt-0.5 truncate">
                  Verified units received
                </div>
              </div>
            </div>

            {/* Stat 3: Pending Scans */}
            <div className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)]/50 transition-colors flex flex-col justify-between">
              <div className="flex items-center justify-between text-[var(--pt-text-secondary,#A3A8BD)] mb-2">
                <span className="text-[10px] font-mono uppercase tracking-wider font-bold">
                  Pending Scans
                </span>
                <Clock className="w-4 h-4 text-[#F59E0B]" />
              </div>
              <div>
                <div className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-[#F59E0B]">
                  {stats.pendingScans}
                </div>
                <div className="text-[10px] font-mono text-[#F59E0B]/80 mt-0.5 truncate">
                  Outstanding units
                </div>
              </div>
            </div>

            {/* Stat 4: Completed Dockets */}
            <div className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)]/50 transition-colors flex flex-col justify-between">
              <div className="flex items-center justify-between text-[var(--pt-text-secondary,#A3A8BD)] mb-2">
                <span className="text-[10px] font-mono uppercase tracking-wider font-bold">
                  Completed Dockets
                </span>
                <Archive className="w-4 h-4 text-[#078BFF]" />
              </div>
              <div>
                <div className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-white">
                  {stats.completedDeliveries}
                </div>
                <div className="text-[10px] font-mono text-[var(--pt-text-muted,#737B94)] mt-0.5 truncate">
                  Full shipment verified
                </div>
              </div>
            </div>

            {/* Stat 5: Scans This Week */}
            <div className="col-span-2 md:col-span-1 p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)]/50 transition-colors flex flex-col justify-between">
              <div className="flex items-center justify-between text-[var(--pt-text-secondary,#A3A8BD)] mb-2">
                <span className="text-[10px] font-mono uppercase tracking-wider font-bold">
                  Scans This Week
                </span>
                <TrendingUp className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
              </div>
              <div>
                <div className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-[var(--pt-primary-light,#C084FC)]">
                  {stats.scansThisWeek}
                </div>
                <div className="text-[10px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-0.5 truncate">
                  7-day scan velocity
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* =========================================================================
         * 4. ACTIVE DOCKET CARD & RECEIVING PROGRESS (When docket is selected)
         * ========================================================================= */}
        {delivery && activeDeliveryStats && (
          <section className="rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] p-4 sm:p-5 space-y-4 shadow-md">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[var(--pt-border,#29243D)] pb-3.5">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-base font-extrabold text-white tracking-tight font-sans">
                    {delivery.supplier}
                  </h3>
                  <span className="text-xs font-mono font-bold px-2.5 py-0.5 rounded-md bg-[var(--pt-bg-secondary,#101321)] text-[var(--pt-primary-light,#C084FC)] border border-[var(--pt-border,#29243D)]">
                    Docket #{delivery.docketNumber}
                  </span>
                  {activeDeliveryStats.isCompleted ? (
                    <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-[#00D979]/15 border border-[#00D979]/40 text-[#00D979] uppercase">
                      COMPLETE
                    </span>
                  ) : activeDeliveryStats.received > 0 ? (
                    <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-[#078BFF]/15 border border-[#078BFF]/40 text-[#078BFF] uppercase">
                      STARTED
                    </span>
                  ) : (
                    <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-[#F59E0B]/15 border border-[#F59E0B]/40 text-[#F59E0B] uppercase">
                      INCOMPLETE
                    </span>
                  )}
                </div>
                <p className="text-xs font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-1">
                  Delivery Date: {delivery.deliveryDate}{' '}
                  {delivery.palletCount ? `• ${delivery.palletCount} Pallets` : ''}
                </p>
              </div>

              {/* Actions Dropdown */}
              <div className="relative shrink-0 flex items-center gap-2" ref={menuRef}>
                <button
                  type="button"
                  onClick={() => onNavigateToChecklist()}
                  className="h-9 px-3.5 rounded-xl pt-btn-primary text-xs font-mono font-bold uppercase tracking-wider inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <ClipboardList className="w-3.5 h-3.5" />
                  <span>Order Details</span>
                </button>

                <button
                  type="button"
                  onClick={handleExportPdf}
                  disabled={isExportingPdf}
                  className="h-9 px-3 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/5 border border-[var(--pt-border,#29243D)] text-xs font-mono font-semibold text-white inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                >
                  <Printer className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)]" />
                  <span className="hidden sm:inline">
                    {isExportingPdf ? 'Exporting...' : 'PDF'}
                  </span>
                </button>

                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setActionsMenuOpen((p) => !p)}
                    className="h-9 w-9 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/5 border border-[var(--pt-border,#29243D)] text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white flex items-center justify-center cursor-pointer transition-colors"
                    title="More docket actions"
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </button>

                  {actionsMenuOpen && (
                    <div className="absolute right-0 mt-1.5 w-56 bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] shadow-2xl rounded-xl py-1 z-30 text-xs font-sans divide-y divide-[var(--pt-border,#29243D)]">
                      <button
                        type="button"
                        onClick={handleExportPdf}
                        className="w-full px-3.5 py-2.5 text-left text-white hover:bg-white/5 flex items-center gap-2 cursor-pointer transition-colors"
                      >
                        <Printer className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)]" />
                        <span>Export colour-coded PDF</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setActionsMenuOpen(false);
                          setIsDocketPhotosOpen(true);
                        }}
                        className="w-full px-3.5 py-2.5 text-left text-white hover:bg-white/5 flex items-center gap-2 cursor-pointer transition-colors"
                      >
                        <FileText className="w-3.5 h-3.5 text-[var(--pt-text-secondary,#A3A8BD)]" />
                        <span>Original docket photo(s)</span>
                      </button>

                      {activeDeliveryStats.isCompleted ? (
                        <button
                          type="button"
                          onClick={handleReopen}
                          className="w-full px-3.5 py-2.5 text-left text-[#F59E0B] hover:bg-white/5 flex items-center gap-2 cursor-pointer transition-colors"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>Reopen delivery</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={handleMarkComplete}
                          className="w-full px-3.5 py-2.5 text-left text-[#00D979] font-semibold hover:bg-white/5 flex items-center gap-2 cursor-pointer transition-colors"
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
                <span className="text-[var(--pt-text-secondary,#A3A8BD)] uppercase tracking-wider font-semibold">
                  Verification Progress
                </span>
                <span className="text-[var(--pt-primary-light,#C084FC)] font-bold tabular-nums">
                  {activeDeliveryStats.received} / {activeDeliveryStats.total} parts (
                  {activeDeliveryStats.percentage}%)
                </span>
              </div>

              <div className="w-full h-2.5 rounded-full bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${activeDeliveryStats.percentage}%`,
                    background:
                      activeDeliveryStats.percentage === 100
                        ? '#00D979'
                        : 'linear-gradient(90deg, var(--pt-primary, #A020F0) 0%, var(--pt-primary-light, #C084FC) 100%)',
                  }}
                />
              </div>

              <div className="flex items-center justify-between text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] pt-1">
                <span>{activeDeliveryStats.remaining} remaining to scan</span>
                {activeDeliveryStats.unexpectedCount > 0 ? (
                  <button
                    type="button"
                    onClick={onOpenUnexpectedModal}
                    className="text-[#EF4444] hover:underline font-bold cursor-pointer"
                  >
                    {activeDeliveryStats.unexpectedCount} unexpected flagged
                  </button>
                ) : (
                  <span className="text-[#00D979]">0 discrepancies</span>
                )}
                <button
                  type="button"
                  onClick={() => onNavigateToChecklist()}
                  className="text-[var(--pt-primary-light,#C084FC)] hover:underline flex items-center gap-1 font-bold cursor-pointer"
                >
                  <span>Manage Parts &amp; Pallets</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </section>
        )}

        {/* =========================================================================
         * 5. RECENT ACTIVITY & THROUGHPUT VELOCITY (Side-by-Side on Desktop)
         * ========================================================================= */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
          {/* Recent Activity Section */}
          <section className="rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] p-4 sm:p-5 flex flex-col justify-between">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-white">
                  RECENT OPERATIONAL ACTIVITY
                </h3>
                <p className="text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-0.5">
                  Live dockets uploaded, parts scanned &amp; verifications logged
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  onNavigateToOrders ? onNavigateToOrders() : onNavigateToChecklist()
                }
                className="text-[11px] font-mono font-bold text-[var(--pt-primary-light,#C084FC)] hover:underline flex items-center gap-0.5 cursor-pointer"
              >
                <span>VIEW ORDERS</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {recentActivities.length > 0 ? (
              <div className="divide-y divide-[var(--pt-border,#29243D)]/70 overflow-hidden">
                {recentActivities.map((act) => (
                  <div
                    key={act.id}
                    className="py-2.5 flex items-center justify-between gap-3 hover:bg-white/[0.02] px-1.5 rounded-lg transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-bold text-xs text-white truncate">
                          {act.title}
                        </span>
                        <span
                          className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border uppercase ${act.badgeColor}`}
                        >
                          {act.badgeLabel}
                        </span>
                      </div>
                      <p className="text-[11px] text-[var(--pt-text-secondary,#A3A8BD)] truncate mt-0.5 font-sans">
                        {act.subtitle}
                      </p>
                    </div>

                    <div className="text-right shrink-0 font-mono">
                      <span className="text-[10px] font-semibold text-[var(--pt-primary-light,#C084FC)] block">
                        {act.workerName}
                      </span>
                      <span className="text-[10px] text-[var(--pt-text-muted,#737B94)]">
                        {formatTimeAgo(act.timestamp)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-10 px-4 flex flex-col items-center justify-center text-center space-y-2 border border-dashed border-[var(--pt-border,#29243D)] rounded-xl">
                <CheckCircle2 className="w-6 h-6 text-[var(--pt-text-muted,#737B94)] mb-1" />
                <p className="text-xs font-semibold text-white">No operational activity yet</p>
                <p className="text-[11px] font-mono text-[var(--pt-text-muted,#737B94)] max-w-xs">
                  Upload a delivery docket or scan a barcode/QR code to begin tracking activity in real time.
                </p>
              </div>
            )}
          </section>

          {/* Operations Overview Chart */}
          <section className="rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] p-4 sm:p-5 flex flex-col justify-between">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-white">
                  SCANNING THROUGHPUT (7 DAYS)
                </h3>
                <p className="text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-0.5">
                  Real scan events logged across warehouse terminals
                </p>
              </div>
              <Activity className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
            </div>

            {weeklyActivityData.hasAnyData ? (
              <div className="space-y-4">
                <div className="h-40 w-full flex items-end justify-between gap-2 pt-4 px-2">
                  {weeklyActivityData.days.map((d, idx) => {
                    const heightPercent = Math.max(
                      8,
                      Math.round((d.count / weeklyActivityData.maxCount) * 100)
                    );
                    return (
                      <div
                        key={idx}
                        className="flex-1 flex flex-col items-center gap-1.5 h-full justify-end group"
                      >
                        <span className="text-[10px] font-mono font-bold text-[var(--pt-primary-light,#C084FC)]">
                          {d.count}
                        </span>
                        <div
                          className="w-full rounded-t-lg transition-all duration-300 group-hover:brightness-125"
                          style={{
                            height: `${heightPercent}%`,
                            background:
                              d.count > 0
                                ? 'linear-gradient(180deg, var(--pt-primary-light, #C084FC) 0%, var(--pt-primary, #A020F0) 100%)'
                                : 'var(--pt-bg-secondary, #101321)',
                            border: '1px solid var(--pt-border, #29243D)',
                          }}
                        />
                        <span className="text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] font-bold">
                          {d.label}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-[var(--pt-border,#29243D)] text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)]">
                  <span>Weekly Total: {stats.scansThisWeek} scans</span>
                  {onNavigateToReports && (
                    <button
                      type="button"
                      onClick={onNavigateToReports}
                      className="text-[var(--pt-primary-light,#C084FC)] hover:underline font-bold flex items-center gap-1 cursor-pointer"
                    >
                      <span>Open Full Analytics</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="py-10 px-4 flex flex-col items-center justify-center text-center space-y-2 border border-dashed border-[var(--pt-border,#29243D)] rounded-xl">
                <Activity className="w-6 h-6 text-[var(--pt-text-muted,#737B94)] mb-1" />
                <p className="text-xs font-semibold text-white">
                  No scan throughput recorded this week
                </p>
                <p className="text-[11px] font-mono text-[var(--pt-text-muted,#737B94)] max-w-xs">
                  Scan events logged using 1D barcode, 2D QR, or Pallet Label OCR will chart daily velocity here.
                </p>
                <button
                  type="button"
                  onClick={() => (onNavigateToOrders ? onNavigateToOrders() : onNavigateToChecklist())}
                  className="mt-2 text-xs font-mono font-bold text-[var(--pt-primary-light,#C084FC)] hover:underline flex items-center gap-1 cursor-pointer"
                >
                  <span>Open dockets to scan</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </section>
        </div>

        {/* =========================================================================
         * 6. QUICK OPERATIONS TOOLS
         * ========================================================================= */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <button
            type="button"
            onClick={() => (onNavigateToOrders ? onNavigateToOrders() : onNavigateToChecklist())}
            className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] hover:bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)] text-left transition-all cursor-pointer group"
          >
            <div className="w-9 h-9 rounded-xl bg-[var(--pt-bg,#080B12)] text-[#078BFF] border border-[var(--pt-border,#29243D)] flex items-center justify-center mb-2.5 group-hover:scale-105 transition-transform">
              <ClipboardList className="w-4 h-4" />
            </div>
            <div className="font-bold text-xs text-white">Delivery Dockets</div>
            <div className="text-[10px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-0.5">
              {stats.totalDeliveries} dockets · Open to scan parts
            </div>
          </button>

          <button
            type="button"
            onClick={() => (onNavigateToGroups ? onNavigateToGroups() : onNavigateToOrders?.())}
            className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] hover:bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)] text-left transition-all cursor-pointer group"
          >
            <div className="w-9 h-9 rounded-xl bg-[var(--pt-bg,#080B12)] text-[var(--pt-primary-light,#C084FC)] border border-[var(--pt-border,#29243D)] flex items-center justify-center mb-2.5 group-hover:scale-105 transition-transform">
              <FolderKanban className="w-4 h-4" />
            </div>
            <div className="font-bold text-xs text-white">Docket Groups</div>
            <div className="text-[10px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-0.5">
              {groupsCount} {groupsCount === 1 ? 'group' : 'groups'} · Batch group scanning
            </div>
          </button>

          <button
            type="button"
            onClick={() =>
              onNavigateToReports ? onNavigateToReports() : handleExportPdf()
            }
            className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] hover:bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)] text-left transition-all cursor-pointer group"
          >
            <div className="w-9 h-9 rounded-xl bg-[var(--pt-bg,#080B12)] text-[#00D979] border border-[var(--pt-border,#29243D)] flex items-center justify-center mb-2.5 group-hover:scale-105 transition-transform">
              <BarChart3 className="w-4 h-4" />
            </div>
            <div className="font-bold text-xs text-white">Reports &amp; Exports</div>
            <div className="text-[10px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-0.5">
              PDF, CSV &amp; User Accountability
            </div>
          </button>

          <button
            type="button"
            onClick={() => onOpenDeliveriesList?.()}
            className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] hover:bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)] text-left transition-all cursor-pointer group"
          >
            <div className="w-9 h-9 rounded-xl bg-[var(--pt-bg,#080B12)] text-[#F59E0B] border border-[var(--pt-border,#29243D)] flex items-center justify-center mb-2.5 group-hover:scale-105 transition-transform">
              <FolderOpen className="w-4 h-4" />
            </div>
            <div className="font-bold text-xs text-white">Switch Active Docket</div>
            <div className="text-[10px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-0.5">
              Select or upload docket
            </div>
          </button>
        </section>

        {/* =========================================================================
         * 7. STORAGE & SYNCHRONISATION TELEMETRY FOOTER
         * ========================================================================= */}
        <section className="rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] p-3.5 sm:p-4 text-xs font-mono">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[var(--pt-text-secondary,#A3A8BD)]">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)] shrink-0" />
              <span className="text-white font-bold">{BRANDING.appNameUppercase}:</span>
              <span className="text-[#00D979] font-bold">{BRANDING.tagline}</span>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-[11px]">
              <div>
                <span className="text-[var(--pt-text-muted,#737B94)]">Offline Queue: </span>
                <span className="text-white font-bold">
                  {rtState.pendingOfflineScansCount} Pending
                </span>
              </div>
              <div>
                <span className="text-[var(--pt-text-muted,#737B94)]">OCR Engine: </span>
                <span className="text-[var(--pt-primary-light,#C084FC)] font-bold">
                  {isOnline ? 'Cloud Vision + Local Tesseract' : 'Local Tesseract Offline'}
                </span>
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
