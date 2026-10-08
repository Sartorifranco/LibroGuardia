'use strict';

/**
 * InputDriver {start(onChange), stop(), health(), values()} (docs/ETAPA2-DISENO.md §1).
 *
 * Entradas lógicas por puerta y su valor normalizado:
 *   dps        'open' | 'closed'        (sensor de puerta)
 *   bond       'engaged' | 'released'   (sensor de traba / bond del maglock)
 *   rex        true | false             (pulsador de salida)
 *   emergency  true | false             (pulsador / señal de emergencia)
 * onChange(name, value) se llama solo cuando cambia. El debounce (50 ms) lo hace el controlador.
 *
 *  - 'gpio'       libgpiod (`gpiomon` + `gpioget`). Línea activa = dps abierta, bond trabado,
 *                 rex/emergencia presionados; `activeLow` invierte. Sin Linux → no hace nada.
 *  - 'simulated'  valores en memoria, se mueven con set() (API LAN `POST /edge/sim/input`).
 *  - 'none'       sin sensores.
 */

const { spawn, execFile } = require('child_process');
const { nullLogger } = require('./logger');

const INPUT_NAMES = ['dps', 'bond', 'rex', 'emergency'];
const DEFAULTS = { dps: 'closed', bond: 'engaged', rex: false, emergency: false };

const TRUE_RE = /^(1|true|on|yes|si|sí|open|abierta|abierto|engaged|trabado|trabada|pressed|active|activo|activa)$/i;
const FALSE_RE = /^(0|false|off|no|closed|cerrada|cerrado|released|liberado|liberada|destrabado|inactive|inactivo|inactiva)$/i;

/** Valor crudo (bool / número / texto) → valor lógico de la entrada, o undefined si no se entiende. */
function normalizeInputValue(name, v) {
  let active;
  if (typeof v === 'boolean') active = v;
  else if (typeof v === 'number') active = v !== 0;
  else if (typeof v === 'string' && TRUE_RE.test(v.trim())) active = true;
  else if (typeof v === 'string' && FALSE_RE.test(v.trim())) active = false;
  else return undefined;
  switch (name) {
    case 'dps': return active ? 'open' : 'closed';
    case 'bond': return active ? 'engaged' : 'released';
    case 'rex':
    case 'emergency': return active;
    default: return undefined;
  }
}

class BaseInput {
  constructor(cfg = {}, { logger = nullLogger } = {}) {
    this.cfg = cfg;
    this.logger = logger;
    this.onChange = null;
    this.state = {};
    this.stats = { changes: 0, lastChangeAt: null, error: null };
  }

  /** Entradas configuradas (las demás no existen en esta puerta). */
  enabled() {
    return INPUT_NAMES.filter((n) => this.cfg[n] !== undefined && this.cfg[n] !== false && this.cfg[n] !== null);
  }

  emit(name, value) {
    if (this.state[name] === value) return;
    this.state[name] = value;
    this.stats.changes += 1;
    this.stats.lastChangeAt = Date.now();
    if (this.onChange) this.onChange(name, value);
  }

  values() {
    return { ...this.state };
  }

  health() {
    return { driver: this.cfg.driver, inputs: this.enabled(), values: this.values(), ...this.stats };
  }

  async start(onChange) {
    this.onChange = onChange;
  }

  async stop() {}
}

class NoInput extends BaseInput {
  enabled() {
    return [];
  }
}

class SimulatedInput extends BaseInput {
  constructor(cfg, deps) {
    super(cfg, deps);
    for (const n of this.enabled()) {
      const init = typeof cfg[n] === 'object' && cfg[n] && 'initial' in cfg[n] ? normalizeInputValue(n, cfg[n].initial) : undefined;
      this.state[n] = init === undefined ? DEFAULTS[n] : init;
    }
  }

  async start(onChange) {
    this.onChange = onChange;
    // El estado inicial se informa para que el controlador arranque sabiendo dónde está.
    for (const n of this.enabled()) onChange(n, this.state[n]);
  }

  /** @returns {{ok:boolean, value?:any, error?:string}} */
  set(name, raw) {
    if (!INPUT_NAMES.includes(name)) return { ok: false, error: `Entrada desconocida "${name}"` };
    if (!this.enabled().includes(name)) return { ok: false, error: `La puerta no tiene la entrada "${name}" configurada` };
    const value = normalizeInputValue(name, raw);
    if (value === undefined) return { ok: false, error: `Valor inválido para ${name}` };
    this.emit(name, value);
    return { ok: true, value };
  }
}

const isLinux = () => process.platform === 'linux';

/** Parsea una línea de `gpiomon --format="%o %e"` (v1: e=1 sube / 0 baja; v2: 1 sube / 2 baja) o la salida clásica. */
function parseGpiomonLine(line, version = 1) {
  const s = String(line || '').trim();
  if (!s) return null;
  const fmt = s.match(/^(\d+)\s+(\d+)$/);
  if (fmt) {
    const offset = Number(fmt[1]);
    const e = Number(fmt[2]);
    return { offset, rising: version === 2 ? e === 1 : e === 1 };
  }
  const classic = s.match(/(RISING|FALLING)\s+EDGE.*?offset:\s*(\d+)/i) || s.match(/offset:\s*(\d+).*?(rising|falling)/i);
  if (!classic) return null;
  if (/^\d+$/.test(classic[1])) return { offset: Number(classic[1]), rising: /rising/i.test(classic[2]) };
  return { offset: Number(classic[2]), rising: /rising/i.test(classic[1]) };
}

/**
 * cfg: { driver:'gpio', chip:'gpiochip0', gpiodVersion:1|2, dps:{line:17, activeLow:false}, bond:{line:27}, rex:{line:22}, emergency:{line:23} }
 */
class GpioInput extends BaseInput {
  constructor(cfg, deps = {}) {
    super(cfg, deps);
    this.chip = cfg.chip || 'gpiochip0';
    this.version = Number(cfg.gpiodVersion) === 2 ? 2 : 1;
    this.spawnFn = deps.spawnFn || spawn;
    this.execFileFn = deps.execFileFn || execFile;
    this.mock = cfg.mock === true || !isLinux();
    this.proc = null;
    this.byLine = new Map();
    for (const n of this.enabled()) {
      const line = Number(cfg[n].line ?? cfg[n]);
      if (!Number.isInteger(line)) throw new Error(`Entrada gpio "${n}": falta line`);
      this.byLine.set(line, { name: n, activeLow: cfg[n].activeLow === true });
    }
  }

  valueFor(line, high) {
    const def = this.byLine.get(line);
    if (!def) return null;
    const active = def.activeLow ? !high : high;
    return { name: def.name, value: normalizeInputValue(def.name, active) };
  }

  async start(onChange) {
    this.onChange = onChange;
    if (this.mock) {
      this.stats.error = 'GPIO no disponible en esta plataforma (entradas sin leer)';
      this.logger.warn(this.stats.error);
      return;
    }
    const lines = [...this.byLine.keys()];
    if (!lines.length) return;
    await this.readInitial(lines).catch((err) => {
      this.stats.error = `gpioget: ${err.message}`;
      this.logger.error('No se pudo leer el estado inicial de las entradas', { error: err.message });
    });
    const args = this.version === 2
      ? ['-c', this.chip, '--format=%o %e', ...lines.map(String)]
      : ['--num-events=0', '--format=%o %e', this.chip, ...lines.map(String)];
    this.proc = this.spawnFn('gpiomon', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      for (const l of parts) this.handleLine(l);
    });
    this.proc.on('error', (err) => {
      this.stats.error = `gpiomon: ${err.message}`;
      this.logger.error('gpiomon falló', { error: err.message });
    });
    this.proc.on('exit', (code) => {
      if (!this.stopping) {
        this.stats.error = `gpiomon terminó (código ${code})`;
        this.logger.error(this.stats.error);
      }
    });
  }

  handleLine(line) {
    const ev = parseGpiomonLine(line, this.version);
    if (!ev) return;
    const v = this.valueFor(ev.offset, ev.rising);
    if (v) this.emit(v.name, v.value);
  }

  readInitial(lines) {
    const args = this.version === 2
      ? ['-c', this.chip, '--numeric', ...lines.map(String)]
      : [this.chip, ...lines.map(String)];
    return new Promise((resolve, reject) => {
      this.execFileFn('gpioget', args, (err, stdout) => {
        if (err) return reject(err);
        const vals = String(stdout).trim().split(/\s+/).map(Number);
        lines.forEach((line, i) => {
          const v = this.valueFor(line, vals[i] === 1);
          if (v) this.emit(v.name, v.value);
        });
        return resolve();
      });
    });
  }

  async stop() {
    this.stopping = true;
    if (this.proc) this.proc.kill('SIGTERM');
  }
}

const INPUTS = { gpio: GpioInput, simulated: SimulatedInput, none: NoInput };

function createInput(cfg = {}, deps = {}) {
  const Cls = INPUTS[cfg.driver || 'none'];
  if (!Cls) throw new Error(`Driver de entradas desconocido "${cfg.driver}" (gpio | simulated | none)`);
  return new Cls(cfg, deps);
}

module.exports = {
  createInput, normalizeInputValue, parseGpiomonLine, INPUT_NAMES, DEFAULTS, SimulatedInput, GpioInput, NoInput, BaseInput
};
