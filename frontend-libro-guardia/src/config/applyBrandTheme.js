/**
 * Aplica las CSS custom properties de marca en <html>.
 * Debe ejecutarse antes del primer paint útil (index.js).
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

function applyBrandTheme(brand) {
  if (typeof document === 'undefined' || !brand) return;

  const root = document.documentElement;
  root.style.setProperty('--brand-primary', brand.primaryColor);
  root.style.setProperty('--brand-primary-hover', brand.primaryColorHover || brand.primaryColor);
  root.style.setProperty('--brand-background', brand.backgroundColor);
  root.style.setProperty('--brand-primary-rgb', hexToRgbChannels(brand.primaryColor));
}

module.exports = { applyBrandTheme, hexToRgbChannels };
