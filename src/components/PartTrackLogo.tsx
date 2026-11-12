import React from 'react';
import { BRANDING } from '../config/branding';

interface PartTrackLogoProps {
  /** Visual lockup style */
  variant?: 'horizontal' | 'compact' | 'stacked' | 'icon-only';
  /** Size preset */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  /** Whether to show the official tagline PARTS • DOCKETS • SHIPMENTS • VERIFICATION */
  showTagline?: boolean;
  /** Optional extra classes */
  className?: string;
}

/**
 * Vector 3-Layer Geometric Stacked Diamond / Chevron Mark
 * Matches the supplied PartTrack reference logo & icon and adapts dynamically to active theme
 */
export const PartTrackGeometricIcon: React.FC<{ className?: string }> = ({
  className = 'w-7 h-7',
}) => (
  <svg
    viewBox="0 0 120 120"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    <defs>
      <linearGradient id="ptIconTopGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="var(--pt-accent-secondary, #E879F9)" />
        <stop offset="50%" stopColor="var(--pt-primary-light, #C084FC)" />
        <stop offset="100%" stopColor="var(--pt-primary, #A020F0)" />
      </linearGradient>
      <linearGradient id="ptIconMidGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="var(--pt-accent-secondary, #C084FC)" />
        <stop offset="100%" stopColor="var(--pt-primary, #A020F0)" />
      </linearGradient>
      <linearGradient id="ptIconBotGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="var(--pt-primary, #A020F0)" />
        <stop offset="100%" stopColor="var(--pt-primary-deep, #6B21A8)" />
      </linearGradient>
    </defs>
    {/* Top Diamond Ring */}
    <path
      d="M60 12 L106 38 L60 64 L14 38 Z M60 25 L31 38 L60 51 L89 38 Z"
      fill="url(#ptIconTopGrad)"
      fillRule="evenodd"
    />
    {/* Middle Stacked Chevron */}
    <path
      d="M14 53 L60 79 L106 53 L106 66 L60 92 L14 66 Z"
      fill="url(#ptIconMidGrad)"
    />
    {/* Bottom Stacked Chevron */}
    <path
      d="M14 74 L60 100 L106 74 L106 87 L60 113 L14 87 Z"
      fill="url(#ptIconBotGrad)"
    />
  </svg>
);

export const PartTrackLogo: React.FC<PartTrackLogoProps> = ({
  variant = 'horizontal',
  size = 'md',
  showTagline = false,
  className = '',
}) => {
  const iconSizes = {
    xs: 'w-6 h-6',
    sm: 'w-7 h-7',
    md: 'w-9 h-9',
    lg: 'w-12 h-12',
    xl: 'w-16 h-16',
  };

  const textSizes = {
    xs: 'text-sm',
    sm: 'text-base',
    md: 'text-lg',
    lg: 'text-2xl',
    xl: 'text-3xl sm:text-4xl',
  };

  if (variant === 'icon-only') {
    return (
      <div
        className={`relative rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] shadow-[0_0_16px_var(--pt-glow,rgba(160,32,240,0.35))] flex items-center justify-center p-1 shrink-0 ${iconSizes[size]} ${className}`}
      >
        <PartTrackGeometricIcon className="w-full h-full" />
      </div>
    );
  }

  if (variant === 'stacked') {
    return (
      <div className={`flex flex-col items-center text-center select-none ${className}`}>
        <div className="relative mb-2 flex items-center justify-center">
          <div
            className="absolute -inset-2 rounded-full blur-xl opacity-60 pointer-events-none"
            style={{ background: 'var(--pt-glow, rgba(160, 32, 240, 0.4))' }}
          />
          <PartTrackGeometricIcon className={iconSizes[size]} />
        </div>
        <div
          className={`font-extrabold italic tracking-tight leading-none font-sans ${textSizes[size]}`}
        >
          <span className="text-[var(--pt-text,#FFFFFF)]">Part</span>
          <span
            className="bg-clip-text text-transparent"
            style={{
              backgroundImage:
                'linear-gradient(135deg, var(--pt-accent-secondary, #C084FC) 0%, var(--pt-primary, #A020F0) 100%)',
            }}
          >
            Track
          </span>
        </div>
        {showTagline && (
          <div className="mt-1.5 font-mono text-[9px] sm:text-[10px] font-bold tracking-[0.22em] text-[var(--pt-text,#FFFFFF)]/90 uppercase flex items-center justify-center gap-1.5 flex-wrap">
            <span>PARTS</span>
            <span style={{ color: 'var(--pt-primary, #A020F0)' }}>•</span>
            <span>DOCKETS</span>
            <span style={{ color: 'var(--pt-primary, #A020F0)' }}>•</span>
            <span>SHIPMENTS</span>
            <span style={{ color: 'var(--pt-primary, #A020F0)' }}>•</span>
            <span>VERIFICATION</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`inline-flex items-center gap-2.5 select-none ${className}`}>
      <div
        className={`relative rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] shadow-[0_0_14px_var(--pt-glow,rgba(160,32,240,0.3))] flex items-center justify-center p-1 shrink-0 ${iconSizes[size]}`}
      >
        <PartTrackGeometricIcon className="w-full h-full" />
      </div>

      <div className="flex flex-col justify-center min-w-0">
        <div
          className={`font-extrabold italic tracking-tight leading-none font-sans flex items-center ${textSizes[size]}`}
        >
          <span className="text-[var(--pt-text,#FFFFFF)]">Part</span>
          <span
            className="bg-clip-text text-transparent pr-0.5"
            style={{
              backgroundImage:
                'linear-gradient(135deg, var(--pt-accent-secondary, #C084FC) 0%, var(--pt-primary, #A020F0) 100%)',
            }}
          >
            Track
          </span>
        </div>

        {showTagline && (
          <div className="mt-1 font-mono text-[8px] sm:text-[9px] font-bold tracking-[0.16em] text-[var(--pt-text-secondary,#A3A8BD)] uppercase truncate">
            {BRANDING.tagline}
          </div>
        )}
      </div>
    </div>
  );
};

export default PartTrackLogo;
