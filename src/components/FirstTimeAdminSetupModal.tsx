import React, { useState } from 'react';
import {
  ShieldAlert,
  Lock,
  User,
  BadgeCheck,
  AlertTriangle,
  Loader2,
  X,
  KeyRound,
} from 'lucide-react';
import { apiSetupAdmin } from '../services/palletTrackApi';
import { UserAccount } from '../types/delivery';

interface FirstTimeAdminSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (adminUser: UserAccount) => void;
}

export const FirstTimeAdminSetupModal: React.FC<FirstTimeAdminSetupModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [employeeName, setEmployeeName] = useState('Operations Super Admin');
  const [employeeCode, setEmployeeCode] = useState('SUPER-01');
  const [setupSecret, setSetupSecret] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const name = employeeName.trim();
    const code = employeeCode.trim().toUpperCase();
    const cleanPin = pin.trim();
    const secret = setupSecret.trim();

    if (!name) {
      setErrorMessage('Super Admin name is required');
      return;
    }
    if (!code) {
      setErrorMessage('Employee identifier is required');
      return;
    }
    if (!secret) {
      setErrorMessage('One-time setup secret is required');
      return;
    }
    if (!/^\d{4}$/.test(cleanPin)) {
      setErrorMessage('PIN must be exactly 4 numeric digits');
      return;
    }
    if (cleanPin !== confirmPin.trim()) {
      setErrorMessage('PINs do not match');
      return;
    }

    setIsLoading(true);
    try {
      const result = await apiSetupAdmin({
        employeeName: name,
        employeeCode: code,
        pin: cleanPin,
        setupSecret: secret,
      });
      onSuccess(result.user);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to setup initial Super Admin.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-md bg-[#0E1626] border border-[#1E2D44] rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 sm:p-5 bg-gradient-to-r from-amber-950/60 to-[#0E1626] border-b border-[#1E2D44] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400">
              <ShieldAlert className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white font-mono uppercase tracking-wide">
                Initial Setup: Provision Super Admin
              </h2>
              <p className="text-[11px] text-amber-300/80 font-sans">
                One-time secure Super Admin provisioning
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 flex items-center justify-center cursor-pointer transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="p-3 rounded-xl bg-cyan-950/30 border border-cyan-500/30 text-cyan-200 text-xs leading-relaxed">
            <p className="font-semibold text-cyan-300 mb-1 flex items-center gap-1.5">
              <BadgeCheck className="w-3.5 h-3.5" />
              Multi-Admin & Role-Based Access Foundation
            </p>
            The first account is provisioned as <strong>Super Admin</strong> with unrestricted access to create unlimited <strong>Admin</strong>, <strong>Supervisor</strong>, and <strong>Employee</strong> accounts.
          </div>

          {errorMessage && (
            <div className="p-3 rounded-xl bg-rose-950/50 border border-rose-500/50 text-rose-300 text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* One-Time Setup Secret */}
          <div>
            <label className="block text-[11px] font-mono uppercase tracking-wider text-amber-300 mb-1">
              One-Time Provisioning Secret Key
            </label>
            <div className="relative">
              <input
                type="password"
                autoComplete="off"
                required
                value={setupSecret}
                onChange={(e) => setSetupSecret(e.target.value)}
                placeholder="Enter server INITIAL_SETUP_SECRET"
                className="w-full px-3 py-2 bg-[#070A0F] border border-amber-500/40 rounded-xl text-amber-200 font-mono text-xs focus:outline-none focus:border-amber-400"
              />
              <KeyRound className="absolute right-3 top-2.5 w-4 h-4 text-amber-400/70" />
            </div>
            <span className="text-[10px] text-slate-500 font-mono mt-0.5 block">
              Must match the strong INITIAL_SETUP_SECRET configured in your Worker / server secrets
            </span>
          </div>

          {/* Super Admin Name */}
          <div>
            <label className="block text-[11px] font-mono uppercase tracking-wider text-slate-400 mb-1">
              Super Admin Full Name
            </label>
            <div className="relative">
              <input
                type="text"
                required
                value={employeeName}
                onChange={(e) => setEmployeeName(e.target.value)}
                placeholder="e.g. Workshop Super Admin"
                className="w-full px-3 py-2 bg-[#070A0F] border border-[#1E2D44] rounded-xl text-white font-sans text-xs focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/50"
              />
              <User className="absolute right-3 top-2.5 w-4 h-4 text-slate-500" />
            </div>
          </div>

          {/* Employee Identifier */}
          <div>
            <label className="block text-[11px] font-mono uppercase tracking-wider text-slate-400 mb-1">
              Super Admin Identifier
            </label>
            <input
              type="text"
              required
              value={employeeCode}
              onChange={(e) => setEmployeeCode(e.target.value.toUpperCase())}
              placeholder="e.g. SUPER-01"
              className="w-full px-3 py-2 bg-[#070A0F] border border-[#1E2D44] rounded-xl text-white font-mono text-xs uppercase tracking-wider focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/50"
            />
            <span className="text-[10px] text-slate-500 font-mono mt-0.5 block">
              Unique identifier used to sign in to workshop terminals
            </span>
          </div>

          {/* 4-digit PIN */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-mono uppercase tracking-wider text-slate-400 mb-1">
                4-Digit Security PIN
              </label>
              <div className="relative">
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  required
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="••••"
                  className="w-full px-3 py-2 bg-[#070A0F] border border-[#1E2D44] rounded-xl text-white font-mono text-center tracking-[0.4em] text-sm focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/50"
                />
                <Lock className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-mono uppercase tracking-wider text-slate-400 mb-1">
                Confirm PIN
              </label>
              <div className="relative">
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  required
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="••••"
                  className="w-full px-3 py-2 bg-[#070A0F] border border-[#1E2D44] rounded-xl text-white font-mono text-center tracking-[0.4em] text-sm focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/50"
                />
                <Lock className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="pt-2 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading}
              className="px-4 py-2 rounded-xl bg-transparent hover:bg-white/5 border border-slate-700 text-slate-300 font-mono text-xs uppercase cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading || pin.length !== 4 || confirmPin.length !== 4}
              className="px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-bold font-mono text-xs uppercase tracking-wider shadow-[0_0_15px_rgba(0,168,255,0.4)] transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Provisioning...</span>
                </>
              ) : (
                <>
                  <BadgeCheck className="w-3.5 h-3.5" />
                  <span>Provision Super Admin</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
