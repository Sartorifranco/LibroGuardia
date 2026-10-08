const AR_YMD = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Argentina/Buenos_Aires',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

/**
 * YYYY-MM-DD en hora de Argentina (no UTC: después de las 21 h toISOString ya da mañana).
 */
export const argentinaYmd = (date = new Date()) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const parts = Object.fromEntries(AR_YMD.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export default argentinaYmd;
