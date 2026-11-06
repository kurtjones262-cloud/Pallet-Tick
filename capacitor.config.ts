import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.parttrack.app',
  appName: 'PartTrack',
  webDir: 'dist',
  backgroundColor: '#F6F5F2',
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },
  android: {
    backgroundColor: '#F6F5F2',
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  ios: {
    backgroundColor: '#F6F5F2',
    contentInset: 'automatic',
    allowsLinkPreview: false,
    scrollEnabled: true,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
