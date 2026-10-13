/** Espejo de functions/lib/visitPassCode.js */
export const VISITA_PASS_PREFIX = 'MSSV1.';
const VISITA_PASS_RE = /^MSSV1\.[0-9A-F]{32}$/;

/** Forma canónica del código de pase (MSSV1.<32 hex>) o null si no es válido. */
export function parseVisitaPassCode(raw) {
  const value = String(raw == null ? '' : raw).trim().toUpperCase();
  return VISITA_PASS_RE.test(value) ? value : null;
}

/** true si empieza con el prefijo (aunque esté mal formado): nunca tratarlo como DNI. */
export function looksLikeVisitaPassCode(raw) {
  return String(raw == null ? '' : raw).trim().toUpperCase().startsWith(VISITA_PASS_PREFIX);
}

/** Texto escaneado listo para enviar: el código de pase va en forma canónica; el resto tal cual. */
export function normalizeScanForSend(raw) {
  const trimmed = String(raw == null ? '' : raw).trim();
  return parseVisitaPassCode(trimmed) || trimmed;
}

/** El backend puede devolver el código de pase en idNumber: no mostrarlo como DNI. */
export function hidePassCodeAsDni(result) {
  if (!result || !looksLikeVisitaPassCode(result.idNumber)) return result;
  return { ...result, idNumber: '' };
}

/** Solo los últimos 3 dígitos (mismo formato que dniMasked del backend). */
export function maskDni(dni) {
  const digits = String(dni == null ? '' : dni).replace(/\D/g, '');
  return digits ? `***${digits.slice(-3)}` : '';
}

/**
 * Contenido del QR de invitación: solo el código opaco del pase, sin nombre ni DNI.
 * La vigencia la valida el backend al escanear (ventana de visita).
 */
export function buildVisitaQrPayload(visita = {}) {
  return parseVisitaPassCode(visita.passCode) || '';
}

/** Ventana de vigencia alineada a functions/lib/visitasAccess.js */
export function getVisitaWindow(fechaHoraEsperada) {
  const expected = fechaHoraEsperada ? new Date(fechaHoraEsperada) : null;
  if (!expected || Number.isNaN(expected.getTime())) {
    return { start: null, end: null, label: 'Sin fecha de vigencia' };
  }
  const start = new Date(expected.getTime() - (2 * 60 * 60 * 1000));
  // Fin del día AR (UTC-3)
  const arParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(expected);
  const y = arParts.find((p) => p.type === 'year')?.value;
  const m = arParts.find((p) => p.type === 'month')?.value;
  const d = arParts.find((p) => p.type === 'day')?.value;
  const end = new Date(`${y}-${m}-${d}T23:59:59.999-03:00`);
  const fmt = (dt) => dt.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  return {
    start,
    end,
    label: `Válido desde ${fmt(start)} hasta ${fmt(end)}`
  };
}
