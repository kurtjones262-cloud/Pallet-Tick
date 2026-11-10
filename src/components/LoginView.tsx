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

  // Focus employee code on mount if empty
  useEffect(() => {
    if (!employeeCode) {
      codeInputRef.current?.focus();
    }
  }, [employeeCode]);

  // Lockout countdown timer
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
          setLockoutRemainingSeconds(15 * 60); // 15 minutes lockout
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

  // Number key press handler
  const handleDigitPress = (digit: string) => {
    if (isLoading || isLocked) return;
    if (pin.length < 4) {
      const nextPin = pin + digit;
      setPin(nextPin);
      setErrorMessage(null);
      // Auto-submit when 4th digit is entered
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

  // Keyboard listener for physical keyboard & barcode scanner entry
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture when typing inside the employee code text input
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
    <div className="min-h-dvh w-full bg-[#070A0F] text-slate-100 flex flex-col justify-between p-4 sm:p-6 selection:bg-cyan-500/20">
      {/* Top Header / Branding */}
      <div className="w-full max-w-sm mx-auto flex items-center justify-between pt-2">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg overflow-hidden bg-black border border-cyan-500/30 shadow-[0_0_12px_rgba(0,168,255,0.3)]">
            <img
              src="/pallettrack-icon.png"
              alt="PalletTrack"
              className="w-full h-full object-cover"
            />
          </div>
          <div>
            <div className="text-sm font-bold tracking-tight text-white font-mono flex items-center gap-1.5">
              PALLETTRACK
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-950/80 border border-cyan-500/30 text-cyan-400 font-sans font-semibold">
                PHASE 2
              </span>
            </div>
            <div className="text-[10px] text-slate-400 tracking-wider uppercase font-mono">
              Workshop Terminal Access
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 text-[11px] font-mono px-2 py-0.5 rounded-full bg-emerald-950/50 border border-emerald-500/30 text-emerald-400">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span>D1 Online</span>
        </div>
      </div>

      {/* Main Login Card */}
      <div className="w-full max-w-sm mx-auto my-auto py-4">
        {/* First-time Setup Prompt if no Super Admin exists */}
        {!hasAdmin && (
          <div className="mb-4 p-4 rounded-xl bg-amber-950/40 border border-amber-500/40 text-amber-200">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-amber-300 mb-1">
              <ShieldAlert className="w-4 h-4" />
              Initial Super Admin Setup Required
            </div>
            <p className="text-xs text-amber-200/90 leading-relaxed mb-3">
              No Super Admin account exists yet. Complete one-time provisioning to create the initial Super Admin and unlock multi-admin RBAC.
            </p>
            <button
              onClick={onOpenSetupAdmin}
              className="w-full py-2 px-3 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-bold text-xs uppercase tracking-wider transition-colors cursor-pointer flex items-center justify-center gap-1.5"
            >
              <span>Setup Initial Super Admin</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Lockout Banner */}
        {isLocked && (
          <div className="mb-4 p-4 rounded-xl bg-rose-950/60 border border-rose-500/50 text-rose-200 animate-pulse">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-rose-400 mb-1">
              <AlertTriangle className="w-4 h-4" />
              Terminal Account Locked
            </div>
            <p className="text-xs text-rose-200/90 leading-relaxed">
              Exceeded 5 consecutive failed login attempts. Account access is temporarily suspended for security.
            </p>
            <div className="mt-2 text-lg font-mono font-bold text-rose-300">
              Unlock in: {formatLockoutTime(lockoutRemainingSeconds)}
            </div>
          </div>
        )}

        {/* Credentials Form Box */}
        <div className="bg-[#0E1626]/90 border border-[#1E2D44] rounded-2xl p-5 shadow-2xl backdrop-blur-md">
          {/* Employee Identifier Input */}
          <div className="mb-4">
            <label className="block text-[11px] font-mono uppercase tracking-wider text-slate-400 mb-1.5">
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
                className="w-full px-3.5 py-2.5 bg-[#070A0F] border border-[#1E2D44] rounded-xl text-white font-mono text-sm tracking-wider uppercase focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/50 transition-all placeholder:text-slate-600 disabled:opacity-50"
              />
              <User className="absolute right-3 top-3 w-4 h-4 text-slate-500 pointer-events-none" />
            </div>
          </div>

          {/* 4-Digit PIN Status Display */}
          <div className="mb-5">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-mono uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5 text-cyan-400" />
                4-Digit Security PIN
              </label>
              {pin.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearPin}
                  className="text-[10px] font-mono text-cyan-400 hover:text-cyan-300 cursor-pointer"
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
                        ? 'bg-cyan-500/20 border-2 border-cyan-400 shadow-[0_0_12px_rgba(0,168,255,0.4)]'
                        : isCurrent
                        ? 'bg-[#070A0F] border-2 border-cyan-500/60'
                        : 'bg-[#070A0F] border border-[#1E2D44]'
                    }`}
                  >
                    {isFilled ? (
                      <div className="w-3.5 h-3.5 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(0,168,255,0.8)]" />
                    ) : (
                      <span className="text-slate-700 text-xs font-mono">•</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Error Message */}
          {errorMessage && !isLocked && (
            <div className="mb-4 p-3 rounded-xl bg-rose-950/40 border border-rose-500/40 text-rose-300 text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
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
                className="h-12 rounded-xl bg-[#070A0F] hover:bg-[#141D30] active:scale-95 border border-[#1E2D44] hover:border-cyan-500/40 text-white text-lg font-mono font-bold transition-all cursor-pointer shadow-sm disabled:opacity-40"
              >
                {digit}
              </button>
            ))}
            <button
              type="button"
              onClick={handleClearPin}
              disabled={isLoading || isLocked || pin.length === 0}
              className="h-12 rounded-xl bg-[#070A0F] hover:bg-[#141D30] active:scale-95 border border-[#1E2D44] hover:border-slate-500 text-slate-400 hover:text-slate-200 text-xs font-mono uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center disabled:opacity-30"
              title="Clear PIN"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => handleDigitPress('0')}
              disabled={isLoading || isLocked}
              className="h-12 rounded-xl bg-[#070A0F] hover:bg-[#141D30] active:scale-95 border border-[#1E2D44] hover:border-cyan-500/40 text-white text-lg font-mono font-bold transition-all cursor-pointer shadow-sm disabled:opacity-40"
            >
              0
            </button>
            <button
              type="button"
              onClick={handleBackspace}
              disabled={isLoading || isLocked || pin.length === 0}
              className="h-12 rounded-xl bg-[#070A0F] hover:bg-[#141D30] active:scale-95 border border-[#1E2D44] hover:border-slate-500 text-slate-400 hover:text-slate-200 text-xs font-mono uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center disabled:opacity-30"
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
            className="w-full py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-sky-500 hover:from-cyan-400 hover:to-sky-400 text-black font-bold font-mono text-sm uppercase tracking-wider shadow-[0_0_20px_rgba(0,168,255,0.4)] transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin text-black" />
                <span>Verifying PIN...</span>
              </>
            ) : (
              <>
                <Lock className="w-4 h-4" />
                <span>Sign In Terminal</span>
              </>
            )}
          </button>
        </div>

        {/* Roles information help */}
        <div className="mt-4 text-center">
          <p className="text-[11px] text-slate-500 font-mono">
            Fast 4-digit PIN authentication for workshop terminals
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 mt-2 text-[10px] font-mono text-slate-400">
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Super Admin
            </span>
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" /> Admin
            </span>
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" /> Supervisor
            </span>
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Employee
            </span>
          </div>
        </div>
      </div>

      {/* Footer Info */}
      <div className="w-full max-w-sm mx-auto text-center pb-2 text-[10px] text-slate-600 font-mono flex items-center justify-between">
        <span>PalletTrack v2.0-RBAC</span>
        <span className="flex items-center gap-1 text-slate-500">
          <Server className="w-3 h-3 text-slate-500" />
          Multi-User D1 Auth
        </span>
      </div>
    </div>
  );
};
