import React, { useState } from 'react';
import {
  X,
  Trash2,
  Archive,
  Loader2,
  Database,
  Building2,
  Users,
  ScanLine,
  Cpu,
  Palette,
  Wifi,
  HardDrive,
  Info,
  Check,
  RefreshCw,
  Moon,
  Sun,
  AlertTriangle,
} from 'lucide-react';
import { AppSettings, SupplierRuleId, UserAccount } from '../types/delivery';
import {
  getStoredSettings,
  saveStoredSettings,
  clearAllDeliveries,
  clearAllDocketsAuthoritative,
  syncDeliveriesFromCentralDatabase,
  getPreferredSupplierRuleId,
  setPreferredSupplierRuleId,
} from '../utils/storage';
import { playAudio, triggerHaptic } from '../utils/audioFeedback';
import { exportAllDeliveriesBackupZip } from '../utils/zipExport';
import {
  APP_THEMES,
  AppThemeId,
  AppThemeMode,
  getStoredTheme,
  getStoredThemeMode,
  setStoredTheme,
  setStoredThemeMode,
} from '../config/theme';
import { BRANDING } from '../config/branding';
import { PartTrackLogo } from './PartTrackLogo';
import { realtimeClient } from '../services/realtimeSync';
import { checkBackendConnection } from '../services/palletTrackApi';

interface SettingsModalProps {
  onClose: () => void;
  onSettingsSaved: () => void;
  onAllDocketsCleared?: () => void;
  onOpenMigration?: () => void;
  onOpenUserManagement?: () => void;
  currentUser?: UserAccount | null;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  onClose,
  onSettingsSaved,
  onAllDocketsCleared,
  onOpenMigration,
  onOpenUserManagement,
  currentUser,
}) => {
  const canManageDeletion =
    currentUser?.role === 'super_admin' ||
    currentUser?.role === 'admin' ||
    currentUser?.role === 'supervisor';
  const userKey = currentUser?.id || currentUser?.employeeCode || null;
  const extraUserKey =
    currentUser?.id && currentUser?.employeeCode && currentUser.id !== currentUser.employeeCode
      ? [currentUser.employeeCode]
      : undefined;

  const [settings, setSettings] = useState<AppSettings>(getStoredSettings());
  const [activeTheme, setActiveTheme] = useState<AppThemeId>(() => getStoredTheme(userKey));
  const [activeMode, setActiveMode] = useState<AppThemeMode>(() => getStoredThemeMode(userKey));
  const [preferredRule, setPreferredRule] = useState<SupplierRuleId>(() =>
    getPreferredSupplierRuleId()
  );
  const [isBackingUpZip, setIsBackingUpZip] = useState(false);
  const [isSyncingNow, setIsSyncingNow] = useState(false);
  const [confirmClearAllDockets, setConfirmClearAllDockets] = useState(false);
  const [isClearingAllDockets, setIsClearingAllDockets] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  const handleToggle = (field: keyof AppSettings) => {
    const next = { ...settings, [field]: !settings[field] };
    setSettings(next);
    saveStoredSettings(next);
    onSettingsSaved();

    if (field === 'soundEnabled' && next.soundEnabled) {
      playAudio.success();
    }
    if (field === 'vibrationEnabled' && next.vibrationEnabled) {
      triggerHaptic('success');
    }
  };

  const handleThemeSelect = (themeId: AppThemeId) => {
    setActiveTheme(themeId);
    setStoredTheme(themeId, userKey, extraUserKey);
    onSettingsSaved();
  };

  const handleModeSelect = (mode: AppThemeMode) => {
    setActiveMode(mode);
    setStoredThemeMode(mode, userKey, extraUserKey);
    onSettingsSaved();
  };

  const handleRuleSelect = (ruleId: SupplierRuleId) => {
    setPreferredRule(ruleId);
    setPreferredSupplierRuleId(ruleId);
    onSettingsSaved();
  };

  const handleManualSync = async () => {
    setIsSyncingNow(true);
    try {
      await checkBackendConnection();
      await realtimeClient.flushPendingOfflineScans();
      await syncDeliveriesFromCentralDatabase();
      onSettingsSaved();
    } finally {
      setTimeout(() => setIsSyncingNow(false), 500);
    }
  };

  const handleRefreshLocalCache = async () => {
    setIsSyncingNow(true);
    try {
      clearAllDeliveries();
      await syncDeliveriesFromCentralDatabase();
      onSettingsSaved();
      onClose();
    } finally {
      setIsSyncingNow(false);
    }
  };

  const handleConfirmClearAllDockets = async () => {
    if (!canManageDeletion) return;
    setClearError(null);
    setIsClearingAllDockets(true);
    try {
      await clearAllDocketsAuthoritative();
      setConfirmClearAllDockets(false);
      onAllDocketsCleared?.();
      onSettingsSaved();
      onClose();
    } catch (err: any) {
      setClearError(err?.message || 'Failed to clear all dockets from central database.');
    } finally {
      setIsClearingAllDockets(false);
    }
  };

  const handleBackupAllZip = async () => {
    setIsBackingUpZip(true);
    try {
      await exportAllDeliveriesBackupZip();
    } catch (err) {
      console.error('Backup zip failed:', err);
    } finally {
      setIsBackingUpZip(false);
    }
  };

  const rtState = realtimeClient.getState();

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[92dvh] bg-[var(--pt-bg-secondary,#101321)] border-t sm:border border-[var(--pt-border,#29243D)] rounded-t-3xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden text-[var(--pt-text,#FFFFFF)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 bg-[var(--pt-card,#15182A)] border-b border-[var(--pt-border,#29243D)] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <PartTrackLogo size="xs" />
            <span className="text-[var(--pt-text-muted,#737B94)]">/</span>
            <h2 className="font-mono font-bold text-sm uppercase tracking-wider text-[var(--pt-text,#FFFFFF)]">
              SYSTEM SETTINGS
            </h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[var(--pt-text,#FFFFFF)] flex items-center justify-center cursor-pointer transition-colors"
            aria-label="Close Settings"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable 8-Section Settings Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-5 text-xs">
          {/* =================================================================
           * SECTION 1: THEMES & APPEARANCE (Dark/Light Mode + 4 Colour Themes)
           * ================================================================= */}
          <section className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] space-y-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 font-mono font-bold uppercase tracking-wider text-[var(--pt-text,#FFFFFF)]">
                <Palette className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
                <span>1. Themes &amp; Appearance</span>
              </div>
              <span className="text-[10px] font-mono text-[var(--pt-primary-light,#C084FC)] font-semibold">
                {APP_THEMES[activeTheme]?.name} · {activeMode === 'dark' ? 'Dark Mode' : 'Light Mode'}
              </span>
            </div>

            {/* 1A: Prominent Appearance Mode Toggle (Dark Mode / Light Mode) */}
            <div className="p-3 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="font-mono font-bold uppercase tracking-wider text-[11px] text-[var(--pt-text,#FFFFFF)]">
                  Appearance
                </div>
                <div className="text-[11px] text-[var(--pt-text-secondary,#A3A8BD)] mt-0.5">
                  Switch globally between Dark Mode and Light Mode while preserving your colour theme
                </div>
              </div>

              <div
                role="group"
                aria-label="Appearance mode toggle"
                className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] shrink-0"
              >
                <button
                  type="button"
                  onClick={() => handleModeSelect('dark')}
                  aria-pressed={activeMode === 'dark'}
                  className={`h-9 px-3.5 rounded-lg font-mono font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
                    activeMode === 'dark'
                      ? 'pt-btn-primary shadow-md'
                      : 'text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[var(--pt-text,#FFFFFF)] hover:bg-[var(--pt-hover-bg)]'
                  }`}
                >
                  <Moon className="w-3.5 h-3.5" />
                  <span>Dark Mode</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleModeSelect('light')}
                  aria-pressed={activeMode === 'light'}
                  className={`h-9 px-3.5 rounded-lg font-mono font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
                    activeMode === 'light'
                      ? 'pt-btn-primary shadow-md'
                      : 'text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[var(--pt-text,#FFFFFF)] hover:bg-[var(--pt-hover-bg)]'
                  }`}
                >
                  <Sun className="w-3.5 h-3.5" />
                  <span>Light Mode</span>
                </button>
              </div>
            </div>

            {/* 1B: Colour Themes Grid (4 Complete Themes with Swatch Previews) */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-mono font-bold uppercase tracking-wider text-[11px] text-[var(--pt-text-secondary,#A3A8BD)]">
                  Colour Themes
                </span>
                <span className="text-[10px] font-mono text-[var(--pt-text-muted,#737B94)]">
                  Saved per user profile
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {(Object.keys(APP_THEMES) as AppThemeId[]).map((themeKey) => {
                  const theme = APP_THEMES[themeKey];
                  const palette = theme.palettes[activeMode] || theme.palettes.dark;
                  const isSelected = activeTheme === theme.id;
                  return (
                    <button
                      key={theme.id}
                      type="button"
                      onClick={() => handleThemeSelect(theme.id)}
                      aria-pressed={isSelected}
                      className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between gap-2.5 ${
                        isSelected
                          ? 'bg-[var(--pt-bg,#080B12)] border-2 shadow-lg'
                          : 'bg-[var(--pt-bg-secondary,#101321)]/80 border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary)]/50'
                      }`}
                      style={
                        isSelected
                          ? {
                              borderColor: palette.primary,
                              boxShadow: `0 0 18px ${palette.glowRgba}`,
                            }
                          : undefined
                      }
                    >
                      <div className="flex items-center justify-between gap-2">
                        {/* Colour Preview Swatches: Primary Accent, Secondary Accent, Surface, Card */}
                        <div className="flex items-center gap-1.5" title={`${theme.name} swatch preview`}>
                          <span
                            className="w-5 h-5 rounded-full border border-black/20 shadow-xs shrink-0"
                            style={{ backgroundColor: palette.primary }}
                          />
                          <span
                            className="w-4 h-4 rounded-full border border-black/20 shrink-0"
                            style={{ backgroundColor: palette.accentSecondary }}
                          />
                          <span
                            className="w-4 h-4 rounded-md border shrink-0"
                            style={{
                              backgroundColor: palette.bgPrimary,
                              borderColor: palette.border,
                            }}
                          />
                          <span
                            className="w-4 h-4 rounded-md border shrink-0"
                            style={{
                              backgroundColor: palette.bgCard,
                              borderColor: palette.border,
                            }}
                          />
                        </div>

                        {isSelected ? (
                          <span
                            className="px-2 py-0.5 rounded-md text-[9px] font-mono font-extrabold uppercase inline-flex items-center gap-1 shadow-xs"
                            style={{
                              backgroundColor: palette.primary,
                              color: palette.primaryContrast,
                            }}
                          >
                            <Check className="w-2.5 h-2.5 stroke-[3]" />
                            Active
                          </span>
                        ) : (
                          <span className="text-[9px] font-mono text-[var(--pt-text-muted,#737B94)] uppercase font-semibold">
                            {theme.badge}
                          </span>
                        )}
                      </div>

                      <div>
                        <div className="font-bold text-[var(--pt-text,#FFFFFF)] text-xs flex items-center gap-1.5">
                          <span>{theme.name}</span>
                        </div>
                        <div className="text-[10px] text-[var(--pt-text-secondary,#A3A8BD)] leading-snug mt-0.5">
                          {theme.subtitle}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          {/* =================================================================
           * SECTION 2: COMPANY & SITES
           * ================================================================= */}
          <section className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] space-y-2.5">
            <div className="flex items-center gap-2 font-mono font-bold uppercase tracking-wider text-white">
              <Building2 className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
              <span>2. Company &amp; Sites</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 font-mono">
              <div className="p-3 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)]">
                <div className="text-[10px] text-[var(--pt-text-muted,#737B94)] uppercase">
                  Active Facility / Site
                </div>
                <div className="text-xs font-bold text-white mt-0.5">
                  Main Manufacturing Facility · WH-01
                </div>
              </div>
              <div className="p-3 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)]">
                <div className="text-[10px] text-[var(--pt-text-muted,#737B94)] uppercase">
                  Terminal Mode
                </div>
                <div className="text-xs font-bold text-[#00D979] mt-0.5">
                  Multi-Worker Receiving Bay
                </div>
              </div>
            </div>
          </section>

          {/* =================================================================
           * SECTION 3: USERS & ACCESS (RBAC)
           * ================================================================= */}
          <section className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-mono font-bold uppercase tracking-wider text-white">
                <Users className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
                <span>3. Users &amp; Access</span>
              </div>
              {currentUser && (
                <span className="px-2 py-0.5 rounded bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] font-mono text-[10px] font-bold text-[var(--pt-primary-light,#C084FC)] uppercase">
                  {currentUser.role.replace('_', ' ')}
                </span>
              )}
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)]">
              <div>
                <div className="font-bold text-white">
                  {currentUser ? currentUser.employeeName : 'Active Operator'}
                </div>
                <div className="text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)]">
                  ID: {currentUser?.employeeCode || 'TERMINAL'} · 4-Tier Role-Based Access Control
                </div>
              </div>
              {(currentUser?.role === 'super_admin' || currentUser?.role === 'admin') &&
                onOpenUserManagement && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenUserManagement();
                    }}
                    className="h-9 px-3.5 rounded-xl pt-btn-primary font-mono font-bold text-xs uppercase tracking-wider inline-flex items-center justify-center gap-1.5 cursor-pointer shrink-0"
                  >
                    <Users className="w-3.5 h-3.5" />
                    <span>Manage Users &amp; Roles</span>
                  </button>
                )}
            </div>
          </section>

          {/* =================================================================
           * SECTION 4: SCANNING & DEVICES
           * ================================================================= */}
          <section className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] space-y-3">
            <div className="flex items-center gap-2 font-mono font-bold uppercase tracking-wider text-white">
              <ScanLine className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
              <span>4. Scanning &amp; Devices</span>
            </div>

            <div className="divide-y divide-[var(--pt-border,#29243D)] rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] overflow-hidden">
              <label className="px-3.5 py-3 flex items-center justify-between cursor-pointer hover:bg-white/[0.02]">
                <div>
                  <span className="font-bold text-white block">Sound Feedback</span>
                  <span className="text-[11px] text-[var(--pt-text-secondary,#A3A8BD)]">
                    High-contrast audio chime on scan verification or duplicate alert
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={settings.soundEnabled}
                  onChange={() => handleToggle('soundEnabled')}
                  className="w-4 h-4 accent-[var(--pt-primary,#A020F0)] cursor-pointer"
                />
              </label>

              <label className="px-3.5 py-3 flex items-center justify-between cursor-pointer hover:bg-white/[0.02]">
                <div>
                  <span className="font-bold text-white block">Haptic Vibration</span>
                  <span className="text-[11px] text-[var(--pt-text-secondary,#A3A8BD)]">
                    Tactile device pulse on barcode, QR &amp; OCR confirmation
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={settings.vibrationEnabled}
                  onChange={() => handleToggle('vibrationEnabled')}
                  className="w-4 h-4 accent-[var(--pt-primary,#A020F0)] cursor-pointer"
                />
              </label>

              <label className="px-3.5 py-3 flex items-center justify-between cursor-pointer hover:bg-white/[0.02]">
                <div>
                  <span className="font-bold text-white block">Voice Announcements</span>
                  <span className="text-[11px] text-[var(--pt-text-secondary,#A3A8BD)]">
                    Speak part numbers and verification alerts aloud
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={settings.speechEnabled}
                  onChange={() => handleToggle('speechEnabled')}
                  className="w-4 h-4 accent-[var(--pt-primary,#A020F0)] cursor-pointer"
                />
              </label>

              <div className="px-3.5 py-3 flex items-center justify-between gap-2">
                <div>
                  <span className="font-bold text-white block">Default Camera Sensor</span>
                  <span className="text-[11px] text-[var(--pt-text-secondary,#A3A8BD)]">
                    Continuous autofocus priority (Android S25 Ultra / iOS)
                  </span>
                </div>
                <div className="flex items-center bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] rounded-lg p-0.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      const next = { ...settings, preferredCamera: 'environment' as const };
                      setSettings(next);
                      saveStoredSettings(next);
                      onSettingsSaved();
                    }}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-mono font-bold cursor-pointer transition-all ${
                      settings.preferredCamera === 'environment'
                        ? 'pt-btn-primary text-white'
                        : 'text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white'
                    }`}
                  >
                    Rear
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const next = { ...settings, preferredCamera: 'user' as const };
                      setSettings(next);
                      saveStoredSettings(next);
                      onSettingsSaved();
                    }}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-mono font-bold cursor-pointer transition-all ${
                      settings.preferredCamera === 'user'
                        ? 'pt-btn-primary text-white'
                        : 'text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white'
                    }`}
                  >
                    Front
                  </button>
                </div>
              </div>

              <div className="px-3.5 py-3 flex items-center justify-between gap-2">
                <div>
                  <span className="font-bold text-white block">Default Scanning Profile</span>
                  <span className="text-[11px] text-[var(--pt-text-secondary,#A3A8BD)]">
                    Supplier barcode / QR / pallet label decoding mode
                  </span>
                </div>
                <select
                  value={preferredRule}
                  onChange={(e) => handleRuleSelect(e.target.value as SupplierRuleId)}
                  className="h-8 px-2.5 rounded-lg bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)] text-white font-mono text-[11px] font-bold outline-none"
                >
                  <option value="laser_central">Laser Central (1D + QR)</option>
                  <option value="gci">GCI (Fast 2D QR)</option>
                  <option value="ocr_label">Pallet Label OCR</option>
                </select>
              </div>
            </div>
          </section>

          {/* =================================================================
           * SECTION 5: INTEGRATIONS
           * ================================================================= */}
          <section className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] space-y-2.5">
            <div className="flex items-center gap-2 font-mono font-bold uppercase tracking-wider text-white">
              <Cpu className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
              <span>5. Integrations</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 font-mono">
              <div className="p-3 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-white">Docket AI Vision + OCR</div>
                  <div className="text-[10px] text-[var(--pt-text-secondary,#A3A8BD)]">
                    Cloud Vision + Local Tesseract
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded bg-[#00D979]/15 border border-[#00D979]/40 text-[#00D979] text-[10px] font-bold">
                  ACTIVE
                </span>
              </div>
              <div className="p-3 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-white">Hardware HID Wedge</div>
                  <div className="text-[10px] text-[var(--pt-text-secondary,#A3A8BD)]">
                    USB &amp; Bluetooth Scanners
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded bg-[#00D979]/15 border border-[#00D979]/40 text-[#00D979] text-[10px] font-bold">
                  READY
                </span>
              </div>
            </div>
          </section>

          {/* =================================================================
           * SECTION 6: SYNC & OFFLINE
           * ================================================================= */}
          <section className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-mono font-bold uppercase tracking-wider text-white">
                <Wifi className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
                <span>6. Sync &amp; Offline</span>
              </div>
              <span
                className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase ${
                  rtState.status === 'connected'
                    ? 'bg-[#00D979]/15 border border-[#00D979]/40 text-[#00D979]'
                    : 'bg-[#F59E0B]/15 border border-[#F59E0B]/40 text-[#F59E0B]'
                }`}
              >
                {rtState.status === 'connected' ? 'REALTIME ONLINE' : `REALTIME ${rtState.status.toUpperCase()}`}
              </span>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)]">
              <div className="font-mono">
                <div className="text-xs font-bold text-white">
                  Real-Time Multi-User Synchronisation
                </div>
                <div className="text-[10px] text-[var(--pt-text-secondary,#A3A8BD)] mt-0.5">
                  Offline Queue: {rtState.pendingOfflineScansCount} pending scans · Connected Workers:{' '}
                  {typeof rtState.presence?.connectedWorkersCount === 'number'
                    ? rtState.presence.connectedWorkersCount
                    : rtState.status === 'connected'
                    ? 1
                    : 0}
                </div>
              </div>
              <button
                type="button"
                onClick={handleManualSync}
                disabled={isSyncingNow}
                className="h-9 px-3.5 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-white font-mono font-bold text-xs inline-flex items-center justify-center gap-1.5 cursor-pointer shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isSyncingNow ? 'animate-spin' : ''}`} />
                <span>{isSyncingNow ? 'Syncing...' : 'Sync Now'}</span>
              </button>
            </div>
          </section>

          {/* =================================================================
           * SECTION 7: DATA & STORAGE
           * ================================================================= */}
          <section className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] space-y-2.5">
            <div className="flex items-center gap-2 font-mono font-bold uppercase tracking-wider text-white">
              <HardDrive className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
              <span>7. Data &amp; Storage</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {onOpenMigration && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenMigration();
                  }}
                  className="h-10 px-3 rounded-xl bg-[var(--pt-bg,#080B12)] hover:bg-white/5 border border-[var(--pt-border,#29243D)] text-xs font-mono font-bold text-[var(--pt-primary-light,#C084FC)] flex items-center justify-center gap-2 cursor-pointer transition-colors"
                >
                  <Database className="w-3.5 h-3.5" />
                  <span>Migrate / Sync to D1</span>
                </button>
              )}

              <button
                type="button"
                onClick={handleBackupAllZip}
                disabled={isBackingUpZip}
                className="h-10 px-3 rounded-xl bg-[var(--pt-bg,#080B12)] hover:bg-white/5 border border-[var(--pt-border,#29243D)] text-xs font-mono font-bold text-white flex items-center justify-center gap-2 cursor-pointer transition-colors"
              >
                {isBackingUpZip ? (
                  <Loader2 className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)] animate-spin" />
                ) : (
                  <Archive className="w-3.5 h-3.5 text-[#00D979]" />
                )}
                <span>{isBackingUpZip ? 'Packaging .ZIP...' : 'Backup All Dockets (.ZIP)'}</span>
              </button>
            </div>

            <button
              type="button"
              onClick={handleRefreshLocalCache}
              disabled={isSyncingNow}
              className="w-full h-10 px-3 rounded-xl border border-[var(--pt-border,#29243D)] bg-[var(--pt-bg,#080B12)] hover:bg-white/5 text-xs font-mono font-bold text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white flex items-center justify-center gap-2 cursor-pointer transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncingNow ? 'animate-spin' : ''}`} />
              <span>Refresh Local Cache from Server</span>
            </button>

            {canManageDeletion && (
              <div className="pt-2 border-t border-[var(--pt-border,#29243D)] space-y-2">
                {clearError && (
                  <div className="p-2.5 rounded-lg bg-[#EF4444]/15 border border-[#EF4444]/40 text-[#EF4444] text-[11px] font-mono">
                    {clearError}
                  </div>
                )}

                {!confirmClearAllDockets ? (
                  <button
                    type="button"
                    onClick={() => setConfirmClearAllDockets(true)}
                    className="w-full h-10 px-3 rounded-xl border border-[#EF4444]/40 bg-[#EF4444]/10 hover:bg-[#EF4444]/20 text-xs font-mono font-bold text-[#EF4444] flex items-center justify-center gap-2 cursor-pointer transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>CLEAR ALL DOCKETS (ALL USERS)</span>
                  </button>
                ) : (
                  <div className="p-3 rounded-xl border border-[#EF4444]/50 bg-[#EF4444]/10 space-y-2.5">
                    <div className="flex items-start gap-2 text-[#EF4444] text-[11px] font-mono">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>
                        Permanently delete ALL dockets, parts, scan logs &amp; docket groups from Cloudflare D1 and all devices? User accounts remain intact.
                      </span>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        disabled={isClearingAllDockets}
                        onClick={() => setConfirmClearAllDockets(false)}
                        className="h-8 px-3 rounded-lg bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] text-[var(--pt-text-secondary,#A3A8BD)] text-[11px] font-mono font-bold cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={isClearingAllDockets}
                        onClick={handleConfirmClearAllDockets}
                        className="h-8 px-3 rounded-lg bg-[#EF4444] hover:bg-red-500 text-white text-[11px] font-mono font-extrabold uppercase inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                      >
                        {isClearingAllDockets && <Loader2 className="w-3 h-3 animate-spin" />}
                        <span>{isClearingAllDockets ? 'Clearing...' : 'Confirm Clear All'}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* =================================================================
           * SECTION 8: ABOUT PARTTRACK
           * ================================================================= */}
          <section className="p-4 rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 font-mono font-bold uppercase tracking-wider text-white">
                <Info className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
                <span>8. About PartTrack</span>
              </div>
              <div className="text-[11px] font-mono text-[var(--pt-primary-light,#C084FC)] font-bold">
                {BRANDING.tagline}
              </div>
              <div className="text-[11px] text-[var(--pt-text-secondary,#A3A8BD)]">
                {BRANDING.operationalSubtitle}
              </div>
            </div>
            <div className="text-left sm:text-right font-mono shrink-0">
              <span className="px-2.5 py-1 rounded-lg bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] text-[11px] font-bold text-white">
                {BRANDING.versionLabel}
              </span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
