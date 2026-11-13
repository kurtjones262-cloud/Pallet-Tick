import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import {
  Camera,
  Flashlight,
  FlipHorizontal,
  Keyboard,
  X,
  Check,
  QrCode,
  Barcode,
  RefreshCw,
  FileText,
  FolderOpen,
  Images,
  ArrowLeft,
  AlertTriangle,
  Tag,
  FolderKanban,
} from 'lucide-react';
import {
  Delivery,
  DeliveryPart,
  DocketGroup,
  GroupScanConflictCandidate,
  ScanFeedback,
  PendingQuantityConfirmation,
  SupplierRuleId,
  ScanEvent,
  ScanMethod,
} from '../types/delivery';
import {
  parseBarcodeDocketNo,
  getDeliverySupplierRule,
  setDeliverySupplierRule,
  getPreferredSupplierRuleId,
  setPreferredSupplierRuleId,
  SUPPLIER_RULES,
  getStoredSettings,
  getStoredDeliveries,
  saveStoredDeliveries,
  findMatchingPartsInDelivery,
  findMatchingPartsInGroup,
  commitScanPartAuthoritative,
} from '../utils/storage';
import { apiScanGroupPart, isBackendOnline } from '../services/palletTrackApi';
import { realtimeClient } from '../services/realtimeSync';

import {
  recognizePalletLabelOffline,
  evaluatePalletLabelMatch,
  prewarmPalletLabelOcrEngine,
  computeVideoFrameSignature,
  computeFrameSignatureDifference,
} from '../utils/palletLabelOcr';
import {
  CAMERA_PROFILES,
  ScanMode,
  rankRearVideoDevices,
  applyCameraProfileToTrack,
  triggerCameraRefocusPulse,
  createVerifiedNativeBarcodeDetector,
  decodeStillImageOrVideoFrameBarcodes,
} from '../utils/cameraManager';
import {
  ScanConfirmationModal,
  ActiveScanData,
  ConfirmedScanPayload,
  ScanMethodType,
} from './ScanConfirmationModal';
import { DuplicateScanModal, DuplicateScanModalData } from './DuplicateScanModal';
import { detectDuplicateScan } from '../utils/duplicateDetection';
import { playAudio, triggerHaptic, speakAlert } from '../utils/audioFeedback';
import { filterPartsSmart, HighlightMatch } from '../utils/partSearch';
import {
  isIgnoredNonPartQrPayload,
  filterOutIgnoredQrDetections,
} from '../utils/ignoredQrCodes';

export type ScanInputSource = 'camera_barcode_qr' | 'external_hid' | 'photo_snap' | 'manual';

const SELECTED_CAMERA_STORAGE_KEY = 'pallettick_selected_camera_id_v2';

type DiagnosticCategory = 'camera' | 'barcode_qr' | 'ocr' | 'external_hid' | 'error';

interface GroupScanConflictModalState {
  rawCode: string;
  scanMethod: ScanMethodType;
  detectedQuantity: number;
  rawOcrText?: string;
  candidates: GroupScanConflictCandidate[];
}

interface ScannerViewProps {
  scanScope?: { mode: 'delivery'; deliveryId: string } | { mode: 'group'; groupId: string };
  delivery: Delivery | null;
  group?: DocketGroup | null;
  groupDeliveries?: Delivery[];
  onUpdateDelivery: (updated: Delivery) => void;
  onOpenTestSheet?: () => void;
  onOpenNewDelivery?: () => void;
  externalPendingQuantity?: PendingQuantityConfirmation | null;
  onClearExternalPendingQuantity?: () => void;
  onScanConfirmationChange?: (isOpen: boolean) => void;
  onClose?: () => void;
}

export const ScannerView: React.FC<ScannerViewProps> = ({
  scanScope,
  delivery,
  group = null,
  groupDeliveries = [],
  onUpdateDelivery,
  externalPendingQuantity,
  onClearExternalPendingQuantity,
  onScanConfirmationChange,
  onClose,
}) => {
  // Live camera stream state
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [availableCameras, setAvailableCameras] = useState<Array<{ id: string; label: string }>>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      try {
        return localStorage.getItem(SELECTED_CAMERA_STORAGE_KEY) || '';
      } catch {}
    }
    return '';
  });
  const [actualCameraInfo, setActualCameraInfo] = useState<{
    cameraProfile?: string;
    width: number;
    height: number;
    frameRate?: number;
    focusMode?: string;
    supportedFocusModes?: string[];
    exposureMode?: string;
    whiteBalanceMode?: string;
    deviceLabel?: string;
    decodeMethod?: string;
    scanFrequencyHz?: number;
    scanIntervalMs?: number;
    avgDecodeTimeMs?: number;
    lastDecodeTimeMs?: number;
    lastRecognitionTimeMs?: number | null;
    lastRecognitionTimestamp?: string | null;
    attemptsBeforeLastSuccess?: number;
    currentAttemptCount?: number;
    multipleDecodersActive?: boolean;
    concurrentDecodersCount?: number;
    streamStatus?: string;
  } | null>(null);
  const [showDiagnosticsHud, setShowDiagnosticsHud] = useState<boolean>(false);

  // Torch & zoom state
  const [torchOn, setTorchOn] = useState<boolean>(false);
  const [hasTorch, setHasTorch] = useState<boolean>(false);
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [supportsHardwareZoom, setSupportsHardwareZoom] = useState<boolean>(false);
  const [minHardwareZoom, setMinHardwareZoom] = useState<number>(1);
  const [maxHardwareZoom, setMaxHardwareZoom] = useState<number>(4);
  const [focusRingPos, setFocusRingPos] = useState<{ x: number; y: number } | null>(null);

  // UNIFIED SCAN CONFIRMATION STATE (locks/pauses camera detection while open)
  const [activeScanConfirmation, setActiveScanConfirmation] = useState<ActiveScanData | null>(null);

  // STRICT DUPLICATE SCAN WARNING STATE (prominent RED warning popup)
  const [activeDuplicateWarning, setActiveDuplicateWarning] = useState<DuplicateScanModalData | null>(null);

  // DOCKET GROUP PART ALLOCATION MODAL (when >1 member docket contains the scanned part)
  const [groupConflictModal, setGroupConflictModal] = useState<GroupScanConflictModalState | null>(
    null
  );

  // Notify parent container so global menu bars are hidden while confirming a scan or resolving conflict
  useEffect(() => {
    onScanConfirmationChange?.(
      activeScanConfirmation !== null ||
        activeDuplicateWarning !== null ||
        groupConflictModal !== null
    );
    return () => {
      onScanConfirmationChange?.(false);
    };
  }, [activeScanConfirmation, activeDuplicateWarning, groupConflictModal, onScanConfirmationChange]);

  // Announce active scanning status to real-time room while ScannerView is mounted
  useEffect(() => {
    const activeTargetId =
      scanScope?.mode === 'group' ? groupDeliveries[0]?.id || delivery?.id : delivery?.id;
    if (activeTargetId) {
      realtimeClient.joinDeliveryRoom(activeTargetId, 'scanning');
    }
    return () => {
      if (activeTargetId) {
        realtimeClient.setWorkerStatus('viewing');
      }
    };
  }, [delivery?.id, scanScope?.mode, groupDeliveries]);

  // App Settings (sound, vibration, speech)
  const [appSettings] = useState(() => getStoredSettings());

  // Real-time concurrent scan guard: if another worker completes scanning the exact part
  // that this worker currently has open in the Scan Confirmation sheet, immediately alert!
  useEffect(() => {
    if (!activeScanConfirmation?.matchedPart) return;
    const targetDel = activeScanConfirmation.targetDeliveryId
      ? groupDeliveries.find((d) => d.id === activeScanConfirmation.targetDeliveryId) || delivery
      : delivery;
    if (!targetDel) return;
    const livePart = targetDel.parts.find(
      (p) => p.id === activeScanConfirmation.matchedPart?.id
    );
    if (
      livePart &&
      livePart.status === 'received' &&
      (livePart.receivedQuantity ?? 0) >= Math.max(1, livePart.quantity ?? 1)
    ) {
      activeScanConfirmationRef.current = null;
      setActiveScanConfirmation(null);
      playAudio.duplicate(appSettings.soundEnabled);
      triggerHaptic('duplicate', appSettings.vibrationEnabled);
      triggerVisualFlash('red');
      const dupData: DuplicateScanModalData = {
        partNumber: livePart.partNumber,
        description: livePart.description,
        code: activeScanConfirmation.rawCode,
        itemNumber: livePart.itemNumber,
        palletNumber: livePart.palletNumber,
        scannedAt: livePart.scannedAt,
        scannedBy: livePart.lastScannedByName || 'Another worker',
        customMessage:
          'Duplicate scan – this part has already been received by another worker',
        receivedQuantity: livePart.receivedQuantity,
      };
      activeDuplicateWarningRef.current = dupData;
      setActiveDuplicateWarning(dupData);
    }
  }, [delivery, groupDeliveries, activeScanConfirmation, appSettings]);

  // Status and feedback states
  const [scanFeedback, setScanFeedback] = useState<ScanFeedback | null>(null);
  const [flashColor, setFlashColor] = useState<'green' | 'orange' | 'red' | null>(null);
  const [isProcessingOcrLabel, setIsProcessingOcrLabel] = useState<boolean>(false);
  const [ocrLabelStatusMessage, setOcrLabelStatusMessage] = useState<string>('');
  const [liveOcrDetectedPreview, setLiveOcrDetectedPreview] = useState<string>('');
  const [isSnappingPhoto, setIsSnappingPhoto] = useState<boolean>(false);
  const [lastExternalScannerEvent, setLastExternalScannerEvent] = useState<{
    code: string;
    timestamp: number;
  } | null>(null);

  // Modals
  const [isCameraSelectModalOpen, setIsCameraSelectModalOpen] = useState<boolean>(false);
  const [isSupplierModalOpen, setIsSupplierModalOpen] = useState<boolean>(false);
  const [isManualModalOpen, setIsManualModalOpen] = useState<boolean>(false);
  const [manualCodeInput, setManualCodeInput] = useState<string>('');

  // Preferred Supplier Rule ID state (syncs across session and when no delivery is active)
  const [preferredRuleId, setPreferredRuleId] = useState<SupplierRuleId>(() =>
    getPreferredSupplierRuleId()
  );

  useEffect(() => {
    const handleRuleChange = () => {
      setPreferredRuleId(getPreferredSupplierRuleId());
    };
    window.addEventListener('parttrack_supplier_rule_changed', handleRuleChange);
    return () => {
      window.removeEventListener('parttrack_supplier_rule_changed', handleRuleChange);
    };
  }, []);

  // Active Supplier Rule State
  const activeSupplierRule = useMemo(() => {
    if (delivery) {
      return getDeliverySupplierRule(delivery);
    }
    return SUPPLIER_RULES[preferredRuleId] || SUPPLIER_RULES.laser_central;
  }, [delivery, preferredRuleId]);

  const activeSupplierRuleRef = useRef(activeSupplierRule);
  activeSupplierRuleRef.current = activeSupplierRule;

  const startScannerRef = useRef<((targetCameraId?: string) => Promise<void>) | null>(null);
  const reconfigureActiveModeRef = useRef<(() => void) | null>(null);

  const handleSelectSupplierRule = useCallback(
    (ruleId: SupplierRuleId) => {
      setPreferredRuleId(ruleId);
      setPreferredSupplierRuleId(ruleId);
      if (delivery) {
        const updated = setDeliverySupplierRule(delivery, ruleId);
        onUpdateDelivery(updated);
      }
      setIsSupplierModalOpen(false);
      // Re-configure active decoder loops in-place without restarting the camera stream
      setTimeout(() => {
        if (scannerRef.current && scannerRef.current.isScanning) {
          reconfigureActiveModeRef.current?.();
        } else {
          startScannerRef.current?.();
        }
      }, 30);
    },
    [delivery, onUpdateDelivery]
  );

  // References for continuous camera scanner instance & timers
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const offscreenScannerRef = useRef<Html5Qrcode | null>(null);
  const nativeDetectorIntervalRef = useRef<any>(null);
  const isNativeDetectingRef = useRef<boolean>(false);
  const focusMaintenanceIntervalRef = useRef<any>(null);
  const liveOcrIntervalRef = useRef<any>(null);
  const lastOcrFrameSignatureRef = useRef<number[]>([]);
  const isLiveOcrBusyRef = useRef<boolean>(false);

  // QR & Barcode decode performance diagnostic counters
  const decodeAttemptCountRef = useRef<number>(0);
  const attemptsBeforeLastSuccessRef = useRef<number>(0);
  const decodeTimeSamplesRef = useRef<number[]>([]);
  const activeDecodeMethodRef = useRef<string>('Initializing...');

  const lastScannedCodeRef = useRef<string>('');
  const lastScannedTimeRef = useRef<number>(0);
  const feedbackTimeoutRef = useRef<any>(null);
  const flashTimeoutRef = useRef<any>(null);
  const focusRingTimeoutRef = useRef<any>(null);
  const externalHidBannerTimeoutRef = useRef<any>(null);
  const isStartingRef = useRef<boolean>(false);
  const isMountedRef = useRef<boolean>(true);

  // Input refs for file uploads & shutter fallback
  const snapFileInputRef = useRef<HTMLInputElement | null>(null);
  const ocrLabelFileInputRef = useRef<HTMLInputElement | null>(null);
  const galleryFileInputRef = useRef<HTMLInputElement | null>(null);

  // Hardware HID Keyboard Wedge refs
  const hidBufferRef = useRef<string>('');
  const hidLastKeyTimeRef = useRef<number>(0);
  const hidFirstKeyTimeRef = useRef<number>(0);
  const hidKeystrokeCountRef = useRef<number>(0);
  const hidFlushTimerRef = useRef<any>(null);

  // Pinch-to-zoom gesture tracking refs
  const pinchStartDistanceRef = useRef<number | null>(null);
  const pinchStartZoomRef = useRef<number>(1);
  const zoomLevelRef = useRef<number>(1);
  zoomLevelRef.current = zoomLevel;

  // Active scan ref to immediately block background scans while modal is open
  const activeScanConfirmationRef = useRef<ActiveScanData | null>(null);
  activeScanConfirmationRef.current = activeScanConfirmation;

  // Active duplicate warning ref to immediately block background scans while duplicate popup is open
  const activeDuplicateWarningRef = useRef<DuplicateScanModalData | null>(null);
  activeDuplicateWarningRef.current = activeDuplicateWarning;

  const groupConflictModalRef = useRef<GroupScanConflictModalState | null>(null);
  groupConflictModalRef.current = groupConflictModal;

  // Atomic processing lock against rapid consecutive events
  const isProcessingScanRef = useRef<boolean>(false);

  const isManualModalOpenRef = useRef<boolean>(false);
  isManualModalOpenRef.current = isManualModalOpen;

  const deliveryRef = useRef(delivery);
  deliveryRef.current = delivery;

  const scanScopeRef = useRef(scanScope);
  scanScopeRef.current = scanScope;

  const groupRef = useRef(group);
  groupRef.current = group;

  const groupDeliveriesRef = useRef<Delivery[]>(groupDeliveries);
  groupDeliveriesRef.current = groupDeliveries;

  const onUpdateDeliveryRef = useRef(onUpdateDelivery);
  onUpdateDeliveryRef.current = onUpdateDelivery;

  const appendDiagnosticLog = useCallback(
    (category: DiagnosticCategory, message: string) => {
      const prefix = `[PartTrack ${category.toUpperCase()}]`;
      if (category === 'error') {
        console.warn(prefix, message);
      } else {
        console.info(prefix, message);
      }
    },
    []
  );

  /**
   * Helper to inspect active video track
   */
  const getActiveVideoTrack = useCallback((): MediaStreamTrack | null => {
    try {
      const container = document.getElementById('camera-scanner-view');
      const video = container?.querySelector('video') as HTMLVideoElement | null;
      const stream = video?.srcObject as MediaStream | null;
      if (stream && stream.getVideoTracks && stream.getVideoTracks().length > 0) {
        return stream.getVideoTracks()[0];
      }
    } catch {}
    return null;
  }, []);

  /**
   * Trigger brief visual flash on camera view
   */
  const triggerVisualFlash = useCallback((color: 'green' | 'orange' | 'red') => {
    setFlashColor(color);
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    flashTimeoutRef.current = setTimeout(() => {
      setFlashColor(null);
    }, 450);
  }, []);

  /**
   * Triggers prominent RED duplicate scan warning popup & rejection feedback
   */
  const triggerDuplicateWarning = useCallback(
    (dupData: DuplicateScanModalData) => {
      playAudio.duplicate(appSettings.soundEnabled);
      triggerHaptic('duplicate', appSettings.vibrationEnabled);
      speakAlert(`Duplicate scan: ${dupData.partNumber}`, appSettings.speechEnabled);
      triggerVisualFlash('red');

      activeDuplicateWarningRef.current = dupData;
      setActiveDuplicateWarning(dupData);
    },
    [appSettings, triggerVisualFlash]
  );

  /**
   * Dismisses red duplicate warning popup and leaves camera ready for next scan
   */
  const handleDismissDuplicateWarning = useCallback(() => {
    setActiveDuplicateWarning(null);
    activeDuplicateWarningRef.current = null;
    lastScannedTimeRef.current = Date.now();
  }, []);

  /**
   * Rejects a code that does not belong to the active docket or group
   */
  const rejectUnscopedCode = useCallback(
    (code: string, message: string) => {
      playAudio.duplicate(appSettings.soundEnabled);
      triggerHaptic('duplicate', appSettings.vibrationEnabled);
      triggerVisualFlash('red');
      setScanFeedback({
        type: 'unexpected',
        code,
        message,
        timestamp: Date.now(),
      });
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = setTimeout(() => {
        setScanFeedback(null);
      }, 4200);
    },
    [appSettings, triggerVisualFlash]
  );

  /**
   * Universal device video inputs enumeration (ranked with primary rear wide sensor first)
   */
  const enumerateAllVideoInputs = useCallback(async (): Promise<
    Array<{ id: string; label: string }>
  > => {
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      !navigator.mediaDevices.enumerateDevices
    ) {
      return [];
    }
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const rankedRearFirst = rankRearVideoDevices(allDevices);
      const videoInputs =
        rankedRearFirst.length > 0
          ? rankedRearFirst
          : allDevices.filter((d) => d.kind === 'videoinput');
      const list = videoInputs.map((d, idx) => ({
        id: d.deviceId,
        label: d.label || `Camera ${idx + 1}`,
      }));
      if (isMountedRef.current) {
        setAvailableCameras(list);
      }
      return list;
    } catch (err: any) {
      appendDiagnosticLog('error', `Enumerate devices note: ${err?.message || String(err)}`);
      return [];
    }
  }, [appendDiagnosticLog]);

  /**
   * Apply mode-specific camera profile (resolution, frameRate, continuous autofocus, continuous exposure,
   * continuous white balance, zoom, torch) in-place without restarting or disrupting the video stream.
   */
  const configureTrackFocusAndCapabilities = useCallback(
    async (targetZoom: number = 1) => {
      const track = getActiveVideoTrack();
      if (!track) return;

      try {
        if (focusMaintenanceIntervalRef.current) {
          clearInterval(focusMaintenanceIntervalRef.current);
          focusMaintenanceIntervalRef.current = null;
        }

        const currentMode: ScanMode =
          (activeSupplierRuleRef.current?.id as ScanMode) || 'laser_central';
        const profile = CAMERA_PROFILES[currentMode] || CAMERA_PROFILES.laser_central;

        const applied = await applyCameraProfileToTrack(
          track,
          currentMode,
          targetZoom > 1 ? targetZoom : undefined
        );

        if (isMountedRef.current) {
          setHasTorch(applied.torchSupported);
          setSupportsHardwareZoom(applied.zoomSupported);
          if (applied.zoomSupported) {
            setMinHardwareZoom(applied.zoomMin);
            setMaxHardwareZoom(applied.zoomMax);
          }
        }

        // If the camera driver only supports single-shot focus (no continuous PDAF), pulse gently every 2.2s
        if (
          !applied.supportedFocusModes.includes('continuous') &&
          applied.supportedFocusModes.includes('single-shot')
        ) {
          focusMaintenanceIntervalRef.current = setInterval(() => {
            if (
              !isMountedRef.current ||
              activeScanConfirmationRef.current !== null ||
              activeDuplicateWarningRef.current !== null
            ) {
              return;
            }
            const currentTrack = getActiveVideoTrack();
            if (!currentTrack) return;
            triggerCameraRefocusPulse(currentTrack).catch(() => {});
          }, 2200);
        }

        // Inspect actual video element dimensions if track settings omitted width/height
        const container = document.getElementById('camera-scanner-view');
        const video = container?.querySelector('video') as HTMLVideoElement | null;
        const [parsedW, parsedH] = applied.resolution.split('x').map((n) => parseInt(n, 10) || 0);
        const actualW = video?.videoWidth || parsedW || profile.idealWidth;
        const actualH = video?.videoHeight || parsedH || profile.idealHeight;

        if (isMountedRef.current) {
          setActualCameraInfo((prev) => {
            const diagPayload = {
              cameraProfile: applied.cameraProfile,
              width: actualW,
              height: actualH,
              frameRate: applied.frameRate,
              focusMode: applied.activeFocusMode,
              supportedFocusModes:
                applied.supportedFocusModes.length > 0
                  ? applied.supportedFocusModes
                  : ['continuous (driver-default)'],
              exposureMode: applied.activeExposureMode,
              whiteBalanceMode: applied.activeWhiteBalanceMode,
              deviceLabel: applied.cameraDeviceLabel,
              decodeMethod: activeDecodeMethodRef.current,
              scanFrequencyHz: profile.scanFrequencyHz,
              scanIntervalMs: profile.scanIntervalMs,
              avgDecodeTimeMs:
                decodeTimeSamplesRef.current.length > 0
                  ? Math.round(
                      (decodeTimeSamplesRef.current.reduce((a, b) => a + b, 0) /
                        decodeTimeSamplesRef.current.length) *
                        10
                    ) / 10
                  : 0,
              lastDecodeTimeMs:
                decodeTimeSamplesRef.current[decodeTimeSamplesRef.current.length - 1] || 0,
              lastRecognitionTimeMs: prev?.lastRecognitionTimeMs ?? null,
              lastRecognitionTimestamp: prev?.lastRecognitionTimestamp ?? null,
              attemptsBeforeLastSuccess: attemptsBeforeLastSuccessRef.current,
              currentAttemptCount: decodeAttemptCountRef.current,
              multipleDecodersActive: false,
              concurrentDecodersCount: 1,
              streamStatus: 'active',
            };
            if (typeof window !== 'undefined') {
              (window as any).__PALLETTRACK_SCANNER_DIAGNOSTICS__ = diagPayload;
            }
            return diagPayload;
          });
        }
      } catch (e: any) {
        appendDiagnosticLog('error', `Track capability check note: ${e?.message || String(e)}`);
      }
    },
    [appendDiagnosticLog, getActiveVideoTrack]
  );

  /**
   * Smoothly apply a new zoom level
   */
  const applyZoomLevel = useCallback(
    async (rawTargetZoom: number) => {
      const maxAllowed = supportsHardwareZoom ? maxHardwareZoom : 4;
      const minAllowed = supportsHardwareZoom ? minHardwareZoom : 1;
      const clamped =
        Math.round(Math.max(minAllowed, Math.min(maxAllowed, rawTargetZoom)) * 100) / 100;

      setZoomLevel(clamped);
      zoomLevelRef.current = clamped;

      const track = getActiveVideoTrack();
      if (!track) return;

      try {
        const capabilities = (track as any).getCapabilities?.() || {};
        if (capabilities.zoom) {
          const minZ = capabilities.zoom.min || 1;
          const maxZ = capabilities.zoom.max || 4;
          const hwZoom = Math.max(minZ, Math.min(maxZ, clamped));
          await track.applyConstraints({
            advanced: [
              {
                zoom: hwZoom,
                ...(Array.isArray(capabilities.focusMode) &&
                capabilities.focusMode.includes('continuous')
                  ? { focusMode: 'continuous' }
                  : {}),
              } as any,
            ],
          });
        }
      } catch {}
    },
    [getActiveVideoTrack, maxHardwareZoom, minHardwareZoom, supportsHardwareZoom]
  );

  /**
   * Toggle flashlight/torch
   */
  const toggleTorch = useCallback(async () => {
    const track = getActiveVideoTrack();
    if (!track) return;

    try {
      const nextState = !torchOn;
      await (track as any).applyConstraints({
        advanced: [{ torch: nextState }],
      });
      setTorchOn(nextState);
      appendDiagnosticLog('camera', `Torch turned ${nextState ? 'ON' : 'OFF'}`);
    } catch (e: any) {
      appendDiagnosticLog('error', `Torch toggle failed: ${e?.message || String(e)}`);
    }
  }, [appendDiagnosticLog, getActiveVideoTrack, torchOn]);

  /**
   * Tap to focus on camera preview (triggers refocus pulse + pointsOfInterest while keeping continuous AF)
   */
  const handleTapToFocus = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      setFocusRingPos({ x, y });
      if (focusRingTimeoutRef.current) clearTimeout(focusRingTimeoutRef.current);
      focusRingTimeoutRef.current = setTimeout(() => {
        setFocusRingPos(null);
      }, 1000);

      const track = getActiveVideoTrack();
      if (!track) return;

      try {
        const normX = Math.max(0, Math.min(1, x / rect.width));
        const normY = Math.max(0, Math.min(1, y / rect.height));
        const capabilities: any = track.getCapabilities ? track.getCapabilities() : {};

        if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
          (track as any)
            .applyConstraints({
              advanced: [
                {
                  focusMode: 'continuous',
                  pointsOfInterest: [{ x: normX, y: normY }],
                } as any,
              ],
            })
            .catch(() => {});
        }
        triggerCameraRefocusPulse(track).catch(() => {});
      } catch {}
    },
    [getActiveVideoTrack]
  );

  /**
   * CENTRAL SCAN EVENT HANDLER
   * Strictly scoped either to a single opened Delivery Docket OR a Docket Group's member dockets.
   * Rejects external codes clearly and triggers docket allocation if >1 group docket matches.
   */
  const handleScannedCode = useCallback(
    (
      codeText: string,
      inputSource: ScanInputSource = 'camera_barcode_qr',
      detectedFormat?: string
    ) => {
      // Silently ignore permanently excluded non-part QR codes (e.g. sheet-metal protective film QR)
      if (isIgnoredNonPartQrPayload(codeText)) {
        return;
      }

      // Block scanning if confirmation, conflict allocation, or duplicate warning modal is already open
      if (
        activeScanConfirmationRef.current !== null ||
        activeDuplicateWarningRef.current !== null ||
        groupConflictModalRef.current !== null ||
        isProcessingScanRef.current
      ) {
        return;
      }

      // When in OCR label scan mode, do NOT automatically scan QR codes
      const isOcrMode = activeSupplierRuleRef.current?.id === 'ocr_label';
      if (isOcrMode && inputSource === 'camera_barcode_qr') {
        const fmt = (detectedFormat || '').toUpperCase();
        if (fmt === 'QR_CODE' || fmt === 'QRCODE' || fmt.includes('QR')) {
          return;
        }
        const trimmed = codeText.trim();
        if (
          trimmed.startsWith('http://') ||
          trimmed.startsWith('https://') ||
          trimmed.startsWith('mailto:') ||
          trimmed.startsWith('tel:')
        ) {
          return;
        }
      }

      const isGroupMode =
        scanScopeRef.current?.mode === 'group' && Boolean(groupRef.current);
      const currentDelivery = deliveryRef.current;
      const scopedGroup = groupRef.current;
      const scopedDeliveries = isGroupMode
        ? groupDeliveriesRef.current
        : currentDelivery
        ? [currentDelivery]
        : [];

      if (scopedDeliveries.length === 0) return;

      // Online-only receiving guard
      if (!isBackendOnline()) {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('parttrack_connection_required'));
        }
        playAudio.duplicate(appSettings.soundEnabled);
        triggerHaptic('duplicate', appSettings.vibrationEnabled);
        return;
      }

      const cleaned = codeText.trim();
      if (!cleaned) return;

      const now = Date.now();
      if (cleaned === lastScannedCodeRef.current && now - lastScannedTimeRef.current < 1200) {
        return;
      }

      lastScannedCodeRef.current = cleaned;
      lastScannedTimeRef.current = now;

      let method: ScanMethodType = 'barcode';
      if (inputSource === 'external_hid') {
        method = 'external_hid';
      } else if (inputSource === 'manual') {
        method = 'manual';
      } else if (cleaned.length > 25 || cleaned.includes('\n') || cleaned.includes('{')) {
        method = 'qr_code';
      }

      appendDiagnosticLog(
        inputSource === 'external_hid' ? 'external_hid' : 'barcode_qr',
        `Scanned code "${cleaned}" via ${inputSource} (${isGroupMode ? `Group:${scopedGroup?.name}` : `Docket:#${currentDelivery?.docketNumber}`})`
      );

      // Deduplicated matches strictly inside scoped delivery or scoped group deliveries
      const rawMatches = isGroupMode
        ? findMatchingPartsInGroup(scopedDeliveries, cleaned)
        : findMatchingPartsInDelivery(scopedDeliveries[0], cleaned);

      const dedupedMatches = rawMatches.filter(
        (m, idx, arr) =>
          arr.findIndex((x) => x.delivery.id === m.delivery.id && x.part.id === m.part.id) === idx
      );

      if (dedupedMatches.length === 0) {
        // Fallback check on previously recorded scannedCode inside scoped dockets
        for (const d of scopedDeliveries) {
          const dupCheck = detectDuplicateScan(d, cleaned);
          if (dupCheck.isDuplicate) {
            triggerDuplicateWarning({
              partNumber: dupCheck.partNumber,
              description: dupCheck.description,
              code: cleaned,
              itemNumber: dupCheck.itemNumber,
              palletNumber: dupCheck.palletNumber,
              scannedAt: dupCheck.scannedAt,
              scannedBy: dupCheck.scannedBy,
              customMessage: dupCheck.scannedBy
                ? `Duplicate scan – already received by ${dupCheck.scannedBy} on Docket #${d.docketNumber}`
                : undefined,
              receivedQuantity: dupCheck.receivedQuantity,
            });
            return;
          }
        }

        rejectUnscopedCode(
          cleaned,
          isGroupMode
            ? `✕ Rejected: "${cleaned}" does not belong to any docket in group "${scopedGroup?.name || ''}"`
            : `✕ Rejected: "${cleaned}" does not belong to Docket #${scopedDeliveries[0].docketNumber}`
        );
        return;
      }

      const uncompleted = dedupedMatches.filter((m) => !m.alreadyFullyScanned);

      if (uncompleted.length === 0) {
        const firstDup = dedupedMatches[0];
        triggerDuplicateWarning({
          partNumber: firstDup.part.partNumber,
          description: firstDup.part.description,
          code: cleaned,
          itemNumber: firstDup.part.itemNumber,
          palletNumber: firstDup.part.palletNumber,
          scannedAt: firstDup.part.scannedAt,
          scannedBy: firstDup.part.lastScannedByName,
          customMessage: firstDup.part.lastScannedByName
            ? `Duplicate scan – already received on Docket #${firstDup.delivery.docketNumber} by ${firstDup.part.lastScannedByName}`
            : `Duplicate scan – already received on Docket #${firstDup.delivery.docketNumber}`,
          receivedQuantity: firstDup.part.receivedQuantity ?? firstDup.part.quantity ?? 1,
        });
        return;
      }

      // Group mode ambiguity: require explicit operator docket allocation if >1 member docket has this part
      if (isGroupMode && uncompleted.length > 1) {
        playAudio.unexpected(appSettings.soundEnabled);
        triggerHaptic('unexpected', appSettings.vibrationEnabled);
        const candidates: GroupScanConflictCandidate[] = uncompleted.map((m) => {
          const req = Math.max(1, m.part.quantity ?? 1);
          const rec =
            m.part.status === 'received' && typeof m.part.receivedQuantity === 'number'
              ? m.part.receivedQuantity
              : 0;
          return {
            deliveryId: m.delivery.id,
            docketNumber: m.delivery.docketNumber,
            supplier: m.delivery.supplier,
            partId: m.part.id,
            partNumber: m.part.partNumber,
            itemNumber: m.part.itemNumber,
            description: m.part.description,
            requiredQuantity: req,
            receivedQuantity: rec,
            status: m.part.status,
            matchedMode: m.matchMode,
          };
        });
        const conflictState: GroupScanConflictModalState = {
          rawCode: cleaned,
          scanMethod: method,
          detectedQuantity: Math.max(1, uncompleted[0].part.quantity ?? 1),
          candidates,
        };
        groupConflictModalRef.current = conflictState;
        setGroupConflictModal(conflictState);
        return;
      }

      const match = uncompleted[0];
      realtimeClient.notifyScanningActivity({
        action: 'confirming_scan',
        partId: match.part.id,
        partNumber: match.part.partNumber,
        itemNumber: match.part.itemNumber,
        summary: `Scanning ${match.part.partNumber} (Docket #${match.delivery.docketNumber})`,
      });

      playAudio.success(appSettings.soundEnabled);
      triggerHaptic('success', appSettings.vibrationEnabled);

      const newScanData: ActiveScanData = {
        scanMethod: method,
        rawCode: cleaned,
        detectedPartNumber: match.part.partNumber,
        detectedDescription: match.part.description,
        detectedQuantity: Math.max(1, match.part.quantity ?? 1),
        matchedPart: match.part,
        docketNumber: match.delivery.docketNumber,
        customerOrSupplier: match.delivery.supplier || '',
        targetDeliveryId: match.delivery.id,
        isUnlisted: false,
      };

      activeScanConfirmationRef.current = newScanData;
      setActiveScanConfirmation(newScanData);
    },
    [appendDiagnosticLog, appSettings, rejectUnscopedCode, triggerDuplicateWarning]
  );

  /**
   * Handle SAVE & SCAN NEXT action from confirmation modal.
   * Uses authoritative server commits (`apiScanGroupPart` in Group mode, `commitScanPartAuthoritative` in Single-Docket mode).
   */
  const handleSaveAndScanNext = useCallback(
    async (payload: ConfirmedScanPayload) => {
      const activeConfirm = activeScanConfirmationRef.current;
      const isGroupMode =
        scanScopeRef.current?.mode === 'group' && Boolean(groupRef.current);

      const currentDelivery =
        (activeConfirm?.targetDeliveryId
          ? groupDeliveriesRef.current.find((d) => d.id === activeConfirm.targetDeliveryId)
          : undefined) || deliveryRef.current;

      if (!currentDelivery && !isGroupMode) return;

      const scanMethodToCodeType: ScanMethod =
        payload.scanMethod === 'qr_code'
          ? 'qr'
          : payload.scanMethod === 'ocr_label'
          ? 'ocr_label'
          : payload.scanMethod === 'manual'
          ? 'manual'
          : 'barcode';

      lastScannedCodeRef.current = payload.rawCode;
      lastScannedTimeRef.current = Date.now();

      // Close confirmation sheet immediately for responsive UX while committing
      activeScanConfirmationRef.current = null;
      setActiveScanConfirmation(null);

      // Group Scan Path -> authoritative group scan endpoint
      if (isGroupMode && groupRef.current) {
        try {
          const idempotencyKey = `gscan_${groupRef.current.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const res = await apiScanGroupPart(groupRef.current.id, {
            scannedCode: payload.rawCode || payload.partNumber,
            scannedVia: scanMethodToCodeType,
            receivedQuantity: payload.quantity,
            mode: scanMethodToCodeType === 'ocr_label' ? 'increment' : 'set',
            targetDeliveryId: activeConfirm?.targetDeliveryId || currentDelivery?.id,
            targetPartId: payload.matchedPart?.id,
            idempotencyKey,
            rawOcrText: activeConfirm?.rawOcrText,
          });

          if (res.status === 'not_found') {
            rejectUnscopedCode(payload.rawCode, res.message);
            return;
          }

          if (res.status === 'ambiguous' && res.candidates && res.candidates.length > 0) {
            const conflictState: GroupScanConflictModalState = {
              rawCode: payload.rawCode,
              scanMethod: payload.scanMethod,
              detectedQuantity: payload.quantity,
              rawOcrText: activeConfirm?.rawOcrText,
              candidates: res.candidates,
            };
            groupConflictModalRef.current = conflictState;
            setGroupConflictModal(conflictState);
            return;
          }

          if (res.status === 'duplicate') {
            triggerDuplicateWarning({
              partNumber: res.part?.partNumber || payload.partNumber,
              description: res.part?.description || payload.description,
              code: payload.rawCode,
              itemNumber: res.part?.itemNumber,
              palletNumber: res.part?.palletNumber,
              scannedAt: res.alreadyScannedAt || res.part?.scannedAt,
              scannedBy: res.alreadyScannedBy || res.part?.lastScannedByName || 'Another worker',
              customMessage: res.message,
              receivedQuantity: res.part?.receivedQuantity ?? payload.quantity,
            });
            return;
          }

          if (res.status === 'committed' && res.deliveryId && res.part) {
            const allStored = getStoredDeliveries();
            const targetDel =
              allStored.find((d) => d.id === res.deliveryId) ||
              groupDeliveriesRef.current.find((d) => d.id === res.deliveryId);

            if (targetDel) {
              const nextParts = targetDel.parts.map((p) =>
                p.id === res.part!.id ? { ...p, ...res.part! } : p
              );
              const allDone = nextParts.length > 0 && nextParts.every((p) => p.status === 'received');
              const nextHistory =
                res.scanEvent && !targetDel.scanHistory.some((ev) => ev.id === res.scanEvent!.id)
                  ? [res.scanEvent, ...targetDel.scanHistory].slice(0, 300)
                  : targetDel.scanHistory;
              const updatedTarget: Delivery = {
                ...targetDel,
                parts: nextParts,
                status: allDone ? 'completed' : 'receiving',
                version: res.deliveryVersion || (targetDel.version || 1) + 1,
                scanHistory: nextHistory,
                updatedAt: new Date().toISOString(),
              };
              const updatedList = allStored.map((d) =>
                d.id === updatedTarget.id ? updatedTarget : d
              );
              saveStoredDeliveries(updatedList);
              onUpdateDeliveryRef.current(updatedTarget);
            }

            const reqQty = Math.max(1, res.part.quantity ?? payload.matchedPart?.quantity ?? 1);
            const recQty = res.part.receivedQuantity ?? payload.quantity;
            const isQtyMatch = recQty === reqQty;

            if (isQtyMatch) {
              playAudio.success(appSettings.soundEnabled);
              triggerHaptic('success', appSettings.vibrationEnabled);
              triggerVisualFlash('green');
            } else {
              playAudio.unexpected(appSettings.soundEnabled);
              triggerHaptic('unexpected', appSettings.vibrationEnabled);
              triggerVisualFlash('orange');
            }

            setScanFeedback({
              type: isQtyMatch ? 'success' : 'quantity_mismatch',
              code: payload.rawCode,
              message: `✓ Docket #${targetDel?.docketNumber || ''}: ${payload.partNumber} (${recQty}/${reqQty})`,
              timestamp: Date.now(),
            });
            if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
            feedbackTimeoutRef.current = setTimeout(() => {
              setScanFeedback(null);
            }, 3500);
          }
        } catch (err: any) {
          rejectUnscopedCode(
            payload.rawCode,
            err?.message || 'Unable to verify scan against docket group.'
          );
        }
        return;
      }

      // Single-Docket Scan Path -> authoritative single-delivery commit
      if (!currentDelivery || !payload.matchedPart) {
        rejectUnscopedCode(
          payload.rawCode,
          `✕ Rejected: "${payload.rawCode || payload.partNumber}" is not part of Docket #${currentDelivery?.docketNumber || ''}`
        );
        return;
      }

      const res = await commitScanPartAuthoritative(
        currentDelivery,
        {
          code: payload.rawCode,
          detectedType: scanMethodToCodeType,
          matchedMode: 'exact-part',
          part: {
            ...payload.matchedPart,
            partNumber: payload.partNumber,
            description: payload.description,
          },
        },
        payload.quantity,
        {
          mode: scanMethodToCodeType === 'ocr_label' ? 'increment' : 'set',
          rawOcrText: activeConfirm?.rawOcrText,
        }
      );

      onUpdateDeliveryRef.current(res.updatedDelivery);

      if (res.outcome === 'duplicate') {
        triggerDuplicateWarning({
          partNumber: res.updatedPart.partNumber || payload.partNumber,
          description: res.updatedPart.description || payload.description,
          code: payload.rawCode,
          itemNumber: res.updatedPart.itemNumber,
          palletNumber: res.updatedPart.palletNumber,
          scannedAt: res.alreadyScannedAt || res.updatedPart.scannedAt,
          scannedBy: res.alreadyScannedBy || res.updatedPart.lastScannedByName || 'Another worker',
          customMessage:
            'Duplicate scan – this part has already been received by another worker',
          receivedQuantity: res.receivedQuantity,
        });
        return;
      }

      if (res.outcome === 'pending_sync') {
        playAudio.unexpected(appSettings.soundEnabled);
        triggerHaptic('unexpected', appSettings.vibrationEnabled);
        triggerVisualFlash('orange');
        setScanFeedback({
          type: 'pending_sync',
          code: payload.rawCode,
          message: `⏳ Pending Sync: ${payload.partNumber} (will verify on reconnect)`,
          timestamp: Date.now(),
        });
        if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
        feedbackTimeoutRef.current = setTimeout(() => {
          setScanFeedback(null);
        }, 4500);
        return;
      }

      if (res.isCorrectQuantity) {
        playAudio.success(appSettings.soundEnabled);
        triggerHaptic('success', appSettings.vibrationEnabled);
        triggerVisualFlash('green');
      } else {
        playAudio.unexpected(appSettings.soundEnabled);
        triggerHaptic('unexpected', appSettings.vibrationEnabled);
        triggerVisualFlash('orange');
      }

      setScanFeedback({
        type: res.isCorrectQuantity ? 'success' : 'quantity_mismatch',
        code: payload.rawCode,
        message: `✓ Saved: ${payload.partNumber} (Qty ${res.receivedQuantity}/${res.requiredQuantity})`,
        timestamp: Date.now(),
      });
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = setTimeout(() => {
        setScanFeedback(null);
      }, 3500);
    },
    [appSettings, rejectUnscopedCode, triggerVisualFlash, triggerDuplicateWarning]
  );

  /**
   * Handle CONFIRM & SAVE action from confirmation modal
   */
  const handleConfirmAndSave = useCallback(
    (payload: ConfirmedScanPayload) => {
      handleSaveAndScanNext(payload);
    },
    [handleSaveAndScanNext]
  );

  /**
   * Handle DISCARD action from confirmation modal
   */
  const handleDiscard = useCallback(() => {
    // Debounce last code so camera doesn't immediately re-open on discarded frame
    lastScannedTimeRef.current = Date.now() + 600;
    activeScanConfirmationRef.current = null;
    setActiveScanConfirmation(null);
  }, []);

  /**
   * Listen for external pending quantity trigger (e.g. from test barcodes sheet)
   */
  useEffect(() => {
    if (externalPendingQuantity && delivery) {
      const part = externalPendingQuantity.part;
      const scanData: ActiveScanData = {
        scanMethod: externalPendingQuantity.detectedType === 'ocr_label' ? 'ocr_label' : 'barcode',
        rawCode: externalPendingQuantity.code,
        detectedPartNumber: part.partNumber,
        detectedDescription: part.description,
        detectedQuantity: Math.max(1, part.quantity ?? 1),
        matchedPart: part,
        docketNumber: delivery.docketNumber,
        customerOrSupplier: delivery.supplier || '',
        isUnlisted: false,
      };
      activeScanConfirmationRef.current = scanData;
      setActiveScanConfirmation(scanData);
      onClearExternalPendingQuantity?.();
    }
  }, [externalPendingQuantity, delivery, onClearExternalPendingQuantity]);

  /**
   * Helper to update live decode diagnostics in state and window
   */
  const recordDecodeDiagnostics = useCallback(
    (elapsedMs: number, recognized: boolean, methodLabel: string) => {
      activeDecodeMethodRef.current = methodLabel;
      decodeAttemptCountRef.current += 1;
      const roundedMs = Math.round(elapsedMs * 10) / 10;
      const samples = decodeTimeSamplesRef.current;
      samples.push(roundedMs);
      if (samples.length > 30) {
        samples.shift();
      }
      const avgMs =
        Math.round((samples.reduce((acc, v) => acc + v, 0) / samples.length) * 10) / 10;

      const currentMode: ScanMode =
        (activeSupplierRuleRef.current?.id as ScanMode) || 'laser_central';
      const profile = CAMERA_PROFILES[currentMode] || CAMERA_PROFILES.laser_central;

      if (recognized) {
        attemptsBeforeLastSuccessRef.current = decodeAttemptCountRef.current;
        decodeAttemptCountRef.current = 0;
      }

      // Throttle React state updates for non-recognition frames to every 6 attempts
      if (recognized || decodeAttemptCountRef.current % 6 === 0) {
        setActualCameraInfo((prev) => {
          const next = {
            cameraProfile: prev?.cameraProfile || profile.profileLabel,
            width: prev?.width || profile.idealWidth,
            height: prev?.height || profile.idealHeight,
            frameRate: prev?.frameRate || profile.idealFrameRate,
            focusMode: prev?.focusMode || 'continuous',
            supportedFocusModes: prev?.supportedFocusModes || ['continuous'],
            exposureMode: prev?.exposureMode || 'continuous',
            whiteBalanceMode: prev?.whiteBalanceMode || 'continuous',
            deviceLabel: prev?.deviceLabel || 'Rear Camera',
            decodeMethod: methodLabel,
            scanFrequencyHz: profile.scanFrequencyHz,
            scanIntervalMs: profile.scanIntervalMs,
            avgDecodeTimeMs: avgMs,
            lastDecodeTimeMs: roundedMs,
            lastRecognitionTimeMs: recognized ? roundedMs : (prev?.lastRecognitionTimeMs ?? null),
            lastRecognitionTimestamp: recognized
              ? new Date().toLocaleTimeString()
              : (prev?.lastRecognitionTimestamp ?? null),
            attemptsBeforeLastSuccess: attemptsBeforeLastSuccessRef.current,
            currentAttemptCount: decodeAttemptCountRef.current,
            multipleDecodersActive: false,
            concurrentDecodersCount: 1,
            streamStatus: 'active',
          };
          if (typeof window !== 'undefined') {
            (window as any).__PALLETTRACK_SCANNER_DIAGNOSTICS__ = next;
          }
          return next;
        });
      }
    },
    []
  );

  /**
   * Single-flight, mode-isolated Native Barcode & QR scanning loop on video frames.
   * - In GCI mode ('gci'): isolates strictly to ['qr_code'] at 45ms intervals (22.2 Hz) with single-flight lock,
   *   and suspends Html5Qrcode's redundant ZXing canvas loop so only one decoder processes each frame.
   * - In Laser Central mode ('laser_central'): verifies native 1D format support (code_128, code_39) via
   *   createVerifiedNativeBarcodeDetector and scans at 60ms intervals (16.7 Hz) with single-flight lock,
   *   or automatically enables ZXing fallback if 1D formats are unsupported natively.
   * - In OCR Label mode ('ocr_label'): scans 1D barcodes at 85ms intervals (11.8 Hz) while ignoring QR codes.
   */
  const startNativeBarcodeLoop = useCallback(async () => {
    if (nativeDetectorIntervalRef.current) {
      clearInterval(nativeDetectorIntervalRef.current);
      nativeDetectorIntervalRef.current = null;
    }
    isNativeDetectingRef.current = false;
    decodeAttemptCountRef.current = 0;

    const currentRuleId: ScanMode =
      (activeSupplierRuleRef.current?.id as ScanMode) || 'laser_central';
    const profile = CAMERA_PROFILES[currentRuleId] || CAMERA_PROFILES.laser_central;

    const { detector, engineName } = await createVerifiedNativeBarcodeDetector(currentRuleId);

    if (!detector) {
      // Native BarcodeDetector unavailable or missing required 1D formats: ensure Html5Qrcode ZXing fallback is active
      activeDecodeMethodRef.current = engineName;
      if (scannerRef.current) {
        (scannerRef.current as any).shouldScan = true;
      }
      setActualCameraInfo((prev) =>
        prev
          ? {
              ...prev,
              cameraProfile: profile.profileLabel,
              decodeMethod: engineName,
              scanFrequencyHz: profile.scanFrequencyHz,
              scanIntervalMs: profile.scanIntervalMs,
              multipleDecodersActive: false,
              concurrentDecodersCount: 1,
            }
          : prev
      );
      return;
    }

    try {
      const methodLabel = engineName;
      activeDecodeMethodRef.current = methodLabel;

      // Prevent Html5Qrcode's internal ZXing canvas decoder from running in parallel on the same frame
      if (scannerRef.current) {
        (scannerRef.current as any).shouldScan = false;
        if ((scannerRef.current as any).foreverScanTimeout) {
          clearTimeout((scannerRef.current as any).foreverScanTimeout);
        }
      }

      setActualCameraInfo((prev) =>
        prev
          ? {
              ...prev,
              cameraProfile: profile.profileLabel,
              decodeMethod: methodLabel,
              scanFrequencyHz: profile.scanFrequencyHz,
              scanIntervalMs: profile.scanIntervalMs,
              multipleDecodersActive: false,
              concurrentDecodersCount: 1,
            }
          : prev
      );

      const intervalMs = profile.scanIntervalMs;

      nativeDetectorIntervalRef.current = setInterval(async () => {
        // Strict single-flight guard: never start decoding a frame if the previous frame is still decoding
        if (
          isNativeDetectingRef.current ||
          !isMountedRef.current ||
          activeScanConfirmationRef.current !== null ||
          activeDuplicateWarningRef.current !== null ||
          isManualModalOpenRef.current
        ) {
          return;
        }

        const container = document.getElementById('camera-scanner-view');
        const video = container?.querySelector('video') as HTMLVideoElement | null;
        if (!video || video.readyState < 2 || video.videoWidth === 0) return;

        isNativeDetectingRef.current = true;
        const t0 = performance.now();
        try {
          const barcodes = await detector.detect(video);
          const elapsedMs = performance.now() - t0;

          if (
            barcodes &&
            barcodes.length > 0 &&
            isMountedRef.current &&
            activeScanConfirmationRef.current === null
          ) {
            const validBarcodes = filterOutIgnoredQrDetections(
              barcodes,
              (b: any) => b?.rawValue || b?.raw_value || ''
            );
            if (validBarcodes.length === 0) {
              recordDecodeDiagnostics(elapsedMs, false, methodLabel);
              return;
            }
            const first = validBarcodes[0];
            const fmt = (first.format || '').toLowerCase();
            const currentIsOcr = activeSupplierRuleRef.current?.id === 'ocr_label';
            if (
              currentIsOcr &&
              (fmt === 'qr_code' || fmt === 'qrcode' || fmt === 'qr')
            ) {
              recordDecodeDiagnostics(elapsedMs, false, methodLabel);
              return; // Do NOT scan QR codes in OCR label scan mode
            }
            const rawVal = (first.rawValue || first.raw_value || '').trim();
            if (rawVal) {
              recordDecodeDiagnostics(elapsedMs, true, methodLabel);
              handleScannedCode(rawVal, 'camera_barcode_qr', fmt);
              return;
            }
          }

          recordDecodeDiagnostics(elapsedMs, false, methodLabel);
        } catch {
          // If native BarcodeDetector fails at runtime, re-enable ZXing fallback
          if (scannerRef.current) {
            (scannerRef.current as any).shouldScan = true;
          }
        } finally {
          isNativeDetectingRef.current = false;
        }
      }, intervalMs);
    } catch {
      // Fallback to Html5Qrcode ZXing decoder if BarcodeDetector fails
      activeDecodeMethodRef.current = 'ZXing Fallback (Html5Qrcode)';
      if (scannerRef.current) {
        (scannerRef.current as any).shouldScan = true;
      }
    }
  }, [handleScannedCode, recordDecodeDiagnostics]);

  /**
   * Background Live Pallet Label OCR loop (isolated strictly to OCR Label Mode)
   */
  const startLiveOcrDetectionLoop = useCallback(() => {
    if (liveOcrIntervalRef.current) {
      clearInterval(liveOcrIntervalRef.current);
      liveOcrIntervalRef.current = null;
    }

    // Do NOT run background Tesseract OCR during GCI QR or Laser Central barcode scanning
    if (activeSupplierRuleRef.current?.id !== 'ocr_label') {
      return;
    }

    const ocrCadenceMs = CAMERA_PROFILES.ocr_label.ocrIntervalMs || 1350;

    liveOcrIntervalRef.current = setInterval(async () => {
      if (
        !isMountedRef.current ||
        activeSupplierRuleRef.current?.id !== 'ocr_label' ||
        isLiveOcrBusyRef.current ||
        isProcessingOcrLabel ||
        activeScanConfirmationRef.current !== null ||
        activeDuplicateWarningRef.current !== null ||
        isManualModalOpenRef.current
      ) {
        return;
      }

      const container = document.getElementById('camera-scanner-view');
      const video = container?.querySelector('video') as HTMLVideoElement | null;
      if (!video || video.readyState < 2 || video.videoWidth === 0) return;

      const sigInfo = computeVideoFrameSignature(video);
      if (!sigInfo || sigInfo.edgeContrast < 4.5) return;

      if (lastOcrFrameSignatureRef.current.length > 0) {
        const diff = computeFrameSignatureDifference(
          sigInfo.signature,
          lastOcrFrameSignatureRef.current
        );
        if (diff < 4.0) return;
      }

      lastOcrFrameSignatureRef.current = sigInfo.signature;
      isLiveOcrBusyRef.current = true;
      const t0 = performance.now();

      try {
        const isGroupMode =
          scanScopeRef.current?.mode === 'group' && Boolean(groupRef.current);
        const scopedDeliveries = isGroupMode
          ? groupDeliveriesRef.current
          : deliveryRef.current
          ? [deliveryRef.current]
          : [];
        const partsPool = scopedDeliveries.flatMap((d) => d.parts || []);

        const result = await recognizePalletLabelOffline(
          video,
          partsPool,
          { x: 0.05, y: 0.16, width: 0.9, height: 0.68 }
        );
        const ocrElapsedMs = performance.now() - t0;

        if (
          !isMountedRef.current ||
          activeScanConfirmationRef.current !== null ||
          activeDuplicateWarningRef.current !== null ||
          groupConflictModalRef.current !== null
        ) {
          return;
        }

        if (result.partNumber && scopedDeliveries.length > 0) {
          recordDecodeDiagnostics(ocrElapsedMs, true, 'BarcodeDetector (1D) + Offline OCR');
          const matches = isGroupMode
            ? findMatchingPartsInGroup(scopedDeliveries, result.partNumber)
            : findMatchingPartsInDelivery(scopedDeliveries[0], result.partNumber);
          const deduped = matches.filter(
            (m, i, arr) =>
              arr.findIndex((x) => x.delivery.id === m.delivery.id && x.part.id === m.part.id) === i
          );
          if (deduped.length === 0) return;

          const uncompleted = deduped.filter((m) => !m.alreadyFullyScanned);
          if (uncompleted.length === 0) {
            const firstDup = deduped[0];
            triggerDuplicateWarning({
              partNumber: firstDup.part.partNumber,
              description: firstDup.part.description,
              code: result.partNumber,
              itemNumber: firstDup.part.itemNumber,
              palletNumber: firstDup.part.palletNumber,
              scannedAt: firstDup.part.scannedAt,
              scannedBy: firstDup.part.lastScannedByName,
              receivedQuantity: firstDup.part.receivedQuantity,
            });
            return;
          }

          if (isGroupMode && uncompleted.length > 1) {
            playAudio.unexpected(appSettings.soundEnabled);
            triggerHaptic('unexpected', appSettings.vibrationEnabled);
            const conflictState: GroupScanConflictModalState = {
              rawCode: result.partNumber,
              scanMethod: 'ocr_label',
              detectedQuantity: result.quantity || (uncompleted[0].part.quantity ?? 1),
              rawOcrText: result.rawOcrText,
              candidates: uncompleted.map((m) => {
                const req = Math.max(1, m.part.quantity ?? 1);
                const rec =
                  m.part.status === 'received' && typeof m.part.receivedQuantity === 'number'
                    ? m.part.receivedQuantity
                    : 0;
                return {
                  deliveryId: m.delivery.id,
                  docketNumber: m.delivery.docketNumber,
                  supplier: m.delivery.supplier,
                  partId: m.part.id,
                  partNumber: m.part.partNumber,
                  itemNumber: m.part.itemNumber,
                  description: m.part.description,
                  requiredQuantity: req,
                  receivedQuantity: rec,
                  status: m.part.status,
                  matchedMode: m.matchMode,
                };
              }),
            };
            groupConflictModalRef.current = conflictState;
            setGroupConflictModal(conflictState);
            return;
          }

          const match = uncompleted[0];
          playAudio.success(appSettings.soundEnabled);
          triggerHaptic('success', appSettings.vibrationEnabled);

          const newScanData: ActiveScanData = {
            scanMethod: 'ocr_label',
            rawCode: result.partNumber,
            detectedPartNumber: match.part.partNumber,
            detectedDescription: result.description || match.part.description || '',
            detectedQuantity: result.quantity || (match.part.quantity ?? 1),
            matchedPart: match.part,
            docketNumber: match.delivery.docketNumber,
            customerOrSupplier: match.delivery.supplier || '',
            targetDeliveryId: match.delivery.id,
            rawOcrText: result.rawOcrText,
            isUnlisted: false,
            unconfidentFields: result.quantity === null ? ['quantity'] : undefined,
          };

          activeScanConfirmationRef.current = newScanData;
          setActiveScanConfirmation(newScanData);
        }
      } catch (err: any) {
        appendDiagnosticLog('error', `Live OCR note: ${err?.message || String(err)}`);
      } finally {
        isLiveOcrBusyRef.current = false;
      }
    }, ocrCadenceMs);
  }, [
    appendDiagnosticLog,
    appSettings,
    isProcessingOcrLabel,
    recordDecodeDiagnostics,
    triggerDuplicateWarning,
  ]);

  // Reconfigure active decoder loops & resolution profile in-place when switching between GCI, Laser Central, and OCR Label modes
  const reconfigureActiveMode = useCallback(() => {
    configureTrackFocusAndCapabilities(zoomLevelRef.current);
    startNativeBarcodeLoop();
    startLiveOcrDetectionLoop();
  }, [configureTrackFocusAndCapabilities, startLiveOcrDetectionLoop, startNativeBarcodeLoop]);
  reconfigureActiveModeRef.current = reconfigureActiveMode;

  /**
   * Initializes the continuous video camera scanner using shared camera profiles & smart rear-lens ranking
   */
  const startScanner = useCallback(
    async (targetCameraId?: string) => {
      if (isStartingRef.current) return;
      isStartingRef.current = true;
      setIsStarting(true);
      setCameraError(null);

      try {
        // 1. Clean up prior stream
        if (nativeDetectorIntervalRef.current) {
          clearInterval(nativeDetectorIntervalRef.current);
          nativeDetectorIntervalRef.current = null;
        }
        if (focusMaintenanceIntervalRef.current) {
          clearInterval(focusMaintenanceIntervalRef.current);
          focusMaintenanceIntervalRef.current = null;
        }
        if (liveOcrIntervalRef.current) {
          clearInterval(liveOcrIntervalRef.current);
          liveOcrIntervalRef.current = null;
        }
        const existingTrack = getActiveVideoTrack();
        if (existingTrack) {
          try {
            existingTrack.stop();
          } catch {}
        }
        if (scannerRef.current) {
          try {
            if (scannerRef.current.isScanning) {
              await scannerRef.current.stop();
            }
            scannerRef.current.clear();
          } catch {}
          scannerRef.current = null;
        }

        // 2. Discover available devices (already ranked with primary wide rear camera first via rankRearVideoDevices)
        const devices = await enumerateAllVideoInputs();
        const savedCamId =
          typeof window !== 'undefined'
            ? localStorage.getItem(SELECTED_CAMERA_STORAGE_KEY) || ''
            : '';
        const requestedId = targetCameraId ?? (selectedCameraId || savedCamId);

        const orderedCameraIds: string[] = [];
        if (requestedId && (devices.length === 0 || devices.some((d) => d.id === requestedId))) {
          orderedCameraIds.push(requestedId);
        }
        devices.forEach((d) => {
          if (!orderedCameraIds.includes(d.id)) {
            orderedCameraIds.push(d.id);
          }
        });

        const currentRuleId: ScanMode =
          (activeSupplierRuleRef.current?.id as ScanMode) || 'laser_central';
        const profile = CAMERA_PROFILES[currentRuleId] || CAMERA_PROFILES.laser_central;

        const formatsToSupport =
          currentRuleId === 'gci'
            ? [Html5QrcodeSupportedFormats.QR_CODE]
            : currentRuleId === 'ocr_label'
            ? [
                Html5QrcodeSupportedFormats.CODE_128,
                Html5QrcodeSupportedFormats.CODE_39,
                Html5QrcodeSupportedFormats.EAN_13,
                Html5QrcodeSupportedFormats.EAN_8,
                Html5QrcodeSupportedFormats.DATA_MATRIX,
                Html5QrcodeSupportedFormats.ITF,
                Html5QrcodeSupportedFormats.UPC_A,
                Html5QrcodeSupportedFormats.UPC_E,
                Html5QrcodeSupportedFormats.CODABAR,
              ]
            : [
                Html5QrcodeSupportedFormats.QR_CODE,
                Html5QrcodeSupportedFormats.CODE_128,
                Html5QrcodeSupportedFormats.CODE_39,
                Html5QrcodeSupportedFormats.EAN_13,
                Html5QrcodeSupportedFormats.EAN_8,
                Html5QrcodeSupportedFormats.DATA_MATRIX,
                Html5QrcodeSupportedFormats.ITF,
                Html5QrcodeSupportedFormats.UPC_A,
                Html5QrcodeSupportedFormats.UPC_E,
                Html5QrcodeSupportedFormats.CODABAR,
              ];

        const scanner = new Html5Qrcode('camera-scanner-view', {
          formatsToSupport,
          useBarCodeDetectorIfSupported: true,
          verbose: false,
        });
        scannerRef.current = scanner;

        let lastZxingAttemptTs = performance.now();
        const onZxingSuccess = (decodedText: string, decodedResult: any) => {
          const nowTs = performance.now();
          const elapsed = Math.max(1, nowTs - lastZxingAttemptTs);
          lastZxingAttemptTs = nowTs;
          if (isIgnoredNonPartQrPayload(decodedText)) {
            recordDecodeDiagnostics(elapsed, false, activeDecodeMethodRef.current);
            return;
          }
          const currentIsOcr = activeSupplierRuleRef.current?.id === 'ocr_label';
          const formatName = (decodedResult?.result?.format?.formatName || '').toUpperCase();
          const formatEnum = decodedResult?.result?.format?.format;
          if (
            currentIsOcr &&
            (formatName === 'QR_CODE' ||
              formatName === 'QRCODE' ||
              formatEnum === Html5QrcodeSupportedFormats.QR_CODE ||
              formatName.includes('QR'))
          ) {
            return; // Don't scan QR codes in OCR label scan mode
          }
          recordDecodeDiagnostics(elapsed, true, activeDecodeMethodRef.current);
          handleScannedCode(decodedText, 'camera_barcode_qr', formatName);
        };

        const onZxingFrameAttempt = () => {
          const nowTs = performance.now();
          const elapsed = Math.max(1, nowTs - lastZxingAttemptTs);
          lastZxingAttemptTs = nowTs;
          recordDecodeDiagnostics(elapsed, false, activeDecodeMethodRef.current);
        };

        const baseScanConfig: any = {
          fps: currentRuleId === 'gci' ? 24 : 18,
          disableFlip: currentRuleId === 'gci',
          qrbox: (w: number, h: number) => ({
            width: Math.max(180, Math.floor(w * 0.88)),
            height: Math.max(140, Math.floor(h * 0.72)),
          }),
        };

        let started = false;
        let lastErrorMsg = '';

        // Prefer ranked primary rear camera or environment-facing constraint with profile's optimal resolution & continuous autofocus
        if (!requestedId && orderedCameraIds.length === 0) {
          try {
            await scanner.start(
              { facingMode: 'environment' },
              {
                ...baseScanConfig,
                videoConstraints: {
                  facingMode: { ideal: 'environment' },
                  width: { ideal: profile.idealWidth },
                  height: { ideal: profile.idealHeight },
                  frameRate: { ideal: profile.idealFrameRate },
                  advanced: [
                    { focusMode: 'continuous' },
                    { exposureMode: 'continuous' },
                    { whiteBalanceMode: 'continuous' },
                  ] as any,
                } as any,
              },
              onZxingSuccess,
              onZxingFrameAttempt
            );
            started = true;
          } catch {
            // Fall through to ranked deviceId loop or standard facingMode: 'environment'
          }
        }

        if (!started) {
          for (const camId of orderedCameraIds) {
            try {
              await scanner.start(
                { deviceId: { exact: camId } },
                {
                  ...baseScanConfig,
                  videoConstraints: {
                    deviceId: { exact: camId },
                    width: { ideal: profile.idealWidth },
                    height: { ideal: profile.idealHeight },
                    frameRate: { ideal: profile.idealFrameRate },
                    advanced: [
                      { focusMode: 'continuous' },
                      { exposureMode: 'continuous' },
                      { whiteBalanceMode: 'continuous' },
                    ] as any,
                  } as any,
                },
                onZxingSuccess,
                onZxingFrameAttempt
              );
              started = true;
              setSelectedCameraId(camId);
              if (typeof window !== 'undefined') {
                try {
                  localStorage.setItem(SELECTED_CAMERA_STORAGE_KEY, camId);
                } catch {}
              }
              break;
            } catch {
              try {
                await scanner.start(
                  { deviceId: { exact: camId } },
                  baseScanConfig,
                  onZxingSuccess,
                  onZxingFrameAttempt
                );
                started = true;
                setSelectedCameraId(camId);
                if (typeof window !== 'undefined') {
                  try {
                    localStorage.setItem(SELECTED_CAMERA_STORAGE_KEY, camId);
                  } catch {}
                }
                break;
              } catch (camErr: any) {
                lastErrorMsg = camErr?.message || String(camErr);
              }
            }
          }
        }

        if (!started) {
          try {
            await scanner.start(
              { facingMode: 'environment' },
              baseScanConfig,
              onZxingSuccess,
              onZxingFrameAttempt
            );
            started = true;
          } catch (envErr: any) {
            lastErrorMsg = envErr?.message || String(envErr);
          }
        }

        if (!started) {
          if (isMountedRef.current) {
            setIsScanning(false);
            setCameraError(
              lastErrorMsg.includes('Permission') || lastErrorMsg.includes('NotAllowed')
                ? 'Camera permission was denied. Please allow camera access in browser settings.'
                : 'Unable to start camera stream. Tap "Retry Camera" or use Manual / Snap.'
            );
          }
          return;
        }

        // Camera successfully started!
        if (isMountedRef.current) {
          setIsScanning(true);
          setCameraError(null);
        }

        await configureTrackFocusAndCapabilities();
        await startNativeBarcodeLoop();
        startLiveOcrDetectionLoop();
      } catch (err: any) {
        if (isMountedRef.current) {
          setIsScanning(false);
          setCameraError(err?.message || 'Camera initialization error');
        }
      } finally {
        isStartingRef.current = false;
        if (isMountedRef.current) {
          setIsStarting(false);
        }
      }
    },
    [
      appendDiagnosticLog,
      configureTrackFocusAndCapabilities,
      enumerateAllVideoInputs,
      getActiveVideoTrack,
      handleScannedCode,
      recordDecodeDiagnostics,
      selectedCameraId,
      startLiveOcrDetectionLoop,
      startNativeBarcodeLoop,
    ]
  );
  startScannerRef.current = startScanner;

  /**
   * Stop scanner safely
   */
  const stopScanner = useCallback(async () => {
    if (nativeDetectorIntervalRef.current) {
      clearInterval(nativeDetectorIntervalRef.current);
      nativeDetectorIntervalRef.current = null;
    }
    if (focusMaintenanceIntervalRef.current) {
      clearInterval(focusMaintenanceIntervalRef.current);
      focusMaintenanceIntervalRef.current = null;
    }
    if (liveOcrIntervalRef.current) {
      clearInterval(liveOcrIntervalRef.current);
      liveOcrIntervalRef.current = null;
    }
    isNativeDetectingRef.current = false;
    const track = getActiveVideoTrack();
    if (track) {
      try {
        track.stop();
      } catch {}
    }
    if (scannerRef.current) {
      try {
        if (scannerRef.current.isScanning) {
          await scannerRef.current.stop();
        }
        scannerRef.current.clear();
      } catch {}
      scannerRef.current = null;
    }
    setIsScanning(false);
    setTorchOn(false);
  }, [getActiveVideoTrack]);

  // Mount/unmount lifecycle: start camera automatically on mount
  useEffect(() => {
    isMountedRef.current = true;
    prewarmPalletLabelOcrEngine();
    startScanner();

    return () => {
      isMountedRef.current = false;
      stopScanner();
    };
  }, [startScanner, stopScanner]);

  /**
   * Switch to a specific device camera
   */
  const handleSelectCameraDevice = async (deviceId: string) => {
    setIsCameraSelectModalOpen(false);
    setSelectedCameraId(deviceId);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(SELECTED_CAMERA_STORAGE_KEY, deviceId);
      } catch {}
    }
    await startScanner(deviceId);
  };

  /**
   * Manual Snapshot / Shutter capture for instant Barcode/QR Fast-Path + Offline OCR Label processing
   */
  const handleShutterCapture = async () => {
    if (
      isProcessingOcrLabel ||
      isSnappingPhoto ||
      activeScanConfirmation !== null ||
      activeDuplicateWarning !== null
    ) {
      return;
    }

    const container = document.getElementById('camera-scanner-view');
    const video = container?.querySelector('video') as HTMLVideoElement | null;

    if (!video || video.readyState < 2 || video.videoWidth === 0) {
      // Fallback to native file input if video element is not ready
      snapFileInputRef.current?.click();
      return;
    }

    setIsProcessingOcrLabel(true);
    setOcrLabelStatusMessage('Scanning frame for barcodes & label text...');
    triggerVisualFlash('green');

    try {
      const currentMode: ScanMode =
        (activeSupplierRuleRef.current?.id as ScanMode) || 'laser_central';

      // 1. FAST-PATH: Check native BarcodeDetector on the captured video frame (<25ms)
      if (currentMode !== 'ocr_label') {
        const barcodeCheck = await decodeStillImageOrVideoFrameBarcodes(video, currentMode);
        if (barcodeCheck.rawValues.length > 0) {
          recordDecodeDiagnostics(barcodeCheck.elapsedMs, true, barcodeCheck.engineUsed);
          handleScannedCode(barcodeCheck.rawValues[0], 'photo_snap');
          return;
        }
      }

      // 2. Run high-detail unsharp-masked OCR on the video frame
      const isGroupMode =
        scanScopeRef.current?.mode === 'group' && Boolean(groupRef.current);
      const scopedDeliveries = isGroupMode
        ? groupDeliveriesRef.current
        : deliveryRef.current
        ? [deliveryRef.current]
        : [];
      const partsPool = scopedDeliveries.flatMap((d) => d.parts || []);

      const t0 = performance.now();
      const ocrResult = await recognizePalletLabelOffline(
        video,
        partsPool,
        { x: 0.05, y: 0.15, width: 0.9, height: 0.7 }
      );
      recordDecodeDiagnostics(
        performance.now() - t0,
        Boolean(ocrResult.partNumber),
        'Shutter Offline OCR (Unsharp)'
      );

      if (ocrResult.partNumber && scopedDeliveries.length > 0) {
        const matches = isGroupMode
          ? findMatchingPartsInGroup(scopedDeliveries, ocrResult.partNumber)
          : findMatchingPartsInDelivery(scopedDeliveries[0], ocrResult.partNumber);
        const deduped = matches.filter(
          (m, i, arr) =>
            arr.findIndex((x) => x.delivery.id === m.delivery.id && x.part.id === m.part.id) === i
        );
        if (deduped.length === 0) {
          rejectUnscopedCode(
            ocrResult.partNumber,
            isGroupMode
              ? `✕ Rejected: "${ocrResult.partNumber}" does not belong to any docket in group "${groupRef.current?.name || ''}"`
              : `✕ Rejected: "${ocrResult.partNumber}" does not belong to Docket #${scopedDeliveries[0].docketNumber}`
          );
          return;
        }

        const uncompleted = deduped.filter((m) => !m.alreadyFullyScanned);
        if (uncompleted.length === 0) {
          const firstDup = deduped[0];
          triggerDuplicateWarning({
            partNumber: firstDup.part.partNumber,
            description: firstDup.part.description,
            code: ocrResult.partNumber,
            itemNumber: firstDup.part.itemNumber,
            palletNumber: firstDup.part.palletNumber,
            scannedAt: firstDup.part.scannedAt,
            scannedBy: firstDup.part.lastScannedByName,
            receivedQuantity: firstDup.part.receivedQuantity,
          });
          return;
        }

        if (isGroupMode && uncompleted.length > 1) {
          const conflictState: GroupScanConflictModalState = {
            rawCode: ocrResult.partNumber,
            scanMethod: 'ocr_label',
            detectedQuantity: ocrResult.quantity || (uncompleted[0].part.quantity ?? 1),
            rawOcrText: ocrResult.rawOcrText,
            candidates: uncompleted.map((m) => ({
              deliveryId: m.delivery.id,
              docketNumber: m.delivery.docketNumber,
              supplier: m.delivery.supplier,
              partId: m.part.id,
              partNumber: m.part.partNumber,
              itemNumber: m.part.itemNumber,
              description: m.part.description,
              requiredQuantity: Math.max(1, m.part.quantity ?? 1),
              receivedQuantity:
                m.part.status === 'received' && typeof m.part.receivedQuantity === 'number'
                  ? m.part.receivedQuantity
                  : 0,
              status: m.part.status,
              matchedMode: m.matchMode,
            })),
          };
          groupConflictModalRef.current = conflictState;
          setGroupConflictModal(conflictState);
          return;
        }

        const match = uncompleted[0];
        playAudio.success(appSettings.soundEnabled);
        triggerHaptic('success', appSettings.vibrationEnabled);

        const newScanData: ActiveScanData = {
          scanMethod: 'ocr_label',
          rawCode: ocrResult.partNumber,
          detectedPartNumber: match.part.partNumber,
          detectedDescription: ocrResult.description || match.part.description || '',
          detectedQuantity: ocrResult.quantity || (match.part.quantity ?? 1),
          matchedPart: match.part,
          docketNumber: match.delivery.docketNumber,
          customerOrSupplier: match.delivery.supplier || '',
          targetDeliveryId: match.delivery.id,
          rawOcrText: ocrResult.rawOcrText,
          isUnlisted: false,
          unconfidentFields: ocrResult.quantity === null ? ['quantity'] : undefined,
        };

        activeScanConfirmationRef.current = newScanData;
        setActiveScanConfirmation(newScanData);
        return;
      }

      // If no text was recognized with confidence, notify user
      setScanFeedback({
        type: 'unexpected',
        code: 'OCR',
        message: 'No clear part number or label text detected. Try holding closer or tapping to focus.',
        timestamp: Date.now(),
      });
    } catch (err: any) {
      appendDiagnosticLog('error', `Manual capture note: ${err?.message || String(err)}`);
    } finally {
      setIsProcessingOcrLabel(false);
      setOcrLabelStatusMessage('');
    }
  };

  /**
   * Hardware USB/Bluetooth HID Keyboard Wedge Listener
   */
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tagName = target?.tagName?.toUpperCase() || '';
      const isEditable =
        tagName === 'INPUT' ||
        tagName === 'TEXTAREA' ||
        tagName === 'SELECT' ||
        Boolean(target?.isContentEditable);

      if (
        isEditable ||
        activeScanConfirmationRef.current !== null ||
        activeDuplicateWarningRef.current !== null ||
        groupConflictModalRef.current !== null ||
        isManualModalOpenRef.current
      ) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const now = performance.now();
      const gap = now - hidLastKeyTimeRef.current;
      if (gap > 140) {
        hidBufferRef.current = '';
        hidKeystrokeCountRef.current = 0;
        hidFirstKeyTimeRef.current = now;
      }

      if (e.key === 'Enter' || e.key === 'Tab') {
        const candidate = hidBufferRef.current.trim();
        const count = hidKeystrokeCountRef.current;
        hidBufferRef.current = '';
        hidKeystrokeCountRef.current = 0;

        if (candidate.length >= 2 && count >= 2) {
          e.preventDefault();
          e.stopPropagation();
          handleScannedCode(candidate, 'external_hid');
        }
        return;
      }

      if (e.key.length === 1) {
        hidBufferRef.current += e.key;
        hidKeystrokeCountRef.current += 1;
        hidLastKeyTimeRef.current = now;
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [handleScannedCode]);

  /**
   * Smart search candidate suggestions for manual code entry (scoped to docket or group dockets)
   */
  const manualCandidates = useMemo(() => {
    const q = manualCodeInput.trim();
    if (!q) return [];
    const isGroupMode = scanScope?.mode === 'group' && Boolean(group);
    const scopedDels = isGroupMode
      ? groupDeliveries
      : delivery
      ? [delivery]
      : [];

    const results: Array<{ part: DeliveryPart; docketNumber: string }> = [];
    for (const del of scopedDels) {
      const matches = filterPartsSmart(del.parts || [], q, {
        docketNumber: del.docketNumber,
        supplier: del.supplier,
      });
      for (const m of matches) {
        results.push({ part: m, docketNumber: del.docketNumber });
        if (results.length >= 6) return results;
      }
    }
    return results;
  }, [scanScope?.mode, group, groupDeliveries, delivery, manualCodeInput]);

  const handleSelectCandidate = (partNumber: string) => {
    setIsManualModalOpen(false);
    setManualCodeInput('');
    handleScannedCode(partNumber, 'manual');
  };

  /**
   * Handle manual code entry submit
   */
  const handleManualCodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = manualCodeInput.trim();
    if (!clean) return;
    setIsManualModalOpen(false);
    setManualCodeInput('');
    handleScannedCode(clean, 'manual');
  };

  /**
   * Handle photo upload from gallery or file picker (runs Barcode/QR fast-path first, then Offline OCR)
   */
  const handleFilePicked = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    setIsProcessingOcrLabel(true);
    setOcrLabelStatusMessage('Scanning photo for barcodes & label text...');

    try {
      const currentMode: ScanMode =
        (activeSupplierRuleRef.current?.id as ScanMode) || 'laser_central';

      // 1. FAST-PATH: Check native BarcodeDetector on the uploaded image file (<25ms)
      if (currentMode !== 'ocr_label') {
        const barcodeCheck = await decodeStillImageOrVideoFrameBarcodes(file, currentMode);
        if (barcodeCheck.rawValues.length > 0) {
          recordDecodeDiagnostics(barcodeCheck.elapsedMs, true, barcodeCheck.engineUsed);
          handleScannedCode(barcodeCheck.rawValues[0], 'photo_snap');
          return;
        }
      }

      // 2. Run high-detail unsharp-masked OCR on picked file
      const isGroupMode =
        scanScopeRef.current?.mode === 'group' && Boolean(groupRef.current);
      const scopedDeliveries = isGroupMode
        ? groupDeliveriesRef.current
        : deliveryRef.current
        ? [deliveryRef.current]
        : [];
      const partsPool = scopedDeliveries.flatMap((d) => d.parts || []);

      const t0 = performance.now();
      const ocrResult = await recognizePalletLabelOffline(
        file,
        partsPool,
        { x: 0, y: 0, width: 1, height: 1 }
      );
      recordDecodeDiagnostics(
        performance.now() - t0,
        Boolean(ocrResult.partNumber),
        'File Offline OCR (Unsharp)'
      );

      const partNo = (ocrResult.partNumber || file.name.replace(/\.[^.]+$/, '')).trim();
      if (!partNo || scopedDeliveries.length === 0) return;

      const matches = isGroupMode
        ? findMatchingPartsInGroup(scopedDeliveries, partNo)
        : findMatchingPartsInDelivery(scopedDeliveries[0], partNo);
      const deduped = matches.filter(
        (m, i, arr) =>
          arr.findIndex((x) => x.delivery.id === m.delivery.id && x.part.id === m.part.id) === i
      );

      if (deduped.length === 0) {
        rejectUnscopedCode(
          partNo,
          isGroupMode
            ? `✕ Rejected: "${partNo}" does not belong to any docket in group "${groupRef.current?.name || ''}"`
            : `✕ Rejected: "${partNo}" does not belong to Docket #${scopedDeliveries[0].docketNumber}`
        );
        return;
      }

      const uncompleted = deduped.filter((m) => !m.alreadyFullyScanned);
      if (uncompleted.length === 0) {
        const firstDup = deduped[0];
        triggerDuplicateWarning({
          partNumber: firstDup.part.partNumber,
          description: firstDup.part.description,
          code: partNo,
          itemNumber: firstDup.part.itemNumber,
          palletNumber: firstDup.part.palletNumber,
          scannedAt: firstDup.part.scannedAt,
          scannedBy: firstDup.part.lastScannedByName,
          receivedQuantity: firstDup.part.receivedQuantity,
        });
        return;
      }

      if (isGroupMode && uncompleted.length > 1) {
        const conflictState: GroupScanConflictModalState = {
          rawCode: partNo,
          scanMethod: 'ocr_label',
          detectedQuantity: ocrResult.quantity || (uncompleted[0].part.quantity ?? 1),
          rawOcrText: ocrResult.rawOcrText,
          candidates: uncompleted.map((m) => ({
            deliveryId: m.delivery.id,
            docketNumber: m.delivery.docketNumber,
            supplier: m.delivery.supplier,
            partId: m.part.id,
            partNumber: m.part.partNumber,
            itemNumber: m.part.itemNumber,
            description: m.part.description,
            requiredQuantity: Math.max(1, m.part.quantity ?? 1),
            receivedQuantity:
              m.part.status === 'received' && typeof m.part.receivedQuantity === 'number'
                ? m.part.receivedQuantity
                : 0,
            status: m.part.status,
            matchedMode: m.matchMode,
          })),
        };
        groupConflictModalRef.current = conflictState;
        setGroupConflictModal(conflictState);
        return;
      }

      const match = uncompleted[0];
      const newScanData: ActiveScanData = {
        scanMethod: 'ocr_label',
        rawCode: partNo,
        detectedPartNumber: match.part.partNumber,
        detectedDescription: ocrResult.description || match.part.description || '',
        detectedQuantity: ocrResult.quantity || (match.part.quantity ?? 1),
        matchedPart: match.part,
        docketNumber: match.delivery.docketNumber,
        customerOrSupplier: match.delivery.supplier || '',
        targetDeliveryId: match.delivery.id,
        rawOcrText: ocrResult.rawOcrText,
        isUnlisted: false,
      };

      activeScanConfirmationRef.current = newScanData;
      setActiveScanConfirmation(newScanData);
    } catch (err: any) {
      appendDiagnosticLog('error', `File OCR failed: ${err?.message || String(err)}`);
    } finally {
      setIsProcessingOcrLabel(false);
      setOcrLabelStatusMessage('');
    }
  };

  const cssZoomStyle =
    !supportsHardwareZoom && zoomLevel > 1
      ? { transform: `scale(${zoomLevel})`, transformOrigin: 'center center' }
      : undefined;

  return (
    <div className="fixed inset-x-0 top-13 bottom-15 z-20 bg-[var(--pt-bg,#080B12)] overflow-hidden select-none flex flex-col">
      {/* Hidden file pickers for shutter & gallery uploads */}
      <input
        ref={snapFileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => handleFilePicked(e.target.files)}
      />
      <input
        ref={galleryFileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/jpg,image/heic,image/*"
        className="hidden"
        onChange={(e) => {
          handleFilePicked(e.target.files);
          e.target.value = '';
        }}
      />

      {/* Hidden offscreen container for static image decodes */}
      <div id="pallettick-offscreen-scanner" className="hidden" aria-hidden="true" />

      {/* ============================================================ */}
      {/* FULL-SCREEN CAMERA PREVIEW & VIEWFINDER                      */}
      {/* ============================================================ */}
      <div className="pt-camera-viewport relative flex-1 w-full h-full bg-black overflow-hidden flex items-center justify-center">
        {/* Interactive Camera Container */}
        <div
          onClick={handleTapToFocus}
          className="relative w-full h-full overflow-hidden bg-black cursor-crosshair touch-none flex items-center justify-center"
        >
          {/* Video Stream Element */}
          <div
            id="camera-scanner-view"
            style={cssZoomStyle}
            className="w-full h-full transform-gpu transition-transform duration-150 [&_video]:!w-full [&_video]:!h-full [&_video]:!object-cover [&_[id$='__scan_region']_img]:hidden [&_[id='qr-shaded-region']]:hidden"
          />

          {/* Tap-to-Focus Indicator Ring */}
          {focusRingPos && (
            <div
              style={{
                left: focusRingPos.x - 24,
                top: focusRingPos.y - 24,
                borderColor: 'var(--pt-accent-secondary, #C084FC)',
              }}
              className="pointer-events-none absolute z-30 w-12 h-12 rounded-full border-2 bg-[var(--pt-primary,#A020F0)]/15 flex items-center justify-center animate-ping"
            >
              <div
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: 'var(--pt-accent-secondary, #C084FC)' }}
              />
            </div>
          )}

          {/* Full-Frame Visual Recognition Flash */}
          {flashColor && (
            <div
              className={`pointer-events-none absolute inset-0 z-20 border-[6px] transition-all duration-150 ${
                flashColor === 'green'
                  ? 'border-[#00D979] bg-[#00D979]/20 shadow-[inset_0_0_80px_rgba(0,217,121,0.45)]'
                  : flashColor === 'orange'
                  ? 'border-[#F59E0B] bg-[#F59E0B]/20 shadow-[inset_0_0_80px_rgba(245,158,11,0.45)]'
                  : 'border-[#EF4444] bg-[#EF4444]/20 shadow-[inset_0_0_80px_rgba(239,68,68,0.45)]'
              }`}
            />
          )}

          {/* ============================================================ */}
          {/* CENTRAL INDUSTRIAL SCANNING FRAME & LASER ANIMATION          */}
          {/* ============================================================ */}
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center p-4">
            {/* Viewfinder Target Reticle */}
            <div className="relative w-[84%] max-w-[350px] aspect-[4/3] rounded-2xl flex items-center justify-center">
              {/* Theme-Aware High-Contrast Targeting Corner Guides */}
              <div
                className="absolute top-0 left-0 w-9 h-9 border-t-3 border-l-3 rounded-tl-xl"
                style={{
                  borderColor: 'var(--pt-accent-secondary, #C084FC)',
                  boxShadow: '0 0 14px var(--pt-glow, rgba(160, 32, 240, 0.55))',
                }}
              />
              <div
                className="absolute top-0 right-0 w-9 h-9 border-t-3 border-r-3 rounded-tr-xl"
                style={{
                  borderColor: 'var(--pt-accent-secondary, #C084FC)',
                  boxShadow: '0 0 14px var(--pt-glow, rgba(160, 32, 240, 0.55))',
                }}
              />
              <div
                className="absolute bottom-0 left-0 w-9 h-9 border-b-3 border-l-3 rounded-bl-xl"
                style={{
                  borderColor: 'var(--pt-accent-secondary, #C084FC)',
                  boxShadow: '0 0 14px var(--pt-glow, rgba(160, 32, 240, 0.55))',
                }}
              />
              <div
                className="absolute bottom-0 right-0 w-9 h-9 border-b-3 border-r-3 rounded-br-xl"
                style={{
                  borderColor: 'var(--pt-accent-secondary, #C084FC)',
                  boxShadow: '0 0 14px var(--pt-glow, rgba(160, 32, 240, 0.55))',
                }}
              />

              {/* Subtle Animated Theme Laser Beam */}
              {isScanning && !activeScanConfirmation && (
                <div className="absolute inset-x-2 pointer-events-none animate-barcode-scan">
                  <div
                    className="h-[2px] w-full"
                    style={{
                      background:
                        'linear-gradient(90deg, transparent 0%, var(--pt-accent-secondary, #C084FC) 50%, transparent 100%)',
                      boxShadow: '0 0 14px var(--pt-primary, #A020F0)',
                    }}
                  />
                  <div
                    className="h-5 -mt-2.5 w-full blur-xs"
                    style={{
                      background:
                        'linear-gradient(180deg, var(--pt-glow-soft, rgba(160, 32, 240, 0.25)) 0%, transparent 100%)',
                    }}
                  />
                </div>
              )}

              {/* Subtle Central Scanning Reticle */}
              <div
                className="w-4 h-4 border rounded-full flex items-center justify-center opacity-70"
                style={{ borderColor: 'var(--pt-accent-secondary, #C084FC)' }}
              >
                <div
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: 'var(--pt-accent-secondary, #C084FC)' }}
                />
              </div>
            </div>

            {/* Instruction Tagline below reticle */}
            <div className="mt-4 px-3.5 py-1.5 rounded-full bg-[#080B12]/80 backdrop-blur-md border border-[var(--pt-border,#29243D)] text-center shadow-lg">
              <span className="font-mono text-[10px] font-bold tracking-wider text-[var(--pt-accent-secondary,#C084FC)] uppercase">
                {activeSupplierRule.id === 'ocr_label'
                  ? 'OCR Label Mode • Reading printed label text (QR auto-scan disabled)'
                  : `${activeSupplierRule.name} • Align barcode, QR code or pallet label`}
              </span>
            </div>

            {/* Immediate High-Contrast Scan Feedback Banner */}
            {scanFeedback && (
              <div
                className={`mt-2.5 px-4 py-2 rounded-xl border font-mono text-xs font-extrabold shadow-2xl animate-in zoom-in-95 duration-150 ${
                  scanFeedback.type === 'unexpected'
                    ? 'bg-red-950/95 border-[#EF4444] text-[#FCA5A5]'
                    : scanFeedback.type === 'quantity_mismatch' || scanFeedback.type === 'pending_sync'
                    ? 'bg-amber-950/95 border-[#F59E0B] text-[#F59E0B]'
                    : 'bg-emerald-950/95 border-[#00D979] text-[#00D979]'
                }`}
              >
                {scanFeedback.message}
              </div>
            )}
          </div>

          {/* ============================================================ */}
          {/* CAMERA ERROR OVERLAY & RETRY ACTION                         */}
          {/* ============================================================ */}
          {cameraError && (
            <div className="absolute inset-0 z-40 bg-[var(--pt-bg,#080B12)]/95 flex flex-col items-center justify-center p-6 text-center animate-fade-in">
              <div className="w-14 h-14 rounded-2xl bg-[#EF4444]/15 border border-[#EF4444]/40 text-[#EF4444] flex items-center justify-center mb-4 shadow-[0_0_30px_rgba(239,68,68,0.3)]">
                <AlertTriangle className="w-7 h-7" />
              </div>
              <h3 className="font-bold text-base text-white mb-2">Camera Feed Restricted</h3>
              <p className="text-xs text-[var(--pt-text-secondary,#A3A8BD)] max-w-xs mb-5 leading-relaxed">
                {cameraError}
              </p>

              <div className="flex flex-col gap-2.5 w-full max-w-xs">
                <button
                  type="button"
                  onClick={() => startScanner()}
                  className="w-full h-11 rounded-xl pt-btn-primary font-mono font-bold text-xs tracking-wider uppercase flex items-center justify-center gap-2 cursor-pointer"
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>Retry Camera</span>
                </button>

                <button
                  type="button"
                  onClick={() => setIsManualModalOpen(true)}
                  className="w-full h-10 rounded-xl bg-[var(--pt-card,#15182A)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-white font-mono font-semibold text-xs flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Keyboard className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)]" />
                  <span>Enter Code Manually</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ============================================================ */}
        {/* TOP HUD BAR: BRANDING + DOCKET BADGE + CLOSE/BACK BUTTON     */}
        {/* ============================================================ */}
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute top-0 inset-x-0 z-30 px-3 py-2.5 bg-gradient-to-b from-[#080B12]/90 via-[#080B12]/60 to-transparent flex items-center justify-between gap-2"
        >
          {/* Left: Back/Close button + PartTrack branding + Docket number */}
          <div className="flex items-center gap-2 min-w-0">
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="w-8 h-8 rounded-full bg-black/70 hover:bg-[var(--pt-card,#15182A)] border border-white/15 text-zinc-200 hover:text-white flex items-center justify-center cursor-pointer transition-colors shrink-0"
                title="Return to Dashboard"
                aria-label="Back to dashboard"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}

            <div className="flex items-center gap-1.5 shrink-0">
              <img
                src="/parttrack-icon.png"
                alt="PartTrack"
                className="w-5 h-5 rounded-[4px] object-cover shadow-xs"
              />
              <span className="font-bold text-xs text-white tracking-tight hidden sm:inline">
                PartTrack
              </span>
            </div>

            {scanScope?.mode === 'group' && group ? (
              <span className="px-2.5 py-0.5 rounded-lg bg-[#15182A]/90 border border-[var(--pt-primary,#A020F0)]/50 text-[var(--pt-primary-light,#C084FC)] font-mono text-[11px] font-bold truncate max-w-[180px] sm:max-w-[280px] inline-flex items-center gap-1.5">
                <FolderKanban className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">
                  Group: {group.name} ({groupDeliveries.length})
                </span>
              </span>
            ) : delivery ? (
              <span className="px-2.5 py-0.5 rounded-lg bg-[#15182A]/90 border border-[var(--pt-border,#29243D)] text-white font-mono text-[11px] font-bold truncate max-w-[160px] sm:max-w-[260px]">
                Docket #{delivery.docketNumber} · {delivery.supplier}
              </span>
            ) : (
              <span className="text-[11px] text-zinc-400 font-mono">No scoped target</span>
            )}
          </div>

          {/* Right: Live Scanning Status Indicator + Diagnostics Toggle */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setShowDiagnosticsHud((prev) => !prev)}
              className={`px-2.5 py-1 rounded-full border font-mono text-[10px] font-bold transition-colors cursor-pointer ${
                showDiagnosticsHud
                  ? 'pt-btn-primary text-white'
                  : 'bg-black/70 text-zinc-300 border-white/15 hover:border-[var(--pt-primary,#A020F0)]'
              }`}
              title="Toggle Camera & QR Decoder Diagnostics"
            >
              DIAG
            </button>
            <div className="px-2.5 py-1 rounded-full bg-[#15182A]/90 border border-[var(--pt-primary,#A020F0)]/50 text-[var(--pt-primary-light,#C084FC)] font-mono text-[10px] font-bold flex items-center gap-1.5 shadow-[0_0_12px_var(--pt-glow,rgba(160,32,240,0.35))]">
              <span className="w-2 h-2 rounded-full bg-[#00D979] animate-pulse" />
              <span>
                {activeSupplierRule.id === 'gci'
                  ? 'GCI QR FAST'
                  : activeSupplierRule.id === 'ocr_label'
                  ? 'OCR LABEL HD'
                  : 'LASER 1D HD'}
              </span>
            </div>
          </div>
        </div>

        {/* ============================================================ */}
        {/* LIVE CAMERA & SCANNER DIAGNOSTICS OVERLAY (ALL MODES)         */}
        {/* ============================================================ */}
        {showDiagnosticsHud && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute top-13 right-3 z-30 w-80 p-3.5 rounded-2xl bg-[#080B12]/95 backdrop-blur-md border border-[var(--pt-primary,#A020F0)]/50 text-[10px] font-mono text-zinc-200 shadow-2xl space-y-1"
          >
            <div className="flex items-center justify-between border-b border-white/10 pb-1 mb-1 text-[var(--pt-primary-light,#C084FC)] font-bold uppercase">
              <span>Camera &amp; Scanner Diag</span>
              <span>{activeSupplierRule.name}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">1. Profile:</span>
              <span className="text-[var(--pt-primary-light,#C084FC)] font-bold truncate max-w-[180px]">
                {actualCameraInfo?.cameraProfile ||
                  CAMERA_PROFILES[(activeSupplierRule.id as ScanMode) || 'laser_central']
                    ?.profileLabel}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">2. Camera Device:</span>
              <span className="text-white truncate max-w-[180px]">
                {actualCameraInfo?.deviceLabel || 'Environment Rear'}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">3. Resolution / FPS:</span>
              <span className="text-white">
                {actualCameraInfo?.width || 0}×{actualCameraInfo?.height || 0}
                {actualCameraInfo?.frameRate ? ` @ ${actualCameraInfo.frameRate}fps` : ''}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">4. Supported Focus:</span>
              <span className="text-white truncate max-w-[180px]">
                {actualCameraInfo?.supportedFocusModes?.join(', ') || 'continuous'}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">5. Active Focus Mode:</span>
              <span className="text-[#00D979] font-bold">
                {actualCameraInfo?.focusMode || 'continuous'}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">6. Exposure / WB:</span>
              <span className="text-white">
                {actualCameraInfo?.exposureMode || 'continuous'} /{' '}
                {actualCameraInfo?.whiteBalanceMode || 'continuous'}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">7. Active Decoder:</span>
              <span className="text-[var(--pt-primary-light,#C084FC)] truncate max-w-[180px]">
                {actualCameraInfo?.decodeMethod || activeDecodeMethodRef.current}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">8. Scan Frequency:</span>
              <span className="text-white">
                {actualCameraInfo?.scanFrequencyHz ?? 22.2} Hz (
                {actualCameraInfo?.scanIntervalMs ?? 45} ms)
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">9. Avg Decode Time:</span>
              <span className="text-white">
                {actualCameraInfo?.avgDecodeTimeMs ?? 0} ms (last:{' '}
                {actualCameraInfo?.lastDecodeTimeMs ?? 0} ms)
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">10. Last Match Time:</span>
              <span className="text-[#00D979]">
                {actualCameraInfo?.lastRecognitionTimeMs != null
                  ? `${actualCameraInfo.lastRecognitionTimeMs} ms (${
                      actualCameraInfo.lastRecognitionTimestamp || 'just now'
                    })`
                  : 'Awaiting scan'}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">11. Attempts to Match:</span>
              <span className="text-[#F59E0B] font-bold">
                {actualCameraInfo?.attemptsBeforeLastSuccess || 0} (live:{' '}
                {actualCameraInfo?.currentAttemptCount || 0})
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">12. Multi-Decoders:</span>
              <span
                className={
                  actualCameraInfo?.multipleDecodersActive
                    ? 'text-[#EF4444] font-bold'
                    : 'text-[#00D979] font-bold'
                }
              >
                {actualCameraInfo?.multipleDecodersActive
                  ? `YES (${actualCameraInfo?.concurrentDecodersCount})`
                  : 'NO (Single-Flight = 1)'}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">13. Stream Status:</span>
              <span className="text-[#00D979] font-bold uppercase">
                {isScanning
                  ? actualCameraInfo?.streamStatus || 'ACTIVE'
                  : isStarting
                  ? 'INITIALIZING'
                  : 'IDLE'}
              </span>
            </div>
          </div>
        )}

        {/* ============================================================ */}
        {/* BOTTOM ACCESSIBLE CONTROL BAR (ONE-HANDED MOBILE DOCK)        */}
        {/* ============================================================ */}
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-4 inset-x-2.5 z-30 flex justify-center pointer-events-auto"
        >
          <div className="w-full max-w-md px-2.5 py-2 rounded-2xl bg-[#101321]/90 backdrop-blur-xl border border-[var(--pt-border,#29243D)] shadow-[0_12px_36px_rgba(0,0,0,0.85)] flex items-center justify-between gap-1">
            {/* 1. Flashlight Toggle */}
            <button
              type="button"
              onClick={toggleTorch}
              disabled={!hasTorch}
              className={`w-11 h-11 rounded-xl flex flex-col items-center justify-center transition-all cursor-pointer shrink-0 ${
                torchOn
                  ? 'bg-[#F59E0B] text-black shadow-[0_0_15px_rgba(245,158,11,0.6)]'
                  : hasTorch
                  ? 'bg-[#15182A] hover:bg-white/10 text-zinc-200 border border-[var(--pt-border,#29243D)]'
                  : 'bg-[#15182A]/40 text-zinc-600 opacity-40 cursor-not-allowed'
              }`}
              title={hasTorch ? (torchOn ? 'Torch ON' : 'Torch OFF') : 'Torch unavailable'}
              aria-label="Toggle flashlight"
            >
              <Flashlight className="w-4 h-4 stroke-[2.2]" />
              <span className="text-[8px] font-mono mt-0.5 font-bold uppercase">
                {torchOn ? 'ON' : 'LIGHT'}
              </span>
            </button>

            {/* 2. Change Camera Device Selector (supports all device cameras) */}
            <button
              type="button"
              onClick={() => {
                enumerateAllVideoInputs();
                setIsCameraSelectModalOpen(true);
              }}
              className="w-11 h-11 rounded-xl bg-[#15182A] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-zinc-200 hover:text-white flex flex-col items-center justify-center transition-colors cursor-pointer shrink-0"
              title="Switch camera device"
              aria-label="Switch camera"
            >
              <FlipHorizontal className="w-4 h-4 stroke-[2.2]" />
              <span className="text-[8px] font-mono mt-0.5 font-bold uppercase">CAM</span>
            </button>

            {/* 3. CENTER SHUTTER BUTTON: Manual capture for instant OCR / Barcode */}
            <button
              type="button"
              onClick={handleShutterCapture}
              disabled={isProcessingOcrLabel || isSnappingPhoto || activeScanConfirmation !== null}
              className="w-14 h-14 -my-2 rounded-full pt-btn-primary text-white flex items-center justify-center active:scale-95 transition-all cursor-pointer border-2 border-white/30 shrink-0"
              title="Capture label or barcode snapshot"
              aria-label="Capture snapshot"
            >
              {isProcessingOcrLabel ? (
                <RefreshCw className="w-6 h-6 animate-spin text-white" />
              ) : (
                <Camera className="w-6 h-6 stroke-[2.5]" />
              )}
            </button>

            {/* 4. Manual Code Entry */}
            <button
              type="button"
              onClick={() => setIsManualModalOpen(true)}
              className="w-11 h-11 rounded-xl bg-[#15182A] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-zinc-200 hover:text-white flex flex-col items-center justify-center transition-colors cursor-pointer shrink-0"
              title="Type part number or code manually"
              aria-label="Manual code entry"
            >
              <Keyboard className="w-4 h-4 stroke-[2.2]" />
              <span className="text-[8px] font-mono mt-0.5 font-bold uppercase">TYPE</span>
            </button>

            {/* 5. Gallery Photo Upload */}
            <button
              type="button"
              onClick={() => galleryFileInputRef.current?.click()}
              className="w-11 h-11 rounded-xl bg-[#15182A] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-zinc-200 hover:text-white flex flex-col items-center justify-center transition-colors cursor-pointer shrink-0"
              title="Import photo from gallery"
              aria-label="Import photo from gallery"
            >
              <Images className="w-4 h-4 stroke-[2.2]" />
              <span className="text-[8px] font-mono mt-0.5 font-bold uppercase">PHOTO</span>
            </button>

            {/* 6. Supplier Label Format Selector */}
            <button
              type="button"
              onClick={() => setIsSupplierModalOpen(true)}
              className={`w-11 h-11 rounded-xl flex flex-col items-center justify-center transition-colors cursor-pointer shrink-0 border ${
                isSupplierModalOpen
                  ? 'pt-btn-primary text-white'
                  : 'bg-[#15182A] hover:bg-white/10 border-[var(--pt-border,#29243D)] text-zinc-200 hover:text-white'
              }`}
              title={`Supplier Format: ${activeSupplierRule.name}`}
              aria-label="Select supplier label format"
            >
              <Tag className="w-4 h-4 stroke-[2.2]" />
              <span className="text-[8px] font-mono mt-0.5 font-bold uppercase">MODE</span>
            </button>
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/* SCAN CONFIRMATION SCREEN / MODAL                             */}
      {/* ============================================================ */}
      {activeScanConfirmation && (
        (() => {
          const confirmTargetDelivery =
            (activeScanConfirmation.targetDeliveryId
              ? groupDeliveries.find((d) => d.id === activeScanConfirmation.targetDeliveryId)
              : undefined) || delivery;
          if (!confirmTargetDelivery) return null;
          return (
            <ScanConfirmationModal
              scan={activeScanConfirmation}
              delivery={confirmTargetDelivery}
              onSaveAndScanNext={handleSaveAndScanNext}
              onConfirmAndSave={handleConfirmAndSave}
              onDiscard={handleDiscard}
            />
          );
        })()
      )}

      {/* ============================================================ */}
      {/* DOCKET GROUP SCAN CONFLICT ALLOCATION MODAL                  */}
      {/* ============================================================ */}
      {groupConflictModal && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => {
            groupConflictModalRef.current = null;
            setGroupConflictModal(null);
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-[var(--pt-card,#15182A)] border border-[var(--pt-primary,#A020F0)]/60 p-5 shadow-2xl space-y-4 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-[var(--pt-primary-light,#C084FC)] font-bold">
                  <FolderKanban className="w-3.5 h-3.5" />
                  <span>Multiple Dockets Match Part</span>
                </div>
                <h3 className="font-mono font-extrabold text-sm mt-1">
                  Allocate Scan &ldquo;{groupConflictModal.rawCode}&rdquo;
                </h3>
                <p className="text-xs text-[var(--pt-text-secondary,#A3A8BD)] mt-0.5">
                  Select which docket in &ldquo;{group?.name}&rdquo; should receive this part:
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  groupConflictModalRef.current = null;
                  setGroupConflictModal(null);
                }}
                className="w-7 h-7 rounded-full bg-[var(--pt-bg-secondary,#101321)] text-zinc-400 hover:text-white flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {groupConflictModal.candidates.map((cand) => {
                const remaining = Math.max(0, cand.requiredQuantity - cand.receivedQuantity);
                return (
                  <button
                    key={`${cand.deliveryId}_${cand.partId}`}
                    type="button"
                    onClick={() => {
                      const targetDel = groupDeliveries.find((d) => d.id === cand.deliveryId);
                      const targetPart = targetDel?.parts.find((p) => p.id === cand.partId);
                      if (!targetDel || !targetPart) return;
                      const scanData: ActiveScanData = {
                        scanMethod: groupConflictModal.scanMethod,
                        rawCode: groupConflictModal.rawCode,
                        detectedPartNumber: targetPart.partNumber,
                        detectedDescription: targetPart.description,
                        detectedQuantity:
                          groupConflictModal.detectedQuantity || Math.max(1, targetPart.quantity ?? 1),
                        matchedPart: targetPart,
                        docketNumber: targetDel.docketNumber,
                        customerOrSupplier: targetDel.supplier || '',
                        targetDeliveryId: targetDel.id,
                        rawOcrText: groupConflictModal.rawOcrText,
                        isUnlisted: false,
                      };
                      groupConflictModalRef.current = null;
                      setGroupConflictModal(null);
                      activeScanConfirmationRef.current = scanData;
                      setActiveScanConfirmation(scanData);
                    }}
                    className="w-full p-3 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] hover:border-[var(--pt-primary,#A020F0)] text-left transition-all cursor-pointer flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="font-mono font-extrabold text-xs text-white flex items-center gap-2">
                        <span>Docket #{cand.docketNumber}</span>
                        <span className="text-[var(--pt-primary-light,#C084FC)] font-semibold truncate">
                          {cand.supplier}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-[var(--pt-text-secondary,#A3A8BD)] mt-0.5 truncate">
                        {cand.partNumber} · No. {cand.itemNumber}
                      </div>
                    </div>
                    <div className="text-right font-mono shrink-0">
                      <div className="text-xs font-bold text-[#F59E0B] tabular-nums">
                        {cand.receivedQuantity} / {cand.requiredQuantity}
                      </div>
                      <div className="text-[10px] text-[var(--pt-text-muted,#737B94)]">
                        {remaining} left
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* STRICT DUPLICATE SCAN WARNING MODAL (PROMINENT RED POPUP)    */}
      {/* ============================================================ */}
      {activeDuplicateWarning && (
        <DuplicateScanModal
          data={activeDuplicateWarning}
          onDismiss={handleDismissDuplicateWarning}
        />
      )}

      {/* ============================================================ */}
      {/* UNIVERSAL CAMERA SELECTOR MODAL (ALLOWS ALL DEVICE CAMERAS)  */}
      {/* ============================================================ */}
      {isCameraSelectModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150"
          onClick={() => setIsCameraSelectModalOpen(false)}
        >
          <div
            className="w-full max-w-sm bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] rounded-2xl shadow-2xl p-5 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Camera className="w-5 h-5 text-[var(--pt-primary-light,#C084FC)]" />
                <h3 className="font-bold text-sm">Select Camera Device</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsCameraSelectModalOpen(false)}
                className="w-7 h-7 rounded-full bg-[var(--pt-bg-secondary,#101321)] text-zinc-400 hover:text-white flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-[var(--pt-text-secondary,#A3A8BD)] mb-3">
              Choose from all detected optical sensors and connected USB/Bluetooth cameras:
            </p>

            <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
              {availableCameras.length === 0 ? (
                <div className="p-3 rounded-lg bg-[var(--pt-bg,#080B12)] text-xs text-zinc-400 text-center">
                  Scanning for device cameras...
                </div>
              ) : (
                availableCameras.map((cam, idx) => {
                  const isSelected = cam.id === selectedCameraId;
                  return (
                    <button
                      key={cam.id || idx}
                      type="button"
                      onClick={() => handleSelectCameraDevice(cam.id)}
                      className={`w-full p-3 rounded-xl border text-left flex items-center justify-between gap-2 cursor-pointer transition-all ${
                        isSelected
                          ? 'bg-[var(--pt-bg,#080B12)] border-[var(--pt-primary,#A020F0)] text-white shadow-[0_0_15px_var(--pt-glow,rgba(160,32,240,0.3))]'
                          : 'bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/5 border-[var(--pt-border,#29243D)] text-zinc-300'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-xs font-bold truncate">
                          {cam.label || `Camera ${idx + 1}`}
                        </div>
                        <div className="text-[10px] text-[var(--pt-text-muted,#737B94)] font-mono truncate">
                          ID: {cam.id ? cam.id.slice(0, 16) + '...' : 'Default'}
                        </div>
                      </div>
                      {isSelected && (
                        <Check className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)] shrink-0" />
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* SUPPLIER LABEL FORMAT SELECTOR MODAL                         */}
      {/* ============================================================ */}
      {isSupplierModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150"
          onClick={() => setIsSupplierModalOpen(false)}
        >
          <div
            className="w-full max-w-sm bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] rounded-2xl shadow-2xl p-5 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Tag className="w-5 h-5 text-[var(--pt-primary-light,#C084FC)]" />
                <h3 className="font-bold text-sm">Scanning Mode &amp; Supplier Format</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsSupplierModalOpen(false)}
                className="w-7 h-7 rounded-full bg-[var(--pt-bg-secondary,#101321)] text-zinc-400 hover:text-white flex items-center justify-center cursor-pointer"
                aria-label="Close supplier format selector"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mb-3 px-3 py-2 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] flex items-center justify-between text-xs">
              <span className="text-[var(--pt-text-secondary,#A3A8BD)]">Active Format:</span>
              <span className="font-mono font-bold text-[var(--pt-primary-light,#C084FC)]">
                {activeSupplierRule.name}
              </span>
            </div>

            <div className="space-y-2">
              {(
                [
                  {
                    id: 'laser_central' as SupplierRuleId,
                    name: 'Laser Central',
                    subtitle: '1D Dash Barcodes (######-No) & Part # QR Codes',
                    icon: Barcode,
                  },
                  {
                    id: 'gci' as SupplierRuleId,
                    name: 'GCI',
                    subtitle: '2D QR Codes & Part / Item Number Labels',
                    icon: QrCode,
                  },
                  {
                    id: 'ocr_label' as SupplierRuleId,
                    name: 'OCR Label Scanner',
                    subtitle: 'Printed Text Pallet Labels (Part #, Desc & Qty)',
                    icon: FileText,
                  },
                ] as const
              ).map((option) => {
                const isSelected = activeSupplierRule.id === option.id;
                const OptionIcon = option.icon;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => handleSelectSupplierRule(option.id)}
                    className={`w-full p-3 rounded-xl border text-left flex items-center justify-between gap-3 cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-[var(--pt-bg,#080B12)] border-[var(--pt-primary,#A020F0)] text-white shadow-[0_0_15px_var(--pt-glow,rgba(160,32,240,0.3))]'
                        : 'bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/5 border-[var(--pt-border,#29243D)] text-zinc-300'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <div
                        className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                          isSelected
                            ? 'bg-[var(--pt-primary,#A020F0)]/20 text-[var(--pt-primary-light,#C084FC)] border border-[var(--pt-primary,#A020F0)]/40'
                            : 'bg-[var(--pt-card,#15182A)] text-zinc-400'
                        }`}
                      >
                        <OptionIcon className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-xs font-bold truncate">{option.name}</div>
                        <div className="text-[10px] text-[var(--pt-text-secondary,#A3A8BD)] truncate mt-0.5">
                          {option.subtitle}
                        </div>
                      </div>
                    </div>
                    {isSelected && (
                      <Check className="w-4 h-4 text-[var(--pt-primary-light,#C084FC)] shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* MANUAL CODE ENTRY MODAL                                      */}
      {/* ============================================================ */}
      {isManualModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150"
          onClick={() => setIsManualModalOpen(false)}
        >
          <div
            className="w-full max-w-sm bg-[var(--pt-card,#15182A)] border border-[var(--pt-border,#29243D)] rounded-2xl shadow-2xl p-5 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Keyboard className="w-5 h-5 text-[var(--pt-primary-light,#C084FC)]" />
                <h3 className="font-bold text-sm">Manual Part / Barcode Entry</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsManualModalOpen(false)}
                className="w-7 h-7 rounded-full bg-[var(--pt-bg-secondary,#101321)] text-zinc-400 hover:text-white flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleManualCodeSubmit} className="space-y-4">
              <div>
                <label className="text-[11px] font-mono uppercase text-[var(--pt-text-secondary,#A3A8BD)] block mb-1.5 font-semibold">
                  Enter Part #, Last 4 Digits or Barcode:
                </label>
                <input
                  type="text"
                  autoFocus
                  value={manualCodeInput}
                  onChange={(e) => setManualCodeInput(e.target.value.toUpperCase())}
                  placeholder="e.g. 2048, BRK, or PART-9002"
                  className="w-full h-11 px-3.5 rounded-xl bg-[var(--pt-bg,#080B12)] border border-[var(--pt-border,#29243D)] focus:border-[var(--pt-primary,#A020F0)] text-white font-mono font-bold text-base outline-none uppercase shadow-inner"
                />

                {manualCandidates.length > 0 && (
                  <div className="mt-2 space-y-1">
                    <span className="text-[10px] font-mono uppercase text-[var(--pt-primary-light,#C084FC)] block font-semibold">
                      {scanScope?.mode === 'group'
                        ? 'Matching parts in group dockets:'
                        : 'Matching parts in docket:'}
                    </span>
                    <div className="max-h-36 overflow-y-auto space-y-1 pr-1 divide-y divide-[var(--pt-border,#29243D)]">
                      {manualCandidates.map((item) => (
                        <button
                          key={`${item.docketNumber}_${item.part.id}`}
                          type="button"
                          onClick={() => handleSelectCandidate(item.part.partNumber)}
                          className="w-full text-left p-2 rounded-lg bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-xs transition-colors flex items-center justify-between gap-2 cursor-pointer"
                        >
                          <div className="min-w-0">
                            <span className="font-mono font-bold text-white block truncate">
                              <HighlightMatch text={item.part.partNumber} query={manualCodeInput} />
                              {scanScope?.mode === 'group' && (
                                <span className="ml-1.5 text-[10px] text-[var(--pt-primary-light,#C084FC)]">
                                  #{item.docketNumber}
                                </span>
                              )}
                            </span>
                            <span className="text-[11px] text-[var(--pt-text-secondary,#A3A8BD)] truncate block">
                              <HighlightMatch text={item.part.description} query={manualCodeInput} />
                            </span>
                          </div>
                          <span className="text-[10px] font-mono text-[var(--pt-primary-light,#C084FC)] shrink-0 font-bold">
                            Select ↵
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setIsManualModalOpen(false)}
                  className="flex-1 h-10 rounded-xl bg-[var(--pt-bg-secondary,#101321)] hover:bg-white/10 border border-[var(--pt-border,#29243D)] text-zinc-300 font-mono font-semibold text-xs cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!manualCodeInput.trim()}
                  className="flex-1 h-10 rounded-xl pt-btn-primary disabled:opacity-40 text-white font-mono font-bold text-xs tracking-wider uppercase cursor-pointer"
                >
                  Process Code
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

