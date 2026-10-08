'use strict';

/**
 * Interlock (estanco) puro. Dos modos (D5):
 *  - 'sensor' (producción): una puerta solo se desbloquea si TODAS las demás del
 *    grupo están SEGURA, con DPS cerrado y bond trabado.
 *  - 'timed' (banco): port de deriveAirlockPhase / evaluateAirlockPhase /
 *    evaluateManualAirlockPhase de functions/doorController.js (copiado, sin importarlo).
 *
 * Apertura manual (D4): respeta el estanco → code 'AIRLOCK_OTHER_OPEN' con
 * forcible:true; forzar exige permiso 'puertas.estanco.forzar' y motivo ≥ 5 caracteres.
 */

const FORCE_PERMISSION = 'puertas.estanco.forzar';
const MIN_FORCE_REASON_LENGTH = 5;

/** Copia de doorController.js: tras abrir la interior, el estanco vuelve a idle a los 3 s. */
const INNER_OPEN_RESET_MS = 3000;
const AIRLOCK_DEFAULTS = Object.freeze({
  outerCloseDelayMs: 5000,
  interDoorDelayMs: 2000,
  transitTimeoutMs: 120000
});

/** Copia de airlockTimings (doorController.js). Acepta group.timings o los campos sueltos. */
const airlockTimings = (group = {}) => {
  const src = { ...(group || {}), ...((group && group.timings) || {}) };
  return {
    outerCloseDelayMs: Number(src.outerCloseDelayMs) > 0
      ? Number(src.outerCloseDelayMs) : AIRLOCK_DEFAULTS.outerCloseDelayMs,
    interDoorDelayMs: Number.isFinite(Number(src.interDoorDelayMs)) && Number(src.interDoorDelayMs) >= 0
      ? Number(src.interDoorDelayMs) : AIRLOCK_DEFAULTS.interDoorDelayMs,
    transitTimeoutMs: Number(src.transitTimeoutMs) > 0
      ? Number(src.transitTimeoutMs) : AIRLOCK_DEFAULTS.transitTimeoutMs
  };
};

/**
 * Fase efectiva derivada del tiempo (copia de doorController.deriveAirlockPhase).
 * Diferencia: solo acepta instantes numéricos (outerOpenedAtMs / innerOpenedAtMs);
 * no hay Timestamps de Firestore en el motor. `nowMs` es obligatorio.
 */
const deriveAirlockPhase = (data = {}, group = {}, nowMs) => {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError('deriveAirlockPhase: nowMs es obligatorio');
  }
  const stored = (data && data.phase) || 'idle';
  if (stored === 'idle') return 'idle';
  const t = airlockTimings(group);

  if (stored === 'inner_open') {
    const t1 = Number.isFinite(data.innerOpenedAtMs) ? data.innerOpenedAtMs : null;
    if (t1 == null) return 'idle';
    return nowMs - t1 < INNER_OPEN_RESET_MS ? 'inner_open' : 'idle';
  }

  const t0 = Number.isFinite(data.outerOpenedAtMs) ? data.outerOpenedAtMs : null;
  if (t0 == null) return 'idle';
  const elapsed = nowMs - t0;
  if (elapsed < t.outerCloseDelayMs) return 'outer_open';
  if (elapsed < t.outerCloseDelayMs + t.interDoorDelayMs) return 'outer_closed_pending';
  if (elapsed < t.outerCloseDelayMs + t.interDoorDelayMs + t.transitTimeoutMs) return 'inner_allowed';
  return 'idle';
};

/** Copia literal de doorController.evaluateAirlockPhase. */
const evaluateAirlockPhase = (role, phase) => {
  if (role === 'outer') {
    if (phase === 'idle') return { allowed: true, phase: 'idle', nextPhase: 'outer_open' };
    return { allowed: false, phase, message: 'Estanco en uso. Espere a que se complete el tránsito.' };
  }
  if (role === 'inner') {
    if (phase === 'inner_allowed') return { allowed: true, phase, nextPhase: 'inner_open' };
    if (phase === 'outer_open') {
      return { allowed: false, phase, message: 'Espere a que la puerta exterior cierre por completo.' };
    }
    if (phase === 'outer_closed_pending') {
      return { allowed: false, phase, message: 'Puerta exterior cerrando. Aguarde el retardo configurado.' };
    }
    return { allowed: false, phase, message: 'Debe autorizarse primero en la puerta exterior del estanco.' };
  }
  return { allowed: true, phase };
};

/** Copia literal de doorController.evaluateManualAirlockPhase. */
const evaluateManualAirlockPhase = (role, phase, otherDoorName = '') => {
  const otherOpen = (role === 'outer' && phase === 'inner_open')
    || (role === 'inner' && (phase === 'outer_open' || phase === 'outer_closed_pending'));
  if (otherOpen) {
    const label = String(otherDoorName || '').trim() || (role === 'outer' ? 'interior' : 'exterior');
    return {
      allowed: false,
      phase,
      code: 'AIRLOCK_OTHER_OPEN',
      otherDoorName: label,
      message: `No se puede abrir: la otra puerta del estanco (${label}) está abierta. Esperá a que se cierre.`
    };
  }
  return { allowed: true, phase, nextPhase: role === 'outer' ? 'outer_open' : 'inner_open' };
};

/** ¿Puede el actor forzar? → {ok, reason} */
const canForce = (actor) => {
  const perms = Array.isArray(actor?.permissions) ? actor.permissions : [];
  if (!perms.includes(FORCE_PERMISSION)) return { ok: false, reason: 'sin_permiso_forzar' };
  if (String(actor?.forceReason || '').trim().length < MIN_FORCE_REASON_LENGTH) {
    return { ok: false, reason: 'motivo_forzado_requerido' };
  }
  return { ok: true, reason: null };
};

/** Una puerta vecina está segura (modo sensor). Sin estado conocido = no segura (falla cerrada). */
const isDoorSecure = (st, sensorsRequired = true) => {
  if (!st || st.state !== 'SEGURA') return false;
  if (sensorsRequired === false) return st.dps !== 'open';
  return st.dps === 'closed' && st.bond === 'engaged';
};

/**
 * Rol de la puerta en el tránsito 'timed'. En el código actual el rol es fijo
 * (outer = exterior). Diferencia intencional: para salir (side 'out') la
 * secuencia se invierte — la primera puerta que se cruza actúa como "outer".
 * Mientras hay un tránsito en curso, el rol sale de `entryDoorId` guardado.
 */
const timedRole = (group, doorId, side, data, phase) => {
  if (phase !== 'idle' && data && data.entryDoorId) {
    return doorId === data.entryDoorId ? 'outer' : 'inner';
  }
  const outerIsEntry = side !== 'out';
  const isOuter = doorId === group.outerDoorId;
  return (isOuter === outerIsEntry) ? 'outer' : 'inner';
};

/**
 * Decide si `doorId` puede desbloquearse ahora.
 *
 * @param {Object} p
 * @param {import('./snapshotSchema').InterlockGroup|null} p.group
 * @param {string} p.doorId
 * @param {'in'|'out'} [p.side='in']
 * @param {Object<string,{state:string,dps?:string,bond?:string,since?:number}>} [p.doorStates]
 * @param {Object} [p.interlockState]   estado 'timed' del grupo {phase, outerOpenedAtMs, innerOpenedAtMs, entryDoorId}
 * @param {number} p.at
 * @param {'scan'|'manual'|'remote'} [p.mode='scan']
 * @param {{permissions?:string[], force?:boolean, forceReason?:string}} [p.actor]
 * @param {(doorId:string)=>object|null} [p.doorLookup]   para sensorsRequired y nombres
 * @returns {{allowed:boolean, reason:string|null, code?:string, forcible?:boolean, forced?:boolean,
 *            phase?:string, message?:string, effect?:object|null}}
 */
const evaluateInterlock = ({
  group,
  doorId,
  side = 'in',
  doorStates = {},
  interlockState = null,
  at,
  mode = 'scan',
  actor = null,
  doorLookup = () => null
}) => {
  if (!group || !Array.isArray(group.doorIds) || !group.doorIds.includes(doorId)) {
    return { allowed: true, reason: null, phase: 'bypass', effect: null };
  }
  const manual = mode === 'manual' || mode === 'remote';
  const others = group.doorIds.filter((d) => d !== doorId);
  let blocked = null;

  if (group.mode === 'timed') {
    const data = interlockState || {};
    const phase = deriveAirlockPhase(data, group, at);
    const role = timedRole(group, doorId, side, data, phase);
    const otherName = others.map((d) => doorLookup(d)?.name || '').filter(Boolean).join(', ');
    const check = manual
      ? evaluateManualAirlockPhase(role, phase, otherName)
      : evaluateAirlockPhase(role, phase);
    const effect = role === 'outer'
      ? { groupId: group.id, phase: 'outer_open', outerOpenedAtMs: at, innerOpenedAtMs: null, entryDoorId: doorId }
      : { groupId: group.id, phase: 'inner_open', innerOpenedAtMs: at,
        outerOpenedAtMs: data.outerOpenedAtMs ?? null, entryDoorId: data.entryDoorId ?? null };
    if (check.allowed) return { allowed: true, reason: null, phase, effect };
    blocked = {
      phase,
      message: check.message,
      reason: (!manual && role === 'inner' && (phase === 'idle' || phase === 'inner_open'))
        ? 'debe_ingresar_por_exterior'
        : 'estanco_ocupado',
      effect
    };
  } else {
    // 'sensor' (default ante modo desconocido: el más estricto)
    const notSecure = others.filter((d) => !isDoorSecure(doorStates[d], doorLookup(d)?.sensorsRequired));
    if (!notSecure.length) return { allowed: true, reason: null, phase: 'sensor', effect: null };
    const names = notSecure.map((d) => doorLookup(d)?.name || d).join(', ');
    blocked = {
      phase: 'sensor',
      message: `No se puede abrir: la otra puerta del estanco (${names}) no está cerrada y trabada.`,
      reason: 'estanco_ocupado',
      effect: null
    };
  }

  if (!manual) {
    return { allowed: false, reason: blocked.reason, phase: blocked.phase, message: blocked.message, effect: null };
  }
  // Manual / remota: forzable con permiso + motivo.
  if (actor && actor.force === true) {
    const f = canForce(actor);
    if (!f.ok) {
      return {
        allowed: false, reason: f.reason, code: 'AIRLOCK_OTHER_OPEN', forcible: true,
        phase: blocked.phase, message: blocked.message, effect: null
      };
    }
    return { allowed: true, reason: null, forced: true, phase: blocked.phase, effect: blocked.effect };
  }
  return {
    allowed: false,
    reason: 'estanco_ocupado',
    code: 'AIRLOCK_OTHER_OPEN',
    forcible: true,
    phase: blocked.phase,
    message: blocked.message,
    effect: null
  };
};

module.exports = {
  FORCE_PERMISSION,
  MIN_FORCE_REASON_LENGTH,
  INNER_OPEN_RESET_MS,
  AIRLOCK_DEFAULTS,
  airlockTimings,
  deriveAirlockPhase,
  evaluateAirlockPhase,
  evaluateManualAirlockPhase,
  canForce,
  isDoorSecure,
  evaluateInterlock
};
