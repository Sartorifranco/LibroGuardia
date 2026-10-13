'use strict';

/**
 * Sitio de prueba del compilador (no es un test: lo importan siteCompiler*.test.js).
 * Modelo Firestore ACTUAL (people, authorizations, personalMaster, visitas,
 * settings/doorsConfig, users). "Hoy" = jueves 2026-10-08, hora de Argentina (UTC−3).
 */

const { Timestamp } = require('./helpers/countingFirestore');

const ar = (ymd, hhmm = '00:00') => Date.parse(`${ymd}T${hhmm}:00.000-03:00`);
const TODAY = '2026-10-08';
const NOW = ar(TODAY, '10:00');
const BCRYPT = '$2a$10$abcdefghijklmnopqrstuuJ8m0lJp2bq1u7xXy8WvYbJ6Qk3eW9mS';

const door = (id, extra = {}) => ({
  id,
  name: `Puerta ${id}`,
  active: true,
  device: { driver: 'sr201', host: '192.168.0.38', port: 6722, channel: 1, bridgeSecret: 'NO-VIAJA', httpAuthToken: 'NO-VIAJA' },
  pulseSeconds: 3,
  relayMode: 'cloud',
  readers: [{ id: `INGRESO_${id}`, direction: 'ingreso' }, { id: `EGRESO_${id}`, direction: 'egreso' }],
  airlockGroupId: null,
  airlockRole: null,
  ...extra
});

const person = (id, dni, allowedDoorIds, extra = {}) => ({ nombre: `Persona ${id}`, dniNormalized: dni, active: true, allowedDoorIds, ...extra });
const nomina = (personId, extra = {}) => ({ personId, source: 'nomina', active: true, name: personId, ...extra });

const buildInitial = () => ({
  'sites/principal': { name: 'Planta', tz: 'America/Argentina/Buenos_Aires' },
  'settings/doorsConfig': {
    version: 1,
    doors: [
      door('P1', { name: 'Portón' }),
      door('P2', { name: 'Oficinas' }),
      door('EA', { airlockGroupId: 'estanco-1', airlockRole: 'outer' }),
      door('EB', { airlockGroupId: 'estanco-1', airlockRole: 'inner' }),
      door('P9', { active: false })
    ],
    airlockGroups: [{ id: 'estanco-1', name: 'Estanco', doorIds: ['EA', 'EB'], enabled: true, mode: 'sequential_closed',
      outerCloseDelayMs: 5000, interDoorDelayMs: 2000, transitTimeoutMs: 120000 }]
  },
  people: {
    perm1: person('perm1', '30111222', ['P1', 'P2']),
    perm24: person('perm24', '30111333', ['P1']),
    noauth: person('noauth', '30111444', ['P1']),
    cit1: person('cit1', '30111555', ['P1']),
    cit2: person('cit2', '30111556', ['P1']),
    temp1: person('temp1', '30111666', ['P2']),
    nomShift: person('nomShift', '30111777', ['P1']),
    nomSinTurno: person('nomSinTurno', '30111778', ['P1']),
    sistemas: person('sistemas', '30111888', ['P1', 'P2']),
    transp: person('transp', '30111990', ['P1']),
    transp2: person('transp2', '30111991', ['P1']),
    baja: person('baja', '30111999', ['P1'], { active: false }),
    dup1: person('dup1', '30222000', ['P1']),
    dup2: person('dup2', '30222000', ['P1']),
    airlock: person('airlock', '30333000', ['EA', 'EB'])
  },
  authorizations: {
    a_perm1: { type: 'permanent', personId: 'perm1', active: true, daysOfWeek: ['Lu', 'Ma', 'Mi', 'Ju', 'Vi'], timeWindow: { from: '08:00', to: '17:00' } },
    a_perm24: { type: 'permanent', personId: 'perm24', active: true },
    a_airlock: { type: 'permanent', personId: 'airlock', active: true },
    a_perm_old: { type: 'permanent', personId: 'perm24', active: false, allowedDoorIds: ['P2'] },
    a_cit1: { type: 'citacion', personId: 'cit1', active: true, appointmentDate: TODAY, timeWindow: { from: '14:00', to: '18:00' } },
    a_cit2_tomorrow: { type: 'citacion', personId: 'cit2', active: true, appointmentDate: '2026-10-09', timeWindow: { from: '08:00', to: '12:00' } },
    a_cit_old: { type: 'citacion', personId: 'cit2', active: true, appointmentDate: '2026-09-01' },
    a_temp1: { type: 'temporal', personId: 'temp1', active: true, startDate: '2026-10-07', endDate: '2026-10-09' },
    a_transp: { type: 'citacion', personId: 'transp', active: true, appointmentDate: TODAY, timeWindow: { from: '09:00', to: '17:00' } }
  },
  personalMaster: {
    pm_shift: nomina('nomShift', { centroCosto: 'Producción', shiftSchedule: { daysOfWeek: ['Lu', 'Ma', 'Mi', 'Ju', 'Vi'], timeWindow: { from: '06:00', to: '14:00' } } }),
    pm_sin: nomina('nomSinTurno', { centroCosto: 'Producción' }),
    pm_sis: nomina('sistemas', { centroCosto: 'Sistemas' }),
    pm_tr: nomina('transp', { centroCosto: 'Transporte', requiresCitacion: true }),
    pm_tr2: nomina('transp2', { centroCosto: 'Transporte', requiresCitacion: true }),
    pm_other_source: { personId: 'perm1', source: 'biostar', centroCosto: 'Sistemas' }
  },
  visitas: {
    v1: { nombreVisitante: 'Visita Uno', dniVisitante: '40.111.222', dniVisitanteNormalized: '40111222', estado: 'autorizada',
      fechaHoraEsperada: Timestamp.fromMillis(ar(TODAY, '11:00')), allowedDoorIds: ['P1'] },
    v2: { nombreVisitante: 'Visita Cancelada', dniVisitanteNormalized: '40111333', estado: 'cancelada',
      fechaHoraEsperada: Timestamp.fromMillis(ar(TODAY, '11:00')), allowedDoorIds: ['P1'] },
    v3: { nombreVisitante: 'Visita Pendiente Aprob', dniVisitanteNormalized: '40111444', estado: 'pendiente_aprobacion',
      fechaHoraEsperada: Timestamp.fromMillis(ar(TODAY, '11:00')), allowedDoorIds: ['P1'] },
    v_old: { nombreVisitante: 'Vieja', dniVisitanteNormalized: '40111555', estado: 'autorizada',
      fechaHoraEsperada: Timestamp.fromMillis(ar('2026-09-01', '11:00')), allowedDoorIds: ['P1'] }
  },
  users: {
    guardia1: { username: 'guardia1', password: BCRYPT, role: 'guardia', passwordVersion: 3, active: true, posts: ['porton'] },
    operador: { username: 'operador', password: BCRYPT, role: 'rol_custom', permissions: ['entries.create'], active: true },
    lector: { username: 'lector', password: BCRYPT, role: 'rol_lector', permissions: ['reports.export'], active: true },
    inactivo: { username: 'inactivo', password: BCRYPT, role: 'guardia', active: false },
    'kiosk.p1': { username: 'kiosk.p1', password: BCRYPT, role: 'kiosk_puerta', permissions: ['entries.create'], active: true }
  },
  roles: {
    rol_custom: { permissions: [] },
    rol_lector: { permissions: ['reports.export'] }
  }
});

/**
 * Casos de paridad: resultado esperado según las reglas ACTUALES (PARITY.md),
 * con el código del motor. `reason` = código del motor; `nota` cuando difiere del actual.
 */
const PARITY_CASES = [
  { name: 'permanente L-V 08-17 dentro de horario', dni: '30111222', door: 'P1', at: ar(TODAY, '10:00'), decision: 'grant', reason: 'puerta_directa' },
  { name: 'permanente con tolerancia 15 (16:10 → 17:15 ok)', dni: '30111222', door: 'P2', at: ar(TODAY, '17:10'), decision: 'grant' },
  { name: 'permanente fuera de horario', dni: '30111222', door: 'P1', at: ar(TODAY, '20:00'), decision: 'deny', reason: 'fuera_de_horario', nota: 'hoy: sin_citacion_para_hoy' },
  { name: 'permanente sábado', dni: '30111222', door: 'P1', at: ar('2026-10-10', '10:00'), decision: 'deny', reason: 'fuera_de_horario' },
  { name: 'puerta fuera de allowedDoorIds', dni: '30111333', door: 'P2', at: ar(TODAY, '10:00'), decision: 'deny', reason: 'puerta_no_autorizada' },
  { name: 'permanente sin días ni ventana = 24x7', dni: '30111333', door: 'P1', at: ar(TODAY, '03:00'), decision: 'grant', reason: 'puerta_directa' },
  { name: 'allowedDoorIds sin autorización', dni: '30111444', door: 'P1', at: ar(TODAY, '10:00'), decision: 'deny', reason: 'sin_citacion_para_hoy' },
  { name: 'citación hoy fuera de ventana (no estricta → aviso)', dni: '30111555', door: 'P1', at: ar(TODAY, '10:00'), decision: 'grant', reason: 'citacion_hoy', warning: 'citacion_fuera_de_horario' },
  { name: 'citación solo mañana', dni: '30111556', door: 'P1', at: ar(TODAY, '10:00'), decision: 'deny', reason: 'sin_citacion_para_hoy' },
  { name: 'citación de mañana vale mañana', dni: '30111556', door: 'P1', at: ar('2026-10-09', '09:00'), decision: 'grant', reason: 'citacion_hoy' },
  { name: 'temporal por rango dentro', dni: '30111666', door: 'P2', at: ar(TODAY, '23:00'), decision: 'grant', reason: 'autorizacion_temporal' },
  { name: 'temporal por rango después', dni: '30111666', door: 'P2', at: ar('2026-10-10', '09:00'), decision: 'deny', reason: 'fuera_de_vigencia' },
  { name: 'nómina turno 06-14 en horario', dni: '30111777', door: 'P1', at: ar(TODAY, '10:00'), decision: 'grant', reason: 'turno_hoy' },
  { name: 'nómina turno tolerancia 30 antes', dni: '30111777', door: 'P1', at: ar(TODAY, '05:35'), decision: 'grant', reason: 'turno_hoy' },
  { name: 'nómina turno fuera de horario', dni: '30111777', door: 'P1', at: ar(TODAY, '15:00'), decision: 'deny', reason: 'fuera_horario_turno' },
  { name: 'nómina turno fuera de día', dni: '30111777', door: 'P1', at: ar('2026-10-10', '10:00'), decision: 'deny', reason: 'fuera_dia_turno' },
  { name: 'nómina sin turno', dni: '30111778', door: 'P1', at: ar(TODAY, '10:00'), decision: 'deny', reason: 'sin_turno' },
  { name: 'Sistemas 24x7 en sus puertas', dni: '30111888', door: 'P2', at: ar(TODAY, '23:30'), decision: 'grant', reason: 'puerta_directa', nota: 'hoy: sistemas_acceso_permanente' },
  { name: 'área con citación obligatoria citado en ventana', dni: '30111990', door: 'P1', at: ar(TODAY, '10:00'), decision: 'grant', reason: 'citacion_hoy' },
  { name: 'citación obligatoria tolerancia 30 antes', dni: '30111990', door: 'P1', at: ar(TODAY, '08:35'), decision: 'grant', reason: 'citacion_hoy' },
  { name: 'citación obligatoria antes de la tolerancia', dni: '30111990', door: 'P1', at: ar(TODAY, '08:20'), decision: 'deny', reason: 'fuera_horario_turno' },
  { name: 'citación obligatoria solo en sus puertas (grant *)', dni: '30111990', door: 'P2', at: ar(TODAY, '10:00'), decision: 'deny', reason: 'puerta_no_autorizada' },
  { name: 'área con citación obligatoria sin citación hoy', dni: '30111991', door: 'P1', at: ar(TODAY, '10:00'), decision: 'deny', reason: 'sin_citacion_para_hoy', nota: 'hoy: sin_citacion_hoy (código unificado)' },
  { name: 'persona dada de baja', dni: '30111999', door: 'P1', at: ar(TODAY, '10:00'), decision: 'deny', reason: 'credencial_desconocida', nota: 'hoy: persona_inactiva (las bajas no se compilan)' },
  { name: 'DNI duplicado entre activas', dni: '30222000', door: 'P1', at: ar(TODAY, '10:00'), decision: 'deny', reason: 'dni_duplicado' },
  { name: 'DNI desconocido', dni: '99999999', door: 'P1', at: ar(TODAY, '10:00'), decision: 'deny', reason: 'credencial_desconocida', nota: 'hoy: no_encontrado' },
  { name: 'egreso libre con credencial conocida y persona activa', dni: '30111444', door: 'P1', side: 'out', at: ar(TODAY, '20:00'), decision: 'grant', reason: 'egreso_libre' },
  { name: 'egreso con DNI desconocido', dni: '99999999', door: 'P1', side: 'out', at: ar(TODAY, '20:00'), decision: 'deny', reason: 'credencial_desconocida', nota: 'hoy: "Egreso registrado"' },
  { name: 'puerta inactiva en doorsConfig', dni: '30111333', door: 'P9', at: ar(TODAY, '10:00'), decision: 'deny', reason: 'puerta_deshabilitada' },
  { name: 'lector de egreso fijo → lado out', dni: '30111444', door: 'P1', readerId: 'EGRESO_P1', at: ar(TODAY, '20:00'), decision: 'grant', reason: 'egreso_libre' },
  { name: 'visita en ventana (esperada − 2 h)', dni: '40111222', door: 'P1', at: ar(TODAY, '09:05'), decision: 'grant', reason: 'pase_visita' },
  { name: 'visita antes de la ventana', dni: '40111222', door: 'P1', at: ar(TODAY, '08:30'), decision: 'deny', reason: 'visita_antes_de_ventana' },
  { name: 'visita vence a fin del día', dni: '40111222', door: 'P1', at: ar('2026-10-09', '00:30'), decision: 'deny', reason: 'pase_vencido', nota: 'hoy: visita_fuera_de_ventana' },
  { name: 'visita en puerta ajena', dni: '40111222', door: 'P2', at: ar(TODAY, '10:00'), decision: 'deny', reason: 'puerta_no_autorizada' },
  { name: 'visita cancelada', dni: '40111333', door: 'P1', at: ar(TODAY, '10:00'), decision: 'deny', reason: 'credencial_desconocida' },
  { name: 'visita pendiente de aprobación', dni: '40111444', door: 'P1', at: ar(TODAY, '10:00'), decision: 'deny', reason: 'credencial_desconocida' },
  { name: 'estanco: puerta exterior con interior segura', dni: '30333000', door: 'EA', at: ar(TODAY, '10:00'), decision: 'grant', reason: 'puerta_directa' }
];

module.exports = { ar, TODAY, NOW, BCRYPT, buildInitial, PARITY_CASES };
