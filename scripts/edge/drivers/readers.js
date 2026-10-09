'use strict';

/**
 * ReaderDriver {start(onCredential), stop(), health()} (docs/ETAPA2-DISENO.md §1).
 *
 *  - 'serial'  lector serie/USB (DNI PDF417, QR, tarjeta en claro): una ráfaga = una lectura
 *              (silencio interFrameGapMs). Una ficha multilínea sale como qr + dniHint.
 *  - 'stdin'   mismas tramas desde un stream (process.stdin por defecto): banco y tests.
 *  - 'wiegand' fase 2 (GPIO): solo la interfaz; start() avisa que no está implementado.
 *
 * onCredential({ type:'dni'|'card'|'qr'|'biostar', value, readerId, side, vendor, format })
 * El valor viaja en claro solo dentro del proceso: el motor lo hashea y el journal guarda el hash.
 */

const { createSerialFramer, runSerialLoop } = require('./serialFramer');
const { nullLogger, maskDocumentDigits, maskIdNumber } = require('./logger');
const { parseReaderFrame, parseMultilineCredential } = require('../../lib/stationReaderPlugins');
const { parseScanData } = require('../../../functions/dniParser');

const QR_PREFIX = /^(?:QR|PASE|PASS)[#:=]\s*(.+)$/i;

const framerOptions = (cfg, logger) => ({
  idleMs: Number(cfg.idleMs) > 0 ? Number(cfg.idleMs) : 120,
  interFrameGapMs: Number(cfg.interFrameGapMs) > 0 ? Number(cfg.interFrameGapMs) : 60,
  splitOnNewline: cfg.splitOnNewline === true || cfg.splitOnNewline === 'true',
  logger
});

const normalizeScanText = (text) => String(text || '')
  .replace(/^\uFEFF/, '')
  .replace(/\0/g, '')
  .replace(/\r\n/g, '\n')
  .replace(/\r/g, '\n')
  .replace(/^\n+|\n+$/g, '')
  .trim();

/**
 * Trama cruda → credencial del motor (o null si no se reconoce).
 * Una sola línea sigue igual (PDF417 → dni, número suelto → dni, resto → qr).
 * Una ficha con saltos internos es qr; si trae un DNI, dniHint para que el controlador
 * resuelva a la persona como hoy resuelve la línea suelta.
 * @param {string} text
 * @param {{plugin?:string, credentialType?:'auto'|'dni'|'qr'|'card'}} [opts]
 */
function frameToCredential(text, { plugin = 'serial_dni', credentialType = 'auto' } = {}) {
  const raw = normalizeScanText(text);
  if (!raw) return null;
  const qr = raw.match(QR_PREFIX);
  if (qr && !raw.includes('\n')) return { type: 'qr', value: qr[1].trim(), vendor: 'qr', format: 'qr_prefix' };
  if (credentialType === 'card') return { type: 'card', value: raw, vendor: 'card', format: 'card' };

  if (raw.includes('\n')) {
    const multi = parseMultilineCredential(raw);
    if (!multi) return null;
    const parsed = parseReaderFrame(plugin, raw);
    const vendor = (parsed && parsed.vendor) || 'qr';
    if (credentialType === 'dni') {
      return multi.dniHint ? { type: 'dni', value: multi.dniHint, vendor, format: 'numeric' } : null;
    }
    return {
      type: 'qr',
      value: multi.value,
      ...(multi.dniHint ? { dniHint: multi.dniHint } : {}),
      vendor,
      format: 'qr'
    };
  }

  if (credentialType === 'qr') return { type: 'qr', value: raw, vendor: 'qr', format: 'qr' };

  const parsed = parseReaderFrame(plugin, raw);
  if (!parsed) return null;
  if (parsed.authMethod === 'credential' && parsed.credentialCode) {
    return { type: 'card', value: parsed.credentialCode, vendor: parsed.vendor, format: 'card' };
  }
  if (parsed.authMethod === 'biometric' && parsed.biometricExternalId) {
    return { type: 'biostar', value: parsed.biometricExternalId, vendor: parsed.vendor, format: 'biostar' };
  }
  // DNI: PDF417 argentino, MRZ, JSON o número de 7/8 dígitos en una sola línea.
  const scan = parseScanData(parsed.idNumber || parsed.rawData || raw);
  if (scan && scan.idNumber) return { type: 'dni', value: scan.idNumber, vendor: parsed.vendor, format: scan.format };
  if (credentialType === 'dni') return null;
  // Auto: lo que no es DNI se trata como QR (pase de visita = contenido del QR).
  return { type: 'qr', value: raw, vendor: parsed.vendor, format: 'qr' };
}

class BaseReader {
  constructor(cfg = {}, { logger = nullLogger } = {}) {
    this.cfg = cfg;
    this.id = cfg.id || 'lector';
    this.side = cfg.side || 'in';
    this.logger = logger;
    this.onCredential = null;
    this.stats = { frames: 0, credentials: 0, unrecognized: 0, lastFrameAt: null, connected: false, error: null };
  }

  handleFrame(frame) {
    this.stats.frames += 1;
    this.stats.lastFrameAt = Date.now();
    const cred = frameToCredential(frame.text, this.cfg);
    const dni = cred && (cred.dniHint || (cred.type === 'dni' ? cred.value : ''));
    this.logger.info('Lectura', {
      reader: this.id,
      bytes: frame.rawBuf ? frame.rawBuf.length : Buffer.byteLength(String(frame.text || '')),
      reason: frame.reason || null,
      type: cred ? cred.type : null,
      ...(dni ? { dni: maskIdNumber(dni) } : {})
    });
    this.logger.debug('Lectura detalle', { reader: this.id, text: maskDocumentDigits(frame.text) });
    if (!cred) {
      this.stats.unrecognized += 1;
      this.logger.warn('Trama no reconocida', { reader: this.id, text: maskDocumentDigits(frame.text) });
      return;
    }
    this.stats.credentials += 1;
    if (this.onCredential) this.onCredential({ ...cred, readerId: this.id, side: this.side, at: Date.now() });
  }

  health() {
    return { id: this.id, driver: this.cfg.driver, side: this.side, ...this.stats };
  }
}

class SerialReader extends BaseReader {
  constructor(cfg, deps = {}) {
    super(cfg, deps);
    this.SerialPort = deps.SerialPort || null;
    this.stopped = false;
    this.port = null;
  }

  async start(onCredential) {
    this.onCredential = onCredential;
    this.stopped = false;
    const cfg = {
      serialPort: this.cfg.port || this.cfg.serialPort,
      baudRate: Number(this.cfg.baudRate) || 9600,
      ...framerOptions(this.cfg, this.logger),
      reconnectMinMs: Number(this.cfg.reconnectMinMs) || 1000,
      reconnectMaxMs: Number(this.cfg.reconnectMaxMs) || 30000
    };
    if (!cfg.serialPort) throw new Error(`Lector ${this.id}: falta "port" (ej. COM3 o /dev/ttyUSB0)`);
    this.loop = runSerialLoop(cfg, (f) => this.handleFrame(f), () => this.stopped, {
      SerialPort: this.SerialPort,
      onPort: (p) => { this.port = p; },
      onConnected: () => { this.stats.connected = true; this.stats.error = null; },
      onDisconnected: () => { this.stats.connected = false; }
    }).catch((err) => {
      this.stats.error = err.message;
      this.logger.error('Loop serie terminó con error', { reader: this.id, error: err.message });
    });
  }

  async stop() {
    this.stopped = true;
    try {
      if (this.port && this.port.isOpen) this.port.close();
    } catch (_) { /* ignore */ }
  }
}

class StdinReader extends BaseReader {
  constructor(cfg, deps = {}) {
    super(cfg, deps);
    this.stream = deps.stream || process.stdin;
  }

  async start(onCredential) {
    this.onCredential = onCredential;
    this.framer = createSerialFramer(framerOptions(this.cfg, this.logger), (f) => this.handleFrame(f));
    this.onData = (chunk) => this.framer.push(chunk);
    this.stream.on('data', this.onData);
    if (typeof this.stream.resume === 'function') this.stream.resume();
    this.stats.connected = true;
    this.logger.info(`Lector ${this.id} en modo stdin: pegá DNI/QR + Enter`);
  }

  /** Para tests: inyecta una trama como si llegara del lector. */
  inject(text) {
    this.handleFrame({ text: String(text) });
  }

  async stop() {
    if (this.onData) this.stream.off('data', this.onData);
    if (this.framer) this.framer.destroy();
    if (this.stream === process.stdin && typeof this.stream.pause === 'function') this.stream.pause();
    this.stats.connected = false;
  }
}

/** Wiegand por GPIO: fase 2. Se deja la interfaz para que la config no cambie. */
class WiegandReader extends BaseReader {
  async start(onCredential) {
    this.onCredential = onCredential;
    this.stats.error = 'Wiegand por GPIO no implementado (fase 2)';
    this.logger.warn(`Lector ${this.id}: Wiegand por GPIO queda para la fase 2; el lector no lee.`);
  }

  /** Decodificación prevista: 26/34 bits → tipo 'card' con el número en decimal. */
  static decodeBits() {
    throw new Error('Wiegand: fase 2');
  }

  async stop() {}
}

const READERS = { serial: SerialReader, stdin: StdinReader, wiegand: WiegandReader };

function createReader(cfg = {}, deps = {}) {
  const Cls = READERS[cfg.driver || 'serial'];
  if (!Cls) throw new Error(`Driver de lector desconocido "${cfg.driver}" (serial | stdin | wiegand)`);
  return new Cls(cfg, deps);
}

module.exports = { createReader, frameToCredential, SerialReader, StdinReader, WiegandReader, BaseReader };
