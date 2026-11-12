import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Lock,
  Delete,
  AlertTriangle,
  ArrowRight,
  ShieldAlert,
  Server,
  Loader2,
  User,
  KeyRound,
  RotateCcw,
} from 'lucide-react';
import { apiLogin, getStoredUser } from '../services/palletTrackApi';
import { UserAccount } from '../types/delivery';
import { BRANDING } from '../config/branding';
import { PartTrackLogo } from './PartTrackLogo';

interface LoginViewProps {
  onLoginSuccess: (user: UserAccount) => void;
  onOpenSetupAdmin?: () => void;
  hasAdmin: boolean;
}

export const LoginView: React.FC<LoginViewProps> = ({
  onLoginSuccess,
  onOpenSetupAdmin,
  hasAdmin,
}) => {
  const [employeeCode, setEmployeeCode] = useState<string>(() => {
    const lastUser = getStoredUser();
    return lastUser?.employeeCode || '';
  });
  const [pin, setPin] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLocked, setIsLocked] = useState<boolean>(false);
  const [lockoutRemainingSeconds, setLockoutRemainingSeconds] = useState<number>(0);

  const codeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!employeeCode) {
      codeInputRef.current?.focus();
    }
  }, [employeeCode]);

  useEffect(() => {
    if (!isLocked || lockoutRemainingSeconds <= 0) return;
    const timer = setInterval(() => {
      setLockoutRemainingSeconds((prev) => {
        if (prev <= 1) {
          setIsLocked(false);
          setErrorMessage(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isLocked, lockoutRemainingSeconds]);

  const handleLogin = useCallback(
    async (codeToUse?: string, pinToUse?: string) => {
      const code = (codeToUse !== undefined ? codeToUse : employeeCode).trim().toUpperCase();
      const currentPin = pinToUse !== undefined ? pinToUse : pin;

      if (!code) {
        setErrorMessage('Please enter your Employee Identifier');
        codeInputRef.current?.focus();
        return;
      }

      if (currentPin.length !== 4) {
        setErrorMessage('PIN must be exactly 4 digits');
        return;
      }

      if (isLocked) {
        return;
      }

      setIsLoading(true);
      setErrorMessage(null);

      try {
        const response = await apiLogin(code, currentPin);
        onLoginSuccess(response.user);
      } catch (err: any) {
        const msg = err?.message || 'Invalid employee identifier or PIN';
        setPin('');

        if (err.code === 'ACCOUNT_LOCKED' || msg.includes('locked')) {
          setIsLocked(true);
          setLockoutRemainingSeconds(15 * 60);
          setErrorMessage(msg);
        } else {
          setErrorMessage(msg);
        }
      } finally {
        setIsLoading(false);
      }
    },
    [employeeCode, pin, isLocked, onLoginSuccess]
  );

  const handleDigitPress = (digit: string) => {
    if (isLoading || isLocked) return;
    if (pin.length < 4) {
      const nextPin = pin + digit;
      setPin(nextPin);
      setErrorMessage(null);
      if (nextPin.length === 4 && employeeCode.trim()) {
        handleLogin(employeeCode, nextPin);
      }
    }
  };

  const handleBackspace = () => {
    if (isLoading || isLocked) return;
    setPin((prev) => prev.slice(0, -1));
    setErrorMessage(null);
  };

  const handleClearPin = () => {
    if (isLoading || isLocked) return;
    setPin('');
    setErrorMessage(null);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement === codeInputRef.current) {
        if (e.key === 'Enter') {
          e.preventDefault();
          codeInputRef.current?.blur();
        }
        return;
      }

      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        handleDigitPress(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        handleBackspace();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleClearPin();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (pin.length === 4) {
          handleLogin();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pin, employeeCode, isLoading, isLocked, handleLogin]);

  const formatLockoutTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="min-h-dvh w-full bg-[var(--pt-bg,#080B12)] text-white flex flex-col justify-between p-4 sm:p-6 selection:bg-[var(--pt-primary,#A020F0)]/30">
      {/* Top Header / Branding */}
      <div className="w-full max-w-sm mx-auto flex items-center justify-between pt-2">
        <PartTrackLogo size="sm" showTagline />

        <div className="flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-0.5 rounded-full bg-[#00D979]/15 border border-[#00D979]/40 text-[#00D979]">
          <span className="w-1.5 h-1.5 rounded-full bg-[#00D979] animate-pulse" />
          <span>D1 Online</span>
        </div>
      </div>

      {/* Main Login Card */}
      <div className="w-full max-w-sm mx-auto my-auto py-4">
        {/* First-time Setup Prompt if no Super Admin exists */}
        {!hasAdmin && (
          <div className="mb-4 p-4 rounded-2xl bg-[#F59E0B]/15 border border-[#F59E0B]/40 text-amber-200">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#F59E0B] mb-1">
              <ShieldAlert className="w-4 h-4" />
              Initial Super Admin Setup Required
            </div>
            <p className="text-xs text-amber-200/90 leading-relaxed mb-3">
              No Super Admin account exists yet. Complete one-time provisioning to create the initial Super Admin and unlock multi-admin RBAC.
            </p>
            <button
              onClick={onOpenSetupAdmin}
              className="w-full py-2.5 px-3 rounded-xl bg-[#F59E0B] hover:bg-amber-400 text-black font-mono font-bold text-xs uppercase tracking-wider transition-colors cursor-pointer flex items-center justify-center gap-1.5"
            >
              <span>Setup Initial Super Admin</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Lockout Banner */}
        {isLocked && (
          <div className="mb-4 p-4 rounded-2xl bg-[#EF4444]/15 border border-[#EF4444]/50 text-red-200 animate-pulse">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#EF4444] mb-1">
              <AlertTriangle className="w-4 h-4" />
              Terminal Account Locked
            </div>
            <p className="text-xs text-red-200/90 leading-relaxed">
              Exceeded 5 consecutive failed login attempts. Account access is temporarily suspended for security.
            </p>
            <div className="mt-2 text-lg font-mono font-bold text-[#EF4444]">
              Unlock in: {formatLockoutTime(lockoutRemainingSeconds)}
            </div>
          </div>
        )}

        {/* Credentials Form Box */}
        <div className="bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] rounded-2xl p-5 shadow-2xl">
          {/* Employee Identifier Input */}
          <div className="mb-4">
            <label className="block text-[11px] font-mono uppercase tracking-wider text-[var(--pt-text-secondary,#A3A8BD)] mb-1.5">
              Employee Identifier
            </label>
            <div className="relative">
              <input
                ref={codeInputRef}
                type="text"
                value={employeeCode}
                onChange={(e) => {
                  setEmployeeCode(e.target.value.toUpperCase());
                  setErrorMessage(null);
                }}
                disabled={isLoading || isLocked}
                placeholder="e.g. EMP-101 or ADMIN-01"
                className="w-full px-3.5 py-2.5 bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] rounded-xl text-white font-mono text-sm tracking-wider uppercase focus:outline-none focus:border-[var(--pt-primary,#A020F0)] transition-all placeholder:text-[var(--pt-text-muted,#737B94)] disabled:opacity-50"
              />
              <User className="absolute right-3 top-3 w-4 h-4 text-[var(--pt-text-muted,#737B94)] pointer-events-none" />
            </div>
          </div>

          {/* 4-Digit PIN Status Display */}
          <div className="mb-5">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-mono uppercase tracking-wider text-[var(--pt-text-secondary,#A3A8BD)] flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)]" />
                4-Digit Security PIN
              </label>
              {pin.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearPin}
                  className="text-[10px] font-mono text-[var(--pt-primary-light,#C084FC)] hover:underline cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>

            {/* 4 PIN Dots / Digit Boxes */}
            <div className="grid grid-cols-4 gap-2.5 h-12">
              {[0, 1, 2, 3].map((index) => {
                const isFilled = pin.length > index;
                const isCurrent = pin.length === index;
                return (
                  <div
                    key={index}
                    className={`rounded-xl flex items-center justify-center transition-all ${
                      isFilled
                        ? 'bg-[var(--pt-primary,#A020F0)]/20 border-2 border-[var(--pt-primary-light,#C084FC)] shadow-[0_0_12px_var(--pt-glow,rgba(160,32,240,0.4))]'
                        : isCurrent
                        ? 'bg-[var(--pt-bg,#080B12)] border-2 border-[var(--pt-primary,#A020F0)]/60'
                        : 'bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)]'
                    }`}
                  >
                    {isFilled ? (
                      <div
                        className="w-3.5 h-3.5 rounded-full"
                        style={{
                          backgroundColor: 'var(--pt-primary-light, #C084FC)',
                          boxShadow: '0 0 8px var(--pt-primary, #A020F0)',
                        }}
                      />
                    ) : (
                      <span className="text-[var(--pt-text-muted,#737B94)] text-xs font-mono">
                        •
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Error Message */}
          {errorMessage && !isLocked && (
            <div className="mb-4 p-3 rounded-xl bg-[#EF4444]/15 border border-[#EF4444]/40 text-red-200 text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-[#EF4444]" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Touchscreen Numeric Keypad */}
          <div className="grid grid-cols-3 gap-2 mb-4">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
              <button
                key={digit}
                type="button"
                onClick={() => handleDigitPress(digit)}
                disabled={isLoading || isLocked}
                className="h-12 rounded-xl bg-[var(--pt-bg,#080B12)] hover:bg-[var(--pt-bg-secondary,#101321)] active:scale-95 border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)]/50 text-white text-lg font-mono font-bold transition-all cursor-pointer shadow-sm disabled:opacity-40"
              >
                {digit}
              </button>
            ))}
            <button
              type="button"
              onClick={handleClearPin}
              disabled={isLoading || isLocked || pin.length === 0}
              className="h-12 rounded-xl bg-[var(--pt-bg,#080B12)] hover:bg-[var(--pt-bg-secondary,#101321)] active:scale-95 border border-[var(--pt-border,#29243D)] text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white text-xs font-mono uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center disabled:opacity-30"
              title="Clear PIN"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => handleDigitPress('0')}
              disabled={isLoading || isLocked}
              className="h-12 rounded-xl bg-[var(--pt-bg,#080B12)] hover:bg-[var(--pt-bg-secondary,#101321)] active:scale-95 border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)]/50 text-white text-lg font-mono font-bold transition-all cursor-pointer shadow-sm disabled:opacity-40"
            >
              0
            </button>
            <button
              type="button"
              onClick={handleBackspace}
              disabled={isLoading || isLocked || pin.length === 0}
              className="h-12 rounded-xl bg-[var(--pt-bg,#080B12)] hover:bg-[var(--pt-bg-secondary,#101321)] active:scale-95 border border-[var(--pt-border,#29243D)] text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white text-xs font-mono uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center disabled:opacity-30"
              title="Backspace"
            >
              <Delete className="w-5 h-5" />
            </button>
          </div>

          {/* Explicit Sign In Button */}
          <button
            type="button"
            onClick={() => handleLogin()}
            disabled={isLoading || isLocked || !employeeCode.trim() || pin.length !== 4}
            className="w-full py-3 rounded-xl pt-btn-primary text-white font-bold font-mono text-sm uppercase tracking-wider transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin text-white" />
                <span>Verifying PIN...</span>
              </>
            ) : (
              <>
                <Lock className="w-4 h-4" />
                <span>Sign In Terminal</span>
              </>
            )}
          </button>

          {/* Quick Terminal Access (One-Tap Preview / Workshop Role Switcher) */}
          {hasAdmin && (
            <div className="mt-4 pt-3.5 border-t border-[var(--pt-border,#29243D)]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--pt-text-secondary,#A3A8BD)]">
                  Quick Terminal Access (1-Tap Login)
                </span>
                <span className="text-[9px] font-mono text-[var(--pt-primary-light,#C084FC)]">
                  Auto-fills ID &amp; PIN
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {[
                  {
                    code: 'SUPER-01',
                    pin: '1234',
                    label: 'Super Admin',
                    badgeClass:
                      'border-[#F59E0B]/40 text-[#F59E0B] hover:bg-amber-950/40',
                  },
                  {
                    code: 'ADMIN-01',
                    pin: '1111',
                    label: 'Admin',
                    badgeClass:
                      'border-[#A020F0]/50 text-[#C084FC] hover:bg-purple-950/40',
                  },
                  {
                    code: 'SUP-01',
                    pin: '2222',
                    label: 'Supervisor',
                    badgeClass:
                      'border-[#078BFF]/40 text-[#38BDF8] hover:bg-sky-950/40',
                  },
                  {
                    code: 'EMP-01',
                    pin: '3333',
                    label: 'Operator',
                    badgeClass:
                      'border-[#00D979]/40 text-[#00D979] hover:bg-emerald-950/40',
                  },
                ].map((acct) => (
                  <button
                    key={acct.code}
                    type="button"
                    disabled={isLoading || isLocked}
                    onClick={() => {
                      setEmployeeCode(acct.code);
                      setPin(acct.pin);
                      setErrorMessage(null);
                      handleLogin(acct.code, acct.pin);
                    }}
                    className={`px-2.5 py-1.5 rounded-lg bg-[var(--pt-bg,#080B12)] border ${acct.badgeClass} transition-all cursor-pointer flex items-center justify-between text-left disabled:opacity-40`}
                  >
                    <div>
                      <div className="text-[11px] font-mono font-bold text-white leading-tight">
                        {acct.code}
                      </div>
                      <div className="text-[9px] font-mono opacity-85">{acct.label}</div>
                    </div>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/5 text-slate-300">
                      PIN {acct.pin}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Roles information help */}
        <div className="mt-4 text-center">
          <p className="text-[11px] text-[var(--pt-text-muted,#737B94)] font-mono">
            {BRANDING.tagline}
          </p>
        </div>
      </div>

      {/* Footer Info */}
      <div className="w-full max-w-sm mx-auto text-center pb-2 text-[10px] text-[var(--pt-text-muted,#737B94)] font-mono flex items-center justify-between">
        <span>{BRANDING.versionLabel}</span>
        <span className="flex items-center gap-1">
          <Server className="w-3 h-3" />
          Multi-User D1 Auth
        </span>
      </div>
    </div>
  );
};
