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
} from 'lucide-react';
import {
  Delivery,
  DeliveryPart,
  ScanFeedback,
  PendingQuantityConfirmation,
  SupplierRuleId,
  ScanEvent,
  UnexpectedPart,
  ScanMethod,
} from '../types/delivery';
import {
  confirmScannedPartQuantity,
  parseBarcodeDocketNo,
  getDeliverySupplierRule,
  setDeliverySupplierRule,
  getPreferredSupplierRuleId,
  setPreferredSupplierRuleId,
  SUPPLIER_RULES,
  getStoredSettings,
  updateDelivery,
} from '../utils/storage';
import { isBackendOnline } from '../services/palletTrackApi';

import {
  recognizePalletLabelOffline,
  evaluatePalletLabelMatch,
  prewarmPalletLabelOcrEngine,
  computeVideoFrameSignature,
  computeFrameSignatureDifference,
} from '../utils/palletLabelOcr';
import {
  ScanConfirmationModal,
  ActiveScanData,
  ConfirmedScanPayload,
} from './ScanConfirmationModal';
import { DuplicateScanModal, DuplicateScanModalData } from './DuplicateScanModal';
import { detectDuplicateScan } from '../utils/duplicateDetection';
import { playAudio, triggerHaptic, speakAlert } from '../utils/audioFeedback';
import { filterPartsSmart, HighlightMatch } from '../utils/partSearch';

export type ScanInputSource = 'camera_barcode_qr' | 'external_hid' | 'photo_snap' | 'manual';

const SELECTED_CAMERA_STORAGE_KEY = 'pallettick_selected_camera_id_v2';

type DiagnosticCategory = 'camera' | 'barcode_qr' | 'ocr' | 'external_hid' | 'error';

interface ScannerViewProps {
  delivery: Delivery | null;
  onUpdateDelivery: (updated: Delivery) => void;
  onOpenTestSheet?: () => void;
  onOpenNewDelivery?: () => void;
  externalPendingQuantity?: PendingQuantityConfirmation | null;
  onClearExternalPendingQuantity?: () => void;
  onScanConfirmationChange?: (isOpen: boolean) => void;
  onClose?: () => void;
}

export const ScannerView: React.FC<ScannerViewProps> = ({
  delivery,
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
    width: number;
    height: number;
    frameRate?: number;
    focusMode?: string;
    supportedFocusModes?: string[];
    deviceLabel?: string;
    decodeMethod?: string;
    avgDecodeTimeMs?: number;
    lastDecodeTimeMs?: number;
    attemptsBeforeLastSuccess?: number;
    currentAttemptCount?: number;
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

  // Notify parent container so global menu bars are hidden while confirming a scan or viewing duplicate warning
  useEffect(() => {
    onScanConfirmationChange?.(activeScanConfirmation !== null || activeDuplicateWarning !== null);
    return () => {
      onScanConfirmationChange?.(false);
    };
  }, [activeScanConfirmation, activeDuplicateWarning, onScanConfirmationChange]);

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

  // App Settings (sound, vibration, speech)
  const [appSettings] = useState(() => getStoredSettings());

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

  // Atomic processing lock against rapid consecutive events
  const isProcessingScanRef = useRef<boolean>(false);

  const isManualModalOpenRef = useRef<boolean>(false);
  isManualModalOpenRef.current = isManualModalOpen;

  const deliveryRef = useRef(delivery);
  deliveryRef.current = delivery;

  const onUpdateDeliveryRef = useRef(onUpdateDelivery);
  onUpdateDeliveryRef.current = onUpdateDelivery;

  const appendDiagnosticLog = useCallback(
    (category: DiagnosticCategory, message: string) => {
      const prefix = `[PalletTick ${category.toUpperCase()}]`;
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
   * Universal device video inputs enumeration
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
      const videoInputs = allDevices.filter((d) => d.kind === 'videoinput');
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
   * Apply hardware camera capabilities (continuous autofocus, zoom, torch, exposure)
   * without restarting or disrupting the video stream.
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

        const capabilities: any = track.getCapabilities ? track.getCapabilities() : {};
        const supportedFocusModes: string[] = Array.isArray(capabilities.focusMode)
          ? capabilities.focusMode
          : [];

        // 1. Check Torch capability
        if (capabilities.torch && isMountedRef.current) {
          setHasTorch(true);
        } else if (isMountedRef.current) {
          setHasTorch(false);
        }

        // 2. Check Hardware Zoom capability
        if (capabilities.zoom && typeof capabilities.zoom === 'object') {
          const minZ = capabilities.zoom.min || 1;
          const maxZ = capabilities.zoom.max || 4;
          if (isMountedRef.current) {
            setSupportsHardwareZoom(true);
            setMinHardwareZoom(minZ);
            setMaxHardwareZoom(Math.min(maxZ, 6));
          }
        } else if (isMountedRef.current) {
          setSupportsHardwareZoom(false);
        }

        // 3. Apply continuous autofocus where supported (or best available focus fallback)
        let appliedContinuousFocus = false;
        if (supportedFocusModes.includes('continuous') || supportedFocusModes.length === 0) {
          try {
            await track.applyConstraints({
              advanced: [{ focusMode: 'continuous' } as any],
            });
            appliedContinuousFocus = true;
          } catch {
            try {
              await track.applyConstraints({ focusMode: 'continuous' } as any);
              appliedContinuousFocus = true;
            } catch {}
          }
        }

        // Fallback if continuous autofocus is not supported by the camera driver
        if (!appliedContinuousFocus && supportedFocusModes.length > 0) {
          const fallbackMode = supportedFocusModes.includes('single-shot')
            ? 'single-shot'
            : supportedFocusModes.includes('auto')
            ? 'auto'
            : null;
          if (fallbackMode) {
            await track
              .applyConstraints({
                advanced: [{ focusMode: fallbackMode } as any],
              })
              .catch(() => {});

            // Gently trigger single-shot refocus periodically without resetting the stream
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
              currentTrack
                .applyConstraints({
                  advanced: [{ focusMode: fallbackMode } as any],
                })
                .catch(() => {});
            }, 2200);
          }
        }

        // 4. Apply continuous exposure & white balance if supported
        if (
          Array.isArray(capabilities.exposureMode) &&
          capabilities.exposureMode.includes('continuous')
        ) {
          await track
            .applyConstraints({
              advanced: [{ exposureMode: 'continuous' } as any],
            })
            .catch(() => {});
        }
        if (
          Array.isArray(capabilities.whiteBalanceMode) &&
          capabilities.whiteBalanceMode.includes('continuous')
        ) {
          await track
            .applyConstraints({
              advanced: [{ whiteBalanceMode: 'continuous' } as any],
            })
            .catch(() => {});
        }
        if (capabilities.zoom && targetZoom > 1) {
          const minZ = capabilities.zoom.min || 1;
          const maxZ = capabilities.zoom.max || 4;
          const clampedZ = Math.max(minZ, Math.min(maxZ, targetZoom));
          await track
            .applyConstraints({
              advanced: [{ zoom: clampedZ } as any],
            })
            .catch(() => {});
        }

        // 5. Inspect updated settings after applying constraints
        const updatedSettings: any = track.getSettings ? track.getSettings() : {};
        const container = document.getElementById('camera-scanner-view');
        const video = container?.querySelector('video') as HTMLVideoElement | null;
        const actualW = updatedSettings.width || video?.videoWidth || 0;
        const actualH = updatedSettings.height || video?.videoHeight || 0;
        const fps = updatedSettings.frameRate ? Math.round(updatedSettings.frameRate) : undefined;
        const activeFocusMode =
          updatedSettings.focusMode ||
          (appliedContinuousFocus && supportedFocusModes.includes('continuous')
            ? 'continuous'
            : supportedFocusModes.length > 0
            ? supportedFocusModes[0]
            : 'auto (driver managed)');

        if (isMountedRef.current) {
          const diagPayload = {
            width: actualW,
            height: actualH,
            frameRate: fps,
            focusMode: activeFocusMode,
            supportedFocusModes:
              supportedFocusModes.length > 0 ? supportedFocusModes : ['driver-default'],
            deviceLabel: track.label || 'Rear Camera',
            decodeMethod: activeDecodeMethodRef.current,
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
            attemptsBeforeLastSuccess: attemptsBeforeLastSuccessRef.current,
            currentAttemptCount: decodeAttemptCountRef.current,
          };
          setActualCameraInfo(diagPayload);
          if (typeof window !== 'undefined') {
            (window as any).__PALLETTRACK_SCANNER_DIAGNOSTICS__ = diagPayload;
          }
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
   * Tap to focus on camera preview
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
      } catch {}
    },
    [getActiveVideoTrack]
  );

  /**
   * CENTRAL SCAN EVENT HANDLER
   * When ANY barcode, QR code, or OCR label is detected:
   * 1. Pauses/locks camera scanning.
   * 2. Evaluates against delivery parts.
   * 3. Opens the dedicated ScanConfirmationModal.
   */
  const handleScannedCode = useCallback(
    (
      codeText: string,
      inputSource: ScanInputSource = 'camera_barcode_qr',
      detectedFormat?: string
    ) => {
      // Block scanning if confirmation modal or duplicate warning is already open, or scan is being processed
      if (
        activeScanConfirmationRef.current !== null ||
        activeDuplicateWarningRef.current !== null ||
        isProcessingScanRef.current
      ) {
        return;
      }

      // When in OCR label scan mode, do NOT automatically scan QR codes
      const isOcrMode = activeSupplierRuleRef.current?.id === 'ocr_label';
      if (isOcrMode && inputSource === 'camera_barcode_qr') {
        const fmt = (detectedFormat || '').toUpperCase();
        if (
          fmt === 'QR_CODE' ||
          fmt === 'QRCODE' ||
          fmt.includes('QR')
        ) {
          return;
        }

        const trimmed = codeText.trim();
        // Guard against QR payloads (URL, mailto, complex json/multiline data)
        if (
          trimmed.startsWith('http://') ||
          trimmed.startsWith('https://') ||
          trimmed.startsWith('mailto:') ||
          trimmed.startsWith('tel:')
        ) {
          return;
        }
      }

      const currentDelivery = deliveryRef.current;
      if (!currentDelivery) return;

      // Requirement 5: Online-only receiving
      // Prevent scans from being recorded when disconnected from central database
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

      // Debounce identical scans within 1.2 seconds
      if (cleaned === lastScannedCodeRef.current && now - lastScannedTimeRef.current < 1200) {
        return;
      }

      // STRICT DUPLICATE SCAN PREVENTION:
      // When a QR code or barcode is scanned, immediately check whether that exact part
      // has already been successfully scanned in the current delivery.
      // Must happen before adding the part or quantity to the scanned parts list.
      const duplicateCheck = detectDuplicateScan(currentDelivery, cleaned);
      if (duplicateCheck.isDuplicate) {
        lastScannedCodeRef.current = cleaned;
        lastScannedTimeRef.current = now;

        triggerDuplicateWarning({
          partNumber: duplicateCheck.partNumber,
          description: duplicateCheck.description,
          code: cleaned,
          itemNumber: duplicateCheck.itemNumber,
          palletNumber: duplicateCheck.palletNumber,
          scannedAt: duplicateCheck.scannedAt,
          receivedQuantity: duplicateCheck.receivedQuantity,
        });
        return;
      }

      lastScannedCodeRef.current = cleaned;
      lastScannedTimeRef.current = now;

      appendDiagnosticLog(
        inputSource === 'external_hid' ? 'external_hid' : 'barcode_qr',
        `Scanned code "${cleaned}" via ${inputSource}`
      );

      // Evaluate match against delivery parts
      const parsedBarcode = parseBarcodeDocketNo(cleaned);
      const cleanNorm = cleaned.toUpperCase().replace(/\s*-\s*/g, '-');

      let matched: DeliveryPart | null = null;

      // 1. Exact partNumber match
      matched = currentDelivery.parts.find(
        (p) => p.partNumber.trim().toUpperCase().replace(/\s*-\s*/g, '-') === cleanNorm
      ) || null;

      // 2. Barcode item number or numeric line match
      if (!matched && parsedBarcode.hasDashFormat && parsedBarcode.numericNo !== null) {
        matched = currentDelivery.parts.find((p) => {
          const rawItm = (p.itemNumber || '').trim().replace(/^ITM-0*/i, '');
          return (
            rawItm === String(parsedBarcode.numericNo) ||
            p.docketLineIndex === parsedBarcode.numericNo
          );
        }) || null;
      }

      if (!matched) {
        matched = currentDelivery.parts.find((p) => {
          const rawItm = (p.itemNumber || '').trim().toUpperCase();
          return rawItm && (rawItm === cleanNorm || rawItm.replace(/^ITM-0*/, '') === cleanNorm);
        }) || null;
      }

      // Determine scan method
      let method: 'barcode' | 'qr_code' | 'ocr_label' | 'external_hid' | 'manual' = 'barcode';
      if (inputSource === 'external_hid') {
        method = 'external_hid';
      } else if (inputSource === 'manual') {
        method = 'manual';
      } else if (cleaned.length > 25 || cleaned.includes('\n') || cleaned.includes('{')) {
        method = 'qr_code';
      }

      const detectedPartNo = matched ? matched.partNumber : cleaned;
      const detectedDesc = matched ? matched.description : '';
      const detectedQty = matched ? Math.max(1, matched.quantity ?? 1) : 1;

      // Play detection chime & feedback
      playAudio.success(appSettings.soundEnabled);
      triggerHaptic('success', appSettings.vibrationEnabled);

      // Open dedicated Scan Confirmation Screen!
      const newScanData: ActiveScanData = {
        scanMethod: method,
        rawCode: cleaned,
        detectedPartNumber: detectedPartNo,
        detectedDescription: detectedDesc,
        detectedQuantity: detectedQty,
        matchedPart: matched,
        docketNumber: currentDelivery.docketNumber,
        customerOrSupplier: currentDelivery.supplier || '',
        isUnlisted: !matched,
      };

      activeScanConfirmationRef.current = newScanData;
      setActiveScanConfirmation(newScanData);
    },
    [appendDiagnosticLog, appSettings, triggerDuplicateWarning]
  );

  /**
   * Handle SAVE & SCAN NEXT action from confirmation modal
   */
  const handleSaveAndScanNext = useCallback(
    (payload: ConfirmedScanPayload) => {
      const currentDelivery = deliveryRef.current;
      if (!currentDelivery) return;

      if (!isBackendOnline()) {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('parttrack_connection_required'));
        }
        return;
      }

      const now = new Date().toISOString();

      let updatedDelivery: Delivery;

      const scanMethodToCodeType: ScanMethod =
        payload.scanMethod === 'qr_code'
          ? 'qr'
          : payload.scanMethod === 'ocr_label'
          ? 'ocr_label'
          : payload.scanMethod === 'manual'
          ? 'manual'
          : 'barcode';

      if (payload.matchedPart) {
        // Save matched part verification using existing logic
        const res = confirmScannedPartQuantity(
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
          payload.quantity
        );
        updatedDelivery = res.updatedDelivery;
      } else {
        // Save unlisted part into unexpectedParts and scanHistory
        const unexpectedItem: UnexpectedPart = {
          id: `unexp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          code: payload.rawCode || payload.partNumber,
          codeType: scanMethodToCodeType,
          scannedAt: now,
          notes: payload.description
            ? `${payload.partNumber} (${payload.description}) - Qty ${payload.quantity}`
            : `Qty ${payload.quantity}`,
        };

        const scanEvent: ScanEvent = {
          id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: now,
          code: payload.rawCode || payload.partNumber,
          codeType: scanMethodToCodeType,
          status: 'unexpected_warning',
          partNumber: payload.partNumber,
          requiredQuantity: 0,
          receivedQuantity: payload.quantity,
          addedQuantity: payload.quantity,
          message: `Recorded unexpected item ${payload.partNumber} — Qty ${payload.quantity}`,
        };

        updatedDelivery = {
          ...currentDelivery,
          unexpectedParts: [unexpectedItem, ...currentDelivery.unexpectedParts],
          scanHistory: [scanEvent, ...currentDelivery.scanHistory].slice(0, 300),
          updatedAt: now,
        };
        updateDelivery(updatedDelivery);
      }

      onUpdateDeliveryRef.current(updatedDelivery);

      // Audio & visual feedback
      playAudio.success(appSettings.soundEnabled);
      triggerHaptic('success', appSettings.vibrationEnabled);
      triggerVisualFlash('green');

      // Brief toast notification on camera
      setScanFeedback({
        type: 'success',
        code: payload.rawCode,
        message: `✓ Saved: ${payload.partNumber} (Qty ${payload.quantity})`,
        timestamp: Date.now(),
      });
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = setTimeout(() => {
        setScanFeedback(null);
      }, 3500);

      // Debounce same code for 1.5 seconds so camera doesn't re-trigger immediately
      lastScannedCodeRef.current = payload.rawCode;
      lastScannedTimeRef.current = Date.now();

      // Return immediately to live camera scanner!
      activeScanConfirmationRef.current = null;
      setActiveScanConfirmation(null);
    },
    [appSettings, triggerVisualFlash]
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

      if (recognized) {
        attemptsBeforeLastSuccessRef.current = decodeAttemptCountRef.current;
        decodeAttemptCountRef.current = 0;
      }

      // Throttle React state updates for non-recognition frames to every 6 attempts
      if (recognized || decodeAttemptCountRef.current % 6 === 0) {
        setActualCameraInfo((prev) => {
          const next = {
            width: prev?.width || 0,
            height: prev?.height || 0,
            frameRate: prev?.frameRate,
            focusMode: prev?.focusMode || 'continuous',
            supportedFocusModes: prev?.supportedFocusModes || ['continuous'],
            deviceLabel: prev?.deviceLabel || 'Rear Camera',
            decodeMethod: methodLabel,
            avgDecodeTimeMs: avgMs,
            lastDecodeTimeMs: roundedMs,
            attemptsBeforeLastSuccess: attemptsBeforeLastSuccessRef.current,
            currentAttemptCount: decodeAttemptCountRef.current,
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
   * - In GCI mode ('gci'): isolates strictly to ['qr_code'] at 45ms intervals with single-flight lock,
   *   and suspends Html5Qrcode's redundant ZXing canvas loop so only one decoder processes each frame.
   * - In Laser Central mode ('laser_central'): scans 1D barcodes + QR codes with single-flight lock.
   * - In OCR Label mode ('ocr_label'): scans 1D barcodes only (ignores QR codes).
   */
  const startNativeBarcodeLoop = useCallback(() => {
    if (nativeDetectorIntervalRef.current) {
      clearInterval(nativeDetectorIntervalRef.current);
      nativeDetectorIntervalRef.current = null;
    }
    isNativeDetectingRef.current = false;
    decodeAttemptCountRef.current = 0;

    const currentRuleId = activeSupplierRuleRef.current?.id || 'laser_central';

    if (
      typeof window === 'undefined' ||
      !('BarcodeDetector' in window) ||
      typeof (window as any).BarcodeDetector !== 'function'
    ) {
      // Native BarcodeDetector unavailable: ensure Html5Qrcode ZXing fallback is active
      const fallbackLabel =
        currentRuleId === 'gci'
          ? 'ZXing Fallback (GCI QR Mode)'
          : 'ZXing Fallback (Html5Qrcode)';
      activeDecodeMethodRef.current = fallbackLabel;
      if (scannerRef.current) {
        (scannerRef.current as any).shouldScan = true;
      }
      setActualCameraInfo((prev) =>
        prev ? { ...prev, decodeMethod: fallbackLabel } : prev
      );
      return;
    }

    try {
      const formats =
        currentRuleId === 'gci'
          ? ['qr_code']
          : currentRuleId === 'ocr_label'
          ? [
              'code_128',
              'code_39',
              'ean_13',
              'ean_8',
              'data_matrix',
              'itf',
              'upc_a',
              'upc_e',
              'codabar',
            ]
          : [
              'qr_code',
              'code_128',
              'code_39',
              'ean_13',
              'ean_8',
              'data_matrix',
              'itf',
              'upc_a',
              'upc_e',
              'codabar',
            ];

      const detector = new (window as any).BarcodeDetector({ formats });
      const methodLabel =
        currentRuleId === 'gci'
          ? 'Native BarcodeDetector (QR Fast-Path)'
          : currentRuleId === 'ocr_label'
          ? 'Native BarcodeDetector (1D + Live OCR)'
          : 'Native BarcodeDetector (1D + QR)';
      activeDecodeMethodRef.current = methodLabel;

      // Prevent Html5Qrcode's internal ZXing canvas decoder from running in parallel on the same frame
      if (scannerRef.current) {
        (scannerRef.current as any).shouldScan = false;
        if ((scannerRef.current as any).foreverScanTimeout) {
          clearTimeout((scannerRef.current as any).foreverScanTimeout);
        }
      }

      setActualCameraInfo((prev) =>
        prev ? { ...prev, decodeMethod: methodLabel } : prev
      );

      // Fast 45ms cadence for GCI QR codes (~22fps), 80ms for multi-format 1D+QR
      const intervalMs = currentRuleId === 'gci' ? 45 : 80;

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
            const first = barcodes[0];
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
      // Fallback to Html5Qrcode ZXing decoder if BarcodeDetector constructor fails
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

      try {
        const result = await recognizePalletLabelOffline(
          video,
          deliveryRef.current?.parts || [],
          { x: 0.05, y: 0.16, width: 0.9, height: 0.68 }
        );

        if (
          !isMountedRef.current ||
          activeScanConfirmationRef.current !== null ||
          activeDuplicateWarningRef.current !== null
        ) {
          return;
        }

        if (result.partNumber) {
          // STRICT DUPLICATE SCAN PREVENTION CHECK
          const duplicateCheck = detectDuplicateScan(
            deliveryRef.current,
            result.partNumber,
            result.partNumber
          );
          if (duplicateCheck.isDuplicate) {
            triggerDuplicateWarning({
              partNumber: duplicateCheck.partNumber,
              description: duplicateCheck.description,
              code: result.partNumber,
              itemNumber: duplicateCheck.itemNumber,
              palletNumber: duplicateCheck.palletNumber,
              scannedAt: duplicateCheck.scannedAt,
              receivedQuantity: duplicateCheck.receivedQuantity,
            });
            return;
          }

          const evalResult = evaluatePalletLabelMatch(
            result.partNumber,
            result.quantity,
            deliveryRef.current?.parts || [],
            result.ocrConfidence
          );

          if (
            evalResult.matchedPart ||
            (result.ocrConfidence === 'high' && result.quantity !== null && result.quantity > 0)
          ) {
            playAudio.success(appSettings.soundEnabled);
            triggerHaptic('success', appSettings.vibrationEnabled);

            const newScanData: ActiveScanData = {
              scanMethod: 'ocr_label',
              rawCode: result.partNumber,
              detectedPartNumber: result.partNumber,
              detectedDescription:
                result.description || evalResult.matchedPart?.description || '',
              detectedQuantity:
                result.quantity || (evalResult.matchedPart?.quantity ?? 1),
              matchedPart: evalResult.matchedPart,
              docketNumber: deliveryRef.current?.docketNumber || '',
              customerOrSupplier: deliveryRef.current?.supplier || '',
              rawOcrText: result.rawOcrText,
              isUnlisted: !evalResult.matchedPart,
              unconfidentFields: result.quantity === null ? ['quantity'] : undefined,
            };

            activeScanConfirmationRef.current = newScanData;
            setActiveScanConfirmation(newScanData);
          }
        }
      } catch (err: any) {
        appendDiagnosticLog('error', `Live OCR note: ${err?.message || String(err)}`);
      } finally {
        isLiveOcrBusyRef.current = false;
      }
    }, 1800);
  }, [appendDiagnosticLog, appSettings, isProcessingOcrLabel, triggerDuplicateWarning]);

  // Reconfigure active decoder loops in-place when switching between GCI, Laser Central, and OCR Label modes
  const reconfigureActiveMode = useCallback(() => {
    configureTrackFocusAndCapabilities(zoomLevelRef.current);
    startNativeBarcodeLoop();
    startLiveOcrDetectionLoop();
  }, [configureTrackFocusAndCapabilities, startLiveOcrDetectionLoop, startNativeBarcodeLoop]);
  reconfigureActiveModeRef.current = reconfigureActiveMode;

  /**
   * Initializes the continuous video camera scanner
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

        // 2. Discover available devices & prioritize rear/environment cameras when no explicit camera is saved
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
        if (devices.length > 0) {
          // Sort rear/back/environment cameras ahead of front cameras
          const sortedDevices = [...devices].sort((a, b) => {
            const aBack = /back|rear|environment|0/i.test(a.label) ? 0 : 1;
            const bBack = /back|rear|environment|0/i.test(b.label) ? 0 : 1;
            return aBack - bBack;
          });
          sortedDevices.forEach((d) => {
            if (!orderedCameraIds.includes(d.id)) {
              orderedCameraIds.push(d.id);
            }
          });
        }

        const currentRuleId = activeSupplierRuleRef.current?.id || 'laser_central';
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

        // Prefer environment-facing camera with 1280x720 HD resolution & continuous autofocus first when no specific camera ID was forced
        if (!requestedId) {
          try {
            await scanner.start(
              { facingMode: 'environment' },
              {
                ...baseScanConfig,
                videoConstraints: {
                  facingMode: { ideal: 'environment' },
                  width: { ideal: 1280 },
                  height: { ideal: 720 },
                  frameRate: { ideal: 30 },
                  advanced: [{ focusMode: 'continuous' } as any],
                } as any,
              },
              onZxingSuccess,
              onZxingFrameAttempt
            );
            started = true;
          } catch {
            // Fall through to deviceId loop or standard facingMode: 'environment'
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
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    frameRate: { ideal: 30 },
                    advanced: [{ focusMode: 'continuous' } as any],
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
        startNativeBarcodeLoop();
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
   * Manual Snapshot / Shutter capture for instant OCR & Barcode processing
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
    setOcrLabelStatusMessage('Reading label text & barcodes...');
    triggerVisualFlash('green');

    try {
      // 1. First run high-speed OCR on video frame
      const ocrResult = await recognizePalletLabelOffline(
        video,
        deliveryRef.current?.parts || [],
        { x: 0.05, y: 0.15, width: 0.9, height: 0.7 }
      );

      const evalMatch = evaluatePalletLabelMatch(
        ocrResult.partNumber || '',
        ocrResult.quantity,
        deliveryRef.current?.parts || [],
        ocrResult.ocrConfidence
      );

      if (ocrResult.partNumber) {
        // STRICT DUPLICATE SCAN PREVENTION CHECK
        const duplicateCheck = detectDuplicateScan(
          deliveryRef.current,
          ocrResult.partNumber,
          ocrResult.partNumber
        );
        if (duplicateCheck.isDuplicate) {
          triggerDuplicateWarning({
            partNumber: duplicateCheck.partNumber,
            description: duplicateCheck.description,
            code: ocrResult.partNumber,
            itemNumber: duplicateCheck.itemNumber,
            palletNumber: duplicateCheck.palletNumber,
            scannedAt: duplicateCheck.scannedAt,
            receivedQuantity: duplicateCheck.receivedQuantity,
          });
          return;
        }

        playAudio.success(appSettings.soundEnabled);
        triggerHaptic('success', appSettings.vibrationEnabled);

        const newScanData: ActiveScanData = {
          scanMethod: 'ocr_label',
          rawCode: ocrResult.partNumber,
          detectedPartNumber: ocrResult.partNumber,
          detectedDescription:
            ocrResult.description || evalMatch.matchedPart?.description || '',
          detectedQuantity: ocrResult.quantity || (evalMatch.matchedPart?.quantity ?? 1),
          matchedPart: evalMatch.matchedPart,
          docketNumber: deliveryRef.current?.docketNumber || '',
          customerOrSupplier: deliveryRef.current?.supplier || '',
          rawOcrText: ocrResult.rawOcrText,
          isUnlisted: !evalMatch.matchedPart,
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
   * Smart search candidate suggestions for manual code entry (e.g. typing last 4 digits)
   */
  const manualCandidates = useMemo(() => {
    const q = manualCodeInput.trim();
    if (!q || !delivery?.parts) return [];
    return filterPartsSmart(delivery.parts, q, {
      docketNumber: delivery.docketNumber,
      supplier: delivery.supplier,
    }).slice(0, 5);
  }, [delivery, manualCodeInput]);

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
   * Handle photo upload from gallery or file picker
   */
  const handleFilePicked = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    setIsProcessingOcrLabel(true);
    setOcrLabelStatusMessage('Processing image...');

    try {
      // Run OCR on picked file
      const ocrResult = await recognizePalletLabelOffline(
        file,
        deliveryRef.current?.parts || [],
        { x: 0, y: 0, width: 1, height: 1 }
      );

      const evalMatch = evaluatePalletLabelMatch(
        ocrResult.partNumber || '',
        ocrResult.quantity,
        deliveryRef.current?.parts || [],
        ocrResult.ocrConfidence
      );

      const partNo = ocrResult.partNumber || file.name.replace(/\.[^.]+$/, '');

      // STRICT DUPLICATE SCAN PREVENTION CHECK
      const duplicateCheck = detectDuplicateScan(deliveryRef.current, partNo, partNo);
      if (duplicateCheck.isDuplicate) {
        triggerDuplicateWarning({
          partNumber: duplicateCheck.partNumber,
          description: duplicateCheck.description,
          code: partNo,
          itemNumber: duplicateCheck.itemNumber,
          palletNumber: duplicateCheck.palletNumber,
          scannedAt: duplicateCheck.scannedAt,
          receivedQuantity: duplicateCheck.receivedQuantity,
        });
        return;
      }

      const newScanData: ActiveScanData = {
        scanMethod: 'ocr_label',
        rawCode: partNo,
        detectedPartNumber: partNo,
        detectedDescription:
          ocrResult.description || evalMatch.matchedPart?.description || '',
        detectedQuantity: ocrResult.quantity || (evalMatch.matchedPart?.quantity ?? 1),
        matchedPart: evalMatch.matchedPart,
        docketNumber: deliveryRef.current?.docketNumber || '',
        customerOrSupplier: deliveryRef.current?.supplier || '',
        rawOcrText: ocrResult.rawOcrText,
        isUnlisted: !evalMatch.matchedPart,
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
    <div className="fixed inset-x-0 top-11 bottom-12 z-20 bg-[#070A0F] overflow-hidden select-none flex flex-col">
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
      <div className="relative flex-1 w-full h-full bg-black overflow-hidden flex items-center justify-center">
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
              style={{ left: focusRingPos.x - 24, top: focusRingPos.y - 24 }}
              className="pointer-events-none absolute z-30 w-12 h-12 rounded-full border-2 border-cyan-400 bg-cyan-400/10 flex items-center justify-center animate-ping"
            >
              <div className="w-2 h-2 rounded-full bg-cyan-400" />
            </div>
          )}

          {/* Full-Frame Visual Recognition Flash */}
          {flashColor && (
            <div
              className={`pointer-events-none absolute inset-0 z-20 border-[6px] transition-all duration-150 ${
                flashColor === 'green'
                  ? 'border-cyan-400 bg-cyan-400/20 shadow-[inset_0_0_80px_rgba(6,182,212,0.4)]'
                  : flashColor === 'orange'
                  ? 'border-amber-400 bg-amber-400/20 shadow-[inset_0_0_80px_rgba(245,158,11,0.4)]'
                  : 'border-red-500 bg-red-500/20 shadow-[inset_0_0_80px_rgba(239,68,68,0.4)]'
              }`}
            />
          )}

          {/* ============================================================ */}
          {/* CENTRAL INDUSTRIAL SCANNING FRAME & LASER ANIMATION          */}
          {/* ============================================================ */}
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center p-4">
            {/* Viewfinder Target Reticle */}
            <div className="relative w-[84%] max-w-[340px] aspect-[4/3] rounded-2xl flex items-center justify-center">
              {/* Electric Blue Corner Guides */}
              <div className="absolute top-0 left-0 w-8 h-8 border-t-3 border-l-3 border-cyan-400 rounded-tl-xl shadow-[0_0_12px_rgba(6,182,212,0.6)]" />
              <div className="absolute top-0 right-0 w-8 h-8 border-t-3 border-r-3 border-cyan-400 rounded-tr-xl shadow-[0_0_12px_rgba(6,182,212,0.6)]" />
              <div className="absolute bottom-0 left-0 w-8 h-8 border-b-3 border-l-3 border-cyan-400 rounded-bl-xl shadow-[0_0_12px_rgba(6,182,212,0.6)]" />
              <div className="absolute bottom-0 right-0 w-8 h-8 border-b-3 border-r-3 border-cyan-400 rounded-br-xl shadow-[0_0_12px_rgba(6,182,212,0.6)]" />

              {/* Subtle Animated Electric-Blue Scanning Laser Beam */}
              {isScanning && !activeScanConfirmation && (
                <div className="absolute inset-x-2 pointer-events-none animate-barcode-scan">
                  <div className="h-[2px] w-full bg-gradient-to-r from-transparent via-cyan-300 to-transparent shadow-[0_0_12px_#00d2ff,0_0_24px_#0088ff]" />
                  <div className="h-5 -mt-2.5 w-full bg-gradient-to-b from-cyan-400/20 to-transparent blur-xs" />
                </div>
              )}

              {/* Central Target Crosshairs */}
              <div className="w-4 h-4 border border-cyan-400/30 rounded-full flex items-center justify-center opacity-60">
                <div className="w-1 h-1 rounded-full bg-cyan-400" />
              </div>
            </div>

            {/* Instruction Tagline below reticle */}
            <div className="mt-4 px-3 py-1 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-center">
              <span className="font-mono text-[10px] font-bold tracking-wider text-cyan-300 uppercase">
                {activeSupplierRule.id === 'ocr_label'
                  ? 'OCR Label Mode · Reading printed label text (QR auto-scan disabled)'
                  : `${activeSupplierRule.name} · Align barcode, QR code or pallet label`}
              </span>
            </div>

            {/* Temporary Toast Feedback Notification */}
            {scanFeedback && (
              <div className="mt-2 px-3 py-1.5 rounded-lg bg-emerald-950/90 border border-emerald-400 text-emerald-200 font-mono text-xs font-bold shadow-xl animate-in zoom-in-95 duration-150">
                {scanFeedback.message}
              </div>
            )}
          </div>

          {/* ============================================================ */}
          {/* CAMERA ERROR OVERLAY & RETRY ACTION                         */}
          {/* ============================================================ */}
          {cameraError && (
            <div className="absolute inset-0 z-40 bg-[#070A0F]/95 flex flex-col items-center justify-center p-6 text-center animate-fade-in">
              <div className="w-14 h-14 rounded-2xl bg-red-950/80 border border-red-500/40 text-red-400 flex items-center justify-center mb-4 shadow-[0_0_30px_rgba(239,68,68,0.3)]">
                <AlertTriangle className="w-7 h-7" />
              </div>
              <h3 className="font-bold text-base text-white mb-2">Camera Feed Restricted</h3>
              <p className="text-xs text-zinc-400 max-w-xs mb-5 leading-relaxed">{cameraError}</p>

              <div className="flex flex-col gap-2 w-full max-w-xs">
                <button
                  type="button"
                  onClick={() => startScanner()}
                  className="w-full h-11 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-bold text-xs tracking-wider uppercase flex items-center justify-center gap-2 cursor-pointer shadow-[0_0_15px_rgba(6,182,212,0.4)]"
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>Retry Camera</span>
                </button>

                <button
                  type="button"
                  onClick={() => setIsManualModalOpen(true)}
                  className="w-full h-10 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white font-semibold text-xs flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Keyboard className="w-4 h-4 text-cyan-400" />
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
          className="absolute top-0 inset-x-0 z-30 px-3 py-2.5 bg-gradient-to-b from-black/90 via-black/60 to-transparent flex items-center justify-between gap-2"
        >
          {/* Left: Back/Close button + PalletTick branding + Docket number */}
          <div className="flex items-center gap-2 min-w-0">
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="w-8 h-8 rounded-full bg-black/60 hover:bg-zinc-800 border border-white/15 text-zinc-300 hover:text-white flex items-center justify-center cursor-pointer transition-colors shrink-0"
                title="Return to Dashboard"
                aria-label="Back to dashboard"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}

            <div className="flex items-center gap-1.5 shrink-0">
              <img
                src="/pallettrack-icon.png"
                alt="PalletTick"
                className="w-5 h-5 rounded-[4px] object-cover shadow-xs"
              />
              <span className="font-bold text-xs text-white tracking-tight hidden sm:inline">
                PalletTick
              </span>
            </div>

            {delivery ? (
              <span className="px-2 py-0.5 rounded-md bg-white/10 border border-white/15 text-zinc-200 font-mono text-[11px] font-semibold truncate max-w-[130px] sm:max-w-[200px]">
                Docket #{delivery.docketNumber}
              </span>
            ) : (
              <span className="text-[11px] text-zinc-400 font-mono">No docket</span>
            )}
          </div>

          {/* Right: Live Scanning Status Indicator + Diagnostics Toggle */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setShowDiagnosticsHud((prev) => !prev)}
              className={`px-2 py-1 rounded-full border font-mono text-[10px] font-bold transition-colors cursor-pointer ${
                showDiagnosticsHud
                  ? 'bg-cyan-500 text-black border-cyan-400'
                  : 'bg-black/60 text-zinc-300 border-white/15 hover:border-cyan-400/50'
              }`}
              title="Toggle Camera & QR Decoder Diagnostics"
            >
              DIAG
            </button>
            <div className="px-2.5 py-1 rounded-full bg-cyan-950/70 border border-cyan-500/40 text-cyan-300 font-mono text-[10px] font-bold flex items-center gap-1.5 shadow-[0_0_10px_rgba(6,182,212,0.25)]">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
              <span>
                {activeSupplierRule.id === 'gci' ? 'GCI QR FAST' : 'LIVE SCAN'}
              </span>
            </div>
          </div>
        </div>

        {/* ============================================================ */}
        {/* LIVE CAMERA & QR DECODER DIAGNOSTICS OVERLAY                 */}
        {/* ============================================================ */}
        {showDiagnosticsHud && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute top-13 right-3 z-30 w-72 p-3 rounded-xl bg-black/90 backdrop-blur-md border border-cyan-500/40 text-[10px] font-mono text-zinc-200 shadow-2xl space-y-1"
          >
            <div className="flex items-center justify-between border-b border-white/10 pb-1 mb-1 text-cyan-400 font-bold uppercase">
              <span>Scanner Diagnostics</span>
              <span>{activeSupplierRule.name}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">Camera:</span>
              <span className="text-white truncate max-w-[160px]">
                {actualCameraInfo?.deviceLabel || 'Environment Rear'}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">Resolution / FPS:</span>
              <span className="text-white">
                {actualCameraInfo?.width || 0}×{actualCameraInfo?.height || 0}
                {actualCameraInfo?.frameRate ? ` @ ${actualCameraInfo.frameRate}fps` : ''}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">Supported Focus:</span>
              <span className="text-white truncate max-w-[160px]">
                {actualCameraInfo?.supportedFocusModes?.join(', ') || 'continuous'}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">Active Focus Mode:</span>
              <span className="text-emerald-400 font-bold">
                {actualCameraInfo?.focusMode || 'continuous'}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">Decode Engine:</span>
              <span className="text-cyan-300 truncate max-w-[165px]">
                {actualCameraInfo?.decodeMethod || activeDecodeMethodRef.current}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">Avg Decode Time:</span>
              <span className="text-white">
                {actualCameraInfo?.avgDecodeTimeMs ?? 0} ms (last:{' '}
                {actualCameraInfo?.lastDecodeTimeMs ?? 0} ms)
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-400">Attempts to Match:</span>
              <span className="text-amber-300 font-bold">
                {actualCameraInfo?.attemptsBeforeLastSuccess || 0} (live:{' '}
                {actualCameraInfo?.currentAttemptCount || 0})
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
          <div className="w-full max-w-md px-2.5 py-2 rounded-2xl bg-black/85 backdrop-blur-xl border border-white/15 shadow-[0_10px_35px_rgba(0,0,0,0.8)] flex items-center justify-between gap-1">
            {/* 1. Flashlight Toggle */}
            <button
              type="button"
              onClick={toggleTorch}
              disabled={!hasTorch}
              className={`w-11 h-11 rounded-xl flex flex-col items-center justify-center transition-all cursor-pointer shrink-0 ${
                torchOn
                  ? 'bg-amber-400 text-black shadow-[0_0_15px_rgba(251,191,36,0.6)]'
                  : hasTorch
                  ? 'bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300'
                  : 'bg-zinc-900/40 text-zinc-600 opacity-40 cursor-not-allowed'
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
              className="w-11 h-11 rounded-xl bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-white flex flex-col items-center justify-center transition-colors cursor-pointer shrink-0"
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
              className="w-14 h-14 -my-2 rounded-full bg-gradient-to-b from-cyan-400 to-blue-600 hover:from-cyan-300 hover:to-blue-500 text-black flex items-center justify-center shadow-[0_0_25px_rgba(6,182,212,0.6)] active:scale-95 transition-all cursor-pointer border-2 border-white/40 shrink-0"
              title="Capture label or barcode snapshot"
              aria-label="Capture snapshot"
            >
              {isProcessingOcrLabel ? (
                <RefreshCw className="w-6 h-6 animate-spin text-black" />
              ) : (
                <Camera className="w-6 h-6 stroke-[2.5]" />
              )}
            </button>

            {/* 4. Manual Code Entry */}
            <button
              type="button"
              onClick={() => setIsManualModalOpen(true)}
              className="w-11 h-11 rounded-xl bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-white flex flex-col items-center justify-center transition-colors cursor-pointer shrink-0"
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
              className="w-11 h-11 rounded-xl bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-white flex flex-col items-center justify-center transition-colors cursor-pointer shrink-0"
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
              className={`w-11 h-11 rounded-xl flex flex-col items-center justify-center transition-colors cursor-pointer shrink-0 ${
                isSupplierModalOpen
                  ? 'bg-cyan-500 text-black shadow-[0_0_15px_rgba(6,182,212,0.5)]'
                  : 'bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-white'
              }`}
              title={`Supplier Format: ${activeSupplierRule.name}`}
              aria-label="Select supplier label format"
            >
              <Tag className="w-4 h-4 stroke-[2.2]" />
              <span className="text-[8px] font-mono mt-0.5 font-bold uppercase">SUPPLIER</span>
            </button>
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/* SCAN CONFIRMATION SCREEN / MODAL                             */}
      {/* ============================================================ */}
      {activeScanConfirmation && delivery && (
        <ScanConfirmationModal
          scan={activeScanConfirmation}
          delivery={delivery}
          onSaveAndScanNext={handleSaveAndScanNext}
          onConfirmAndSave={handleConfirmAndSave}
          onDiscard={handleDiscard}
        />
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
            className="w-full max-w-sm bg-[#0B0F17] border border-cyan-500/40 rounded-2xl shadow-2xl p-5 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Camera className="w-5 h-5 text-cyan-400" />
                <h3 className="font-bold text-sm">Select Camera Device</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsCameraSelectModalOpen(false)}
                className="w-7 h-7 rounded-full bg-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-zinc-400 mb-3">
              Choose from all detected optical sensors and connected USB/Bluetooth cameras:
            </p>

            <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
              {availableCameras.length === 0 ? (
                <div className="p-3 rounded-lg bg-zinc-900/60 text-xs text-zinc-400 text-center">
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
                          ? 'bg-cyan-950/60 border-cyan-400 text-white shadow-[0_0_15px_rgba(6,182,212,0.3)]'
                          : 'bg-zinc-900/60 hover:bg-zinc-800 border-zinc-800 text-zinc-300'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-xs font-bold truncate">
                          {cam.label || `Camera ${idx + 1}`}
                        </div>
                        <div className="text-[10px] text-zinc-500 font-mono truncate">
                          ID: {cam.id ? cam.id.slice(0, 16) + '...' : 'Default'}
                        </div>
                      </div>
                      {isSelected && <Check className="w-4 h-4 text-cyan-400 shrink-0" />}
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
            className="w-full max-w-sm bg-[#0B0F17] border border-cyan-500/40 rounded-2xl shadow-2xl p-5 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Tag className="w-5 h-5 text-cyan-400" />
                <h3 className="font-bold text-sm">Supplier Label Format</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsSupplierModalOpen(false)}
                className="w-7 h-7 rounded-full bg-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center cursor-pointer"
                aria-label="Close supplier format selector"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mb-3 px-3 py-2 rounded-xl bg-zinc-900/80 border border-zinc-800 flex items-center justify-between text-xs">
              <span className="text-zinc-400">Active Format:</span>
              <span className="font-mono font-bold text-cyan-400">{activeSupplierRule.name}</span>
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
                        ? 'bg-cyan-950/60 border-cyan-400 text-white shadow-[0_0_15px_rgba(6,182,212,0.3)]'
                        : 'bg-zinc-900/60 hover:bg-zinc-800 border-zinc-800 text-zinc-300'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <div
                        className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                          isSelected
                            ? 'bg-cyan-400/20 text-cyan-300 border border-cyan-400/40'
                            : 'bg-zinc-800 text-zinc-400'
                        }`}
                      >
                        <OptionIcon className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-xs font-bold truncate">{option.name}</div>
                        <div className="text-[10px] text-zinc-400 truncate mt-0.5">
                          {option.subtitle}
                        </div>
                      </div>
                    </div>
                    {isSelected && <Check className="w-4 h-4 text-cyan-400 shrink-0" />}
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
            className="w-full max-w-sm bg-[#0B0F17] border border-cyan-500/40 rounded-2xl shadow-2xl p-5 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Keyboard className="w-5 h-5 text-cyan-400" />
                <h3 className="font-bold text-sm">Manual Part / Barcode Entry</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsManualModalOpen(false)}
                className="w-7 h-7 rounded-full bg-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleManualCodeSubmit} className="space-y-4">
              <div>
                <label className="text-[11px] font-mono uppercase text-zinc-400 block mb-1.5 font-semibold">
                  Enter Part #, Last 4 Digits or Barcode:
                </label>
                <input
                  type="text"
                  autoFocus
                  value={manualCodeInput}
                  onChange={(e) => setManualCodeInput(e.target.value.toUpperCase())}
                  placeholder="e.g. 2048, BRK, or PART-9002"
                  className="w-full h-11 px-3.5 rounded-xl bg-[#070A0F] border border-zinc-700 focus:border-cyan-400 text-white font-mono font-bold text-base outline-none uppercase shadow-inner"
                />

                {manualCandidates.length > 0 && (
                  <div className="mt-2 space-y-1">
                    <span className="text-[10px] font-mono uppercase text-cyan-400/80 block font-semibold">
                      Matching parts in docket:
                    </span>
                    <div className="max-h-36 overflow-y-auto space-y-1 pr-1 divide-y divide-zinc-800/80">
                      {manualCandidates.map((cand) => (
                        <button
                          key={cand.id}
                          type="button"
                          onClick={() => handleSelectCandidate(cand.partNumber)}
                          className="w-full text-left p-2 rounded-lg bg-zinc-900/90 hover:bg-cyan-950/50 border border-zinc-800 hover:border-cyan-500/50 text-xs transition-colors flex items-center justify-between gap-2 cursor-pointer"
                        >
                          <div className="min-w-0">
                            <span className="font-mono font-bold text-white block truncate">
                              <HighlightMatch text={cand.partNumber} query={manualCodeInput} />
                            </span>
                            <span className="text-[11px] text-zinc-400 truncate block">
                              <HighlightMatch text={cand.description} query={manualCodeInput} />
                            </span>
                          </div>
                          <span className="text-[10px] font-mono text-cyan-400 shrink-0 font-bold">
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
                  className="flex-1 h-10 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-semibold text-xs cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!manualCodeInput.trim()}
                  className="flex-1 h-10 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-black font-bold text-xs tracking-wider uppercase cursor-pointer shadow-[0_0_15px_rgba(6,182,212,0.4)]"
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
