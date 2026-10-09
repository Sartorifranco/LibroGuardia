'use strict';

/**
 * Framing serie del edge (la estación v1.7 sigue en scripts/programa-estacion.js y no se toca).
 *
 * Por defecto un CR/LF no cierra la lectura: todo lo que llega en la misma ráfaga es una sola
 * trama y se cierra cuando no entran más bytes durante interFrameGapMs (60). Los saltos internos
 * quedan como '\n'. idleMs sigue siendo el máximo de espera si el lector no manda terminador.
 * splitOnNewline:true vuelve a cortar en cada CR/LF, como el lector de una línea.
 */

const path = require('path');
const { nullLogger, maskDocumentDigits } = require('./logger');

const DEFAULT_IDLE_MS = 120;
const DEFAULT_GAP_MS = 60;

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

/** Hex de debug: los dígitos ASCII de un DNI (7+) se tapan salvo los últimos 3. */
const maskHexDigits = (buf) => {
  const bytes = [...buf];
  const hide = new Array(bytes.length).fill(false);
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] >= 0x30 && bytes[i] <= 0x39) {
      let j = i;
      while (j < bytes.length && bytes[j] >= 0x30 && bytes[j] <= 0x39) j += 1;
      if (j - i >= 7) {
        for (let k = i; k < j - 3; k += 1) hide[k] = true;
      }
      i = j;
    } else {
      i += 1;
    }
  }
  return bytes.map((b, idx) => (hide[idx] ? '**' : b.toString(16).padStart(2, '0'))).join(' ');
};

const chunkForLog = (buf) => {
  const { pretty } = formatChunk(buf);
  return { pretty: maskDocumentDigits(pretty), hex: maskHexDigits(buf) };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const positiveMs = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);

const bufferToText = (rawBuf, splitOnNewline) => {
  const raw = rawBuf.toString('utf8').replace(/\0/g, '');
  if (splitOnNewline) return raw.replace(/[\r\n]+/g, '').trim();
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\n+|\n+$/g, '').trim();
};

/**
 * @param {{idleMs?:number, interFrameGapMs?:number, splitOnNewline?:boolean, logger?:object}} cfg
 * @param {(frame:{text:string, pretty:string, hex:string, reason:string, rawBuf:Buffer})=>void} onComplete
 */
const createSerialFramer = (cfg, onComplete) => {
  const idleMs = positiveMs(cfg.idleMs, DEFAULT_IDLE_MS);
  const interFrameGapMs = positiveMs(cfg.interFrameGapMs, DEFAULT_GAP_MS);
  const splitOnNewline = cfg.splitOnNewline === true || cfg.splitOnNewline === 'true';
  const logger = cfg.logger || nullLogger;
  let buffer = Buffer.alloc(0);
  let idleTimer = null;
  let pendingReason = '';

  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const emitFrame = (rawBuf, reason) => {
    clearIdle();
    if (!rawBuf || rawBuf.length === 0) return;
    const text = bufferToText(rawBuf, splitOnNewline);
    const { pretty, hex } = formatChunk(rawBuf);
    logger.info('Trama', { bytes: rawBuf.length, reason });
    logger.debug('Trama detalle', { bytes: rawBuf.length, reason, ...chunkForLog(rawBuf) });
    onComplete({ text, pretty, hex, reason, rawBuf });
  };

  const scheduleFlush = (waitMs, reason) => {
    clearIdle();
    pendingReason = reason;
    idleTimer = setTimeout(() => {
      if (buffer.length === 0) return;
      const snapshot = buffer;
      buffer = Buffer.alloc(0);
      emitFrame(snapshot, pendingReason);
    }, waitMs);
  };

  const cutOnNewlines = () => {
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
  };

  const push = (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    logger.debug(`RX chunk (${buf.length} B)`, chunkForLog(buf));
    buffer = Buffer.concat([buffer, buf]);

    if (splitOnNewline) {
      cutOnNewlines();
      if (buffer.length > 0) scheduleFlush(idleMs, `silencio ${idleMs}ms`);
      return;
    }

    if (buffer.length === 0) return;
    const hasTerminator = buffer.includes(0x0d) || buffer.includes(0x0a);
    if (hasTerminator) scheduleFlush(interFrameGapMs, `ráfaga ${interFrameGapMs}ms`);
    else scheduleFlush(idleMs, `silencio ${idleMs}ms`);
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
 * @param {{serialPort:string, baudRate:number, idleMs?:number, interFrameGapMs?:number, splitOnNewline?:boolean, reconnectMinMs?:number, reconnectMaxMs?:number, logger?:object}} cfg
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
