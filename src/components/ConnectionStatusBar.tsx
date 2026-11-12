import React, { useEffect, useState } from 'react';
import { WifiOff, RefreshCw, Users, Radio, ScanLine, Clock, FileUp } from 'lucide-react';
import {
  subscribeToBackendHealth,
  checkBackendConnection,
  BackendHealth,
  getStoredUser,
} from '../services/palletTrackApi.ts';
import {
  realtimeClient,
  RealtimeClientState,
  RealtimeSyncEvent,
} from '../services/realtimeSync.ts';
import { WorkerPresence } from '../types/delivery.ts';

interface LiveActivityNotice {
  id: string;
  message: string;
  actor: string;
  type: 'scan' | 'docket' | 'edit' | 'duplicate';
  timestamp: string;
}

export const ConnectionStatusBar: React.FC = () => {
  const [health, setHealth] = useState<BackendHealth>({ connected: true });
  const [isChecking, setIsChecking] = useState(false);
  const [rtState, setRtState] = useState<RealtimeClientState>(() => realtimeClient.getState());
  const [liveNotice, setLiveNotice] = useState<LiveActivityNotice | null>(null);

  useEffect(() => {
    checkBackendConnection().catch(() => {});

    const interval = setInterval(() => {
      checkBackendConnection().catch(() => {});
    }, 10000);

    const unsubscribeHealth = subscribeToBackendHealth(setHealth);
    const unsubscribeRtState = realtimeClient.onStateChange((state, presence) => {
      setRtState({
        status: state,
        presence,
        pendingOfflineScansCount: realtimeClient.getOfflineQueue().length,
      });
    });

    const unsubscribeRtEvent = realtimeClient.onEvent((event: RealtimeSyncEvent) => {
      const me = getStoredUser();
      if (me && event.userId === me.id) return;

      const actor = event.employeeName || 'Coworker';
      let notice: LiveActivityNotice | null = null;

      if (event.type === 'part:scanned' || event.type === 'quantity:updated') {
        const partNumber = event.payload?.part?.partNumber || event.payload?.partNumber || 'Part';
        const recQty = event.payload?.receivedQuantity ?? event.payload?.part?.receivedQuantity ?? 1;
        const reqQty = event.payload?.requiredQuantity ?? event.payload?.part?.quantity ?? 1;
        notice = {
          id: event.id,
          actor,
          type: 'scan',
          message: `scanned ${partNumber} (${recQty}/${reqQty})`,
          timestamp: event.timestamp,
        };
      } else if (event.type === 'delivery:processing') {
        const fileName = event.payload?.fileName || 'Delivery Docket';
        notice = {
          id: event.id,
          actor,
          type: 'docket',
          message: `is uploading & compiling ${fileName}...`,
          timestamp: event.timestamp,
        };
      } else if (event.type === 'delivery:created') {
        const docketNo = event.payload?.delivery?.docketNumber || 'New Delivery';
        notice = {
          id: event.id,
          actor,
          type: 'docket',
          message: `added delivery ${docketNo}`,
          timestamp: event.timestamp,
        };
      } else if (
        event.type === 'part:added' ||
        event.type === 'part:edited' ||
        event.type === 'parts:batch_saved'
      ) {
        notice = {
          id: event.id,
          actor,
          type: 'edit',
          message:
            event.type === 'part:added'
              ? `added part ${event.payload?.part?.partNumber || ''}`
              : `updated delivery parts list`,
          timestamp: event.timestamp,
        };
      }

      if (notice) {
        setLiveNotice(notice);
      }
    });

    const handleWindowOnline = () => {
      checkBackendConnection().catch(() => {});
    };
    const handleWindowOffline = () => {
      setHealth({ connected: false, error: 'Device is offline' });
    };

    window.addEventListener('online', handleWindowOnline);
    window.addEventListener('offline', handleWindowOffline);

    return () => {
      clearInterval(interval);
      unsubscribeHealth();
      unsubscribeRtState();
      unsubscribeRtEvent();
      window.removeEventListener('online', handleWindowOnline);
      window.removeEventListener('offline', handleWindowOffline);
    };
  }, []);

  useEffect(() => {
    if (!liveNotice) return;
    const t = setTimeout(() => {
      setLiveNotice((curr) => (curr?.id === liveNotice.id ? null : curr));
    }, 5500);
    return () => clearTimeout(t);
  }, [liveNotice]);

  const handleRetry = async () => {
    setIsChecking(true);
    try {
      await checkBackendConnection();
      realtimeClient.flushPendingOfflineScans().catch(() => {});
    } finally {
      setIsChecking(false);
    }
  };

  if (!health.connected) {
    return (
      <div
        role="alert"
        className="bg-amber-950/90 border-b border-[#F59E0B]/60 text-amber-100 px-3 py-2 text-xs flex items-center justify-between shadow-lg sticky top-0 z-40 backdrop-blur-sm"
      >
        <div className="flex items-center gap-2 min-w-0">
          <WifiOff className="w-4 h-4 text-[#F59E0B] shrink-0" />
          <div className="truncate font-mono">
            <span className="font-bold text-[#F59E0B] uppercase tracking-wider mr-1.5">
              OFFLINE:
            </span>
            <span className="text-amber-200">
              Receiving paused.
              {rtState.pendingOfflineScansCount > 0
                ? ` (${rtState.pendingOfflineScansCount} scan pending server verification)`
                : ' Reconnect to sync with central D1 database.'}
            </span>
          </div>
        </div>
        <button
          onClick={handleRetry}
          disabled={isChecking}
          className="ml-3 shrink-0 flex items-center gap-1 px-2.5 py-1 bg-[#F59E0B]/25 hover:bg-[#F59E0B]/40 border border-[#F59E0B]/50 rounded-lg text-amber-200 font-mono font-bold tracking-wide transition-colors cursor-pointer"
        >
          <RefreshCw className={`w-3 h-3 ${isChecking ? 'animate-spin' : ''}`} />
          <span>{isChecking ? 'Checking...' : 'Retry'}</span>
        </button>
      </div>
    );
  }

  const presence = rtState.presence;
  const currentUser = getStoredUser();
  const deliveryWorkers: WorkerPresence[] = presence?.deliveryWorkers || presence?.workers || [];
  const otherDeliveryWorkers = deliveryWorkers.filter(
    (w: WorkerPresence) => w.userId !== currentUser?.id
  );
  const activelyScanningWorkers = otherDeliveryWorkers.filter(
    (w: WorkerPresence) => w.status === 'scanning'
  );
  const totalOnlineCount = Math.max(1, presence?.connectedWorkersCount || 1);

  return (
    <div className="bg-[var(--pt-bg-secondary,#101321)] text-white border-b border-[var(--pt-border,#29243D)] px-3 sm:px-6 py-1.5 text-[11px] flex items-center justify-between gap-2 z-20 shrink-0">
      <div className="max-w-6xl w-full mx-auto flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0 flex-wrap">
          {/* Live Sync Status Indicator */}
          <div className="flex items-center gap-1.5 font-mono">
            <span
              className={`w-2 h-2 rounded-full ${
                rtState.status === 'connected'
                  ? 'bg-[#00D979] shadow-[0_0_8px_#00D979]'
                  : rtState.status === 'reconnecting' || rtState.status === 'connecting'
                  ? 'bg-[#F59E0B] animate-ping'
                  : 'bg-slate-500'
              }`}
            />
            <span className="text-[10px] uppercase tracking-wider font-bold text-white">
              {rtState.status === 'connected'
                ? 'ONLINE • SYNCED'
                : rtState.status === 'reconnecting' || rtState.status === 'connecting'
                ? 'CONNECTING'
                : 'SYNC ERROR'}
            </span>
          </div>

          {/* Connected Workers Count */}
          <div className="flex items-center gap-1 text-[var(--pt-text-secondary,#A3A8BD)] bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] px-2 py-0.5 rounded-md font-mono text-[10px]">
            <Users className="w-3 h-3 text-[var(--pt-primary-light,#C084FC)] shrink-0" />
            <span>
              {totalOnlineCount} {totalOnlineCount === 1 ? 'Worker' : 'Workers'} Online
            </span>
          </div>

          {/* Coworkers in the same delivery */}
          {otherDeliveryWorkers.length > 0 && (
            <div className="flex items-center gap-1.5 min-w-0">
              {otherDeliveryWorkers.slice(0, 3).map((w: WorkerPresence) => (
                <span
                  key={w.userId}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-mono text-[10px] border ${
                    w.status === 'scanning'
                      ? 'bg-[#00D979]/15 border-[#00D979]/50 text-[#00D979]'
                      : 'bg-[var(--pt-card,#15182A)] border-[var(--pt-border,#29243D)] text-[var(--pt-text-secondary,#A3A8BD)]'
                  }`}
                  title={`${w.employeeName} (${
                    w.status === 'scanning'
                      ? 'Actively scanning this delivery'
                      : 'Viewing this delivery'
                  })`}
                >
                  {w.status === 'scanning' ? (
                    <ScanLine className="w-2.5 h-2.5 text-[#00D979] animate-pulse" />
                  ) : (
                    <Radio className="w-2.5 h-2.5 text-[var(--pt-primary-light,#C084FC)]" />
                  )}
                  <span className="truncate max-w-[100px]">{w.employeeName}</span>
                  {w.status === 'scanning' && (
                    <span className="text-[9px] uppercase text-[#00D979] font-bold">Scanning</span>
                  )}
                </span>
              ))}
              {otherDeliveryWorkers.length > 3 && (
                <span className="font-mono text-[10px] text-[var(--pt-text-muted,#737B94)]">
                  +{otherDeliveryWorkers.length - 3} more
                </span>
              )}
            </div>
          )}

          {/* Pending Offline Scans Indicator */}
          {rtState.pendingOfflineScansCount > 0 && (
            <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#F59E0B]/15 border border-[#F59E0B]/50 text-[#F59E0B] font-mono text-[10px]">
              <Clock className="w-3 h-3 text-[#F59E0B] animate-spin" />
              <span>{rtState.pendingOfflineScansCount} Pending Sync</span>
            </div>
          )}
        </div>

        {/* Live Coworker Activity Toast */}
        {liveNotice ? (
          <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-[var(--pt-card,#15182A)] border border-[var(--pt-primary,#A020F0)]/50 text-white font-mono text-[10px] truncate max-w-[55%] sm:max-w-[360px]">
            {liveNotice.type === 'docket' ? (
              <FileUp className="w-3 h-3 text-[var(--pt-primary-light,#C084FC)] shrink-0" />
            ) : (
              <ScanLine className="w-3 h-3 text-[#00D979] shrink-0" />
            )}
            <span className="font-bold text-[var(--pt-primary-light,#C084FC)] shrink-0">
              {liveNotice.actor}
            </span>
            <span className="truncate">{liveNotice.message}</span>
          </div>
        ) : activelyScanningWorkers.length > 0 ? (
          <div className="hidden sm:flex items-center gap-1 text-[#00D979] font-mono text-[10px]">
            <ScanLine className="w-3 h-3 animate-pulse" />
            <span>
              {activelyScanningWorkers.map((w: WorkerPresence) => w.employeeName).join(', ')}{' '}
              scanning live
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
};
