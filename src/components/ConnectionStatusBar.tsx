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
      } else if (event.type === 'part:added' || event.type === 'part:edited' || event.type === 'parts:batch_saved') {
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
        className="bg-amber-950/90 border-b border-amber-600/60 text-amber-100 px-3 py-2 text-xs flex items-center justify-between shadow-lg sticky top-0 z-40 backdrop-blur-sm animate-pulse-subtle"
      >
        <div className="flex items-center gap-2 min-w-0">
          <WifiOff className="w-4 h-4 text-amber-400 shrink-0" />
          <div className="truncate">
            <span className="font-bold text-amber-300 uppercase tracking-wider mr-1.5">
              Database Disconnected:
            </span>
            <span className="text-amber-200">
              Receiving paused.{rtState.pendingOfflineScansCount > 0 ? ` (${rtState.pendingOfflineScansCount} scan pending server verification)` : ' Online connection to central database is required.'}
            </span>
          </div>
        </div>
        <button
          onClick={handleRetry}
          disabled={isChecking}
          className="ml-3 shrink-0 flex items-center gap-1 px-2.5 py-1 bg-amber-600/30 hover:bg-amber-600/50 active:bg-amber-600/60 border border-amber-500/50 rounded text-amber-200 font-semibold tracking-wide transition-colors"
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
  const otherDeliveryWorkers = deliveryWorkers.filter((w: WorkerPresence) => w.userId !== currentUser?.id);
  const activelyScanningWorkers = otherDeliveryWorkers.filter((w: WorkerPresence) => w.status === 'scanning');
  const totalOnlineCount = Math.max(1, presence?.connectedWorkersCount || 1);

  return (
    <div className="bg-zinc-900 text-zinc-100 border-b border-zinc-800 px-3 py-1.5 text-[11px] flex items-center justify-between gap-2 z-30 shrink-0">
      <div className="flex items-center gap-2.5 min-w-0 flex-wrap">
        {/* Live Sync Status Indicator */}
        <div className="flex items-center gap-1.5 font-mono">
          <span
            className={`w-2 h-2 rounded-full ${
              rtState.status === 'connected'
                ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]'
                : rtState.status === 'reconnecting' || rtState.status === 'connecting'
                  ? 'bg-amber-400 animate-ping'
                  : 'bg-zinc-500'
            }`}
          />
          <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-300">
            {rtState.status === 'connected'
              ? 'Live Sync'
              : rtState.status === 'reconnecting'
                ? 'Reconnecting...'
                : 'Syncing'}
          </span>
        </div>

        {/* Connected Workers Count */}
        <div className="flex items-center gap-1 text-zinc-300 bg-zinc-800/90 border border-zinc-700/80 px-2 py-0.5 rounded-[3px] font-mono text-[10px]">
          <Users className="w-3 h-3 text-emerald-400 shrink-0" />
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
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[3px] font-mono text-[10px] border ${
                  w.status === 'scanning'
                    ? 'bg-emerald-950/80 border-emerald-600/60 text-emerald-300'
                    : 'bg-zinc-800 border-zinc-700 text-zinc-300'
                }`}
                title={`${w.employeeName} (${w.status === 'scanning' ? 'Actively scanning this delivery' : 'Viewing this delivery'})`}
              >
                {w.status === 'scanning' ? (
                  <ScanLine className="w-2.5 h-2.5 text-emerald-400 animate-pulse" />
                ) : (
                  <Radio className="w-2.5 h-2.5 text-cyan-400" />
                )}
                <span className="truncate max-w-[100px]">{w.employeeName}</span>
                {w.status === 'scanning' && (
                  <span className="text-[9px] uppercase text-emerald-400 font-bold">Scanning</span>
                )}
              </span>
            ))}
            {otherDeliveryWorkers.length > 3 && (
              <span className="font-mono text-[10px] text-zinc-400">
                +{otherDeliveryWorkers.length - 3} more
              </span>
            )}
          </div>
        )}

        {/* Pending Offline Scans Indicator */}
        {rtState.pendingOfflineScansCount > 0 && (
          <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[3px] bg-amber-950/90 border border-amber-600/70 text-amber-300 font-mono text-[10px]">
            <Clock className="w-3 h-3 text-amber-400 animate-spin" />
            <span>{rtState.pendingOfflineScansCount} Pending Sync</span>
          </div>
        )}
      </div>

      {/* Live Coworker Activity Toast */}
      {liveNotice ? (
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-[3px] bg-emerald-950/90 border border-emerald-600/60 text-emerald-200 font-mono text-[10px] truncate max-w-[55%] sm:max-w-[360px]">
          {liveNotice.type === 'docket' ? (
            <FileUp className="w-3 h-3 text-emerald-400 shrink-0" />
          ) : (
            <ScanLine className="w-3 h-3 text-emerald-400 shrink-0" />
          )}
          <span className="font-bold text-emerald-300 shrink-0">{liveNotice.actor}</span>
          <span className="truncate">{liveNotice.message}</span>
        </div>
      ) : activelyScanningWorkers.length > 0 ? (
        <div className="hidden sm:flex items-center gap-1 text-emerald-400 font-mono text-[10px]">
          <ScanLine className="w-3 h-3 animate-pulse" />
          <span>
            {activelyScanningWorkers.map((w: WorkerPresence) => w.employeeName).join(', ')} scanning live
          </span>
        </div>
      ) : null}
    </div>
  );
};
