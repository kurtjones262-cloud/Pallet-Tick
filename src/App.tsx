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
import { Delivery, PendingQuantityConfirmation, UserAccount } from './types/delivery';
import {
  getActiveDelivery,
  updateDelivery,
  processScannedCode,
  getStoredSettings,
  syncDeliveriesFromCentralDatabase,
} from './utils/storage';
import { playAudio, triggerHaptic, speakAlert } from './utils/audioFeedback';
import { SplashScreen } from './components/SplashScreen';
import { OrdersView } from './components/OrdersView';
import { DuplicateScanModal, DuplicateScanModalData } from './components/DuplicateScanModal';
import { ConnectionStatusBar } from './components/ConnectionStatusBar';
import { ConnectionRequiredModal } from './components/ConnectionRequiredModal';
import { DataMigrationModal } from './components/DataMigrationModal';
import { LoginView } from './components/LoginView';
import { FirstTimeAdminSetupModal } from './components/FirstTimeAdminSetupModal';
import { UserManagementModal } from './components/UserManagementModal';
import {
  apiGetSession,
  apiLogin,
  apiLogout,
  apiCheckProvisionStatus,
  getStoredUser,
} from './services/palletTrackApi';

export function App() {
  // Phase 2 Multi-User & RBAC State
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(() => getStoredUser());
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [hasAdmin, setHasAdmin] = useState(true);
  const [isFirstTimeSetupOpen, setIsFirstTimeSetupOpen] = useState(false);
  const [isUserManagementOpen, setIsUserManagementOpen] = useState(false);

  // Application views & state
  const [activeTab, setActiveTab] = useState<'scanner' | 'checklist' | 'dashboard' | 'orders'>('dashboard');
  const [activeDelivery, setActiveDelivery] = useState<Delivery | null>(null);
  const [checklistPalletFilter, setChecklistPalletFilter] = useState<string>('all');
  const [externalPendingQuantity, setExternalPendingQuantity] =
    useState<PendingQuantityConfirmation | null>(null);
  const [isConfirmingScan, setIsConfirmingScan] = useState<boolean>(false);
  const [globalDuplicateWarning, setGlobalDuplicateWarning] =
    useState<DuplicateScanModalData | null>(null);
  const [isConnectionRequiredOpen, setIsConnectionRequiredOpen] = useState(false);
  const [isMigrationModalOpen, setIsMigrationModalOpen] = useState(false);

  // Modals state
  const [isNewDeliveryOpen, setIsNewDeliveryOpen] = useState(false);
  const [isDeliveriesListOpen, setIsDeliveriesListOpen] = useState(false);
  const [isTestSheetOpen, setIsTestSheetOpen] = useState(false);
  const [isUnexpectedOpen, setIsUnexpectedOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Startup splash screen state
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
      const current = getActiveDelivery();
      setActiveDelivery(current);
      setIsAppReady(true);
    } catch (err: any) {
      console.error('PalletTrack startup initialisation error:', err);
      setInitError(err?.message || 'Could not initialise PalletTrack storage.');
    }
  }, []);

  // Check initial authentication and provision status
  useEffect(() => {
    let isMounted = true;

    async function checkAuthStatus() {
      try {
        const prov = await apiCheckProvisionStatus();
        if (isMounted) {
          setHasAdmin(prov.hasAdmin);
          if (!prov.hasAdmin) {
            setIsFirstTimeSetupOpen(true);
            setCurrentUser(null);
            setIsCheckingAuth(false);
            return;
          }
        }

        const session = await apiGetSession();
        if (isMounted) {
          setCurrentUser(session.user);
        }
      } catch {
        // In development/preview environment, if no active session exists and the user
        // has not explicitly signed out, auto-authenticate the default terminal account
        // so the preview opens directly into the working workspace.
        let restoredUser: UserAccount | null = null;
        try {
          const explicitLogout =
            typeof sessionStorage !== 'undefined' &&
            sessionStorage.getItem('pallettrack_explicit_logout') === 'true';
          if (import.meta.env.DEV && !explicitLogout) {
            try {
              const autoRes = await apiLogin('SUPER-01', '1234');
              restoredUser = autoRes.user;
            } catch {
              const fallbackRes = await apiLogin('ADMIN-01', '1111');
              restoredUser = fallbackRes.user;
            }
          }
        } catch {
          restoredUser = null;
        }

        if (isMounted) {
          setCurrentUser(restoredUser);
        }
      } finally {
        if (isMounted) {
          setIsCheckingAuth(false);
        }
      }
    }

    checkAuthStatus();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    initAppWorkspace();

    if (currentUser) {
      // Background sync with central Cloudflare D1 database
      syncDeliveriesFromCentralDatabase()
        .then(() => reloadDelivery())
        .catch(console.warn);
    }

    const handleDeliveriesUpdate = () => reloadDelivery();
    const handleActiveChange = () => reloadDelivery();
    const handleConnectionRequired = () => setIsConnectionRequiredOpen(true);

    window.addEventListener('parttrack_deliveries_updated', handleDeliveriesUpdate);
    window.addEventListener('parttrack_active_delivery_changed', handleActiveChange);
    window.addEventListener('parttrack_connection_required', handleConnectionRequired);

    return () => {
      window.removeEventListener('parttrack_deliveries_updated', handleDeliveriesUpdate);
      window.removeEventListener('parttrack_active_delivery_changed', handleActiveChange);
      window.removeEventListener('parttrack_connection_required', handleConnectionRequired);
    };
  }, [initAppWorkspace, reloadDelivery, currentUser]);

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

  const handleLoginSuccess = (user: UserAccount) => {
    try {
      sessionStorage.removeItem('pallettrack_explicit_logout');
    } catch {}
    setCurrentUser(user);
    setHasAdmin(true);
    setIsFirstTimeSetupOpen(false);
    syncDeliveriesFromCentralDatabase()
      .then(() => reloadDelivery())
      .catch(console.warn);
  };

  const handleLogout = async () => {
    try {
      sessionStorage.setItem('pallettrack_explicit_logout', 'true');
    } catch {}
    await apiLogout();
    setCurrentUser(null);
    setActiveTab('dashboard');
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

    if (result.status === 'duplicate') {
      playAudio.duplicate(settings.soundEnabled);
      triggerHaptic('duplicate', settings.vibrationEnabled);
      speakAlert(
        `Duplicate scan: ${result.part?.partNumber || code}`,
        settings.speechEnabled
      );
      setGlobalDuplicateWarning({
        partNumber: result.part?.partNumber || code,
        description: result.part?.description || '',
        code,
        itemNumber: result.part?.itemNumber,
        palletNumber: result.part?.palletNumber,
        scannedAt: result.part?.scannedAt,
        receivedQuantity: result.part?.receivedQuantity,
      });
      return;
    }

    handleUpdateDelivery(updatedDelivery);

    if (result.status === 'matched') {
      playAudio.success(settings.soundEnabled);
      triggerHaptic('success', settings.vibrationEnabled);
      speakAlert(`Matched ${result.part?.partNumber}`, settings.speechEnabled);
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

  // If not logged in, display the PIN login screen
  if (!isCheckingAuth && !currentUser) {
    return (
      <div className="min-h-dvh bg-[#070A0F]">
        <LoginView
          onLoginSuccess={handleLoginSuccess}
          onOpenSetupAdmin={() => setIsFirstTimeSetupOpen(true)}
          hasAdmin={hasAdmin}
        />
        <FirstTimeAdminSetupModal
          isOpen={isFirstTimeSetupOpen}
          onClose={() => setIsFirstTimeSetupOpen(false)}
          onSuccess={handleLoginSuccess}
        />
      </div>
    );
  }

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

      {/* Database Connection Warning Status Bar */}
      <ConnectionStatusBar />

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
          currentUser={currentUser}
          onOpenUserManagement={() => setIsUserManagementOpen(true)}
          onLogout={handleLogout}
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

      {/* Modals */}
      {isNewDeliveryOpen && (
        <NewDeliveryModal
          onClose={() => setIsNewDeliveryOpen(false)}
          onDeliveryCreated={(newDel) => {
            setActiveDelivery(newDel);
            setActiveTab('scanner');
          }}
        />
      )}

      {isDeliveriesListOpen && (
        <DeliveriesListModal
          activeDeliveryId={activeDelivery?.id || null}
          onSelectDelivery={(selected) => setActiveDelivery(selected)}
          onOpenNewDelivery={() => setIsNewDeliveryOpen(true)}
          onOpenMigration={() => setIsMigrationModalOpen(true)}
          onClose={() => setIsDeliveriesListOpen(false)}
          userRole={currentUser?.role}
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
          onOpenMigration={() => setIsMigrationModalOpen(true)}
        />
      )}

      {globalDuplicateWarning && (
        <DuplicateScanModal
          data={globalDuplicateWarning}
          onDismiss={() => setGlobalDuplicateWarning(null)}
        />
      )}

      {/* Online-only Receiving Alert Modal */}
      <ConnectionRequiredModal
        isOpen={isConnectionRequiredOpen}
        onDismiss={() => setIsConnectionRequiredOpen(false)}
        onConnected={() => reloadDelivery()}
      />

      {/* Cloudflare D1 Migration Modal */}
      <DataMigrationModal
        isOpen={isMigrationModalOpen}
        onClose={() => setIsMigrationModalOpen(false)}
        onMigrationComplete={() => reloadDelivery()}
      />

      {/* Phase 2: Super Admin & Administrator User Management Modal */}
      {isUserManagementOpen &&
        (currentUser?.role === 'super_admin' || currentUser?.role === 'admin') && (
          <UserManagementModal
            isOpen={isUserManagementOpen}
            onClose={() => setIsUserManagementOpen(false)}
            currentUser={currentUser}
          />
        )}
    </div>
  );
}

export default App;
