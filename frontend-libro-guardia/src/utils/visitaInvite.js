/**
 * Payload del QR de invitación de visita.
 * El kiosk/lector ya parsea JSON con campo dni (functions/dniParser.parseScanData).
 * La vigencia la valida el backend al escanear (ventana de visita).
 */
export function buildVisitaQrPayload(visita = {}) {
  const dni = String(visita.dniVisitanteNormalized || visita.dniVisitante || '')
    .replace(/\D/g, '');
  return JSON.stringify({
    tipo: 'visita_mss',
    dni,
    visitaId: visita.id || '',
    nombre: visita.nombreVisitante || ''
  });
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
