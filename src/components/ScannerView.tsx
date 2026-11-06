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
  Sparkles,
  ExternalLink,
  RefreshCw,
  Search,
  ListChecks,
  Split,
  Focus,
  ZoomIn,
} from 'lucide-react';
import { Delivery, DeliveryPart, ScanFeedback } from '../types/delivery';
import { processScannedCode, undoLastScan, setPartStatus, parseBarcodeDocketNo } from '../utils/storage';
import { playAudio, triggerHaptic, speakAlert } from '../utils/audioFeedback';

interface ScannerViewProps {
  delivery: Delivery | null;
  onUpdateDelivery: (updated: Delivery) => void;
  onOpenTestSheet: () => void;
  onOpenNewDelivery?: () => void;
}

/**
 * Helper to format clean Docket "No." badge from part itemNumber / docketLineIndex
 */
function formatDocketNoBadge(part: DeliveryPart, fallbackIdx?: number): string {
  const raw = (part.itemNumber || '').trim();
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
}) => {
  const [isScanning, setIsScanning] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [availableCameras, setAvailableCameras] = useState<Array<{ id: string; label: string }>>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('');
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);

  // Camera sharpness, zoom & autofocus controls
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [supportsHardwareZoom, setSupportsHardwareZoom] = useState<boolean>(false);
  const [maxHardwareZoom, setMaxHardwareZoom] = useState<number>(4);
  const [focusRingPos, setFocusRingPos] = useState<{ x: number; y: number } | null>(null);

  // Manual modal & input
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [manualCodeInput, setManualCodeInput] = useState('');

  // Real-time scan feedback & visual flash
  const [scanFeedback, setScanFeedback] = useState<ScanFeedback | null>(null);
  const [flashColor, setFlashColor] = useState<'green' | 'orange' | 'red' | null>(null);
  const [isSnappingPhoto, setIsSnappingPhoto] = useState(false);

  // Side docket window state
  const [sideListSearch, setSideListSearch] = useState('');
  const [sideListFilter, setSideListFilter] = useState<'all' | 'outstanding' | 'received'>('all');
  const [justScannedPartId, setJustScannedPartId] = useState<string | null>(null);
  const [confirmTickPart, setConfirmTickPart] = useState<DeliveryPart | null>(null);
  const [mobileViewMode, setMobileViewMode] = useState<'side' | 'split' | 'camera' | 'list'>('side');

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const offscreenScannerRef = useRef<Html5Qrcode | null>(null);
  const nativeDetectorIntervalRef = useRef<any>(null);
  const lastScannedCodeRef = useRef<string>('');
  const lastScannedTimeRef = useRef<number>(0);
  const feedbackTimeoutRef = useRef<any>(null);
  const flashTimeoutRef = useRef<any>(null);
  const justScannedTimeoutRef = useRef<any>(null);
  const focusRingTimeoutRef = useRef<any>(null);
  const isStartingRef = useRef<boolean>(false);
  const isMountedRef = useRef<boolean>(true);
  const snapFileInputRef = useRef<HTMLInputElement | null>(null);
  const partsListScrollRef = useRef<HTMLDivElement | null>(null);

  // Check if running inside iframe (e.g., AI Studio preview)
  const isInsideIframe = typeof window !== 'undefined' && window.self !== window.top;

  // Keep references to delivery and update handler stable
  const deliveryRef = useRef(delivery);
  deliveryRef.current = delivery;

  const onUpdateDeliveryRef = useRef(onUpdateDelivery);
  onUpdateDeliveryRef.current = onUpdateDelivery;

  const totalParts = delivery?.parts.length || 0;
  const receivedParts = delivery?.parts.filter((p) => p.status === 'received').length || 0;
  const outstandingParts = totalParts - receivedParts;
  const percentage = totalParts > 0 ? Math.round((receivedParts / totalParts) * 100) : 0;

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
   * Applies continuous autofocus, continuous exposure, and sharpness enhancements
   * to the live camera track so 1D barcodes are crisp instead of blurry.
   */
  const configureTrackFocusAndCapabilities = useCallback(
    async (initialZoom = zoomLevel) => {
      const track = getActiveVideoTrack();
      if (!track) return;

      try {
        const capabilities = (track as any).getCapabilities?.() || {};

        // 1. Check Torch capability
        if (capabilities.torch && isMountedRef.current) {
          setHasTorch(true);
        }

        // 2. Check Hardware Zoom capability
        if (capabilities.zoom && typeof capabilities.zoom === 'object') {
          const maxZ = capabilities.zoom.max || 4;
          if (isMountedRef.current) {
            setSupportsHardwareZoom(true);
            setMaxHardwareZoom(Math.min(maxZ, 5));
          }
        } else if (isMountedRef.current) {
          setSupportsHardwareZoom(false);
        }

        // 3. Enforce continuous autofocus + continuous exposure + optional hardware zoom
        const advancedConstraints: Record<string, any> = {};
        if (
          Array.isArray(capabilities.focusMode) &&
          capabilities.focusMode.includes('continuous')
        ) {
          advancedConstraints.focusMode = 'continuous';
        }
        if (
          Array.isArray(capabilities.exposureMode) &&
          capabilities.exposureMode.includes('continuous')
        ) {
          advancedConstraints.exposureMode = 'continuous';
        }
        if (
          Array.isArray(capabilities.whiteBalanceMode) &&
          capabilities.whiteBalanceMode.includes('continuous')
        ) {
          advancedConstraints.whiteBalanceMode = 'continuous';
        }
        if (capabilities.zoom && initialZoom > 1) {
          const minZ = capabilities.zoom.min || 1;
          const maxZ = capabilities.zoom.max || 4;
          advancedConstraints.zoom = Math.max(minZ, Math.min(maxZ, initialZoom));
        }

        // 3. Upgrade live video track to Full HD 1080p + continuous autofocus + optional hardware zoom
        try {
          await track.applyConstraints({
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            ...(Object.keys(advancedConstraints).length > 0
              ? { advanced: [advancedConstraints] }
              : {}),
          } as any);
        } catch {
          if (Object.keys(advancedConstraints).length > 0) {
            await track
              .applyConstraints({
                advanced: [advancedConstraints],
              } as any)
              .catch(() => {});
          } else {
            await track
              .applyConstraints({
                advanced: [{ focusMode: 'continuous' } as any],
              })
              .catch(() => {});
          }
        }
      } catch (e) {
        console.info('Camera track focus tuning note:', e);
      }
    },
    [getActiveVideoTrack, zoomLevel]
  );

  /**
   * Changes camera zoom level (1x, 1.5x, 2x, 3x).
   * Using 1.5x or 2x allows holding the phone ~20cm back where the main lens focuses sharply!
   */
  const handleSelectZoom = async (targetZoom: number, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setZoomLevel(targetZoom);

    const track = getActiveVideoTrack();
    if (!track) return;

    try {
      const capabilities = (track as any).getCapabilities?.() || {};
      if (capabilities.zoom) {
        const minZ = capabilities.zoom.min || 1;
        const maxZ = capabilities.zoom.max || 4;
        const clamped = Math.max(minZ, Math.min(maxZ, targetZoom));
        await track.applyConstraints({
          advanced: [{ zoom: clamped, focusMode: 'continuous' } as any],
        });
      }
    } catch {}
  };

  /**
   * Tap-to-Focus handler: triggers an immediate autofocus cycle on the camera track
   */
  const handleTapToFocus = async (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setFocusRingPos({ x, y });
    if (focusRingTimeoutRef.current) clearTimeout(focusRingTimeoutRef.current);
    focusRingTimeoutRef.current = setTimeout(() => {
      setFocusRingPos(null);
    }, 950);

    const track = getActiveVideoTrack();
    if (!track) return;

    try {
      const capabilities = (track as any).getCapabilities?.() || {};
      if (Array.isArray(capabilities.focusMode)) {
        if (capabilities.focusMode.includes('single-shot')) {
          await track.applyConstraints({
            advanced: [{ focusMode: 'single-shot' } as any],
          });
          setTimeout(() => {
            if (capabilities.focusMode.includes('continuous')) {
              track
                .applyConstraints({
                  advanced: [{ focusMode: 'continuous' } as any],
                })
                .catch(() => {});
            }
          }, 550);
          return;
        }
      }
      await track.applyConstraints({
        advanced: [{ focusMode: 'continuous' } as any],
      });
    } catch {}
  };

  const handleScannedCode = useCallback((codeText: string) => {
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

    const { updatedDelivery, result } = processScannedCode(currentDelivery, cleaned);
    onUpdateDeliveryRef.current(updatedDelivery);

    if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);

    const parsedBarcodeNo = parseBarcodeDocketNo(cleaned);

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
          ? `Barcode ${cleaned} → No. ${docketNoStr} (${result.part.partNumber})`
          : `Verified No. ${docketNoStr} · ${result.part.partNumber}`,
        timestamp: now,
      });
    } else if (result.status === 'duplicate' && result.part) {
      triggerVisualFlash('orange');
      playAudio.duplicate();
      triggerHaptic('duplicate');
      speakAlert('Duplicate scan');

      const docketNoStr = formatDocketNoBadge(result.part);
      setScanFeedback({
        type: 'duplicate',
        code: cleaned,
        matchedPart: result.part,
        message: `No. ${docketNoStr} (${result.part.partNumber}) already received`,
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
            ? `Barcode "${cleaned}" (Docket No. ${parsedBarcodeNo.numericNo}) not found on docket ${currentDelivery.docketNumber}`
            : `Code "${cleaned}" not listed on docket ${currentDelivery.docketNumber}`,
        timestamp: now,
      });
    }

    feedbackTimeoutRef.current = setTimeout(() => {
      setScanFeedback(null);
    }, 8000);
  }, []);

  /**
   * Starts a parallel hardware-accelerated BarcodeDetector loop on the live <video> element
   * when supported by Android Chrome / WebView. This scans the ENTIRE 1080p video frame
   * without cropping so wide 1D barcodes (<numbers>-<No>) are picked up immediately.
   */
  const startNativeBarcodeLoop = useCallback(() => {
    if (nativeDetectorIntervalRef.current) {
      clearInterval(nativeDetectorIntervalRef.current);
      nativeDetectorIntervalRef.current = null;
    }

    const BarcodeDetectorAPI = (window as any).BarcodeDetector;
    if (!BarcodeDetectorAPI) return;

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
    } catch {
      try {
        detector = new BarcodeDetectorAPI();
      } catch {
        return;
      }
    }

    let isDetecting = false;
    nativeDetectorIntervalRef.current = setInterval(async () => {
      if (isDetecting || !isMountedRef.current) return;
      const container = document.getElementById('camera-scanner-view');
      const video = container?.querySelector('video') as HTMLVideoElement | null;
      if (!video || video.readyState < 2 || video.videoWidth === 0) return;

      isDetecting = true;
      try {
        const barcodes = await detector.detect(video);
        if (barcodes && barcodes.length > 0) {
          // Prefer a barcode matching <numbers>-<No> if multiple are visible
          const hyphenMatch = barcodes.find(
            (b: any) =>
              b.rawValue && parseBarcodeDocketNo(String(b.rawValue)).hasDashFormat
          );
          const chosen = hyphenMatch || barcodes[0];
          if (chosen?.rawValue) {
            handleScannedCode(String(chosen.rawValue));
          }
        }
      } catch {
        // Ignore transient frame errors
      } finally {
        isDetecting = false;
      }
    }, 160);
  }, [handleScannedCode]);

  /**
   * Initializes or restarts the continuous video camera scanner with 1080p HD constraints
   * and smart main-lens selection (avoiding blurry 0.5x ultra-wide fixed-focus cameras).
   */
  const startScanner = useCallback(
    async (targetCameraId?: string) => {
      if (isStartingRef.current) return;
      isStartingRef.current = true;
      setIsStarting(true);
      setCameraError(null);

      try {
        // 1. Discover available cameras and prioritize the MAIN rear autofocus lens
        let devices: Array<{ id: string; label: string }> = [];
        try {
          const rawDevices = await Html5Qrcode.getCameras();
          if (rawDevices && rawDevices.length > 0) {
            devices = rawDevices.map((d) => ({
              id: d.id,
              label: d.label || `Camera ${d.id}`,
            }));
            if (isMountedRef.current) {
              setAvailableCameras(devices);
            }
          }
        } catch (e) {
          console.info('Camera discovery info:', e);
        }

        // 2. Build multi-tier attempts list
        // CRITICAL: html5-qrcode's createVideoConstraints ONLY accepts:
        // - string deviceId, OR
        // - { facingMode: "environment" }, OR
        // - { facingMode: "user" }
        // Passing extra keys (width/height/ideal) or {} in cameraIdOrConfig throws synchronously
        // and locks html5-qrcode's stateManagerProxy!
        const activeId = targetCameraId || selectedCameraId;
        const attempts: Array<string | MediaTrackConstraints> = [];

        if (activeId) {
          attempts.push(activeId);
        }

        if (devices.length > 0) {
          // Filter out ultra-wide (0.5x) or front cameras when looking for the primary rear camera
          const rearCandidates = devices.filter(
            (d) =>
              /back|rear|environment|main|standard/i.test(d.label) &&
              !/ultra|wide-angle|0\.5|front|user|selfie/i.test(d.label)
          );
          // On Samsung Android, "camera 0, facing back" is the primary main sensor with autofocus
          const primaryRear =
            rearCandidates.find((d) => /camera\s*0|main|standard/i.test(d.label)) ||
            rearCandidates[0] ||
            devices.find((d) => /back|rear|environment/i.test(d.label));

          if (primaryRear && !attempts.includes(primaryRear.id)) {
            attempts.push(primaryRear.id);
          }

          for (const dev of devices) {
            if (!attempts.includes(dev.id) && !/front|user|selfie/i.test(dev.label)) {
              attempts.push(dev.id);
            }
          }
          for (const dev of devices) {
            if (!attempts.includes(dev.id)) {
              attempts.push(dev.id);
            }
          }
        }

        attempts.push({ facingMode: 'environment' });
        attempts.push({ facingMode: 'user' });

        // 3. Stop any existing scanner instance cleanly
        if (nativeDetectorIntervalRef.current) {
          clearInterval(nativeDetectorIntervalRef.current);
          nativeDetectorIntervalRef.current = null;
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
              useBarCodeDetectorIfSupported: true,
            },
            verbose: false,
          });

        // Wide scan box (94% width) so horizontal 1D barcodes (<numbers>-<No>) never get clipped in side-by-side mode
        const scanConfig: any = {
          fps: 25,
          disableFlip: false,
          qrbox: (viewfinderWidth: number, viewfinderHeight: number) => {
            const w = Math.max(160, Math.floor(viewfinderWidth * 0.94));
            const h = Math.max(110, Math.floor(Math.min(viewfinderHeight * 0.58, w * 0.72)));
            return { width: w, height: h };
          },
        };

        let started = false;
        let lastErrorMsg = '';

        for (const attempt of attempts) {
          try {
            const candidateScanner = createFreshScanner();
            await candidateScanner.start(
              attempt,
              scanConfig,
              (decodedText) => handleScannedCode(decodedText),
              () => {}
            );
            scannerRef.current = candidateScanner;
            started = true;
            break;
          } catch (attemptErr: any) {
            lastErrorMsg = attemptErr?.message || String(attemptErr);
            console.info('Camera start attempt note:', attemptErr?.name || lastErrorMsg);
          }
        }

        if (!started) {
          if (isMountedRef.current) {
            setIsScanning(false);
            const inIframe = typeof window !== 'undefined' && window.self !== window.top;
            if (inIframe) {
              setCameraError(
                'Continuous video camera is restricted inside the preview iframe. Use "Snap Photo of Part" below (works 100% in preview) or open PartTrack in a dedicated browser tab.'
              );
            } else {
              setCameraError(
                lastErrorMsg.includes('Permission') || lastErrorMsg.includes('NotAllowed')
                  ? 'Camera permission was denied. Please allow camera access in your browser settings or tap "Grant Camera Access" below.'
                  : 'Unable to start continuous camera stream. Tap "Snap Photo of Part" to scan barcodes via camera.'
              );
            }
          }
          return;
        }

        if (isMountedRef.current) {
          setIsScanning(true);
          setCameraError(null);
        }

        // Configure continuous autofocus, torch check, and hardware zoom on the live video track
        setTimeout(() => {
          configureTrackFocusAndCapabilities();
          startNativeBarcodeLoop();
        }, 250);
      } catch (err: any) {
        console.warn('Camera start error:', err?.message || err);
        if (isMountedRef.current) {
          setIsScanning(false);
          const inIframe = typeof window !== 'undefined' && window.self !== window.top;
          setCameraError(
            inIframe
              ? 'Preview iframe restricted video stream. Use "Snap Photo of Part" to scan with camera.'
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
      handleScannedCode,
      selectedCameraId,
      configureTrackFocusAndCapabilities,
      startNativeBarcodeLoop,
    ]
  );

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
            video: true,
            audio: false,
          });
          stream.getTracks().forEach((track) => track.stop());
        } catch (permErr: any) {
          console.warn('getUserMedia direct permission result:', permErr?.name || permErr);
          if (permErr?.name === 'NotAllowedError' || permErr?.name === 'SecurityError') {
            const inIframe = typeof window !== 'undefined' && window.self !== window.top;
            if (inIframe) {
              setCameraError(
                'The preview iframe has blocked continuous video streaming. Tap "Scan Part Barcode (Camera)" below to scan using your camera directly (works 100% in preview).'
              );
              setIsStarting(false);
              return;
            }
          }
        }
      }
    } catch (e) {
      console.warn('Permission probe error:', e);
    }

    await startScanner();
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
    setSelectedCameraId(nextCameraId);
    await startScanner(nextCameraId);
  };

  /**
   * High-resolution image preparation with contrast & unsharp-mask barcode enhancement
   * so 1D barcodes (<numbers>-<No>) in snapped photos decode cleanly.
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

  const handleSnapPhoto = () => {
    if (snapFileInputRef.current) {
      snapFileInputRef.current.click();
    }
  };

  /**
   * Multi-Pass Photo Barcode & Label Decoder:
   * Pass 1: Native Android/Chrome BarcodeDetector on full-resolution image
   * Pass 2: High-res 2200px contrast-enhanced barcode scan via Html5Qrcode
   * Pass 3: 2x center-cropped barcode region via Html5Qrcode
   * Pass 4: Gemini AI Vision fallback (/api/read-part-label) to read blurry <numbers>-<No> barcode or printed text
   */
  const handleSnapFile = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const originalFile = files[0];
    setIsSnappingPhoto(true);

    try {
      let decodedText = '';

      // Pass 1: Try native hardware BarcodeDetector on full-res bitmap
      const BarcodeDetectorAPI = (window as any).BarcodeDetector;
      if (BarcodeDetectorAPI && typeof createImageBitmap === 'function') {
        try {
          const detector = new BarcodeDetectorAPI();
          const bitmap = await createImageBitmap(originalFile);
          const barcodes = await detector.detect(bitmap);
          bitmap.close?.();
          if (barcodes && barcodes.length > 0) {
            const hyphenMatch = barcodes.find(
              (b: any) =>
                b.rawValue && parseBarcodeDocketNo(String(b.rawValue)).hasDashFormat
            );
            const chosen = hyphenMatch || barcodes[0];
            if (chosen?.rawValue) {
              decodedText = String(chosen.rawValue).trim();
            }
          }
        } catch {}
      }

      // Prepare high-res variants
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

        // Pass 2: High-res 2200px contrast-enhanced scan
        try {
          decodedText = await offscreenScanner.scanFile(highResVariant.file, false);
        } catch {
          // Pass 3: 2x center-cropped scan for small 1D barcodes
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

      // Pass 4: Fallback to Gemini AI Vision (/api/read-part-label) for blurry or damaged <numbers>-<No> labels
      if (!decodedText && highResVariant.base64) {
        try {
          const currentParts = (deliveryRef.current?.parts || []).map((p, idx) => ({
            no: formatDocketNoBadge(p, idx),
            partNumber: p.partNumber,
            description: p.description,
          }));
          const resp = await fetch('/api/read-part-label', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              imageBase64: highResVariant.base64,
              mimeType: 'image/jpeg',
              docketParts: currentParts,
            }),
          });
          if (resp.ok) {
            const data = await resp.json();
            if (data?.scannedCode) {
              decodedText = String(data.scannedCode).trim();
            } else if (data?.docketNo) {
              decodedText = `0000-${data.docketNo}`;
            } else if (data?.partNumber) {
              decodedText = String(data.partNumber).trim();
            }
          }
        } catch (aiErr) {
          console.info('Gemini label reader fallback note:', aiErr);
        }
      }

      if (decodedText) {
        handleScannedCode(decodedText);
      } else {
        throw new Error('No barcode or label code found');
      }
    } catch (err: any) {
      console.info('Snapshot decode note:', err);
      playAudio.unexpected();
      speakAlert('Could not read code in photo');
      setScanFeedback({
        type: 'unexpected',
        code: 'PHOTO SCAN',
        message:
          'Could not detect barcode. Hold ~20cm away so the label is in sharp focus and try again.',
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
   * Handle user clicking a manual tick button on an item in the side list
   */
  const handleRequestTick = (part: DeliveryPart, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmTickPart(part);
  };

  /**
   * Execute manual verification after user confirms in the prompt
   */
  const handleConfirmManualTick = () => {
    if (!confirmTickPart || !delivery) return;

    const newStatus = confirmTickPart.status === 'received' ? 'outstanding' : 'received';
    const updated = setPartStatus(delivery.id, confirmTickPart.id, newStatus, 'manual');

    if (newStatus === 'received') {
      const docketNoStr = formatDocketNoBadge(confirmTickPart);
      // Visual flash on camera screen
      triggerVisualFlash('green');
      // Little beep chime
      playAudio.success();
      triggerHaptic('success');
      speakAlert(`Manually verified Number ${docketNoStr}, ${confirmTickPart.partNumber}`);

      // Promote to top of the side list in green
      setJustScannedPartId(confirmTickPart.id);
      if (justScannedTimeoutRef.current) clearTimeout(justScannedTimeoutRef.current);
      justScannedTimeoutRef.current = setTimeout(() => {
        setJustScannedPartId(null);
      }, 6000);

      // Auto-scroll side list to top
      partsListScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });

      setScanFeedback({
        type: 'success',
        code: confirmTickPart.partNumber,
        matchedPart: { ...confirmTickPart, status: 'received' },
        message: `Manually verified No. ${docketNoStr} (${confirmTickPart.partNumber})`,
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

    // If a part was just scanned, promote it to index 0 at the very top of the list!
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
    };
  }, []);

  const outstandingSample = delivery?.parts.find((p) => p.status === 'outstanding');
  const latestHistoricalScan = delivery?.scanHistory?.[0];

  // Apply CSS digital zoom fallback if the device camera doesn't expose hardware zoom
  const cssZoomStyle =
    !supportsHardwareZoom && zoomLevel > 1
      ? { transform: `scale(${zoomLevel})`, transformOrigin: 'center center' }
      : undefined;

  return (
    <div
      className={`fixed inset-x-0 top-11 bottom-12 z-20 bg-[#0F0F0E] overflow-hidden select-none flex ${
        mobileViewMode === 'split' ? 'flex-col md:flex-row' : 'flex-row'
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

      {/* Dedicated hidden offscreen container for static image barcode decoding */}
      <div id="parttrack-offscreen-scanner" className="hidden" aria-hidden="true" />

      {/* ============================================================ */}
      {/* SECTION 1: Camera Viewport with HUD, Zoom & Flash Feedback    */}
      {/* ============================================================ */}
      <div
        className={`relative flex flex-col bg-black overflow-hidden min-h-0 min-w-0 transition-all duration-200 ${
          mobileViewMode === 'camera'
            ? 'h-full w-full flex-1'
            : mobileViewMode === 'list'
            ? 'hidden md:flex md:h-full md:flex-1'
            : mobileViewMode === 'split'
            ? 'h-[55%] md:h-full w-full flex-1'
            : 'h-full flex-1'
        }`}
      >
        {/* Inner Camera Stage (Tap anywhere to refocus!) */}
        <div
          onClick={handleTapToFocus}
          className="relative flex-1 min-h-0 w-full overflow-hidden bg-black cursor-crosshair"
        >
          <div
            id="camera-scanner-view"
            style={cssZoomStyle}
            className="w-full h-full transition-transform duration-200 [&_video]:w-full [&_video]:h-full [&_video]:object-cover [&_[id$='__scan_region']_img]:hidden"
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

          {/* Top Translucent HUD: Progress + Utility Controls */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute top-0 inset-x-0 z-35 px-2.5 py-2 bg-gradient-to-b from-black/90 via-black/50 to-transparent flex items-center justify-between gap-1.5 flex-wrap"
          >
            {/* Progress Counter */}
            <div className="flex items-center gap-1.5">
              {delivery ? (
                <>
                  <span className="font-mono text-xs font-bold text-white tabular-nums">
                    {receivedParts}/{totalParts}
                  </span>
                  <div className="hidden sm:block w-12 h-1 bg-white/20 overflow-hidden rounded-full">
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
            </div>

            {/* Camera Action Controls */}
            <div className="flex items-center gap-1">
              {/* Direct Camera Photo Snapshot Button */}
              <button
                onClick={handleSnapPhoto}
                disabled={isSnappingPhoto}
                className="h-7 px-2 rounded-[3px] bg-[#059669] hover:bg-[#047857] text-white text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition-colors shadow-sm"
                title="Photograph part barcode or QR code with camera"
              >
                <Camera className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">
                  {isSnappingPhoto ? 'Decoding...' : 'Snap'}
                </span>
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
                className="h-7 px-2 rounded-[3px] bg-white/15 hover:bg-white/25 backdrop-blur-md text-white text-[11px] font-medium flex items-center gap-1 cursor-pointer transition-colors"
                title="Enter barcode (e.g. 48291-03) or Docket No. manually"
              >
                <Keyboard className="w-3 h-3" />
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
                  title="Switch camera lens"
                >
                  <FlipHorizontal className="w-3.5 h-3.5" />
                </button>
              )}

              {/* View Mode Switcher: Side-by-Side / Top-Bottom / Full Cam */}
              <div className="flex md:hidden items-center bg-white/10 rounded-[3px] p-0.5 border border-white/10">
                <button
                  onClick={() => setMobileViewMode('side')}
                  className={`px-1.5 py-0.5 rounded-[2px] text-[10px] font-mono cursor-pointer transition-colors ${
                    mobileViewMode === 'side' ? 'bg-[#059669] text-white font-bold' : 'text-zinc-300'
                  }`}
                  title="Side-by-Side (Camera + Side List)"
                >
                  Side
                </button>
                <button
                  onClick={() => setMobileViewMode('split')}
                  className={`px-1.5 py-0.5 rounded-[2px] text-[10px] font-mono cursor-pointer transition-colors ${
                    mobileViewMode === 'split' ? 'bg-[#059669] text-white font-bold' : 'text-zinc-300'
                  }`}
                  title="Top/Bottom Split"
                >
                  <Split className="w-3 h-3" />
                </button>
                <button
                  onClick={() => setMobileViewMode('camera')}
                  className={`px-1.5 py-0.5 rounded-[2px] text-[10px] font-mono cursor-pointer transition-colors ${
                    mobileViewMode === 'camera' ? 'bg-[#059669] text-white font-bold' : 'text-zinc-300'
                  }`}
                  title="Full Camera"
                >
                  <Camera className="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>

          {/* Wide 1D Barcode Targeting Reticle */}
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center p-2.5">
            <div
              className={`relative w-[92%] max-w-[260px] h-[115px] transition-transform duration-200 ${
                flashColor === 'green' ? 'scale-[1.03]' : ''
              }`}
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
                    : 'border-white/85'
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
                    : 'border-white/85'
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
                    : 'border-white/85'
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
                    : 'border-white/85'
                }`}
              />

              {/* Subtle Laser Scan Line */}
              {isScanning && (
                <div className="absolute inset-x-2 h-[1.5px] bg-[#10B981]/90 shadow-[0_0_8px_#10B981] animate-laser-scan" />
              )}
            </div>

            <span className="mt-2 px-2 py-0.5 rounded bg-black/55 backdrop-blur-xs text-[10px] font-mono text-white/90 tracking-wide text-center">
              {isScanning
                ? 'Scan Barcode (######-No) → Matches Docket "No"'
                : 'Aim at barcode or tap "Snap"'}
            </span>
          </div>

          {/* Bottom-Center Live Zoom & Refocus Controls (Prevents close-up blur!) */}
          {isScanning && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute bottom-2 inset-x-0 z-30 flex items-center justify-center gap-1.5 px-2"
            >
              <div className="flex items-center gap-0.5 bg-black/75 backdrop-blur-md border border-white/15 rounded-[4px] p-0.5 shadow-lg">
                <span className="px-1.5 text-[9px] font-mono text-zinc-400 flex items-center gap-0.5">
                  <ZoomIn className="w-2.5 h-2.5 text-emerald-400" />
                  <span className="hidden sm:inline">Zoom</span>
                </span>
                {[1, 1.5, 2, 3]
                  .filter((z) => !supportsHardwareZoom || z <= maxHardwareZoom)
                  .map((z) => (
                    <button
                      key={z}
                      type="button"
                      onClick={(e) => handleSelectZoom(z, e)}
                      className={`px-1.5 py-0.5 rounded-[3px] font-mono text-[10px] cursor-pointer transition-colors ${
                        zoomLevel === z
                          ? 'bg-[#059669] text-white font-bold shadow-xs'
                          : 'text-zinc-300 hover:text-white hover:bg-white/10'
                      }`}
                      title={`Zoom ${z}x (Hold phone ~20cm back and use 1.5x/2x for sharp barcode focus)`}
                    >
                      {z}x
                    </button>
                  ))}
              </div>

              <button
                type="button"
                onClick={() => configureTrackFocusAndCapabilities()}
                className="h-6 px-2 rounded-[4px] bg-black/75 hover:bg-black/90 backdrop-blur-md border border-white/15 text-zinc-200 text-[10px] font-mono flex items-center gap-1 cursor-pointer shadow-lg"
                title="Tap to re-lock autofocus"
              >
                <Focus className="w-3 h-3 text-emerald-400" />
                <span className="hidden sm:inline">Focus</span>
              </button>
            </div>
          )}

          {/* Camera Permission / Fallback Overlay */}
          {(cameraError || (!isScanning && !isStarting)) && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute inset-0 z-30 bg-[#141413]/95 pt-11 px-3 pb-3 flex flex-col items-center justify-center text-center overflow-y-auto"
            >
              <div className="w-8 h-8 rounded-full bg-[#10B981]/15 text-[#10B981] flex items-center justify-center mb-2 shrink-0">
                <Camera className="w-4 h-4" />
              </div>

              <h3 className="text-xs font-semibold text-white mb-1">
                {isInsideIframe ? 'Camera Barcode Scanner' : 'Camera Access'}
              </h3>

              <p className="text-[11px] text-zinc-300 max-w-xs leading-snug mb-2.5">
                {isInsideIframe
                  ? 'Tap below to photograph a part barcode with your camera, or start live video scanning.'
                  : cameraError ||
                    'Photograph labels directly with your camera or enable live continuous scanning.'}
              </p>

              <div className="flex flex-col items-center gap-1.5 w-full max-w-[230px]">
                <button
                  onClick={handleSnapPhoto}
                  disabled={isSnappingPhoto}
                  className="w-full h-8 px-2.5 rounded-[4px] bg-[#059669] hover:bg-[#047857] text-white font-semibold text-[11px] flex items-center justify-center gap-1.5 cursor-pointer transition-colors shadow-md"
                >
                  <Camera className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">
                    {isSnappingPhoto ? 'Decoding...' : 'Scan Part Barcode (Camera)'}
                  </span>
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
                    <span className="truncate">Compile Docket with Gemini AI</span>
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
              : scanFeedback?.type === 'duplicate'
              ? 'bg-amber-500 text-white border-amber-600'
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
                    ) : scanFeedback.type === 'duplicate' ? (
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

                {scanFeedback.type === 'success' && (
                  <button
                    onClick={handleUndo}
                    className="h-6 px-2 rounded-[3px] bg-black/20 hover:bg-black/30 text-white font-medium text-[11px] flex items-center gap-1 shrink-0 cursor-pointer transition-colors"
                  >
                    <RotateCcw className="w-2.5 h-2.5" />
                    <span>Undo</span>
                  </button>
                )}
              </>
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
                  Scan barcode (######-No) · Matches Docket &quot;No&quot;
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
      {/* SECTION 2: Side Scrollable Docket Parts List Window          */}
      {/* ============================================================ */}
      <div
        className={`border-zinc-800 bg-[#141413] flex flex-col shrink-0 z-10 min-h-0 overflow-hidden transition-all duration-200 ${
          mobileViewMode === 'camera'
            ? 'hidden md:flex md:w-80 lg:w-96 md:h-full md:border-l'
            : mobileViewMode === 'list'
            ? 'h-full w-full flex-1 md:w-80 lg:w-96 md:flex-none md:border-l'
            : mobileViewMode === 'split'
            ? 'h-[45%] w-full border-t md:h-full md:w-80 lg:w-96 md:border-t-0 md:border-l'
            : 'w-[45%] max-w-[260px] sm:max-w-none sm:w-72 md:w-80 lg:w-96 h-full border-l'
        }`}
      >
        {/* Side Header: Docket info & filter bar */}
        <div className="p-2.5 border-b border-zinc-800/80 bg-[#18181B] shrink-0">
          <div className="flex items-center justify-between gap-1.5 mb-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <ListChecks className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <h2 className="text-[11px] font-bold text-white uppercase tracking-wider truncate">
                Docket Parts
              </h2>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <span className="font-mono text-[11px] font-bold text-white tabular-nums">
                {receivedParts}/{totalParts}
              </span>
              <span className="px-1.5 py-0.5 rounded-[3px] bg-emerald-500/15 text-emerald-400 font-mono text-[10px] font-semibold">
                {percentage}%
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

        {/* Scrollable Parts List (strictly isolated scroll container) */}
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
              const isReceived = part.status === 'received';
              const docketNoBadge = formatDocketNoBadge(part, idx);

              return (
                <div
                  key={part.id}
                  className={`relative flex items-center justify-between p-2.5 transition-all duration-300 cursor-pointer ${
                    isJustScanned
                      ? 'bg-emerald-950/80 border-l-4 border-emerald-400 shadow-md ring-1 ring-emerald-500/30'
                      : isReceived
                      ? 'bg-white/[0.01] hover:bg-white/[0.04]'
                      : 'hover:bg-white/[0.03]'
                  }`}
                  onClick={(e) => handleRequestTick(part, e)}
                  title="Click to manually verify or unverify"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1 pr-1.5">
                    {/* Interactive Tick / Check Button with Double-Check Prompt */}
                    <button
                      type="button"
                      onClick={(e) => handleRequestTick(part, e)}
                      className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 border transition-all cursor-pointer ${
                        isReceived
                          ? 'bg-[#10B981] border-[#10B981] text-white shadow-xs'
                          : 'border-zinc-600 hover:border-emerald-400 text-transparent hover:text-emerald-400/50 hover:bg-emerald-500/10'
                      }`}
                      title={
                        isReceived
                          ? 'Received · Tap to double check and unverify'
                          : 'Pending · Tap to double check and mark received'
                      }
                    >
                      <Check className="w-3.5 h-3.5 stroke-[3]" />
                    </button>

                    {/* Part Details + Prominent Docket "No." Badge */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {/* Docket "No." Cross-Reference Pill */}
                        <span
                          className={`px-1.5 py-0.5 rounded-[3px] font-mono text-[10px] font-bold shrink-0 ${
                            isJustScanned
                              ? 'bg-emerald-500 text-black'
                              : isReceived
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-zinc-800 text-amber-300 border border-zinc-700'
                          }`}
                          title={`Docket No. ${docketNoBadge} (matches barcode -${docketNoBadge})`}
                        >
                          No. {docketNoBadge}
                        </span>

                        <span
                          className={`font-mono text-xs font-bold tracking-tight truncate ${
                            isJustScanned
                              ? 'text-emerald-300'
                              : isReceived
                              ? 'text-zinc-200'
                              : 'text-white'
                          }`}
                        >
                          {part.partNumber}
                        </span>

                        {isJustScanned && (
                          <span className="px-1 py-0.2 rounded-[2px] bg-emerald-500/25 border border-emerald-400/40 text-emerald-300 font-mono text-[8px] font-bold tracking-wider uppercase flex items-center gap-0.5 animate-pulse">
                            <Sparkles className="w-2 h-2 text-emerald-300" />
                            Just Scanned
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 text-[10px] text-zinc-400 truncate mt-0.5">
                        <span className="truncate max-w-[150px]">{part.description}</span>
                        {(part.thickness || part.material || part.dimensions) && (
                          <span className="px-1 py-0.2 rounded-[2px] bg-zinc-800/90 text-zinc-300 font-mono text-[9px] shrink-0">
                            {[part.thickness, part.material, part.dimensions].filter(Boolean).join(' · ')}
                          </span>
                        )}
                        {part.palletNumber && (
                          <span className="px-1 py-0.2 rounded-[2px] bg-zinc-800 text-zinc-400 font-mono text-[9px] shrink-0">
                            {String(part.palletNumber).replace(/^Pallet\s*/i, 'P')}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Status Indicator Pill */}
                  <div className="shrink-0 flex items-center">
                    {isReceived ? (
                      <span className="px-1.5 py-0.5 rounded-[3px] bg-[#10B981]/15 text-[#10B981] font-mono text-[10px] font-semibold flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#10B981]" />
                        Recv&apos;d
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
          <span>{delivery?.docketNumber || 'No docket'}</span>
          <span className="font-mono text-zinc-300">
            {receivedParts} received · {outstandingParts} remaining
          </span>
        </div>
      </div>

      {/* ============================================================ */}
      {/* MODAL 1: Double-Check Manual Tick Confirmation Prompt       */}
      {/* ============================================================ */}
      {confirmTickPart && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-[#1C1C1E] border border-zinc-700/80 rounded-[8px] p-4.5 shadow-2xl text-white animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-start gap-3 mb-3.5">
              <div
                className={`w-9 h-9 rounded-[6px] flex items-center justify-center shrink-0 ${
                  confirmTickPart.status === 'outstanding'
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                }`}
              >
                {confirmTickPart.status === 'outstanding' ? (
                  <Check className="w-5 h-5 stroke-[2.5]" />
                ) : (
                  <AlertTriangle className="w-5 h-5" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold text-sm text-white">
                  {confirmTickPart.status === 'outstanding'
                    ? 'Confirm Manual Verification'
                    : 'Undo Part Verification'}
                </h3>
                <p className="text-xs text-zinc-400 mt-0.5 leading-relaxed">
                  {confirmTickPart.status === 'outstanding'
                    ? 'Double-check: Do you want to manually mark this part as received without scanning?'
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
                  No. {formatDocketNoBadge(confirmTickPart)}
                </span>
              </div>
              <p className="text-xs text-zinc-300 truncate">
                {confirmTickPart.description}
              </p>
              {confirmTickPart.palletNumber && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="px-1.5 py-0.5 rounded-[3px] bg-zinc-800 text-zinc-300 font-mono text-[10px]">
                    Pallet {confirmTickPart.palletNumber}
                  </span>
                  {confirmTickPart.material && (
                    <span className="text-[10px] text-zinc-400 font-mono">
                      {confirmTickPart.material}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Prompt Actions */}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmTickPart(null)}
                className="h-8 px-3.5 rounded-[4px] border border-zinc-700 bg-transparent hover:bg-zinc-800 text-zinc-300 text-xs font-medium cursor-pointer transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmManualTick}
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
                Enter Barcode (######-No) or Docket No
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
                  handleScannedCode(manualCodeInput.trim());
                  setManualCodeInput('');
                  setIsManualModalOpen(false);
                }
              }}
            >
              <input
                type="text"
                autoFocus
                value={manualCodeInput}
                onChange={(e) => setManualCodeInput(e.target.value)}
                placeholder="Barcode (e.g. 482910-3) or Docket No."
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
                    482910-{formatDocketNoBadge(outstandingSample)} (Docket No.{' '}
                    {formatDocketNoBadge(outstandingSample)})
                  </button>
                  <button
                    type="button"
                    onClick={() => setManualCodeInput(outstandingSample.partNumber)}
                    className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded-[3px] font-mono text-white cursor-pointer"
                  >
                    {outstandingSample.partNumber}
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
    </div>
  );
};
