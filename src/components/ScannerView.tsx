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
  Sparkles,
  ExternalLink,
  RefreshCw,
  ZoomIn,
  ZoomOut,
  Plus,
  Minus,
  FileText,
  Usb,
  Activity,
  Image as ImageIcon,
  FolderOpen,
  ArrowLeft,
  Sliders,
  Volume2,
  VolumeX,
  Smartphone,
  Eye,
  AlertTriangle,
  Info,
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
  processScannedCode,
  confirmScannedPartQuantity,
  confirmOcrPalletLabelScan,
  recordUnmatchedOcrPalletLabel,
  parseBarcodeDocketNo,
  getPartVerificationState,
  getDeliverySupplierRule,
  setDeliverySupplierRule,
  getPreferredSupplierRuleId,
  setPreferredSupplierRuleId,
  SUPPLIER_RULES,
  getStoredSettings,
  saveStoredSettings,
  updateDelivery,
} from '../utils/storage';
import {
  recognizePalletLabelOffline,
  generateSamplePalletLabelDataUrl,
  evaluatePalletLabelMatch,
  prewarmPalletLabelOcrEngine,
  computeVideoFrameSignature,
  computeFrameSignatureDifference,
  PalletLabelExtractionResult,
} from '../utils/palletLabelOcr';
import {
  ScanConfirmationModal,
  ActiveScanData,
  ConfirmedScanPayload,
} from './ScanConfirmationModal';
import { exportDeliveryPdf } from '../utils/pdfExport';
import { playAudio, triggerHaptic, speakAlert } from '../utils/audioFeedback';

export type ScanInputSource = 'camera_barcode_qr' | 'external_hid' | 'photo_snap' | 'manual';

const SELECTED_CAMERA_STORAGE_KEY = 'pallettick_selected_camera_id_v2';

interface DiagnosticLogEntry {
  id: string;
  timestamp: string;
  category: 'camera' | 'barcode_qr' | 'ocr' | 'external_hid' | 'error';
  message: string;
}

interface ScannerViewProps {
  delivery: Delivery | null;
  onUpdateDelivery: (updated: Delivery) => void;
  onOpenTestSheet: () => void;
  onOpenNewDelivery?: () => void;
  externalPendingQuantity?: PendingQuantityConfirmation | null;
  onClearExternalPendingQuantity?: () => void;
  onClose?: () => void;
}

export const ScannerView: React.FC<ScannerViewProps> = ({
  delivery,
  onUpdateDelivery,
  onOpenTestSheet,
  onOpenNewDelivery,
  externalPendingQuantity,
  onClearExternalPendingQuantity,
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
    deviceLabel?: string;
  } | null>(null);

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

  // Modals & Drawers
  const [isCameraSelectModalOpen, setIsCameraSelectModalOpen] = useState<boolean>(false);
  const [isPreferencesModalOpen, setIsPreferencesModalOpen] = useState<boolean>(false);
  const [isManualModalOpen, setIsManualModalOpen] = useState<boolean>(false);
  const [manualCodeInput, setManualCodeInput] = useState<string>('');
  const [diagnosticLogs, setDiagnosticLogs] = useState<DiagnosticLogEntry[]>([]);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState<boolean>(false);

  // App Settings (sound, vibration, speech)
  const [appSettings, setAppSettings] = useState(() => getStoredSettings());

  // Supplier Rule State
  const activeSupplierRule = useMemo(() => {
    return delivery ? getDeliverySupplierRule(delivery) : SUPPLIER_RULES.laser_central;
  }, [delivery]);

  // References for continuous camera scanner instance & timers
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const offscreenScannerRef = useRef<Html5Qrcode | null>(null);
  const nativeDetectorIntervalRef = useRef<any>(null);
  const liveOcrIntervalRef = useRef<any>(null);
  const lastOcrFrameSignatureRef = useRef<number[]>([]);
  const isLiveOcrBusyRef = useRef<boolean>(false);

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

  const isManualModalOpenRef = useRef<boolean>(false);
  isManualModalOpenRef.current = isManualModalOpen;

  const deliveryRef = useRef(delivery);
  deliveryRef.current = delivery;

  const onUpdateDeliveryRef = useRef(onUpdateDelivery);
  onUpdateDeliveryRef.current = onUpdateDelivery;

  const appendDiagnosticLog = useCallback(
    (category: DiagnosticLogEntry['category'], message: string) => {
      const timeStr = new Date().toLocaleTimeString();
      const prefix = `[PalletTick ${category.toUpperCase()}]`;
      if (category === 'error') {
        console.warn(prefix, message);
      } else {
        console.info(prefix, message);
      }
      setDiagnosticLogs((prev) => [
        {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: timeStr,
          category,
          message,
        },
        ...prev.slice(0, 59),
      ]);
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
   * Apply hardware camera capabilities (focus, zoom, torch, exposure)
   */
  const configureTrackFocusAndCapabilities = useCallback(
    async (targetZoom: number = 1) => {
      const track = getActiveVideoTrack();
      if (!track) return;

      try {
        const capabilities: any = track.getCapabilities ? track.getCapabilities() : {};
        const settings: any = track.getSettings ? track.getSettings() : {};

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

        // 3. Apply continuous autofocus, exposure, white balance & zoom
        if (
          Array.isArray(capabilities.focusMode) &&
          capabilities.focusMode.includes('continuous')
        ) {
          await track
            .applyConstraints({
              advanced: [{ focusMode: 'continuous' } as any],
            })
            .catch(() => {});
        }
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
        if (capabilities.zoom) {
          const minZ = capabilities.zoom.min || 1;
          const maxZ = capabilities.zoom.max || 4;
          const clampedZ = Math.max(minZ, Math.min(maxZ, targetZoom));
          await track
            .applyConstraints({
              advanced: [{ zoom: clampedZ } as any],
            })
            .catch(() => {});
        }

        // 4. Update actual camera resolution info
        const container = document.getElementById('camera-scanner-view');
        const video = container?.querySelector('video') as HTMLVideoElement | null;
        const actualW = settings.width || video?.videoWidth || 0;
        const actualH = settings.height || video?.videoHeight || 0;
        const fps = settings.frameRate ? Math.round(settings.frameRate) : undefined;
        const focusMode =
          settings.focusMode ||
          (Array.isArray(capabilities.focusMode) ? capabilities.focusMode.join(',') : 'auto');

        if (isMountedRef.current && actualW > 0 && actualH > 0) {
          setActualCameraInfo({
            width: actualW,
            height: actualH,
            frameRate: fps,
            focusMode,
            deviceLabel: track.label || undefined,
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
    (codeText: string, inputSource: ScanInputSource = 'camera_barcode_qr') => {
      // Block scanning if confirmation modal is already open
      if (activeScanConfirmationRef.current !== null) {
        return;
      }

      const currentDelivery = deliveryRef.current;
      if (!currentDelivery) return;

      const cleaned = codeText.trim();
      if (!cleaned) return;

      const now = Date.now();
      // Debounce identical scans within 1.2 seconds
      if (cleaned === lastScannedCodeRef.current && now - lastScannedTimeRef.current < 1200) {
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
    [appendDiagnosticLog, appSettings]
  );

  /**
   * Handle SAVE & SCAN NEXT action from confirmation modal
   */
  const handleSaveAndScanNext = useCallback(
    (payload: ConfirmedScanPayload) => {
      const currentDelivery = deliveryRef.current;
      if (!currentDelivery) return;

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
   * Continuous Barcode & QR scanning loop on video frames
   */
  const startNativeBarcodeLoop = useCallback(() => {
    if (nativeDetectorIntervalRef.current) {
      clearInterval(nativeDetectorIntervalRef.current);
      nativeDetectorIntervalRef.current = null;
    }

    if (
      typeof window === 'undefined' ||
      !('BarcodeDetector' in window) ||
      typeof (window as any).BarcodeDetector !== 'function'
    ) {
      return;
    }

    try {
      const detector = new (window as any).BarcodeDetector({
        formats: [
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
        ],
      });

      nativeDetectorIntervalRef.current = setInterval(async () => {
        if (
          !isMountedRef.current ||
          activeScanConfirmationRef.current !== null ||
          isManualModalOpenRef.current
        ) {
          return;
        }

        const container = document.getElementById('camera-scanner-view');
        const video = container?.querySelector('video') as HTMLVideoElement | null;
        if (!video || video.readyState < 2 || video.videoWidth === 0) return;

        try {
          const barcodes = await detector.detect(video);
          if (
            barcodes &&
            barcodes.length > 0 &&
            isMountedRef.current &&
            activeScanConfirmationRef.current === null
          ) {
            const rawVal = barcodes[0].rawValue || barcodes[0].raw_value || '';
            if (rawVal) {
              handleScannedCode(rawVal, 'camera_barcode_qr');
            }
          }
        } catch {}
      }, 140);
    } catch {}
  }, [handleScannedCode]);

  /**
   * Background Live Pallet Label OCR loop
   */
  const startLiveOcrDetectionLoop = useCallback(() => {
    if (liveOcrIntervalRef.current) {
      clearInterval(liveOcrIntervalRef.current);
      liveOcrIntervalRef.current = null;
    }

    liveOcrIntervalRef.current = setInterval(async () => {
      if (
        !isMountedRef.current ||
        isLiveOcrBusyRef.current ||
        isProcessingOcrLabel ||
        activeScanConfirmationRef.current !== null ||
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

        if (!isMountedRef.current || activeScanConfirmationRef.current !== null) {
          return;
        }

        if (result.partNumber) {
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
  }, [appendDiagnosticLog, appSettings, isProcessingOcrLabel]);

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

        // 2. Discover available devices
        let devices = await enumerateAllVideoInputs();
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
          devices.forEach((d) => {
            if (!orderedCameraIds.includes(d.id)) {
              orderedCameraIds.push(d.id);
            }
          });
        }

        const scanner = new Html5Qrcode('camera-scanner-view', {
          formatsToSupport: [
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
          ],
          verbose: false,
        });
        scannerRef.current = scanner;

        const scanConfig: any = {
          fps: 15,
          disableFlip: false,
          qrbox: (w: number, h: number) => ({
            width: Math.max(160, Math.floor(w * 0.88)),
            height: Math.max(100, Math.floor(h * 0.65)),
          }),
        };

        let started = false;
        let lastErrorMsg = '';

        for (const camId of orderedCameraIds) {
          try {
            await scanner.start(
              { deviceId: { exact: camId } },
              scanConfig,
              (decodedText) => handleScannedCode(decodedText, 'camera_barcode_qr'),
              () => {}
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

        if (!started) {
          try {
            await scanner.start(
              { facingMode: 'environment' },
              scanConfig,
              (decodedText) => handleScannedCode(decodedText, 'camera_barcode_qr'),
              () => {}
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
      selectedCameraId,
      startLiveOcrDetectionLoop,
      startNativeBarcodeLoop,
    ]
  );

  /**
   * Stop scanner safely
   */
  const stopScanner = useCallback(async () => {
    if (nativeDetectorIntervalRef.current) {
      clearInterval(nativeDetectorIntervalRef.current);
      nativeDetectorIntervalRef.current = null;
    }
    if (liveOcrIntervalRef.current) {
      clearInterval(liveOcrIntervalRef.current);
      liveOcrIntervalRef.current = null;
    }
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
    if (isProcessingOcrLabel || isSnappingPhoto || activeScanConfirmation !== null) return;

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

      if (isEditable || activeScanConfirmationRef.current !== null || isManualModalOpenRef.current) {
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
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFilePicked(e.target.files)}
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
                Align barcode, QR code or pallet label
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

          {/* Right: Live Scanning Status Indicator + Preferences + Diagnostics */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Live Auto-Scan Status Pill */}
            <div className="px-2 py-1 rounded-full bg-cyan-950/70 border border-cyan-500/40 text-cyan-300 font-mono text-[10px] font-bold flex items-center gap-1.5 shadow-[0_0_10px_rgba(6,182,212,0.25)]">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
              <span>LIVE SCAN</span>
            </div>

            {/* Test Sheet / Quick Codes */}
            <button
              type="button"
              onClick={onOpenTestSheet}
              className="h-8 px-2 rounded-lg bg-black/60 hover:bg-zinc-800 border border-white/15 text-zinc-300 hover:text-white font-mono text-[11px] flex items-center gap-1 cursor-pointer transition-colors"
              title="Test barcodes & QR codes"
            >
              <QrCode className="w-3.5 h-3.5 text-cyan-400" />
              <span className="hidden md:inline">Test Codes</span>
            </button>

            {/* Settings Menu Button */}
            <button
              type="button"
              onClick={() => setIsPreferencesModalOpen(true)}
              className="w-8 h-8 rounded-lg bg-black/60 hover:bg-zinc-800 border border-white/15 text-zinc-300 hover:text-white flex items-center justify-center cursor-pointer transition-colors"
              title="Scanning preferences"
              aria-label="Scanning preferences"
            >
              <Sliders className="w-4 h-4" />
            </button>

            {/* Diagnostics Drawer Button */}
            <button
              type="button"
              onClick={() => setIsDiagnosticsOpen((prev) => !prev)}
              className={`w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-colors border ${
                isDiagnosticsOpen
                  ? 'bg-cyan-500 text-black border-cyan-400 shadow-[0_0_10px_rgba(6,182,212,0.5)]'
                  : 'bg-black/60 hover:bg-zinc-800 border-white/15 text-zinc-400 hover:text-white'
              }`}
              title="Diagnostics log"
              aria-label="Diagnostics log"
            >
              <Activity className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* ============================================================ */}
        {/* BOTTOM ACCESSIBLE CONTROL BAR (ONE-HANDED MOBILE DOCK)        */}
        {/* ============================================================ */}
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-4 inset-x-3 z-30 flex justify-center pointer-events-auto"
        >
          <div className="w-full max-w-sm px-3 py-2 rounded-2xl bg-black/85 backdrop-blur-xl border border-white/15 shadow-[0_10px_35px_rgba(0,0,0,0.8)] flex items-center justify-between gap-1">
            {/* 1. Flashlight Toggle */}
            <button
              type="button"
              onClick={toggleTorch}
              disabled={!hasTorch}
              className={`w-11 h-11 rounded-xl flex flex-col items-center justify-center transition-all cursor-pointer ${
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
              className="w-11 h-11 rounded-xl bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-white flex flex-col items-center justify-center transition-colors cursor-pointer"
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
              className="w-11 h-11 rounded-xl bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-white flex flex-col items-center justify-center transition-colors cursor-pointer"
              title="Type part number or code manually"
              aria-label="Manual code entry"
            >
              <Keyboard className="w-4 h-4 stroke-[2.2]" />
              <span className="text-[8px] font-mono mt-0.5 font-bold uppercase">TYPE</span>
            </button>

            {/* 5. Gallery / File Upload */}
            <button
              type="button"
              onClick={() => galleryFileInputRef.current?.click()}
              className="w-11 h-11 rounded-xl bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-white flex flex-col items-center justify-center transition-colors cursor-pointer"
              title="Upload photo from gallery or files"
              aria-label="Upload photo"
            >
              <FolderOpen className="w-4 h-4 stroke-[2.2]" />
              <span className="text-[8px] font-mono mt-0.5 font-bold uppercase">PHOTO</span>
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
      {/* SCANNING PREFERENCES / SETTINGS MODAL                        */}
      {/* ============================================================ */}
      {isPreferencesModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150"
          onClick={() => setIsPreferencesModalOpen(false)}
        >
          <div
            className="w-full max-w-sm bg-[#0B0F17] border border-zinc-800 rounded-2xl shadow-2xl p-5 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Sliders className="w-5 h-5 text-cyan-400" />
                <h3 className="font-bold text-sm">Scanning Preferences</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsPreferencesModalOpen(false)}
                className="w-7 h-7 rounded-full bg-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              {/* Sound Audio Feedback */}
              <label className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/70 border border-zinc-800 cursor-pointer">
                <div className="flex items-center gap-2.5">
                  <Volume2 className="w-4 h-4 text-cyan-400" />
                  <div>
                    <span className="font-medium block text-zinc-200">Audio Chimes</span>
                    <span className="text-[10px] text-zinc-500">Play sound on successful match</span>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={appSettings.soundEnabled}
                  onChange={(e) => {
                    const next = { ...appSettings, soundEnabled: e.target.checked };
                    setAppSettings(next);
                    saveStoredSettings(next);
                  }}
                  className="w-4 h-4 rounded text-cyan-500 focus:ring-cyan-400"
                />
              </label>

              {/* Vibration Haptic Feedback */}
              <label className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/70 border border-zinc-800 cursor-pointer">
                <div className="flex items-center gap-2.5">
                  <Smartphone className="w-4 h-4 text-cyan-400" />
                  <div>
                    <span className="font-medium block text-zinc-200">Vibration Feedback</span>
                    <span className="text-[10px] text-zinc-500">Haptic pulse on scan</span>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={appSettings.vibrationEnabled}
                  onChange={(e) => {
                    const next = { ...appSettings, vibrationEnabled: e.target.checked };
                    setAppSettings(next);
                    saveStoredSettings(next);
                  }}
                  className="w-4 h-4 rounded text-cyan-500 focus:ring-cyan-400"
                />
              </label>

              {/* Supplier Rule Selection */}
              <div className="p-3 rounded-xl bg-zinc-900/70 border border-zinc-800">
                <label className="font-medium block text-zinc-200 mb-1.5">
                  Supplier Label Format
                </label>
                <select
                  value={activeSupplierRule.id}
                  onChange={(e) => {
                    const ruleId = e.target.value as SupplierRuleId;
                    if (delivery) {
                      const updated = setDeliverySupplierRule(delivery, ruleId);
                      onUpdateDelivery(updated);
                    }
                    setPreferredSupplierRuleId(ruleId);
                  }}
                  className="w-full h-9 px-2.5 rounded-lg bg-[#070A0F] border border-zinc-700 text-white font-mono text-xs outline-none focus:border-cyan-400 cursor-pointer"
                >
                  <option value="laser_central">Laser Central (Part # QR &amp; Dash Barcode)</option>
                  <option value="gci">GCI (Part # &amp; Item #)</option>
                  <option value="ocr_label">OCR Pallet Label Mode</option>
                </select>
              </div>
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
                  Enter Part # or Barcode String:
                </label>
                <input
                  type="text"
                  autoFocus
                  value={manualCodeInput}
                  onChange={(e) => setManualCodeInput(e.target.value.toUpperCase())}
                  placeholder="e.g. 10293 or PART-9002"
                  className="w-full h-11 px-3.5 rounded-xl bg-[#070A0F] border border-zinc-700 focus:border-cyan-400 text-white font-mono font-bold text-base outline-none uppercase shadow-inner"
                />
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

      {/* ============================================================ */}
      {/* DIAGNOSTIC LOGS DRAWER                                       */}
      {/* ============================================================ */}
      {isDiagnosticsOpen && (
        <div className="fixed inset-x-0 bottom-12 z-40 bg-[#0B0F17]/98 border-t border-cyan-500/30 max-h-64 flex flex-col text-white shadow-2xl animate-in slide-in-from-bottom duration-200">
          <div className="px-4 py-2 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/60">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-cyan-400" />
              <span className="font-mono text-xs font-bold uppercase tracking-wider">
                Scanner Hardware Logs ({diagnosticLogs.length})
              </span>
            </div>
            <button
              type="button"
              onClick={() => setIsDiagnosticsOpen(false)}
              className="p-1 text-zinc-400 hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 font-mono text-[10px] space-y-1">
            {diagnosticLogs.length === 0 ? (
              <div className="text-zinc-500 italic">No diagnostic events recorded yet.</div>
            ) : (
              diagnosticLogs.map((log) => (
                <div key={log.id} className="text-zinc-300 flex items-start gap-2">
                  <span className="text-zinc-500 shrink-0">{log.timestamp}</span>
                  <span
                    className={`font-bold shrink-0 ${
                      log.category === 'error'
                        ? 'text-red-400'
                        : log.category === 'ocr'
                        ? 'text-amber-400'
                        : 'text-cyan-400'
                    }`}
                  >
                    [{log.category.toUpperCase()}]
                  </span>
                  <span className="break-all">{log.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
