import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: [
          'pallettrack-icon.png',
          'pallettrack-horizontal-logo.png',
          'favicon.ico',
          'favicon-32x32.png',
          'favicon-16x16.png',
          'apple-touch-icon.png',
          'icon-192.png',
          'icon-512.png',
          'icon-maskable-512.png',
          'icon.svg',
        ],
        manifest: {
          id: '/',
          name: 'PalletTick - Parts Receiving & Verification',
          short_name: 'PalletTick',
          description:
            'Offline-first delivery docket scanner, on-device OCR, and continuous QR & barcode parts verification.',
          theme_color: '#0B111A',
          background_color: '#070A0F',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: '/icon-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/icon-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/icon-maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
            {
              src: '/pallettrack-icon.png',
              sizes: '1254x1254',
              type: 'image/png',
              purpose: 'any',
            },
          ],
        },
        workbox: {
          cacheId: 'pallettick-pwa-v2',
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true,
          maximumFileSizeToCacheInBytes: 25 * 1024 * 1024, // 25MB for Tesseract wasm and traineddata
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
          globIgnores: ['**/assets/aistudio/**', '**/tesseract/**'],
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//, /\.zip$/i],
          runtimeCaching: [
            {
              urlPattern: /^\/tesseract\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'tesseract-offline-assets',
                expiration: {
                  maxEntries: 60,
                  maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'gstatic-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
          ],
        },
        devOptions: {
          enabled: false,
          type: 'module',
        },
      }),
    ],
    optimizeDeps: {
      entries: ['index.html', 'src/**/*.{ts,tsx}'],
    },
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
