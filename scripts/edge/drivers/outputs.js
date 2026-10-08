'use strict';

/**
 * OutputDriver {pulse(ms), set(on), health()} (docs/ETAPA2-DISENO.md §1).
 *
 *  - 'sr201'        placa SR-201 por TCP (functions/lib/doorDrivers/sr201.js tal cual):
 *                   ON → espera ms → OFF con reintentos (sendOffWithRetry). `pulse` resuelve apenas
 *                   la placa contesta el ON (relayConfirmed); el OFF sigue en segundo plano.
 *  - 'generic_http' webhook {action:'pulse'|'on'|'off', seconds} (mismo payload que genericHttp/fireLocalRelay).
 *  - 'gpio'         relé por GPIO (sysfs o `gpioset` de libgpiod). En Windows / sin GPIO → mock que solo loguea.
 *  - 'mock'         memoria (tests y banco sin relé).
 *
 * Resultado de pulse/set: { ok, relayConfirmed, detail?, error? }.
 *  ok=false → el comando NO salió (no aplicar efectos de estanco). ok=true y relayConfirmed=false →
 *  se envió pero la placa no confirmó.
 * `set(true)` mantiene destrabado (emergencia) hasta `set(false)`; mientras tanto los pulsos no apagan.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const sr201 = require('../../../functions/lib/doorDrivers/sr201');
const { nullLogger } = require('./logger');

class BaseOutput {
  constructor(cfg = {}, { logger = nullLogger, timers = null } = {}) {
    this.cfg = cfg;
    this.logger = logger;
    this.timers = timers || { setTimeout, clearTimeout };
    this.held = false;
    this.offTimer = null;
    this.stats = { pulses: 0, lastPulseAt: null, lastResult: null, lastError: null, offFailures: 0, active: false };
  }

  health() {
    return { driver: this.cfg.driver, held: this.held, ...this.stats };
  }

  cancelOff() {
    if (this.offTimer) {
      this.timers.clearTimeout(this.offTimer);
      this.offTimer = null;
    }
  }

  /** Programa el apagado (cancela uno anterior: un pulso nuevo extiende el tiempo). */
  scheduleOff(ms, offFn) {
    this.cancelOff();
    this.offTimer = this.timers.setTimeout(async () => {
      this.offTimer = null;
      if (this.held) return;
      try {
        const r = await offFn();
        this.stats.active = false;
        if (r && r.confirmed === false) this.stats.offFailures += 1;
      } catch (err) {
        this.stats.offFailures += 1;
        this.stats.lastError = err.message;
        this.logger.error('OFF del relé falló: la puerta PUEDE HABER QUEDADO DESTRABADA', { error: err.message });
      }
    }, Math.max(0, ms));
  }

  /**
   * Re-traba ya (DPS cerró antes de terminar el pulso). No hace nada si está retenido (emergencia)
   * o si no hay un pulso activo.
   */
  async lock() {
    if (this.held || !this.stats.active) return { ok: true, relayConfirmed: true, skipped: true };
    this.cancelOff();
    const r = await this.lockNow();
    if (r.ok) this.stats.active = false;
    return this.record(r);
  }

  async lockNow() {
    return { ok: true, relayConfirmed: false };
  }

  record(result) {
    this.stats.lastResult = result;
    if (result && result.error) this.stats.lastError = result.error;
    return result;
  }

  async stop() {
    this.cancelOff();
  }
}

class Sr201Output extends BaseOutput {
  constructor(cfg, deps = {}) {
    super(cfg, deps);
    this.host = String(cfg.host || '').trim();
    this.port = Number(cfg.port) || 6722;
    this.channel = sr201.clampChannel(cfg.channel ?? cfg.relayChannel ?? 1);
    this.timeoutMs = Number(cfg.timeoutMs) || 4000;
    this.sendFn = deps.sendFn || sr201.sendTcpCommand;
    this.sleepFn = deps.sleepFn;
    if (!this.host) throw new Error('Salida sr201: falta host (IP de la placa)');
  }

  async send(cmd) {
    return this.sendFn(this.host, this.port, cmd, this.timeoutMs);
  }

  sendOff() {
    return sr201.sendOffWithRetry(this.host, this.port, this.channel, {
      timeoutMs: this.timeoutMs,
      retryDelaysMs: this.cfg.offRetryDelaysMs,
      sendFn: this.sendFn,
      ...(this.sleepFn ? { sleepFn: this.sleepFn } : {}),
      logger: { warn: (m) => this.logger.warn(m), error: (m) => this.logger.error(m) }
    });
  }

  async pulse(ms) {
    const dur = Math.max(Number(this.cfg.minPulseMs ?? 200), Number(ms) || 3000);
    this.stats.pulses += 1;
    this.stats.lastPulseAt = Date.now();
    let on;
    try {
      on = await this.send(sr201.buildOnCommand(this.channel));
    } catch (err) {
      this.logger.error('SR201: no se pudo enviar ON', { host: this.host, channel: this.channel, error: err.message });
      return this.record({ ok: false, relayConfirmed: false, error: err.message });
    }
    this.stats.active = true;
    if (!this.held) this.scheduleOff(dur, () => this.sendOff());
    return this.record({
      ok: true,
      relayConfirmed: on?.confirmed !== false,
      detail: { command: `${sr201.buildOnCommand(this.channel)} / ${dur}ms / ${sr201.buildOffCommand(this.channel)}`, response: on?.response ?? null }
    });
  }

  async set(on) {
    if (on) {
      this.held = true;
      this.cancelOff();
      try {
        const r = await this.send(sr201.buildOnCommand(this.channel));
        this.stats.active = true;
        return this.record({ ok: true, relayConfirmed: r?.confirmed !== false });
      } catch (err) {
        return this.record({ ok: false, relayConfirmed: false, error: err.message });
      }
    }
    this.held = false;
    this.cancelOff();
    const r = await this.sendOff();
    this.stats.active = !r.confirmed && !r.ok;
    return this.record({ ok: r.ok, relayConfirmed: r.confirmed, error: r.error || undefined });
  }

  async lockNow() {
    const r = await this.sendOff();
    return { ok: r.ok, relayConfirmed: r.confirmed, error: r.error || undefined };
  }

  /** Sondeo sin disparar (comando de estado "01"). */
  async probe() {
    try {
      const r = await this.send('01');
      return { reachable: true, status: sr201.parseRelayStatusBits(r?.response) };
    } catch (err) {
      return { reachable: false, error: err.message };
    }
  }

  async stop() {
    this.cancelOff();
  }
}

class GenericHttpOutput extends BaseOutput {
  constructor(cfg, deps = {}) {
    super(cfg, deps);
    this.url = String(cfg.httpUrl || cfg.url || '').trim();
    if (!this.url) throw new Error('Salida generic_http: falta httpUrl');
    this.method = String(cfg.httpMethod || 'POST').toUpperCase();
    this.fetchFn = deps.fetchFn || globalThis.fetch;
    this.timeoutMs = Number(cfg.timeoutMs) || 8000;
  }

  async call(payload) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.url, {
        method: this.method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.cfg.httpAuthToken ? { Authorization: `Bearer ${String(this.cfg.httpAuthToken)}` } : {})
        },
        body: this.method === 'GET' ? undefined : JSON.stringify(payload),
        signal: ctrl.signal
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, relayConfirmed: false, error: data.message || `Relé HTTP respondió ${res.status}` };
      return { ok: true, relayConfirmed: true, detail: { httpStatus: res.status, ...data } };
    } catch (err) {
      return { ok: false, relayConfirmed: false, error: err.name === 'AbortError' ? `Timeout relé HTTP (${this.url})` : err.message };
    } finally {
      clearTimeout(t);
    }
  }

  async pulse(ms) {
    const seconds = Math.max(1, Math.round((Number(ms) || 3000) / 1000));
    this.stats.pulses += 1;
    this.stats.lastPulseAt = Date.now();
    return this.record(await this.call({ action: 'pulse', seconds, ms: Number(ms) || seconds * 1000 }));
  }

  async set(on) {
    this.held = Boolean(on);
    return this.record(await this.call({ action: on ? 'on' : 'off' }));
  }

  async lockNow() {
    return this.call({ action: 'off' });
  }
}

const isLinux = () => process.platform === 'linux';

/**
 * Relé por GPIO.
 *  cfg: { line:17, chip:'gpiochip0', activeLow:false, method:'sysfs'|'gpioset', gpiodVersion:1|2 }
 *  - sysfs: /sys/class/gpio/gpioN/value (exporta si hace falta).
 *  - gpioset: mantiene un proceso `gpioset` vivo mientras el relé está activo y lo mata al soltar.
 *  En Windows / macOS (o `mock:true`) no toca hardware: loguea y responde ok (relayConfirmed=false).
 */
class GpioOutput extends BaseOutput {
  constructor(cfg, deps = {}) {
    super(cfg, deps);
    this.line = Number(cfg.line);
    this.chip = cfg.chip || 'gpiochip0';
    this.method = cfg.method || 'sysfs';
    this.version = Number(cfg.gpiodVersion) === 2 ? 2 : 1;
    this.mock = cfg.mock === true || !isLinux();
    this.spawnFn = deps.spawnFn || spawn;
    this.execFileFn = deps.execFileFn || execFile;
    this.sysfsRoot = deps.sysfsRoot || '/sys/class/gpio';
    this.proc = null;
    if (!Number.isInteger(this.line) || this.line < 0) throw new Error('Salida gpio: falta "line" (número de línea)');
    if (this.mock) this.logger.warn(`GPIO ${this.line}: sin GPIO en esta plataforma, salida simulada (no mueve ningún relé)`);
  }

  level(on) {
    return (on ? 1 : 0) ^ (this.cfg.activeLow ? 1 : 0);
  }

  gpiosetArgs(value) {
    return this.version === 2
      ? ['-c', this.chip, `${this.line}=${value}`]
      : ['--mode=signal', this.chip, `${this.line}=${value}`];
  }

  async write(on) {
    const value = this.level(on);
    if (this.mock) {
      this.logger.info(`[gpio-mock] línea ${this.line} ← ${value}`);
      return { ok: true, relayConfirmed: false, detail: { mock: true, value } };
    }
    try {
      if (this.method === 'gpioset') {
        if (this.proc) {
          this.proc.kill('SIGTERM');
          this.proc = null;
        }
        if (on) {
          this.proc = this.spawnFn('gpioset', this.gpiosetArgs(value), { stdio: 'ignore' });
          this.proc.on('error', (err) => this.logger.error('gpioset falló', { error: err.message }));
        } else if (this.version === 1) {
          await new Promise((resolve, reject) => {
            this.execFileFn('gpioset', ['--mode=exit', this.chip, `${this.line}=${value}`], (err) => (err ? reject(err) : resolve()));
          });
        }
        return { ok: true, relayConfirmed: true, detail: { value } };
      }
      const dir = path.join(this.sysfsRoot, `gpio${this.line}`);
      if (!fs.existsSync(dir)) {
        fs.writeFileSync(path.join(this.sysfsRoot, 'export'), String(this.line));
        fs.writeFileSync(path.join(dir, 'direction'), 'out');
      }
      fs.writeFileSync(path.join(dir, 'value'), String(value));
      return { ok: true, relayConfirmed: true, detail: { value } };
    } catch (err) {
      return { ok: false, relayConfirmed: false, error: err.message };
    }
  }

  async pulse(ms) {
    this.stats.pulses += 1;
    this.stats.lastPulseAt = Date.now();
    const r = await this.write(true);
    if (r.ok) {
      this.stats.active = true;
      if (!this.held) this.scheduleOff(Math.max(100, Number(ms) || 3000), () => this.write(false).then((x) => ({ confirmed: x.ok })));
    }
    return this.record(r);
  }

  async set(on) {
    this.held = Boolean(on);
    this.cancelOff();
    const r = await this.write(Boolean(on));
    this.stats.active = Boolean(on) && r.ok;
    return this.record(r);
  }

  async lockNow() {
    return this.write(false);
  }

  async stop() {
    this.cancelOff();
    if (this.proc) this.proc.kill('SIGTERM');
  }
}

/** Salida en memoria: registra las llamadas. `failNext` / `unconfirmed` para simular fallas. */
class MockOutput extends BaseOutput {
  constructor(cfg = {}, deps = {}) {
    super({ driver: 'mock', ...cfg }, deps);
    this.calls = [];
    this.failNext = 0;
    this.unconfirmed = cfg.unconfirmed === true;
  }

  async pulse(ms) {
    this.stats.pulses += 1;
    this.stats.lastPulseAt = Date.now();
    if (this.failNext > 0) {
      this.failNext -= 1;
      this.calls.push({ op: 'pulse', ms, failed: true });
      return this.record({ ok: false, relayConfirmed: false, error: 'falla simulada' });
    }
    this.calls.push({ op: 'pulse', ms });
    this.stats.active = true;
    if (!this.held) {
      this.scheduleOff(Number(ms) || 0, async () => {
        this.calls.push({ op: 'off' });
        return { confirmed: true };
      });
    }
    return this.record({ ok: true, relayConfirmed: !this.unconfirmed });
  }

  async set(on) {
    this.held = Boolean(on);
    this.cancelOff();
    this.calls.push({ op: 'set', on: Boolean(on) });
    this.stats.active = Boolean(on);
    return this.record({ ok: true, relayConfirmed: !this.unconfirmed });
  }

  async lockNow() {
    this.calls.push({ op: 'lock' });
    return { ok: true, relayConfirmed: true };
  }
}

const OUTPUTS = { sr201: Sr201Output, generic_http: GenericHttpOutput, gpio: GpioOutput, mock: MockOutput, none: MockOutput };

function createOutput(cfg = {}, deps = {}) {
  const Cls = OUTPUTS[cfg.driver || 'sr201'];
  if (!Cls) throw new Error(`Driver de salida desconocido "${cfg.driver}" (sr201 | generic_http | gpio | mock)`);
  return new Cls(cfg, deps);
}

module.exports = { createOutput, Sr201Output, GenericHttpOutput, GpioOutput, MockOutput, BaseOutput, isLinux };
