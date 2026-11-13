import React, { useState, useEffect, useCallback } from 'react';
import { Navbar, NavTabId } from './components/Navbar';
import { ScannerView } from './components/ScannerView';
import { ChecklistView } from './components/ChecklistView';
import { DeliveryDashboard } from './components/DeliveryDashboard';
import { NewDeliveryModal } from './components/NewDeliveryModal';
import { DeliveriesListModal } from './components/DeliveriesListModal';
import { TestBarcodesModal } from './components/TestBarcodesModal';
import { UnexpectedPartsModal } from './components/UnexpectedPartsModal';
import { SettingsModal } from './components/SettingsModal';
import { ReportsView } from './components/ReportsView';
import {
  Delivery,
  DocketGroup,
  PendingQuantityConfirmation,
  UserAccount,
} from './types/delivery';
import {
  getActiveDelivery,
  getStoredDeliveries,
  setActiveDeliveryId,
  updateDelivery,
  processScannedCode,
  getStoredSettings,
  syncDeliveriesFromCentralDatabase,
  applyRealtimeEventToDeliveries,
  commitScanPartAuthoritative,
} from './utils/storage';
import { playAudio, triggerHaptic, speakAlert } from './utils/audioFeedback';
import { isIgnoredNonPartQrPayload } from './utils/ignoredQrCodes';
import { SplashScreen } from './components/SplashScreen';
import { OrdersView } from './components/OrdersView';
import { DocketGroupsView } from './components/DocketGroupsView';
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
  apiListGroups,
  getStoredUser,
  getAuthToken,
  setAuthToken,
  setStoredUser,
} from './services/palletTrackApi';
import { realtimeClient } from './services/realtimeSync';
import {
  getStoredTheme,
  getStoredThemeMode,
  applyThemeToDocument,
} from './config/theme';

export type ScanScopeContext =
  | { mode: 'delivery'; deliveryId: string }
  | { mode: 'group'; groupId: string }
  | null;

export function App() {
  // Phase 2 Multi-User & RBAC State
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(() => getStoredUser());
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [hasAdmin, setHasAdmin] = useState(true);
  const [isFirstTimeSetupOpen, setIsFirstTimeSetupOpen] = useState(false);
  const [isUserManagementOpen, setIsUserManagementOpen] = useState(false);

  // Application views & state
  const [activeTab, setActiveTab] = useState<NavTabId>('dashboard');
  const [deliveries, setDeliveries] = useState<Delivery[]>(() => getStoredDeliveries());
  const [activeDelivery, setActiveDelivery] = useState<Delivery | null>(null);
  const [groups, setGroups] = useState<DocketGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [scanContext, setScanContext] = useState<ScanScopeContext>(null);
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

  // Apply stored PartTrack colour theme + Dark/Light mode immediately and whenever the active user changes
  useEffect(() => {
    const userKey = currentUser?.id || currentUser?.employeeCode || null;
    const themeId = getStoredTheme(userKey);
    const mode = getStoredThemeMode(userKey);
    applyThemeToDocument(themeId, mode);
  }, [currentUser]);

  const reloadDelivery = useCallback(() => {
    const all = getStoredDeliveries();
    const current = getActiveDelivery();
    setDeliveries(all);
    setActiveDelivery(current);
  }, []);

  const refreshGroups = useCallback(async () => {
    if (!currentUser) return;
    try {
      const list = await apiListGroups();
      setGroups(list);
    } catch {
      // Keep cached groups on transient network issues
    }
  }, [currentUser]);

  const initAppWorkspace = useCallback(() => {
    try {
      setInitError(null);
      const all = getStoredDeliveries();
      const current = getActiveDelivery();
      setDeliveries(all);
      setActiveDelivery(current);
      setIsAppReady(true);
    } catch (err: any) {
      console.error('PartTrack startup initialisation error:', err);
      setInitError(err?.message || 'Could not initialise PartTrack storage.');
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
      } catch (err: any) {
        const isExplicitUnauthorized = err?.status === 401 || err?.status === 403;
        const cachedUser = getStoredUser();
        const cachedToken = getAuthToken();

        // If a transient network error or 5xx occurred while the worker already has a cached session,
        // preserve their session so they are not logged out during brief connectivity drops.
        if (!isExplicitUnauthorized && cachedUser && cachedToken) {
          if (isMounted) {
            setCurrentUser(cachedUser);
          }
          return;
        }

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
      refreshGroups().catch(() => {});

      // Start live multi-user WebSocket synchronisation
      realtimeClient.start(getActiveDelivery()?.id || null);
    } else {
      realtimeClient.stop();
    }

    const unsubRealtimeEvent = realtimeClient.onEvent((event) => {
      if (event.type === 'deliveries:cleared') {
        setGroups([]);
        setSelectedGroupId(null);
        setScanContext(null);
      }
      if (
        event.type === 'group:created' ||
        event.type === 'group:updated' ||
        event.type === 'group:deleted' ||
        event.type === 'delivery:deleted'
      ) {
        refreshGroups().catch(() => {});
      }
      const { changed } = applyRealtimeEventToDeliveries(getStoredDeliveries(), event);
      if (changed) {
        reloadDelivery();
      }
    });

    const unsubAuthRevoked = realtimeClient.onAuthRevoked(() => {
      realtimeClient.stop();
      setAuthToken(null);
      setStoredUser(null);
      setCurrentUser(null);
      setScanContext(null);
      setActiveTab('dashboard');
    });

    const handleDeliveriesUpdate = () => reloadDelivery();
    const handleActiveChange = () => reloadDelivery();
    const handleConnectionRequired = () => setIsConnectionRequiredOpen(true);

    window.addEventListener('parttrack_deliveries_updated', handleDeliveriesUpdate);
    window.addEventListener('parttrack_active_delivery_changed', handleActiveChange);
    window.addEventListener('parttrack_connection_required', handleConnectionRequired);

    return () => {
      unsubRealtimeEvent();
      unsubAuthRevoked();
      window.removeEventListener('parttrack_deliveries_updated', handleDeliveriesUpdate);
      window.removeEventListener('parttrack_active_delivery_changed', handleActiveChange);
      window.removeEventListener('parttrack_connection_required', handleConnectionRequired);
    };
  }, [initAppWorkspace, reloadDelivery, refreshGroups, currentUser]);

  // Keep active delivery room and worker status synchronised across tabs/deliveries
  useEffect(() => {
    if (!currentUser) return;
    const workerStatus =
      activeTab === 'scanner' ? 'scanning' : activeDelivery ? 'viewing' : 'dashboard';
    realtimeClient.joinDeliveryRoom(activeDelivery?.id || null, workerStatus);
  }, [currentUser, activeDelivery?.id, activeTab]);

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
    setDeliveries(getStoredDeliveries());
  };

  const openScopedScanner = useCallback(
    (scope: NonNullable<ScanScopeContext>) => {
      if (scope.mode === 'delivery') {
        const target =
          getStoredDeliveries().find((d) => d.id === scope.deliveryId) || activeDelivery;
        if (!target) return;
        setActiveDeliveryId(target.id);
        setActiveDelivery(target);
      }
      setScanContext(scope);
      setActiveTab('scanner');
    },
    [activeDelivery]
  );

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
    realtimeClient.stop();
    await apiLogout();
    setCurrentUser(null);
    setScanContext(null);
    setActiveTab('dashboard');
  };

  const handleSimulateScan = async (code: string) => {
    if (!activeDelivery) return;
    if (isIgnoredNonPartQrPayload(code)) return;
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
        scannedBy: result.part?.lastScannedByName,
      });
      return;
    }

    if (result.status === 'matched' && result.part) {
      const authRes = await commitScanPartAuthoritative(
        activeDelivery,
        {
          part: result.part,
          code,
          detectedType: result.detectedType,
          matchedMode: result.detectedType === 'barcode' ? 'docket-no' : 'exact-part',
        },
        result.part.receivedQuantity ?? result.part.quantity ?? 1,
        { mode: 'set' }
      );
      if (authRes.outcome === 'duplicate') {
        playAudio.duplicate(settings.soundEnabled);
        triggerHaptic('duplicate', settings.vibrationEnabled);
        speakAlert(
          `Duplicate scan: ${result.part.partNumber}`,
          settings.speechEnabled
        );
        setGlobalDuplicateWarning({
          partNumber: result.part.partNumber,
          description: result.part.description || '',
          code,
          itemNumber: result.part.itemNumber,
          palletNumber: result.part.palletNumber,
          scannedAt: authRes.alreadyScannedAt || result.part.scannedAt,
          receivedQuantity: result.part.receivedQuantity,
          scannedBy: authRes.alreadyScannedBy || result.part.lastScannedByName,
          customMessage: authRes.message,
        });
        return;
      }
      handleUpdateDelivery(authRes.updatedDelivery);
      playAudio.success(settings.soundEnabled);
      triggerHaptic('success', settings.vibrationEnabled);
      speakAlert(`Matched ${result.part.partNumber}`, settings.speechEnabled);
    } else {
      handleUpdateDelivery(updatedDelivery);
      playAudio.unexpected(settings.soundEnabled);
      triggerHaptic('unexpected', settings.vibrationEnabled);
      speakAlert('Unexpected part', settings.speechEnabled);
    }
  };

  const handleSelectTab = (tab: NavTabId) => {
    if (tab !== 'checklist') {
      setChecklistPalletFilter('all');
    }
    if (tab !== 'scanner') {
      setScanContext(null);
    }
    setActiveTab(tab);
  };

  // If not logged in, display the PIN login screen
  if (!isCheckingAuth && !currentUser) {
    return (
      <div className="min-h-dvh bg-[var(--pt-bg)]">
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
      } bg-[var(--pt-bg)] text-white flex flex-col font-sans`}
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
            onNavigateToGroups={() => setActiveTab('groups')}
            onNavigateToReports={() => setActiveTab('reports')}
            groupsCount={groups.length}
            onOpenNewDelivery={() => setIsNewDeliveryOpen(true)}
            onOpenDeliveriesList={() => setIsDeliveriesListOpen(true)}
            onOpenSettings={() => setIsSettingsOpen(true)}
            onOpenUserManagement={() => setIsUserManagementOpen(true)}
            onLogout={handleLogout}
            currentUser={currentUser}
          />
        )}

        {activeTab === 'orders' && (
          <OrdersView
            activeDelivery={activeDelivery}
            onSelectDelivery={(del) => {
              setActiveDeliveryId(del.id);
              setActiveDelivery(del);
            }}
            onUpdateDelivery={handleUpdateDelivery}
            onDeleteDelivery={() => {
              reloadDelivery();
              refreshGroups().catch(() => {});
            }}
            onClearAllDockets={() => {
              setGroups([]);
              setSelectedGroupId(null);
              setScanContext(null);
              reloadDelivery();
            }}
            onOpenChecklist={(del) => {
              setActiveDeliveryId(del.id);
              setActiveDelivery(del);
              setChecklistPalletFilter('all');
              setActiveTab('checklist');
            }}
            onNavigateToChecklist={(pallet?: string) => {
              setChecklistPalletFilter(pallet || 'all');
              setActiveTab('checklist');
            }}
            onStartScanning={(del) => {
              const target = del || activeDelivery;
              if (target) {
                openScopedScanner({ mode: 'delivery', deliveryId: target.id });
              }
            }}
            onOpenNewDelivery={() => setIsNewDeliveryOpen(true)}
            userRole={currentUser?.role}
          />
        )}

        {activeTab === 'groups' && (
          <DocketGroupsView
            groups={groups}
            deliveries={deliveries}
            selectedGroupId={selectedGroupId}
            onSelectGroup={setSelectedGroupId}
            onGroupsChanged={setGroups}
            onOpenDelivery={(del) => {
              setActiveDeliveryId(del.id);
              setActiveDelivery(del);
              setChecklistPalletFilter('all');
              setActiveTab('checklist');
            }}
            onScanGroup={(groupId) => {
              openScopedScanner({ mode: 'group', groupId });
            }}
            userRole={currentUser?.role}
          />
        )}

        {activeTab === 'reports' && (
          <ReportsView
            activeDelivery={activeDelivery}
            groups={groups}
            onSelectDelivery={(del) => {
              setActiveDeliveryId(del.id);
              setActiveDelivery(del);
            }}
            onOpenOrderDetails={(del) => {
              setActiveDeliveryId(del.id);
              setActiveDelivery(del);
              setChecklistPalletFilter('all');
              setActiveTab('checklist');
            }}
          />
        )}

        {activeTab === 'scanner' && scanContext && (
          <ScannerView
            scanScope={scanContext}
            delivery={
              scanContext.mode === 'delivery'
                ? deliveries.find((d) => d.id === scanContext.deliveryId) || activeDelivery
                : activeDelivery
            }
            group={
              scanContext.mode === 'group'
                ? groups.find((g) => g.id === scanContext.groupId) || null
                : null
            }
            groupDeliveries={
              scanContext.mode === 'group'
                ? (() => {
                    const g = groups.find((item) => item.id === scanContext.groupId);
                    if (!g) return [];
                    const idSet = new Set(g.deliveryIds || []);
                    return deliveries.filter((d) => idSet.has(d.id));
                  })()
                : []
            }
            onUpdateDelivery={handleUpdateDelivery}
            onOpenTestSheet={() => setIsTestSheetOpen(true)}
            onOpenNewDelivery={() => setIsNewDeliveryOpen(true)}
            externalPendingQuantity={externalPendingQuantity}
            onClearExternalPendingQuantity={() => setExternalPendingQuantity(null)}
            onScanConfirmationChange={setIsConfirmingScan}
            onClose={() => {
              const returnTab = scanContext.mode === 'group' ? 'groups' : 'checklist';
              setScanContext(null);
              setActiveTab(returnTab);
            }}
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
            onStartScanning={() => {
              if (activeDelivery) {
                openScopedScanner({ mode: 'delivery', deliveryId: activeDelivery.id });
              }
            }}
            onDeleteDelivery={() => {
              reloadDelivery();
              refreshGroups().catch(() => {});
              setActiveTab('orders');
            }}
            onNavigateToOrders={() => setActiveTab('orders')}
            userRole={currentUser?.role}
          />
        )}
      </main>

      {/* Modals */}
      {isNewDeliveryOpen && (
        <NewDeliveryModal
          onClose={() => setIsNewDeliveryOpen(false)}
          onDeliveryCreated={(created) => {
            const createdList = Array.isArray(created) ? created : [created];
            reloadDelivery();
            if (createdList.length > 1) {
              setActiveDeliveryId(createdList[0].id);
              setActiveDelivery(createdList[0]);
              setActiveTab('orders');
            } else if (createdList[0]) {
              setActiveDeliveryId(createdList[0].id);
              setActiveDelivery(createdList[0]);
              setChecklistPalletFilter('all');
              setActiveTab('checklist');
            }
          }}
        />
      )}

      {isDeliveriesListOpen && (
        <DeliveriesListModal
          activeDeliveryId={activeDelivery?.id || null}
          onSelectDelivery={(selected) => {
            setActiveDeliveryId(selected.id);
            setActiveDelivery(selected);
            setChecklistPalletFilter('all');
            setActiveTab('checklist');
          }}
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
          onSettingsSaved={() => {
            reloadDelivery();
            refreshGroups().catch(() => {});
          }}
          onAllDocketsCleared={() => {
            setGroups([]);
            setSelectedGroupId(null);
            setScanContext(null);
            reloadDelivery();
          }}
          onOpenMigration={() => setIsMigrationModalOpen(true)}
          currentUser={currentUser}
          onOpenUserManagement={() => setIsUserManagementOpen(true)}
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
