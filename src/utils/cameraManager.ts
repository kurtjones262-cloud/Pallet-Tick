/**
 * PalletTrack Application-Wide Camera & Scanner Management Layer
 *
 * Centralises:
 * 1. Task-specific camera profiles (GCI QR Fast 720p, Laser Central 1D Barcode 1080p, OCR Label High-Detail 1080p).
 * 2. Multi-lens rear camera ranking (prioritising primary wide PDAF sensor on devices like Samsung S25 Ultra).
 * 3. Continuous autofocus, continuous auto-exposure, continuous white-balance, and in-place resolution switching
 *    without tearing down the active MediaStream.
 * 4. Native BarcodeDetector capability inspection (verifying format support for QR vs 1D Code-128/Code-39).
 * 5. Still-frame / uploaded-file barcode & QR fast-path detection for manual shutter capture and gallery imports.
 * 6. Application-wide real-time camera & decoder diagnostics telemetry.
 */

import { isIgnoredNonPartQrPayload } from './ignoredQrCodes';

export type ScanMode = 'laser_central' | 'gci' | 'ocr_label';

export interface CameraProfileConfig {
  mode: ScanMode;
  profileId: 'gci_qr_fast' | 'laser_central_1d_hd' | 'ocr_label_1080p_sharp';
  profileLabel: string;
  idealWidth: number;
  idealHeight: number;
  minWidth: number;
  minHeight: number;
  idealFrameRate: number;
  minFrameRate: number;
  scanIntervalMs: number;
  scanFrequencyHz: number;
  nativeFormats: string[];
  requiredFormats: string[];
  enableBackgroundOcr: boolean;
  ocrIntervalMs: number | null;
}

export const CAMERA_PROFILES: Record<ScanMode, CameraProfileConfig> = {
  gci: {
    mode: 'gci',
    profileId: 'gci_qr_fast',
    profileLabel: 'GCI QR Fast (720p @ 30fps)',
    idealWidth: 1280,
    idealHeight: 720,
    minWidth: 640,
    minHeight: 480,
    idealFrameRate: 30,
    minFrameRate: 24,
    scanIntervalMs: 45,
    scanFrequencyHz: 22.2,
    nativeFormats: ['qr_code'],
    requiredFormats: ['qr_code'],
    enableBackgroundOcr: false,
    ocrIntervalMs: null,
  },
  laser_central: {
    mode: 'laser_central',
    profileId: 'laser_central_1d_hd',
    profileLabel: 'Laser Central 1D HD (1080p @ 30fps)',
    idealWidth: 1920,
    idealHeight: 1080,
    minWidth: 1280,
    minHeight: 720,
    idealFrameRate: 30,
    minFrameRate: 24,
    scanIntervalMs: 60,
    scanFrequencyHz: 16.7,
    nativeFormats: [
      'code_128',
      'code_39',
      'code_93',
      'codabar',
      'ean_13',
      'ean_8',
      'itf',
      'upc_a',
      'upc_e',
      'qr_code',
      'data_matrix',
      'pdf417',
    ],
    requiredFormats: ['code_128', 'code_39'],
    enableBackgroundOcr: false,
    ocrIntervalMs: null,
  },
  ocr_label: {
    mode: 'ocr_label',
    profileId: 'ocr_label_1080p_sharp',
    profileLabel: 'OCR Label HD (1080p @ 30fps + Unsharp)',
    idealWidth: 1920,
    idealHeight: 1080,
    minWidth: 1280,
    minHeight: 720,
    idealFrameRate: 24,
    minFrameRate: 15,
    scanIntervalMs: 85,
    scanFrequencyHz: 11.8,
    nativeFormats: [
      'code_128',
      'code_39',
      'code_93',
      'ean_13',
      'itf',
      'upc_a',
      'qr_code',
      'data_matrix',
    ],
    requiredFormats: ['code_128', 'qr_code'],
    enableBackgroundOcr: true,
    ocrIntervalMs: 1350,
  },
};

export interface CameraScannerDiagnostics {
  activeMode: ScanMode;
  cameraProfile: string;
  cameraDeviceLabel: string;
  cameraDeviceId: string;
  resolution: string;
  frameRate: number;
  supportedFocusModes: string[];
  activeFocusMode: string;
  supportedExposureModes: string[];
  activeExposureMode: string;
  supportedWhiteBalanceModes: string[];
  activeWhiteBalanceMode: string;
  decoderEngine: string;
  scanFrequencyHz: number;
  scanIntervalMs: number;
  avgDecodeMs: number;
  lastDecodeMs: number;
  lastRecognitionTimeMs: number | null;
  lastRecognitionTimestamp: string | null;
  decodeAttemptsBeforeMatch: number;
  totalDecodeAttempts: number;
  singleFlightActive: boolean;
  concurrentDecodersCount: number;
  multipleDecodersActive: boolean;
  streamStatus: 'idle' | 'initializing' | 'active' | 'reconfiguring' | 'fallback_file' | 'error';
  zoomSupported: boolean;
  zoomMin: number;
  zoomMax: number;
  zoomCurrent: number;
  torchSupported: boolean;
}

export function createInitialDiagnostics(mode: ScanMode = 'gci'): CameraScannerDiagnostics {
  const profile = CAMERA_PROFILES[mode];
  return {
    activeMode: mode,
    cameraProfile: profile.profileLabel,
    cameraDeviceLabel: 'Initializing...',
    cameraDeviceId: '',
    resolution: '0x0',
    frameRate: 0,
    supportedFocusModes: [],
    activeFocusMode: 'unknown',
    supportedExposureModes: [],
    activeExposureMode: 'unknown',
    supportedWhiteBalanceModes: [],
    activeWhiteBalanceMode: 'unknown',
    decoderEngine: 'detecting...',
    scanFrequencyHz: profile.scanFrequencyHz,
    scanIntervalMs: profile.scanIntervalMs,
    avgDecodeMs: 0,
    lastDecodeMs: 0,
    lastRecognitionTimeMs: null,
    lastRecognitionTimestamp: null,
    decodeAttemptsBeforeMatch: 0,
    totalDecodeAttempts: 0,
    singleFlightActive: false,
    concurrentDecodersCount: 0,
    multipleDecodersActive: false,
    streamStatus: 'idle',
    zoomSupported: false,
    zoomMin: 1,
    zoomMax: 1,
    zoomCurrent: 1,
    torchSupported: false,
  };
}

/**
 * Ranks available videoinput devices so the primary rear wide-angle camera (with fast Dual-Pixel PDAF & OIS)
 * is selected first on multi-camera phones like the Samsung S25 Ultra, avoiding ultra-wide, macro, or telephoto lenses.
 */
export function rankRearVideoDevices(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  const videoDevices = devices.filter((d) => d.kind === 'videoinput');
  if (videoDevices.length <= 1) return videoDevices;

  const scoreDevice = (device: MediaDeviceInfo, index: number): number => {
    const label = (device.label || '').toLowerCase();
    let score = 0;

    // Exclude or heavily penalize front/selfie cameras
    if (/\b(front|user|selfie|facetime)\b/i.test(label)) {
      return -1000;
    }

    // Reward rear/environment indicators
    if (/\b(back|rear|environment|world)\b/i.test(label)) {
      score += 100;
    }

    // Penalize auxiliary lenses that struggle with close-up barcode focus or distort QR geometry
    if (/\b(ultra[\s-]?wide|uw|0\.5x|0\.6x)\b/i.test(label)) {
      score -= 60;
    }
    if (/\b(tele|telephoto|periscope|3x|5x|10x|zoom)\b/i.test(label)) {
      score -= 50;
    }
    if (/\b(macro|depth|tof|bokeh|virtual)\b/i.test(label)) {
      score -= 80;
    }

    // On Android Chrome (e.g. Samsung S25 Ultra), "camera2 0, facing back" is the primary main sensor
    if (/\b(camera2?\s*0|main|primary|wide|1x)\b/i.test(label) && !/ultra/i.test(label)) {
      score += 50;
    }

    // Prefer earlier enumeration index among equal rear candidates (camera 0 is standard primary rear on Android)
    score -= index * 2;
    return score;
  };

  return [...videoDevices]
    .map((device, index) => ({ device, score: scoreDevice(device, index) }))
    .filter((entry) => entry.score > -500)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.device);
}

/**
 * Builds prioritized MediaStreamConstraints for opening the rear camera in the given scan mode.
 */
export function buildCameraStreamConstraints(
  mode: ScanMode,
  preferredDeviceId?: string
): MediaStreamConstraints[] {
  const profile = CAMERA_PROFILES[mode];
  const baseAdvanced: Record<string, any>[] = [
    { focusMode: 'continuous' },
    { exposureMode: 'continuous' },
    { whiteBalanceMode: 'continuous' },
  ];

  const constraintsList: MediaStreamConstraints[] = [];

  if (preferredDeviceId) {
    constraintsList.push({
      audio: false,
      video: {
        deviceId: { exact: preferredDeviceId },
        width: { ideal: profile.idealWidth, min: profile.minWidth },
        height: { ideal: profile.idealHeight, min: profile.minHeight },
        frameRate: { ideal: profile.idealFrameRate, min: profile.minFrameRate },
        advanced: baseAdvanced,
      } as any,
    });
  }

  // Primary environment constraint with profile resolution + continuous focus/exposure/WB hints
  constraintsList.push({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: profile.idealWidth, min: profile.minWidth },
      height: { ideal: profile.idealHeight, min: profile.minHeight },
      frameRate: { ideal: profile.idealFrameRate, min: profile.minFrameRate },
      advanced: baseAdvanced,
    } as any,
  });

  // Fallback environment constraint with standard 720p ideal
  constraintsList.push({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
  });

  // Broadest environment fallback
  constraintsList.push({
    audio: false,
    video: { facingMode: 'environment' },
  });

  // Final any-camera fallback (e.g. desktop webcam)
  constraintsList.push({
    audio: false,
    video: true,
  });

  return constraintsList;
}

export interface AppliedTrackConfiguration {
  cameraProfile: string;
  cameraDeviceLabel: string;
  cameraDeviceId: string;
  resolution: string;
  frameRate: number;
  supportedFocusModes: string[];
  activeFocusMode: string;
  supportedExposureModes: string[];
  activeExposureMode: string;
  supportedWhiteBalanceModes: string[];
  activeWhiteBalanceMode: string;
  zoomSupported: boolean;
  zoomMin: number;
  zoomMax: number;
  zoomCurrent: number;
  torchSupported: boolean;
}

/**
 * Inspects the active MediaStreamTrack capabilities, applies the mode's resolution profile,
 * and enables continuous autofocus, continuous auto-exposure, and continuous white-balance
 * without restarting the camera stream.
 */
export async function applyCameraProfileToTrack(
  track: MediaStreamTrack,
  mode: ScanMode,
  requestedZoom?: number
): Promise<AppliedTrackConfiguration> {
  const profile = CAMERA_PROFILES[mode];
  const rawCapabilities: any =
    typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
  const initialSettings: any =
    typeof track.getSettings === 'function' ? track.getSettings() : {};

  const supportedFocusModes: string[] = Array.isArray(rawCapabilities?.focusMode)
    ? rawCapabilities.focusMode
    : [];
  const supportedExposureModes: string[] = Array.isArray(rawCapabilities?.exposureMode)
    ? rawCapabilities.exposureMode
    : [];
  const supportedWhiteBalanceModes: string[] = Array.isArray(rawCapabilities?.whiteBalanceMode)
    ? rawCapabilities.whiteBalanceMode
    : [];

  // 1. Apply mode resolution & frameRate constraints in-place if track supports applyConstraints
  if (typeof track.applyConstraints === 'function') {
    try {
      await track.applyConstraints({
        width: { ideal: profile.idealWidth },
        height: { ideal: profile.idealHeight },
        frameRate: { ideal: profile.idealFrameRate },
      } as any);
    } catch {
      // Ignore if hardware locks resolution after stream start
    }

    // 2. Apply continuous autofocus, exposure, white-balance, and optional hardware zoom
    const advancedPatch: Record<string, any> = {};

    if (supportedFocusModes.includes('continuous')) {
      advancedPatch.focusMode = 'continuous';
    } else if (supportedFocusModes.includes('single-shot')) {
      advancedPatch.focusMode = 'single-shot';
    }

    if (supportedExposureModes.includes('continuous')) {
      advancedPatch.exposureMode = 'continuous';
    }

    if (supportedWhiteBalanceModes.includes('continuous')) {
      advancedPatch.whiteBalanceMode = 'continuous';
    }

    const zoomCap = rawCapabilities?.zoom;
    const zoomSupported =
      zoomCap !== undefined &&
      (typeof zoomCap === 'number' ||
        (typeof zoomCap === 'object' && typeof zoomCap.max === 'number' && zoomCap.max > 1));

    if (zoomSupported && typeof requestedZoom === 'number') {
      const zMin = typeof zoomCap === 'object' && typeof zoomCap.min === 'number' ? zoomCap.min : 1;
      const zMax = typeof zoomCap === 'object' && typeof zoomCap.max === 'number' ? zoomCap.max : 4;
      advancedPatch.zoom = Math.min(zMax, Math.max(zMin, requestedZoom));
    }

    if (Object.keys(advancedPatch).length > 0) {
      try {
        await track.applyConstraints({ advanced: [advancedPatch] } as any);
      } catch {
        try {
          await track.applyConstraints(advancedPatch as any);
        } catch {
          // Best-effort fallback: apply focusMode alone if combined patch was rejected
          if (advancedPatch.focusMode) {
            try {
              await track.applyConstraints({
                advanced: [{ focusMode: advancedPatch.focusMode }],
              } as any);
            } catch {
              // Ignore
            }
          }
        }
      }
    } else {
      // Unadvertised focusMode hint for mobile WebViews that accept focusMode without listing it
      try {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as any);
      } catch {
        // Ignore if unsupported
      }
    }
  }

  const finalSettings: any =
    typeof track.getSettings === 'function' ? track.getSettings() : initialSettings;

  const zoomCap = rawCapabilities?.zoom;
  const zoomSupported =
    zoomCap !== undefined &&
    (typeof zoomCap === 'number' ||
      (typeof zoomCap === 'object' && typeof zoomCap.max === 'number' && zoomCap.max > 1));
  const zoomMin =
    zoomSupported && typeof zoomCap === 'object' && typeof zoomCap.min === 'number'
      ? zoomCap.min
      : 1;
  const zoomMax =
    zoomSupported && typeof zoomCap === 'object' && typeof zoomCap.max === 'number'
      ? Math.min(zoomCap.max, 5)
      : 1;
  const zoomCurrent =
    typeof finalSettings?.zoom === 'number' ? finalSettings.zoom : zoomMin;

  const activeFocusMode =
    finalSettings?.focusMode ||
    (supportedFocusModes.includes('continuous')
      ? 'continuous'
      : supportedFocusModes[0] || 'auto-hardware');
  const activeExposureMode =
    finalSettings?.exposureMode ||
    (supportedExposureModes.includes('continuous')
      ? 'continuous'
      : supportedExposureModes[0] || 'auto');
  const activeWhiteBalanceMode =
    finalSettings?.whiteBalanceMode ||
    (supportedWhiteBalanceModes.includes('continuous')
      ? 'continuous'
      : supportedWhiteBalanceModes[0] || 'auto');

  const width = finalSettings?.width || profile.idealWidth;
  const height = finalSettings?.height || profile.idealHeight;
  const frameRate = Math.round(finalSettings?.frameRate || profile.idealFrameRate);

  return {
    cameraProfile: profile.profileLabel,
    cameraDeviceLabel: track.label || 'Rear Environment Camera',
    cameraDeviceId: finalSettings?.deviceId || '',
    resolution: `${width}x${height}`,
    frameRate,
    supportedFocusModes,
    activeFocusMode,
    supportedExposureModes,
    activeExposureMode,
    supportedWhiteBalanceModes,
    activeWhiteBalanceMode,
    zoomSupported,
    zoomMin,
    zoomMax,
    zoomCurrent,
    torchSupported: Boolean(rawCapabilities?.torch),
  };
}

/**
 * Triggers a non-destructive autofocus pulse on the active video track (single-shot -> continuous)
 * to immediately recover sharp focus when the phone distance changes or the user taps the viewfinder.
 */
export async function triggerCameraRefocusPulse(track: MediaStreamTrack | null): Promise<string> {
  if (!track || typeof track.applyConstraints !== 'function') {
    return 'auto-hardware';
  }

  try {
    const capabilities: any =
      typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
    const focusModes: string[] = Array.isArray(capabilities?.focusMode)
      ? capabilities.focusMode
      : [];

    if (focusModes.includes('single-shot') && focusModes.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] } as any);
      await new Promise((resolve) => setTimeout(resolve, 140));
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as any);
      return 'continuous (refocused)';
    }

    if (focusModes.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as any);
      return 'continuous (refocused)';
    }

    if (focusModes.includes('single-shot')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] } as any);
      return 'single-shot (pulsed)';
    }

    await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as any);
    return 'continuous';
  } catch {
    return 'auto-hardware';
  }
}

/**
 * Creates a hardware-accelerated native BarcodeDetector for the given ScanMode, verifying that
 * the browser supports the required barcode formats for that mode.
 */
export async function createVerifiedNativeBarcodeDetector(
  mode: ScanMode
): Promise<{ detector: any | null; engineName: string; supportedFormats: string[] }> {
  const BarcodeDetectorCtor =
    typeof window !== 'undefined' ? (window as any).BarcodeDetector : undefined;

  if (!BarcodeDetectorCtor) {
    return {
      detector: null,
      engineName: 'Html5Qrcode (ZXing)',
      supportedFormats: [],
    };
  }

  const profile = CAMERA_PROFILES[mode];
  let advertisedFormats: string[] = [];

  if (typeof BarcodeDetectorCtor.getSupportedFormats === 'function') {
    try {
      const formats = await BarcodeDetectorCtor.getSupportedFormats();
      if (Array.isArray(formats)) {
        advertisedFormats = formats;
      }
    } catch {
      advertisedFormats = [];
    }
  }

  // Filter requested formats to those supported by the browser (if getSupportedFormats returned a list)
  const effectiveFormats =
    advertisedFormats.length > 0
      ? profile.nativeFormats.filter((f) => advertisedFormats.includes(f))
      : profile.nativeFormats;

  // Verify that all critical formats for this mode are supported
  const hasRequiredFormats =
    advertisedFormats.length === 0 ||
    profile.requiredFormats.every((req) => effectiveFormats.includes(req));

  if (!hasRequiredFormats || effectiveFormats.length === 0) {
    return {
      detector: null,
      engineName: 'Html5Qrcode (ZXing 1D Fallback)',
      supportedFormats: advertisedFormats,
    };
  }

  try {
    const detector = new BarcodeDetectorCtor({ formats: effectiveFormats });
    const engineName =
      mode === 'gci'
        ? 'BarcodeDetector (Native QR)'
        : mode === 'laser_central'
        ? `BarcodeDetector (Native 1D+2D [${effectiveFormats.length}])`
        : 'BarcodeDetector (1D) + Offline OCR';
    return {
      detector,
      engineName,
      supportedFormats: effectiveFormats,
    };
  } catch {
    try {
      const detector = new BarcodeDetectorCtor();
      return {
        detector,
        engineName: 'BarcodeDetector (Native Default)',
        supportedFormats: advertisedFormats,
      };
    } catch {
      return {
        detector: null,
        engineName: 'Html5Qrcode (ZXing)',
        supportedFormats: [],
      };
    }
  }
}

/**
 * Fast single-frame barcode/QR decoder for manual shutter captures and gallery/file uploads.
 * Runs native BarcodeDetector on a video frame, canvas, or uploaded File/DataURL in <25ms
 * before falling back to OCR.
 */
export async function decodeStillImageOrVideoFrameBarcodes(
  source: HTMLVideoElement | HTMLCanvasElement | File | string,
  mode: ScanMode
): Promise<{ rawValues: string[]; elapsedMs: number; engineUsed: string }> {
  const t0 = performance.now();
  const { detector, engineName } = await createVerifiedNativeBarcodeDetector(
    mode === 'gci' ? 'gci' : 'laser_central'
  );

  if (!detector) {
    return {
      rawValues: [],
      elapsedMs: Number((performance.now() - t0).toFixed(1)),
      engineUsed: 'none',
    };
  }

  try {
    let imageSource: CanvasImageSource | ImageBitmap;

    if (
      (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) ||
      (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement)
    ) {
      imageSource = source;
    } else if (typeof File !== 'undefined' && source instanceof File) {
      if (typeof createImageBitmap === 'function') {
        imageSource = await createImageBitmap(source);
      } else {
        imageSource = await loadImageElementFromSource(source);
      }
    } else if (typeof source === 'string') {
      imageSource = await loadImageElementFromSource(source);
    } else {
      return {
        rawValues: [],
        elapsedMs: Number((performance.now() - t0).toFixed(1)),
        engineUsed: engineName,
      };
    }

    const detections = await detector.detect(imageSource);
    const rawValues: string[] = [];
    if (Array.isArray(detections)) {
      for (const d of detections) {
        const val = typeof d?.rawValue === 'string' ? d.rawValue.trim() : '';
        if (val && !isIgnoredNonPartQrPayload(val) && !rawValues.includes(val)) {
          rawValues.push(val);
        }
      }
    }

    return {
      rawValues,
      elapsedMs: Number((performance.now() - t0).toFixed(1)),
      engineUsed: engineName,
    };
  } catch {
    return {
      rawValues: [],
      elapsedMs: Number((performance.now() - t0).toFixed(1)),
      engineUsed: engineName,
    };
  }
}

function loadImageElementFromSource(source: File | string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const publishUrl = (url: string) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = (err) => reject(err);
      img.src = url;
    };

    if (typeof source === 'string') {
      publishUrl(source);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => publishUrl(reader.result as string);
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(source);
  });
}
