'use strict';

/**
 * Logger del edge. Copia del criterio de programa-estacion.js (`log`, `rotateLogFile`,
 * `redactForLog`, `maskIdNumber`): una línea por evento, rotación por tamaño, DNI enmascarados
 * y claves sensibles fuera del log.
 */

const fs = require('fs');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_MAX_FILES = 5;
const SENSITIVE_LOG_KEYS = new Set([
  'password', 'secret', 'token', 'privateKey', 'privateKeyPem', 'httpAuthToken', 'authorization', 'sig'
]);
const FRAME_LOG_KEYS = new Set(['pretty', 'hex', 'preview', 'rawData', 'raw', 'text', 'value']);

const maskIdNumber = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length <= 3) return digits;
  return `${'*'.repeat(digits.length - 3)}${digits.slice(-3)}`;
};

const maskDocumentDigits = (value) => String(value ?? '').replace(/\d{7,}/g, (run) => maskIdNumber(run));

const redactForLog = (value, depth = 0, key = '') => {
  if (value == null || depth > 8) return value;
  if (typeof value === 'string') return FRAME_LOG_KEYS.has(key) ? maskDocumentDigits(value) : value;
  if (typeof value !== 'object') return value;
  if (value instanceof Error) return value.message;
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, depth + 1, key));
  const out = {};
  for (const [childKey, item] of Object.entries(value)) {
    if (SENSITIVE_LOG_KEYS.has(childKey)) continue;
    out[childKey] = redactForLog(item, depth + 1, childKey);
  }
  return out;
};

const rotateLogFile = (logFile, { maxBytes = LOG_MAX_BYTES, keep = LOG_MAX_FILES } = {}) => {
  let size = 0;
  try {
    size = fs.statSync(logFile).size;
  } catch (_err) {
    return false;
  }
  if (size < maxBytes) return false;
  const oldest = `${logFile}.${keep}`;
  if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
  for (let i = keep - 1; i >= 1; i -= 1) {
    const src = `${logFile}.${i}`;
    if (fs.existsSync(src)) fs.renameSync(src, `${logFile}.${i + 1}`);
  }
  fs.renameSync(logFile, `${logFile}.1`);
  return true;
};

/**
 * @param {{logFile?:string|null, level?:'debug'|'info'|'warn'|'error', tag?:string, console?:boolean}} [opts]
 * @returns {{debug:Function, info:Function, warn:Function, error:Function, child:(tag:string)=>object}}
 */
function createLogger({ logFile = null, level = 'info', tag = '', console: toConsole = true } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, message, extra) => {
    if ((LEVELS[lvl] ?? 0) < min) return;
    const safe = extra === undefined ? undefined : redactForLog(extra);
    const line = `${new Date().toISOString()} [${lvl}]${tag ? ` [${tag}]` : ''} ${message}${safe === undefined ? '' : ` ${JSON.stringify(safe)}`}`;
    if (toConsole) {
      // eslint-disable-next-line no-console
      (lvl === 'error' ? console.error : console.log)(line);
    }
    if (logFile) {
      try {
        rotateLogFile(logFile);
        fs.appendFileSync(logFile, `${line}\n`, 'utf8');
      } catch (_err) {
        // no romper el servicio por fallo de log a disco
      }
    }
  };
  const api = {
    debug: (m, e) => write('debug', m, e),
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e),
    child: (childTag) => createLogger({ logFile, level, tag: tag ? `${tag}/${childTag}` : childTag, console: toConsole })
  };
  return api;
}

/** Logger mudo (tests). */
const nullLogger = {
  debug() {}, info() {}, warn() {}, error() {}, child() { return nullLogger; }
};

module.exports = { createLogger, nullLogger, redactForLog, maskIdNumber, maskDocumentDigits, rotateLogFile, LEVELS };
