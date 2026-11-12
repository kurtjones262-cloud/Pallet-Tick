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
      <div className="w-full max-w-md bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] rounded-2xl shadow-2xl overflow-hidden flex flex-col text-[var(--pt-text,#FFFFFF)]">
        {/* Header */}
        <div className="p-4 sm:p-5 bg-[var(--pt-bg-secondary,#101321)] border-b border-[var(--pt-border,#29243D)] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#F59E0B]/15 border border-[#F59E0B]/40 flex items-center justify-center text-[#F59E0B]">
              <ShieldAlert className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-[var(--pt-text,#FFFFFF)] font-mono uppercase tracking-wide">
                Initial Setup: Provision Super Admin
              </h2>
              <p className="text-[11px] text-[var(--pt-text-secondary,#A3A8BD)] font-sans">
                One-time secure Super Admin provisioning
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[var(--pt-text,#FFFFFF)] hover:bg-[var(--pt-hover-bg)] flex items-center justify-center cursor-pointer transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="p-3 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] text-[var(--pt-text-secondary,#A3A8BD)] text-xs leading-relaxed">
            <p className="font-semibold text-[var(--pt-primary-light,#C084FC)] mb-1 flex items-center gap-1.5">
              <BadgeCheck className="w-3.5 h-3.5" />
              Multi-Admin &amp; Role-Based Access Foundation
            </p>
            The first account is provisioned as <strong className="text-[var(--pt-text,#FFFFFF)]">Super Admin</strong> with unrestricted access to create unlimited <strong className="text-[var(--pt-text,#FFFFFF)]">Admin</strong>, <strong className="text-[var(--pt-text,#FFFFFF)]">Supervisor</strong>, and <strong className="text-[var(--pt-text,#FFFFFF)]">Employee</strong> accounts.
          </div>

          {errorMessage && (
            <div className="p-3 rounded-xl bg-[#EF4444]/15 border border-[#EF4444]/50 text-[#EF4444] text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-[#EF4444]" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* One-Time Setup Secret */}
          <div>
            <label className="block text-[11px] font-mono uppercase tracking-wider text-[#F59E0B] mb-1 font-semibold">
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
                className="w-full px-3 py-2 bg-[var(--pt-input-bg,#080B12)] border border-[#F59E0B]/50 rounded-xl text-[var(--pt-text,#FFFFFF)] font-mono text-xs focus:outline-none focus:border-[#F59E0B]"
              />
              <KeyRound className="absolute right-3 top-2.5 w-4 h-4 text-[#F59E0B]" />
            </div>
            <span className="text-[10px] text-[var(--pt-text-muted,#737B94)] font-mono mt-0.5 block">
              Must match the strong INITIAL_SETUP_SECRET configured in your Worker / server secrets
            </span>
          </div>

          {/* Super Admin Name */}
          <div>
            <label className="block text-[11px] font-mono uppercase tracking-wider text-[var(--pt-text-secondary,#A3A8BD)] mb-1">
              Super Admin Full Name
            </label>
            <div className="relative">
              <input
                type="text"
                required
                value={employeeName}
                onChange={(e) => setEmployeeName(e.target.value)}
                placeholder="e.g. Workshop Super Admin"
                className="w-full px-3 py-2 bg-[var(--pt-input-bg,#080B12)] border border-[var(--pt-border,#29243D)] rounded-xl text-[var(--pt-text,#FFFFFF)] font-sans text-xs focus:outline-none focus:border-[var(--pt-primary,#A020F0)]"
              />
              <User className="absolute right-3 top-2.5 w-4 h-4 text-[var(--pt-text-muted,#737B94)]" />
            </div>
          </div>

          {/* Employee Identifier */}
          <div>
            <label className="block text-[11px] font-mono uppercase tracking-wider text-[var(--pt-text-secondary,#A3A8BD)] mb-1">
              Super Admin Identifier
            </label>
            <input
              type="text"
              required
              value={employeeCode}
              onChange={(e) => setEmployeeCode(e.target.value.toUpperCase())}
              placeholder="e.g. SUPER-01"
              className="w-full px-3 py-2 bg-[var(--pt-input-bg,#080B12)] border border-[var(--pt-border,#29243D)] rounded-xl text-[var(--pt-text,#FFFFFF)] font-mono text-xs uppercase tracking-wider focus:outline-none focus:border-[var(--pt-primary,#A020F0)]"
            />
            <span className="text-[10px] text-[var(--pt-text-muted,#737B94)] font-mono mt-0.5 block">
              Unique identifier used to sign in to workshop terminals
            </span>
          </div>

          {/* 4-digit PIN */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-mono uppercase tracking-wider text-[var(--pt-text-secondary,#A3A8BD)] mb-1">
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
                  className="w-full px-3 py-2 bg-[var(--pt-input-bg,#080B12)] border border-[var(--pt-border,#29243D)] rounded-xl text-[var(--pt-text,#FFFFFF)] font-mono text-center tracking-[0.4em] text-sm focus:outline-none focus:border-[var(--pt-primary,#A020F0)]"
                />
                <Lock className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-[var(--pt-text-muted,#737B94)] pointer-events-none" />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-mono uppercase tracking-wider text-[var(--pt-text-secondary,#A3A8BD)] mb-1">
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
                  className="w-full px-3 py-2 bg-[var(--pt-input-bg,#080B12)] border border-[var(--pt-border,#29243D)] rounded-xl text-[var(--pt-text,#FFFFFF)] font-mono text-center tracking-[0.4em] text-sm focus:outline-none focus:border-[var(--pt-primary,#A020F0)]"
                />
                <Lock className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-[var(--pt-text-muted,#737B94)] pointer-events-none" />
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="pt-2 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading}
              className="px-4 py-2 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-[var(--pt-hover-bg)] border border-[var(--pt-border,#29243D)] text-[var(--pt-text-secondary,#A3A8BD)] font-mono text-xs uppercase cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading || pin.length !== 4 || confirmPin.length !== 4}
              className="px-4 py-2 rounded-xl pt-btn-primary font-bold font-mono text-xs uppercase tracking-wider transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
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
