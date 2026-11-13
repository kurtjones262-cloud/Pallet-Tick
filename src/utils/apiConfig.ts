/**
 * Runtime and native platform environment detection for PartTrack.
 * PartTrack uses local IndexedDB storage with an offline docket queue and Gemini-first vision OCR.
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
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env || {};
  const workerBase =
    env.VITE_CLOUDFLARE_WORKER_URL ||
    env.VITE_WORKER_URL ||
    env.VITE_API_BASE_URL;

  if (workerBase && workerBase.trim().length > 0) {
    return `${workerBase.trim().replace(/\/+$/, '')}${normalizedPath}`;
  }

  return normalizedPath;
}
