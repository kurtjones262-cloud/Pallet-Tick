import React, { useEffect, useState } from 'react';
import { WifiOff, RefreshCw, Database } from 'lucide-react';
import {
  subscribeToBackendHealth,
  checkBackendConnection,
  BackendHealth,
} from '../services/palletTrackApi.ts';

export const ConnectionStatusBar: React.FC = () => {
  const [health, setHealth] = useState<BackendHealth>({ connected: true });
  const [isChecking, setIsChecking] = useState(false);

  useEffect(() => {
    // Initial health check
    checkBackendConnection().catch(() => {});

    // Periodic health poll every 10 seconds
    const interval = setInterval(() => {
      checkBackendConnection().catch(() => {});
    }, 10000);

    const unsubscribe = subscribeToBackendHealth(setHealth);

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
      unsubscribe();
      window.removeEventListener('online', handleWindowOnline);
      window.removeEventListener('offline', handleWindowOffline);
    };
  }, []);

  const handleRetry = async () => {
    setIsChecking(true);
    try {
      await checkBackendConnection();
    } finally {
      setIsChecking(false);
    }
  };

  // If connected, show nothing or minimal clean indicator
  if (health.connected) {
    return null;
  }

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
            Receiving paused. Online connection to central database is required.
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
};
