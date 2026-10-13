/** Duración del pase de visita: espejo de functions/lib/visitDuration.js (docs/VISITAS-DISENO.md §3.0). */

export const MAX_MES_DAYS = 31;

export const DURACION_OPCIONES = [
  { id: 'un_ingreso', label: 'Un solo ingreso', help: 'Sirve para entrar una vez.' },
  { id: 'horas', label: 'Por horas', help: 'Entra y sale las veces que necesite dentro del horario.' },
  { id: 'dia', label: 'Todo el día', help: 'Vale todo el día elegido.' },
  {
    id: 'mes',
    label: 'Por mes',
    help: `Para clientes o técnicos que vienen seguido. Hasta ${MAX_MES_DAYS} días. Lo aprueba Seguridad.`
  }
];

const DURACION_IDS = new Set(DURACION_OPCIONES.map((o) => o.id));

const pad = (n) => String(n).padStart(2, '0');

const ymdLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hmLocal = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** ISO, Date o Timestamp de Firestore serializado ({ _seconds } / { seconds }). */
export function toDateOrNull(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'object') {
    const secs = raw._seconds ?? raw.seconds;
    return Number.isFinite(Number(secs)) ? new Date(Number(secs) * 1000) : null;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function normalizeDuracion(raw) {
  return DURACION_IDS.has(raw) ? raw : 'un_ingreso';
}

/** Estado inicial del selector (nuevo o a partir de una visita existente). */
export function duracionFormFrom(visita = null, now = new Date()) {
  const expected = toDateOrNull(visita?.fechaHoraEsperada) || now;
  const duracion = normalizeDuracion(visita?.duracion);
  const until = toDateOrNull(visita?.validoHasta);
  const defaultHasta = new Date(expected.getTime() + 2 * 60 * 60 * 1000);
  return {
    duracion,
    fecha: ymdLocal(expected),
    horaDesde: hmLocal(expected),
    horaHasta: duracion === 'horas' && until ? hmLocal(until) : hmLocal(defaultHasta),
    fechaHasta: duracion === 'mes' && until ? ymdLocal(until) : ymdLocal(expected)
  };
}

const addDaysYmd = (ymd, days) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
};

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^\d{2}:\d{2}$/;

/**
 * Valida igual que el backend y arma { fechaHoraEsperada, duracion, validoHasta }.
 * @returns {{ error: string }|{ payload: object }}
 */
export function buildDuracionPayload(form) {
  const duracion = normalizeDuracion(form?.duracion);
  const fecha = String(form?.fecha || '');
  if (!YMD_RE.test(fecha)) return { error: 'Elegí el día de la visita.' };

  if (duracion === 'dia' || duracion === 'mes') {
    const start = new Date(`${fecha}T00:00`);
    if (duracion === 'dia') {
      return { payload: { fechaHoraEsperada: start.toISOString(), duracion, validoHasta: null } };
    }
    const fechaHasta = String(form?.fechaHasta || '');
    if (!YMD_RE.test(fechaHasta)) return { error: 'Indicá hasta qué día vale el pase.' };
    if (fechaHasta < fecha) return { error: 'El último día tiene que ser igual o posterior al primero.' };
    if (fechaHasta > addDaysYmd(fecha, MAX_MES_DAYS - 1)) {
      return { error: `El pase por mes puede durar como máximo ${MAX_MES_DAYS} días.` };
    }
    // TODO(visitas): horario del sitio (scheduleId) cuando haya un endpoint de horarios para empleados.
    return { payload: { fechaHoraEsperada: start.toISOString(), duracion, validoHasta: fechaHasta } };
  }

  const horaDesde = String(form?.horaDesde || '');
  if (!HM_RE.test(horaDesde)) return { error: 'Poné la hora de la visita.' };
  const start = new Date(`${fecha}T${horaDesde}`);
  if (duracion === 'un_ingreso') {
    return { payload: { fechaHoraEsperada: start.toISOString(), duracion, validoHasta: null } };
  }
  const horaHasta = String(form?.horaHasta || '');
  if (!HM_RE.test(horaHasta)) return { error: 'Indicá hasta qué hora vale el pase.' };
  if (horaHasta <= horaDesde) return { error: 'La hora de fin tiene que ser después de la hora de inicio.' };
  const end = new Date(`${fecha}T${horaHasta}`);
  return { payload: { fechaHoraEsperada: start.toISOString(), duracion, validoHasta: end.toISOString() } };
}

const horaCorta = (d) => `${d.getHours()}:${pad(d.getMinutes())}`;
const diaCorto = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;

const diaRelativo = (d, now) => {
  const today = ymdLocal(now);
  const day = ymdLocal(d);
  if (day === today) return 'Hoy';
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (day === ymdLocal(tomorrow)) return 'Mañana';
  return diaCorto(d);
};

/** Fin de la validez: validoHasta o, si falta, el vencimiento del link. */
const finDe = (visita) => toDateOrNull(visita?.validoHasta) || toDateOrNull(visita?.inviteExpiresAt);

/** Texto corto para listas: "Hoy 9:00 a 13:00", "Del 14/10 al 13/11", "1 ingreso · Hoy 9:00". */
export function formatValidezCorta(visita, now = new Date()) {
  const start = toDateOrNull(visita?.fechaHoraEsperada);
  if (!start) return 'Sin fecha';
  const duracion = normalizeDuracion(visita?.duracion);
  const end = finDe(visita);
  if (duracion === 'mes') return `Del ${diaCorto(start)} al ${diaCorto(end || start)}`;
  if (duracion === 'dia') return `${diaRelativo(start, now)}, todo el día`;
  if (duracion === 'horas') {
    return end ? `${diaRelativo(start, now)} ${horaCorta(start)} a ${horaCorta(end)}` : `${diaRelativo(start, now)} desde ${horaCorta(start)}`;
  }
  return `1 ingreso · ${diaRelativo(start, now)} ${horaCorta(start)}`;
}

export function duracionLabel(raw) {
  const opt = DURACION_OPCIONES.find((o) => o.id === normalizeDuracion(raw));
  return opt ? opt.label : 'Un solo ingreso';
}

/** Texto para la persona invitada: "Válido el 14/10 de 9:00 a 13:00", "Válido del 14/10 al 13/11". */
export function formatValidezInvitacion(invite) {
  const start = toDateOrNull(invite?.fechaHoraEsperada);
  if (!start) return 'Sin fecha de vigencia';
  const duracion = normalizeDuracion(invite?.duracion);
  const end = finDe(invite);
  if (duracion === 'mes') return `Válido del ${diaCorto(start)} al ${diaCorto(end || start)}`;
  if (duracion === 'dia') return `Válido todo el día ${diaCorto(start)}`;
  if (duracion === 'horas') {
    return end
      ? `Válido el ${diaCorto(start)} de ${horaCorta(start)} a ${horaCorta(end)}`
      : `Válido el ${diaCorto(start)} desde las ${horaCorta(start)}`;
  }
  return `Válido el ${diaCorto(start)} desde las ${horaCorta(start)}. Sirve para un solo ingreso.`;
}
