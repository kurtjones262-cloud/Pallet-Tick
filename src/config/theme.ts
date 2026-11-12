/**
 * Global Theme System for PartTrack
 * Supports 4 complete industrial colour themes across both Dark Mode and Light Mode:
 *   1. Purple / Graphite (Default)
 *   2. Emerald / Black
 *   3. Electric Blue / Black
 *   4. Yellow — Industrial (Caterpillar / DeWalt / Industrial Safety & Logistics)
 *
 * Functional Status Colours remain consistent across all themes:
 *   - Success / Verified:   #00D979
 *   - Pending / Incomplete: #F59E0B
 *   - Error / Mismatch:     #EF4444
 *   - Information:          #078BFF
 */

export type AppThemeId = 'purple' | 'emerald' | 'blue' | 'yellow';
export type AppThemeMode = 'dark' | 'light';

export interface AppThemePalette {
  primary: string;
  primaryLight: string;
  primaryDeep: string;
  accentSecondary: string;
  primaryContrast: string;
  bgPrimary: string;
  bgSecondary: string;
  bgCard: string;
  bgModal: string;
  bgInput: string;
  bgTableHeader: string;
  bgHover: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  glowRgba: string;
  glowSoftRgba: string;
}

export interface AppThemeDefinition {
  id: AppThemeId;
  name: string;
  subtitle: string;
  badge: string;
  colors: AppThemePalette;
  palettes: {
    dark: AppThemePalette;
    light: AppThemePalette;
  };
}

export const VALID_THEME_IDS: readonly AppThemeId[] = ['purple', 'emerald', 'blue', 'yellow'];
export const VALID_THEME_MODES: readonly AppThemeMode[] = ['dark', 'light'];

export function isValidThemeId(val: unknown): val is AppThemeId {
  return typeof val === 'string' && (VALID_THEME_IDS as readonly string[]).includes(val);
}

export function isValidThemeMode(val: unknown): val is AppThemeMode {
  return typeof val === 'string' && (VALID_THEME_MODES as readonly string[]).includes(val);
}

export const APP_THEMES: Record<AppThemeId, AppThemeDefinition> = {
  purple: {
    id: 'purple',
    name: 'Purple / Graphite',
    subtitle: 'Signature futuristic neon-purple & graphite industrial interface',
    badge: 'DEFAULT',
    colors: {
      primary: '#A020F0',
      primaryLight: '#C084FC',
      primaryDeep: '#6B21A8',
      accentSecondary: '#C084FC',
      primaryContrast: '#FFFFFF',
      bgPrimary: '#080B12',
      bgSecondary: '#101321',
      bgCard: '#15182A',
      bgModal: '#101321',
      bgInput: '#080B12',
      bgTableHeader: '#101321',
      bgHover: 'rgba(255, 255, 255, 0.05)',
      border: '#29243D',
      textPrimary: '#FFFFFF',
      textSecondary: '#A3A8BD',
      textMuted: '#737B94',
      glowRgba: 'rgba(160, 32, 240, 0.35)',
      glowSoftRgba: 'rgba(160, 32, 240, 0.16)',
    },
    palettes: {
      dark: {
        primary: '#A020F0',
        primaryLight: '#C084FC',
        primaryDeep: '#6B21A8',
        accentSecondary: '#C084FC',
        primaryContrast: '#FFFFFF',
        bgPrimary: '#080B12',
        bgSecondary: '#101321',
        bgCard: '#15182A',
        bgModal: '#101321',
        bgInput: '#080B12',
        bgTableHeader: '#101321',
        bgHover: 'rgba(255, 255, 255, 0.05)',
        border: '#29243D',
        textPrimary: '#FFFFFF',
        textSecondary: '#A3A8BD',
        textMuted: '#737B94',
        glowRgba: 'rgba(160, 32, 240, 0.35)',
        glowSoftRgba: 'rgba(160, 32, 240, 0.16)',
      },
      light: {
        primary: '#8B1CD9',
        primaryLight: '#7E22CE',
        primaryDeep: '#6B21A8',
        accentSecondary: '#A855F7',
        primaryContrast: '#FFFFFF',
        bgPrimary: '#F4F3F8',
        bgSecondary: '#FFFFFF',
        bgCard: '#FFFFFF',
        bgModal: '#FFFFFF',
        bgInput: '#F8F7FC',
        bgTableHeader: '#EFECE6',
        bgHover: 'rgba(126, 34, 206, 0.06)',
        border: '#DDD8E8',
        textPrimary: '#1E1B2E',
        textSecondary: '#5A5570',
        textMuted: '#7C7694',
        glowRgba: 'rgba(139, 28, 217, 0.22)',
        glowSoftRgba: 'rgba(139, 28, 217, 0.10)',
      },
    },
  },
  emerald: {
    id: 'emerald',
    name: 'Emerald / Black',
    subtitle: 'High-visibility emerald green highlights on deep carbon surfaces',
    badge: 'INDUSTRIAL',
    colors: {
      primary: '#00D979',
      primaryLight: '#34D399',
      primaryDeep: '#059669',
      accentSecondary: '#34D399',
      primaryContrast: '#06150E',
      bgPrimary: '#060A09',
      bgSecondary: '#0C1412',
      bgCard: '#111C19',
      bgModal: '#0C1412',
      bgInput: '#060A09',
      bgTableHeader: '#0C1412',
      bgHover: 'rgba(255, 255, 255, 0.05)',
      border: '#1E332C',
      textPrimary: '#FFFFFF',
      textSecondary: '#9FB5AD',
      textMuted: '#688279',
      glowRgba: 'rgba(0, 217, 121, 0.32)',
      glowSoftRgba: 'rgba(0, 217, 121, 0.14)',
    },
    palettes: {
      dark: {
        primary: '#00D979',
        primaryLight: '#34D399',
        primaryDeep: '#059669',
        accentSecondary: '#34D399',
        primaryContrast: '#06150E',
        bgPrimary: '#060A09',
        bgSecondary: '#0C1412',
        bgCard: '#111C19',
        bgModal: '#0C1412',
        bgInput: '#060A09',
        bgTableHeader: '#0C1412',
        bgHover: 'rgba(255, 255, 255, 0.05)',
        border: '#1E332C',
        textPrimary: '#FFFFFF',
        textSecondary: '#9FB5AD',
        textMuted: '#688279',
        glowRgba: 'rgba(0, 217, 121, 0.32)',
        glowSoftRgba: 'rgba(0, 217, 121, 0.14)',
      },
      light: {
        primary: '#059669',
        primaryLight: '#047857',
        primaryDeep: '#065F46',
        accentSecondary: '#10B981',
        primaryContrast: '#FFFFFF',
        bgPrimary: '#F3F7F5',
        bgSecondary: '#FFFFFF',
        bgCard: '#FFFFFF',
        bgModal: '#FFFFFF',
        bgInput: '#F7FAF8',
        bgTableHeader: '#EBF2EE',
        bgHover: 'rgba(5, 150, 105, 0.06)',
        border: '#D5E2DC',
        textPrimary: '#16241E',
        textSecondary: '#52665E',
        textMuted: '#748A81',
        glowRgba: 'rgba(5, 150, 105, 0.22)',
        glowSoftRgba: 'rgba(5, 150, 105, 0.10)',
      },
    },
  },
  blue: {
    id: 'blue',
    name: 'Electric Blue / Black',
    subtitle: 'Technology-focused electric blue accents on slate-black panels',
    badge: 'TECH HUD',
    colors: {
      primary: '#078BFF',
      primaryLight: '#38BDF8',
      primaryDeep: '#0284C7',
      accentSecondary: '#38BDF8',
      primaryContrast: '#FFFFFF',
      bgPrimary: '#070A0F',
      bgSecondary: '#0E1522',
      bgCard: '#131C2E',
      bgModal: '#0E1522',
      bgInput: '#070A0F',
      bgTableHeader: '#0E1522',
      bgHover: 'rgba(255, 255, 255, 0.05)',
      border: '#1E2D44',
      textPrimary: '#FFFFFF',
      textSecondary: '#9BA8BD',
      textMuted: '#6A7891',
      glowRgba: 'rgba(7, 139, 255, 0.35)',
      glowSoftRgba: 'rgba(7, 139, 255, 0.15)',
    },
    palettes: {
      dark: {
        primary: '#078BFF',
        primaryLight: '#38BDF8',
        primaryDeep: '#0284C7',
        accentSecondary: '#38BDF8',
        primaryContrast: '#FFFFFF',
        bgPrimary: '#070A0F',
        bgSecondary: '#0E1522',
        bgCard: '#131C2E',
        bgModal: '#0E1522',
        bgInput: '#070A0F',
        bgTableHeader: '#0E1522',
        bgHover: 'rgba(255, 255, 255, 0.05)',
        border: '#1E2D44',
        textPrimary: '#FFFFFF',
        textSecondary: '#9BA8BD',
        textMuted: '#6A7891',
        glowRgba: 'rgba(7, 139, 255, 0.35)',
        glowSoftRgba: 'rgba(7, 139, 255, 0.15)',
      },
      light: {
        primary: '#0277E6',
        primaryLight: '#0369A1',
        primaryDeep: '#075985',
        accentSecondary: '#38BDF8',
        primaryContrast: '#FFFFFF',
        bgPrimary: '#F3F6FA',
        bgSecondary: '#FFFFFF',
        bgCard: '#FFFFFF',
        bgModal: '#FFFFFF',
        bgInput: '#F7F9FC',
        bgTableHeader: '#EBF0F7',
        bgHover: 'rgba(2, 119, 230, 0.06)',
        border: '#D6E0ED',
        textPrimary: '#172130',
        textSecondary: '#54647A',
        textMuted: '#78889E',
        glowRgba: 'rgba(2, 119, 230, 0.22)',
        glowSoftRgba: 'rgba(2, 119, 230, 0.10)',
      },
    },
  },
  yellow: {
    id: 'yellow',
    name: 'Yellow — Industrial',
    subtitle: 'Heavy industrial manufacturing & safety-yellow logistics interface',
    badge: 'HEAVY DUTY',
    colors: {
      primary: '#F5C400',
      primaryLight: '#FFD633',
      primaryDeep: '#D9AB00',
      accentSecondary: '#FFD633',
      primaryContrast: '#111315',
      bgPrimary: '#111315',
      bgSecondary: '#1A1D20',
      bgCard: '#22262A',
      bgModal: '#1A1D20',
      bgInput: '#111315',
      bgTableHeader: '#1A1D20',
      bgHover: 'rgba(245, 196, 0, 0.08)',
      border: '#34393E',
      textPrimary: '#F5F5F5',
      textSecondary: '#A5A9AD',
      textMuted: '#7B8085',
      glowRgba: 'rgba(245, 196, 0, 0.34)',
      glowSoftRgba: 'rgba(245, 196, 0, 0.15)',
    },
    palettes: {
      dark: {
        primary: '#F5C400',
        primaryLight: '#FFD633',
        primaryDeep: '#D9AB00',
        accentSecondary: '#FFD633',
        primaryContrast: '#111315',
        bgPrimary: '#111315',
        bgSecondary: '#1A1D20',
        bgCard: '#22262A',
        bgModal: '#1A1D20',
        bgInput: '#111315',
        bgTableHeader: '#1A1D20',
        bgHover: 'rgba(245, 196, 0, 0.08)',
        border: '#34393E',
        textPrimary: '#F5F5F5',
        textSecondary: '#A5A9AD',
        textMuted: '#7B8085',
        glowRgba: 'rgba(245, 196, 0, 0.34)',
        glowSoftRgba: 'rgba(245, 196, 0, 0.15)',
      },
      light: {
        primary: '#E5B400',
        primaryLight: '#9E7800',
        primaryDeep: '#C99B00',
        accentSecondary: '#F5C400',
        primaryContrast: '#111315',
        bgPrimary: '#F5F6F7',
        bgSecondary: '#FFFFFF',
        bgCard: '#FFFFFF',
        bgModal: '#FFFFFF',
        bgInput: '#F5F6F7',
        bgTableHeader: '#ECEEF0',
        bgHover: 'rgba(229, 180, 0, 0.10)',
        border: '#DDE1E5',
        textPrimary: '#202327',
        textSecondary: '#666D73',
        textMuted: '#858C93',
        glowRgba: 'rgba(229, 180, 0, 0.25)',
        glowSoftRgba: 'rgba(229, 180, 0, 0.12)',
      },
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
const THEME_MODE_STORAGE_KEY_PREFIX = 'parttrack_app_theme_mode_v1';

function normalizeUserKey(userKey?: string | null): string | null {
  if (!userKey || typeof userKey !== 'string') return null;
  const trimmed = userKey.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Retrieve the stored colour theme ID for a specific authenticated user,
 * or fallback to the global device preference when unauthenticated.
 */
export function getStoredTheme(userKey?: string | null): AppThemeId {
  if (typeof window === 'undefined') return 'purple';
  const normalizedUser = normalizeUserKey(userKey);
  try {
    if (normalizedUser) {
      const userSaved = localStorage.getItem(`${THEME_STORAGE_KEY_PREFIX}_${normalizedUser}`);
      if (isValidThemeId(userSaved)) {
        return userSaved;
      }
      return 'purple';
    }
    const globalSaved = localStorage.getItem(THEME_STORAGE_KEY_PREFIX);
    if (isValidThemeId(globalSaved)) {
      return globalSaved;
    }
  } catch {}
  return 'purple';
}

/**
 * Retrieve the stored Dark / Light appearance mode for a specific authenticated user,
 * or fallback to the global device preference when unauthenticated.
 */
export function getStoredThemeMode(userKey?: string | null): AppThemeMode {
  if (typeof window === 'undefined') return 'dark';
  const normalizedUser = normalizeUserKey(userKey);
  try {
    if (normalizedUser) {
      const userSaved = localStorage.getItem(`${THEME_MODE_STORAGE_KEY_PREFIX}_${normalizedUser}`);
      if (isValidThemeMode(userSaved)) {
        return userSaved;
      }
      return 'dark';
    }
    const globalSaved = localStorage.getItem(THEME_MODE_STORAGE_KEY_PREFIX);
    if (isValidThemeMode(globalSaved)) {
      return globalSaved;
    }
  } catch {}
  return 'dark';
}

export function getStoredThemePreferences(userKey?: string | null): {
  themeId: AppThemeId;
  mode: AppThemeMode;
} {
  return {
    themeId: getStoredTheme(userKey),
    mode: getStoredThemeMode(userKey),
  };
}

export function getThemePalette(
  themeId: AppThemeId,
  mode: AppThemeMode = 'dark'
): AppThemePalette {
  const theme = APP_THEMES[themeId] || APP_THEMES.purple;
  return theme.palettes[mode] || theme.palettes.dark;
}

/**
 * Apply both the selected colour theme and Dark/Light mode to the document root
 * so every screen, modal, table, card, badge, and control updates immediately.
 */
export function applyThemeToDocument(
  themeId: AppThemeId,
  mode?: AppThemeMode
): void {
  if (typeof document === 'undefined') return;
  const resolvedTheme = APP_THEMES[themeId] || APP_THEMES.purple;
  const currentAttrMode = document.documentElement.getAttribute('data-mode');
  const resolvedMode: AppThemeMode = isValidThemeMode(mode)
    ? mode
    : isValidThemeMode(currentAttrMode)
    ? currentAttrMode
    : getStoredThemeMode();

  const palette = resolvedTheme.palettes[resolvedMode] || resolvedTheme.palettes.dark;
  const root = document.documentElement;

  root.setAttribute('data-theme', resolvedTheme.id);
  root.setAttribute('data-mode', resolvedMode);
  root.classList.toggle('dark', resolvedMode === 'dark');
  root.classList.toggle('light', resolvedMode === 'light');
  root.style.colorScheme = resolvedMode;

  root.style.setProperty('--pt-primary', palette.primary);
  root.style.setProperty('--pt-primary-light', palette.primaryLight);
  root.style.setProperty('--pt-primary-deep', palette.primaryDeep);
  root.style.setProperty('--pt-accent-secondary', palette.accentSecondary);
  root.style.setProperty('--pt-primary-contrast', palette.primaryContrast);
  root.style.setProperty('--pt-bg', palette.bgPrimary);
  root.style.setProperty('--pt-bg-secondary', palette.bgSecondary);
  root.style.setProperty('--pt-card', palette.bgCard);
  root.style.setProperty('--pt-modal-bg', palette.bgModal);
  root.style.setProperty('--pt-input-bg', palette.bgInput);
  root.style.setProperty('--pt-table-header', palette.bgTableHeader);
  root.style.setProperty('--pt-hover-bg', palette.bgHover);
  root.style.setProperty('--pt-border', palette.border);
  root.style.setProperty('--pt-text', palette.textPrimary);
  root.style.setProperty('--pt-text-secondary', palette.textSecondary);
  root.style.setProperty('--pt-text-muted', palette.textMuted);
  root.style.setProperty('--pt-glow', palette.glowRgba);
  root.style.setProperty('--pt-glow-soft', palette.glowSoftRgba);

  // Consistent Functional Status Colours across all themes
  root.style.setProperty('--pt-success', STATUS_COLORS.success);
  root.style.setProperty('--pt-warning', STATUS_COLORS.warning);
  root.style.setProperty('--pt-error', STATUS_COLORS.error);
  root.style.setProperty('--pt-info', STATUS_COLORS.info);

  // Update theme-color meta tag for mobile browsers / PWA status bar
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute('content', palette.bgPrimary);
  }
}

export function setStoredTheme(
  themeId: AppThemeId,
  userKey?: string | null,
  additionalUserKeys?: Array<string | null | undefined>
): void {
  const validId: AppThemeId = isValidThemeId(themeId) ? themeId : 'purple';
  const normalizedUser = normalizeUserKey(userKey);
  const currentMode = getStoredThemeMode(normalizedUser);

  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(THEME_STORAGE_KEY_PREFIX, validId);
      if (normalizedUser) {
        localStorage.setItem(`${THEME_STORAGE_KEY_PREFIX}_${normalizedUser}`, validId);
      }
      if (additionalUserKeys) {
        for (const extraKey of additionalUserKeys) {
          const normExtra = normalizeUserKey(extraKey);
          if (normExtra) {
            localStorage.setItem(`${THEME_STORAGE_KEY_PREFIX}_${normExtra}`, validId);
          }
        }
      }
    } catch {}
  }

  applyThemeToDocument(validId, currentMode);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('parttrack_theme_changed', {
        detail: { themeId: validId, mode: currentMode, userKey: normalizedUser },
      })
    );
  }
}

export function setStoredThemeMode(
  mode: AppThemeMode,
  userKey?: string | null,
  additionalUserKeys?: Array<string | null | undefined>
): void {
  const validMode: AppThemeMode = isValidThemeMode(mode) ? mode : 'dark';
  const normalizedUser = normalizeUserKey(userKey);
  const currentTheme = getStoredTheme(normalizedUser);

  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(THEME_MODE_STORAGE_KEY_PREFIX, validMode);
      if (normalizedUser) {
        localStorage.setItem(`${THEME_MODE_STORAGE_KEY_PREFIX}_${normalizedUser}`, validMode);
      }
      if (additionalUserKeys) {
        for (const extraKey of additionalUserKeys) {
          const normExtra = normalizeUserKey(extraKey);
          if (normExtra) {
            localStorage.setItem(`${THEME_MODE_STORAGE_KEY_PREFIX}_${normExtra}`, validMode);
          }
        }
      }
    } catch {}
  }

  applyThemeToDocument(currentTheme, validMode);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('parttrack_theme_changed', {
        detail: { themeId: currentTheme, mode: validMode, userKey: normalizedUser },
      })
    );
  }
}
