/**
 * Aplica la apariencia completa del sistema (marca + temas claro/oscuro).
 * Estilo tipo personalizador (Slack / Notion / Discord): accent + superficies + textos.
 */

function hexToRgbChannels(hex) {
  const raw = String(hex || '').replace('#', '').trim();
  if (raw.length !== 6) return '220, 38, 38';
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return '220, 38, 38';
  return `${r}, ${g}, ${b}`;
}

function lighten(hex, amount = 0.12) {
  const raw = String(hex || '').replace('#', '');
  if (raw.length !== 6) return hex;
  const nums = [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16));
  if (nums.some((n) => Number.isNaN(n))) return hex;
  const mixed = nums.map((n) => Math.min(255, Math.round(n + (255 - n) * amount)));
  return `#${mixed.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function darken(hex, amount = 0.12) {
  const raw = String(hex || '').replace('#', '');
  if (raw.length !== 6) return hex;
  const nums = [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16));
  if (nums.some((n) => Number.isNaN(n))) return hex;
  const mixed = nums.map((n) => Math.max(0, Math.round(n * (1 - amount))));
  return `#${mixed.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * @param {object} appearance
 */
function applyAppearanceTheme(appearance = {}) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  const set = (key, value) => {
    if (value) root.style.setProperty(key, value);
  };

  const primary = appearance.primaryColor || appearance.accent || null;
  const primaryHover = appearance.primaryColorHover || appearance.accentHover || null;
  const brandBg = appearance.backgroundColor || appearance.darkBg || null;

  if (primary) {
    set('--brand-primary', primary);
    set('--brand-primary-rgb', hexToRgbChannels(primary));
    set('--accent', primary);
  }
  if (primaryHover || primary) {
    set('--brand-primary-hover', primaryHover || darken(primary, 0.15));
    set('--accent-hover', primaryHover || darken(primary, 0.15));
  }
  if (brandBg) set('--brand-background', brandBg);

  // Tema oscuro (fondo de app, paneles, texto)
  const darkBg = appearance.darkBg || appearance.backgroundColor || null;
  const darkSurface = appearance.darkSurface || (darkBg ? lighten(darkBg, 0.06) : null);
  const darkCard = appearance.darkCard || (darkBg ? lighten(darkBg, 0.1) : null);
  const darkText = appearance.darkText || null;
  const darkMuted = appearance.darkMuted || null;
  const darkBorder = appearance.darkBorder || null;
  const darkSidebar = appearance.darkSidebar || darkSurface;

  set('--theme-dark-bg', darkBg);
  set('--theme-dark-surface', darkSurface);
  set('--theme-dark-card', darkCard);
  set('--theme-dark-text', darkText);
  set('--theme-dark-muted', darkMuted);
  set('--theme-dark-border', darkBorder);
  set('--theme-dark-sidebar', darkSidebar);

  // Tema claro
  const lightBg = appearance.lightBg || null;
  const lightSurface = appearance.lightSurface || (lightBg ? lighten(lightBg, 0.5) : null);
  const lightCard = appearance.lightCard || lightSurface;
  const lightText = appearance.lightText || null;
  const lightMuted = appearance.lightMuted || null;
  const lightBorder = appearance.lightBorder || null;
  const lightSidebar = appearance.lightSidebar || lightCard;

  set('--theme-light-bg', lightBg);
  set('--theme-light-surface', lightSurface);
  set('--theme-light-card', lightCard);
  set('--theme-light-text', lightText);
  set('--theme-light-muted', lightMuted);
  set('--theme-light-border', lightBorder);
  set('--theme-light-sidebar', lightSidebar);

  if (appearance.appTitle && typeof document !== 'undefined' && document.title) {
    // no forzar title acá; el shell puede leerlo del cache
  }
}

/** Compat: marca antigua solo con primary/background. */
function applyBrandTheme(brand) {
  applyAppearanceTheme({
    primaryColor: brand?.primaryColor,
    primaryColorHover: brand?.primaryColorHover,
    backgroundColor: brand?.backgroundColor,
    darkBg: brand?.backgroundColor
  });
}

module.exports = {
  applyAppearanceTheme,
  applyBrandTheme,
  hexToRgbChannels,
  lighten,
  darken
};
