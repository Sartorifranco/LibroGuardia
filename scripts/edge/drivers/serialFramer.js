'use strict';

/**
 * Framing serie validado en banco (copia de createSerialFramer / runSerialLoop de
 * scripts/programa-estacion.js; ese archivo no se toca porque lo usa la estación v1.7):
 * acumula hasta CR/LF/CRLF, o flush por silencio (idleMs) si el lector no manda terminador.
 */

const path = require('path');
const { nullLogger } = require('./logger');

const CONTROL_NAMES = {
  0: 'NUL', 7: 'BEL', 8: 'BS', 9: 'TAB', 10: 'LF', 11: 'VT', 12: 'FF', 13: 'CR', 27: 'ESC', 32: 'SPC'
};

const formatByte = (byte) => {
  const name = CONTROL_NAMES[byte];
  if (name) return `[${name}]`;
  if (byte >= 33 && byte <= 126) return String.fromCharCode(byte);
  return `[0x${byte.toString(16).padStart(2, '0')}]`;
};

const formatChunk = (buf) => {
  const bytes = [...buf];
  return {
    pretty: bytes.map(formatByte).join(''),
    hex: bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{idleMs?:number, logger?:object}} cfg
 * @param {(frame:{text:string, pretty:string, hex:string, reason:string, rawBuf:Buffer})=>void} onComplete
 */
const createSerialFramer = (cfg, onComplete) => {
  const idleMs = Number(cfg.idleMs) > 0 ? Number(cfg.idleMs) : 120;
  const logger = cfg.logger || nullLogger;
  let buffer = Buffer.alloc(0);
  let idleTimer = null;

  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const emitFrame = (rawBuf, reason) => {
    clearIdle();
    if (!rawBuf || rawBuf.length === 0) return;
    const text = rawBuf.toString('utf8').replace(/[\r\n\0]+/g, '').trim();
    const { pretty, hex } = formatChunk(rawBuf);
    onComplete({ text, pretty, hex, reason, rawBuf });
  };

  const scheduleIdleFlush = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      if (buffer.length === 0) return;
      const snapshot = buffer;
      buffer = Buffer.alloc(0);
      emitFrame(snapshot, `silencio ${idleMs}ms`);
    }, idleMs);
  };

  const push = (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    logger.debug(`RX chunk (${buf.length} B)`, formatChunk(buf));
    buffer = Buffer.concat([buffer, buf]);

    while (buffer.length > 0) {
      const cr = buffer.indexOf(0x0d);
      const lf = buffer.indexOf(0x0a);
      let cut = -1;
      if (cr >= 0 && lf >= 0) cut = Math.min(cr, lf);
      else if (cr >= 0) cut = cr;
      else if (lf >= 0) cut = lf;
      if (cut < 0) break;

      let end = cut + 1;
      if (buffer[cut] === 0x0d && buffer[end] === 0x0a) end += 1;
      const frame = Buffer.from(buffer.subarray(0, end));
      buffer = buffer.subarray(end);
      const hasCr = frame.includes(0x0d);
      const hasLf = frame.includes(0x0a);
      emitFrame(frame, hasCr && hasLf ? 'CRLF' : hasCr ? 'CR' : 'LF');
    }

    if (buffer.length > 0) scheduleIdleFlush();
  };

  return {
    push,
    reset: () => {
      clearIdle();
      buffer = Buffer.alloc(0);
    },
    destroy: clearIdle
  };
};

const loadSerialPort = () => {
  try {
    return require('serialport');
  } catch {
    try {
      return require(path.join(__dirname, '..', '..', 'node_modules', 'serialport'));
    } catch (err) {
      throw new Error(`No se encontró el paquete "serialport". Ejecutá: cd scripts && npm install. Detalle: ${err.message}`);
    }
  }
};

const openSerialOnce = (cfg, SerialPortImpl) => new Promise((resolve, reject) => {
  const { SerialPort } = SerialPortImpl || loadSerialPort();
  const port = new SerialPort({
    path: cfg.serialPort,
    baudRate: cfg.baudRate,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    autoOpen: false
  });
  port.open((err) => {
    if (err) {
      const msg = err.message || String(err);
      let hint = '';
      if (/access denied|busy|in use|EACCES|EBUSY/i.test(msg)) hint = ' El puerto suele estar en uso por otro programa.';
      if (/cannot find|ENOENT|file not found|unknown/i.test(msg)) hint = ' Revisá el nombre del puerto (Administrador de dispositivos → Puertos COM, o /dev/ttyUSB0).';
      reject(new Error(`No se pudo abrir ${cfg.serialPort}: ${msg}.${hint}`));
      return;
    }
    resolve(port);
  });
});

/**
 * Mantiene el puerto serie abierto con reconexión y backoff (×1.8). Termina solo con shouldStop().
 * @param {{serialPort:string, baudRate:number, idleMs?:number, reconnectMinMs?:number, reconnectMaxMs?:number, logger?:object}} cfg
 * @param {{onConnected?:Function, onDisconnected?:Function, onPort?:(port)=>void, SerialPort?:object}} [hooks]
 */
const runSerialLoop = async (cfg, onFrame, shouldStop, hooks = {}) => {
  const logger = cfg.logger || nullLogger;
  const minMs = Number(cfg.reconnectMinMs) || 1000;
  const maxMs = Number(cfg.reconnectMaxMs) || 30000;
  let backoff = minMs;
  const { onConnected, onDisconnected, onPort } = hooks;

  while (!shouldStop()) {
    let port = null;
    const framer = createSerialFramer(cfg, onFrame);
    try {
      port = await openSerialOnce(cfg, hooks.SerialPort);
      backoff = minMs;
      onPort?.(port);
      onConnected?.();
      logger.info('Puerto serie abierto', { port: cfg.serialPort, baud: cfg.baudRate });
      await new Promise((resolve) => {
        const onData = (chunk) => framer.push(chunk);
        const onError = (err) => logger.error('Error de puerto serie', { error: err.message || String(err) });
        const cleanup = () => {
          port.off('data', onData);
          port.off('error', onError);
          port.off('close', onClose);
          framer.destroy();
        };
        function onClose() {
          logger.warn('Puerto serie cerrado');
          onDisconnected?.();
          cleanup();
          resolve();
        }
        port.on('data', onData);
        port.on('error', onError);
        port.on('close', onClose);
        if (shouldStop()) {
          cleanup();
          try { if (port.isOpen) port.close(); } catch (_e) { /* ignore */ }
          onDisconnected?.();
          resolve();
        }
      });
    } catch (err) {
      onDisconnected?.();
      logger.error('Fallo serie, reintento', { error: err.message, waitMs: backoff });
      framer.destroy();
      await sleep(backoff);
      backoff = Math.min(maxMs, Math.floor(backoff * 1.8));
      continue;
    }
    if (shouldStop()) break;
    logger.warn('Reconectando puerto serie', { waitMs: backoff });
    await sleep(backoff);
    backoff = Math.min(maxMs, Math.floor(backoff * 1.8));
  }
};

module.exports = { createSerialFramer, runSerialLoop, openSerialOnce, loadSerialPort, formatChunk };
