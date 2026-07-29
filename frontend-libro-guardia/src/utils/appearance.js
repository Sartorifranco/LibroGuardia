/**
 * Cache local + fetch de apariencia (tema completo).
 */

const CACHE_KEY = 'mss-guard-appearance-override';

export function readAppearanceCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function saveAppearanceCache(appearance) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(appearance || {}));
  } catch {
    // ignore
  }
}

export function clearAppearanceCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}

export function mergeAppearance(defaults, override = {}) {
  return {
    ...defaults,
    ...Object.fromEntries(
      Object.entries(override || {}).filter(([, v]) => v != null && v !== '')
    )
  };
}

export async function fetchAndApplyAppearance(applyFn, brandDefaults) {
  const defaults = {
    primaryColor: brandDefaults.primaryColor,
    primaryColorHover: brandDefaults.primaryColorHover,
    backgroundColor: brandDefaults.backgroundColor,
    darkBg: brandDefaults.backgroundColor,
    darkSurface: '#141414',
    darkCard: '#1a1a1a',
    darkText: '#fafafa',
    darkMuted: '#a3a3a3',
    darkBorder: '#2a2a2a',
    darkSidebar: '#1a1010',
    lightBg: '#f3f4f6',
    lightSurface: '#ffffff',
    lightCard: '#ffffff',
    lightText: '#111827',
    lightMuted: '#6b7280',
    lightBorder: '#e5e7eb',
    lightSidebar: '#ffffff',
    appTitle: brandDefaults.appTitle,
    companyName: brandDefaults.companyName
  };

  const cached = readAppearanceCache();
  if (cached) {
    applyFn(mergeAppearance(defaults, cached));
  } else {
    applyFn(defaults);
  }

  try {
    const base = process.env.REACT_APP_API_BASE_URL || '/api';
    const res = await fetch(`${base}/public/appearance`, { cache: 'no-store' });
    if (!res.ok) return cached || defaults;
    const data = await res.json();
    const appearance = data.appearance || {};
    const merged = mergeAppearance(defaults, appearance);
    saveAppearanceCache(merged);
    applyFn(merged);
    return merged;
  } catch {
    return cached || defaults;
  }
}
