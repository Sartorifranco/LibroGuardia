'use strict';

/**
 * Máquina de estados de puerta (docs/ETAPA2-DISENO.md §5).
 *
 *   SEGURA ──unlock──▶ DESBLOQUEADA ──DPS abre──▶ ABIERTA_AUT ──heldOpenSec──▶ RETENIDA (alarma held_open)
 *      │                    │ timer unlockSec sin abrir → SEGURA + evento door_not_opened (posible bloqueo físico)
 *      ├─DPS abre sin grant ni REX──▶ FORZADA (alarma door_forced)
 *      └─bond no traba en 2 s / sensores inconsistentes──▶ FALLA (alarma lock_fault)
 *   DPS cierra (ABIERTA_AUT / RETENIDA / FORZADA) → re-traba (mín. 1 s desde el unlock) → SEGURA.
 *   REX: enmascara el forzado durante rexMaskMs; si `rexUnlocks` (maglock) además pulsa la salida.
 *   Emergencia: desbloqueo mantenido (output hold) hasta que se libera.
 *
 * `reduceDoor(state, event, params)` es PURO: devuelve el estado nuevo y una lista de efectos
 * ({type:'output'|'alarm'|'event'|'timer'|'cancel'}). `DoorRunner` ejecuta timers, debounce
 * (50 ms) y efectos con un reloj inyectable.
 */

const STATES = Object.freeze({
  SEGURA: 'SEGURA',
  DESBLOQUEADA: 'DESBLOQUEADA',
  ABIERTA_AUT: 'ABIERTA_AUT',
  RETENIDA: 'RETENIDA',
  FORZADA: 'FORZADA',
  FALLA: 'FALLA'
});
const OPEN_STATES = new Set([STATES.ABIERTA_AUT, STATES.RETENIDA, STATES.FORZADA]);

const DEFAULTS = Object.freeze({
  unlockMs: 3000,
  heldOpenMs: 30000,
  relockMinMs: 1000,
  bondCheckMs: 2000,
  rexMaskMs: 10000,
  debounceMs: 50
});

/**
 * Parámetros de la puerta: snapshot de la nube (door) + config local (hardware).
 * @param {object} [door]   door del snapshot (unlockSec, heldOpenSec, rexUnlocks...)
 * @param {object} [local]  config local de la puerta ({inputs:{dps,bond,rex,...}, heldOpenSec, rexUnlocks...})
 */
function doorParams(door = {}, local = {}) {
  const inputs = local.inputs || {};
  const has = (n) => inputs[n] !== undefined && inputs[n] !== false && inputs[n] !== null && inputs.driver !== 'none';
  const num = (...vals) => vals.map(Number).find((v) => Number.isFinite(v) && v > 0);
  const unlockSec = num(door && door.unlockSec, local.unlockSec);
  const heldSec = num(door && door.heldOpenSec, local.heldOpenSec);
  return {
    unlockMs: unlockSec ? Math.round(unlockSec * 1000) : DEFAULTS.unlockMs,
    heldOpenMs: heldSec ? Math.round(heldSec * 1000) : DEFAULTS.heldOpenMs,
    relockMinMs: num(local.relockMinMs) ?? DEFAULTS.relockMinMs,
    bondCheckMs: num(local.bondCheckMs) ?? DEFAULTS.bondCheckMs,
    rexMaskMs: num(local.rexMaskMs) ?? (unlockSec ? Math.max(DEFAULTS.rexMaskMs, unlockSec * 1000) : DEFAULTS.rexMaskMs),
    debounceMs: Number.isFinite(Number(local.debounceMs)) ? Number(local.debounceMs) : DEFAULTS.debounceMs,
    hasDps: has('dps'),
    hasBond: has('bond'),
    hasRex: has('rex'),
    rexUnlocks: (local.rexUnlocks ?? (door && door.rexUnlocks)) === true
  };
}

function initialDoorState(doorId, at = 0) {
  return {
    doorId,
    state: STATES.SEGURA,
    since: at,
    dps: null,
    bond: null,
    rex: false,
    emergency: false,
    unlockedAt: null,
    unlockSource: null,
    pendingRelock: false,
    rexMaskUntil: 0,
    alarms: { door_forced: false, held_open: false, lock_fault: false, emergency: false }
  };
}

/**
 * @param {ReturnType<typeof initialDoorState>} prev
 * @param {{type:'unlock', at:number, ms?:number, source?:string}
 *        |{type:'input', at:number, name:'dps'|'bond'|'rex', value:any}
 *        |{type:'timer', at:number, name:'unlock'|'held'|'relock'|'bond_check'}
 *        |{type:'emergency', at:number, active:boolean}} ev
 * @param {ReturnType<typeof doorParams>} p
 * @returns {{state:object, effects:object[]}}
 */
function reduceDoor(prev, ev, p) {
  const s = { ...prev, alarms: { ...prev.alarms } };
  const fx = [];
  const at = ev.at;
  const go = (state) => {
    if (s.state !== state) {
      s.state = state;
      s.since = at;
    }
  };
  const alarm = (code, raised, detail) => {
    if (s.alarms[code] === raised) return;
    s.alarms[code] = raised;
    fx.push({ type: 'alarm', code, state: raised ? 'raised' : 'cleared', ...(detail ? { detail } : {}) });
  };
  const event = (code, detail) => fx.push({ type: 'event', code, ...(detail ? { detail } : {}) });
  const timer = (name, ms) => fx.push({ type: 'timer', name, ms: Math.max(0, ms) });
  const cancel = (name) => fx.push({ type: 'cancel', name });
  const output = (action, extra = {}) => fx.push({ type: 'output', action, ...extra });

  /** Quedó trabada: SEGURA y, si hay sensor de bond, verificar en bondCheckMs. */
  const secured = () => {
    s.pendingRelock = false;
    s.unlockedAt = null;
    s.unlockSource = null;
    go(s.bond === 'released' && p.hasBond && s.alarms.lock_fault ? STATES.FALLA : STATES.SEGURA);
    if (p.hasBond) timer('bond_check', p.bondCheckMs);
  };
  const unlock = (source, ms) => {
    s.unlockedAt = at;
    s.unlockSource = source;
    s.pendingRelock = false;
    cancel('relock');
    cancel('bond_check');
    if (OPEN_STATES.has(s.state)) return; // ya está abierta: se re-arma el re-trabado al cerrar
    go(STATES.DESBLOQUEADA);
    timer('unlock', ms || p.unlockMs);
  };
  /** Sensor inconsistente: el bond dice "trabado" con la puerta abierta (solo se evalúa al cambiar el bond). */
  const inconsistent = () => p.hasDps && p.hasBond && s.dps === 'open' && s.bond === 'engaged' && !s.emergency;

  switch (ev.type) {
    case 'unlock': {
      if (s.emergency) break;
      unlock(ev.source || 'grant', ev.ms);
      break;
    }

    case 'input': {
      const { name, value } = ev;
      const first = s[name] === null || s[name] === undefined;
      if (name === 'rex') {
        s.rex = Boolean(value);
        if (!s.rex) break;
        s.rexMaskUntil = at + p.rexMaskMs;
        event('rex');
        if (p.rexUnlocks && !s.emergency && (s.state === STATES.SEGURA || s.state === STATES.FALLA || s.state === STATES.DESBLOQUEADA)) {
          output('pulse', { ms: p.unlockMs, source: 'rex' });
          unlock('rex', p.unlockMs);
        }
        break;
      }
      if (name === 'dps') {
        s.dps = value;
        if (first || !p.hasDps) break;
        if (value === 'open') {
          if (s.emergency) {
            go(STATES.ABIERTA_AUT);
            break;
          }
          if (s.state === STATES.DESBLOQUEADA) {
            cancel('unlock');
            go(STATES.ABIERTA_AUT);
            timer('held', p.heldOpenMs);
            event('door_opened', { via: s.unlockSource || 'grant' });
          } else if (s.state === STATES.SEGURA || s.state === STATES.FALLA) {
            cancel('bond_check');
            if (at < s.rexMaskUntil) {
              s.unlockedAt = at;
              s.unlockSource = 'rex';
              go(STATES.ABIERTA_AUT);
              timer('held', p.heldOpenMs);
              event('door_opened', { via: 'rex' });
            } else {
              go(STATES.FORZADA);
              alarm('door_forced', true);
            }
          }
        } else if (value === 'closed') {
          if (!OPEN_STATES.has(s.state)) break;
          cancel('held');
          alarm('held_open', false);
          alarm('door_forced', false);
          event('door_closed');
          if (s.emergency) {
            go(STATES.DESBLOQUEADA);
            break;
          }
          const elapsed = s.unlockedAt === null ? Infinity : at - s.unlockedAt;
          if (elapsed < p.relockMinMs) {
            s.pendingRelock = true;
            go(STATES.DESBLOQUEADA);
            timer('relock', p.relockMinMs - elapsed);
          } else {
            output('lock');
            secured();
          }
        }
        break;
      }
      if (name === 'bond') {
        s.bond = value;
        if (first || !p.hasBond) break;
        if (value === 'engaged') {
          cancel('bond_check');
          if (inconsistent()) {
            go(STATES.FALLA);
            alarm('lock_fault', true, 'sensor_inconsistente');
          } else if (s.state === STATES.FALLA && s.dps !== 'open') {
            alarm('lock_fault', false);
            go(STATES.SEGURA);
          } else if (s.state === STATES.FALLA) {
            alarm('lock_fault', false);
          }
        } else if (value === 'released' && s.state === STATES.SEGURA && !s.emergency) {
          go(STATES.FALLA);
          alarm('lock_fault', true, 'traba_liberada_sin_orden');
        }
        break;
      }
      break;
    }

    case 'timer': {
      if (ev.name === 'unlock' && s.state === STATES.DESBLOQUEADA && !s.emergency && !s.pendingRelock) {
        if (p.hasDps && s.unlockSource !== 'rex') event('door_not_opened', { message: 'La puerta no abrió (posible bloqueo físico).' });
        secured();
      } else if (ev.name === 'held' && s.state === STATES.ABIERTA_AUT) {
        go(STATES.RETENIDA);
        alarm('held_open', true);
      } else if (ev.name === 'relock' && s.pendingRelock && !s.emergency) {
        output('lock');
        secured();
      } else if (ev.name === 'bond_check' && p.hasBond && !s.emergency
        && (s.state === STATES.SEGURA || s.state === STATES.FALLA) && s.bond !== 'engaged') {
        go(STATES.FALLA);
        alarm('lock_fault', true, 'traba_no_engancho');
      }
      break;
    }

    case 'emergency': {
      if (Boolean(ev.active) === s.emergency) break;
      s.emergency = Boolean(ev.active);
      for (const t of ['unlock', 'held', 'relock', 'bond_check']) cancel(t);
      if (s.emergency) {
        s.pendingRelock = false;
        output('hold', { on: true });
        alarm('emergency', true);
        alarm('door_forced', false);
        alarm('held_open', false);
        go(s.dps === 'open' ? STATES.ABIERTA_AUT : STATES.DESBLOQUEADA);
      } else {
        output('hold', { on: false });
        alarm('emergency', false);
        if (p.hasDps && s.dps === 'open') {
          s.unlockedAt = at;
          s.unlockSource = 'emergency';
          go(STATES.ABIERTA_AUT);
          timer('held', p.heldOpenMs);
        } else {
          secured();
        }
      }
      break;
    }

    default:
      break;
  }
  return { state: s, effects: fx };
}

/**
 * Ejecuta la máquina de una puerta: debounce de entradas, timers y efectos.
 * @param {{doorId:string, params:object, clock?:{now:()=>number, setTimeout:Function, clearTimeout:Function},
 *          onEffect:(effect:object, state:object)=>void, onState?:(state:object, prev:object)=>void}} opts
 */
class DoorRunner {
  constructor({ doorId, params, clock = null, onEffect = () => {}, onState = () => {}, onEmergencyInput = null }) {
    this.doorId = doorId;
    this.onEmergencyInput = onEmergencyInput;
    this.emergencyInput = false;
    this.params = params;
    this.clock = clock || { now: () => Date.now(), setTimeout, clearTimeout };
    this.onEffect = onEffect;
    this.onState = onState;
    this.state = initialDoorState(doorId, this.clock.now());
    this.timers = new Map();
    this.debounce = new Map();
    this.pendingValue = new Map();
  }

  setParams(params) {
    this.params = params;
  }

  dispatch(ev) {
    const prev = this.state;
    const { state, effects } = reduceDoor(prev, { at: this.clock.now(), ...ev }, this.params);
    this.state = state;
    for (const e of effects) {
      if (e.type === 'timer') this.startTimer(e.name, e.ms);
      else if (e.type === 'cancel') this.cancelTimer(e.name);
    }
    if (prev.state !== state.state) this.onState(state, prev);
    for (const e of effects) {
      if (e.type !== 'timer' && e.type !== 'cancel') this.onEffect(e, state);
    }
    return { state, effects };
  }

  startTimer(name, ms) {
    this.cancelTimer(name);
    const h = this.clock.setTimeout(() => {
      this.timers.delete(name);
      this.dispatch({ type: 'timer', name });
    }, ms);
    this.timers.set(name, h);
  }

  cancelTimer(name) {
    const h = this.timers.get(name);
    if (h) {
      this.clock.clearTimeout(h);
      this.timers.delete(name);
    }
  }

  /**
   * Entrada cruda con debounce: solo se aplica si se mantiene `debounceMs`.
   * 'emergency' no entra al reductor: se entrega a `onEmergencyInput` (el controlador la reparte al grupo).
   */
  input(name, value) {
    const ms = this.params.debounceMs;
    const pending = this.debounce.get(name);
    if (pending) this.clock.clearTimeout(pending);
    this.debounce.delete(name);
    const stable = name === 'emergency' ? this.emergencyInput : this.state[name];
    if (value === stable && name !== 'rex') return;
    const apply = (v) => {
      if (name === 'emergency') {
        this.emergencyInput = Boolean(v);
        if (this.onEmergencyInput) this.onEmergencyInput(this.emergencyInput);
        return;
      }
      this.dispatch({ type: 'input', name, value: v });
    };
    if (!ms) {
      apply(value);
      return;
    }
    this.pendingValue.set(name, value);
    this.debounce.set(name, this.clock.setTimeout(() => {
      this.debounce.delete(name);
      apply(this.pendingValue.get(name));
    }, ms));
  }

  /** Vista para el motor (doorStates del interlock) y /edge/status. */
  view() {
    const s = this.state;
    return {
      state: s.state, since: s.since, dps: s.dps, bond: s.bond, emergency: s.emergency,
      alarms: Object.keys(s.alarms).filter((k) => s.alarms[k])
    };
  }

  stop() {
    for (const h of this.timers.values()) this.clock.clearTimeout(h);
    for (const h of this.debounce.values()) this.clock.clearTimeout(h);
    this.timers.clear();
    this.debounce.clear();
  }
}

module.exports = { STATES, DEFAULTS, doorParams, initialDoorState, reduceDoor, DoorRunner };
