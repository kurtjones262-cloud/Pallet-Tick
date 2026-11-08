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
import { Delivery, PendingQuantityConfirmation } from './types/delivery';
import {
  getActiveDelivery,
  updateDelivery,
  processScannedCode,
  getStoredSettings,
} from './utils/storage';
import { playAudio, triggerHaptic, speakAlert } from './utils/audioFeedback';
import { SplashScreen } from './components/SplashScreen';
import { OrdersView } from './components/OrdersView';

export function App() {
  const [activeTab, setActiveTab] = useState<'scanner' | 'checklist' | 'dashboard' | 'orders'>('dashboard');
  const [activeDelivery, setActiveDelivery] = useState<Delivery | null>(null);
  const [checklistPalletFilter, setChecklistPalletFilter] = useState<string>('all');
  const [externalPendingQuantity, setExternalPendingQuantity] =
    useState<PendingQuantityConfirmation | null>(null);
  const [isConfirmingScan, setIsConfirmingScan] = useState<boolean>(false);

  // Modals state
  const [isNewDeliveryOpen, setIsNewDeliveryOpen] = useState(false);
  const [isDeliveriesListOpen, setIsDeliveriesListOpen] = useState(false);
  const [isTestSheetOpen, setIsTestSheetOpen] = useState(false);
  const [isUnexpectedOpen, setIsUnexpectedOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Startup splash screen initialisation state
  const [isAppReady, setIsAppReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [showSplash, setShowSplash] = useState(true);

  const reloadDelivery = useCallback(() => {
    const current = getActiveDelivery();
    setActiveDelivery(current);
  }, []);

  const initAppWorkspace = useCallback(() => {
    try {
      setInitError(null);
      // Essential initialisation: load delivery data and stored state
      const current = getActiveDelivery();
      setActiveDelivery(current);
      setIsAppReady(true);
    } catch (err: any) {
      console.error('PalletTick startup initialisation error:', err);
      setInitError(err?.message || 'Could not initialise PalletTick storage.');
    }
  }, []);

  useEffect(() => {
    initAppWorkspace();

    const handleDeliveriesUpdate = () => reloadDelivery();
    const handleActiveChange = () => reloadDelivery();

    window.addEventListener('parttrack_deliveries_updated', handleDeliveriesUpdate);
    window.addEventListener('parttrack_active_delivery_changed', handleActiveChange);

    return () => {
      window.removeEventListener('parttrack_deliveries_updated', handleDeliveriesUpdate);
      window.removeEventListener('parttrack_active_delivery_changed', handleActiveChange);
    };
  }, [initAppWorkspace, reloadDelivery]);

  // Global Ctrl+K / Cmd+K focuses search bar in Orders
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setActiveTab('orders');
        setTimeout(() => {
          const searchInput = document.getElementById('orders-smart-search-input') as HTMLInputElement | null;
          searchInput?.focus();
          searchInput?.select();
        }, 60);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleUpdateDelivery = (updated: Delivery) => {
    setActiveDelivery(updated);
    updateDelivery(updated);
  };

  const handleSimulateScan = (code: string) => {
    if (!activeDelivery) return;
    const { updatedDelivery, result } = processScannedCode(activeDelivery, code);
    const settings = getStoredSettings();

    if (result.status === 'requires_quantity' && result.pendingQuantityConfirmation) {
      playAudio.success(settings.soundEnabled);
      triggerHaptic('success', settings.vibrationEnabled);
      speakAlert(
        `Enter quantity for ${result.pendingQuantityConfirmation.part.partNumber}`,
        settings.speechEnabled
      );
      setIsTestSheetOpen(false);
      setExternalPendingQuantity(result.pendingQuantityConfirmation);
      setActiveTab('scanner');
      return;
    }

    handleUpdateDelivery(updatedDelivery);

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

  const handleSelectTab = (tab: 'scanner' | 'checklist' | 'dashboard' | 'orders') => {
    if (tab !== 'checklist') {
      setChecklistPalletFilter('all');
    }
    setActiveTab(tab);
  };

  return (
    <div
      className={`${
        activeTab === 'scanner' ? 'h-dvh overflow-hidden' : 'min-h-dvh'
      } bg-[#070A0F] text-slate-100 flex flex-col font-sans selection:bg-cyan-500/20 selection:text-cyan-200`}
    >
      {/* Startup Splash Screen */}
      {showSplash && (
        <SplashScreen
          isReady={isAppReady}
          error={initError}
          onRetry={initAppWorkspace}
          onTransitionComplete={() => setShowSplash(false)}
        />
      )}

      {/* Top Bar & Fixed Bottom Navigation (hidden when confirming scan) */}
      {!isConfirmingScan && (
        <Navbar
          activeTab={activeTab}
          setActiveTab={handleSelectTab}
          activeDelivery={activeDelivery}
          onUpdateDelivery={handleUpdateDelivery}
          onOpenNewDelivery={() => setIsNewDeliveryOpen(true)}
          onOpenDeliveriesList={() => setIsDeliveriesListOpen(true)}
          onOpenTestSheet={() => setIsTestSheetOpen(true)}
          onOpenSettings={() => setIsSettingsOpen(true)}
        />
      )}

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
            onNavigateToOrders={() => setActiveTab('orders')}
            onStartScanning={() => setActiveTab('scanner')}
            onOpenNewDelivery={() => setIsNewDeliveryOpen(true)}
            onOpenDeliveriesList={() => setIsDeliveriesListOpen(true)}
            onOpenSettings={() => setIsSettingsOpen(true)}
          />
        )}

        {activeTab === 'orders' && (
          <OrdersView
            activeDelivery={activeDelivery}
            onSelectDelivery={handleUpdateDelivery}
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
            externalPendingQuantity={externalPendingQuantity}
            onClearExternalPendingQuantity={() => setExternalPendingQuantity(null)}
            onScanConfirmationChange={setIsConfirmingScan}
            onClose={() => setActiveTab('dashboard')}
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
            // Automatically navigate to the scanner screen once the compiled parts list is confirmed!
            setActiveTab('scanner');
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
