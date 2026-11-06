import React from 'react';
import {
  QrCode,
  ListChecks,
  LayoutGrid,
  Plus,
  Settings,
  ChevronDown,
} from 'lucide-react';
import { Delivery } from '../types/delivery';

interface NavbarProps {
  activeTab: 'scanner' | 'checklist' | 'dashboard';
  setActiveTab: (tab: 'scanner' | 'checklist' | 'dashboard') => void;
  activeDelivery: Delivery | null;
  onOpenNewDelivery: () => void;
  onOpenDeliveriesList: () => void;
  onOpenTestSheet: () => void;
  onOpenSettings: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  activeDelivery,
  onOpenNewDelivery,
  onOpenDeliveriesList,
  onOpenSettings,
}) => {
  const total = activeDelivery?.parts.length || 0;
  const received = activeDelivery?.parts.filter((p) => p.status === 'received').length || 0;
  const remaining = total - received;

  return (
    <>
      {/* Top Bar: Minimal Native App Header */}
      <header className="sticky top-0 z-30 bg-[#F6F5F2]/95 backdrop-blur-md border-b border-[#E4E3DE] pt-safe">
        <div className="max-w-2xl mx-auto px-4 h-11 flex items-center justify-between gap-3">
          {/* Left: Brand + Delivery Selector */}
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => setActiveTab('dashboard')}
              className="flex items-center gap-1.5 shrink-0 cursor-pointer text-left"
            >
              <span className="w-2 h-2 bg-[#059669] inline-block shrink-0" />
              <span className="font-bold text-[13px] tracking-tight text-[#18181B]">
                PartTrack
              </span>
            </button>

            <span className="text-zinc-300 text-xs select-none">/</span>

            {activeDelivery ? (
              <button
                onClick={onOpenDeliveriesList}
                className="flex items-center gap-1 py-1 px-1.5 -mx-1 rounded hover:bg-black/[0.04] text-[#18181B] transition-colors text-xs font-mono font-medium truncate max-w-[160px] sm:max-w-[240px] cursor-pointer"
                title="Switch active delivery"
              >
                <span className="truncate">{activeDelivery.docketNumber}</span>
                <ChevronDown className="w-3 h-3 text-zinc-400 shrink-0" />
              </button>
            ) : (
              <button
                onClick={onOpenDeliveriesList}
                className="text-xs text-zinc-500 hover:text-zinc-900 cursor-pointer font-medium"
              >
                Select docket
              </button>
            )}
          </div>

          {/* Right: New Delivery + Settings */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={onOpenNewDelivery}
              className="h-8 px-2.5 inline-flex items-center gap-1 text-xs font-semibold text-[#059669] hover:text-[#047857] hover:bg-emerald-950/[0.04] rounded transition-colors cursor-pointer whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5 stroke-[2.2]" />
              <span>New</span>
            </button>

            <button
              onClick={onOpenSettings}
              className="w-8 h-8 inline-flex items-center justify-center text-zinc-500 hover:text-[#18181B] hover:bg-black/[0.04] rounded transition-colors cursor-pointer"
              aria-label="Settings"
              title="Settings"
            >
              <Settings className="w-4 h-4 stroke-[1.75]" />
            </button>
          </div>
        </div>
      </header>

      {/* Bottom Navigation: Minimal Fixed 3-Tab Bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-[#F6F5F2]/95 backdrop-blur-md border-t border-[#E4E3DE] pb-safe">
        <div className="max-w-2xl mx-auto grid grid-cols-3 h-12">
          {/* Tab 1: Dashboard */}
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`relative flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
              activeTab === 'dashboard'
                ? 'text-[#18181B]'
                : 'text-zinc-400 hover:text-zinc-700'
            }`}
          >
            {activeTab === 'dashboard' && (
              <span className="absolute top-0 inset-x-8 h-[2px] bg-[#18181B]" />
            )}
            <LayoutGrid className="w-4 h-4 stroke-[1.8]" />
            <span className="text-[10px] font-medium tracking-tight leading-none">
              Dashboard
            </span>
          </button>

          {/* Tab 2: Scan */}
          <button
            onClick={() => setActiveTab('scanner')}
            className={`relative flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
              activeTab === 'scanner'
                ? 'text-[#059669]'
                : 'text-zinc-400 hover:text-zinc-700'
            }`}
          >
            {activeTab === 'scanner' && (
              <span className="absolute top-0 inset-x-8 h-[2px] bg-[#059669]" />
            )}
            <QrCode className="w-4 h-4 stroke-[1.9]" />
            <span className="text-[10px] font-medium tracking-tight leading-none">
              Scan
            </span>
          </button>

          {/* Tab 3: Checklist */}
          <button
            onClick={() => setActiveTab('checklist')}
            className={`relative flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
              activeTab === 'checklist'
                ? 'text-[#18181B]'
                : 'text-zinc-400 hover:text-zinc-700'
            }`}
          >
            {activeTab === 'checklist' && (
              <span className="absolute top-0 inset-x-8 h-[2px] bg-[#18181B]" />
            )}
            <div className="relative flex items-center justify-center">
              <ListChecks className="w-4 h-4 stroke-[1.8]" />
              {remaining > 0 && (
                <span className="ml-1 text-[9px] font-mono font-semibold text-zinc-500 tabular-nums">
                  {remaining}
                </span>
              )}
            </div>
            <span className="text-[10px] font-medium tracking-tight leading-none">
              Checklist
            </span>
          </button>
        </div>
      </nav>
    </>
  );
};
