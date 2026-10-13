'use strict';

/**
 * Motor de decisión puro (docs/ETAPA2-DISENO.md §2).
 *
 * Orden de evaluación (el primer fallo corta):
 *   1. credencial  → credencial_desconocida | credencial_revocada | dni_duplicado | fuera_de_vigencia
 *   2. persona     → no_encontrado | persona_inactiva | fuera_de_vigencia
 *   3. puerta      → puerta_desconocida | puerta_deshabilitada | puerta_bloqueada | lado_no_habilitado
 *   4. derechos    → unión de accessAll (D7), grupos, puertas directas, grants, pase de visita (D9/D10)
 *                    con turno (shiftScheduleId), citación obligatoria (requiresGrant) y feriados
 *   5. política    → requireGuardApproval (D16) → 'needs_approval'
 *   6. interlock   → estanco_esperar (la otra puerta está abierta) | estanco_ocupado |
 *                    debe_ingresar_por_exterior (manual: AIRLOCK_OTHER_OPEN forzable).
 *                    Si ESTA puerta ya está destrabada o abierta, el escaneo se registra
 *                    (paso_registrado_puerta_abierta) y no se trata como error.
 *   7. APB         → apb_advertencia (blando, se permite) | apb_violacion (duro)
 *
 * Nunca lee el reloj del sistema: el instante es `at` (ms). Síncrono.
 * La coacción (duress) NO se decide acá: la informa BioStar como alarma.
 */

const { DEFAULT_POLICY, DEFAULT_TZ, CREDENTIAL_TYPES, hashCredential, normalizeCredentialValue } = require('./snapshotSchema');
const { evaluateSchedule, is24x7, localParts } = require('./schedule');
const { evaluateInterlock } = require('./interlock');
const { evaluateApb } = require('./apb');
const { reasonMessage } = require('./reasons.es');

const DEFAULT_UNLOCK_SEC = 3;
const MODES = new Set(['scan', 'manual', 'remote']);
const STATIC_SOURCES = new Set(['accessAll', 'group', 'direct']);
/** Cualquier otra fuente de rights es un grant con ventana from/to ('grant' genérico = temporal). */
const GRANT_REASON_BY_SOURCE = { citacion: 'citacion', visita: 'visita' };
/** Preferencia entre derechos que habilitan (como AUTH_PRIORITY: permanente > citación > rango). */
const SOURCE_ORDER = ['accessAll', 'group', 'direct', 'citacion', 'temporal', 'visita', 'pass'];
const GRANT_REASON = {
  accessAll: 'acceso_total',
  group: 'nivel_acceso',
  direct: 'puerta_directa',
  citacion: 'citacion_hoy',
  temporal: 'autorizacion_temporal',
  visita: 'visita_autorizada',
  pass: 'pase_visita'
};
/** Si fallan todos los derechos, se informa el motivo más específico. */
const FAILURE_RANK = [
  'reloj_no_confiable',
  'fuera_horario_turno',
  'fuera_dia_turno',
  'sin_turno',
  'feriado',
  'fuera_de_horario',
  'pase_utilizado',
  'pase_sin_ingreso',
  'visita_antes_de_ventana',
  'visita_fuera_de_ventana',
  'pase_vencido',
  'fuera_de_vigencia',
  'sin_citacion_para_hoy',
  'puerta_no_autorizada'
];
const rankOf = (r) => {
  const i = FAILURE_RANK.indexOf(r);
  return i === -1 ? FAILURE_RANK.length : i;
};
const pickFailure = (reasons) => reasons.slice().sort((a, b) => rankOf(a) - rankOf(b))[0] || 'puerta_no_autorizada';

const CLOSED_PASS = new Set(['cancelada', 'revocada']);
/** Puerta ya liberada: un escaneo autorizado registra el paso (no es un error). */
const PASSAGE_STATES = new Set(['DESBLOQUEADA', 'ABIERTA_AUT', 'RETENIDA']);
/** Destrabada o con la hoja abierta: un intento de quien no está autorizado lleva aviso. */
const LEAF_OPEN_STATES = new Set(['DESBLOQUEADA', 'ABIERTA_AUT', 'RETENIDA', 'FORZADA']);

/** ms epoch | ISO | {_seconds} → ms o null (las filas del edge ya vienen en ms; los pases pueden traer ISO). */
const toMs = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object') {
    const sec = Number(v._seconds ?? v.seconds);
    return Number.isFinite(sec) ? sec * 1000 : null;
  }
  const n = Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
};

const outsideValidity = (obj, at) => {
  const from = toMs(obj?.validFrom);
  const to = toMs(obj?.validTo);
  return (from != null && at < from) || (to != null && at > to);
};

const grantKind = (source) => GRANT_REASON_BY_SOURCE[source] || 'temporal';

/**
 * findCredential: contrato = null | credencial | {status:'duplicate', cardholderIds}.
 * Por compatibilidad también acepta un array de filas.
 */
const normalizeFound = (found) => {
  if (!Array.isArray(found)) return found || null;
  if (!found.length) return null;
  if (found.length === 1) return found[0];
  const active = found.filter((r) => !r.status || r.status === 'active');
  if (active.length === 1) return active[0];
  return { ...(active[0] || found[0]), status: 'duplicate', cardholderIds: found.map((r) => r.cardholderId).sort() };
};

// ───────────────────────────── Derechos ──────────────────────────────

const evaluateGrantRow = (row, { at, tz, policy, cardholder, clockTrusted }) => {
  if (!clockTrusted) return { ok: false, reason: 'reloj_no_confiable' };
  const kind = grantKind(row.source);
  const from = toMs(row.validFrom);
  const to = toMs(row.validTo);
  if (from == null || to == null) return { ok: false, reason: 'fuera_de_vigencia' };
  if (kind === 'citacion') {
    const strict = policy.citacionWindowStrict === true || cardholder.requiresGrant === true;
    const today = localParts(at, tz).ymd;
    const sameDay = today >= localParts(from, tz).ymd && today <= localParts(to, tz).ymd;
    if (!sameDay) return { ok: false, reason: 'sin_citacion_para_hoy' };
    if (at >= from && at <= to) return { ok: true };
    if (strict) return { ok: false, reason: 'fuera_horario_turno' };
    return { ok: true, warning: 'citacion_fuera_de_horario' };
  }
  if (at < from) return { ok: false, reason: kind === 'visita' ? 'visita_antes_de_ventana' : 'fuera_de_vigencia' };
  if (at > to) return { ok: false, reason: kind === 'visita' ? 'visita_fuera_de_ventana' : 'fuera_de_vigencia' };
  return { ok: true };
};

const SHIFT_REASON = {
  fuera_dia: 'fuera_dia_turno',
  fuera_horario: 'fuera_horario_turno',
  feriado: 'feriado',
  sin_intervalos: 'sin_turno'
};

const evaluateStaticRow = (row, { snap, at, tz, cardholder, clockTrusted }) => {
  const isHoliday = (ymd, setId) => snap.isHoliday(ymd, setId);
  if (outsideValidity(row, at)) return { ok: false, reason: 'fuera_de_vigencia' };
  const sch = snap.schedule(row.scheduleId || '24x7');
  if (!sch) return { ok: false, reason: 'fuera_de_horario' };
  if (!clockTrusted && !is24x7(sch)) return { ok: false, reason: 'reloj_no_confiable' };
  const ev = evaluateSchedule(sch, at, tz, { isHoliday });
  if (!ev.ok) return { ok: false, reason: ev.reason === 'feriado' ? 'feriado' : 'fuera_de_horario' };

  if (cardholder.shiftScheduleId) {
    const shift = snap.schedule(cardholder.shiftScheduleId);
    if (!shift) return { ok: false, reason: 'sin_turno' };
    if (!clockTrusted && !is24x7(shift)) return { ok: false, reason: 'reloj_no_confiable' };
    const sv = evaluateSchedule(shift, at, tz, { isHoliday });
    if (!sv.ok) return { ok: false, reason: SHIFT_REASON[sv.reason] || 'fuera_horario_turno' };
    return { ok: true, shift: true };
  }
  return { ok: true };
};

/** Derechos de una persona (sin pases). → {ok, matched, reason, warnings} */
const evaluateCardholderRights = (ctx) => {
  const { snap, cardholder, doorId } = ctx;
  const rows = (snap.rightsFor(cardholder.id, doorId) || []).map((r) => ({ ...r, refId: r.refId ?? r.id ?? null }));
  const staticRows = rows.filter((r) => STATIC_SOURCES.has(r.source));
  // D7: accessAll no se materializa en rights (tampoco en el edge): se lee de la persona.
  if (cardholder.accessAll === true) {
    staticRows.unshift({
      doorId, source: 'accessAll', refId: 'accessAll',
      scheduleId: cardholder.accessAllScheduleId || '24x7', validFrom: null, validTo: null
    });
  }
  let grantRows = rows.filter((r) => !STATIC_SOURCES.has(r.source) && !snap.isRevoked(`grant:${r.refId}`));
  // Citación obligatoria: los derechos estáticos definen las puertas; un grant
  // (aunque sea doors '*') no habilita puertas fuera de ellos.
  if (cardholder.requiresGrant === true && !staticRows.length) grantRows = [];
  if (!staticRows.length && !grantRows.length) return { ok: false, reason: 'puerta_no_autorizada' };

  const successes = [];
  const failures = [];

  for (const row of grantRows) {
    const r = evaluateGrantRow(row, ctx);
    if (r.ok) successes.push({ row, warning: r.warning || null });
    else failures.push(r.reason);
  }

  if (cardholder.requiresGrant === true) {
    // Los derechos estáticos solo definen puertas. Sin grant del día no se consulta
    // el turno: sch_sin_turno devolvería sin_turno y taparía la falta de citación.
    if (!successes.length) {
      const reasons = failures.filter((r) => r !== 'sin_turno');
      return { ok: false, reason: reasons.length ? pickFailure(reasons) : 'sin_citacion_para_hoy' };
    }
  } else {
    for (const row of staticRows) {
      const r = evaluateStaticRow(row, ctx);
      if (r.ok) successes.push({ row, shift: r.shift === true });
      else failures.push(r.reason);
    }
  }

  if (!successes.length) return { ok: false, reason: pickFailure(failures) };
  const sourceOf = (row) => (STATIC_SOURCES.has(row.source) ? row.source : grantKind(row.source));
  successes.sort((a, b) => SOURCE_ORDER.indexOf(sourceOf(a.row)) - SOURCE_ORDER.indexOf(sourceOf(b.row)));
  const best = successes[0];
  const source = sourceOf(best.row);
  return {
    ok: true,
    reason: best.shift ? 'turno_hoy' : GRANT_REASON[source],
    matched: {
      source,
      id: best.row.refId ?? (source === 'direct' ? 'direct' : null),
      scheduleId: STATIC_SOURCES.has(best.row.source) ? (best.row.scheduleId ?? '24x7') : null
    },
    warnings: best.warning ? [best.warning] : []
  };
};

// ───────────────────────────── Pases ─────────────────────────────────

const exteriorArea = (snap, areaId) => {
  if (!areaId) return false;
  if (areaId === 'exterior') return true;
  const area = typeof snap.area === 'function' ? snap.area(areaId) : null;
  return Boolean(area && area.exterior === true);
};

/** Pase de visita (D9/D10). → {ok, pass, reason, effect} */
const evaluatePasses = (passes, { snap, door, side, sideDef, at, tz, clockTrusted, presence }) => {
  const failures = [];
  for (const p of passes) {
    const validFrom = toMs(p.validFrom);
    const validTo = toMs(p.validTo);
    const onDoor = Array.isArray(p.doors) && p.doors.includes(door.id);
    if (side === 'out') {
      const inside = p.status === 'ingreso_registrado' || Boolean(presence && presence[`pass:${p.id}`]);
      if (!inside) { failures.push('pase_sin_ingreso'); continue; }
      if (!onDoor) { failures.push('puerta_no_autorizada'); continue; }
      // El egreso no revalida la ventana (no dejar gente atrapada), igual que visitasAccess.
      const closes = exteriorArea(snap, sideDef?.zoneTo);
      return { ok: true, pass: p, reason: 'egreso_visita', effect: closes ? { id: p.id, status: 'egreso_registrado' } : null };
    }
    const limited = Number.isFinite(p.maxUses);
    // Sin maxUses (por horas, día o mes) se vuelve a entrar después de salir.
    if (p.status === 'egreso_registrado' && limited) { failures.push('pase_utilizado'); continue; }
    const firstIngress = p.status !== 'ingreso_registrado';
    if (firstIngress && limited && (Number(p.uses) || 0) >= p.maxUses) {
      failures.push('pase_utilizado');
      continue;
    }
    if (!clockTrusted) { failures.push('reloj_no_confiable'); continue; }
    if (validFrom == null || validTo == null || at > validTo) { failures.push('pase_vencido'); continue; }
    if (at < validFrom) { failures.push('visita_antes_de_ventana'); continue; }
    if (!onDoor) { failures.push('puerta_no_autorizada'); continue; }
    if (p.scheduleId) {
      const sch = snap.schedule(String(p.scheduleId));
      if (!sch) { failures.push('fuera_de_horario'); continue; }
      const ev = evaluateSchedule(sch, at, tz, { isHoliday: (ymd, setId) => snap.isHoliday(ymd, setId) });
      if (!ev.ok) { failures.push(ev.reason === 'feriado' ? 'feriado' : 'fuera_de_horario'); continue; }
    }
    return {
      ok: true,
      pass: p,
      reason: 'pase_visita',
      effect: firstIngress ? { id: p.id, status: 'ingreso_registrado', usesDelta: 1 } : null
    };
  }
  return { ok: false, reason: pickFailure(failures) };
};

// ───────────────────────────── decide ────────────────────────────────

/**
 * @param {Object} input
 * @param {import('./snapshotSchema').SnapLookup} input.snap
 * @param {{type:string, value:string}|null} [input.credential]   requerido en mode 'scan'
 * @param {string} input.doorId
 * @param {'in'|'out'} [input.side]   default: lado del lector (readerId) o 'in'
 * @param {string} [input.readerId]
 * @param {number} input.at           ms epoch
 * @param {{interlock?:Object, presence?:Object|null, doorStates?:Object, clockTrusted?:boolean}} [input.state]
 * @param {'scan'|'manual'|'remote'} [input.mode='scan']
 * @param {{id?:string, permissions?:string[], force?:boolean, forceReason?:string}} [input.actor]
 */
const decide = (input = {}) => {
  const {
    snap,
    credential = null,
    doorId,
    readerId = null,
    at,
    state = {},
    mode = 'scan',
    actor = null
  } = input;
  if (!snap || typeof snap.door !== 'function') throw new TypeError('decide: snap es obligatorio');
  if (typeof at !== 'number' || !Number.isFinite(at)) throw new TypeError('decide: at (ms) es obligatorio');
  if (!MODES.has(mode)) throw new TypeError(`decide: mode inválido "${mode}"`);

  const rawPolicy = snap.policy() || {};
  const site = typeof snap.site === 'function' ? (snap.site() || {}) : {};
  const policy = { ...DEFAULT_POLICY, ...rawPolicy };
  const tz = rawPolicy.tz || site.tz || DEFAULT_TZ;
  const clockTrusted = state.clockTrusted !== false;
  const manual = mode !== 'scan';
  const warnings = [];
  let side = input.side || null;
  let cardholder = null;
  let credentialHash = null;
  let passCandidates = [];

  const out = (decision, reason, extra = {}) => ({
    decision,
    reason,
    cardholderId: cardholder ? cardholder.id : null,
    matched: extra.matched || null,
    actions: extra.actions || [],
    stateEffects: extra.stateEffects || {},
    message: reasonMessage(reason),
    warnings,
    side,
    credentialHash,
    ...(extra.code ? { code: extra.code } : {}),
    ...(extra.forcible ? { forcible: true } : {}),
    ...(extra.forced ? { forced: true } : {}),
    ...(extra.passId ? { passId: extra.passId } : {}),
    ...(extra.detail ? { detail: extra.detail } : {})
  });
  const doorStateOf = (id) => ((state.doorStates || {})[id] || {}).state || null;
  const deny = (reason, extra) => {
    const authorized = Boolean(extra && extra.matched);
    if (!authorized && LEAF_OPEN_STATES.has(doorStateOf(doorId)) && !warnings.includes('intento_con_puerta_abierta')) {
      warnings.push('intento_con_puerta_abierta');
    }
    return out('deny', reason, extra);
  };

  // ── 1. Credencial ──
  if (!manual) {
    const type = credential && credential.type;
    if (!CREDENTIAL_TYPES.includes(type)) return deny('credencial_desconocida');
    // Clave HMAC del sitio: explícita o la del snapshot (chunk 'secrets'); sin clave = sha256.
    const credentialKey = input.credentialKey
      ?? (typeof snap.credentialKey === 'function' ? snap.credentialKey() : null);
    credentialHash = hashCredential(type, credential.value, credentialKey);
    if (!credentialHash) return deny('credencial_desconocida');
    if (snap.isRevoked(`cred:${type}:${credentialHash}`)) return deny('credencial_revocada');

    const found = normalizeFound(snap.findCredential(type, credentialHash));
    if (found && found.status === 'duplicate') return deny('dni_duplicado');
    let passFound = null;
    if (type === 'dni' || type === 'qr') {
      // Pases de visita: por id (= contenido del QR) o por DNI normalizado.
      // Con clave del sitio los pases traen dniHash (no el DNI en claro).
      const p = snap.pass(normalizeCredentialValue(type, credential.value))
        || (credentialKey && type === 'dni' ? snap.pass(credentialHash) : null);
      if (p) {
        passFound = p;
        const closed = CLOSED_PASS.has(p.status) || snap.isRevoked(`pass:${p.id}`) || snap.isRevoked(String(p.id));
        if (!closed) passCandidates = [p];
      }
    }
    if (!found && !passFound) return deny('credencial_desconocida');
    if (!found && !passCandidates.length) return deny('credencial_revocada');

    if (found) {
      const active = !found.status || found.status === 'active';
      if (!active && !passCandidates.length) return deny('credencial_revocada');
      if (active) {
        const cred = found;
        if (outsideValidity(cred, at)) return deny('fuera_de_vigencia');
        // ── 2. Persona ──
        const ch = snap.cardholder(cred.cardholderId);
        if (!ch) return deny('no_encontrado');
        cardholder = ch;
        if (ch.status !== 'active' || snap.isRevoked(`ch:${ch.id}`)) return deny('persona_inactiva');
        if (outsideValidity(ch, at)) return deny('fuera_de_vigencia');
      }
    }
  }

  // ── 3. Puerta ──
  const door = snap.door(doorId);
  if (!door) return deny('puerta_desconocida');
  if (door.enabled === false) return deny('puerta_deshabilitada');
  if (door.lockdown === true) return deny('puerta_bloqueada');
  if (readerId) {
    const reader = (door.readers || []).find((r) => r.id === readerId);
    if (!reader) return deny('lado_no_habilitado');
    if (side && side !== reader.side) return deny('lado_no_habilitado');
    side = reader.side;
  }
  side = side || 'in';
  const sideDef = Array.isArray(door.sides)
    ? (door.sides.includes(side) ? {} : null) // forma corta ['in','out']: sin áreas
    : (door.sides && door.sides[side]);
  if (!sideDef || sideDef.enabled === false) return deny('lado_no_habilitado');

  // ── 4. Derechos ──
  let matched = null;
  let grantReason = null;
  let passEffect = null;
  let passId = null;
  if (manual) {
    matched = { source: mode, id: actor && actor.id ? actor.id : null, scheduleId: null };
    grantReason = mode === 'remote' ? 'apertura_remota' : 'apertura_manual';
  } else {
    const ctx = { snap, at, tz, policy, clockTrusted, doorId: door.id };
    let failure = null;
    if (cardholder) {
      const requireRights = sideDef.requireRights != null ? sideDef.requireRights === true : side === 'in';
      if (!requireRights) {
        matched = { source: 'egress', id: null, scheduleId: null };
        grantReason = 'egreso_libre';
      } else {
        const r = evaluateCardholderRights({ ...ctx, cardholder });
        if (r.ok) {
          matched = r.matched;
          grantReason = r.reason;
          warnings.push(...r.warnings);
        } else {
          failure = r.reason;
        }
      }
    }
    if (!matched && passCandidates.length) {
      const p = evaluatePasses(passCandidates, {
        snap, door, side, sideDef, at, tz, clockTrusted, presence: state.presence
      });
      if (p.ok) {
        matched = { source: 'pass', id: p.pass.id, scheduleId: null };
        grantReason = p.reason;
        passEffect = p.effect;
        passId = p.pass.id;
      } else {
        failure = failure ? pickFailure([failure, p.reason]) : p.reason;
      }
    }
    if (!matched) return deny(failure || 'puerta_no_autorizada');
  }

  // ── 5. Política ──
  if (!manual && door.requireGuardApproval === true) {
    return out('needs_approval', 'requiere_aprobacion_guardia', { matched, passId });
  }

  // ── 6. Interlock ──
  // Esta puerta ya está destrabada o abierta: el paso se registra igual (anti-colado).
  // No se vuelve a evaluar el estanco: la otra hoja, si está abierta, no invalida el registro.
  const passageState = !manual && PASSAGE_STATES.has(doorStateOf(door.id));
  const stateEffects = {};
  let groups = [];
  if (typeof snap.interlockGroups === 'function') groups = snap.interlockGroups(door.id) || [];
  else if (typeof snap.interlockGroup === 'function') {
    const g = snap.interlockGroup(door.id);
    if (g) groups = [g];
  }
  let forced = false;
  const interlockEffects = [];
  if (!passageState) for (const group of groups) {
    const il = evaluateInterlock({
      group,
      doorId: door.id,
      side,
      doorStates: state.doorStates || {},
      interlockState: (state.interlock && state.interlock[group.id]) || null,
      at,
      mode,
      actor,
      doorLookup: (id) => snap.door(id)
    });
    if (!il.allowed) {
      return deny(il.reason, {
        matched,
        code: il.code,
        forcible: il.forcible,
        detail: il.message,
        passId
      });
    }
    if (il.forced && !forced) {
      forced = true;
      warnings.push('apertura_forzada_estanco');
    }
    if (il.effect) interlockEffects.push(il.effect);
  }
  if (interlockEffects.length) {
    stateEffects.interlock = interlockEffects[0];
    stateEffects.interlocks = interlockEffects;
  }

  // ── 7. Anti-passback ──
  const presenceKey = cardholder ? cardholder.id : (passId ? `pass:${passId}` : null);
  if (presenceKey) {
    const apb = evaluateApb({
      mode: manual ? 'off' : policy.apbMode,
      resetMin: policy.apbResetMin,
      presence: state.presence,
      presenceKey,
      door,
      side,
      at
    });
    if (apb.result === 'deny') return deny(apb.reason, { matched, passId });
    if (apb.result === 'warn') warnings.push(apb.reason);
    if (apb.effect) stateEffects.presence = apb.effect;
  }
  if (passEffect) stateEffects.pass = passEffect;

  const unlockSec = Number(door.unlockSec) > 0 ? Number(door.unlockSec) : DEFAULT_UNLOCK_SEC;
  if (passageState) {
    // DESBLOQUEADA: el controlador extiende la ventana (la acción unlock no es un pulso nuevo
    // si el relé sigue abierto). ABIERTA_AUT / RETENIDA: no hace falta accionar el relé.
    const actions = doorStateOf(door.id) === 'DESBLOQUEADA'
      ? [{ type: 'unlock', doorId: door.id, ms: Math.round(unlockSec * 1000) }]
      : [];
    return out('grant', 'paso_registrado_puerta_abierta', {
      matched, actions, stateEffects, passId
    });
  }
  return out('grant', forced ? 'apertura_forzada_estanco' : grantReason, {
    matched,
    actions: [{ type: 'unlock', doorId: door.id, ms: Math.round(unlockSec * 1000) }],
    stateEffects,
    forced,
    passId
  });
};

module.exports = { decide, FAILURE_RANK, SOURCE_ORDER, DEFAULT_UNLOCK_SEC };
