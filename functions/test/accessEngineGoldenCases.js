'use strict';

/**
 * Tabla dorada del motor de acceso (Etapa 2, docs/ETAPA2-DISENO.md §2), compartida
 * por accessEngine.test.js (snapshot en memoria) y accessEngineSqlite.test.js
 * (SqliteSnapshot del edge, T3). No es un test por sí mismo.
 * Cada fila: entrada → decision + reason (+ chequeos extra opcionales).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, REASONS } = require('../lib/accessEngine');
const { ENGINE_REASONS } = require('../lib/accessEngine/reasons.es');
const { ar, door } = require('./accessEngineFixture');

const SECURE = { state: 'SEGURA', dps: 'closed', bond: 'engaged' };
const THU_10 = ar('2026-10-08', '10:00');

const dni = (value) => ({ type: 'dni', value });

/** Casos dorados. `overrides` (para buildChunks) opcional; `state`, `mode`, `actor`, `side`, `readerId` opcionales. */
const CASES = [
  // ── 1. Credencial ──
  { name: 'DNI desconocido', credential: dni('99999999'), doorId: 'D1', expect: ['deny', 'credencial_desconocida'] },
  { name: 'tipo de credencial inválido', credential: { type: 'huella', value: '1' }, doorId: 'D1', expect: ['deny', 'credencial_desconocida'] },
  { name: 'DNI vacío tras normalizar', credential: dni('abc'), doorId: 'D1', expect: ['deny', 'credencial_desconocida'] },
  { name: 'sin credencial en modo scan', credential: null, doorId: 'D1', expect: ['deny', 'credencial_desconocida'] },
  { name: 'credencial con status revoked', credential: dni('20000015'), doorId: 'D1', expect: ['deny', 'credencial_revocada'] },
  { name: 'credencial en lista de revocaciones', credential: dni('20000018'), doorId: 'D1', expect: ['deny', 'credencial_revocada'] },
  { name: 'DNI en dos personas activas', credential: dni('30.000.001'), doorId: 'D1', expect: ['deny', 'dni_duplicado'] },
  { name: 'credencial vencida', credential: dni('20000016'), doorId: 'D1', expect: ['deny', 'fuera_de_vigencia'] },

  // ── 2. Persona ──
  { name: 'credencial huérfana (persona inexistente)', credential: dni('20000017'), doorId: 'D1', expect: ['deny', 'no_encontrado'] },
  { name: 'persona inactiva', credential: dni('20000012'), doorId: 'D1', expect: ['deny', 'persona_inactiva'] },
  { name: 'persona revocada por delta', credential: dni('20000013'), doorId: 'D1', expect: ['deny', 'persona_inactiva'] },
  { name: 'persona fuera de vigencia', credential: dni('20000014'), doorId: 'D1', expect: ['deny', 'fuera_de_vigencia'] },

  // ── 3. Puerta ──
  { name: 'puerta inexistente', credential: dni('20000001'), doorId: 'NOPE', expect: ['deny', 'puerta_desconocida'] },
  { name: 'puerta deshabilitada', credential: dni('20000001'), doorId: 'D3', expect: ['deny', 'puerta_deshabilitada'] },
  { name: 'puerta en lockdown', credential: dni('20000001'), doorId: 'D4', expect: ['deny', 'puerta_bloqueada'] },
  { name: 'lado sin configurar', credential: dni('20000001'), doorId: 'D5', side: 'out', expect: ['deny', 'lado_no_habilitado'] },
  { name: 'lector de otro lado', credential: dni('20000001'), doorId: 'D1', side: 'in', readerId: 'D1-out', expect: ['deny', 'lado_no_habilitado'] },
  { name: 'lector desconocido', credential: dni('20000001'), doorId: 'D1', readerId: 'X', expect: ['deny', 'lado_no_habilitado'] },

  // ── 4. Derechos: accessAll / grupos / directas ──
  { name: 'accessAll por DNI', credential: dni('20000001'), doorId: 'D1', expect: ['grant', 'acceso_total'],
    check: (r) => assert.deepEqual(r.actions, [{ type: 'unlock', doorId: 'D1', ms: 3000 }]) },
  { name: 'accessAll por tarjeta (normaliza espacios y mayúsculas)', credential: { type: 'card', value: 'ab12cd' }, doorId: 'D2', expect: ['grant', 'acceso_total'] },
  { name: 'accessAll por BioStar', credential: { type: 'biostar', value: ' 1001 ' }, doorId: 'D2', expect: ['grant', 'acceso_total'] },
  { name: 'accessAll en puerta agregada después', credential: dni('20000001'), doorId: 'D9',
    overrides: { extraDoors: [door('D9')] }, expect: ['grant', 'acceso_total'] },
  { name: "grupo '*' en puerta agregada después", credential: dni('20000002'), doorId: 'D9',
    overrides: { extraDoors: [door('D9')] }, expect: ['grant', 'nivel_acceso'] },
  { name: 'lector define el lado', credential: dni('20000001'), doorId: 'D1', readerId: 'D1-in', expect: ['grant', 'acceso_total'],
    check: (r) => assert.equal(r.side, 'in') },
  { name: 'grupo con horario de oficina, dentro', credential: dni('20000003'), doorId: 'D2', expect: ['grant', 'nivel_acceso'],
    check: (r) => assert.deepEqual(r.matched, { source: 'group', id: 'grp_oficina', scheduleId: 'oficina' }) },
  { name: 'grupo oficina 18:00:59 (minuto final inclusivo)', credential: dni('20000003'), doorId: 'D2', at: ar('2026-10-08', '18:00', '59'), expect: ['grant', 'nivel_acceso'] },
  { name: 'grupo oficina 18:01', credential: dni('20000003'), doorId: 'D2', at: ar('2026-10-08', '18:01'), expect: ['deny', 'fuera_de_horario'] },
  { name: 'grupo oficina sábado', credential: dni('20000003'), doorId: 'D2', at: ar('2026-10-10', '10:00'), expect: ['deny', 'fuera_de_horario'] },
  { name: 'grupo oficina feriado (deny)', credential: dni('20000003'), doorId: 'D2', at: ar('2026-10-12', '10:00'), expect: ['deny', 'feriado'] },
  { name: 'puerta fuera de sus grupos', credential: dni('20000003'), doorId: 'D1', expect: ['deny', 'puerta_no_autorizada'] },
  { name: 'nocturno mar 23:30', credential: dni('20000004'), doorId: 'D1', at: ar('2026-10-06', '23:30'), expect: ['grant', 'nivel_acceso'] },
  { name: 'nocturno mié 05:30 (empezó el martes)', credential: dni('20000004'), doorId: 'D1', at: ar('2026-10-07', '05:30'), expect: ['grant', 'nivel_acceso'] },
  { name: 'nocturno sáb 03:00 (empezó el viernes)', credential: dni('20000004'), doorId: 'D1', at: ar('2026-10-10', '03:00'), expect: ['grant', 'nivel_acceso'] },
  { name: 'nocturno dom 03:00 (sábado no habilitado)', credential: dni('20000004'), doorId: 'D1', at: ar('2026-10-11', '03:00'), expect: ['deny', 'fuera_de_horario'] },
  { name: 'nocturno jue 12:00', credential: dni('20000004'), doorId: 'D1', expect: ['deny', 'fuera_de_horario'], at: ar('2026-10-08', '12:00') },
  { name: 'puerta directa 24x7', credential: dni('20000005'), doorId: 'D1', at: ar('2026-10-11', '03:00'), expect: ['grant', 'puerta_directa'] },

  // ── Turno de nómina ──
  { name: 'turno: 30 min antes (tolerancia)', credential: dni('20000006'), doorId: 'D1', at: ar('2026-10-08', '05:30'), expect: ['grant', 'turno_hoy'] },
  { name: 'turno: 31 min antes', credential: dni('20000006'), doorId: 'D1', at: ar('2026-10-08', '05:29'), expect: ['deny', 'fuera_horario_turno'] },
  { name: 'turno: 15 min después', credential: dni('20000006'), doorId: 'D1', at: ar('2026-10-08', '14:15'), expect: ['grant', 'turno_hoy'] },
  { name: 'turno: 16 min después', credential: dni('20000006'), doorId: 'D1', at: ar('2026-10-08', '14:16'), expect: ['deny', 'fuera_horario_turno'] },
  { name: 'turno: día no laborable', credential: dni('20000006'), doorId: 'D1', at: ar('2026-10-10', '08:00'), expect: ['deny', 'fuera_dia_turno'] },
  { name: 'turno sin intervalos', credential: dni('20000007'), doorId: 'D1', expect: ['deny', 'sin_turno'] },

  // ── Citación / grants ──
  { name: 'citación obligatoria dentro de ventana', credential: dni('20000008'), doorId: 'D1', at: ar('2026-10-08', '09:00'), expect: ['grant', 'citacion_hoy'],
    check: (r) => assert.equal(r.matched.id, 'auth_1') },
  { name: 'citación obligatoria fuera de ventana (siempre estricta)', credential: dni('20000008'), doorId: 'D1', at: ar('2026-10-08', '13:00'), expect: ['deny', 'fuera_horario_turno'] },
  { name: 'citación obligatoria otro día', credential: dni('20000008'), doorId: 'D1', at: ar('2026-10-09', '09:00'), expect: ['deny', 'sin_citacion_para_hoy'] },
  { name: "citación 'inherit' no abre puertas sin derecho", credential: dni('20000008'), doorId: 'D2', at: ar('2026-10-08', '09:00'), expect: ['deny', 'puerta_no_autorizada'] },
  { name: 'citación no estricta fuera de hora → aviso', credential: dni('20000009'), doorId: 'D2', at: ar('2026-10-08', '15:00'), expect: ['grant', 'citacion_hoy'],
    check: (r) => assert.deepEqual(r.warnings, ['citacion_fuera_de_horario']) },
  { name: 'citación con política estricta fuera de hora', credential: dni('20000009'), doorId: 'D2', at: ar('2026-10-08', '15:00'),
    overrides: { policy: { citacionWindowStrict: true } }, expect: ['deny', 'fuera_horario_turno'] },
  { name: 'autorización temporal vigente', credential: dni('20000010'), doorId: 'D2', at: ar('2026-10-07', '10:00'), expect: ['grant', 'autorizacion_temporal'] },
  { name: 'autorización temporal vencida', credential: dni('20000010'), doorId: 'D2', at: ar('2026-10-10', '10:00'), expect: ['deny', 'fuera_de_vigencia'] },
  { name: 'autorización temporal revocada', credential: dni('20000010'), doorId: 'D2', at: ar('2026-10-07', '10:00'),
    overrides: { revocations: ['grant:auth_3'] }, expect: ['deny', 'puerta_no_autorizada'] },
  { name: 'grant de visita antes de ventana', credential: dni('20000011'), doorId: 'D2', at: ar('2026-10-08', '07:00'), expect: ['deny', 'visita_antes_de_ventana'] },
  { name: 'grant de visita vigente', credential: dni('20000011'), doorId: 'D2', expect: ['grant', 'visita_autorizada'] },
  { name: 'grant de visita vencido', credential: dni('20000011'), doorId: 'D2', at: ar('2026-10-09', '10:00'), expect: ['deny', 'visita_fuera_de_ventana'] },

  // ── Pases de visita (D9/D10) ──
  { name: 'pase por DNI', credential: dni('40.111.222'), doorId: 'D1', expect: ['grant', 'pase_visita'],
    check: (r) => {
      assert.equal(r.passId, 'QR-P1');
      assert.equal(r.cardholderId, null);
      assert.deepEqual(r.stateEffects.pass, { id: 'QR-P1', status: 'ingreso_registrado', usesDelta: 1 });
    } },
  { name: 'pase por QR en segunda puerta', credential: { type: 'qr', value: 'QR-P1' }, doorId: 'D2', expect: ['grant', 'pase_visita'] },
  { name: 'pase en puerta no incluida', credential: dni('40111222'), doorId: 'D5', expect: ['deny', 'puerta_no_autorizada'] },
  { name: 'pase antes de la ventana', credential: dni('40111222'), doorId: 'D1', at: ar('2026-10-08', '07:00'), expect: ['deny', 'visita_antes_de_ventana'] },
  { name: 'pase vencido', credential: dni('40333444'), doorId: 'D1', expect: ['deny', 'pase_vencido'] },
  { name: 'pase revocado', credential: dni('40555666'), doorId: 'D1', expect: ['deny', 'credencial_revocada'] },
  { name: 'pase en passes.revoked (fechas ISO)', credential: dni('40121212'), doorId: 'D1', expect: ['deny', 'credencial_revocada'] },
  { name: 'pase agotado (maxUses)', credential: dni('40999000'), doorId: 'D1', expect: ['deny', 'pase_utilizado'] },
  { name: 'egreso de visita con ingreso registrado (fuera de ventana)', credential: dni('40777888'), doorId: 'D1', side: 'out',
    at: ar('2026-10-08', '01:00'), expect: ['grant', 'egreso_visita'],
    check: (r) => assert.deepEqual(r.stateEffects.pass, { id: 'p4', status: 'egreso_registrado' }) },
  { name: 'egreso de visita sin ingreso', credential: dni('40111222'), doorId: 'D1', side: 'out', expect: ['deny', 'pase_sin_ingreso'] },
  { name: 'egreso de visita con presencia en el hub', credential: dni('40111222'), doorId: 'D1', side: 'out',
    state: { presence: { 'pass:QR-P1': { areaId: 'planta', ts: ar('2026-10-08', '09:00') } } }, expect: ['grant', 'egreso_visita'] },

  // ── Egreso libre ──
  { name: 'egreso libre sin derechos sobre la puerta', credential: dni('20000003'), doorId: 'D1', side: 'out', expect: ['grant', 'egreso_libre'] },
  { name: 'egreso libre no revive a una baja', credential: dni('20000012'), doorId: 'D1', side: 'out', expect: ['deny', 'persona_inactiva'] },

  // ── 5. Política ──
  { name: 'portón de clientes requiere aprobación', credential: dni('20000005'), doorId: 'D6', expect: ['needs_approval', 'requiere_aprobacion_guardia'],
    check: (r) => assert.deepEqual(r.actions, []) },
  { name: 'aprobación manual del guardia en portón de clientes', credential: null, doorId: 'D6', mode: 'manual', actor: { id: 'guardia1' }, expect: ['grant', 'apertura_manual'] },

  // ── Reloj no confiable ──
  { name: 'reloj no confiable: 24x7 pasa', credential: dni('20000001'), doorId: 'D1', state: { clockTrusted: false }, expect: ['grant', 'acceso_total'] },
  { name: 'reloj no confiable: horario se niega', credential: dni('20000003'), doorId: 'D2', state: { clockTrusted: false }, expect: ['deny', 'reloj_no_confiable'] },
  { name: 'reloj no confiable: citación se niega', credential: dni('20000008'), doorId: 'D1', at: ar('2026-10-08', '09:00'), state: { clockTrusted: false }, expect: ['deny', 'reloj_no_confiable'] },
  { name: 'reloj no confiable: pase se niega', credential: dni('40111222'), doorId: 'D1', state: { clockTrusted: false }, expect: ['deny', 'reloj_no_confiable'] },
  { name: 'reloj no confiable: turno se niega', credential: dni('20000006'), doorId: 'D1', at: ar('2026-10-08', '07:00'), state: { clockTrusted: false }, expect: ['deny', 'reloj_no_confiable'] },

  // ── 6. Interlock sensor ──
  { name: 'estanco sensor: otra puerta segura', credential: dni('20000005'), doorId: 'EA', state: { doorStates: { EB: SECURE } }, expect: ['grant', 'puerta_directa'] },
  { name: 'estanco sensor: otra abierta', credential: dni('20000005'), doorId: 'EA',
    state: { doorStates: { EB: { state: 'ABIERTA_AUT', dps: 'open', bond: 'released' } } }, expect: ['deny', 'estanco_ocupado'] },
  { name: 'estanco sensor: bond sin trabar', credential: dni('20000005'), doorId: 'EA',
    state: { doorStates: { EB: { state: 'SEGURA', dps: 'closed', bond: 'released' } } }, expect: ['deny', 'estanco_ocupado'] },
  { name: 'estanco sensor: estado desconocido (falla cerrada)', credential: dni('20000005'), doorId: 'EA', state: { doorStates: {} }, expect: ['deny', 'estanco_ocupado'] },
  { name: 'estanco sensor manual: otra abierta → AIRLOCK_OTHER_OPEN', credential: null, doorId: 'EA', mode: 'manual', actor: { id: 'g' },
    state: { doorStates: { EB: { state: 'DESBLOQUEADA', dps: 'open' } } }, expect: ['deny', 'estanco_ocupado'],
    check: (r) => { assert.equal(r.code, 'AIRLOCK_OTHER_OPEN'); assert.equal(r.forcible, true); } },
  { name: 'forzar sin permiso', credential: null, doorId: 'EA', mode: 'manual',
    actor: { id: 'g', permissions: ['access.manual_open'], force: true, forceReason: 'emergencia médica' },
    state: { doorStates: { EB: { state: 'DESBLOQUEADA', dps: 'open' } } }, expect: ['deny', 'sin_permiso_forzar'] },
  { name: 'forzar con permiso y motivo corto', credential: null, doorId: 'EA', mode: 'manual',
    actor: { id: 'g', permissions: ['puertas.estanco.forzar'], force: true, forceReason: ' ok ' },
    state: { doorStates: { EB: { state: 'DESBLOQUEADA', dps: 'open' } } }, expect: ['deny', 'motivo_forzado_requerido'] },
  { name: 'forzar con permiso y motivo', credential: null, doorId: 'EA', mode: 'remote',
    actor: { id: 'g', permissions: ['puertas.estanco.forzar'], force: true, forceReason: 'evacuación' },
    state: { doorStates: { EB: { state: 'DESBLOQUEADA', dps: 'open' } } }, expect: ['grant', 'apertura_forzada_estanco'],
    check: (r) => { assert.equal(r.forced, true); assert.ok(r.warnings.includes('apertura_forzada_estanco')); } },

  // ── Interlock timed (port de doorController) ──
  { name: 'estanco timed: exterior en reposo', credential: dni('20000005'), doorId: 'TA', expect: ['grant', 'puerta_directa'],
    check: (r) => assert.deepEqual(r.stateEffects.interlock, {
      groupId: 'G2', phase: 'outer_open', outerOpenedAtMs: THU_10, innerOpenedAtMs: null, entryDoorId: 'TA'
    }) },
  { name: 'estanco timed: interior sin pasar por exterior', credential: dni('20000005'), doorId: 'TB', expect: ['deny', 'debe_ingresar_por_exterior'] },
  { name: 'estanco timed: interior con exterior abierta', credential: dni('20000005'), doorId: 'TB',
    state: { interlock: { G2: { phase: 'outer_open', outerOpenedAtMs: THU_10 - 1000, entryDoorId: 'TA' } } }, expect: ['deny', 'estanco_ocupado'] },
  { name: 'estanco timed: interior durante retardo', credential: dni('20000005'), doorId: 'TB',
    state: { interlock: { G2: { phase: 'outer_open', outerOpenedAtMs: THU_10 - 6000, entryDoorId: 'TA' } } }, expect: ['deny', 'estanco_ocupado'] },
  { name: 'estanco timed: interior habilitada', credential: dni('20000005'), doorId: 'TB',
    state: { interlock: { G2: { phase: 'outer_open', outerOpenedAtMs: THU_10 - 8000, entryDoorId: 'TA' } } }, expect: ['grant', 'puerta_directa'],
    check: (r) => assert.equal(r.stateEffects.interlock.phase, 'inner_open') },
  { name: 'estanco timed: exterior en tránsito', credential: dni('20000005'), doorId: 'TA',
    state: { interlock: { G2: { phase: 'outer_open', outerOpenedAtMs: THU_10 - 8000, entryDoorId: 'TA' } } }, expect: ['deny', 'estanco_ocupado'] },
  { name: 'estanco timed: tránsito vencido vuelve a reposo', credential: dni('20000005'), doorId: 'TA',
    state: { interlock: { G2: { phase: 'outer_open', outerOpenedAtMs: THU_10 - 200000, entryDoorId: 'TA' } } }, expect: ['grant', 'puerta_directa'] },
  { name: 'estanco timed: salida empieza por la interior', credential: dni('20000005'), doorId: 'TB', side: 'out', expect: ['grant', 'puerta_directa'],
    check: (r) => assert.equal(r.stateEffects.interlock.entryDoorId, 'TB') },
  { name: 'estanco timed manual: otra abierta', credential: null, doorId: 'TB', mode: 'manual', actor: { id: 'g' },
    state: { interlock: { G2: { phase: 'outer_open', outerOpenedAtMs: THU_10 - 1000, entryDoorId: 'TA' } } }, expect: ['deny', 'estanco_ocupado'],
    check: (r) => assert.equal(r.code, 'AIRLOCK_OTHER_OPEN') },
  { name: 'estanco timed manual: interior en reposo (sin exigir secuencia)', credential: null, doorId: 'TB', mode: 'manual', actor: { id: 'g' }, expect: ['grant', 'apertura_manual'] },

  // ── 7. Anti-passback ──
  { name: 'APB duro: ya figura adentro', credential: dni('20000001'), doorId: 'D1', overrides: { policy: { apbMode: 'hard' } },
    state: { presence: { ch_all: { areaId: 'planta', ts: THU_10 - 60000 } } }, expect: ['deny', 'apb_violacion'] },
  { name: 'APB blando: pasa con aviso', credential: dni('20000001'), doorId: 'D1', overrides: { policy: { apbMode: 'soft' } },
    state: { presence: { ch_all: { areaId: 'planta', ts: THU_10 - 60000 } } }, expect: ['grant', 'acceso_total'],
    check: (r) => assert.deepEqual(r.warnings, ['apb_advertencia']) },
  { name: 'APB duro: presencia vencida por apbResetMin', credential: dni('20000001'), doorId: 'D1',
    overrides: { policy: { apbMode: 'hard', apbResetMin: 60 } },
    state: { presence: { ch_all: { areaId: 'planta', ts: THU_10 - 61 * 60000 } } }, expect: ['grant', 'acceso_total'] },
  { name: 'APB duro: zona correcta', credential: dni('20000001'), doorId: 'D1', overrides: { policy: { apbMode: 'hard' } },
    state: { presence: { ch_all: { areaId: 'exterior', ts: THU_10 - 60000 } } }, expect: ['grant', 'acceso_total'],
    check: (r) => assert.deepEqual(r.stateEffects.presence, { ch_all: { areaId: 'planta', ts: THU_10 } }) },
  { name: 'APB duro sin presencia (hub caído) baja a blando', credential: dni('20000001'), doorId: 'D1',
    overrides: { policy: { apbMode: 'hard' } }, state: { presence: null }, expect: ['grant', 'acceso_total'],
    check: (r) => assert.deepEqual(r.warnings, ['apb_sin_presencia']) },

  // ── Manual / remota ──
  { name: 'apertura manual sin estanco', credential: null, doorId: 'D1', mode: 'manual', actor: { id: 'g' }, expect: ['grant', 'apertura_manual'] },
  { name: 'apertura remota', credential: null, doorId: 'D2', mode: 'remote', actor: { id: 'g' }, expect: ['grant', 'apertura_remota'] },
  { name: 'apertura manual en lockdown', credential: null, doorId: 'D4', mode: 'manual', actor: { id: 'g' }, expect: ['deny', 'puerta_bloqueada'] }
];


/**
 * Registra un test por caso + el de cobertura de códigos.
 * @param {string} label
 * @param {(overrides?:object) => import('../lib/accessEngine/snapshotSchema').SnapLookup} makeSnap
 * @param {object} [testOpts]  opciones de node:test (p. ej. { skip })
 */
const runGolden = (label, makeSnap, testOpts = {}) => {
  const seenReasons = new Set();
  let base = null;
  const snapFor = (c) => {
    if (c.overrides) return makeSnap(c.overrides);
    if (!base) base = makeSnap();
    return base;
  };
  for (const c of CASES) {
    test(`${label}: ${c.name}`, testOpts, () => {
      const r = decide({
        snap: snapFor(c),
        credential: c.credential,
        doorId: c.doorId,
        side: c.side,
        readerId: c.readerId,
        at: c.at ?? THU_10,
        state: c.state || { doorStates: { EA: SECURE, EB: SECURE }, presence: {} },
        mode: c.mode || 'scan',
        actor: c.actor || null
      });
      assert.equal(r.decision, c.expect[0], `decision (${r.reason})`);
      assert.equal(r.reason, c.expect[1]);
      assert.equal(typeof r.message, 'string');
      assert.ok(r.message.length > 0);
      if (r.decision !== 'grant') assert.deepEqual(r.actions, []);
      seenReasons.add(r.reason);
      r.warnings.forEach((w) => seenReasons.add(w));
      if (c.check) c.check(r);
    });
  }
  test(`${label}: la tabla dorada tiene ≥40 casos y cubre todos los códigos del motor`, testOpts, () => {
    assert.ok(CASES.length >= 40, `casos: ${CASES.length}`);
    const missing = ENGINE_REASONS.filter((code) => !seenReasons.has(code));
    assert.deepEqual(missing, []);
    for (const code of seenReasons) assert.ok(REASONS[code], `sin mensaje: ${code}`);
  });
};

module.exports = { CASES, runGolden, THU_10, SECURE, dni };
