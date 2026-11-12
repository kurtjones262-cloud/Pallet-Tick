import React from 'react';
import {
  QrCode,
  LayoutGrid,
  ClipboardList,
  BarChart3,
  Settings,
  ChevronDown,
  Users,
  LogOut,
  ShieldAlert,
  Shield,
  UserCheck,
  HardHat,
} from 'lucide-react';
import { Delivery, UserAccount, UserRole } from '../types/delivery';
import { BRANDING } from '../config/branding';
import { PartTrackLogo } from './PartTrackLogo';

export type NavTabId = 'scanner' | 'checklist' | 'dashboard' | 'orders' | 'reports';

interface NavbarProps {
  activeTab: NavTabId;
  setActiveTab: (tab: NavTabId) => void;
  activeDelivery: Delivery | null;
  onUpdateDelivery?: (updated: Delivery) => void;
  onOpenNewDelivery?: () => void;
  onOpenDeliveriesList: () => void;
  onOpenTestSheet?: () => void;
  onOpenSettings: () => void;
  currentUser?: UserAccount | null;
  onOpenUserManagement?: () => void;
  onLogout?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  activeDelivery,
  onOpenDeliveriesList,
  onOpenSettings,
  currentUser,
  onOpenUserManagement,
  onLogout,
}) => {
  const parts = activeDelivery?.parts || [];

  const total = (activeDelivery as any)?.stats?.totalParts ?? parts.length;
  const received =
    (activeDelivery as any)?.stats?.receivedParts ??
    parts.filter((p) => p.status === 'received').length;

  const renderRoleBadge = (role?: UserRole) => {
    switch (role) {
      case 'super_admin':
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold uppercase bg-amber-950/90 border border-[#F59E0B]/40 text-[#F59E0B]">
            <ShieldAlert className="w-2.5 h-2.5 text-[#F59E0B]" />
            SUPER ADMIN
          </span>
        );
      case 'admin':
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold uppercase bg-purple-950/90 border border-[#A020F0]/50 text-[#C084FC]">
            <Shield className="w-2.5 h-2.5 text-[#C084FC]" />
            ADMIN
          </span>
        );
      case 'supervisor':
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold uppercase bg-sky-950/90 border border-[#078BFF]/40 text-[#38BDF8]">
            <UserCheck className="w-2.5 h-2.5 text-[#078BFF]" />
            SUPERVISOR
          </span>
        );
      case 'employee':
      case 'operator':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold uppercase bg-emerald-950/90 border border-[#00D979]/40 text-[#00D979]">
            <HardHat className="w-2.5 h-2.5 text-[#00D979]" />
            OPERATOR
          </span>
        );
    }
  };

  return (
    <>
      {/* =========================================================================
       * TOP BAR: PartTrack Industrial Header with Active Docket & RBAC Identity
       * ========================================================================= */}
      <header className="sticky top-0 z-30 bg-[var(--pt-bg,#080B12)]/95 backdrop-blur-md border-b border-[var(--pt-border,#29243D)] pt-safe">
        <div className="max-w-6xl mx-auto px-3 sm:px-6 h-13 flex items-center justify-between gap-2 sm:gap-3">
          {/* Left: PartTrack Brand + Active Docket Selector */}
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <button
              onClick={() => setActiveTab('dashboard')}
              className="flex items-center gap-2 shrink-0 cursor-pointer text-left group"
              title={`${BRANDING.appName} — ${BRANDING.tagline}`}
            >
              <PartTrackLogo size="xs" />
            </button>

            <span className="text-[var(--pt-text-muted,#737B94)] text-xs select-none">/</span>

            {activeDelivery ? (
              <button
                onClick={onOpenDeliveriesList}
                className="flex items-center gap-1.5 py-1 px-2.5 rounded-lg bg-[var(--pt-bg-secondary,#101321)] hover:bg-[var(--pt-card,#15182A)] text-white transition-colors text-xs font-mono font-semibold truncate max-w-[130px] sm:max-w-[220px] cursor-pointer border border-[var(--pt-border,#29243D)]"
                title="Switch active delivery docket"
              >
                <span className="truncate">#{activeDelivery.docketNumber}</span>
                <span className="text-[10px] text-[var(--pt-text-secondary,#A3A8BD)] hidden sm:inline truncate">
                  ({activeDelivery.supplier})
                </span>
                <ChevronDown className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)] shrink-0" />
              </button>
            ) : (
              <button
                onClick={onOpenDeliveriesList}
                className="text-xs text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white cursor-pointer font-mono font-medium truncate flex items-center gap-1 py-1 px-2.5 rounded-lg bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)]"
              >
                <span>Select docket</span>
                <ChevronDown className="w-3 h-3 text-[var(--pt-primary-light,#C084FC)]" />
              </button>
            )}
          </div>

          {/* Center Desktop Navigation Links (for larger screens) */}
          <div className="hidden lg:flex items-center gap-1 bg-[var(--pt-bg-secondary,#101321)] p-1 rounded-xl border border-[var(--pt-border,#29243D)]">
            {(
              [
                { id: 'dashboard', label: 'Home', icon: LayoutGrid },
                { id: 'orders', label: 'Orders', icon: ClipboardList },
                { id: 'scanner', label: 'Scan', icon: QrCode },
                { id: 'reports', label: 'Reports', icon: BarChart3 },
              ] as const
            ).map((navItem) => {
              const Icon = navItem.icon;
              const isActive =
                activeTab === navItem.id ||
                (navItem.id === 'orders' && activeTab === 'checklist');
              return (
                <button
                  key={navItem.id}
                  type="button"
                  onClick={() => setActiveTab(navItem.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold uppercase tracking-wider inline-flex items-center gap-1.5 transition-all cursor-pointer ${
                    isActive
                      ? 'pt-btn-primary text-white'
                      : 'text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{navItem.label}</span>
                </button>
              );
            })}
          </div>

          {/* Right: Employee Account Badge + Actions */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {activeDelivery && (
              <button
                type="button"
                onClick={() => setActiveTab('checklist')}
                className="hidden md:flex items-center gap-1.5 text-xs font-mono px-2.5 py-1 rounded-lg bg-[var(--pt-bg-secondary,#101321)] hover:bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] text-slate-200 cursor-pointer transition-colors"
                title="Open active docket checklist"
              >
                <span className="text-[#00D979] font-bold">{received}</span>
                <span className="text-[var(--pt-text-muted,#737B94)]">/</span>
                <span>{total}</span>
                <span className="text-[var(--pt-text-muted,#737B94)] text-[10px] uppercase">
                  rcvd
                </span>
              </button>
            )}

            {/* Logged in Employee Info */}
            {currentUser && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-[var(--pt-bg-secondary,#101321)] border border-[var(--pt-border,#29243D)]">
                <div className="flex flex-col text-left">
                  <div className="flex items-center gap-1.5 leading-none">
                    <span className="text-xs font-mono font-bold text-white truncate max-w-[85px] sm:max-w-[130px]">
                      {currentUser.employeeName}
                    </span>
                    {renderRoleBadge(currentUser.role)}
                  </div>
                  <span className="text-[9px] font-mono text-[var(--pt-primary-light,#C084FC)] tracking-wider mt-0.5">
                    {currentUser.employeeCode} · WH-01
                  </span>
                </div>
              </div>
            )}

            {/* Super Admin & Admin User Management Button */}
            {(currentUser?.role === 'super_admin' || currentUser?.role === 'admin') &&
              onOpenUserManagement && (
                <button
                  onClick={onOpenUserManagement}
                  className="h-9 px-2.5 inline-flex items-center gap-1.5 text-[var(--pt-primary-light,#C084FC)] hover:text-white bg-[var(--pt-bg-secondary,#101321)] hover:bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] rounded-xl transition-colors cursor-pointer text-xs font-mono font-bold"
                  aria-label="User Management"
                  title="Employee & Admin Accounts (RBAC)"
                >
                  <Users className="w-3.5 h-3.5 text-[var(--pt-primary-light,#C084FC)]" />
                  <span className="hidden sm:inline">Users</span>
                </button>
              )}

            {/* Settings Button */}
            <button
              onClick={onOpenSettings}
              className="w-9 h-9 inline-flex items-center justify-center text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white bg-[var(--pt-bg-secondary,#101321)] hover:bg-[var(--pt-card,#15182A)] rounded-xl transition-colors cursor-pointer border border-[var(--pt-border,#29243D)]"
              aria-label="Settings"
              title="Settings & App Theme"
            >
              <Settings className="w-4 h-4 stroke-[1.9]" />
            </button>

            {/* Sign Out Button */}
            {onLogout && (
              <button
                onClick={onLogout}
                className="w-9 h-9 inline-flex items-center justify-center text-[var(--pt-text-secondary,#A3A8BD)] hover:text-[#EF4444] bg-[var(--pt-bg-secondary,#101321)] hover:bg-red-950/40 rounded-xl transition-colors cursor-pointer border border-[var(--pt-border,#29243D)] hover:border-[#EF4444]/40"
                aria-label="Sign Out"
                title="Sign Out Terminal"
              >
                <LogOut className="w-4 h-4 stroke-[1.9]" />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* =========================================================================
       * BOTTOM NAVIGATION: 5-Tab Mobile & Tablet Ergonomic Bar
       * [ Home · Orders · Scan · Reports · Settings ]
       * ========================================================================= */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-[var(--pt-bg-secondary,#101321)]/95 backdrop-blur-md border-t border-[var(--pt-border,#29243D)] pb-safe shadow-[0_-6px_28px_rgba(0,0,0,0.65)]">
        <div className="max-w-lg mx-auto grid grid-cols-5 h-15 items-center px-1">
          {/* 1. Home */}
          <button
            type="button"
            onClick={() => setActiveTab('dashboard')}
            className={`flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer py-1 min-h-[44px] ${
              activeTab === 'dashboard'
                ? 'text-[var(--pt-primary-light,#C084FC)]'
                : 'text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white'
            }`}
          >
            <LayoutGrid className="w-4 h-4 stroke-[2]" />
            <span className="text-[10px] font-mono font-bold tracking-tight leading-none uppercase">
              Home
            </span>
          </button>

          {/* 2. Orders */}
          <button
            type="button"
            onClick={() => setActiveTab('orders')}
            className={`flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer py-1 min-h-[44px] ${
              activeTab === 'orders' || activeTab === 'checklist'
                ? 'text-[var(--pt-primary-light,#C084FC)]'
                : 'text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white'
            }`}
          >
            <ClipboardList className="w-4 h-4 stroke-[2]" />
            <span className="text-[10px] font-mono font-bold tracking-tight leading-none uppercase">
              Orders
            </span>
          </button>

          {/* 3. Scan (Prominent Primary Action) */}
          <button
            type="button"
            onClick={() => setActiveTab('scanner')}
            className={`flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer py-1 min-h-[44px] ${
              activeTab === 'scanner'
                ? 'text-white'
                : 'text-[var(--pt-primary-light,#C084FC)] hover:text-white'
            }`}
            title="Launch High-Speed Scanner"
            aria-label="Scan parts"
          >
            <div
              className={`w-10 h-7 rounded-xl flex items-center justify-center transition-all ${
                activeTab === 'scanner'
                  ? 'pt-btn-primary text-white scale-105'
                  : 'bg-[var(--pt-card,#15182A)] border border-[var(--pt-primary,#A020F0)]/60 text-[var(--pt-primary-light,#C084FC)] shadow-[0_0_12px_var(--pt-glow,rgba(160,32,240,0.3))]'
              }`}
            >
              <QrCode className="w-4 h-4 stroke-[2.3]" />
            </div>
            <span className="text-[10px] font-mono font-extrabold tracking-tight leading-none uppercase">
              Scan
            </span>
          </button>

          {/* 4. Reports */}
          <button
            type="button"
            onClick={() => setActiveTab('reports')}
            className={`flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer py-1 min-h-[44px] ${
              activeTab === 'reports'
                ? 'text-[var(--pt-primary-light,#C084FC)]'
                : 'text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white'
            }`}
          >
            <BarChart3 className="w-4 h-4 stroke-[2]" />
            <span className="text-[10px] font-mono font-bold tracking-tight leading-none uppercase">
              Reports
            </span>
          </button>

          {/* 5. Settings */}
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex flex-col items-center justify-center gap-1 text-[var(--pt-text-secondary,#A3A8BD)] hover:text-white transition-colors cursor-pointer py-1 min-h-[44px]"
            title="Application Settings & Theme"
          >
            <Settings className="w-4 h-4 stroke-[2]" />
            <span className="text-[10px] font-mono font-bold tracking-tight leading-none uppercase">
              Settings
            </span>
          </button>
        </div>
      </nav>
    </>
  );
};
