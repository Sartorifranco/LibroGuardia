/**
 * Texto simple de un horario del sitio para quien no es técnico:
 * [{ days:[1..5], from:'08:00', to:'17:00' }] → "lun a vie 8:00 a 17:00".
 * Días: 0 = domingo … 6 = sábado (como accessModel). Se listan de lunes a domingo.
 */

const DAY_NAMES = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const hora = (hhmm) => String(hhmm || '').replace(/^0(\d)/, '$1');

const listar = (items) => (items.length <= 1
  ? items.join('')
  : `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`);

/** Días en orden de semana; tres o más seguidos se resumen "lun a vie". */
const diasTexto = (days) => {
  const set = new Set((Array.isArray(days) ? days : []).map(Number));
  const ordered = WEEK_ORDER.filter((d) => set.has(d));
  if (ordered.length === 7) return 'todos los días';
  const runs = [];
  ordered.forEach((d) => {
    const pos = WEEK_ORDER.indexOf(d);
    const last = runs[runs.length - 1];
    if (last && WEEK_ORDER.indexOf(last[last.length - 1]) === pos - 1) last.push(d);
    else runs.push([d]);
  });
  const parts = runs.flatMap((run) => (run.length >= 3
    ? [`${DAY_NAMES[run[0]]} a ${DAY_NAMES[run[run.length - 1]]}`]
    : run.map((d) => DAY_NAMES[d])));
  return listar(parts);
};

const scheduleResumen = (intervals) => (Array.isArray(intervals) ? intervals : [])
  .filter((iv) => iv && iv.from && iv.to)
  .map((iv) => `${diasTexto(iv.days)} ${hora(iv.from)} a ${hora(iv.to)}`)
  .join('; ');

module.exports = { scheduleResumen, diasTexto };
