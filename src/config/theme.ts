/**
 * Global Theme System for PartTrack
 * Supports 3 complete industrial themes:
 *   1. Purple / Graphite (Default) - #A020F0, #C084FC, #6B21A8, #080B12, #101321, #15182A, #29243D
 *   2. Emerald / Black             - #00D979, #34D399, #059669, #060A09, #0C1412, #111C19, #1E332C
 *   3. Electric Blue / Black       - #078BFF, #38BDF8, #0284C7, #070A0F, #0E1522, #131C2E, #1E2D44
 *
 * Functional Status Colours remain consistent across all themes:
 *   - Success / Verified:   #00D979
 *   - Pending / Incomplete: #F59E0B
 *   - Error / Mismatch:     #EF4444
 *   - Information:          #078BFF
 */

export type AppThemeId = 'purple' | 'emerald' | 'blue';

export interface AppThemeDefinition {
  id: AppThemeId;
  name: string;
  subtitle: string;
  badge: string;
  colors: {
    primary: string;
    primaryLight: string;
    primaryDeep: string;
    bgPrimary: string;
    bgSecondary: string;
    bgCard: string;
    border: string;
    textPrimary: string;
    textSecondary: string;
    textMuted: string;
    glowRgba: string;
  };
}

export const APP_THEMES: Record<AppThemeId, AppThemeDefinition> = {
  purple: {
    id: 'purple',
    name: 'Purple / Graphite',
    subtitle: 'Signature futuristic neon-purple & dark graphite industrial interface',
    badge: 'DEFAULT',
    colors: {
      primary: '#A020F0',
      primaryLight: '#C084FC',
      primaryDeep: '#6B21A8',
      bgPrimary: '#080B12',
      bgSecondary: '#101321',
      bgCard: '#15182A',
      border: '#29243D',
      textPrimary: '#FFFFFF',
      textSecondary: '#A3A8BD',
      textMuted: '#737B94',
      glowRgba: 'rgba(160, 32, 240, 0.35)',
    },
  },
  emerald: {
    id: 'emerald',
    name: 'Emerald / Black',
    subtitle: 'High-visibility emerald green highlights on deep carbon black surfaces',
    badge: 'INDUSTRIAL',
    colors: {
      primary: '#00D979',
      primaryLight: '#34D399',
      primaryDeep: '#059669',
      bgPrimary: '#060A09',
      bgSecondary: '#0C1412',
      bgCard: '#111C19',
      border: '#1E332C',
      textPrimary: '#FFFFFF',
      textSecondary: '#9FB5AD',
      textMuted: '#688279',
      glowRgba: 'rgba(0, 217, 121, 0.32)',
    },
  },
  blue: {
    id: 'blue',
    name: 'Electric Blue / Black',
    subtitle: 'Technology-focused electric blue accents on deep slate-black panels',
    badge: 'TECH HUD',
    colors: {
      primary: '#078BFF',
      primaryLight: '#38BDF8',
      primaryDeep: '#0284C7',
      bgPrimary: '#070A0F',
      bgSecondary: '#0E1522',
      bgCard: '#131C2E',
      border: '#1E2D44',
      textPrimary: '#FFFFFF',
      textSecondary: '#9BA8BD',
      textMuted: '#6A7891',
      glowRgba: 'rgba(7, 139, 255, 0.35)',
    },
  },
};

export const STATUS_COLORS = {
  success: '#00D979',
  warning: '#F59E0B',
  error: '#EF4444',
  info: '#078BFF',
} as const;

const THEME_STORAGE_KEY_PREFIX = 'parttrack_app_theme_v1';

export function getStoredTheme(userKey?: string | null): AppThemeId {
  if (typeof window === 'undefined') return 'purple';
  try {
    if (userKey) {
      const userSaved = localStorage.getItem(`${THEME_STORAGE_KEY_PREFIX}_${userKey}`);
      if (userSaved === 'purple' || userSaved === 'emerald' || userSaved === 'blue') {
        return userSaved;
      }
    }
    const globalSaved = localStorage.getItem(THEME_STORAGE_KEY_PREFIX);
    if (globalSaved === 'purple' || globalSaved === 'emerald' || globalSaved === 'blue') {
      return globalSaved;
    }
  } catch {}
  return 'purple';
}

export function applyThemeToDocument(themeId: AppThemeId): void {
  if (typeof document === 'undefined') return;
  const theme = APP_THEMES[themeId] || APP_THEMES.purple;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme.id);
  root.style.setProperty('--pt-primary', theme.colors.primary);
  root.style.setProperty('--pt-primary-light', theme.colors.primaryLight);
  root.style.setProperty('--pt-primary-deep', theme.colors.primaryDeep);
  root.style.setProperty('--pt-bg', theme.colors.bgPrimary);
  root.style.setProperty('--pt-bg-secondary', theme.colors.bgSecondary);
  root.style.setProperty('--pt-card', theme.colors.bgCard);
  root.style.setProperty('--pt-border', theme.colors.border);
  root.style.setProperty('--pt-text', theme.colors.textPrimary);
  root.style.setProperty('--pt-text-secondary', theme.colors.textSecondary);
  root.style.setProperty('--pt-text-muted', theme.colors.textMuted);
  root.style.setProperty('--pt-glow', theme.colors.glowRgba);

  // Consistent Functional Status Colours across all themes
  root.style.setProperty('--pt-success', STATUS_COLORS.success);
  root.style.setProperty('--pt-warning', STATUS_COLORS.warning);
  root.style.setProperty('--pt-error', STATUS_COLORS.error);
  root.style.setProperty('--pt-info', STATUS_COLORS.info);

  // Update theme-color meta tag for mobile browsers
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute('content', theme.colors.bgPrimary);
  }
}

export function setStoredTheme(themeId: AppThemeId, userKey?: string | null): void {
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(THEME_STORAGE_KEY_PREFIX, themeId);
      if (userKey) {
        localStorage.setItem(`${THEME_STORAGE_KEY_PREFIX}_${userKey}`, themeId);
      }
    } catch {}
  }
  applyThemeToDocument(themeId);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('parttrack_theme_changed', { detail: { themeId } }));
  }
}
