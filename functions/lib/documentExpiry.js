/**
 * Vencimientos de documentos (ART, licencia, seguro, VTV, autorizaciones).
 * Fechas inválidas o ausentes → sin alerta (no se tratan como vencidas).
 */

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const normalizeExpiryYmd = (value) => {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const trimmed = value.trim().slice(0, 10);
    return YMD_RE.test(trimmed) ? trimmed : null;
  }
  if (value && typeof value.toDate === 'function') {
    const d = value.toDate();
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return null;
};

const daysBetweenYmd = (fromYmd, toYmd) => {
  if (!fromYmd || !toYmd) return null;
  const a = new Date(`${fromYmd}T12:00:00-03:00`);
  const b = new Date(`${toYmd}T12:00:00-03:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
};

const bucketForDaysLeft = (daysLeft) => {
  if (daysLeft === null || daysLeft === undefined) return null;
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= 7) return 'endingIn7';
  if (daysLeft <= 15) return 'endingIn15';
  if (daysLeft <= 30) return 'endingIn30';
  return null;
};

/**
 * @returns {null|{ endDate: string, daysLeft: number, bucket: string }}
 */
const evaluateExpiry = (rawDate, todayYmd) => {
  const endDate = normalizeExpiryYmd(rawDate);
  if (!endDate) return null;
  const daysLeft = daysBetweenYmd(todayYmd, endDate);
  const bucket = bucketForDaysLeft(daysLeft);
  if (!bucket) return null;
  return { endDate, daysLeft, bucket };
};

const KIND_LABELS = {
  authorization: 'Autorización',
  art: 'ART',
  license: 'Licencia',
  insurance: 'Seguro',
  vtv: 'VTV / revisión técnica'
};

const buildExpiryMessage = ({ kind, subject, endDate, daysLeft }) => {
  const kindLabel = KIND_LABELS[kind] || kind;
  if (daysLeft < 0) {
    const days = Math.abs(daysLeft);
    return `El ${kindLabel} de ${subject} está vencido (desde hace ${days} día${days === 1 ? '' : 's'}, ${endDate})`;
  }
  if (daysLeft === 0) {
    return `El ${kindLabel} de ${subject} vence hoy (${endDate})`;
  }
  return `El ${kindLabel} de ${subject} vence en ${daysLeft} día${daysLeft === 1 ? '' : 's'} (${endDate})`;
};

module.exports = {
  normalizeExpiryYmd,
  daysBetweenYmd,
  evaluateExpiry,
  bucketForDaysLeft,
  buildExpiryMessage,
  KIND_LABELS
};
