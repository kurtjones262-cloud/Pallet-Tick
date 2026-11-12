/**
 * Central Branding Configuration for PartTrack
 * Official Application Name: PartTrack
 * Official Tagline: PARTS • DOCKETS • SHIPMENTS • VERIFICATION
 */

export const BRANDING = {
  /** Standard mixed-case product name */
  appName: 'PartTrack',
  /** Official uppercase logotype / header brand */
  appNameUppercase: 'PARTTRACK',
  /** Official short name for PWA & mobile launcher */
  shortName: 'PartTrack',
  /** Official brand tagline */
  tagline: 'PARTS • DOCKETS • SHIPMENTS • VERIFICATION',
  /** Uppercase tagline for industrial HUD / splash displays */
  taglineUppercase: 'PARTS • DOCKETS • SHIPMENTS • VERIFICATION',
  /** Secondary operational subtitle */
  operationalSubtitle: 'Industrial Parts, Dockets, Shipments & Real-Time Verification Platform',
  /** Full browser & SEO page title */
  fullTitle: 'PartTrack — PARTS • DOCKETS • SHIPMENTS • VERIFICATION',
  /** Full meta description for browser, OpenGraph & PWA manifest */
  description:
    'PartTrack — PARTS • DOCKETS • SHIPMENTS • VERIFICATION. Industrial parts receiving, AI delivery docket extraction, high-speed QR & barcode verification, and real-time multi-user warehouse collaboration.',
  /** Primary square application icon path */
  logoIconPath: '/parttrack-icon.png',
  /** Horizontal brand lockup path */
  logoHorizontalPath: '/parttrack-horizontal-logo.png',
  /** Startup / splash screen artwork path */
  splashImagePath: '/parttrack-splash.jpg',
  /** SVG vector icon path */
  logoSvgPath: '/icon.svg',
  /** Export file prefix for PDF reports, CSV spreadsheets & ZIP archives */
  exportFilePrefix: 'PartTrack',
  /** PDF report subtitle */
  reportSubtitle: 'PARTS • DOCKETS • SHIPMENTS • VERIFICATION · OFFICIAL AUDIT REPORT',
  /** Version & build display string */
  versionLabel: 'PartTrack v3.0 Enterprise',
  /** Splash footer label */
  splashFooterLabel: 'PARTTRACK · PARTS • DOCKETS • SHIPMENTS • VERIFICATION',
} as const;

export default BRANDING;
