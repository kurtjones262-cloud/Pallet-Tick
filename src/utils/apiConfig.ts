/**
 * Runtime and native platform environment detection for PartTrack.
 * PartTrack operates 100% offline and on-device (local IndexedDB & offline Tesseract.js OCR).
 */

export function isCapacitorNativeRuntime(): boolean {
  if (typeof window === 'undefined') return false;

  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
    return true;
  }

  const { protocol, hostname, port } = window.location;
  if (protocol === 'capacitor:' || protocol === 'ionic:' || protocol === 'file:') {
    return true;
  }

  // Capacitor Android WebView serves local assets from https://localhost or http://localhost with no port
  if (hostname === 'localhost' && !port) {
    return true;
  }

  return false;
}

export function resolveApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const envBase = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_API_BASE_URL;

  if (envBase && envBase.trim().length > 0) {
    return `${envBase.trim().replace(/\/+$/, '')}${normalizedPath}`;
  }

  return normalizedPath;
}
