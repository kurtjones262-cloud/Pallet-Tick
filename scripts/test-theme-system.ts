import {
  APP_THEMES,
  AppThemeId,
  AppThemeMode,
  VALID_THEME_IDS,
  VALID_THEME_MODES,
  getStoredTheme,
  getStoredThemeMode,
  getStoredThemePreferences,
  setStoredTheme,
  setStoredThemeMode,
  applyThemeToDocument,
} from '../src/config/theme';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

// Minimal browser environment mock for testing storage + DOM CSS variable injection
const storageMap = new Map<string, string>();
const cssProps = new Map<string, string>();
const attrMap = new Map<string, string>();
const classSet = new Set<string>();
let metaThemeColor = '#080B12';
const dispatchedEvents: Array<{ type: string; detail: any }> = [];

(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (storageMap.has(k) ? storageMap.get(k)! : null),
    setItem: (k: string, v: string) => storageMap.set(k, String(v)),
    removeItem: (k: string) => storageMap.delete(k),
    clear: () => storageMap.clear(),
  },
  dispatchEvent: (ev: any) => {
    dispatchedEvents.push({ type: ev.type, detail: ev.detail });
    return true;
  },
};
(globalThis as any).localStorage = (globalThis as any).window.localStorage;
(globalThis as any).CustomEvent = class CustomEvent {
  type: string;
  detail: any;
  constructor(type: string, init?: { detail?: any }) {
    this.type = type;
    this.detail = init?.detail;
  }
};
(globalThis as any).document = {
  documentElement: {
    setAttribute: (k: string, v: string) => attrMap.set(k, v),
    getAttribute: (k: string) => attrMap.get(k) || null,
    classList: {
      toggle: (cls: string, force?: boolean) => {
        if (force === undefined) {
          if (classSet.has(cls)) classSet.delete(cls);
          else classSet.add(cls);
        } else if (force) {
          classSet.add(cls);
        } else {
          classSet.delete(cls);
        }
      },
      contains: (cls: string) => classSet.has(cls),
    },
    style: {
      colorScheme: 'dark',
      setProperty: (k: string, v: string) => cssProps.set(k, v),
      getPropertyValue: (k: string) => cssProps.get(k) || '',
    },
  },
  querySelector: (sel: string) => {
    if (sel === 'meta[name="theme-color"]') {
      return {
        setAttribute: (_k: string, v: string) => {
          metaThemeColor = v;
        },
      };
    }
    return null;
  },
};

console.log('=== PartTrack Global Theme System Verification ===\n');

// 1. Verify all 4 themes exist with complete Dark and Light palettes
assert(VALID_THEME_IDS.length === 4, 'Expected 4 valid theme IDs');
assert(
  VALID_THEME_IDS.includes('purple') &&
    VALID_THEME_IDS.includes('emerald') &&
    VALID_THEME_IDS.includes('blue') &&
    VALID_THEME_IDS.includes('yellow'),
  'All 4 themes (purple, emerald, blue, yellow) must be registered'
);
assert(
  VALID_THEME_MODES.includes('dark') && VALID_THEME_MODES.includes('light'),
  'Both dark and light modes must be registered'
);

for (const id of VALID_THEME_IDS) {
  const theme = APP_THEMES[id];
  assert(Boolean(theme), `Theme definition missing for ${id}`);
  for (const mode of VALID_THEME_MODES) {
    const p = theme.palettes[mode];
    assert(Boolean(p), `Palette missing for ${id} (${mode})`);
    assert(Boolean(p.primary && p.bgPrimary && p.bgSecondary && p.bgCard && p.border && p.textPrimary), `Core tokens missing for ${id} (${mode})`);
  }
}
console.log('✓ 1. All 4 colour themes (Purple, Emerald, Blue, Yellow — Industrial) verified in Dark & Light modes.');

// 2. Verify exact Yellow — Industrial Dark & Light Mode specifications
const yellowDark = APP_THEMES.yellow.palettes.dark;
assert(yellowDark.bgPrimary === '#111315', `Yellow Dark primary bg expected #111315, got ${yellowDark.bgPrimary}`);
assert(yellowDark.bgSecondary === '#1A1D20', `Yellow Dark secondary bg expected #1A1D20, got ${yellowDark.bgSecondary}`);
assert(yellowDark.bgCard === '#22262A', `Yellow Dark card bg expected #22262A, got ${yellowDark.bgCard}`);
assert(yellowDark.primary === '#F5C400', `Yellow Dark primary accent expected #F5C400, got ${yellowDark.primary}`);
assert(yellowDark.accentSecondary === '#FFD633', `Yellow Dark secondary accent expected #FFD633, got ${yellowDark.accentSecondary}`);
assert(yellowDark.textPrimary === '#F5F5F5', `Yellow Dark primary text expected #F5F5F5, got ${yellowDark.textPrimary}`);
assert(yellowDark.textSecondary === '#A5A9AD', `Yellow Dark secondary text expected #A5A9AD, got ${yellowDark.textSecondary}`);
assert(yellowDark.border === '#34393E', `Yellow Dark border expected #34393E, got ${yellowDark.border}`);
assert(yellowDark.primaryContrast === '#111315', 'Yellow Dark button text contrast must be dark charcoal #111315');

const yellowLight = APP_THEMES.yellow.palettes.light;
assert(yellowLight.bgPrimary === '#F5F6F7', `Yellow Light primary bg expected #F5F6F7, got ${yellowLight.bgPrimary}`);
assert(yellowLight.bgSecondary === '#FFFFFF', `Yellow Light secondary bg expected #FFFFFF, got ${yellowLight.bgSecondary}`);
assert(yellowLight.bgCard === '#FFFFFF', `Yellow Light card bg expected #FFFFFF, got ${yellowLight.bgCard}`);
assert(yellowLight.primary === '#E5B400', `Yellow Light primary accent expected #E5B400, got ${yellowLight.primary}`);
assert(yellowLight.accentSecondary === '#F5C400', `Yellow Light secondary accent expected #F5C400, got ${yellowLight.accentSecondary}`);
assert(yellowLight.textPrimary === '#202327', `Yellow Light primary text expected #202327, got ${yellowLight.textPrimary}`);
assert(yellowLight.textSecondary === '#666D73', `Yellow Light secondary text expected #666D73, got ${yellowLight.textSecondary}`);
assert(yellowLight.border === '#DDE1E5', `Yellow Light border expected #DDE1E5, got ${yellowLight.border}`);
assert(yellowLight.primaryContrast === '#111315', 'Yellow Light button text contrast must be dark charcoal #111315');
console.log('✓ 2. Yellow — Industrial Dark Mode and Light Mode palettes match exact specifications.');

// 3. Verify switching between Dark and Light mode preserves the active colour theme
storageMap.clear();
setStoredTheme('yellow', 'USR-01');
assert(getStoredTheme('USR-01') === 'yellow', 'User USR-01 theme should be yellow');
assert(getStoredThemeMode('USR-01') === 'dark', 'User USR-01 default mode should be dark');
assert(attrMap.get('data-theme') === 'yellow' && attrMap.get('data-mode') === 'dark', 'DOM attributes should be yellow + dark');
assert(cssProps.get('--pt-bg') === '#111315', 'CSS --pt-bg should be #111315 in Yellow Dark');

// Switch to Light Mode while on Yellow theme
setStoredThemeMode('light', 'USR-01');
assert(getStoredTheme('USR-01') === 'yellow', 'Switching to Light Mode must preserve Yellow colour theme');
assert(getStoredThemeMode('USR-01') === 'light', 'Mode should now be light');
assert(attrMap.get('data-theme') === 'yellow' && attrMap.get('data-mode') === 'light', 'DOM attributes should be yellow + light');
assert(cssProps.get('--pt-bg') === '#F5F6F7', 'CSS --pt-bg should be #F5F6F7 in Yellow Light');
assert(cssProps.get('--pt-primary') === '#E5B400', 'CSS --pt-primary should be #E5B400 in Yellow Light');
assert(metaThemeColor === '#F5F6F7', 'Meta theme-color should update to #F5F6F7');

// Switch back to Dark Mode while on Yellow theme
setStoredThemeMode('dark', 'USR-01');
assert(getStoredTheme('USR-01') === 'yellow', 'Switching back to Dark Mode must preserve Yellow colour theme');
assert(getStoredThemeMode('USR-01') === 'dark', 'Mode should now be dark');
assert(cssProps.get('--pt-bg') === '#111315', 'CSS --pt-bg should return to #111315 in Yellow Dark');
console.log('✓ 3. Instant Dark <-> Light mode switching preserves active colour theme and updates all CSS variables.');

// 4. Verify multi-user preference isolation (User A vs User B vs User C)
setStoredTheme('yellow', 'USER-A');
setStoredThemeMode('light', 'USER-A');

setStoredTheme('emerald', 'USER-B');
setStoredThemeMode('dark', 'USER-B');

// User C has never configured a custom theme
const prefsA = getStoredThemePreferences('USER-A');
const prefsB = getStoredThemePreferences('USER-B');
const prefsC = getStoredThemePreferences('USER-C');

assert(prefsA.themeId === 'yellow' && prefsA.mode === 'light', 'USER-A preferences must remain yellow + light');
assert(prefsB.themeId === 'emerald' && prefsB.mode === 'dark', 'USER-B preferences must remain emerald + dark');
assert(prefsC.themeId === 'purple' && prefsC.mode === 'dark', 'USER-C (new user) must default to purple + dark without inheriting USER-B');
console.log('✓ 4. Per-user theme and mode preferences are isolated and never overwrite other users.');

// 5. Verify all 8 combinations (4 themes × 2 modes) apply cleanly to document
for (const themeId of VALID_THEME_IDS) {
  for (const mode of VALID_THEME_MODES) {
    applyThemeToDocument(themeId as AppThemeId, mode as AppThemeMode);
    assert(attrMap.get('data-theme') === themeId, `Expected data-theme=${themeId}`);
    assert(attrMap.get('data-mode') === mode, `Expected data-mode=${mode}`);
    assert(classSet.has(mode), `Expected root classList to contain ${mode}`);
  }
}
console.log('✓ 5. All 8 theme×mode combinations (Purple, Emerald, Blue, Yellow × Dark, Light) apply cleanly to DOM.');
console.log('\nALL GLOBAL THEME SYSTEM TESTS PASSED (5/5)!');
