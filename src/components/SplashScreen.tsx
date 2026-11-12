import React, { useEffect, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { BRANDING } from '../config/branding';

interface SplashScreenProps {
  isReady: boolean;
  error?: string | null;
  onRetry?: () => void;
  onTransitionComplete?: () => void;
}

/**
 * PartTrack Startup / Splash Screen
 * Uses the user-supplied PartTrack startup reference artwork (/parttrack-splash.jpg):
 * - Dark industrial background with laser cutting machine, sparks, and purple illumination
 * - Central PartTrack 3-layer geometric logo & wordmark
 * - Tagline: PARTS • DOCKETS • SHIPMENTS • VERIFICATION
 * - Proportional display without stretching across mobile & desktop screens
 * - No loading bar, no percentage indicator, no unnecessary loading text, no extra buttons
 */
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
      const splashTimer = setTimeout(() => {
        setIsFadingOut(true);
        const exitTimer = setTimeout(() => {
          setIsMounted(false);
          onTransitionComplete?.();
        }, 380);
        return () => clearTimeout(exitTimer);
      }, 1500);

      return () => clearTimeout(splashTimer);
    }
  }, [isReady, error, onTransitionComplete]);

  if (!isMounted) return null;

  return (
    <div
      aria-label="PartTrack Startup"
      className={`fixed inset-0 z-[9999] flex items-center justify-center bg-[#080B12] text-white select-none overflow-hidden transition-opacity duration-400 ease-out ${
        isFadingOut ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
      style={{
        background:
          'radial-gradient(circle at 50% 45%, #160C28 0%, #080B12 65%, #040509 100%)',
      }}
    >
      {/* Subtle ambient purple industrial glow behind the proportional startup artwork */}
      <div
        className="absolute w-[420px] h-[420px] sm:w-[640px] sm:h-[640px] rounded-full blur-[130px] pointer-events-none opacity-45"
        style={{
          background:
            'radial-gradient(circle, rgba(160, 32, 240, 0.45) 0%, rgba(107, 33, 168, 0.18) 60%, transparent 80%)',
        }}
      />

      {/* Proportional Startup Reference Artwork Container (never stretched) */}
      <div className="relative z-10 w-full h-full max-w-[560px] flex items-center justify-center">
        <img
          src={BRANDING.splashImagePath}
          alt={`${BRANDING.appName} — ${BRANDING.tagline}`}
          className="w-full h-full object-contain object-center select-none pointer-events-none"
          draggable={false}
        />
      </div>

      {/* Only render error recovery overlay if a fatal storage/database init error occurred */}
      {error && (
        <div className="absolute bottom-8 inset-x-4 z-20 flex justify-center">
          <div className="flex flex-col items-center gap-2.5 p-4 rounded-xl bg-[#15182A]/95 border border-[#EF4444]/50 text-red-200 text-xs max-w-xs shadow-2xl backdrop-blur-md">
            <div className="flex items-center gap-2 text-[#EF4444] font-bold">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>Workspace Initialisation Issue</span>
            </div>
            <p className="text-[11px] text-slate-300 text-center leading-relaxed">{error}</p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="mt-1 h-9 px-4 rounded-lg pt-btn-primary font-mono font-bold text-[11px] tracking-wider uppercase inline-flex items-center gap-1.5 cursor-pointer transition-all"
              >
                <RefreshCw className="w-3.5 h-3.5 stroke-[2.5]" />
                <span>Retry</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
