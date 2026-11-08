import React from 'react';
import {
  QrCode,
  LayoutGrid,
  ClipboardList,
  Settings,
  ChevronDown,
} from 'lucide-react';
import { Delivery } from '../types/delivery';

interface NavbarProps {
  activeTab: 'scanner' | 'checklist' | 'dashboard' | 'orders';
  setActiveTab: (tab: 'scanner' | 'checklist' | 'dashboard' | 'orders') => void;
  activeDelivery: Delivery | null;
  onUpdateDelivery?: (updated: Delivery) => void;
  onOpenNewDelivery?: () => void;
  onOpenDeliveriesList: () => void;
  onOpenTestSheet?: () => void;
  onOpenSettings: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  activeDelivery,
  onOpenDeliveriesList,
  onOpenSettings,
}) => {
  const total = activeDelivery?.parts.length || 0;
  const received = activeDelivery?.parts.filter((p) => p.status === 'received').length || 0;

  return (
    <>
      {/* =========================================================================
       * TOP BAR: Premium Dark Industrial Native Header
       * ========================================================================= */}
      <header className="sticky top-0 z-30 bg-[#070A0F]/95 backdrop-blur-md border-b border-[#1E2D44] pt-safe">
        <div className="max-w-6xl mx-auto px-3 sm:px-6 h-12 flex items-center justify-between gap-3">
          {/* Left: Brand + Active Docket Selector */}
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => setActiveTab('dashboard')}
              className="flex items-center gap-2 shrink-0 cursor-pointer text-left group"
              title="PalletTrack Home Dashboard"
            >
              <div className="w-6 h-6 rounded-md overflow-hidden bg-black border border-cyan-500/30 shadow-[0_0_8px_rgba(0,168,255,0.3)] group-hover:scale-105 transition-transform">
                <img
                  src="/pallettrack-icon.png"
                  alt="PalletTrack"
                  className="w-full h-full object-cover"
                />
              </div>
              <span className="font-bold text-sm tracking-tight text-white font-sans">
                PalletTrack
              </span>
            </button>

            <span className="text-slate-600 text-xs select-none">/</span>

            {activeDelivery ? (
              <button
                onClick={onOpenDeliveriesList}
                className="flex items-center gap-1.5 py-1 px-2 rounded-md hover:bg-white/5 text-slate-200 transition-colors text-xs font-mono font-medium truncate max-w-[130px] sm:max-w-[240px] cursor-pointer border border-transparent hover:border-[#1E2D44]"
                title="Switch active delivery docket"
              >
                <span className="truncate">{activeDelivery.docketNumber}</span>
                <span className="text-[10px] text-slate-400 hidden sm:inline">({activeDelivery.supplier})</span>
                <ChevronDown className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              </button>
            ) : (
              <button
                onClick={onOpenDeliveriesList}
                className="text-xs text-slate-400 hover:text-white cursor-pointer font-mono font-medium truncate flex items-center gap-1 py-1 px-2 rounded hover:bg-white/5"
              >
                <span>Select docket</span>
                <ChevronDown className="w-3 h-3 text-slate-500" />
              </button>
            )}
          </div>

          {/* Right: Quick Action & Settings */}
          <div className="flex items-center gap-2 shrink-0">
            {activeDelivery && (
              <div className="hidden sm:flex items-center gap-1.5 text-xs font-mono px-2 py-0.5 rounded-md bg-[#0E1626] border border-[#1E2D44] text-slate-300">
                <span className="text-cyan-400 font-bold">{received}</span>
                <span className="text-slate-500">/</span>
                <span>{total}</span>
                <span className="text-slate-500 text-[10px] uppercase">rcvd</span>
              </div>
            )}

            <button
              onClick={onOpenSettings}
              className="w-8 h-8 inline-flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors cursor-pointer border border-transparent hover:border-[#1E2D44]"
              aria-label="Settings"
              title="Settings & System Configurations"
            >
              <Settings className="w-4 h-4 stroke-[1.75]" />
            </button>
          </div>
        </div>
      </header>

      {/* =========================================================================
       * BOTTOM NAVIGATION: Clean 4-Tab Mobile & Tablet Layout
       * [ Home · Orders · Scan · Settings ]
       * ========================================================================= */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-[#0A0F1A]/95 backdrop-blur-md border-t border-[#1E2D44] pb-safe shadow-[0_-4px_20px_rgba(0,0,0,0.5)]">
        <div className="max-w-md mx-auto grid grid-cols-4 h-14 items-center px-1">

          {/* 1. Home */}
          <button
            type="button"
            onClick={() => setActiveTab('dashboard')}
            className={`flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer py-1 ${
              activeTab === 'dashboard'
                ? 'text-cyan-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <LayoutGrid className="w-4 h-4 stroke-[1.9]" />
            <span className="text-[10px] font-mono font-bold tracking-tight leading-none uppercase">
              Home
            </span>
          </button>

          {/* 2. Orders */}
          <button
            type="button"
            onClick={() => setActiveTab('orders')}
            className={`flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer py-1 ${
              activeTab === 'orders'
                ? 'text-cyan-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <ClipboardList className="w-4 h-4 stroke-[1.9]" />
            <span className="text-[10px] font-mono font-bold tracking-tight leading-none uppercase">
              Orders
            </span>
          </button>

          {/* 3. Scan */}
          <button
            type="button"
            onClick={() => setActiveTab('scanner')}
            className={`flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer py-1 ${
              activeTab === 'scanner'
                ? 'text-cyan-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
            title="Launch High-Speed Scanner"
            aria-label="Scan parts"
          >
            <div
              className={`w-8 h-7 rounded-lg flex items-center justify-center transition-all ${
                activeTab === 'scanner'
                  ? 'bg-cyan-500 text-black shadow-[0_0_12px_rgba(0,168,255,0.5)]'
                  : 'bg-cyan-950/70 border border-cyan-500/40 text-cyan-400'
              }`}
            >
              <QrCode className="w-4 h-4 stroke-[2.2]" />
            </div>
            <span className="text-[10px] font-mono font-bold tracking-tight leading-none uppercase">
              Scan
            </span>
          </button>

          {/* 4. Settings */}
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex flex-col items-center justify-center gap-1 text-slate-400 hover:text-slate-200 transition-colors cursor-pointer py-1"
            title="Application Settings"
          >
            <Settings className="w-4 h-4 stroke-[1.9]" />
            <span className="text-[10px] font-mono font-bold tracking-tight leading-none uppercase">
              Settings
            </span>
          </button>

        </div>
      </nav>
    </>
  );
};
