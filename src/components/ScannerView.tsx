import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import {
  Camera,
  Flashlight,
  FlipHorizontal,
  RotateCcw,
  Keyboard,
  AlertTriangle,
  XCircle,
  X,
  Check,
  QrCode,
  Barcode,
  Sparkles,
  ExternalLink,
  RefreshCw,
  Search,
  ListChecks,
  Columns2,
  Rows2,
  Focus,
  ZoomIn,
  ZoomOut,
  Plus,
  Minus,
  Printer,
  FileText,
  Usb,
  Activity,
  Image as ImageIcon,
  FolderOpen,
  Trash2,
} from 'lucide-react';
import {
  Delivery,
  DeliveryPart,
  ScanFeedback,
  PendingQuantityConfirmation,
  SupplierRuleId,
} from '../types/delivery';
import {
  processScannedCode,
  confirmScannedPartQuantity,
  confirmOcrPalletLabelScan,
  recordUnmatchedOcrPalletLabel,
  undoLastScan,
  setPartStatus,
  parseBarcodeDocketNo,
  getPartVerificationState,
  getDeliverySupplierRule,
  setDeliverySupplierRule,
  getPreferredSupplierRuleId,
  setPreferredSupplierRuleId,
  SUPPLIER_RULES,
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
import { OcrPalletLabelConfirmModal } from './OcrPalletLabelConfirmModal';
import { exportDeliveryPdf } from '../utils/pdfExport';
import { playAudio, triggerHaptic, speakAlert } from '../utils/audioFeedback';

export type ScannerLayoutMode = 'side-by-side' | 'below-camera';
export type ScanInputSource = 'camera_barcode_qr' | 'external_hid' | 'photo_snap' | 'manual';

const SCANNER_LAYOUT_STORAGE_KEY = 'parttrack_scanner_layout_v1';
const SELECTED_CAMERA_STORAGE_KEY = 'parttrack_selected_camera_id_v1';

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
}

/**
 * Helper to format clean Docket "No." badge from part itemNumber / docketLineIndex
 */
function formatDocketNoBadge(part: DeliveryPart, fallbackIdx?: number): string {
  const raw = String(part.itemNumber ?? '').trim();
  const clean = raw
    .replace(/^(?:ITM|ITEM|LINE|NO|ROW|BC|BAR|LCR)[-_.\s#]*/i, '')
    .replace(/^0+(?=\d)/, '');
  if (/^\d+$/.test(clean)) {
    return clean;
  }
  if (part.docketLineIndex && part.docketLineIndex > 0) {
    return String(part.docketLineIndex);
  }
  if (fallbackIdx !== undefined) {
    return String(fallbackIdx + 1);
  }
  return raw || '—';
}

export const ScannerView: React.FC<ScannerViewProps> = ({
  delivery,
  onUpdateDelivery,
  onOpenTestSheet,
  onOpenNewDelivery,
  externalPendingQuantity,
  onClearExternalPendingQuantity,
}) => {
  const [isScanning, setIsScanning] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
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

  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);

  // Camera sharpness, zoom & autofocus controls
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [supportsHardwareZoom, setSupportsHardwareZoom] = useState<boolean>(false);
  const [minHardwareZoom, setMinHardwareZoom] = useState<number>(1);
  const [maxHardwareZoom, setMaxHardwareZoom] = useState<number>(4);
  const [focusRingPos, setFocusRingPos] = useState<{ x: number; y: number } | null>(null);

  // Mandatory Quantity Confirmation Popup State (locks scanner while open)
  const [pendingQuantityScan, setPendingQuantityScan] =
    useState<PendingQuantityConfirmation | null>(null);
  const [quantityInput, setQuantityInput] = useState<string>('');
  const [quantityError, setQuantityError] = useState<string | null>(null);

  // OCR Pallet Label Confirmation Modal & Processing State (locks scanner while open)
  const [pendingOcrLabelResult, setPendingOcrLabelResult] =
    useState<PalletLabelExtractionResult | null>(null);
  const [isProcessingOcrLabel, setIsProcessingOcrLabel] = useState<boolean>(false);
  const [ocrLabelStatusMessage, setOcrLabelStatusMessage] = useState<string>('');
  const [liveOcrDetectedPreview, setLiveOcrDetectedPreview] = useState<string>('');

  // External USB / Bluetooth HID Scanner State
  const [lastExternalScannerEvent, setLastExternalScannerEvent] = useState<{
    code: string;
    timestamp: number;
  } | null>(null);

  // Diagnostic Log Drawer State
  const [diagnosticLogs, setDiagnosticLogs] = useState<DiagnosticLogEntry[]>([]);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState<boolean>(false);

  // Manual modal & input
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [manualCodeInput, setManualCodeInput] = useState('');

  // Real-time scan feedback & visual flash
  const [scanFeedback, setScanFeedback] = useState<ScanFeedback | null>(null);
  const [flashColor, setFlashColor] = useState<'green' | 'orange' | 'red' | null>(null);
  const [isSnappingPhoto, setIsSnappingPhoto] = useState(false);

  // Mobile 3-Option Upload Selector Modal State (Camera / Gallery / Files with multi-file preview & confirm)
  const [uploadModalIntent, setUploadModalIntent] = useState<'snap' | 'ocr_label' | null>(null);
  const [stagedScannerFiles, setStagedScannerFiles] = useState<
    Array<{
      id: string;
      file: File;
      previewUrl: string;
      sourceLabel: 'Camera' | 'Gallery' | 'Files';
    }>
  >([]);

  // Side docket window state & persisted scanner layout ('side-by-side' vs 'below-camera')
  const [sideListSearch, setSideListSearch] = useState('');
  const [sideListFilter, setSideListFilter] = useState<'all' | 'outstanding' | 'received'>('all');
  const [justScannedPartId, setJustScannedPartId] = useState<string | null>(null);
  const [confirmTickPart, setConfirmTickPart] = useState<DeliveryPart | null>(null);
  const [manualTickQtyInput, setManualTickQtyInput] = useState<string>('1');
  const [scannerLayout, setScannerLayout] = useState<ScannerLayoutMode>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem(SCANNER_LAYOUT_STORAGE_KEY);
        if (saved === 'side-by-side' || saved === 'below-camera') {
          return saved;
        }
      } catch {}
    }
    return 'side-by-side';
  });

  const appendDiagnosticLog = useCallback(
    (category: DiagnosticLogEntry['category'], message: string) => {
      const timeStr = new Date().toLocaleTimeString();
      const prefix = `[PartTrack ${category.toUpperCase()}]`;
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

  const handleSelectScannerLayout = useCallback(
    (nextLayout: ScannerLayoutMode, e?: React.SyntheticEvent) => {
      if (e) e.stopPropagation();
      setScannerLayout(nextLayout);
      if (typeof window !== 'undefined') {
        try {
          localStorage.setItem(SCANNER_LAYOUT_STORAGE_KEY, nextLayout);
        } catch {}
      }
      appendDiagnosticLog('camera', `Switched scanner layout to "${nextLayout}" without restarting stream.`);
    },
    [appendDiagnosticLog]
  );

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
  const justScannedTimeoutRef = useRef<any>(null);
  const focusRingTimeoutRef = useRef<any>(null);
  const externalHidBannerTimeoutRef = useRef<any>(null);
  const isStartingRef = useRef<boolean>(false);
  const isMountedRef = useRef<boolean>(true);
  const snapFileInputRef = useRef<HTMLInputElement | null>(null);
  const ocrLabelFileInputRef = useRef<HTMLInputElement | null>(null);
  const scannerCameraInputRef = useRef<HTMLInputElement | null>(null);
  const scannerGalleryInputRef = useRef<HTMLInputElement | null>(null);
  const scannerFilesInputRef = useRef<HTMLInputElement | null>(null);
  const partsListScrollRef = useRef<HTMLDivElement | null>(null);
  const quantityInputRef = useRef<HTMLInputElement | null>(null);

  // External USB / Bluetooth HID keyboard wedge buffer refs
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

  // Ref to immediately lock/pause scanner callbacks when quantity or OCR confirmation modal is open
  const pendingQuantityScanRef = useRef<PendingQuantityConfirmation | null>(null);
  pendingQuantityScanRef.current = pendingQuantityScan;
  const pendingOcrLabelRef = useRef<PalletLabelExtractionResult | null>(null);
  pendingOcrLabelRef.current = pendingOcrLabelResult;
  const isManualModalOpenRef = useRef<boolean>(false);
  isManualModalOpenRef.current = isManualModalOpen;
  const confirmTickPartRef = useRef<DeliveryPart | null>(null);
  confirmTickPartRef.current = confirmTickPart;

  // Check if running inside iframe (e.g., AI Studio preview)
  const isInsideIframe = typeof window !== 'undefined' && window.self !== window.top;

  // Keep references to delivery and update handler stable
  const deliveryRef = useRef(delivery);
  deliveryRef.current = delivery;

  const onUpdateDeliveryRef = useRef(onUpdateDelivery);
  onUpdateDeliveryRef.current = onUpdateDelivery;

  // Active supplier rule profile ("Laser Central" barcode rule vs "GCI" QR code rule vs "OCR Label Scanner")
  const [preferredRuleId, setPreferredRuleId] = useState<SupplierRuleId>(() =>
    getPreferredSupplierRuleId()
  );

  useEffect(() => {
    const handleRuleChanged = () => {
      setPreferredRuleId(getPreferredSupplierRuleId());
    };
    window.addEventListener('parttrack_supplier_rule_changed', handleRuleChanged);
    return () => window.removeEventListener('parttrack_supplier_rule_changed', handleRuleChanged);
  }, []);

  const activeSupplierRule = useMemo(
    () => (delivery ? getDeliverySupplierRule(delivery) : SUPPLIER_RULES[preferredRuleId]),
    [delivery, preferredRuleId]
  );
  const activeSupplierRuleRef = useRef(activeSupplierRule);
  activeSupplierRuleRef.current = activeSupplierRule;

  // Prewarm offline OCR worker when ScannerView mounts or switches to ocr_label
  useEffect(() => {
    prewarmPalletLabelOcrEngine();
    appendDiagnosticLog('ocr', 'Pre-warming bundled offline Tesseract LSTM worker...');
  }, [appendDiagnosticLog]);

  // Sync externalPendingQuantity (e.g. from TestBarcodesModal) into our popup
  useEffect(() => {
    if (externalPendingQuantity) {
      setPendingQuantityScan(externalPendingQuantity);
      setQuantityInput(String(Math.max(1, externalPendingQuantity.part.quantity ?? 1)));
      setQuantityError(null);
      onClearExternalPendingQuantity?.();
    }
  }, [externalPendingQuantity, onClearExternalPendingQuantity]);

  useEffect(() => {
    if (pendingQuantityScan) {
      setTimeout(() => {
        quantityInputRef.current?.focus();
        quantityInputRef.current?.select();
      }, 60);
    }
  }, [pendingQuantityScan]);

  const totalParts = delivery?.parts.length || 0;
  const receivedParts = delivery?.parts.filter((p) => p.status === 'received').length || 0;
  const outstandingParts = totalParts - receivedParts;
  const percentage = totalParts > 0 ? Math.round((receivedParts / totalParts) * 100) : 0;

  const handleSelectSupplier = (ruleId: SupplierRuleId, e?: React.SyntheticEvent) => {
    if (e) e.stopPropagation();
    setPreferredSupplierRuleId(ruleId);
    setPreferredRuleId(ruleId);
    if (delivery) {
      const updated = setDeliverySupplierRule(delivery, ruleId);
      onUpdateDelivery(updated);
    }
    appendDiagnosticLog(
      'barcode_qr',
      `Active mode set to "${SUPPLIER_RULES[ruleId].name}" (Barcode, QR, OCR & HID remain active).`
    );
  };

  const triggerVisualFlash = (color: 'green' | 'orange' | 'red') => {
    setFlashColor(color);
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    flashTimeoutRef.current = setTimeout(() => {
      setFlashColor(null);
    }, 600);
  };

  /**
   * Helper to get the active video MediaStreamTrack from the scanner DOM container
   */
  const getActiveVideoTrack = useCallback((): MediaStreamTrack | null => {
    try {
      const container = document.getElementById('camera-scanner-view');
      const video = container?.querySelector('video') as HTMLVideoElement | null;
      const stream = video?.srcObject as MediaStream | null;
      const tracks = stream?.getVideoTracks?.();
      if (tracks && tracks.length > 0 && tracks[0].readyState === 'live') {
        return tracks[0];
      }
    } catch {}
    return null;
  }, []);

  /**
   * Enumerates all available video input devices (front, rear, multiple rear lenses, USB webcams, external cameras)
   * using navigator.mediaDevices.enumerateDevices() and formats fallback names (Camera 1, Camera 2, etc.).
   */
  const enumerateAllVideoInputs = useCallback(async (): Promise<
    Array<{ id: string; label: string }>
  > => {
    const discovered: Array<{ id: string; label: string }> = [];
    try {
      if (navigator?.mediaDevices?.enumerateDevices) {
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = allDevices.filter((d) => d.kind === 'videoinput');
        videoInputs.forEach((d, idx) => {
          const id = d.deviceId || `camera_${idx + 1}`;
          const cleanLabel = (d.label || '').trim() || `Camera ${idx + 1}`;
          if (!discovered.some((existing) => existing.id === id)) {
            discovered.push({ id, label: cleanLabel });
          }
        });
      }
    } catch (err: any) {
      appendDiagnosticLog('error', `enumerateDevices() error: ${err?.message || String(err)}`);
    }

    if (discovered.length === 0) {
      try {
        const rawCams = await Html5Qrcode.getCameras();
        if (rawCams && rawCams.length > 0) {
          rawCams.forEach((c, idx) => {
            discovered.push({
              id: c.id,
              label: (c.label || '').trim() || `Camera ${idx + 1}`,
            });
          });
        }
      } catch {}
    }

    if (isMountedRef.current && discovered.length > 0) {
      setAvailableCameras(discovered);
    }
    return discovered;
  }, [appendDiagnosticLog]);

  /**
   * Applies continuous autofocus, continuous exposure, white balance, and hardware zoom
   * to the live camera track without mutating video width/height post-start, and inspects
   * actual granted track settings & capabilities.
   */
  const configureTrackFocusAndCapabilities = useCallback(
    async (targetZoom = zoomLevelRef.current) => {
      const track = getActiveVideoTrack();
      if (!track) return;

      try {
        const capabilities = (track as any).getCapabilities?.() || {};
        const settings = (track as any).getSettings?.() || {};

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

        // 3. Apply continuous autofocus, continuous exposure, white balance & hardware zoom safely
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

        // 4. Inspect actual camera resolution and focus mode granted by hardware
        const updatedSettings = (track as any).getSettings?.() || settings;
        const container = document.getElementById('camera-scanner-view');
        const video = container?.querySelector('video') as HTMLVideoElement | null;
        const actualW = updatedSettings.width || video?.videoWidth || 0;
        const actualH = updatedSettings.height || video?.videoHeight || 0;
        const fps = updatedSettings.frameRate ? Math.round(updatedSettings.frameRate) : undefined;
        const focusMode =
          updatedSettings.focusMode ||
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

        appendDiagnosticLog(
          'camera',
          `Active stream: "${track.label || 'Video Track'}" @ ${actualW}x${actualH}${
            fps ? ` (${fps}fps)` : ''
          } · focus=${focusMode} · hwZoom=${Boolean(capabilities.zoom)}`
        );
      } catch (e: any) {
        appendDiagnosticLog('error', `Track capability check note: ${e?.message || String(e)}`);
      }
    },
    [appendDiagnosticLog, getActiveVideoTrack]
  );

  /**
   * Smoothly applies a new zoom level (used by +/- buttons, preset buttons, and pinch-to-zoom)
   * without interrupting barcode, QR code, or OCR detection.
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

  const handleSelectZoom = async (targetZoom: number, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    await applyZoomLevel(targetZoom);
  };

  const handleZoomStep = async (delta: number, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const next = Math.round((zoomLevelRef.current + delta) * 4) / 4;
    await applyZoomLevel(next);
  };

  /**
   * Pinch-to-Zoom touch handlers on the camera stage
   */
  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchStartDistanceRef.current = Math.hypot(dx, dy);
      pinchStartZoomRef.current = zoomLevelRef.current;
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && pinchStartDistanceRef.current !== null) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      if (pinchStartDistanceRef.current > 10) {
        const scaleRatio = dist / pinchStartDistanceRef.current;
        const targetZoom = pinchStartZoomRef.current * scaleRatio;
        applyZoomLevel(targetZoom);
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length < 2) {
      pinchStartDistanceRef.current = null;
    }
  };

  /**
   * Tap-to-Focus handler: triggers an immediate autofocus cycle on the tapped area
   */
  const handleTapToFocus = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (pendingQuantityScanRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const normX = Math.max(0, Math.min(1, x / Math.max(1, rect.width)));
    const normY = Math.max(0, Math.min(1, y / Math.max(1, rect.height)));

    setFocusRingPos({ x, y });
    if (focusRingTimeoutRef.current) clearTimeout(focusRingTimeoutRef.current);
    focusRingTimeoutRef.current = setTimeout(() => {
      setFocusRingPos(null);
    }, 950);

    const track = getActiveVideoTrack();
    if (!track) return;

    try {
      const capabilities = (track as any).getCapabilities?.() || {};
      const poiConstraint = capabilities.pointsOfInterest
        ? { pointsOfInterest: [{ x: normX, y: normY }] }
        : {};

      if (Array.isArray(capabilities.focusMode)) {
        if (capabilities.focusMode.includes('single-shot')) {
          await track
            .applyConstraints({
              advanced: [{ focusMode: 'single-shot', ...poiConstraint } as any],
            })
            .catch(() => {});
          setTimeout(() => {
            if (capabilities.focusMode.includes('continuous')) {
              track
                .applyConstraints({
                  advanced: [{ focusMode: 'continuous', ...poiConstraint } as any],
                })
                .catch(() => {});
            }
          }, 500);
          return;
        }
      }
      await track
        .applyConstraints({
          advanced: [{ focusMode: 'continuous', ...poiConstraint } as any],
        })
        .catch(() => {});
    } catch {}
  };

  /**
   * UNIFIED CENTRAL SCANNING & MATCHING FUNCTION
   * All recognition methods (Camera Barcode, Camera QR, External USB/Bluetooth HID Scanners,
   * Photo Snap, and Manual Entry) route through this single handler.
   */
  const handleScannedCode = useCallback(
    (codeText: string, inputSource: ScanInputSource = 'camera_barcode_qr') => {
      // CRITICAL: Lock/pause scanner while Mandatory Quantity or OCR Label Confirmation popup is open!
      if (pendingQuantityScanRef.current !== null || pendingOcrLabelRef.current !== null) {
        return;
      }

      const currentDelivery = deliveryRef.current;
      if (!currentDelivery) return;

      const cleaned = codeText.trim();
      if (!cleaned) return;

      const now = Date.now();
      if (cleaned === lastScannedCodeRef.current && now - lastScannedTimeRef.current < 1200) {
        return;
      }

      lastScannedCodeRef.current = cleaned;
      lastScannedTimeRef.current = now;

      appendDiagnosticLog(
        inputSource === 'external_hid' ? 'external_hid' : 'barcode_qr',
        `Received code "${cleaned}" via ${inputSource}`
      );

      if (inputSource === 'external_hid') {
        setLastExternalScannerEvent({ code: cleaned, timestamp: now });
        if (externalHidBannerTimeoutRef.current) {
          clearTimeout(externalHidBannerTimeoutRef.current);
        }
        externalHidBannerTimeoutRef.current = setTimeout(() => {
          setLastExternalScannerEvent(null);
        }, 4500);
      }

      const { updatedDelivery, result } = processScannedCode(currentDelivery, cleaned);

      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);

      // Mandatory Quantity Confirmation when required quantity > 1:
      // Pause scanner immediately and display the quantity entry modal.
      if (result.status === 'requires_quantity' && result.pendingQuantityConfirmation) {
        const pending = result.pendingQuantityConfirmation;
        pendingQuantityScanRef.current = pending;
        setPendingQuantityScan(pending);
        setQuantityInput(String(Math.max(1, pending.part.quantity ?? 1)));
        setQuantityError(null);

        playAudio.success();
        triggerHaptic('success');
        speakAlert(
          `Enter quantity for ${pending.part.partNumber}, required ${pending.part.quantity}`
        );
        return;
      }

      onUpdateDeliveryRef.current(updatedDelivery);

      const parsedBarcodeNo = parseBarcodeDocketNo(cleaned);
      const sourcePrefix = inputSource === 'external_hid' ? '[USB/BT Scanner] ' : '';

      if (result.status === 'matched' && result.part) {
        triggerVisualFlash('green');
        playAudio.success();
        triggerHaptic('success');

        const docketNoStr = formatDocketNoBadge(result.part);
        speakAlert(`Matched Number ${docketNoStr}, ${result.part.partNumber}`);

        // Promote to top of the side window in green
        setJustScannedPartId(result.part.id);
        if (justScannedTimeoutRef.current) clearTimeout(justScannedTimeoutRef.current);
        justScannedTimeoutRef.current = setTimeout(() => {
          setJustScannedPartId(null);
        }, 6000);

        // Auto-scroll the side list to the top
        partsListScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });

        setScanFeedback({
          type: 'success',
          code: cleaned,
          matchedPart: result.part,
          message: parsedBarcodeNo.hasDashFormat
            ? `${sourcePrefix}Barcode ${cleaned} → No. ${docketNoStr} (${result.part.partNumber}) · Qty 1/1`
            : `${sourcePrefix}Verified No. ${docketNoStr} · ${result.part.partNumber} · Qty 1/1`,
          timestamp: now,
        });
      } else if (result.status === 'duplicate' && result.part) {
        triggerVisualFlash('orange');
        playAudio.duplicate();
        triggerHaptic('duplicate');
        speakAlert('Duplicate scan');

        const docketNoStr = formatDocketNoBadge(result.part);
        const vState = getPartVerificationState(result.part);
        setScanFeedback({
          type: 'duplicate',
          code: cleaned,
          matchedPart: result.part,
          message: `${sourcePrefix}Duplicate ignored: No. ${docketNoStr} (${result.part.partNumber}) already recorded (Qty ${vState.receivedQty}/${vState.requiredQty})`,
          timestamp: now,
        });
      } else {
        triggerVisualFlash('red');
        playAudio.unexpected();
        triggerHaptic('unexpected');
        speakAlert('Unexpected part');

        setScanFeedback({
          type: 'unexpected',
          code: cleaned,
          message:
            parsedBarcodeNo.hasDashFormat && parsedBarcodeNo.numericNo !== null
              ? `${sourcePrefix}Barcode "${cleaned}" (Docket No. ${parsedBarcodeNo.numericNo}) not found on docket ${currentDelivery.docketNumber}`
              : `${sourcePrefix}Code "${cleaned}" not listed on docket ${currentDelivery.docketNumber}`,
          timestamp: now,
        });
      }

      feedbackTimeoutRef.current = setTimeout(() => {
        setScanFeedback(null);
      }, 8000);
    },
    [appendDiagnosticLog]
  );

  /**
   * EXTERNAL USB & BLUETOOTH BARCODE SCANNER SUPPORT (HID / Keyboard Wedge Mode)
   * Automatically receives rapid keystroke bursts or Enter/Tab-terminated scans from
   * physical handheld barcode/QR scanners without interfering with normal input fields.
   */
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Do not intercept if a modal with its own input is active or user is typing in an input/textarea/select
      const target = e.target as HTMLElement | null;
      const tagName = target?.tagName?.toUpperCase() || '';
      const isEditableElement =
        tagName === 'INPUT' ||
        tagName === 'TEXTAREA' ||
        tagName === 'SELECT' ||
        Boolean(target?.isContentEditable);

      if (
        isEditableElement ||
        pendingQuantityScanRef.current !== null ||
        pendingOcrLabelRef.current !== null ||
        isManualModalOpenRef.current ||
        confirmTickPartRef.current !== null
      ) {
        return;
      }

      // Ignore modifier shortcuts (Ctrl+C, Cmd+V, Alt+Tab, etc.)
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }

      const now = performance.now();
      const gap = now - hidLastKeyTimeRef.current;

      // Reset buffer if more than 140ms elapsed since previous keystroke (human typing vs scanner burst)
      if (gap > 140) {
        hidBufferRef.current = '';
        hidKeystrokeCountRef.current = 0;
        hidFirstKeyTimeRef.current = now;
      }

      if (e.key === 'Enter' || e.key === 'Tab') {
        const candidate = hidBufferRef.current.trim();
        const count = hidKeystrokeCountRef.current;
        if (hidFlushTimerRef.current) {
          clearTimeout(hidFlushTimerRef.current);
          hidFlushTimerRef.current = null;
        }
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

        // Also support physical scanners configured without an Enter/Tab suffix:
        // If >= 4 characters arrived rapidly (avg < 45ms/char), auto-flush 95ms after last char
        if (hidFlushTimerRef.current) {
          clearTimeout(hidFlushTimerRef.current);
        }
        const totalDuration = now - hidFirstKeyTimeRef.current;
        const avgPerChar =
          hidKeystrokeCountRef.current > 1
            ? totalDuration / (hidKeystrokeCountRef.current - 1)
            : 0;

        if (hidKeystrokeCountRef.current >= 4 && avgPerChar < 48) {
          hidFlushTimerRef.current = setTimeout(() => {
            const burstCandidate = hidBufferRef.current.trim();
            hidBufferRef.current = '';
            hidKeystrokeCountRef.current = 0;
            if (burstCandidate.length >= 3) {
              handleScannedCode(burstCandidate, 'external_hid');
            }
          }, 95);
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown, true);
    appendDiagnosticLog(
      'external_hid',
      'USB & Bluetooth HID Barcode Scanner listener active (Enter/Tab suffix + rapid-burst detection).'
    );
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown, true);
      if (hidFlushTimerRef.current) {
        clearTimeout(hidFlushTimerRef.current);
      }
    };
  }, [appendDiagnosticLog, handleScannedCode]);

  /**
   * Handles submitting the mandatory quantity confirmation popup for parts with required quantity > 1
   */
  const handleConfirmPendingQuantity = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingQuantityScan || !deliveryRef.current) return;

    const trimmed = quantityInput.trim();
    const parsedQty = Number(trimmed);
    if (!trimmed || Number.isNaN(parsedQty) || !Number.isInteger(parsedQty) || parsedQty < 1) {
      setQuantityError('Please enter a valid whole number quantity (1 or greater).');
      return;
    }

    const {
      updatedDelivery,
      updatedPart,
      isCorrectQuantity,
      requiredQuantity,
      receivedQuantity,
    } = confirmScannedPartQuantity(deliveryRef.current, pendingQuantityScan, parsedQty);

    // Unlock scanner and update delivery state
    pendingQuantityScanRef.current = null;
    setPendingQuantityScan(null);
    setQuantityInput('');
    setQuantityError(null);
    lastScannedTimeRef.current = Date.now();

    onUpdateDeliveryRef.current(updatedDelivery);

    const docketNoStr = formatDocketNoBadge(updatedPart);

    // Promote to top of side list
    setJustScannedPartId(updatedPart.id);
    if (justScannedTimeoutRef.current) clearTimeout(justScannedTimeoutRef.current);
    justScannedTimeoutRef.current = setTimeout(() => {
      setJustScannedPartId(null);
    }, 6000);
    partsListScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });

    if (isCorrectQuantity) {
      triggerVisualFlash('green');
      playAudio.success();
      triggerHaptic('success');
      speakAlert(
        `Verified ${updatedPart.partNumber}, quantity ${receivedQuantity} of ${requiredQuantity}`
      );
      setScanFeedback({
        type: 'success',
        code: pendingQuantityScan.code,
        matchedPart: updatedPart,
        message: `Verified No. ${docketNoStr} (${updatedPart.partNumber}) · Qty ${receivedQuantity}/${requiredQuantity} Matched`,
        timestamp: Date.now(),
      });
    } else {
      triggerVisualFlash('orange');
      playAudio.duplicate();
      triggerHaptic('duplicate');
      speakAlert(
        `Quantity mismatch for ${updatedPart.partNumber}: entered ${receivedQuantity}, required ${requiredQuantity}`
      );
      setScanFeedback({
        type: 'quantity_mismatch',
        code: pendingQuantityScan.code,
        matchedPart: updatedPart,
        message: `Qty Mismatch No. ${docketNoStr} (${updatedPart.partNumber}) · Entered ${receivedQuantity} of ${requiredQuantity} required`,
        timestamp: Date.now(),
      });
    }

    if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
    feedbackTimeoutRef.current = setTimeout(() => {
      setScanFeedback(null);
    }, 8000);
  };

  /**
   * Starts a hardware-accelerated BarcodeDetector loop on the full-resolution live <video> element
   * when supported by the browser/device. Operates continuously alongside OCR and Html5Qrcode.
   */
  const startNativeBarcodeLoop = useCallback(() => {
    if (nativeDetectorIntervalRef.current) {
      clearInterval(nativeDetectorIntervalRef.current);
      nativeDetectorIntervalRef.current = null;
    }

    const BarcodeDetectorAPI = (window as any).BarcodeDetector;
    if (!BarcodeDetectorAPI) {
      appendDiagnosticLog(
        'barcode_qr',
        'Native BarcodeDetector API not present in this browser; using Html5Qrcode ZXing engine.'
      );
      return;
    }

    let detector: any = null;
    try {
      detector = new BarcodeDetectorAPI({
        formats: [
          'code_128',
          'code_39',
          'code_93',
          'ean_13',
          'ean_8',
          'upc_a',
          'upc_e',
          'itf',
          'qr_code',
          'data_matrix',
          'codabar',
        ],
      });
      appendDiagnosticLog('barcode_qr', 'Native hardware BarcodeDetector loop started (160ms).');
    } catch {
      try {
        detector = new BarcodeDetectorAPI();
        appendDiagnosticLog('barcode_qr', 'Native BarcodeDetector loop started (default formats).');
      } catch (err: any) {
        appendDiagnosticLog('error', `BarcodeDetector init failed: ${err?.message || String(err)}`);
        return;
      }
    }

    let isDetecting = false;
    nativeDetectorIntervalRef.current = setInterval(async () => {
      if (
        isDetecting ||
        !isMountedRef.current ||
        pendingQuantityScanRef.current !== null ||
        pendingOcrLabelRef.current !== null
      ) {
        return;
      }
      const container = document.getElementById('camera-scanner-view');
      const video = container?.querySelector('video') as HTMLVideoElement | null;
      if (!video || video.readyState < 2 || video.videoWidth === 0) return;

      isDetecting = true;
      try {
        const barcodes = await detector.detect(video);
        if (barcodes && barcodes.length > 0) {
          const rule = activeSupplierRuleRef.current;
          let chosen = barcodes[0];
          if (rule.id === 'gci') {
            const qrCandidate = barcodes.find(
              (b: any) => b.format === 'qr_code' || b.format === 'data_matrix'
            );
            if (qrCandidate) chosen = qrCandidate;
          } else {
            const hyphenMatch = barcodes.find(
              (b: any) =>
                b.rawValue && parseBarcodeDocketNo(String(b.rawValue)).hasDashFormat
            );
            if (hyphenMatch) chosen = hyphenMatch;
          }
          if (chosen?.rawValue) {
            handleScannedCode(String(chosen.rawValue), 'camera_barcode_qr');
          }
        }
      } catch {
        // Ignore transient frame errors
      } finally {
        isDetecting = false;
      }
    }, 160);
  }, [appendDiagnosticLog, handleScannedCode]);

  /**
   * Starts a non-blocking periodic Live Camera OCR loop when OCR Label Scanner mode is selected.
   * Uses frame-signature deduplication so identical frames are not re-processed repeatedly,
   * and never blocks barcode or QR recognition on the same live camera stream.
   */
  const startLiveOcrLoop = useCallback(() => {
    if (liveOcrIntervalRef.current) {
      clearInterval(liveOcrIntervalRef.current);
      liveOcrIntervalRef.current = null;
    }

    liveOcrIntervalRef.current = setInterval(async () => {
      if (
        !isMountedRef.current ||
        activeSupplierRuleRef.current.id !== 'ocr_label' ||
        isLiveOcrBusyRef.current ||
        isProcessingOcrLabel ||
        pendingQuantityScanRef.current !== null ||
        pendingOcrLabelRef.current !== null
      ) {
        return;
      }

      const container = document.getElementById('camera-scanner-view');
      const video = container?.querySelector('video') as HTMLVideoElement | null;
      if (!video || video.readyState < 2 || video.videoWidth === 0) return;

      // Check frame signature & edge contrast to skip identical frames or blank/dark frames
      const sigInfo = computeVideoFrameSignature(video);
      if (!sigInfo || sigInfo.edgeContrast < 4.5) {
        return;
      }

      if (lastOcrFrameSignatureRef.current.length > 0) {
        const diff = computeFrameSignatureDifference(
          sigInfo.signature,
          lastOcrFrameSignatureRef.current
        );
        if (diff < 4.0) {
          // Frame has not meaningfully changed since last OCR evaluation
          return;
        }
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
          pendingQuantityScanRef.current !== null ||
          pendingOcrLabelRef.current !== null
        ) {
          return;
        }

        const previewSummary = [
          result.partNumber ? `Part: ${result.partNumber}` : '',
          result.quantity !== null ? `Qty: ${result.quantity}` : '',
          result.description ? `Desc: ${result.description.slice(0, 28)}` : '',
        ]
          .filter(Boolean)
          .join(' · ');

        if (previewSummary) {
          setLiveOcrDetectedPreview(previewSummary);
          appendDiagnosticLog('ocr', `Live frame OCR: ${previewSummary}`);
        } else if (result.rawOcrText.trim()) {
          const snippet = result.rawOcrText.replace(/\s+/g, ' ').trim().slice(0, 48);
          setLiveOcrDetectedPreview(`Text: "${snippet}"`);
        }

        // Automatically open confirmation modal when live OCR finds a matched part on the docket
        // (or a high-confidence part number + quantity on the pallet label)
        if (result.partNumber) {
          const evaluation = evaluatePalletLabelMatch(
            result.partNumber,
            result.quantity,
            deliveryRef.current?.parts || [],
            result.ocrConfidence
          );
          if (
            evaluation.matchedPart ||
            (result.ocrConfidence === 'high' && result.quantity !== null && result.quantity > 0)
          ) {
            pendingOcrLabelRef.current = result;
            setPendingOcrLabelResult(result);
            playAudio.success();
            triggerHaptic('success');
          }
        }
      } catch (err: any) {
        appendDiagnosticLog('error', `Live OCR frame note: ${err?.message || String(err)}`);
      } finally {
        isLiveOcrBusyRef.current = false;
      }
    }, 1850);
  }, [appendDiagnosticLog, isProcessingOcrLabel]);

  /**
   * Initializes the single unified continuous video camera scanner at native high resolution (Full HD 1080p),
   * supporting universal camera selection by exact deviceId, and safely stopping any prior stream first.
   */
  const startScanner = useCallback(
    async (targetCameraId?: string) => {
      if (isStartingRef.current) return;
      isStartingRef.current = true;
      setIsStarting(true);
      setCameraError(null);

      try {
        // 1. Safely stop any existing scanner instance, video tracks & recognition loops first
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

        // 2. Discover all available videoinput devices via navigator.mediaDevices.enumerateDevices()
        let devices = await enumerateAllVideoInputs();
        appendDiagnosticLog(
          'camera',
          `Enumerated ${devices.length} video input device(s): ${
            devices.map((d) => d.label).join(', ') || 'pending permission'
          }`
        );

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
          const rearCandidates = devices.filter(
            (d) =>
              /back|rear|environment|main|standard/i.test(d.label) &&
              !/ultra|wide-angle|0\.5|macro|depth|tele|front|user|selfie/i.test(d.label)
          );
          const primaryRear =
            rearCandidates.find((d) => /camera\s*0|main|standard|1x/i.test(d.label)) ||
            rearCandidates[0] ||
            devices.find(
              (d) =>
                /back|rear|environment/i.test(d.label) &&
                !/ultra|0\.5|macro|front|user/i.test(d.label)
            ) ||
            devices.find((d) => /back|rear|environment/i.test(d.label));

          if (primaryRear && !orderedCameraIds.includes(primaryRear.id)) {
            orderedCameraIds.push(primaryRear.id);
          }
          for (const dev of rearCandidates) {
            if (!orderedCameraIds.includes(dev.id)) {
              orderedCameraIds.push(dev.id);
            }
          }
          for (const dev of devices) {
            if (!orderedCameraIds.includes(dev.id) && !/front|user|selfie/i.test(dev.label)) {
              orderedCameraIds.push(dev.id);
            }
          }
          for (const dev of devices) {
            if (!orderedCameraIds.includes(dev.id)) {
              orderedCameraIds.push(dev.id);
            }
          }
        }

        // Build high-resolution constraint attempts using exact deviceId first
        const attempts: Array<{ cameraId?: string; constraints: string | MediaTrackConstraints }> =
          [];

        for (const camId of orderedCameraIds) {
          attempts.push({
            cameraId: camId,
            constraints: {
              deviceId: { exact: camId },
              width: { min: 1280, ideal: 1920, max: 2560 },
              height: { min: 720, ideal: 1080, max: 1440 },
            },
          });
          attempts.push({
            cameraId: camId,
            constraints: {
              deviceId: { exact: camId },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            },
          });
          attempts.push({
            cameraId: camId,
            constraints: {
              deviceId: { exact: camId },
            },
          });
        }

        attempts.push({
          constraints: {
            facingMode: { ideal: 'environment' },
            width: { min: 1280, ideal: 1920, max: 2560 },
            height: { min: 720, ideal: 1080, max: 1440 },
          },
        });
        attempts.push({
          constraints: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        attempts.push({ constraints: { facingMode: 'environment' } });
        attempts.push({ constraints: { facingMode: 'user' } });

        const container = document.getElementById('camera-scanner-view');
        if (!container) {
          throw new Error('Scanner container element not found in DOM.');
        }

        const createFreshScanner = () =>
          new Html5Qrcode('camera-scanner-view', {
            formatsToSupport: [
              Html5QrcodeSupportedFormats.CODE_128,
              Html5QrcodeSupportedFormats.CODE_39,
              Html5QrcodeSupportedFormats.CODE_93,
              Html5QrcodeSupportedFormats.ITF,
              Html5QrcodeSupportedFormats.EAN_13,
              Html5QrcodeSupportedFormats.EAN_8,
              Html5QrcodeSupportedFormats.UPC_A,
              Html5QrcodeSupportedFormats.UPC_E,
              Html5QrcodeSupportedFormats.QR_CODE,
              Html5QrcodeSupportedFormats.DATA_MATRIX,
            ],
            experimentalFeatures: {
              useBarCodeDetectorIfSupported: false,
            },
            verbose: false,
          });

        // Responsive qrbox ensures Html5Qrcode's ZXing decoder processes a fast, crisp region
        // without blocking the main thread on 2-megapixel 1080p frames, while startNativeBarcodeLoop()
        // simultaneously scans the full 1080p video frame.
        const scanConfig: any = {
          fps: 15,
          disableFlip: false,
          qrbox: (viewfinderWidth: number, viewfinderHeight: number) => ({
            width: Math.max(160, Math.floor(viewfinderWidth * 0.86)),
            height: Math.max(100, Math.floor(viewfinderHeight * 0.62)),
          }),
        };

        let started = false;
        let lastErrorMsg = '';
        let activeCamId = '';

        for (const attempt of attempts) {
          let candidateScanner: Html5Qrcode | null = null;
          try {
            candidateScanner = createFreshScanner();
            await candidateScanner.start(
              attempt.constraints,
              scanConfig,
              (decodedText) => {
                handleScannedCode(decodedText, 'camera_barcode_qr');
              },
              () => {}
            );
            scannerRef.current = candidateScanner;
            activeCamId = attempt.cameraId || '';
            started = true;
            break;
          } catch (attemptErr: any) {
            lastErrorMsg = attemptErr?.message || String(attemptErr);
            if (candidateScanner) {
              try {
                candidateScanner.clear();
              } catch {}
            }
          }
        }

        if (!started) {
          appendDiagnosticLog('error', `Camera stream start failed: ${lastErrorMsg}`);
          if (isMountedRef.current) {
            setIsScanning(false);
            const inIframe = typeof window !== 'undefined' && window.self !== window.top;
            if (inIframe) {
              setCameraError(
                'Continuous video camera is restricted inside the preview iframe. Use "Scan Barcode/QR" or "OCR Label" below (works 100% in preview) or open PartTrack in a dedicated browser tab.'
              );
            } else {
              setCameraError(
                lastErrorMsg.includes('Permission') || lastErrorMsg.includes('NotAllowed')
                  ? 'Camera permission was denied. Please allow camera access in your browser settings or tap "Start Live Camera" below.'
                  : 'Unable to start continuous camera stream. Tap "Scan Barcode/QR" or "Start Live Camera" below.'
              );
            }
          }
          return;
        }

        // Re-enumerate devices now that permission is granted so full camera labels are populated
        devices = await enumerateAllVideoInputs();
        const liveTrack = getActiveVideoTrack();
        const grantedDeviceId =
          (liveTrack as any)?.getSettings?.()?.deviceId || activeCamId || devices[0]?.id || '';

        if (grantedDeviceId && isMountedRef.current) {
          setSelectedCameraId(grantedDeviceId);
          try {
            localStorage.setItem(SELECTED_CAMERA_STORAGE_KEY, grantedDeviceId);
          } catch {}
        }

        if (isMountedRef.current) {
          setIsScanning(true);
          setCameraError(null);
        }

        appendDiagnosticLog(
          'barcode_qr',
          'Html5Qrcode (1D Barcode + 2D QR) engine initialized on live stream.'
        );

        // Configure continuous autofocus, exposure, zoom capabilities, and start BarcodeDetector + Live OCR loops
        setTimeout(async () => {
          if (!isMountedRef.current) return;
          await configureTrackFocusAndCapabilities();
          startNativeBarcodeLoop();
          startLiveOcrLoop();
        }, 180);
      } catch (err: any) {
        appendDiagnosticLog('error', `Camera initialization exception: ${err?.message || String(err)}`);
        if (isMountedRef.current) {
          setIsScanning(false);
          const inIframe = typeof window !== 'undefined' && window.self !== window.top;
          setCameraError(
            inIframe
              ? 'Preview iframe restricted video stream. Use "Scan Barcode/QR" or "OCR Label" below.'
              : err?.message || 'Camera unavailable. Please grant Camera permission in phone settings.'
          );
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
      startLiveOcrLoop,
      startNativeBarcodeLoop,
    ]
  );

  /**
   * Listen for USB / External camera connection or disconnection via navigator.mediaDevices 'devicechange'
   */
  useEffect(() => {
    if (!navigator?.mediaDevices?.addEventListener) return;
    const handleDeviceChange = async () => {
      const updatedList = await enumerateAllVideoInputs();
      appendDiagnosticLog(
        'camera',
        `devicechange detected: ${updatedList.length} video input device(s) available.`
      );
      if (
        selectedCameraId &&
        updatedList.length > 0 &&
        !updatedList.some((d) => d.id === selectedCameraId)
      ) {
        const fallbackCam = updatedList[0].id;
        setSelectedCameraId(fallbackCam);
        startScanner(fallbackCam);
      }
    };
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [appendDiagnosticLog, enumerateAllVideoInputs, selectedCameraId, startScanner]);

  /**
   * Handler for selecting any available camera from the Universal Camera Selection dropdown
   */
  const handleSelectCameraDevice = async (newCameraId: string, e?: React.SyntheticEvent) => {
    if (e) e.stopPropagation();
    if (!newCameraId) return;
    setSelectedCameraId(newCameraId);
    try {
      localStorage.setItem(SELECTED_CAMERA_STORAGE_KEY, newCameraId);
    } catch {}
    const camLabel =
      availableCameras.find((c) => c.id === newCameraId)?.label || newCameraId;
    appendDiagnosticLog('camera', `User selected camera: "${camLabel}" (${newCameraId})`);
    await startScanner(newCameraId);
  };

  /**
   * Direct User-Gesture Permission Request Handler
   */
  const handleGrantCameraPermission = async () => {
    setIsStarting(true);
    setCameraError(null);

    try {
      if (navigator?.mediaDevices?.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: selectedCameraId
              ? {
                  deviceId: { ideal: selectedCameraId },
                  width: { ideal: 1920 },
                  height: { ideal: 1080 },
                }
              : {
                  facingMode: { ideal: 'environment' },
                  width: { ideal: 1920 },
                  height: { ideal: 1080 },
                },
            audio: false,
          });
          stream.getTracks().forEach((track) => track.stop());
          await enumerateAllVideoInputs();
        } catch (permErr: any) {
          appendDiagnosticLog(
            'error',
            `getUserMedia permission request result: ${permErr?.name || String(permErr)}`
          );
          if (permErr?.name === 'NotAllowedError' || permErr?.name === 'SecurityError') {
            const inIframe = typeof window !== 'undefined' && window.self !== window.top;
            if (inIframe) {
              setCameraError(
                'The preview iframe has blocked continuous video streaming. Tap "Scan Barcode/QR" or "OCR Label" below to scan directly (works 100% in preview).'
              );
              setIsStarting(false);
              return;
            }
          }
        }
      }
    } catch (e: any) {
      appendDiagnosticLog('error', `Permission probe error: ${e?.message || String(e)}`);
    }

    await startScanner(selectedCameraId || undefined);
  };

  const toggleTorch = async () => {
    if (!scannerRef.current || !hasTorch) return;
    try {
      const nextTorch = !torchOn;
      const track = getActiveVideoTrack();
      if (track) {
        await track.applyConstraints({
          advanced: [{ torch: nextTorch } as any],
        });
      } else {
        await (scannerRef.current as any).applyVideoConstraints({
          advanced: [{ torch: nextTorch }],
        });
      }
      setTorchOn(nextTorch);
    } catch {
      setHasTorch(false);
    }
  };

  const flipCamera = async () => {
    if (availableCameras.length <= 1) return;
    const currentIdx = availableCameras.findIndex((c) => c.id === selectedCameraId);
    const nextIdx = (currentIdx + 1) % availableCameras.length;
    const nextCameraId = availableCameras[nextIdx].id;
    await handleSelectCameraDevice(nextCameraId);
  };

  /**
   * High-resolution image preparation with contrast & barcode enhancement
   */
  const prepareBarcodeImageVariant = (
    file: File,
    options: { maxDimension: number; cropCenter?: boolean; enhanceContrast?: boolean }
  ): Promise<{ file: File; base64: string }> => {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);

        let sx = 0;
        let sy = 0;
        let sw = img.width;
        let sh = img.height;

        if (options.cropCenter) {
          sw = Math.round(img.width * 0.65);
          sh = Math.round(img.height * 0.55);
          sx = Math.round((img.width - sw) / 2);
          sy = Math.round((img.height - sh) / 2);
        }

        let targetW = sw;
        let targetH = sh;
        if (targetW > options.maxDimension || targetH > options.maxDimension) {
          if (targetW > targetH) {
            targetH = Math.round((targetH * options.maxDimension) / targetW);
            targetW = options.maxDimension;
          } else {
            targetW = Math.round((targetW * options.maxDimension) / targetH);
            targetH = options.maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve({ file, base64: '' });
          return;
        }

        if (options.enhanceContrast) {
          ctx.filter = 'contrast(1.45) brightness(1.04) saturate(0)';
        }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
        const base64 = dataUrl.split(',')[1] || '';

        canvas.toBlob(
          (blob) => {
            if (blob) {
              const processed = new File([blob], file.name || 'barcode-snap.jpg', {
                type: 'image/jpeg',
              });
              resolve({ file: processed, base64 });
            } else {
              resolve({ file, base64 });
            }
          },
          'image/jpeg',
          0.92
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ file, base64: '' });
      };
      img.src = url;
    });
  };

  /**
   * Runs offline on-device OCR on a captured pallet label source (live <video>, File, or data URL)
   * with visible progress updates and opens the Editable Confirmation Modal.
   */
  const runOfflineOcrOnLabelSource = useCallback(
    async (source: HTMLVideoElement | File | string, cropToGuideBox: boolean) => {
      if (isProcessingOcrLabel || pendingOcrLabelRef.current !== null) return;
      setIsProcessingOcrLabel(true);
      setOcrLabelStatusMessage('Capturing & preparing label image...');
      appendDiagnosticLog('ocr', 'Starting manual OCR pallet label extraction...');

      try {
        const cropBoxRatio = cropToGuideBox
          ? { x: 0.04, y: 0.14, width: 0.92, height: 0.72 }
          : { x: 0.01, y: 0.01, width: 0.98, height: 0.98 };

        const result = await recognizePalletLabelOffline(
          source,
          deliveryRef.current?.parts || [],
          cropBoxRatio,
          (statusText) => {
            if (isMountedRef.current) {
              setOcrLabelStatusMessage(statusText);
            }
          }
        );

        if (!isMountedRef.current) return;

        appendDiagnosticLog(
          'ocr',
          `OCR extracted Part="${result.partNumber || 'none'}", Qty="${
            result.quantity ?? 'none'
          }", Desc="${result.description || 'none'}" (engine=${result.engineUsed})`
        );

        if (result.partNumber || result.rawOcrText.trim()) {
          setLiveOcrDetectedPreview(
            [
              result.partNumber ? `Part: ${result.partNumber}` : '',
              result.quantity !== null ? `Qty: ${result.quantity}` : '',
              result.description ? `Desc: ${result.description.slice(0, 28)}` : '',
            ]
              .filter(Boolean)
              .join(' · ') || `Raw OCR: "${result.rawOcrText.replace(/\s+/g, ' ').slice(0, 45)}"`
          );
        }

        pendingOcrLabelRef.current = result;
        setPendingOcrLabelResult(result);

        const evaluation = evaluatePalletLabelMatch(
          result.partNumber,
          result.quantity,
          deliveryRef.current?.parts || [],
          result.ocrConfidence
        );

        if (evaluation.matchedPart) {
          playAudio.success();
          triggerHaptic('success');
        } else {
          playAudio.duplicate();
          triggerHaptic('duplicate');
        }
      } catch (err: any) {
        appendDiagnosticLog('error', `Offline pallet label OCR error: ${err?.message || String(err)}`);
        playAudio.unexpected();
        triggerHaptic('unexpected');
        setScanFeedback({
          type: 'unexpected',
          code: 'OCR LABEL',
          message: `OCR Error: ${
            err?.message || 'Could not read pallet label text. Align label in frame and try again.'
          }`,
          timestamp: Date.now(),
        });
      } finally {
        if (isMountedRef.current) {
          setIsProcessingOcrLabel(false);
          setOcrLabelStatusMessage('');
        }
      }
    },
    [appendDiagnosticLog, isProcessingOcrLabel]
  );

  /**
   * Captures a pallet label from the live camera preview (if active) or opens the 3-option Camera/Gallery/Files selector
   */
  const handleCaptureOcrLabel = useCallback(async () => {
    if (
      pendingQuantityScanRef.current !== null ||
      pendingOcrLabelRef.current !== null ||
      isProcessingOcrLabel
    ) {
      return;
    }

    const container = document.getElementById('camera-scanner-view');
    const video = container?.querySelector('video') as HTMLVideoElement | null;
    if (isScanning && video && video.readyState >= 2 && video.videoWidth > 0) {
      await runOfflineOcrOnLabelSource(video, true);
      return;
    }

    setUploadModalIntent('ocr_label');
  }, [isProcessingOcrLabel, isScanning, runOfflineOcrOnLabelSource]);

  const handleOcrLabelFileSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (ocrLabelFileInputRef.current) {
      ocrLabelFileInputRef.current.value = '';
    }
    await runOfflineOcrOnLabelSource(file, false);
  };

  /**
   * Generates a realistic printed pallet label for a part on the active docket (with multi-pallet split support)
   * and processes it through the offline OCR pipeline.
   */
  const handleTestSampleOcrLabel = useCallback(
    async (targetPart?: DeliveryPart, customPalletQty?: number) => {
      const currentDelivery = deliveryRef.current;
      const samplePart =
        targetPart ||
        currentDelivery?.parts.find((p) => p.status === 'outstanding') ||
        currentDelivery?.parts[0];

      const partNum = samplePart?.partNumber || 'PLT-0048-A';
      const desc = samplePart?.description || 'Laser Cut Base Plate 10mm Mild Steel';
      const expectedQty = Math.max(1, samplePart?.quantity ?? 24);
      const alreadyScanned =
        samplePart?.status === 'received'
          ? Math.max(0, samplePart.receivedQuantity ?? samplePart.quantity ?? 0)
          : 0;
      const remaining = Math.max(1, expectedQty - alreadyScanned);

      const simulatedPalletQty =
        customPalletQty ??
        (alreadyScanned === 0 && expectedQty >= 4 && expectedQty % 2 === 0
          ? expectedQty / 2
          : remaining);

      const sampleDataUrl = generateSamplePalletLabelDataUrl({
        partNumber: partNum,
        description: desc,
        quantity: simulatedPalletQty,
        orderNumber: `PO-${currentDelivery?.docketNumber || '78412'}`,
        palletIndex: simulatedPalletQty < expectedQty && alreadyScanned > 0 ? 2 : 1,
        totalPallets: simulatedPalletQty < expectedQty ? 2 : 1,
      });

      await runOfflineOcrOnLabelSource(sampleDataUrl, false);
    },
    [runOfflineOcrOnLabelSource]
  );

  // Listen for simulated OCR label triggers from TestBarcodesModal (without overwriting supplier rule)
  useEffect(() => {
    const handleSimulateOcrEvent = (ev: Event) => {
      const customEv = ev as CustomEvent<{ partId?: string; palletQuantity?: number }>;
      const partId = customEv.detail?.partId;
      const palletQty = customEv.detail?.palletQuantity;
      const foundPart = deliveryRef.current?.parts.find((p) => p.id === partId);
      handleTestSampleOcrLabel(foundPart, palletQty);
    };
    window.addEventListener('parttrack_simulate_ocr_label', handleSimulateOcrEvent);
    return () =>
      window.removeEventListener('parttrack_simulate_ocr_label', handleSimulateOcrEvent);
  }, [handleTestSampleOcrLabel]);

  /**
   * Confirms a matched OCR Pallet Label scan and ADDS the pallet quantity to the existing scanned quantity
   */
  const handleConfirmOcrMatchedLabel = (params: {
    part: DeliveryPart;
    recognizedPartNumber: string;
    recognizedDescription: string;
    palletQuantity: number;
    rawOcrText: string;
  }) => {
    if (!deliveryRef.current) return;

    const {
      updatedDelivery,
      updatedPart,
      isExactQuantityMatch,
      existingScannedQty,
      addedPalletQty,
      newTotalScannedQty,
      expectedQty,
    } = confirmOcrPalletLabelScan(deliveryRef.current, params);

    pendingOcrLabelRef.current = null;
    setPendingOcrLabelResult(null);
    lastScannedTimeRef.current = Date.now();

    onUpdateDeliveryRef.current(updatedDelivery);

    const docketNoStr = formatDocketNoBadge(updatedPart);

    setJustScannedPartId(updatedPart.id);
    if (justScannedTimeoutRef.current) clearTimeout(justScannedTimeoutRef.current);
    justScannedTimeoutRef.current = setTimeout(() => {
      setJustScannedPartId(null);
    }, 6000);
    partsListScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });

    if (isExactQuantityMatch) {
      triggerVisualFlash('green');
      playAudio.success();
      triggerHaptic('success');
      speakAlert(
        `Matched ${updatedPart.partNumber}, total ${newTotalScannedQty} of ${expectedQty}`
      );
      setScanFeedback({
        type: 'success',
        code: params.recognizedPartNumber,
        matchedPart: updatedPart,
        message:
          existingScannedQty > 0
            ? `OCR Label +${addedPalletQty} (Prior ${existingScannedQty}) → Total ${newTotalScannedQty}/${expectedQty} Matched`
            : `OCR Label Verified No. ${docketNoStr} (${updatedPart.partNumber}) · Total ${newTotalScannedQty}/${expectedQty}`,
        timestamp: Date.now(),
      });
    } else {
      triggerVisualFlash('orange');
      playAudio.duplicate();
      triggerHaptic('duplicate');
      speakAlert(
        `Added ${addedPalletQty} for ${updatedPart.partNumber}. Total ${newTotalScannedQty} of ${expectedQty}`
      );
      setScanFeedback({
        type: 'quantity_mismatch',
        code: params.recognizedPartNumber,
        matchedPart: updatedPart,
        message: `OCR Label +${addedPalletQty} → Total Scanned: ${newTotalScannedQty}/${expectedQty} (${
          newTotalScannedQty < expectedQty
            ? `${expectedQty - newTotalScannedQty} remaining`
            : `${newTotalScannedQty - expectedQty} over`
        })`,
        timestamp: Date.now(),
      });
    }

    if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
    feedbackTimeoutRef.current = setTimeout(() => {
      setScanFeedback(null);
    }, 8000);
  };

  /**
   * Records an unmatched OCR Pallet Label as an unexpected part (RED indicator)
   */
  const handleRecordUnexpectedOcrLabel = (params: {
    recognizedPartNumber: string;
    recognizedDescription: string;
    palletQuantity: number;
    rawOcrText: string;
  }) => {
    if (!deliveryRef.current) return;

    const updatedDelivery = recordUnmatchedOcrPalletLabel(deliveryRef.current, params);

    pendingOcrLabelRef.current = null;
    setPendingOcrLabelResult(null);
    lastScannedTimeRef.current = Date.now();

    onUpdateDeliveryRef.current(updatedDelivery);

    triggerVisualFlash('red');
    playAudio.unexpected();
    triggerHaptic('unexpected');
    speakAlert('Unmatched pallet label recorded');

    setScanFeedback({
      type: 'unexpected',
      code: params.recognizedPartNumber,
      message: `Unmatched OCR Label "${params.recognizedPartNumber}" (Qty ${params.palletQuantity}) recorded for manual review`,
      timestamp: Date.now(),
    });

    if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
    feedbackTimeoutRef.current = setTimeout(() => {
      setScanFeedback(null);
    }, 8000);
  };

  const handleSnapPhoto = () => {
    if (pendingQuantityScanRef.current !== null || pendingOcrLabelRef.current !== null) return;
    setUploadModalIntent('snap');
  };

  const handleStageScannerUploadFile = (
    files: FileList | null,
    sourceLabel: 'Camera' | 'Gallery' | 'Files'
  ) => {
    if (!files || files.length === 0) return;
    const added = Array.from(files).map((file, idx) => {
      const isPreviewableImage = file.type.startsWith('image/');
      const previewUrl = isPreviewableImage ? URL.createObjectURL(file) : '';
      return {
        id: `staged_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
        file,
        previewUrl,
        sourceLabel,
      };
    });
    setStagedScannerFiles((prev) => [...prev, ...added]);

    if (scannerCameraInputRef.current) scannerCameraInputRef.current.value = '';
    if (scannerGalleryInputRef.current) scannerGalleryInputRef.current.value = '';
    if (scannerFilesInputRef.current) scannerFilesInputRef.current.value = '';
  };

  const handleCloseScannerUploadModal = () => {
    stagedScannerFiles.forEach((item) => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
    setStagedScannerFiles([]);
    setUploadModalIntent(null);
  };

  const handleConfirmStagedScannerFile = async () => {
    if (stagedScannerFiles.length === 0) return;
    const filesToProcess = stagedScannerFiles.map((item) => item.file);
    const intent = uploadModalIntent || 'snap';
    handleCloseScannerUploadModal();

    for (const fileToProcess of filesToProcess) {
      if (intent === 'ocr_label') {
        await runOfflineOcrOnLabelSource(fileToProcess, false);
      } else {
        const dt = new DataTransfer();
        dt.items.add(fileToProcess);
        await handleSnapFile(dt.files);
      }
    }
  };

  /**
   * Multi-Pass Photo Barcode, QR & Offline OCR Label Decoder
   */
  const handleSnapFile = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const originalFile = files[0];
    setIsSnappingPhoto(true);

    try {
      let decodedText = '';

      const BarcodeDetectorAPI = (window as any).BarcodeDetector;
      if (BarcodeDetectorAPI && typeof createImageBitmap === 'function') {
        try {
          const detector = new BarcodeDetectorAPI();
          const bitmap = await createImageBitmap(originalFile);
          const barcodes = await detector.detect(bitmap);
          bitmap.close?.();
          if (barcodes && barcodes.length > 0) {
            const rule = activeSupplierRuleRef.current;
            let chosen = barcodes[0];
            if (rule.id === 'gci') {
              const qrCandidate = barcodes.find(
                (b: any) => b.format === 'qr_code' || b.format === 'data_matrix'
              );
              if (qrCandidate) chosen = qrCandidate;
            } else {
              const hyphenMatch = barcodes.find(
                (b: any) =>
                  b.rawValue && parseBarcodeDocketNo(String(b.rawValue)).hasDashFormat
              );
              if (hyphenMatch) chosen = hyphenMatch;
            }
            if (chosen?.rawValue) {
              decodedText = String(chosen.rawValue).trim();
            }
          }
        } catch {}
      }

      const highResVariant = await prepareBarcodeImageVariant(originalFile, {
        maxDimension: 2200,
        enhanceContrast: true,
      });

      if (!decodedText) {
        let offscreenScanner = offscreenScannerRef.current;
        if (!offscreenScanner) {
          offscreenScanner = new Html5Qrcode('parttrack-offscreen-scanner', {
            formatsToSupport: [
              Html5QrcodeSupportedFormats.CODE_128,
              Html5QrcodeSupportedFormats.CODE_39,
              Html5QrcodeSupportedFormats.CODE_93,
              Html5QrcodeSupportedFormats.ITF,
              Html5QrcodeSupportedFormats.EAN_13,
              Html5QrcodeSupportedFormats.EAN_8,
              Html5QrcodeSupportedFormats.UPC_A,
              Html5QrcodeSupportedFormats.UPC_E,
              Html5QrcodeSupportedFormats.QR_CODE,
              Html5QrcodeSupportedFormats.DATA_MATRIX,
            ],
            experimentalFeatures: {
              useBarCodeDetectorIfSupported: true,
            },
            verbose: false,
          });
          offscreenScannerRef.current = offscreenScanner;
        }

        try {
          decodedText = await offscreenScanner.scanFile(highResVariant.file, false);
        } catch {
          try {
            const centerCropVariant = await prepareBarcodeImageVariant(originalFile, {
              maxDimension: 1800,
              cropCenter: true,
              enhanceContrast: true,
            });
            decodedText = await offscreenScanner.scanFile(centerCropVariant.file, false);
          } catch {
            try {
              decodedText = await offscreenScanner.scanFile(originalFile, false);
            } catch {}
          }
        }
      }

      if (decodedText) {
        handleScannedCode(decodedText, 'photo_snap');
        return;
      }

      // If no 1D barcode or 2D QR code was found in the snapped photo, automatically fall back
      // to on-device Pallet Label OCR so printed labels scanned via "Snap" are also recognized!
      appendDiagnosticLog(
        'ocr',
        'No barcode/QR found in photo snap; falling back to offline Pallet Label OCR...'
      );
      await runOfflineOcrOnLabelSource(originalFile, false);
    } catch (err: any) {
      appendDiagnosticLog('error', `Snapshot decode error: ${err?.message || String(err)}`);
      playAudio.unexpected();
      speakAlert('Could not read code in photo');
      setScanFeedback({
        type: 'unexpected',
        code: 'PHOTO SCAN',
        message:
          'Could not detect code. Hold ~20cm away so the label is in sharp focus and try again.',
        timestamp: Date.now(),
      });
    } finally {
      setIsSnappingPhoto(false);
      if (snapFileInputRef.current) {
        snapFileInputRef.current.value = '';
      }
    }
  };

  const handleUndo = () => {
    const currentDelivery = deliveryRef.current;
    if (!currentDelivery) return;
    const updated = undoLastScan(currentDelivery);
    onUpdateDeliveryRef.current(updated);
    playAudio.undo();
    triggerHaptic('undo');
    setScanFeedback(null);
    setJustScannedPartId(null);
  };

  /**
   * Handle user clicking an item or tick button in the side list
   */
  const handleRequestTick = (part: DeliveryPart, e: React.MouseEvent) => {
    e.stopPropagation();
    if (pendingQuantityScanRef.current !== null) return;
    const vState = getPartVerificationState(part);
    setConfirmTickPart(part);
    setManualTickQtyInput(
      String(part.status === 'received' ? vState.receivedQty : vState.requiredQty)
    );
  };

  /**
   * Execute manual verification or quantity edit after user confirms in the prompt
   */
  const handleConfirmManualTick = (forceTargetStatus?: 'received' | 'outstanding') => {
    if (!confirmTickPart || !delivery) return;

    const requiredQty = Math.max(1, confirmTickPart.quantity ?? 1);
    const newStatus =
      forceTargetStatus ??
      (requiredQty > 1
        ? 'received'
        : confirmTickPart.status === 'received'
        ? 'outstanding'
        : 'received');

    const parsedInput = parseInt(manualTickQtyInput, 10);
    const enteredManualQty =
      newStatus === 'received' && requiredQty > 1
        ? !Number.isNaN(parsedInput) && parsedInput >= 0
          ? parsedInput
          : requiredQty
        : requiredQty;

    const updated = setPartStatus(
      delivery.id,
      confirmTickPart.id,
      newStatus,
      'manual',
      undefined,
      newStatus === 'received' ? enteredManualQty : undefined
    );

    if (newStatus === 'received') {
      const docketNoStr = formatDocketNoBadge(confirmTickPart);
      const isQtyMatch = enteredManualQty === requiredQty;
      triggerVisualFlash(isQtyMatch ? 'green' : 'orange');
      if (isQtyMatch) {
        playAudio.success();
        triggerHaptic('success');
      } else {
        playAudio.duplicate();
        triggerHaptic('duplicate');
      }
      speakAlert(`Verified Number ${docketNoStr}, ${confirmTickPart.partNumber}`);

      setJustScannedPartId(confirmTickPart.id);
      if (justScannedTimeoutRef.current) clearTimeout(justScannedTimeoutRef.current);
      justScannedTimeoutRef.current = setTimeout(() => {
        setJustScannedPartId(null);
      }, 6000);

      partsListScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });

      setScanFeedback({
        type: isQtyMatch ? 'success' : 'quantity_mismatch',
        code: confirmTickPart.partNumber,
        matchedPart: {
          ...confirmTickPart,
          status: 'received',
          receivedQuantity: enteredManualQty,
          verificationStatus: isQtyMatch ? 'verified' : 'quantity_mismatch',
        },
        message: isQtyMatch
          ? `Verified No. ${docketNoStr} (${confirmTickPart.partNumber}) · Qty ${enteredManualQty}/${requiredQty}`
          : `Qty Mismatch No. ${docketNoStr} (${confirmTickPart.partNumber}) · Entered ${enteredManualQty} of ${requiredQty}`,
        timestamp: Date.now(),
      });
    } else {
      playAudio.undo();
      triggerHaptic('undo');
      if (justScannedPartId === confirmTickPart.id) {
        setJustScannedPartId(null);
      }
      setScanFeedback(null);
    }

    if (updated) {
      onUpdateDelivery(updated);
    }
    setConfirmTickPart(null);
  };

  // Filtered and sorted parts for the side docket window
  const displayedDocketParts = useMemo(() => {
    if (!delivery?.parts) return [];
    const q = sideListSearch.trim().toLowerCase();

    const list = delivery.parts.filter((p, idx) => {
      if (sideListFilter === 'outstanding' && p.status !== 'outstanding') return false;
      if (sideListFilter === 'received' && p.status !== 'received') return false;
      if (!q) return true;
      const cleanNo = formatDocketNoBadge(p, idx).toLowerCase();
      return (
        p.partNumber.toLowerCase().includes(q) ||
        p.itemNumber.toLowerCase().includes(q) ||
        cleanNo === q ||
        `no.${cleanNo}`.includes(q) ||
        p.description.toLowerCase().includes(q)
      );
    });

    if (justScannedPartId) {
      const justScanned = delivery.parts.find((p) => p.id === justScannedPartId);
      if (justScanned) {
        const remaining = list.filter((p) => p.id !== justScannedPartId);
        return [justScanned, ...remaining];
      }
    }

    return list;
  }, [delivery?.parts, sideListSearch, sideListFilter, justScannedPartId]);

  useEffect(() => {
    isMountedRef.current = true;
    startScanner();

    return () => {
      isMountedRef.current = false;
      if (nativeDetectorIntervalRef.current) {
        clearInterval(nativeDetectorIntervalRef.current);
        nativeDetectorIntervalRef.current = null;
      }
      if (liveOcrIntervalRef.current) {
        clearInterval(liveOcrIntervalRef.current);
        liveOcrIntervalRef.current = null;
      }
      if (scannerRef.current) {
        try {
          if (scannerRef.current.isScanning) {
            scannerRef.current.stop().catch(() => {});
          }
          scannerRef.current.clear();
        } catch {}
      }
      if (offscreenScannerRef.current) {
        try {
          offscreenScannerRef.current.clear();
        } catch {}
      }
      if (justScannedTimeoutRef.current) {
        clearTimeout(justScannedTimeoutRef.current);
      }
      if (focusRingTimeoutRef.current) {
        clearTimeout(focusRingTimeoutRef.current);
      }
      if (externalHidBannerTimeoutRef.current) {
        clearTimeout(externalHidBannerTimeoutRef.current);
      }
    };
  }, []);

  const outstandingSample = delivery?.parts.find((p) => p.status === 'outstanding');
  const latestHistoricalScan = delivery?.scanHistory?.[0];

  // Apply CSS digital zoom fallback only if the device camera doesn't expose hardware zoom
  const cssZoomStyle =
    !supportsHardwareZoom && zoomLevel > 1
      ? { transform: `scale(${zoomLevel})`, transformOrigin: 'center center' }
      : undefined;

  return (
    <div
      className={`fixed inset-x-0 top-11 bottom-12 z-20 bg-[#0F0F0E] overflow-hidden select-none flex ${
        scannerLayout === 'below-camera' ? 'flex-col' : 'flex-row'
      }`}
    >
      {/* Hidden native snapshot camera input for direct barcode photo fallback */}
      <input
        ref={snapFileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => handleSnapFile(e.target.files)}
      />

      {/* Hidden camera/file input for OCR Pallet Label photo capture */}
      <input
        ref={ocrLabelFileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => handleOcrLabelFileSelected(e.target.files)}
      />

      {/* 1. CAMERA: Dedicated rear camera capture input */}
      <input
        id="scanner-upload-camera-input"
        ref={scannerCameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={(e) => handleStageScannerUploadFile(e.target.files, 'Camera')}
      />

      {/* 2. GALLERY: Dedicated Android/iOS native Photo Picker input (pure accept="image/*" + multiple, no capture attribute) */}
      <input
        id="scanner-upload-gallery-input"
        ref={scannerGalleryInputRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        onChange={(e) => handleStageScannerUploadFile(e.target.files, 'Gallery')}
      />

      {/* 3. FILES: General device file system picker for PDFs, images & supported documents */}
      <input
        id="scanner-upload-files-input"
        ref={scannerFilesInputRef}
        type="file"
        accept=".pdf,application/pdf,image/*,*/*"
        multiple
        className="sr-only"
        onChange={(e) => handleStageScannerUploadFile(e.target.files, 'Files')}
      />

      {/* Dedicated hidden offscreen container for static image barcode decoding */}
      <div id="parttrack-offscreen-scanner" className="hidden" aria-hidden="true" />

      {/* ============================================================ */}
      {/* SECTION 1: Camera Viewport with HUD, Zoom & Flash Feedback    */}
      {/* ============================================================ */}
      <div
        className={`relative flex flex-col bg-black overflow-hidden min-h-0 min-w-0 transition-all duration-200 ${
          scannerLayout === 'below-camera'
            ? 'w-full h-[46%] sm:h-[48%] md:h-[52%] shrink-0 min-h-[210px]'
            : 'h-full flex-1'
        }`}
      >
        {/* Inner Camera Stage (Tap anywhere to refocus, Pinch to zoom!) */}
        <div
          onClick={handleTapToFocus}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          className="relative flex-1 min-h-0 w-full overflow-hidden bg-black cursor-crosshair touch-none flex items-center justify-center"
        >
          <div
            id="camera-scanner-view"
            style={cssZoomStyle}
            className="w-full h-full transform-gpu transition-transform duration-150 [&_video]:!w-full [&_video]:!h-full [&_video]:!object-contain sm:[&_video]:!object-cover [&_[id$='__scan_region']_img]:hidden [&_[id='qr-shaded-region']]:hidden"
          />

          {/* Tap-to-Focus Visual Ring Indicator */}
          {focusRingPos && (
            <div
              style={{ left: focusRingPos.x - 24, top: focusRingPos.y - 24 }}
              className="pointer-events-none absolute z-30 w-12 h-12 rounded-full border-2 border-emerald-400 bg-emerald-400/10 flex items-center justify-center animate-ping"
            >
              <div className="w-2 h-2 rounded-full bg-emerald-400" />
            </div>
          )}

          {/* Instant Full-Frame Visual Recognition Flash */}
          {flashColor && (
            <div
              className={`pointer-events-none absolute inset-0 z-20 border-[6px] transition-all duration-150 ${
                flashColor === 'green'
                  ? 'border-[#10B981] bg-[#10B981]/25 shadow-[inset_0_0_80px_rgba(16,185,129,0.45)]'
                  : flashColor === 'orange'
                  ? 'border-amber-500 bg-amber-500/20 shadow-[inset_0_0_80px_rgba(245,158,11,0.4)]'
                  : 'border-red-500 bg-red-500/20 shadow-[inset_0_0_80px_rgba(239,68,68,0.4)]'
              }`}
            />
          )}

          {/* Green Burst Checkmark Badge on Camera Viewport when scanned */}
          {flashColor === 'green' && (
            <div className="pointer-events-none absolute inset-0 z-25 flex items-center justify-center animate-in zoom-in-75 duration-150">
              <div className="relative flex items-center justify-center">
                <div className="w-20 h-20 rounded-full bg-[#10B981]/30 border-2 border-[#10B981] animate-ping" />
                <div className="absolute w-14 h-14 rounded-full bg-[#10B981] text-white flex items-center justify-center shadow-2xl shadow-emerald-500/90">
                  <Check className="w-8 h-8 stroke-[3]" />
                </div>
              </div>
            </div>
          )}

          {/* External USB / Bluetooth HID Scanner Submission Toast Banner */}
          {lastExternalScannerEvent && (
            <div className="pointer-events-none absolute top-24 inset-x-3 z-45 flex justify-center animate-in fade-in slide-in-from-top-2 duration-150">
              <div className="px-3 py-1.5 rounded-[5px] bg-emerald-950/95 border border-emerald-400 text-emerald-200 font-mono text-xs font-bold shadow-xl flex items-center gap-2">
                <Usb className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>External Scanner Submitted: {lastExternalScannerEvent.code}</span>
              </div>
            </div>
          )}

          {/* Top Translucent HUD: Progress + Action Buttons + Universal Camera Dropdown + Supplier + Layout Toggle */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute top-0 inset-x-0 z-40 px-2.5 py-2 bg-gradient-to-b from-black/95 via-black/80 to-transparent flex flex-col gap-1.5"
          >
            {/* Row 1: Progress + USB/BT HID Ready Badge + Camera Action Controls */}
            <div className="flex items-center justify-between gap-1.5 flex-wrap">
              {/* Progress Counter + Resolution & HID Indicator */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {delivery ? (
                  <>
                    <span className="font-mono text-xs font-bold text-white tabular-nums">
                      {receivedParts}/{totalParts}
                    </span>
                    <div className="hidden sm:block w-10 h-1 bg-white/20 overflow-hidden rounded-full">
                      <div
                        className="h-full bg-[#10B981] transition-all duration-300"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                    <span className="font-mono text-[11px] font-medium text-[#10B981] tabular-nums">
                      {percentage}%
                    </span>
                  </>
                ) : (
                  <span className="font-mono text-xs text-white/70">No docket</span>
                )}

                <span
                  className="px-1.5 py-0.5 rounded-[3px] bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-mono text-[9px] font-semibold inline-flex items-center gap-1"
                  title="USB & Bluetooth HID Barcode Scanners active (Enter/Tab suffix or rapid burst)"
                >
                  <Usb className="w-2.5 h-2.5 text-emerald-400" />
                  <span className="hidden md:inline">USB/BT HID</span>
                </span>

                {actualCameraInfo && (
                  <span
                    className="hidden lg:inline-flex px-1.5 py-0.5 rounded-[3px] bg-white/10 text-zinc-300 font-mono text-[9px]"
                    title={`Active camera resolution: ${actualCameraInfo.width}x${actualCameraInfo.height}`}
                  >
                    {actualCameraInfo.width}×{actualCameraInfo.height}
                  </span>
                )}
              </div>

              {/* Camera Action Controls (Snap Barcode/QR + Independent OCR Label + Utilities) */}
              <div className="flex items-center gap-1 flex-wrap justify-end">
                <button
                  onClick={handleSnapPhoto}
                  disabled={
                    isSnappingPhoto ||
                    isProcessingOcrLabel ||
                    pendingQuantityScan !== null ||
                    pendingOcrLabelResult !== null
                  }
                  className="h-7 px-2 rounded-[3px] bg-[#059669] hover:bg-[#047857] disabled:opacity-50 text-white text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition-colors shadow-sm"
                  title="Photograph part barcode or QR code with camera"
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">
                    {isSnappingPhoto ? 'Decoding...' : 'Snap'}
                  </span>
                </button>

                <button
                  onClick={handleCaptureOcrLabel}
                  disabled={
                    isProcessingOcrLabel ||
                    isSnappingPhoto ||
                    pendingQuantityScan !== null ||
                    pendingOcrLabelResult !== null
                  }
                  className="h-7 px-2 rounded-[3px] bg-amber-500/25 hover:bg-amber-500/35 border border-amber-400/50 disabled:opacity-50 text-amber-200 text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition-colors shadow-sm"
                  title="Read printed pallet label text using offline on-device OCR (uses live camera stream)"
                >
                  <FileText className="w-3.5 h-3.5 text-amber-300" />
                  <span>{isProcessingOcrLabel ? 'OCR...' : 'OCR Label'}</span>
                </button>

                <button
                  onClick={onOpenTestSheet}
                  className="h-7 px-2 rounded-[3px] bg-white/15 hover:bg-white/25 backdrop-blur-md text-white text-[11px] font-medium flex items-center gap-1 cursor-pointer transition-colors"
                  title="Test codes"
                >
                  <QrCode className="w-3 h-3 text-[#10B981]" />
                  <span className="hidden lg:inline">Test</span>
                </button>

                <button
                  onClick={() => setIsManualModalOpen(true)}
                  disabled={pendingQuantityScan !== null}
                  className="h-7 px-2 rounded-[3px] bg-white/15 hover:bg-white/25 disabled:opacity-50 backdrop-blur-md text-white text-[11px] font-medium flex items-center gap-1 cursor-pointer transition-colors"
                  title="Enter barcode or QR code manually"
                >
                  <Keyboard className="w-3 h-3" />
                </button>

                {delivery && (
                  <button
                    onClick={() => exportDeliveryPdf(delivery)}
                    className="h-7 px-2 rounded-[3px] bg-white/15 hover:bg-white/25 backdrop-blur-md text-white text-[11px] font-medium flex items-center gap-1 cursor-pointer transition-colors"
                    title="Export colour-coded PDF"
                  >
                    <Printer className="w-3 h-3 text-[#10B981]" />
                    <span className="hidden sm:inline">PDF</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setIsDiagnosticsOpen((prev) => !prev)}
                  className={`w-7 h-7 rounded-[3px] flex items-center justify-center backdrop-blur-md cursor-pointer transition-colors ${
                    isDiagnosticsOpen
                      ? 'bg-emerald-600 text-white'
                      : 'bg-white/15 text-zinc-200 hover:bg-white/25'
                  }`}
                  title="Scanner Diagnostics & Status Log"
                >
                  <Activity className="w-3.5 h-3.5" />
                </button>

                {hasTorch && (
                  <button
                    onClick={toggleTorch}
                    className={`w-7 h-7 rounded-[3px] flex items-center justify-center backdrop-blur-md cursor-pointer transition-colors ${
                      torchOn ? 'bg-amber-400 text-black' : 'bg-white/15 text-white hover:bg-white/25'
                    }`}
                    title="Torch"
                  >
                    <Flashlight className="w-3.5 h-3.5" />
                  </button>
                )}

                {availableCameras.length > 1 && (
                  <button
                    onClick={flipCamera}
                    className="w-7 h-7 rounded-[3px] bg-white/15 hover:bg-white/25 text-white flex items-center justify-center backdrop-blur-md cursor-pointer transition-colors"
                    title="Cycle camera lens"
                  >
                    <FlipHorizontal className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Row 2: Universal Camera Selection Dropdown + Supplier Selector + Layout Toggle */}
            <div className="flex items-center justify-between gap-1.5 flex-wrap bg-black/80 backdrop-blur-md border border-white/15 rounded-[4px] px-2 py-1">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                {/* Universal Camera Dropdown */}
                <div className="flex items-center gap-1 min-w-0">
                  <Camera className="w-3 h-3 text-emerald-400 shrink-0" />
                  <label htmlFor="scanner-hud-camera-select" className="sr-only">
                    Camera Device
                  </label>
                  <select
                    id="scanner-hud-camera-select"
                    aria-label="Camera Device"
                    value={selectedCameraId}
                    onChange={(e) => handleSelectCameraDevice(e.target.value, e)}
                    className="h-6 max-w-[135px] sm:max-w-[175px] px-1.5 rounded-[3px] bg-[#18181B] border border-zinc-700 focus:border-[#10B981] text-white font-mono text-[10px] font-semibold outline-none cursor-pointer truncate"
                    title="Select any available camera (front, rear, wide, telephoto, USB webcam)"
                  >
                    {availableCameras.length === 0 ? (
                      <option value="" className="bg-[#18181B] text-zinc-300">
                        Default Camera
                      </option>
                    ) : (
                      availableCameras.map((cam, idx) => (
                        <option
                          key={cam.id}
                          value={cam.id}
                          className="bg-[#18181B] text-white"
                        >
                          {cam.label || `Camera ${idx + 1}`}
                        </option>
                      ))
                    )}
                  </select>
                </div>

                {/* Supplier / Scan Mode Dropdown */}
                <div className="flex items-center gap-1 min-w-0">
                  <label
                    htmlFor="scanner-hud-supplier-select"
                    className="text-[9px] font-mono uppercase tracking-wider text-zinc-400 shrink-0 hidden sm:inline"
                  >
                    Mode:
                  </label>
                  <select
                    id="scanner-hud-supplier-select"
                    aria-label="Supplier Scan Mode"
                    value={activeSupplierRule.id}
                    onChange={(e) => handleSelectSupplier(e.target.value as SupplierRuleId, e)}
                    className="h-6 px-1.5 rounded-[3px] bg-[#18181B] border border-zinc-700 focus:border-[#10B981] text-white font-mono text-[10px] font-semibold outline-none cursor-pointer"
                  >
                    <option value="laser_central" className="bg-[#18181B] text-white">
                      Laser Central
                    </option>
                    <option value="gci" className="bg-[#18181B] text-white">
                      GCI
                    </option>
                    <option value="ocr_label" className="bg-[#18181B] text-white">
                      OCR Label Scanner
                    </option>
                  </select>
                </div>
              </div>

              {/* Persisted Scanner Layout Switcher: Option A (Side-by-Side) vs Option B (Below Camera) */}
              <div
                role="group"
                aria-label="Scanner Layout Options"
                className="flex items-center bg-[#18181B] rounded-[3px] p-0.5 border border-zinc-700 shrink-0"
              >
                <button
                  type="button"
                  onClick={(e) => handleSelectScannerLayout('side-by-side', e)}
                  className={`h-5 px-1.5 rounded-[2px] text-[10px] font-mono flex items-center gap-1 cursor-pointer transition-colors ${
                    scannerLayout === 'side-by-side'
                      ? 'bg-[#059669] text-white font-bold shadow-xs'
                      : 'text-zinc-300 hover:text-white'
                  }`}
                  title="Option A: Side-by-Side (Camera on left, Parts list on right)"
                >
                  <Columns2 className="w-3 h-3" />
                  <span>Side-by-Side</span>
                </button>
                <button
                  type="button"
                  onClick={(e) => handleSelectScannerLayout('below-camera', e)}
                  className={`h-5 px-1.5 rounded-[2px] text-[10px] font-mono flex items-center gap-1 cursor-pointer transition-colors ${
                    scannerLayout === 'below-camera'
                      ? 'bg-[#059669] text-white font-bold shadow-xs'
                      : 'text-zinc-300 hover:text-white'
                  }`}
                  title="Option B: Below Camera (Camera at top, Scrollable parts list directly underneath)"
                >
                  <Rows2 className="w-3 h-3" />
                  <span>Below Camera</span>
                </button>
              </div>
            </div>
          </div>

          {/* Diagnostics Overlay Drawer (When toggled open via Activity icon) */}
          {isDiagnosticsOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute top-20 right-2.5 left-2.5 sm:left-auto sm:w-96 max-h-[68%] z-45 bg-[#141413]/95 backdrop-blur-md border border-zinc-700 rounded-[6px] shadow-2xl flex flex-col overflow-hidden text-left"
            >
              <div className="px-3 py-2 border-b border-zinc-800 flex items-center justify-between bg-[#18181B]">
                <div className="flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="font-mono text-[11px] font-bold text-white uppercase tracking-wider">
                    Scanner Diagnostics
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setIsDiagnosticsOpen(false)}
                  className="p-0.5 text-zinc-400 hover:text-white cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="p-2.5 border-b border-zinc-800/80 bg-black/40 font-mono text-[10px] text-zinc-300 space-y-1">
                <div>
                  <span className="text-zinc-500">Cameras discovered:</span>{' '}
                  <span className="text-white font-semibold">{availableCameras.length}</span>
                </div>
                <div>
                  <span className="text-zinc-500">Selected deviceId:</span>{' '}
                  <span className="text-emerald-400">
                    {selectedCameraId ? `${selectedCameraId.slice(0, 18)}...` : 'auto'}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500">Granted Resolution:</span>{' '}
                  <span className="text-white font-semibold">
                    {actualCameraInfo
                      ? `${actualCameraInfo.width}×${actualCameraInfo.height}${
                          actualCameraInfo.frameRate ? ` @ ${actualCameraInfo.frameRate}fps` : ''
                        } (${actualCameraInfo.focusMode || 'auto'})`
                      : 'Awaiting live stream'}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500">Engines Active:</span>{' '}
                  <span className="text-emerald-300">
                    1D Barcode + 2D QR + Offline OCR + USB/BT HID
                  </span>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-1 font-mono text-[10px]">
                {diagnosticLogs.length === 0 ? (
                  <p className="text-zinc-500 text-center py-3">No diagnostic events logged yet.</p>
                ) : (
                  diagnosticLogs.map((log) => (
                    <div
                      key={log.id}
                      className={`px-1.5 py-1 rounded-[3px] border ${
                        log.category === 'error'
                          ? 'bg-red-950/40 border-red-800/50 text-red-300'
                          : log.category === 'external_hid'
                          ? 'bg-emerald-950/40 border-emerald-800/50 text-emerald-300'
                          : log.category === 'ocr'
                          ? 'bg-amber-950/30 border-amber-800/40 text-amber-200'
                          : 'bg-zinc-900/80 border-zinc-800 text-zinc-300'
                      }`}
                    >
                      <span className="text-zinc-500 mr-1.5">{log.timestamp}</span>
                      <span className="uppercase font-bold mr-1">[{log.category}]</span>
                      <span>{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Dynamic Targeting Reticle (1D Barcode for Laser Central, 2D QR for GCI, Physical Pallet Label Frame for OCR Label Scanner) */}
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center p-2.5">
            <div
              className={`relative transition-all duration-200 ${
                activeSupplierRule.id === 'gci'
                  ? 'w-[74%] max-w-[190px] aspect-square max-h-[175px]'
                  : activeSupplierRule.id === 'ocr_label'
                  ? 'w-[90%] max-w-[330px] h-[160px] sm:h-[180px] bg-black/15 border border-emerald-400/35 rounded-[6px]'
                  : 'w-[92%] max-w-[260px] h-[115px]'
              } ${flashColor === 'green' ? 'scale-[1.03]' : ''}`}
            >
              {/* 4 Crisp Corner Brackets */}
              <div
                className={`absolute top-0 left-0 w-5 h-5 border-t-2 border-l-2 ${
                  flashColor === 'green'
                    ? 'border-[#10B981]'
                    : flashColor === 'orange'
                    ? 'border-amber-400'
                    : flashColor === 'red'
                    ? 'border-red-500'
                    : 'border-[#10B981]'
                }`}
              />
              <div
                className={`absolute top-0 right-0 w-5 h-5 border-t-2 border-r-2 ${
                  flashColor === 'green'
                    ? 'border-[#10B981]'
                    : flashColor === 'orange'
                    ? 'border-amber-400'
                    : flashColor === 'red'
                    ? 'border-red-500'
                    : 'border-[#10B981]'
                }`}
              />
              <div
                className={`absolute bottom-0 left-0 w-5 h-5 border-b-2 border-l-2 ${
                  flashColor === 'green'
                    ? 'border-[#10B981]'
                    : flashColor === 'orange'
                    ? 'border-amber-400'
                    : flashColor === 'red'
                    ? 'border-red-500'
                    : 'border-[#10B981]'
                }`}
              />
              <div
                className={`absolute bottom-0 right-0 w-5 h-5 border-b-2 border-r-2 ${
                  flashColor === 'green'
                    ? 'border-[#10B981]'
                    : flashColor === 'orange'
                    ? 'border-amber-400'
                    : flashColor === 'red'
                    ? 'border-red-500'
                    : 'border-[#10B981]'
                }`}
              />

              {activeSupplierRule.id === 'ocr_label' ? (
                /* Pallet Label Guide Frame Overlay with field alignment hints & live OCR status */
                <div className="absolute inset-2 flex flex-col justify-between text-left pointer-events-none">
                  <div className="flex items-center justify-between text-[9px] font-mono uppercase tracking-wider text-emerald-300/90 bg-black/55 px-1.5 py-0.5 rounded-[3px] w-fit">
                    <span>Align Pallet Label Inside Frame</span>
                  </div>
                  {liveOcrDetectedPreview && (
                    <div className="px-2 py-0.5 rounded-[3px] bg-black/75 border border-amber-400/40 text-amber-200 font-mono text-[9px] truncate">
                      {liveOcrDetectedPreview}
                    </div>
                  )}
                  <div className="grid grid-cols-3 gap-1 text-[9px] font-mono text-zinc-300/85 bg-black/55 px-2 py-1 rounded-[3px] border border-white/10">
                    <span className="truncate">1. PART NO</span>
                    <span className="truncate text-center">2. DESCRIPTION</span>
                    <span className="truncate text-right">3. QUANTITY</span>
                  </div>
                </div>
              ) : (
                /* Center laser guide line for 1D Barcode & 2D QR */
                <div
                  className={`absolute inset-x-3 top-1/2 -translate-y-1/2 h-[1.5px] transition-colors ${
                    flashColor === 'green'
                      ? 'bg-[#10B981] shadow-[0_0_12px_#10B981]'
                      : flashColor === 'orange'
                      ? 'bg-amber-400 shadow-[0_0_12px_#f59e0b]'
                      : flashColor === 'red'
                      ? 'bg-red-500 shadow-[0_0_12px_#ef4444]'
                      : 'bg-[#10B981]/75 shadow-[0_0_8px_#10B981]'
                  }`}
                />
              )}
            </div>

            {/* Interactive OCR Label Capture & Sample Test Bar when in OCR Label Scanner mode */}
            {isScanning && activeSupplierRule.id === 'ocr_label' && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="pointer-events-auto mt-2 flex items-center gap-1.5 flex-wrap justify-center"
              >
                <button
                  type="button"
                  onClick={handleCaptureOcrLabel}
                  disabled={isProcessingOcrLabel || pendingOcrLabelResult !== null}
                  className="h-8 px-3 rounded-[4px] bg-[#059669] hover:bg-[#047857] disabled:opacity-50 text-white font-semibold text-xs flex items-center gap-1.5 cursor-pointer shadow-lg border border-emerald-400/40 transition-colors"
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span>
                    {isProcessingOcrLabel
                      ? ocrLabelStatusMessage || 'Reading Label...'
                      : 'Capture Label (OCR)'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => handleTestSampleOcrLabel()}
                  disabled={isProcessingOcrLabel || pendingOcrLabelResult !== null}
                  className="h-8 px-2.5 rounded-[4px] bg-black/80 hover:bg-black/95 border border-amber-400/50 text-amber-300 font-mono text-[11px] font-semibold flex items-center gap-1 cursor-pointer shadow-lg transition-colors"
                  title="Simulate scanning a printed pallet label for the current docket using on-device OCR"
                >
                  <Sparkles className="w-3 h-3 text-amber-400" />
                  <span>Test Pallet Label</span>
                </button>
              </div>
            )}
          </div>

          {/* Floating Zoom (+ / - / Presets) & Refocus Bar on Live Camera */}
          {isScanning && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute bottom-2 inset-x-2 z-30 flex items-center justify-between gap-1.5 pointer-events-auto"
            >
              {/* Visible Zoom Controls: (-) [1x 1.5x 2x 3x] (+) */}
              <div className="flex items-center gap-0.5 bg-black/80 backdrop-blur-md border border-white/15 rounded-[4px] p-0.5 shadow-lg">
                <button
                  type="button"
                  onClick={(e) => handleZoomStep(-0.25, e)}
                  disabled={zoomLevel <= (supportsHardwareZoom ? minHardwareZoom : 1)}
                  className="w-6 h-6 rounded-[3px] flex items-center justify-center text-zinc-200 hover:text-white hover:bg-white/15 disabled:opacity-40 cursor-pointer transition-colors"
                  title="Zoom Out (-)"
                  aria-label="Zoom out"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>

                {[1, 1.5, 2, 3]
                  .filter((z) => z <= (supportsHardwareZoom ? maxHardwareZoom : 4))
                  .map((z) => (
                    <button
                      key={z}
                      type="button"
                      onClick={(e) => handleSelectZoom(z, e)}
                      className={`px-1.5 py-0.5 rounded-[3px] font-mono text-[10px] font-bold cursor-pointer transition-colors ${
                        Math.abs(zoomLevel - z) < 0.12
                          ? 'bg-[#10B981] text-black'
                          : 'text-zinc-300 hover:text-white hover:bg-white/10'
                      }`}
                      title={`Zoom ${z}x`}
                    >
                      {z}x
                    </button>
                  ))}

                {![1, 1.5, 2, 3].some((z) => Math.abs(zoomLevel - z) < 0.12) && (
                  <span className="px-1.5 py-0.5 rounded-[3px] bg-[#059669] text-white font-mono text-[10px] font-bold">
                    {zoomLevel.toFixed(1)}x
                  </span>
                )}

                <button
                  type="button"
                  onClick={(e) => handleZoomStep(0.25, e)}
                  disabled={zoomLevel >= (supportsHardwareZoom ? maxHardwareZoom : 4)}
                  className="w-6 h-6 rounded-[3px] flex items-center justify-center text-zinc-200 hover:text-white hover:bg-white/15 disabled:opacity-40 cursor-pointer transition-colors"
                  title="Zoom In (+)"
                  aria-label="Zoom in"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
              </div>

              <button
                type="button"
                onClick={() => configureTrackFocusAndCapabilities()}
                className="h-7 px-2 rounded-[4px] bg-black/80 hover:bg-black/95 backdrop-blur-md border border-white/15 text-zinc-200 text-[10px] font-mono flex items-center gap-1 cursor-pointer shadow-lg"
                title="Tap to re-lock continuous autofocus"
              >
                <Focus className="w-3 h-3 text-emerald-400" />
                <span className="hidden sm:inline">Focus</span>
              </button>
            </div>
          )}

          {/* Camera Permission / Fallback Overlay (Includes Universal Camera & Supplier Dropdowns) */}
          {(cameraError || (!isScanning && !isStarting)) && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute inset-0 z-30 bg-[#141413]/95 pt-18 px-3 pb-3 flex flex-col items-center justify-center text-center overflow-y-auto"
            >
              <div className="w-8 h-8 rounded-full bg-[#10B981]/15 text-[#10B981] flex items-center justify-center mb-1.5 shrink-0">
                <Camera className="w-4 h-4" />
              </div>

              <h3 className="text-xs font-semibold text-white mb-1">
                {activeSupplierRule.name}
              </h3>

              {cameraError && (
                <p className="text-[10px] text-amber-300/95 max-w-[260px] mb-2 leading-snug">
                  {cameraError}
                </p>
              )}

              {/* Universal Camera Selection + Supplier Dropdowns inside Fallback Overlay */}
              <div className="w-full max-w-[245px] grid grid-cols-2 gap-1.5 mb-2 text-left">
                <div>
                  <label
                    htmlFor="scanner-overlay-camera-select"
                    className="block text-[9px] font-mono uppercase tracking-wider text-zinc-400 mb-0.5"
                  >
                    Camera
                  </label>
                  <select
                    id="scanner-overlay-camera-select"
                    value={selectedCameraId}
                    onChange={(e) => handleSelectCameraDevice(e.target.value, e)}
                    className="w-full h-7 px-1.5 rounded-[4px] bg-[#18181B] border border-zinc-700 focus:border-[#10B981] text-white text-[11px] font-semibold outline-none cursor-pointer truncate"
                  >
                    {availableCameras.length === 0 ? (
                      <option value="" className="bg-[#18181B] text-zinc-300">
                        Default Camera
                      </option>
                    ) : (
                      availableCameras.map((cam, idx) => (
                        <option key={cam.id} value={cam.id} className="bg-[#18181B] text-white">
                          {cam.label || `Camera ${idx + 1}`}
                        </option>
                      ))
                    )}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="scanner-overlay-supplier-select"
                    className="block text-[9px] font-mono uppercase tracking-wider text-zinc-400 mb-0.5"
                  >
                    Supplier / Mode
                  </label>
                  <select
                    id="scanner-overlay-supplier-select"
                    value={activeSupplierRule.id}
                    onChange={(e) => handleSelectSupplier(e.target.value as SupplierRuleId, e)}
                    className="w-full h-7 px-1.5 rounded-[4px] bg-[#18181B] border border-zinc-700 focus:border-[#10B981] text-white text-[11px] font-semibold outline-none cursor-pointer"
                  >
                    <option value="laser_central" className="bg-[#18181B] text-white">
                      Laser Central
                    </option>
                    <option value="gci" className="bg-[#18181B] text-white">
                      GCI
                    </option>
                    <option value="ocr_label" className="bg-[#18181B] text-white">
                      OCR Label Scanner
                    </option>
                  </select>
                </div>
              </div>

              <div className="flex flex-col items-center gap-1.5 w-full max-w-[245px]">
                <div className="grid grid-cols-2 gap-1.5 w-full">
                  <button
                    onClick={handleSnapPhoto}
                    disabled={isSnappingPhoto || isProcessingOcrLabel}
                    className="h-8 px-2 rounded-[4px] bg-[#059669] hover:bg-[#047857] text-white font-semibold text-[11px] flex items-center justify-center gap-1 cursor-pointer transition-colors shadow-md"
                  >
                    <Camera className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">
                      {isSnappingPhoto ? 'Scanning...' : 'Scan Barcode/QR'}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={handleCaptureOcrLabel}
                    disabled={isSnappingPhoto || isProcessingOcrLabel}
                    className="h-8 px-2 rounded-[4px] bg-amber-600 hover:bg-amber-500 text-white font-semibold text-[11px] flex items-center justify-center gap-1 cursor-pointer transition-colors shadow-md"
                  >
                    <FileText className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">
                      {isProcessingOcrLabel
                        ? ocrLabelStatusMessage || 'Reading...'
                        : 'OCR Label'}
                    </span>
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => handleTestSampleOcrLabel()}
                  disabled={isProcessingOcrLabel}
                  className="w-full h-7 px-2.5 rounded-[4px] bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-amber-200 font-semibold text-[11px] flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                >
                  <Sparkles className="w-3 h-3 text-amber-300 shrink-0" />
                  <span className="truncate">Test Sample Pallet Label (Offline OCR)</span>
                </button>

                <button
                  onClick={handleGrantCameraPermission}
                  disabled={isStarting}
                  className="w-full h-7 px-2.5 rounded-[4px] bg-white/10 hover:bg-white/20 text-white font-medium text-[11px] flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                >
                  <RefreshCw className={`w-3 h-3 shrink-0 ${isStarting ? 'animate-spin' : ''}`} />
                  <span className="truncate">
                    {isStarting ? 'Requesting...' : 'Start Live Camera'}
                  </span>
                </button>

                {onOpenNewDelivery && (
                  <button
                    onClick={onOpenNewDelivery}
                    className="w-full h-7 px-2.5 rounded-[4px] bg-white/10 hover:bg-white/15 border border-white/15 text-zinc-200 font-medium text-[11px] flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                  >
                    <Sparkles className="w-3 h-3 text-emerald-400 shrink-0" />
                    <span className="truncate">Import Docket (Photo or PDF)</span>
                  </button>
                )}

                {isInsideIframe && typeof window !== 'undefined' && (
                  <a
                    href={window.location.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full h-7 px-2.5 rounded-[4px] border border-white/10 bg-transparent hover:bg-white/5 text-zinc-400 text-[10px] font-medium flex items-center justify-center gap-1 transition-colors"
                  >
                    <ExternalLink className="w-3 h-3 shrink-0" />
                    <span className="truncate">Open in Browser Tab</span>
                  </a>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Bottom Docked Feedback Status Bar inside camera area */}
        <div
          className={`shrink-0 border-t px-2.5 py-1.5 transition-colors z-20 ${
            scanFeedback?.type === 'success'
              ? 'bg-[#059669] text-white border-[#047857]'
              : scanFeedback?.type === 'quantity_mismatch' || scanFeedback?.type === 'duplicate'
              ? 'bg-amber-600 text-white border-amber-700'
              : scanFeedback?.type === 'unexpected'
              ? 'bg-red-600 text-white border-red-700'
              : 'bg-[#18181B] text-zinc-200 border-zinc-800'
          }`}
        >
          <div className="flex items-center justify-between gap-2 min-h-[28px]">
            {scanFeedback ? (
              <>
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-5 h-5 rounded-[3px] bg-black/20 flex items-center justify-center shrink-0">
                    {scanFeedback.type === 'success' ? (
                      <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                    ) : scanFeedback.type === 'quantity_mismatch' ||
                      scanFeedback.type === 'duplicate' ? (
                      <AlertTriangle className="w-3.5 h-3.5" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5" />
                    )}
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-baseline gap-1.5">
                      {scanFeedback.matchedPart && (
                        <span className="px-1 py-0.2 rounded-[2px] bg-black/25 font-mono text-[10px] font-bold">
                          No. {formatDocketNoBadge(scanFeedback.matchedPart)}
                        </span>
                      )}
                      <span className="font-mono text-xs font-bold tracking-tight truncate">
                        {scanFeedback.matchedPart
                          ? scanFeedback.matchedPart.partNumber
                          : scanFeedback.code}
                      </span>
                    </div>
                    <p className="text-[10px] opacity-95 truncate leading-none mt-0.5">
                      {scanFeedback.message}
                    </p>
                  </div>
                </div>

                {(scanFeedback.type === 'success' ||
                  scanFeedback.type === 'quantity_mismatch') && (
                  <button
                    onClick={handleUndo}
                    className="h-6 px-2 rounded-[3px] bg-black/20 hover:bg-black/30 text-white font-medium text-[11px] flex items-center gap-1 shrink-0 cursor-pointer transition-colors"
                  >
                    <RotateCcw className="w-2.5 h-2.5" />
                    <span>Undo</span>
                  </button>
                )}
              </>
            ) : isProcessingOcrLabel ? (
              <div className="min-w-0 flex items-center justify-between w-full text-amber-300">
                <span className="text-[10px] font-mono truncate">
                  {ocrLabelStatusMessage || 'Running offline on-device OCR on pallet label...'}
                </span>
              </div>
            ) : latestHistoricalScan ? (
              <>
                <div className="min-w-0 flex items-baseline gap-1.5">
                  <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-400">
                    Last:
                  </span>
                  <span className="font-mono text-xs font-bold text-white truncate">
                    {latestHistoricalScan.partNumber || latestHistoricalScan.code}
                  </span>
                </div>

                <button
                  onClick={handleUndo}
                  className="h-6 px-2 rounded-[3px] border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-medium flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  <RotateCcw className="w-2.5 h-2.5" />
                  <span>Undo</span>
                </button>
              </>
            ) : (
              <div className="min-w-0 flex items-center justify-between w-full">
                <span className="text-[10px] text-zinc-400 truncate">
                  {activeSupplierRule.scanPrompt}
                </span>
                <span className="text-[10px] font-mono text-emerald-400 font-semibold shrink-0 ml-1">
                  {outstandingParts} left
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/* SECTION 2: Scrollable Docket Parts List Window               */}
      {/* ============================================================ */}
      <div
        className={`border-zinc-800 bg-[#141413] flex flex-col shrink-0 z-10 min-h-0 overflow-hidden transition-all duration-200 ${
          scannerLayout === 'below-camera'
            ? 'w-full flex-1 border-t'
            : 'w-[46%] max-w-[280px] sm:max-w-none sm:w-72 md:w-84 lg:w-96 h-full border-l'
        }`}
      >
        {/* Side Header: Docket info, Supplier dropdown, Layout toggle & filter bar */}
        <div className="p-2.5 border-b border-zinc-800/80 bg-[#18181B] shrink-0">
          <div className="flex items-center justify-between gap-1.5 mb-2 flex-wrap">
            <div className="flex items-center gap-1.5 min-w-0">
              <ListChecks className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <h2 className="text-[11px] font-bold text-white uppercase tracking-wider truncate">
                Docket Parts
              </h2>
              <button
                type="button"
                onClick={(e) =>
                  handleSelectScannerLayout(
                    scannerLayout === 'side-by-side' ? 'below-camera' : 'side-by-side',
                    e
                  )
                }
                className="h-5 px-1.5 rounded-[3px] bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 hover:text-white font-mono text-[9px] inline-flex items-center gap-1 cursor-pointer transition-colors shrink-0"
                title={
                  scannerLayout === 'side-by-side'
                    ? 'Switch to Below Camera layout'
                    : 'Switch to Side-by-Side layout'
                }
              >
                {scannerLayout === 'side-by-side' ? (
                  <>
                    <Rows2 className="w-2.5 h-2.5 text-emerald-400" />
                    <span>Below</span>
                  </>
                ) : (
                  <>
                    <Columns2 className="w-2.5 h-2.5 text-emerald-400" />
                    <span>Side</span>
                  </>
                )}
              </button>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <select
                aria-label="Supplier"
                value={activeSupplierRule.id}
                onChange={(e) => handleSelectSupplier(e.target.value as SupplierRuleId, e)}
                className="h-6 px-1.5 rounded-[3px] bg-[#0F0F0E] border border-zinc-700 focus:border-emerald-500 text-white font-mono text-[10px] font-semibold outline-none cursor-pointer"
                title="Switch Supplier / Scan Mode"
              >
                <option value="laser_central" className="bg-[#18181B] text-white">
                  Laser Central
                </option>
                <option value="gci" className="bg-[#18181B] text-white">
                  GCI
                </option>
                <option value="ocr_label" className="bg-[#18181B] text-white">
                  OCR Label Scanner
                </option>
              </select>
              {delivery && (
                <button
                  type="button"
                  onClick={() => exportDeliveryPdf(delivery)}
                  className="h-6 px-2 rounded-[3px] bg-[#059669] hover:bg-[#047857] text-white font-mono text-[10px] font-semibold inline-flex items-center gap-1 cursor-pointer transition-colors"
                  title="Export colour-coded PDF"
                >
                  <Printer className="w-3 h-3" />
                  <span>PDF</span>
                </button>
              )}
              <span className="font-mono text-[11px] font-bold text-white tabular-nums">
                {receivedParts}/{totalParts}
              </span>
            </div>
          </div>

          {/* Search box */}
          <div className="relative mb-1.5">
            <Search className="w-3 h-3 text-zinc-400 absolute left-2 top-2 pointer-events-none" />
            <input
              type="text"
              value={sideListSearch}
              onChange={(e) => setSideListSearch(e.target.value)}
              placeholder="Search No. or Part #..."
              className="w-full h-7 pl-6.5 pr-6 bg-[#0F0F0E] border border-zinc-700/70 focus:border-emerald-500 rounded-[4px] text-zinc-200 text-[11px] font-mono placeholder:font-sans placeholder:text-zinc-500 outline-none"
            />
            {sideListSearch && (
              <button
                onClick={() => setSideListSearch('')}
                className="absolute right-1.5 top-1.5 p-0.5 text-zinc-400 hover:text-white"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Filter tabs */}
          <div className="grid grid-cols-3 gap-0.5 bg-[#0F0F0E] p-0.5 rounded-[4px] border border-zinc-800">
            <button
              onClick={() => setSideListFilter('all')}
              className={`py-1 text-[9px] sm:text-[10px] font-mono rounded-[2px] transition-colors cursor-pointer truncate ${
                sideListFilter === 'all'
                  ? 'bg-zinc-800 text-white font-bold'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              All ({totalParts})
            </button>
            <button
              onClick={() => setSideListFilter('outstanding')}
              className={`py-1 text-[9px] sm:text-[10px] font-mono rounded-[2px] transition-colors cursor-pointer truncate ${
                sideListFilter === 'outstanding'
                  ? 'bg-zinc-800 text-amber-300 font-bold'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Left ({outstandingParts})
            </button>
            <button
              onClick={() => setSideListFilter('received')}
              className={`py-1 text-[9px] sm:text-[10px] font-mono rounded-[2px] transition-colors cursor-pointer truncate ${
                sideListFilter === 'received'
                  ? 'bg-zinc-800 text-emerald-400 font-bold'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Done ({receivedParts})
            </button>
          </div>
        </div>

        {/* Scrollable Parts List */}
        <div
          ref={partsListScrollRef}
          className="flex-1 min-h-0 overflow-y-auto divide-y divide-zinc-800/60 bg-[#141413] text-zinc-200 overscroll-contain touch-pan-y"
        >
          {displayedDocketParts.length === 0 ? (
            <div className="p-6 text-center text-zinc-500 text-xs">
              {delivery ? (
                <>
                  <p className="font-semibold text-zinc-400 mb-1">No matching parts</p>
                  <p className="text-[11px]">Adjust your search query or filter tab.</p>
                </>
              ) : (
                <>
                  <p className="font-semibold text-zinc-400 mb-1">No active delivery</p>
                  <p className="text-[11px] mb-3">Create or select a delivery docket first.</p>
                  {onOpenNewDelivery && (
                    <button
                      onClick={onOpenNewDelivery}
                      className="h-7 px-3 rounded-[3px] bg-[#059669] hover:bg-[#047857] text-white text-xs font-semibold cursor-pointer"
                    >
                      New Delivery
                    </button>
                  )}
                </>
              )}
            </div>
          ) : (
            displayedDocketParts.map((part, idx) => {
              const isJustScanned = part.id === justScannedPartId;
              const vState = getPartVerificationState(part);
              const isReceived = part.status === 'received';
              const isMismatch = vState.state === 'quantity_mismatch';
              const docketNoBadge = formatDocketNoBadge(part, idx);

              return (
                <div
                  key={part.id}
                  className={`relative flex items-center justify-between p-2.5 transition-all duration-300 cursor-pointer ${
                    isJustScanned
                      ? isMismatch
                        ? 'bg-amber-950/80 border-l-4 border-amber-400 shadow-md ring-1 ring-amber-500/30'
                        : 'bg-emerald-950/80 border-l-4 border-emerald-400 shadow-md ring-1 ring-emerald-500/30'
                      : isMismatch
                      ? 'bg-amber-950/35 border-l-2 border-amber-500 hover:bg-amber-950/50'
                      : isReceived
                      ? 'bg-white/[0.01] hover:bg-white/[0.04]'
                      : 'hover:bg-white/[0.03]'
                  }`}
                  onClick={(e) => handleRequestTick(part, e)}
                  title="Click to manually verify or unverify"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1 pr-1.5">
                    {/* Interactive Tick / Check Button */}
                    <button
                      type="button"
                      onClick={(e) => handleRequestTick(part, e)}
                      className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 border transition-all cursor-pointer ${
                        isMismatch
                          ? 'bg-amber-500 border-amber-500 text-black shadow-xs'
                          : isReceived
                          ? 'bg-[#10B981] border-[#10B981] text-white shadow-xs'
                          : 'border-zinc-600 hover:border-emerald-400 text-transparent hover:text-emerald-400/50 hover:bg-emerald-500/10'
                      }`}
                    >
                      <Check className="w-3.5 h-3.5 stroke-[3]" />
                    </button>

                    {/* Part Details + Prominent Docket "No." Badge + Qty */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span
                          className={`px-1.5 py-0.5 rounded-[3px] font-mono text-[10px] font-bold shrink-0 ${
                            isJustScanned
                              ? isMismatch
                                ? 'bg-amber-400 text-black'
                                : 'bg-emerald-500 text-black'
                              : isMismatch
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                              : isReceived
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-zinc-800 text-amber-300 border border-zinc-700'
                          }`}
                        >
                          No. {docketNoBadge}
                        </span>

                        <span
                          className={`font-mono text-xs font-bold tracking-tight truncate ${
                            isJustScanned
                              ? isMismatch
                                ? 'text-amber-300'
                                : 'text-emerald-300'
                              : isReceived
                              ? 'text-zinc-200'
                              : 'text-white'
                          }`}
                        >
                          {part.partNumber}
                        </span>

                        <span
                          className={`px-1.5 py-0.2 rounded-[2px] font-mono text-[9px] font-bold ${
                            isMismatch
                              ? 'bg-amber-500/25 text-amber-300 border border-amber-400/40'
                              : isReceived
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : vState.requiredQty > 1
                              ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                              : 'bg-zinc-800 text-zinc-400'
                          }`}
                        >
                          {isReceived
                            ? `Qty ${vState.receivedQty}/${vState.requiredQty}`
                            : `Req Qty: ${vState.requiredQty}`}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5 text-[10px] text-zinc-400 truncate mt-0.5">
                        <span className="truncate max-w-[150px]">{part.description}</span>
                        {(part.thickness || part.material || part.dimensions) && (
                          <span className="px-1 py-0.2 rounded-[2px] bg-zinc-800/90 text-zinc-300 font-mono text-[9px] shrink-0">
                            {[part.thickness, part.material, part.dimensions].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Status Indicator Pill */}
                  <div className="shrink-0 flex items-center">
                    {isMismatch ? (
                      <span className="px-1.5 py-0.5 rounded-[3px] bg-amber-500/20 text-amber-300 border border-amber-500/40 font-mono text-[10px] font-semibold flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                        Mismatch
                      </span>
                    ) : isReceived ? (
                      <span className="px-1.5 py-0.5 rounded-[3px] bg-[#10B981]/15 text-[#10B981] font-mono text-[10px] font-semibold flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#10B981]" />
                        Verified
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded-[3px] bg-zinc-800 text-zinc-400 font-mono text-[10px] flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
                        Pending
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Side Footer: Docket summary count */}
        <div className="p-2.5 border-t border-zinc-800/80 bg-[#18181B] shrink-0 flex items-center justify-between text-[11px] text-zinc-400">
          <span className="truncate">
            {delivery ? `${delivery.supplier} · ${delivery.docketNumber}` : 'No docket'}
          </span>
          <span className="font-mono text-zinc-300 shrink-0">
            {receivedParts}/{totalParts} done
          </span>
        </div>
      </div>

      {/* ============================================================ */}
      {/* MANDATORY QUANTITY CONFIRMATION POPUP (When Req Qty > 1)     */}
      {/* Scanner is locked until user submits the received quantity!  */}
      {/* ============================================================ */}
      {pendingQuantityScan && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-[#1C1C1E] border-2 border-emerald-500/60 rounded-[8px] p-5 shadow-2xl text-white animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-zinc-800 mb-3.5">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="font-mono text-[11px] uppercase tracking-wider text-emerald-400 font-bold">
                  Mandatory Quantity Confirmation
                </span>
              </div>
              <span className="px-2 py-0.5 rounded bg-zinc-800 font-mono text-[10px] text-amber-300 font-semibold">
                Scanner Locked
              </span>
            </div>

            {/* Scanned Part Info & Required Quantity */}
            <div className="p-3.5 rounded-[6px] bg-black/50 border border-zinc-800 mb-4">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div>
                  <span className="text-[10px] font-mono uppercase text-zinc-400 block">
                    Part Number
                  </span>
                  <span className="font-mono text-lg font-bold text-white tracking-tight">
                    {pendingQuantityScan.part.partNumber}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-[10px] font-mono uppercase text-zinc-400 block">
                    Docket No.
                  </span>
                  <span className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 font-mono text-xs font-bold text-emerald-300">
                    No. {formatDocketNoBadge(pendingQuantityScan.part)}
                  </span>
                </div>
              </div>

              <p className="text-xs text-zinc-300 mb-3 truncate">
                {pendingQuantityScan.part.description}
              </p>

              <div className="pt-2.5 border-t border-zinc-800/80 flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-300">
                  Required Docket Quantity:
                </span>
                <span className="px-2.5 py-1 rounded-[4px] bg-emerald-500/20 border border-emerald-500/40 font-mono text-base font-bold text-emerald-300 tabular-nums">
                  {Math.max(1, pendingQuantityScan.part.quantity ?? 1)} pcs
                </span>
              </div>
            </div>

            <form onSubmit={handleConfirmPendingQuantity}>
              <label className="block text-xs font-semibold text-zinc-200 mb-2">
                Enter Actual Quantity Received / Scanned:
              </label>

              <div className="flex items-center gap-2 mb-2">
                <button
                  type="button"
                  onClick={() => {
                    const curr = parseInt(quantityInput, 10) || 1;
                    setQuantityInput(String(Math.max(1, curr - 1)));
                    setQuantityError(null);
                  }}
                  className="w-11 h-11 rounded-[5px] bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-white flex items-center justify-center cursor-pointer shrink-0"
                  aria-label="Decrease quantity"
                >
                  <Minus className="w-4 h-4" />
                </button>

                <input
                  ref={quantityInputRef}
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="99999"
                  required
                  value={quantityInput}
                  onChange={(e) => {
                    setQuantityInput(e.target.value);
                    setQuantityError(null);
                  }}
                  placeholder="Enter qty..."
                  className="flex-1 h-11 px-3 bg-[#0F0F0E] border-2 border-zinc-700 focus:border-emerald-400 rounded-[5px] text-center font-mono text-xl font-bold text-white outline-none tabular-nums"
                />

                <button
                  type="button"
                  onClick={() => {
                    const curr = parseInt(quantityInput, 10) || 0;
                    setQuantityInput(String(curr + 1));
                    setQuantityError(null);
                  }}
                  className="w-11 h-11 rounded-[5px] bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-white flex items-center justify-center cursor-pointer shrink-0"
                  aria-label="Increase quantity"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>

              {quantityError && (
                <p className="text-xs text-red-400 font-medium mb-2">{quantityError}</p>
              )}

              <p className="text-[11px] text-zinc-400 mb-4 leading-snug">
                Matching quantity ({Math.max(1, pendingQuantityScan.part.quantity ?? 1)}) marks the part{' '}
                <strong className="text-emerald-400">Green (Verified)</strong>. A different quantity marks it{' '}
                <strong className="text-amber-400">Orange (Quantity Mismatch)</strong>.
              </p>

              <button
                type="submit"
                className="w-full h-11 px-4 rounded-[5px] bg-[#059669] hover:bg-[#047857] text-white font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer transition-colors shadow-lg"
              >
                <Check className="w-4 h-4 stroke-[2.5]" />
                <span>Submit &amp; Confirm Quantity</span>
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* MODAL 1: Manual Verification & Quantity Edit Prompt          */}
      {/* ============================================================ */}
      {confirmTickPart && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-[#1C1C1E] border border-zinc-700/80 rounded-[8px] p-4.5 shadow-2xl text-white animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-start gap-3 mb-3.5">
              <div
                className={`w-9 h-9 rounded-[6px] flex items-center justify-center shrink-0 ${
                  confirmTickPart.status === 'outstanding' ||
                  Math.max(1, confirmTickPart.quantity ?? 1) > 1
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                }`}
              >
                {confirmTickPart.status === 'outstanding' ||
                Math.max(1, confirmTickPart.quantity ?? 1) > 1 ? (
                  <Check className="w-5 h-5 stroke-[2.5]" />
                ) : (
                  <AlertTriangle className="w-5 h-5" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold text-sm text-white">
                  {Math.max(1, confirmTickPart.quantity ?? 1) > 1
                    ? confirmTickPart.status === 'received'
                      ? 'Edit Part Quantity'
                      : 'Enter & Confirm Part Quantity'
                    : confirmTickPart.status === 'outstanding'
                    ? 'Confirm Manual Verification'
                    : 'Undo Part Verification'}
                </h3>
                <p className="text-xs text-zinc-400 mt-0.5 leading-relaxed">
                  {Math.max(1, confirmTickPart.quantity ?? 1) > 1
                    ? `Enter the actual quantity received for this part (Required: ${Math.max(1, confirmTickPart.quantity ?? 1)}).`
                    : confirmTickPart.status === 'outstanding'
                    ? 'Double-check: Do you want to manually mark this part as received?'
                    : 'Double-check: Do you want to revert this part back to outstanding status?'}
                </p>
              </div>
            </div>

            {/* Part summary card */}
            <div className="p-3 rounded-[5px] bg-black/40 border border-zinc-800 text-left mb-4">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-mono text-sm font-bold text-emerald-400 truncate">
                  {confirmTickPart.partNumber}
                </span>
                <span className="px-1.5 py-0.5 rounded-[3px] bg-zinc-800 font-mono text-xs font-bold text-amber-300">
                  No. {formatDocketNoBadge(confirmTickPart)} · Req Qty:{' '}
                  {Math.max(1, confirmTickPart.quantity ?? 1)}
                </span>
              </div>
              <p className="text-xs text-zinc-300 truncate">{confirmTickPart.description}</p>
            </div>

            {/* Whenever required quantity > 1, allow entering or editing the received quantity */}
            {Math.max(1, confirmTickPart.quantity ?? 1) > 1 && (
              <div className="mb-4">
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Actual Quantity Received (Required: {Math.max(1, confirmTickPart.quantity ?? 1)}):
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const curr = parseInt(manualTickQtyInput, 10) || 0;
                      setManualTickQtyInput(String(Math.max(0, curr - 1)));
                    }}
                    className="w-10 h-10 rounded-[4px] bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-white flex items-center justify-center cursor-pointer shrink-0"
                    aria-label="Decrease quantity"
                  >
                    <Minus className="w-4 h-4" />
                  </button>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    value={manualTickQtyInput}
                    onChange={(e) => setManualTickQtyInput(e.target.value)}
                    className="flex-1 h-10 px-3 bg-[#0F0F0E] border border-zinc-700 focus:border-emerald-400 rounded-[4px] font-mono text-base font-bold text-white text-center outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const curr = parseInt(manualTickQtyInput, 10) || 0;
                      setManualTickQtyInput(String(curr + 1));
                    }}
                    className="w-10 h-10 rounded-[4px] bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-white flex items-center justify-center cursor-pointer shrink-0"
                    aria-label="Increase quantity"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {/* Prompt Actions */}
            <div className="flex items-center justify-end gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => setConfirmTickPart(null)}
                className="h-8 px-3 rounded-[4px] border border-zinc-700 bg-transparent hover:bg-zinc-800 text-zinc-300 text-xs font-medium cursor-pointer transition-colors"
              >
                Cancel
              </button>

              {Math.max(1, confirmTickPart.quantity ?? 1) > 1 ? (
                <>
                  {confirmTickPart.status === 'received' && (
                    <button
                      type="button"
                      onClick={() => handleConfirmManualTick('outstanding')}
                      className="h-8 px-3 rounded-[4px] bg-amber-600/20 hover:bg-amber-600/30 border border-amber-500/40 text-amber-300 text-xs font-semibold cursor-pointer transition-colors"
                    >
                      Mark Outstanding
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleConfirmManualTick('received')}
                    className="h-8 px-4 rounded-[4px] bg-[#059669] hover:bg-[#047857] text-white text-xs font-semibold cursor-pointer transition-colors shadow-sm"
                  >
                    {confirmTickPart.status === 'received' ? 'Save Quantity' : 'Confirm & Receive'}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => handleConfirmManualTick()}
                  className={`h-8 px-4 rounded-[4px] text-white text-xs font-semibold cursor-pointer transition-colors shadow-sm ${
                    confirmTickPart.status === 'outstanding'
                      ? 'bg-[#059669] hover:bg-[#047857]'
                      : 'bg-amber-600 hover:bg-amber-700'
                  }`}
                >
                  {confirmTickPart.status === 'outstanding'
                    ? 'Confirm & Receive'
                    : 'Revert to Outstanding'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* MODAL 2: Manual Code Entry Modal                             */}
      {/* ============================================================ */}
      {isManualModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-[#1C1C1E] border border-zinc-700 rounded-[6px] p-4 shadow-xl text-white">
            <div className="flex items-center justify-between pb-2.5 border-b border-zinc-800 mb-3">
              <span className="font-semibold text-xs text-white">
                Enter Part Code ({activeSupplierRule.name})
              </span>
              <button
                onClick={() => setIsManualModalOpen(false)}
                className="p-1 text-zinc-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (manualCodeInput.trim()) {
                  const codeToProcess = manualCodeInput.trim();
                  setManualCodeInput('');
                  setIsManualModalOpen(false);
                  handleScannedCode(codeToProcess, 'manual');
                }
              }}
            >
              <input
                type="text"
                autoFocus
                value={manualCodeInput}
                onChange={(e) => setManualCodeInput(e.target.value)}
                placeholder={
                  activeSupplierRule.id === 'gci'
                    ? 'Part Number (e.g. PLT-105)'
                    : 'Barcode (e.g. 482910-3) or Part #'
                }
                className="w-full h-9 px-3 bg-[#0F0F0E] border border-zinc-700 focus:border-emerald-500 rounded-[4px] text-white font-mono text-xs outline-none uppercase mb-3"
              />

              {outstandingSample && (
                <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="text-zinc-500">Sample:</span>
                  <button
                    type="button"
                    onClick={() =>
                      setManualCodeInput(`482910-${formatDocketNoBadge(outstandingSample)}`)
                    }
                    className="px-1.5 py-0.5 bg-emerald-950/80 border border-emerald-500/40 rounded-[3px] font-mono text-emerald-300 cursor-pointer"
                  >
                    482910-{formatDocketNoBadge(outstandingSample)} (No.{' '}
                    {formatDocketNoBadge(outstandingSample)})
                  </button>
                  <button
                    type="button"
                    onClick={() => setManualCodeInput(outstandingSample.partNumber)}
                    className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded-[3px] font-mono text-white cursor-pointer"
                  >
                    {outstandingSample.partNumber} (QR)
                  </button>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setIsManualModalOpen(false)}
                  className="h-8 px-3 rounded-[4px] border border-zinc-700 bg-transparent text-zinc-300 text-xs font-medium cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!manualCodeInput.trim()}
                  className="h-8 px-3.5 rounded-[4px] bg-[#059669] hover:bg-[#047857] disabled:opacity-50 text-white font-semibold text-xs cursor-pointer"
                >
                  Verify Part
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* MODAL 3: OCR Pallet Label Editable Confirmation Modal        */}
      {/* ============================================================ */}
      {pendingOcrLabelResult && delivery && (
        <OcrPalletLabelConfirmModal
          delivery={delivery}
          extraction={pendingOcrLabelResult}
          onConfirmMatchedLabel={handleConfirmOcrMatchedLabel}
          onRecordUnexpectedLabel={handleRecordUnexpectedOcrLabel}
          onCancel={() => {
            pendingOcrLabelRef.current = null;
            setPendingOcrLabelResult(null);
          }}
        />
      )}

      {/* ============================================================ */}
      {/* MODAL 4: 3-Option Mobile Upload Selector (Camera/Gallery/Files) */}
      {/* ============================================================ */}
      {uploadModalIntent && (
        <div
          onClick={handleCloseScannerUploadModal}
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-[#1C1C1E] border border-zinc-700 rounded-[6px] p-4 shadow-2xl text-white"
          >
            <div className="flex items-center justify-between pb-2.5 border-b border-zinc-800 mb-3">
              <div>
                <span className="font-semibold text-sm text-white block">
                  {uploadModalIntent === 'ocr_label'
                    ? 'Upload or Capture Pallet Label (OCR)'
                    : 'Upload or Capture Barcode / QR / Label'}
                </span>
                <span className="text-[11px] text-zinc-400">
                  Choose Camera, Photo Gallery, or Device Files
                </span>
              </div>
              <button
                type="button"
                onClick={handleCloseScannerUploadModal}
                className="p-1 text-zinc-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 3 Clear Mobile & Desktop Upload Options */}
            <div className="grid grid-cols-3 gap-2 mb-3">
              {/* Option 1: CAMERA */}
              <label
                htmlFor="scanner-upload-camera-input"
                className="p-3 rounded-[5px] border border-emerald-500/40 bg-emerald-950/30 hover:bg-emerald-950/50 flex flex-col items-center justify-center text-center gap-1.5 cursor-pointer transition-all select-none"
              >
                <div className="w-8 h-8 rounded-full bg-[#059669] text-white flex items-center justify-center shadow-sm">
                  <Camera className="w-4 h-4" />
                </div>
                <div>
                  <span className="text-xs font-bold text-white block">1. Camera</span>
                  <span className="text-[10px] text-emerald-300/90 block leading-tight">
                    Capture new photo
                  </span>
                </div>
              </label>

              {/* Option 2: GALLERY */}
              <label
                htmlFor="scanner-upload-gallery-input"
                className="p-3 rounded-[5px] border-2 border-[#10B981] bg-emerald-950/20 hover:bg-emerald-950/40 flex flex-col items-center justify-center text-center gap-1.5 cursor-pointer transition-all select-none"
              >
                <div className="w-8 h-8 rounded-full bg-[#059669] text-white flex items-center justify-center">
                  <ImageIcon className="w-4 h-4" />
                </div>
                <div>
                  <span className="text-xs font-bold text-white block">2. Gallery</span>
                  <span className="text-[10px] text-emerald-300 block leading-tight">
                    Select from Gallery
                  </span>
                </div>
              </label>

              {/* Option 3: FILES */}
              <label
                htmlFor="scanner-upload-files-input"
                className="p-3 rounded-[5px] border border-zinc-700 bg-zinc-900/90 hover:border-emerald-500/50 hover:bg-zinc-800/80 flex flex-col items-center justify-center text-center gap-1.5 cursor-pointer transition-all select-none"
              >
                <div className="w-8 h-8 rounded-full bg-zinc-800 text-amber-400 flex items-center justify-center border border-zinc-700">
                  <FolderOpen className="w-4 h-4" />
                </div>
                <div>
                  <span className="text-xs font-bold text-white block">3. Files</span>
                  <span className="text-[10px] text-zinc-400 block leading-tight">
                    Browse device files
                  </span>
                </div>
              </label>
            </div>

            {/* Selected Files Preview (Staged before processing) */}
            {stagedScannerFiles.length > 0 ? (
              <div className="mb-3 space-y-2 max-h-48 overflow-y-auto pr-1">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-semibold text-emerald-300">
                    Selected Files ({stagedScannerFiles.length}) — Ready to Confirm
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      stagedScannerFiles.forEach((item) => {
                        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
                      });
                      setStagedScannerFiles([]);
                    }}
                    className="text-red-400 hover:text-red-300 text-[10px] font-medium cursor-pointer"
                  >
                    Clear All
                  </button>
                </div>
                {stagedScannerFiles.map((stagedItem) => (
                  <div
                    key={stagedItem.id}
                    className="p-2 rounded-[5px] bg-zinc-900 border border-emerald-500/40 flex items-center justify-between gap-2.5"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {stagedItem.previewUrl ? (
                        <img
                          src={stagedItem.previewUrl}
                          alt={stagedItem.file.name}
                          className="w-11 h-11 rounded-[4px] object-cover border border-zinc-700 shrink-0 bg-black"
                        />
                      ) : (
                        <div className="w-11 h-11 rounded-[4px] bg-zinc-800 border border-zinc-700 flex items-center justify-center text-amber-400 shrink-0">
                          <FileText className="w-5 h-5" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="px-1.5 py-0.5 rounded-[3px] bg-emerald-500/20 text-emerald-300 font-mono text-[9px] font-bold uppercase">
                            {stagedItem.sourceLabel}
                          </span>
                        </div>
                        <p className="text-xs font-semibold text-white truncate mt-0.5">
                          {stagedItem.file.name}
                        </p>
                        <p className="text-[10px] font-mono text-zinc-400">
                          {(stagedItem.file.size / 1024).toFixed(1)} KB
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (stagedItem.previewUrl) {
                          URL.revokeObjectURL(stagedItem.previewUrl);
                        }
                        setStagedScannerFiles((prev) =>
                          prev.filter((it) => it.id !== stagedItem.id)
                        );
                      }}
                      className="p-1.5 rounded-[4px] text-zinc-400 hover:text-red-400 hover:bg-red-950/30 cursor-pointer shrink-0"
                      title="Remove selected file"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mb-3 py-2.5 px-3 rounded-[4px] bg-zinc-900/60 border border-zinc-800 text-center">
                <p className="text-[11px] text-zinc-400">
                  No files selected yet. Tap <span className="text-white font-semibold">Camera</span>,{' '}
                  <span className="text-white font-semibold">Gallery</span>, or{' '}
                  <span className="text-white font-semibold">Files</span> above.
                </p>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2.5 border-t border-zinc-800">
              <button
                type="button"
                onClick={handleCloseScannerUploadModal}
                className="h-8 px-3 rounded-[4px] border border-zinc-700 bg-transparent text-zinc-300 text-xs font-medium cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={stagedScannerFiles.length === 0}
                onClick={handleConfirmStagedScannerFile}
                className="h-8 px-4 rounded-[4px] bg-[#059669] hover:bg-[#047857] disabled:opacity-40 text-white font-semibold text-xs flex items-center gap-1.5 cursor-pointer transition-colors shadow-sm"
              >
                <Check className="w-3.5 h-3.5" />
                <span>
                  Confirm &amp; Process
                  {stagedScannerFiles.length > 0 ? ` (${stagedScannerFiles.length})` : ''}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
