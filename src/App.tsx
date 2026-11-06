import React, { useState, useEffect, useCallback } from 'react';
import { Navbar } from './components/Navbar';
import { ScannerView } from './components/ScannerView';
import { ChecklistView } from './components/ChecklistView';
import { DeliveryDashboard } from './components/DeliveryDashboard';
import { NewDeliveryModal } from './components/NewDeliveryModal';
import { DeliveriesListModal } from './components/DeliveriesListModal';
import { TestBarcodesModal } from './components/TestBarcodesModal';
import { UnexpectedPartsModal } from './components/UnexpectedPartsModal';
import { SettingsModal } from './components/SettingsModal';
import { Delivery } from './types/delivery';
import {
  getActiveDelivery,
  updateDelivery,
  processScannedCode,
  getStoredSettings,
} from './utils/storage';
import { playAudio, triggerHaptic, speakAlert } from './utils/audioFeedback';

export function App() {
  const [activeTab, setActiveTab] = useState<'scanner' | 'checklist' | 'dashboard'>('dashboard');
  const [activeDelivery, setActiveDelivery] = useState<Delivery | null>(null);
  const [checklistPalletFilter, setChecklistPalletFilter] = useState<string>('all');

  // Modals state
  const [isNewDeliveryOpen, setIsNewDeliveryOpen] = useState(false);
  const [isDeliveriesListOpen, setIsDeliveriesListOpen] = useState(false);
  const [isTestSheetOpen, setIsTestSheetOpen] = useState(false);
  const [isUnexpectedOpen, setIsUnexpectedOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const reloadDelivery = useCallback(() => {
    const current = getActiveDelivery();
    setActiveDelivery(current);
  }, []);

  useEffect(() => {
    reloadDelivery();

    const handleDeliveriesUpdate = () => reloadDelivery();
    const handleActiveChange = () => reloadDelivery();

    window.addEventListener('parttrack_deliveries_updated', handleDeliveriesUpdate);
    window.addEventListener('parttrack_active_delivery_changed', handleActiveChange);

    return () => {
      window.removeEventListener('parttrack_deliveries_updated', handleDeliveriesUpdate);
      window.removeEventListener('parttrack_active_delivery_changed', handleActiveChange);
    };
  }, [reloadDelivery]);

  const handleUpdateDelivery = (updated: Delivery) => {
    setActiveDelivery(updated);
    updateDelivery(updated);
  };

  const handleSimulateScan = (code: string) => {
    if (!activeDelivery) return;
    const { updatedDelivery, result } = processScannedCode(activeDelivery, code);
    handleUpdateDelivery(updatedDelivery);

    const settings = getStoredSettings();

    if (result.status === 'matched') {
      playAudio.success(settings.soundEnabled);
      triggerHaptic('success', settings.vibrationEnabled);
      speakAlert(`Matched ${result.part?.partNumber}`, settings.speechEnabled);
    } else if (result.status === 'duplicate') {
      playAudio.duplicate(settings.soundEnabled);
      triggerHaptic('duplicate', settings.vibrationEnabled);
      speakAlert('Duplicate scan', settings.speechEnabled);
    } else {
      playAudio.unexpected(settings.soundEnabled);
      triggerHaptic('unexpected', settings.vibrationEnabled);
      speakAlert('Unexpected part', settings.speechEnabled);
    }
  };

  const handleSelectTab = (tab: 'scanner' | 'checklist' | 'dashboard') => {
    if (tab !== 'checklist') {
      setChecklistPalletFilter('all');
    }
    setActiveTab(tab);
  };

  return (
    <div
      className={`${
        activeTab === 'scanner' ? 'h-dvh overflow-hidden' : 'min-h-dvh'
      } bg-[#F6F5F2] text-[#18181B] flex flex-col font-sans selection:bg-emerald-600/15 selection:text-emerald-950`}
    >
      {/* Top Bar & Fixed Bottom Navigation */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={handleSelectTab}
        activeDelivery={activeDelivery}
        onOpenNewDelivery={() => setIsNewDeliveryOpen(true)}
        onOpenDeliveriesList={() => setIsDeliveriesListOpen(true)}
        onOpenTestSheet={() => setIsTestSheetOpen(true)}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      {/* Main Content Area */}
      <main className="flex-1 min-h-0 flex flex-col">
        {activeTab === 'dashboard' && (
          <DeliveryDashboard
            delivery={activeDelivery}
            onUpdateDelivery={handleUpdateDelivery}
            onOpenUnexpectedModal={() => setIsUnexpectedOpen(true)}
            onOpenTestSheet={() => setIsTestSheetOpen(true)}
            onNavigateToChecklist={(pallet) => {
              setChecklistPalletFilter(pallet || 'all');
              setActiveTab('checklist');
            }}
            onStartScanning={() => setActiveTab('scanner')}
            onOpenNewDelivery={() => setIsNewDeliveryOpen(true)}
          />
        )}

        {activeTab === 'scanner' && (
          <ScannerView
            delivery={activeDelivery}
            onUpdateDelivery={handleUpdateDelivery}
            onOpenTestSheet={() => setIsTestSheetOpen(true)}
            onOpenNewDelivery={() => setIsNewDeliveryOpen(true)}
          />
        )}

        {activeTab === 'checklist' && (
          <ChecklistView
            delivery={activeDelivery}
            onUpdateDelivery={handleUpdateDelivery}
            onOpenTestSheet={() => setIsTestSheetOpen(true)}
            onOpenUnexpectedModal={() => setIsUnexpectedOpen(true)}
            initialPalletFilter={checklistPalletFilter}
            onOpenNewDelivery={() => setIsNewDeliveryOpen(true)}
          />
        )}
      </main>

      {isNewDeliveryOpen && (
        <NewDeliveryModal
          onClose={() => setIsNewDeliveryOpen(false)}
          onDeliveryCreated={(newDel) => {
            setActiveDelivery(newDel);
            setActiveTab('dashboard');
          }}
        />
      )}

      {isDeliveriesListOpen && (
        <DeliveriesListModal
          activeDeliveryId={activeDelivery?.id || null}
          onSelectDelivery={(selected) => setActiveDelivery(selected)}
          onOpenNewDelivery={() => setIsNewDeliveryOpen(true)}
          onClose={() => setIsDeliveriesListOpen(false)}
        />
      )}

      {isTestSheetOpen && (
        <TestBarcodesModal
          delivery={activeDelivery}
          onClose={() => setIsTestSheetOpen(false)}
          onSimulateScan={handleSimulateScan}
        />
      )}

      {isUnexpectedOpen && (
        <UnexpectedPartsModal
          delivery={activeDelivery}
          onClose={() => setIsUnexpectedOpen(false)}
          onUpdateDelivery={handleUpdateDelivery}
        />
      )}

      {isSettingsOpen && (
        <SettingsModal
          onClose={() => setIsSettingsOpen(false)}
          onSettingsSaved={() => reloadDelivery()}
        />
      )}
    </div>
  );
}

export default App;
