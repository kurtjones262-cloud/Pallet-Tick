import React, { useEffect, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

interface SplashScreenProps {
  isReady: boolean;
  error?: string | null;
  onRetry?: () => void;
  onTransitionComplete?: () => void;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({
  isReady,
  error = null,
  onRetry,
  onTransitionComplete,
}) => {
  const [isFadingOut, setIsFadingOut] = useState(false);
  const [isMounted, setIsMounted] = useState(true);

  useEffect(() => {
    if (isReady && !error) {
      // Display the splash screen first for 2 full seconds (2000ms)
      const splashTimer = setTimeout(() => {
        setIsFadingOut(true);
        const exitTimer = setTimeout(() => {
          setIsMounted(false);
          onTransitionComplete?.();
        }, 400); // 400ms smooth fade-out transition
        return () => clearTimeout(exitTimer);
      }, 2000); // 2 seconds startup display duration

      return () => clearTimeout(splashTimer);
    }
  }, [isReady, error, onTransitionComplete]);

  if (!isMounted) return null;

  return (
    <div
      aria-label="PalletTick Startup"
      className={`fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[#070A0F] text-white select-none transition-opacity duration-400 ease-out ${
        isFadingOut ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
      style={{
        background:
          'radial-gradient(circle at 50% 45%, #0D1624 0%, #070A0F 70%, #030508 100%)',
      }}
    >
      {/* Background ambient electric-blue neon glow */}
      <div
        className="absolute w-[360px] h-[360px] sm:w-[480px] sm:h-[480px] rounded-full blur-[110px] pointer-events-none opacity-40 animate-pulse"
        style={{
          background: 'radial-gradient(circle, rgba(0, 168, 255, 0.45) 0%, rgba(0, 100, 220, 0.15) 60%, transparent 80%)',
        }}
      />

      {/* Main Brand Content Container with smooth fade-in */}
      <div className="relative z-10 flex flex-col items-center px-6 max-w-sm text-center animate-fade-in">
        {/* Official Square PalletTick Icon with Electric Blue Neon Border & Glow */}
        <div className="relative mb-6 group">
          {/* Subtle Outer Neon Pulse Glow */}
          <div className="absolute -inset-1.5 rounded-[28px] bg-gradient-to-b from-cyan-400/40 via-blue-500/20 to-transparent blur-md opacity-75 animate-pulse-glow pointer-events-none" />

          {/* Icon Frame */}
          <div className="relative w-40 h-40 sm:w-48 sm:h-48 rounded-[24px] overflow-hidden bg-black shadow-[0_0_40px_rgba(0,168,255,0.35)] border border-cyan-400/30">
            <img
              src="/pallettrack-icon.png"
              alt="PalletTick"
              className="w-full h-full object-cover"
              draggable={false}
            />

            {/* Subtle Animated Barcode Scanning Laser Beam sweeping across the barcode area */}
            <div className="absolute inset-x-2 pointer-events-none animate-barcode-scan">
              <div className="h-[2px] w-full bg-gradient-to-r from-transparent via-cyan-300 to-transparent shadow-[0_0_12px_#00d2ff,0_0_24px_#0088ff]" />
              <div className="h-4 -mt-2 w-full bg-gradient-to-b from-cyan-400/15 to-transparent blur-xs" />
            </div>
          </div>
        </div>

        {/* Brand Tagline */}
        <p className="font-mono text-[11px] sm:text-xs font-bold tracking-[0.28em] text-cyan-400 uppercase drop-shadow-[0_0_10px_rgba(6,182,212,0.6)] mb-5">
          SCAN. TRACK. DELIVER.
        </p>

        {/* Initialisation Loading State vs. Error State */}
        {error ? (
          <div className="flex flex-col items-center gap-3 p-3.5 rounded-[6px] bg-red-950/60 border border-red-500/40 text-red-200 text-xs max-w-xs animate-shake">
            <div className="flex items-center gap-2 text-red-400 font-semibold">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
              <span>Workspace Initialisation Issue</span>
            </div>
            <p className="text-[11px] text-red-300/90 leading-relaxed">{error}</p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="mt-1 h-8 px-4 rounded-[4px] bg-cyan-500 hover:bg-cyan-400 text-black font-mono font-bold text-[11px] tracking-wider uppercase inline-flex items-center gap-1.5 cursor-pointer shadow-[0_0_15px_rgba(6,182,212,0.5)] transition-all"
              >
                <RefreshCw className="w-3.5 h-3.5 stroke-[2.5]" />
                <span>Retry</span>
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2.5 text-zinc-400">
            {/* Small Animated Electric-Blue Loading Indicator */}
            <div className="w-4 h-4 rounded-full border-2 border-cyan-500/25 border-t-cyan-400 animate-spin shrink-0 shadow-[0_0_8px_rgba(6,182,212,0.5)]" />
            <span className="font-mono text-xs text-zinc-400 tracking-wide font-medium">
              Preparing your workspace...
            </span>
          </div>
        )}
      </div>

      {/* Subtle version/build watermark at bottom */}
      <div className="absolute bottom-4 inset-x-0 text-center pointer-events-none">
        <span className="font-mono text-[10px] text-zinc-500 tracking-widest uppercase">
          PalletTrack · Base Offline Version
        </span>
      </div>
    </div>
  );
};
