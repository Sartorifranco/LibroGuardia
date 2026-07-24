/**
 * Puente de producciÃ³n (estaciÃ³n = uno o varios lectores en el mismo proceso):
 *   lector(es) GADNIC CODBAR14 (RS-232) â†’ POST /api/access/kiosk-scan
 *
 * Formato config:
 *   - Nuevo: { apiBaseUrl, readers: [...], localServerPort?, localServerSecret? }
 *   - Legacy (retrocompat): un solo lector plano en la raÃ­z (doorId/username/â€¦).
 *
 * Servidor HTTP local (opcional, solo LAN â€” sin tÃºnel):
 *   GET  /status          estado de todos los lectores
 *   POST /open/:doorId    dispara relÃ© local si esta estaciÃ³n maneja esa puerta
 *   OPTIONS /*            preflight CORS + Private Network Access (panel guardia HTTPS)
 *   Auth: Authorization: Bearer <localServerSecret>
 *
 * VersiÃ³n bridge (local station API): ver BRIDGE_VERSION / LOCAL_STATION_API_VERSION.
 *
 * RelÃ© en modo local: TCP directo a la placa SR201 (fireLocalRelay).
 *
 * Framing serie: mismo criterio validado en scripts/test-lector-rele.js
 * (buffer hasta CR / CRLF / LF, o silencio idleMs).
 *
 * InstalaciÃ³n (una vez):
 *   cd scripts && npm install
 *
 * Config:
 *   copy door-reader.config.example.json door-reader.config.json
 *   (editar credenciales / doorId / puerto COM)
 *
 * Uso:
 *   set DOOR_READER_CONFIG=C:\ruta\door-reader.config.json
 *   node scripts/door-reader-bridge.js
 *
 * Docs: docs/INSTALACION-LECTOR-PUERTA.md
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// Driver SR201 (sÃ³lo usa 'net', sin Firebase) â€” reusado del mismo mÃ³dulo que
// producciÃ³n y que scripts/test-lector-rele.js (framing/TCP ya validado).
const {
  sendTcpCommand,
  sendTimedPulseTcp,
  buildPulseCommand
} = require('../functions/lib/doorDrivers/sr201');

const { parseScanData, normalizeIdNumber } = require('../functions/dniParser');

const DEFAULTS = {
  serialPort: 'COM3',
  baudRate: 9600,
  idleMs: 120,
  apiBaseUrl: '',
  username: '',
  password: '',
  doorId: '',
  readerId: 'default',
  logFile: '',
  reconnectMinMs: 2000,
  reconnectMaxMs: 60000,
  inputMode: 'serial', // serial | stdin
  /** Modo offline opcional: cachea allowlist y decide local si cae la red. */
  offlineCache: false,
  offlineCacheRefreshMs: 15 * 60 * 1000,
  /** Si la lista tiene mÃ¡s de N horas, no confiar y denegar offline. */
  offlineCacheMaxAgeHours: 24,
  /**
   * Con offlineCache + cachÃ© vigente: decide YA con la lista (sin kiosk-scan),
   * abre relÃ© al instante y reporta el evento en background vÃ­a cola offline.
   */
  localFirstMode: false,
  offlineAllowlistFile: '',
  offlineQueueFile: '',
  onlineScanTimeoutMs: 12000,
  allowlistTimeoutMs: 120000,
  /** Puerto HTTP local (0 = deshabilitado). Solo LAN; sin tÃºnel. */
  localServerPort: 0,
  localServerHost: '0.0.0.0',
  localServerSecret: ''
};

/**
 * VersiÃ³n del proceso door-reader-bridge (semver de scripts).
 * Bump cuando cambie el contrato del servidor local o el framing.
 */
const BRIDGE_VERSION = '1.1.0';
/** API del servidor HTTP local (status/open/CORS). Subir si cambia el contrato. */
const LOCAL_STATION_API_VERSION = 2;

/** OrÃ­genes del panel (HTTPS pÃºblico) autorizados a hablar con la estaciÃ³n LAN. */
const DEFAULT_CORS_ORIGINS = [
  'https://mss-guard.web.app',
  'https://mss-guard.firebaseapp.com',
  'https://bacarguard.web.app',
  'https://bacarguard.firebaseapp.com'
];

const CONTROL_NAMES = {
  0: 'NUL', 7: 'BEL', 8: 'BS', 9: 'TAB', 10: 'LF', 11: 'VT', 12: 'FF',
  13: 'CR', 27: 'ESC', 32: 'SPC'
};

const parseBool = (raw, fallback = false) => {
  if (raw === true || raw === '1' || String(raw).toLowerCase() === 'true') return true;
  if (raw === false || raw === '0' || String(raw).toLowerCase() === 'false') return false;
  return fallback;
};

/**
 * Normaliza un lector individual (campos por puerta) + defaults de estaciÃ³n.
 * @param {object} raw â€” entrada del array readers o del JSON legacy plano
 * @param {object} shared â€” apiBaseUrl, reconnect, logFile, configPath, idleMs
 */
const normalizeReaderConfig = (raw = {}, shared = {}) => {
  const configPath = shared.configPath || path.join(__dirname, 'door-reader.config.json');
  const offlineCache = parseBool(raw.offlineCache, false);
  let localFirstMode = parseBool(raw.localFirstMode, false);
  if (!offlineCache) localFirstMode = false;

  const doorId = String(raw.doorId || '').trim();
  const readerId = String(raw.readerId || DEFAULTS.readerId).trim();
  const doorKey = doorId || 'door';

  return {
    apiBaseUrl: String(shared.apiBaseUrl || '').replace(/\/$/, ''),
    username: String(raw.username || '').trim(),
    password: String(raw.password || ''),
    doorId,
    readerId,
    lectorId: String(raw.lectorId || '').trim(),
    serialPort: String(raw.serialPort || DEFAULTS.serialPort).trim(),
    baudRate: Number(raw.baudRate) || DEFAULTS.baudRate,
    idleMs: Number(raw.idleMs != null ? raw.idleMs : shared.idleMs) || DEFAULTS.idleMs,
    inputMode: String(raw.inputMode || shared.inputMode || DEFAULTS.inputMode).trim().toLowerCase(),
    logFile: String(raw.logFile || shared.logFile || DEFAULTS.logFile).trim(),
    reconnectMinMs: Number(shared.reconnectMinMs) || DEFAULTS.reconnectMinMs,
    reconnectMaxMs: Number(shared.reconnectMaxMs) || DEFAULTS.reconnectMaxMs,
    offlineCache,
    localFirstMode,
    offlineCacheRefreshMs: Number(raw.offlineCacheRefreshMs) || DEFAULTS.offlineCacheRefreshMs,
    offlineCacheMaxAgeHours: Number(raw.offlineCacheMaxAgeHours) || DEFAULTS.offlineCacheMaxAgeHours,
    offlineAllowlistFile: String(
      raw.offlineAllowlistFile
      || path.join(path.dirname(configPath), `door-allowlist-${doorKey}-${readerId}.json`)
    ).trim(),
    offlineQueueFile: String(
      raw.offlineQueueFile
      || path.join(path.dirname(configPath), `offline-queue-${doorKey}-${readerId}.json`)
    ).trim(),
    onlineScanTimeoutMs: Number(raw.onlineScanTimeoutMs) || DEFAULTS.onlineScanTimeoutMs,
    allowlistTimeoutMs: Number(raw.allowlistTimeoutMs) || DEFAULTS.allowlistTimeoutMs,
    configPath
  };
};

/**
 * Formato nuevo: { apiBaseUrl, readers: [...] }
 * Formato viejo (retrocompat): un solo lector en la raÃ­z (doorId/username/â€¦).
 * Env vars solo aplican al formato viejo / al primer lector (estaciones ya instaladas).
 */
const normalizeStationConfig = (fileCfg = {}, env = process.env, configPath = '') => {
  const resolvedPath = configPath
    || env.DOOR_READER_CONFIG
    || path.join(__dirname, 'door-reader.config.json');

  const apiBaseUrl = String(env.API_BASE_URL || fileCfg.apiBaseUrl || DEFAULTS.apiBaseUrl)
    .replace(/\/$/, '');
  const shared = {
    apiBaseUrl,
    logFile: String(env.LOG_FILE || fileCfg.logFile || DEFAULTS.logFile).trim(),
    reconnectMinMs: Number(env.RECONNECT_MIN_MS || fileCfg.reconnectMinMs || DEFAULTS.reconnectMinMs),
    reconnectMaxMs: Number(env.RECONNECT_MAX_MS || fileCfg.reconnectMaxMs || DEFAULTS.reconnectMaxMs),
    idleMs: Number(env.IDLE_MS || fileCfg.idleMs || DEFAULTS.idleMs) || DEFAULTS.idleMs,
    inputMode: String(env.INPUT_MODE || fileCfg.inputMode || DEFAULTS.inputMode).trim().toLowerCase(),
    configPath: resolvedPath
  };

  let rawReaders;
  if (Array.isArray(fileCfg.readers) && fileCfg.readers.length > 0) {
    rawReaders = fileCfg.readers;
  } else {
    // Legacy: un lector plano (+ overrides por env, como hasta ahora).
    // Archivos de cachÃ© conservan el nombre histÃ³rico (sin readerId) para no
    // invalidar allowlists ya generadas en estaciones instaladas.
    const legacyDoorId = String(env.DOOR_ID || fileCfg.doorId || 'door').trim();
    const legacyDir = path.dirname(resolvedPath);
    rawReaders = [{
      serialPort: env.SERIAL_PORT || fileCfg.serialPort,
      baudRate: env.SERIAL_BAUD || fileCfg.baudRate,
      idleMs: env.IDLE_MS || fileCfg.idleMs,
      username: env.KIOSK_USERNAME || fileCfg.username,
      password: env.KIOSK_PASSWORD || fileCfg.password,
      doorId: env.DOOR_ID || fileCfg.doorId,
      readerId: env.READER_ID || fileCfg.readerId,
      lectorId: env.LECTOR_ID || fileCfg.lectorId,
      inputMode: env.INPUT_MODE || fileCfg.inputMode,
      offlineCache: env.OFFLINE_CACHE != null ? env.OFFLINE_CACHE : fileCfg.offlineCache,
      localFirstMode: env.LOCAL_FIRST_MODE != null ? env.LOCAL_FIRST_MODE : fileCfg.localFirstMode,
      offlineCacheRefreshMs: env.OFFLINE_CACHE_REFRESH_MS || fileCfg.offlineCacheRefreshMs,
      offlineCacheMaxAgeHours: env.OFFLINE_CACHE_MAX_AGE_HOURS || fileCfg.offlineCacheMaxAgeHours,
      offlineAllowlistFile: env.OFFLINE_ALLOWLIST_FILE
        || fileCfg.offlineAllowlistFile
        || path.join(legacyDir, `door-allowlist-${legacyDoorId}.json`),
      offlineQueueFile: env.OFFLINE_QUEUE_FILE
        || fileCfg.offlineQueueFile
        || path.join(legacyDir, `offline-queue-${legacyDoorId}.json`),
      onlineScanTimeoutMs: env.ONLINE_SCAN_TIMEOUT_MS || fileCfg.onlineScanTimeoutMs,
      allowlistTimeoutMs: env.ALLOWLIST_TIMEOUT_MS || fileCfg.allowlistTimeoutMs,
      logFile: env.LOG_FILE || fileCfg.logFile
    }];
  }

  const readers = rawReaders.map((r) => normalizeReaderConfig(r, shared));

  if (!apiBaseUrl) {
    throw new Error('Falta apiBaseUrl (ej. https://mss-guard.web.app/api)');
  }
  readers.forEach((r, idx) => {
    if (!r.username || !r.password) {
      throw new Error(`Lector[${idx}]: faltan username/password del usuario kiosk`);
    }
    if (!r.doorId) {
      throw new Error(`Lector[${idx}]: falta doorId`);
    }
  });

  const stdinCount = readers.filter((r) => r.inputMode === 'stdin').length;
  if (stdinCount > 1) {
    throw new Error('Solo un lector puede usar inputMode "stdin" por estaciÃ³n');
  }

  const localServerPort = Number(
    env.LOCAL_SERVER_PORT != null ? env.LOCAL_SERVER_PORT : fileCfg.localServerPort
  );
  const localServerSecret = String(
    env.LOCAL_SERVER_SECRET != null ? env.LOCAL_SERVER_SECRET : (fileCfg.localServerSecret || '')
  ).trim();
  const localServerHost = String(
    env.LOCAL_SERVER_HOST || fileCfg.localServerHost || DEFAULTS.localServerHost
  ).trim() || DEFAULTS.localServerHost;

  if (Number.isFinite(localServerPort) && localServerPort > 0 && !localServerSecret) {
    throw new Error(
      'localServerPort > 0 requiere localServerSecret (mismo criterio que bridgeSecret)'
    );
  }

  return {
    apiBaseUrl,
    logFile: shared.logFile,
    reconnectMinMs: shared.reconnectMinMs,
    reconnectMaxMs: shared.reconnectMaxMs,
    configPath: resolvedPath,
    localServerPort: Number.isFinite(localServerPort) && localServerPort > 0
      ? Math.floor(localServerPort)
      : 0,
    localServerHost,
    localServerSecret,
    readers
  };
};

const loadConfig = () => {
  const configPath = process.env.DOOR_READER_CONFIG
    || path.join(__dirname, 'door-reader.config.json');

  let fileCfg = {};
  if (fs.existsSync(configPath)) {
    fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } else if (!process.env.DOOR_READER_CONFIG) {
    // sin archivo local: solo env / defaults
  } else {
    throw new Error(`No existe el archivo de config: ${configPath}`);
  }

  return normalizeStationConfig(fileCfg, process.env, configPath);
};

const log = (cfg, level, message, extra) => {
  const line = `${new Date().toISOString()} [${level}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
  console.log(line);
  if (cfg.logFile) {
    try {
      fs.appendFileSync(cfg.logFile, `${line}\n`, 'utf8');
    } catch (_err) {
      // no romper el servicio por fallo de log a disco
    }
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * MODO LOCAL: dispara el relÃ© SR201 directo por la LAN, con los datos de
 * conexiÃ³n (host/puerto/canal/pulseSeconds) que devuelve /api/access/kiosk-scan
 * cuando la puerta estÃ¡ en relayMode 'local'. Reusa el driver ya validado.
 *
 * No bloquea: en 'timed' el ON confirma y el OFF sigue async (mismo criterio
 * que producciÃ³n), asÃ­ el escaneo queda libre para la prÃ³xima lectura.
 */
const fireLocalRelay = async (cfg, localRelay = {}) => {
  const host = String(localRelay.host || '').trim();
  const port = Number(localRelay.port) || 6722;
  const channel = Number(localRelay.channel) || 1;
  const mode = localRelay.pulseMode === 'jog' ? 'jog' : 'timed';
  const seconds = Math.max(1, Math.min(99, Number(localRelay.pulseSeconds) || 3));

  if (!host) {
    throw new Error('localRelay sin host (la puerta en modo local necesita IP de la placa)');
  }

  if (mode === 'timed') {
    const timed = await sendTimedPulseTcp(host, port, channel, seconds, 4000, {
      waitForComplete: false
    });
    return { via: 'tcp-local', host, port, channel, mode, seconds, ...timed };
  }

  const command = buildPulseCommand(channel, 'jog', seconds);
  const tcp = await sendTcpCommand(host, port, command);
  return { via: 'tcp-local', host, port, channel, mode, command, ...tcp };
};

const requestJson = (method, urlString, { headers = {}, body, timeoutMs = 25000 } = {}) =>
  new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = lib.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch (_e) { data = { raw }; }
        resolve({ status: res.statusCode || 0, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Timeout de red'));
    });
    if (payload) req.write(payload);
    req.end();
  });

const isNetworkError = (err) => {
  if (!err) return false;
  const msg = String(err.message || err);
  return /timeout|ECONN|ENOTFOUND|EAI_AGAIN|network|socket|TLS|SSL|getaddrinfo|EHOSTUNREACH|ENETUNREACH/i.test(msg);
};

const readJsonFile = (filePath, fallback) => {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
};

const writeJsonFile = (filePath, data) => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
};

const createOfflineLocalId = () =>
  `off_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

const extractScanIdentity = (rawData) => {
  const parsed = parseScanData(rawData);
  const dni = normalizeIdNumber(parsed.idNumber || '');
  return {
    dniNormalized: dni || '',
    nombre: parsed.name || [parsed.lastName, parsed.firstName].filter(Boolean).join(' ').trim(),
    format: parsed.format || 'unknown'
  };
};

const allowlistEntryStillValid = (entry, now = new Date()) => {
  if (!entry) return false;
  if (!entry.validUntil) return true;
  const until = Date.parse(entry.validUntil);
  if (!Number.isFinite(until)) return true;
  return until >= now.getTime();
};

const findAllowlistMatch = (allowlist, dniNormalized, now = new Date()) => {
  const dni = normalizeIdNumber(dniNormalized);
  if (!dni || !allowlist?.entries) return null;
  const hit = allowlist.entries.find((e) => normalizeIdNumber(e.dniNormalized) === dni);
  if (!hit) return null;
  if (!allowlistEntryStillValid(hit, now)) return null;
  return hit;
};

const isAllowlistFresh = (allowlist, maxAgeHours, nowMs = Date.now()) => {
  if (!allowlist?.generatedAt) return false;
  const at = Date.parse(allowlist.generatedAt);
  if (!Number.isFinite(at)) return false;
  const maxMs = Math.max(1, Number(maxAgeHours) || 24) * 60 * 60 * 1000;
  return (nowMs - at) <= maxMs;
};

/** true si debe decidir con cachÃ© sin llamar a kiosk-scan (modo instantÃ¡neo). */
const canDecideLocalFirst = (cfg = {}, allowlist = null, nowMs = Date.now()) =>
  Boolean(cfg.offlineCache)
  && Boolean(cfg.localFirstMode)
  && isAllowlistFresh(allowlist, cfg.offlineCacheMaxAgeHours, nowMs);

const createApiClient = (cfg) => {
  let token = null;
  let networkBackoffMs = cfg.reconnectMinMs;

  const login = async () => {
    const res = await requestJson('POST', `${cfg.apiBaseUrl}/auth/login`, {
      body: { username: cfg.username, password: cfg.password }
    });
    if (res.status === 429) {
      const wait = Number(res.data.retryAfterSeconds || 15) * 1000;
      throw Object.assign(new Error(res.data.message || 'Rate limit login'), { retryAfterMs: wait });
    }
    if (res.status < 200 || res.status >= 300 || !res.data.token) {
      throw new Error(res.data.message || `Login fallÃ³ (${res.status})`);
    }
    token = res.data.token;
    networkBackoffMs = cfg.reconnectMinMs;
    log(cfg, 'info', 'SesiÃ³n kiosk OK', {
      username: cfg.username,
      expiresIn: '8h'
    });
    return token;
  };

  const ensureToken = async () => {
    if (!token) await login();
    return token;
  };

  const authorizedRequest = async (method, pathSuffix, { body, timeoutMs } = {}) => {
    const doCall = async () => {
      const bearer = await ensureToken();
      return requestJson(method, `${cfg.apiBaseUrl}${pathSuffix}`, {
        headers: { Authorization: `Bearer ${bearer}` },
        body,
        timeoutMs
      });
    };
    let res = await doCall();
    if (res.status === 401) {
      log(cfg, 'warn', 'Token expirado o invÃ¡lido (401) â€” re-login');
      token = null;
      await login();
      res = await doCall();
    }
    return res;
  };

  const kioskScan = async (rawData, { timeoutMs } = {}) =>
    authorizedRequest('POST', '/access/kiosk-scan', {
      body: {
        rawData,
        doorId: cfg.doorId,
        readerId: cfg.readerId
      },
      timeoutMs: timeoutMs || cfg.onlineScanTimeoutMs || 25000
    });

  const heartbeat = async () =>
    authorizedRequest('POST', '/lectores/heartbeat', {
      body: {
        doorId: cfg.doorId,
        readerId: cfg.readerId,
        serialPort: cfg.serialPort,
        inputMode: cfg.inputMode,
        ...(cfg.lectorId ? { lectorId: cfg.lectorId } : {})
      },
      timeoutMs: 20000
    });

  const fetchDoorAllowlist = async () =>
    authorizedRequest('GET', `/access/door-allowlist/${encodeURIComponent(cfg.doorId)}`, {
      timeoutMs: cfg.allowlistTimeoutMs || 120000
    });

  const postOfflineEntries = async (events) =>
    authorizedRequest('POST', '/access/offline-entries', {
      body: { events },
      timeoutMs: 60000
    });

  const withNetworkRetry = async (fn, label) => {
    for (;;) {
      try {
        const result = await fn();
        networkBackoffMs = cfg.reconnectMinMs;
        return result;
      } catch (err) {
        const wait = err.retryAfterMs || networkBackoffMs;
        log(cfg, 'warn', `${label} fallÃ³, reintento`, {
          error: err.message,
          waitMs: wait
        });
        await sleep(wait);
        networkBackoffMs = Math.min(
          cfg.reconnectMaxMs,
          Math.floor(networkBackoffMs * 1.8)
        );
      }
    }
  };

  return {
    login,
    kioskScan,
    heartbeat,
    fetchDoorAllowlist,
    postOfflineEntries,
    withNetworkRetry
  };
};

const loadSerialPort = () => {
  try {
    return require('serialport');
  } catch {
    try {
      return require(path.join(__dirname, 'node_modules', 'serialport'));
    } catch (err) {
      throw new Error(
        'No se encontrÃ³ el paquete "serialport". EjecutÃ¡:\n'
        + '  cd scripts\n'
        + '  npm install\n'
        + `Detalle: ${err.message}`
      );
    }
  }
};

/**
 * Framing validado en test-lector-rele.js: acumula hasta CR/LF/CRLF,
 * o flush por silencio (idleMs) si el lector no manda terminador.
 */
const createSerialFramer = (cfg, onComplete) => {
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
      emitFrame(snapshot, `silencio ${cfg.idleMs}ms`);
    }, cfg.idleMs);
  };

  const push = (chunk) => {
    const { pretty, hex } = formatChunk(chunk);
    log(cfg, 'debug', `RX chunk (${chunk.length} B)`, { pretty, hex });

    buffer = Buffer.concat([buffer, chunk]);

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

      let termLabel = 'terminador';
      const hasCr = frame.includes(0x0d);
      const hasLf = frame.includes(0x0a);
      if (hasCr && hasLf) termLabel = 'CRLF';
      else if (hasCr) termLabel = 'CR';
      else if (hasLf) termLabel = 'LF';

      emitFrame(frame, termLabel);
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

const openSerialOnce = (cfg) => new Promise((resolve, reject) => {
  const { SerialPort } = loadSerialPort();
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
      if (/access denied|busy|in use|EACCES|EBUSY/i.test(msg)) {
        hint = ' El puerto suele estar en uso por otro programa.';
      }
      if (/cannot find|ENOENT|file not found|unknown/i.test(msg)) {
        hint = ' RevisÃ¡ el nombre del puerto (Administrador de dispositivos â†’ Puertos COM).';
      }
      reject(new Error(`No se pudo abrir ${cfg.serialPort}: ${msg}.${hint}`));
      return;
    }
    resolve(port);
  });
});

/**
 * Mantiene el puerto serie abierto con reconexiÃ³n y backoff.
 * Nunca termina el loop salvo shutdown.
 * @param {{ onConnected?: () => void, onDisconnected?: () => void }} [hooks]
 */
const runSerialLoop = async (cfg, onFrame, shouldStop, hooks = {}) => {
  let backoff = cfg.reconnectMinMs;
  const { onConnected, onDisconnected } = hooks;

  while (!shouldStop()) {
    let port = null;
    const framer = createSerialFramer(cfg, onFrame);

    try {
      port = await openSerialOnce(cfg);
      backoff = cfg.reconnectMinMs;
      onConnected?.();
      log(cfg, 'info', 'Puerto serie abierto', {
        port: cfg.serialPort,
        baud: cfg.baudRate
      });

      await new Promise((resolve) => {
        const onData = (chunk) => framer.push(chunk);
        const onError = (err) => {
          log(cfg, 'error', 'Error de puerto serie', { error: err.message || String(err) });
        };
        const onClose = () => {
          log(cfg, 'warn', 'Puerto serie cerrado');
          onDisconnected?.();
          cleanup();
          resolve();
        };
        const cleanup = () => {
          port.off('data', onData);
          port.off('error', onError);
          port.off('close', onClose);
          framer.destroy();
        };

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
      log(cfg, 'error', 'Fallo serie, reintento', {
        error: err.message,
        waitMs: backoff
      });
      framer.destroy();
      await sleep(backoff);
      backoff = Math.min(cfg.reconnectMaxMs, Math.floor(backoff * 1.8));
      continue;
    }

    if (shouldStop()) break;
    log(cfg, 'warn', 'Reconectando puerto serie', { waitMs: backoff });
    await sleep(backoff);
    backoff = Math.min(cfg.reconnectMaxMs, Math.floor(backoff * 1.8));
  }
};

/**
 * Extrae el secreto de Authorization Bearer o X-Station-Secret / X-Bridge-Secret.
 */
const extractStationSecret = (req) => {
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  const alt = req.headers['x-station-secret'] || req.headers['x-bridge-secret'];
  return String(alt || '').trim();
};

/**
 * OrÃ­genes CORS permitidos: defaults del hosting + LOCAL_SERVER_CORS_ORIGINS (CSV)
 * + localhost / 127.0.0.1 (cualquier puerto) para desarrollo del panel.
 */
const resolveAllowedCorsOrigins = (env = process.env) => {
  const extra = String(env.LOCAL_SERVER_CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...DEFAULT_CORS_ORIGINS, ...extra];
};

const isAllowedCorsOrigin = (origin, env = process.env) => {
  const o = String(origin || '').trim();
  if (!o) return false;
  if (resolveAllowedCorsOrigins(env).includes(o)) return true;
  // Dev local del SPA (Create React App / Vite).
  try {
    const u = new URL(o);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
};

/**
 * Headers CORS (+ Private Network Access) para respuestas del servidor local.
 * No usa wildcard: el panel manda Authorization Bearer.
 * @returns {Record<string, string>}
 */
const buildCorsHeaders = (req, env = process.env) => {
  const origin = String(req.headers.origin || '').trim();
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, Accept, X-Station-Secret, X-Bridge-Secret',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };

  if (isAllowedCorsOrigin(origin, env)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  // Chrome Private Network Access: preflight desde origen pÃºblico â†’ IP privada.
  // TambiÃ©n lo devolvemos en respuestas reales por si el browser lo exige.
  const wantsPrivateNetwork = String(
    req.headers['access-control-request-private-network'] || ''
  ).toLowerCase() === 'true'
    || Boolean(req.headers.origin);
  if (wantsPrivateNetwork && headers['Access-Control-Allow-Origin']) {
    headers['Access-Control-Allow-Private-Network'] = 'true';
  }

  // Si el preflight pide headers extra, reflejarlos (siempre sobre la allowlist base).
  const requested = String(req.headers['access-control-request-headers'] || '').trim();
  if (requested) {
    headers['Access-Control-Allow-Headers'] = requested;
  }

  return headers;
};

/**
 * Servidor HTTP local de la estaciÃ³n (solo LAN). Endpoints:
 *   GET  /status
 *   POST /open/:doorId
 *   OPTIONS (preflight CORS / PNA) â€” sin auth
 *
 * CORS habilita que https://mss-guard.web.app lea la respuesta en el navegador.
 * La seguridad sigue siendo el secreto Bearer: CORS no abre el endpoint a cualquiera.
 *
 * @param {{ host: string, port: number, secret: string, getStatus: Function, openDoor: Function, logFn?: Function, env?: object }} opts
 * @returns {Promise<{ server: import('http').Server, port: number, close: () => Promise<void> }>}
 */
const createLocalStationServer = (opts) => new Promise((resolve, reject) => {
  const host = String(opts.host || DEFAULTS.localServerHost).trim() || DEFAULTS.localServerHost;
  const port = Number(opts.port);
  const secret = String(opts.secret || '').trim();
  const getStatus = opts.getStatus;
  const openDoor = opts.openDoor;
  const logFn = opts.logFn || (() => {});
  const env = opts.env || process.env;

  if (!Number.isFinite(port) || port <= 0) {
    reject(new Error('createLocalStationServer: puerto invÃ¡lido'));
    return;
  }
  if (!secret) {
    reject(new Error('createLocalStationServer: secret obligatorio'));
    return;
  }

  const sendJson = (res, statusCode, body, req) => {
    const payload = JSON.stringify(body);
    const cors = req ? buildCorsHeaders(req, env) : {};
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      ...cors
    });
    res.end(payload);
  };

  const requireAuth = (req, res) => {
    if (extractStationSecret(req) !== secret) {
      sendJson(res, 401, { ok: false, message: 'Secreto de estaciÃ³n invÃ¡lido' }, req);
      return false;
    }
    return true;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const method = (req.method || 'GET').toUpperCase();

      // Preflight: no exige secreto (el browser aÃºn no manda Authorization).
      if (method === 'OPTIONS') {
        const cors = buildCorsHeaders(req, env);
        res.writeHead(204, {
          ...cors,
          'Content-Length': 0,
          'Cache-Control': 'no-store'
        });
        res.end();
        return;
      }

      if (method === 'GET' && url.pathname === '/status') {
        if (!requireAuth(req, res)) return;
        const status = await Promise.resolve(getStatus());
        sendJson(res, 200, {
          ok: true,
          bridgeVersion: BRIDGE_VERSION,
          localStationApiVersion: LOCAL_STATION_API_VERSION,
          ...status
        }, req);
        return;
      }

      const openMatch = url.pathname.match(/^\/open\/([^/]+)\/?$/);
      if (method === 'POST' && openMatch) {
        if (!requireAuth(req, res)) return;
        const doorId = decodeURIComponent(openMatch[1]);
        const result = await Promise.resolve(openDoor(doorId));
        if (result && result.notFound) {
          sendJson(res, 404, {
            ok: false,
            message: `Esta estaciÃ³n no maneja la puerta "${doorId}"`
          }, req);
          return;
        }
        sendJson(res, 200, {
          ok: true,
          doorId,
          message: 'RelÃ© local disparado',
          ...(result && typeof result === 'object' ? result : {})
        }, req);
        return;
      }

      sendJson(res, 404, { ok: false, message: 'No encontrado' }, req);
    } catch (err) {
      logFn('error', 'Error en servidor local de estaciÃ³n', { error: err.message });
      sendJson(res, 500, { ok: false, message: err.message || 'Error interno' }, req);
    }
  });

  server.on('error', reject);
  server.listen(port, host, () => {
    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : port;
    logFn('info', 'Servidor local de estaciÃ³n escuchando', {
      host,
      port: boundPort,
      bridgeVersion: BRIDGE_VERSION,
      localStationApiVersion: LOCAL_STATION_API_VERSION
    });
    resolve({
      server,
      port: boundPort,
      host,
      close: () => new Promise((resClose, rejClose) => {
        server.close((err) => (err ? rejClose(err) : resClose()));
      })
    });
  });
});

/**
 * Arma getStatus / openDoor a partir de los runtimes de lectores.
 */
const buildStationLocalHandlers = (runtimes = []) => {
  const byDoorId = new Map();
  runtimes.forEach((rt) => {
    const doorId = String(rt?.cfg?.doorId || '').trim();
    if (!doorId) return;
    if (!byDoorId.has(doorId)) byDoorId.set(doorId, []);
    byDoorId.get(doorId).push(rt);
  });

  return {
    getStatus: () => ({
      readers: runtimes.map((rt) => (typeof rt.getStatus === 'function' ? rt.getStatus() : {
        doorId: rt.cfg?.doorId,
        readerId: rt.cfg?.readerId,
        connected: false
      }))
    }),
    openDoor: async (doorId) => {
      const key = String(doorId || '').trim();
      const list = byDoorId.get(key);
      if (!list || list.length === 0) return { notFound: true };
      // Una puerta puede tener varios lectores en la misma estaciÃ³n; basta
      // disparar el relÃ© una vez (mismo localRelay en allowlist de esa puerta).
      const rt = list[0];
      if (typeof rt.openLocal !== 'function') {
        throw new Error('Runtime sin openLocal');
      }
      const relay = await rt.openLocal();
      return { notFound: false, relay };
    }
  };
};

const startStdinReader = (cfg, onFrame) => {
  const framer = createSerialFramer(cfg, onFrame);
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    framer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
  });
  log(cfg, 'info', 'Modo stdin (prueba). PegÃ¡ rawData + Enter/CR.');
  return () => framer.destroy();
};

/**
 * Runtime independiente por lector (serie, login, cachÃ©, cola, heartbeat).
 * @returns {Promise<{ stop: () => void, cfg: object, getStatus: () => object, openLocal: () => Promise<object> }>}
 */
const startReaderRuntime = async (cfg, { shouldStop }) => {
  const api = createApiClient(cfg);
  const cleanups = [];

  let cachedAllowlist = cfg.offlineCache
    ? readJsonFile(cfg.offlineAllowlistFile, null)
    : null;
  let offlineQueue = cfg.offlineCache
    ? readJsonFile(cfg.offlineQueueFile, [])
    : [];
  if (!Array.isArray(offlineQueue)) offlineQueue = [];

  let serialConnected = cfg.inputMode === 'stdin';
  let lastScanAt = null;
  let lastLocalRelay = cachedAllowlist?.localRelay || null;

  const persistQueue = () => {
    if (!cfg.offlineCache) return;
    writeJsonFile(cfg.offlineQueueFile, offlineQueue);
  };

  const persistAllowlist = (data) => {
    cachedAllowlist = data;
    if (data?.localRelay?.host) lastLocalRelay = data.localRelay;
    writeJsonFile(cfg.offlineAllowlistFile, data);
  };

  const enqueueOfflineEvent = (event) => {
    offlineQueue.push(event);
    persistQueue();
  };

  const refreshAllowlist = async (reason = 'scheduled') => {
    if (!cfg.offlineCache) return false;
    const res = await api.fetchDoorAllowlist();
    if (res.status < 200 || res.status >= 300) {
      throw new Error(res.data?.message || `allowlist HTTP ${res.status}`);
    }
    persistAllowlist(res.data);
    log(cfg, 'info', 'Allowlist offline actualizada', {
      reason,
      count: res.data?.count,
      generatedAt: res.data?.generatedAt,
      file: cfg.offlineAllowlistFile
    });
    return true;
  };

  const flushOfflineQueue = async () => {
    if (!cfg.offlineCache || offlineQueue.length === 0) return;
    const batch = [...offlineQueue];
    const res = await api.postOfflineEntries(batch);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(res.data?.message || `offline-entries HTTP ${res.status}`);
    }
    const failed = (res.data?.results || []).filter((r) => r.status === 'error');
    if (failed.length) {
      const failedIds = new Set(failed.map((f) => f.offlineLocalId).filter(Boolean));
      offlineQueue = batch.filter((e) => failedIds.has(e.offlineLocalId));
      persistQueue();
      log(cfg, 'warn', 'Cola offline parcialmente sincronizada', {
        accepted: res.data?.accepted,
        skipped: res.data?.skipped,
        remaining: offlineQueue.length
      });
      return;
    }
    offlineQueue = [];
    persistQueue();
    log(cfg, 'info', 'Cola offline sincronizada', {
      accepted: res.data?.accepted,
      skipped: res.data?.skipped
    });
  };

  const decideFromCache = async (rawData, {
    denyIfStale = true,
    label = 'offline'
  } = {}) => {
    const identity = extractScanIdentity(rawData);
    const now = new Date();
    const fresh = Boolean(cachedAllowlist)
      && isAllowlistFresh(cachedAllowlist, cfg.offlineCacheMaxAgeHours);

    if (!fresh) {
      if (!denyIfStale) {
        return null;
      }
      log(cfg, 'warn', `${label}: allowlist ausente o vencida â€” denegado`, {
        hasCache: Boolean(cachedAllowlist),
        generatedAt: cachedAllowlist?.generatedAt || null,
        maxAgeHours: cfg.offlineCacheMaxAgeHours
      });
      const offlineLocalId = createOfflineLocalId();
      enqueueOfflineEvent({
        offlineLocalId,
        doorId: cfg.doorId,
        readerId: cfg.readerId,
        movementType: 'ingreso',
        timestamp: now.toISOString(),
        dniNormalized: identity.dniNormalized,
        nombre: identity.nombre,
        authorized: false,
        denialReason: 'offline_allowlist_stale',
        relayTriggered: false
      });
      return {
        authorized: false,
        message: 'Sin conexiÃ³n y lista local vencida o ausente. Acceso denegado.',
        offline: true,
        localFirst: label === 'local-first'
      };
    }

    if (!identity.dniNormalized) {
      return {
        authorized: false,
        message: `No se pudo leer el documento (modo ${label}).`,
        offline: true,
        localFirst: label === 'local-first'
      };
    }

    const match = findAllowlistMatch(cachedAllowlist, identity.dniNormalized, now);
    const authorized = Boolean(match);
    const offlineLocalId = createOfflineLocalId();
    let relayTriggered = false;

    if (authorized
      && cachedAllowlist.relayMode === 'local'
      && cachedAllowlist.localRelay) {
      try {
        await fireLocalRelay(cfg, cachedAllowlist.localRelay);
        relayTriggered = true;
      } catch (relayErr) {
        log(cfg, 'error', `Fallo relÃ© local (${label})`, { error: relayErr.message });
      }
    }

    enqueueOfflineEvent({
      offlineLocalId,
      doorId: cfg.doorId,
      readerId: cfg.readerId,
      movementType: 'ingreso',
      timestamp: now.toISOString(),
      dniNormalized: identity.dniNormalized,
      nombre: match?.nombre || identity.nombre,
      personId: match?.personId || null,
      authorizationType: match?.authorizationType || null,
      authorized,
      denialReason: authorized ? null : 'offline_not_in_allowlist',
      relayTriggered
    });

    flushOfflineQueue().catch((err) => {
      log(cfg, 'warn', `Cola ${label}: sync diferido fallÃ³ (reintento en heartbeat)`, {
        error: err.message
      });
    });

    return {
      authorized,
      message: authorized
        ? `${label === 'local-first' ? 'InstantÃ¡neo' : 'Offline'} OK: ${match.nombre || identity.dniNormalized}`
        : `${label === 'local-first' ? 'InstantÃ¡neo' : 'Offline'}: no autorizado en lista local`,
      offline: true,
      localFirst: label === 'local-first',
      localRelay: cachedAllowlist.localRelay || null,
      relayMode: cachedAllowlist.relayMode || 'local',
      relayTriggered
    };
  };

  const decideOffline = (rawData) => decideFromCache(rawData, {
    denyIfStale: true,
    label: 'offline'
  });

  log(cfg, 'info', 'Lector iniciando', {
    doorId: cfg.doorId,
    readerId: cfg.readerId,
    apiBaseUrl: cfg.apiBaseUrl,
    inputMode: cfg.inputMode,
    serialPort: cfg.serialPort,
    baudRate: cfg.baudRate,
    offlineCache: cfg.offlineCache,
    localFirstMode: cfg.localFirstMode
  });

  await api.withNetworkRetry(() => api.login(), 'login');

  if (cfg.offlineCache) {
    try {
      await refreshAllowlist('startup');
    } catch (err) {
      log(cfg, 'warn', 'No se pudo cargar allowlist al iniciar (se usarÃ¡ cachÃ© en disco si hay)', {
        error: err.message
      });
    }
  }

  const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 5 * 60 * 1000);
  const sendHeartbeat = async () => {
    try {
      const res = await api.heartbeat();
      if (res.status >= 200 && res.status < 300) {
        log(cfg, 'info', 'Heartbeat OK', {
          lectorId: res.data?.lectorId,
          status: res.data?.connectionStatus,
          forceResync: Boolean(res.data?.forceResync)
        });

        if (cfg.offlineCache) {
          try {
            await flushOfflineQueue();
          } catch (flushErr) {
            log(cfg, 'warn', 'No se pudo vaciar cola offline', { error: flushErr.message });
          }
          if (res.data?.forceResync) {
            try {
              await refreshAllowlist('forceResync');
            } catch (syncErr) {
              log(cfg, 'warn', 'forceResync fallÃ³', { error: syncErr.message });
            }
          }
        }
      } else {
        log(cfg, 'warn', 'Heartbeat rechazado', {
          status: res.status,
          message: res.data?.message
        });
      }
    } catch (err) {
      log(cfg, 'warn', 'Heartbeat fallÃ³', { error: err.message });
    }
  };
  sendHeartbeat();
  const heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
  cleanups.push(() => clearInterval(heartbeatTimer));

  let allowlistTimer = null;
  if (cfg.offlineCache) {
    allowlistTimer = setInterval(() => {
      refreshAllowlist('interval').catch((err) => {
        log(cfg, 'warn', 'Refresh periÃ³dico de allowlist fallÃ³', { error: err.message });
      });
    }, cfg.offlineCacheRefreshMs);
    cleanups.push(() => clearInterval(allowlistTimer));
  }

  let busy = false;
  const handleFrame = async ({ text, pretty, hex, reason }) => {
    if (!text) {
      log(cfg, 'warn', 'Frame vacÃ­o tras limpiar CR/LF', { reason, pretty });
      return;
    }
    if (busy) {
      log(cfg, 'warn', 'Lectura ignorada (aÃºn procesando la anterior)', {
        preview: text.slice(0, 80)
      });
      return;
    }

    busy = true;
    lastScanAt = new Date().toISOString();
    const t0 = Date.now();
    try {
      log(cfg, 'info', 'Escaneo recibido', {
        doorId: cfg.doorId,
        readerId: cfg.readerId,
        reason,
        pretty: pretty.slice(0, 160),
        hex: hex.slice(0, 120),
        preview: text.slice(0, 80)
      });

      let res;
      let usedOffline = false;
      let usedLocalFirst = false;

      if (canDecideLocalFirst(cfg, cachedAllowlist)) {
        const localResult = await decideFromCache(text, {
          denyIfStale: false,
          label: 'local-first'
        });
        if (localResult) {
          usedLocalFirst = true;
          usedOffline = true;
          res = { status: 200, data: localResult };
        }
      }

      if (!res) {
        if (cfg.offlineCache) {
          try {
            res = await api.kioskScan(text);
          } catch (err) {
            if (isNetworkError(err)) {
              log(cfg, 'warn', 'kiosk-scan sin red â€” modo offline', { error: err.message });
              const offlineResult = await decideOffline(text);
              usedOffline = true;
              res = { status: 200, data: offlineResult };
            } else {
              throw err;
            }
          }
        } else {
          res = await api.withNetworkRetry(
            () => api.kioskScan(text),
            'kiosk-scan'
          );
        }
      }

      const data = res.data || {};
      const elapsedMs = Date.now() - t0;
      const level = data.authorized ? 'info' : 'warn';
      const resultLabel = usedLocalFirst
        ? 'Resultado local-first'
        : (usedOffline ? 'Resultado offline' : 'Resultado kiosk-scan');
      log(cfg, level, resultLabel, {
        doorId: cfg.doorId,
        status: res.status,
        authorized: data.authorized,
        ok: data.ok,
        movementType: data.movementType,
        message: data.message,
        relayMode: data.relayMode || 'cloud',
        relayTriggered: data.relayTriggered,
        relayError: data.relayError || null,
        offline: Boolean(data.offline || usedOffline),
        localFirst: usedLocalFirst,
        elapsedMs
      });

      if (data.localRelay?.host) {
        lastLocalRelay = data.localRelay;
      }

      if (!usedOffline && data.authorized && data.relayMode === 'local' && data.localRelay) {
        const tRelay = Date.now();
        try {
          const relayResult = await fireLocalRelay(cfg, data.localRelay);
          log(cfg, 'info', 'RelÃ© local disparado (sin tÃºnel)', {
            ...relayResult,
            relayMs: Date.now() - tRelay
          });
        } catch (relayErr) {
          log(cfg, 'error', 'Fallo al disparar relÃ© local', {
            error: relayErr.message,
            localRelay: data.localRelay
          });
        }
      }
    } catch (err) {
      log(cfg, 'error', 'Fallo al procesar escaneo', {
        error: err.message,
        elapsedMs: Date.now() - t0
      });
    } finally {
      busy = false;
    }
  };

  const getStatus = () => ({
    doorId: cfg.doorId,
    readerId: cfg.readerId,
    serialPort: cfg.serialPort,
    connected: Boolean(serialConnected),
    lastScanAt,
    offlineCacheEnabled: Boolean(cfg.offlineCache),
    allowlistFresh: cfg.offlineCache
      ? Boolean(cachedAllowlist)
        && isAllowlistFresh(cachedAllowlist, cfg.offlineCacheMaxAgeHours)
      : null,
    allowlistGeneratedAt: cachedAllowlist?.generatedAt || null
  });

  const openLocal = async () => {
    const relay = lastLocalRelay || cachedAllowlist?.localRelay || null;
    if (!relay?.host) {
      throw new Error(
        `Sin datos de relÃ© local para ${cfg.doorId} (falta allowlist/cachÃ© con localRelay)`
      );
    }
    const result = await fireLocalRelay(cfg, relay);
    log(cfg, 'info', 'RelÃ© local disparado vÃ­a servidor de estaciÃ³n', {
      doorId: cfg.doorId,
      host: relay.host,
      channel: relay.channel
    });
    return result;
  };

  const stop = () => {
    cleanups.forEach((fn) => {
      try { fn(); } catch (_e) { /* ignore */ }
    });
  };

  if (cfg.inputMode === 'stdin') {
    const destroy = startStdinReader(cfg, handleFrame);
    cleanups.push(destroy);
    return { stop, cfg, getStatus, openLocal };
  }

  // Serie: loop en background (no bloquea otros lectores de la estaciÃ³n).
  runSerialLoop(cfg, handleFrame, shouldStop, {
    onConnected: () => { serialConnected = true; },
    onDisconnected: () => { serialConnected = false; }
  }).catch((err) => {
    log(cfg, 'error', 'Loop serie terminÃ³ con error', { error: err.message });
  });

  return { stop, cfg, getStatus, openLocal };
};

const main = async () => {
  const station = loadConfig();
  let stopping = false;
  const shouldStop = () => stopping;
  const runtimes = [];
  let localServer = null;

  log({ logFile: station.logFile }, 'info', 'door-reader-bridge estaciÃ³n iniciando', {
    bridgeVersion: BRIDGE_VERSION,
    localStationApiVersion: LOCAL_STATION_API_VERSION,
    apiBaseUrl: station.apiBaseUrl,
    readers: station.readers.length,
    configPath: station.configPath,
    localServerPort: station.localServerPort || null,
    doors: station.readers.map((r) => `${r.doorId}/${r.readerId}@${r.serialPort}`)
  });

  for (const readerCfg of station.readers) {
    const runtime = await startReaderRuntime(readerCfg, { shouldStop });
    runtimes.push(runtime);
  }

  if (station.localServerPort > 0) {
    const handlers = buildStationLocalHandlers(runtimes);
    localServer = await createLocalStationServer({
      host: station.localServerHost,
      port: station.localServerPort,
      secret: station.localServerSecret,
      getStatus: handlers.getStatus,
      openDoor: handlers.openDoor,
      logFn: (level, message, extra) => log({ logFile: station.logFile }, level, message, extra)
    });
  }

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    runtimes.forEach((rt) => {
      try { rt.stop(); } catch (_e) { /* ignore */ }
    });
    if (localServer) {
      localServer.close().catch(() => {});
    }
    log({ logFile: station.logFile }, 'info', 'Cerrando door-reader-bridgeâ€¦');
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Mantener el proceso vivo (los loops serie/stdin corren en background).
  await new Promise(() => {});
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  loadConfig,
  normalizeStationConfig,
  normalizeReaderConfig,
  createSerialFramer,
  formatChunk,
  isNetworkError,
  isAllowlistFresh,
  canDecideLocalFirst,
  findAllowlistMatch,
  extractScanIdentity,
  extractStationSecret,
  isAllowedCorsOrigin,
  buildCorsHeaders,
  createLocalStationServer,
  buildStationLocalHandlers,
  fireLocalRelay,
  BRIDGE_VERSION,
  LOCAL_STATION_API_VERSION,
  DEFAULT_CORS_ORIGINS,
  /**
   * Camino de decisiÃ³n testable (sin I/O de red real).
   * Si local-first + cachÃ© vigente â†’ no invoca kioskScanFn.
   */
  resolveScanPath: ({ cfg, allowlist, nowMs = Date.now() }) => {
    if (canDecideLocalFirst(cfg, allowlist, nowMs)) return 'local-first';
    if (cfg.offlineCache) return 'online-with-offline-fallback';
    return 'online-only';
  },
  DEFAULTS
};
