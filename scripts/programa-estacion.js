/**
 * Puente de producción (estación = uno o varios lectores en el mismo proceso):
 *   lector(es) → plugin de marca → POST /api/access/ingest
 *   (compat: mismo contrato que kiosk-scan vía normalizador en la nube)
 *
 * Formato config:
 *   - Nuevo: { apiBaseUrl, readers: [...], localServerPort?, localServerSecret? }
 *   - Legacy (retrocompat): un solo lector plano en la raíz (doorId/username/…).
 *   - Por lector: plugin = serial_dni | zkteco | hikvision | suprema | hid
 *
 * Servidor HTTP local (opcional, solo LAN — sin túnel):
 *   GET  /status          estado de todos los lectores
 *   POST /open/:doorId    dispara relé local si esta estación maneja esa puerta
 *   OPTIONS /*            preflight CORS + Private Network Access (panel guardia HTTPS)
 *   Auth: Authorization: Bearer <localServerSecret>
 *
 * Versión bridge (local station API): ver BRIDGE_VERSION / LOCAL_STATION_API_VERSION.
 *
 * Relé en modo local: SR201 (TCP) o HTTP genérico (fireLocalRelay).
 *
 * Framing serie: mismo criterio validado en scripts/test-lector-rele.js
 * (buffer hasta CR / CRLF / LF, o silencio idleMs).
 *
 * Instalación (una vez):
 *   cd scripts && npm install
 *
 * Config:
 *   copy door-reader.config.example.json door-reader.config.json
 *   (editar credenciales / doorId / puerto COM / plugin)
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
const crypto = require('crypto');
const { URL } = require('url');
const { writeJsonFileAtomic } = require('./lib/atomicJson');
const { installFatalHandlers } = require('./lib/fatalHandlers');

// Driver SR201 (sÃ³lo usa 'net', sin Firebase) â€” reusado del mismo mÃ³dulo que
// producciÃ³n y que scripts/test-lector-rele.js (framing/TCP ya validado).
const {
  sendTcpCommand,
  sendTimedPulseTcp,
  buildPulseCommand
} = require('../functions/lib/doorDrivers/sr201');

const { parseScanData, normalizeIdNumber } = require('../functions/dniParser');
const {
  resolvePluginId,
  getReaderPlugin,
  parseReaderFrame,
  toIngestBody
} = require('./lib/stationReaderPlugins');

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
  /** Plugin de marca: serial_dni (default) | zkteco | hikvision | suprema | hid */
  plugin: 'serial_dni',
  /** Modo offline opcional: cachea allowlist y decide local si cae la red. */
  offlineCache: false,
  offlineCacheRefreshMs: 15 * 60 * 1000,
  /** Si la lista tiene más de N horas, no confiar y denegar offline. */
  offlineCacheMaxAgeHours: 24,
  /**
   * Con offlineCache + cachÃ© vigente: decide YA con la lista (sin kiosk-scan),
   * abre relÃ© al instante y reporta el evento en background vÃ­a cola offline.
   */
  localFirstMode: false,
  offlineAllowlistFile: '',
  offlineQueueFile: '',
  onlineScanTimeoutMs: 12000,
  /** Hosting corta ~60s; con allowlist en lote el backend responde en segundos. */
  allowlistTimeoutMs: 90000,
  /** Puerto HTTP local (0 = deshabilitado). Solo LAN; sin tÃºnel. */
  localServerPort: 0,
  localServerHost: '0.0.0.0',
  localServerSecret: '',
  /** Tope de la cola offline. Al pasarlo se descartan primero los denegados viejos. */
  offlineQueueMax: 5000
};

/**
 * VersiÃ³n del proceso door-reader-bridge (semver de scripts).
 * Bump cuando cambie el contrato del servidor local o el framing.
 */
const BRIDGE_VERSION = '1.7.0';
/** API del servidor HTTP local (status/open/CORS). Subir si cambia el contrato. */
const LOCAL_STATION_API_VERSION = 4;
/** El servidor rechaza lotes de más de 500; enviamos de a 200. */
const OFFLINE_QUEUE_BATCH_SIZE = 200;
const DEFAULT_OFFLINE_QUEUE_MAX = 5000;
const LOGIN_RETRY_MIN_MS = 5000;
const LOGIN_RETRY_MAX_MS = 5 * 60 * 1000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_MAX_FILES = 5;
const SENSITIVE_LOG_KEYS = new Set([
  'httpAuthToken', 'secret', 'password', 'localServerSecret', 'bridgeSecret',
  'biostarPassword', 'mssPassword'
]);

/** OrÃ­genes del panel (HTTPS pÃºblico) autorizados a hablar con la estaciÃ³n LAN. */
const DEFAULT_CORS_ORIGINS = [
  'https://mss-guard.web.app',
  'https://mss-guard.firebaseapp.com'
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

const sanitizeLocalRelay = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const driver = raw.driver === 'generic_http' ? 'generic_http' : 'sr201';
  const pulseMode = raw.pulseMode === 'jog' ? 'jog' : 'timed';
  const pulseSeconds = Math.max(1, Math.min(99, Number(raw.pulseSeconds) || 3));

  if (driver === 'generic_http') {
    const httpUrl = String(raw.httpUrl || '').trim();
    if (!httpUrl) return null;
    return {
      driver,
      host: '',
      port: 0,
      channel: 1,
      pulseMode,
      pulseSeconds,
      httpUrl,
      httpMethod: String(raw.httpMethod || 'POST').toUpperCase(),
      httpAuthToken: String(raw.httpAuthToken || '')
    };
  }

  const host = String(raw.host || '').trim();
  if (!host) return null;
  return {
    driver: 'sr201',
    host,
    port: Number(raw.port) || 6722,
    channel: Number(raw.channel) === 2 ? 2 : 1,
    pulseMode,
    pulseSeconds,
    httpUrl: '',
    httpMethod: 'POST',
    httpAuthToken: ''
  };
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
    plugin: resolvePluginId(raw.plugin || raw.brand || raw.readerPlugin || shared.plugin || DEFAULTS.plugin),
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
    offlineQueueMax: Math.max(
      1,
      Number(raw.offlineQueueMax || shared.offlineQueueMax) || DEFAULT_OFFLINE_QUEUE_MAX
    ),
    // Relé opcional en config (fallback si aún no hubo allowlist/kiosk-scan).
    localRelay: sanitizeLocalRelay(raw.localRelay || raw.relay || null),
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
    offlineQueueMax: Number(env.OFFLINE_QUEUE_MAX || fileCfg.offlineQueueMax) || DEFAULT_OFFLINE_QUEUE_MAX,
    configPath: resolvedPath
  };

  let rawReaders;
  const hasStationCreds = Boolean(String(fileCfg.username || '').trim() && String(fileCfg.password || ''));
  const isStationFormat = Array.isArray(fileCfg.readers) || Boolean(String(fileCfg.estacionId || '').trim());
  if (Array.isArray(fileCfg.readers)) {
    rawReaders = fileCfg.readers;
  } else if (isStationFormat && hasStationCreds && !fileCfg.doorId) {
    rawReaders = [];
  } else {
    // Legacy: un lector plano (+ overrides por env, como hasta ahora).
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
      localRelay: fileCfg.localRelay || fileCfg.relay || null,
      logFile: env.LOG_FILE || fileCfg.logFile
    }];
  }

  const readers = rawReaders.map((r) => normalizeReaderConfig(r, shared));

  if (!apiBaseUrl) {
    throw new Error('Falta apiBaseUrl (ej. https://mss-guard.web.app/api)');
  }

  const stationUsername = String(fileCfg.username || env.STATION_USERNAME || '').trim();
  const stationPassword = String(fileCfg.password || env.STATION_PASSWORD || '');
  const estacionId = String(fileCfg.estacionId || env.ESTACION_ID || '').trim();

  if (readers.length === 0) {
    if (!stationUsername || !stationPassword) {
      throw new Error(
        'Estación sin lectores: faltan username/password de la máquina '
        + '(código de instalación de la estación en Admin → Estaciones)'
      );
    }
  } else {
    readers.forEach((r, idx) => {
      if (!r.username || !r.password) {
        throw new Error(`Lector[${idx}]: faltan username/password del usuario kiosk`);
      }
      if (!r.doorId) {
        throw new Error(`Lector[${idx}]: falta doorId`);
      }
    });
  }

  const stdinCount = readers.filter((r) => r.inputMode === 'stdin').length;
  if (stdinCount > 1) {
    throw new Error('Solo un lector puede usar inputMode "stdin" por estación');
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
    estacionId,
    stationUsername: stationUsername || (readers[0] && readers[0].username) || '',
    stationPassword: stationPassword || (readers[0] && readers[0].password) || '',
    configVersion: Number(fileCfg.configVersion) || 0,
    readers
  };
};

const loadConfig = () => {
  const candidates = [
    process.env.DOOR_READER_CONFIG,
    path.join(__dirname, 'configuracion-estacion.json'),
    path.join(__dirname, 'door-reader.config.json') // nombre viejo (compat)
  ].filter(Boolean);

  let configPath = candidates[0];
  let fileCfg = {};
  let found = false;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      configPath = candidate;
      fileCfg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      found = true;
      break;
    }
  }

  if (!found && process.env.DOOR_READER_CONFIG) {
    throw new Error(`No existe el archivo de config: ${process.env.DOOR_READER_CONFIG}`);
  }

  return normalizeStationConfig(fileCfg, process.env, configPath);
};

const log = (cfg, level, message, extra) => {
  const safeExtra = extra === undefined ? undefined : redactForLog(extra);
  const line = `${new Date().toISOString()} [${level}] ${message}${safeExtra ? ` ${JSON.stringify(safeExtra)}` : ''}`;
  console.log(line);
  if (cfg && cfg.logFile) {
    try {
      rotateLogFile(cfg.logFile);
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
 * MODO LOCAL: dispara el relé en planta.
 * - SR201: TCP directo (host/puerto/canal)
 * - generic_http: POST/PUT a device.httpUrl con { action, seconds }
 */
const fireLocalRelay = async (cfg, localRelay = {}) => {
  const sanitized = sanitizeLocalRelay(localRelay) || localRelay;
  const driver = sanitized.driver === 'generic_http' ? 'generic_http' : 'sr201';
  const mode = sanitized.pulseMode === 'jog' ? 'jog' : 'timed';
  const seconds = Math.max(1, Math.min(99, Number(sanitized.pulseSeconds) || 3));

  if (driver === 'generic_http') {
    const httpUrl = String(sanitized.httpUrl || '').trim();
    if (!httpUrl) {
      throw new Error('localRelay HTTP sin httpUrl');
    }
    const method = String(sanitized.httpMethod || 'POST').toUpperCase();
    const action = mode === 'timed' ? 'pulse' : 'open';
    const headers = {
      ...(sanitized.httpAuthToken
        ? { Authorization: `Bearer ${String(sanitized.httpAuthToken)}` }
        : {})
    };
    const res = await requestJson(method, httpUrl, {
      headers,
      body: method === 'GET' ? undefined : { action, seconds },
      timeoutMs: 8000
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        (res.data && res.data.message) || `Relé HTTP respondió ${res.status}`
      );
    }
    return {
      via: 'http-local',
      driver: 'generic_http',
      httpUrl,
      method,
      mode,
      seconds,
      httpStatus: res.status,
      ...(res.data || {})
    };
  }

  const host = String(sanitized.host || '').trim();
  const port = Number(sanitized.port) || 6722;
  const channel = Number(sanitized.channel) || 1;

  if (!host) {
    throw new Error('localRelay sin host (la puerta en modo local necesita IP de la placa)');
  }

  if (mode === 'timed') {
    const timed = await sendTimedPulseTcp(host, port, channel, seconds, 4000, {
      waitForComplete: false
    });
    return { via: 'tcp-local', driver: 'sr201', host, port, channel, mode, seconds, ...timed };
  }

  const command = buildPulseCommand(channel, 'jog', seconds);
  const tcp = await sendTcpCommand(host, port, command);
  return { via: 'tcp-local', driver: 'sr201', host, port, channel, mode, command, ...tcp };
};

/**
 * Sondeo liviano: ¿responde la placa de relé en la LAN?
 * No dispara el relé (SR201: comando de estado "01").
 */
const probeLocalRelay = async (localRelay = {}) => {
  const sanitized = sanitizeLocalRelay(localRelay) || localRelay;
  if (!sanitized) {
    return null;
  }
  const driver = sanitized.driver === 'generic_http' ? 'generic_http' : 'sr201';

  if (driver === 'generic_http') {
    const httpUrl = String(sanitized.httpUrl || '').trim();
    if (!httpUrl) return null;
    try {
      await requestJson('GET', httpUrl, { timeoutMs: 3000 });
      return {
        relayReachable: true,
        relayDriver: 'generic_http',
        relayHost: httpUrl
      };
    } catch (_err) {
      return {
        relayReachable: false,
        relayDriver: 'generic_http',
        relayHost: httpUrl
      };
    }
  }

  const host = String(sanitized.host || '').trim();
  const port = Number(sanitized.port) || 6722;
  if (!host) return null;
  try {
    await sendTcpCommand(host, port, '01', 2500);
    return {
      relayReachable: true,
      relayDriver: 'sr201',
      relayHost: host
    };
  } catch (_err) {
    return {
      relayReachable: false,
      relayDriver: 'sr201',
      relayHost: host
    };
  }
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

const writeJsonFile = (filePath, data) => writeJsonFileAtomic(filePath, data);

const isCredentialFailure = (err) => {
  if (!err) return false;
  if (err.credentialError) return true;
  const status = Number(err.status);
  return status === 401 || status === 403;
};

const credentialFailureMessage = (cfg = {}) => {
  const who = cfg.readerId || cfg.doorId || 'desconocido';
  return `Usuario o clave del lector ${who} incorrectos: re-vincular con 01-instalar-estacion.cmd`;
};

const nextLoginBackoffMs = (currentMs) => {
  const current = Number(currentMs);
  const base = Number.isFinite(current) && current >= LOGIN_RETRY_MIN_MS
    ? current
    : LOGIN_RETRY_MIN_MS;
  return Math.min(LOGIN_RETRY_MAX_MS, Math.floor(base * 1.8));
};

/**
 * Reintenta el login sin frenar al resto de la estación.
 * El primer espera es 5 s y crece hasta 5 min. No lanza: el caller sigue.
 */
const startBackgroundLogin = ({
  login,
  sleep: sleepFn = sleep,
  log: logFn = () => {},
  shouldStop = () => false,
  isReady = () => false,
  onState = () => {},
  labelCfg = {}
}) => {
  let stopped = false;
  let wake = null;
  let backoff = LOGIN_RETRY_MIN_MS;
  const state = { ok: false, credentialError: false, message: null, status: 0 };

  const publish = (next) => {
    Object.assign(state, next);
    try { onState({ ...state }); } catch (_err) { /* el estado igual queda en getState */ }
  };

  const cancellableSleep = async (ms) => {
    if (sleepFn !== sleep) {
      await sleepFn(ms);
      return;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  };

  const loop = (async () => {
    while (!stopped && !shouldStop()) {
      if (isReady()) {
        await cancellableSleep(LOGIN_RETRY_MIN_MS);
        continue;
      }
      try {
        await login();
        publish({ ok: true, credentialError: false, message: null, status: 200 });
        backoff = LOGIN_RETRY_MIN_MS;
      } catch (err) {
        if (stopped || shouldStop()) break;
        const credential = isCredentialFailure(err);
        const message = credential
          ? credentialFailureMessage(labelCfg)
          : (err.message || 'Login falló');
        publish({
          ok: false,
          credentialError: credential,
          message,
          status: Number(err.status) || 0
        });
        const wait = Math.max(backoff, Number(err.retryAfterMs) || 0);
        if (!credential) {
          logFn('warn', 'login falló, reintento', { error: err.message, waitMs: wait });
        }
        await cancellableSleep(wait);
        backoff = nextLoginBackoffMs(backoff);
      }
    }
  })();

  loop.catch((err) => {
    logFn('error', 'Loop de login detenido', { error: err.message });
  });

  return {
    stop: () => {
      stopped = true;
      if (wake) wake();
    },
    getState: () => ({ ...state }),
    done: loop
  };
};

const isDeniedOfflineEvent = (event) => Boolean(event) && event.authorized === false;

/**
 * Si la cola pasa el tope, tira primero los DENEGADOS más viejos.
 * Los autorizados no se tiran: si solo quedan esos, se conservan y se avisa.
 */
const applyOfflineQueueCap = (queue, max = DEFAULT_OFFLINE_QUEUE_MAX) => {
  const limit = Math.max(1, Number(max) || DEFAULT_OFFLINE_QUEUE_MAX);
  const events = Array.isArray(queue) ? [...queue] : [];
  let droppedDenied = 0;
  while (events.length > limit) {
    const idx = events.findIndex(isDeniedOfflineEvent);
    if (idx === -1) {
      return { queue: events, droppedDenied, authorizedOverflow: true };
    }
    events.splice(idx, 1);
    droppedDenied += 1;
  }
  return { queue: events, droppedDenied, authorizedOverflow: false };
};

const splitOfflineBatches = (queue, batchSize = OFFLINE_QUEUE_BATCH_SIZE) => {
  const size = Math.max(
    1,
    Math.min(OFFLINE_QUEUE_BATCH_SIZE, Number(batchSize) || OFFLINE_QUEUE_BATCH_SIZE)
  );
  const list = Array.isArray(queue) ? queue : [];
  const batches = [];
  for (let i = 0; i < list.length; i += size) {
    batches.push(list.slice(i, i + size));
  }
  return batches;
};

const maskIdNumber = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length <= 3) return digits;
  return `${'*'.repeat(digits.length - 3)}${digits.slice(-3)}`;
};

const maskDocumentDigits = (value) => String(value ?? '').replace(
  /\d{7,}/g,
  (run) => maskIdNumber(run)
);

const FRAME_LOG_KEYS = new Set(['pretty', 'hex', 'preview', 'rawData', 'raw', 'text']);

const redactForLog = (value, depth = 0, key = '') => {
  if (value == null || depth > 8) return value;
  if (typeof value === 'string') {
    return FRAME_LOG_KEYS.has(key) ? maskDocumentDigits(value) : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, depth + 1, key));
  const out = {};
  Object.entries(value).forEach(([childKey, item]) => {
    if (SENSITIVE_LOG_KEYS.has(childKey)) return;
    out[childKey] = redactForLog(item, depth + 1, childKey);
  });
  return out;
};

const summarizeScanForLog = (text, extra = {}) => {
  const identity = extractScanIdentity(text);
  return {
    ...extra,
    dni: identity.dniNormalized ? maskIdNumber(identity.dniNormalized) : undefined,
    format: identity.format
  };
};

const rotateLogFile = (
  logFile,
  {
    maxBytes = LOG_MAX_BYTES,
    keep = LOG_MAX_FILES,
    statSync = fs.statSync,
    renameSync = fs.renameSync,
    existsSync = fs.existsSync,
    unlinkSync = fs.unlinkSync
  } = {}
) => {
  let size = 0;
  try {
    size = statSync(logFile).size;
  } catch (_err) {
    return false;
  }
  if (size < maxBytes) return false;
  const oldest = `${logFile}.${keep}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let i = keep - 1; i >= 1; i -= 1) {
    const src = `${logFile}.${i}`;
    if (existsSync(src)) renameSync(src, `${logFile}.${i + 1}`);
  }
  renameSync(logFile, `${logFile}.1`);
  return true;
};

const secretsMatch = (provided, expected) => {
  const left = Buffer.from(String(provided ?? ''), 'utf8');
  const right = Buffer.from(String(expected ?? ''), 'utf8');
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
};

/** El body de /open solo puede pedir un canal. Host, puerto y URL se ignoran. */
const openRelayRequestFromBody = (body) => {
  if (!body || typeof body !== 'object') return null;
  const raw = body.localRelay || body.relay || null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const requested = Number(raw.channel);
  if (requested === 1 || requested === 2) return { channel: requested };
  return null;
};

/**
 * Usa el relé ya configurado para la puerta.
 * El canal del pedido solo vale si es el mismo que figura en esa config.
 */
const restrictOpenRelayRequest = (configured, requestRelay) => {
  const base = sanitizeLocalRelay(configured);
  if (!base) return null;
  if (!requestRelay || typeof requestRelay !== 'object') return { ...base };
  const requested = Number(requestRelay.channel);
  if ((requested === 1 || requested === 2) && requested === Number(base.channel)) {
    return { ...base, channel: requested };
  }
  return { ...base };
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

const createApiClient = (cfg, deps = {}) => {
  const doRequest = deps.requestJson || requestJson;
  const sleepFn = deps.sleep || sleep;
  let token = null;
  let networkBackoffMs = cfg.reconnectMinMs;
  let authState = { ok: false, credentialError: false, message: null, status: 0 };
  let loginInFlight = null;
  let loginLoopStop = null;

  const login = async () => {
    if (token) return token;
    if (loginInFlight) return loginInFlight;
    loginInFlight = (async () => {
      try {
        const res = await doRequest('POST', `${cfg.apiBaseUrl}/auth/login`, {
          body: { username: cfg.username, password: cfg.password }
        });
        if (res.status === 429) {
          const wait = Number(res.data.retryAfterSeconds || 15) * 1000;
          throw Object.assign(new Error(res.data.message || 'Rate limit login'), {
            retryAfterMs: wait,
            status: 429
          });
        }
        if (res.status === 401 || res.status === 403) {
          token = null;
          const message = credentialFailureMessage(cfg);
          authState = { ok: false, credentialError: true, message, status: res.status };
          log(cfg, 'error', message);
          throw Object.assign(new Error(res.data.message || message), {
            status: res.status,
            credentialError: true
          });
        }
        if (res.status < 200 || res.status >= 300 || !res.data.token) {
          token = null;
          const message = res.data.message || `Login falló (${res.status})`;
          authState = { ok: false, credentialError: false, message, status: res.status };
          throw Object.assign(new Error(message), { status: res.status });
        }
        token = res.data.token;
        networkBackoffMs = cfg.reconnectMinMs;
        authState = { ok: true, credentialError: false, message: null, status: 200 };
        log(cfg, 'info', 'Sesión kiosk OK', {
          username: cfg.username,
          expiresIn: '8h'
        });
        return token;
      } catch (err) {
        if (!authState.credentialError && !token) {
          authState = {
            ok: false,
            credentialError: isCredentialFailure(err),
            message: isCredentialFailure(err) ? credentialFailureMessage(cfg) : (err.message || 'Login falló'),
            status: Number(err.status) || 0
          };
        }
        throw err;
      } finally {
        loginInFlight = null;
      }
    })();
    return loginInFlight;
  };

  const ensureToken = async () => {
    if (token) return token;
    if (authState.credentialError) {
      throw Object.assign(new Error(authState.message || credentialFailureMessage(cfg)), {
        status: authState.status || 401,
        credentialError: true
      });
    }
    return login();
  };

  const authorizedRequest = async (method, pathSuffix, { body, timeoutMs } = {}) => {
    const doCall = async () => {
      const bearer = await ensureToken();
      return doRequest(method, `${cfg.apiBaseUrl}${pathSuffix}`, {
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

  /** Contrato unificado multi-hardware (pref. sobre kiosk-scan). */
  const accessIngest = async (ingestBody, { timeoutMs } = {}) =>
    authorizedRequest('POST', '/access/ingest', {
      body: {
        ...ingestBody,
        doorId: ingestBody.doorId || cfg.doorId,
        readerId: ingestBody.readerId || cfg.readerId
      },
      timeoutMs: timeoutMs || cfg.onlineScanTimeoutMs || 25000
    });

  /**
   * Traduce frame del lector con el plugin de marca y llama a /access/ingest.
   * Fallback a kiosk-scan solo si el frame no parsea (no debería pasar).
   */
  const scanIdentity = async (rawFrame, { timeoutMs } = {}) => {
    const parsed = parseReaderFrame(cfg.plugin || 'serial_dni', rawFrame);
    const body = toIngestBody(parsed, { doorId: cfg.doorId, readerId: cfg.readerId });
    if (!body) {
      return kioskScan(rawFrame, { timeoutMs });
    }
    return accessIngest(body, { timeoutMs });
  };

  const heartbeat = async (extra = {}) =>
    authorizedRequest('POST', '/lectores/heartbeat', {
      body: {
        doorId: cfg.doorId,
        readerId: cfg.readerId,
        serialPort: cfg.serialPort,
        inputMode: cfg.inputMode,
        ...(cfg.lectorId ? { lectorId: cfg.lectorId } : {}),
        ...extra
      },
      timeoutMs: 20000
    });

  const fetchDoorAllowlist = async ({ clientVersion, clientDateBucket, force } = {}) => {
    const params = new URLSearchParams();
    if (clientVersion != null && clientVersion !== '') params.set('clientVersion', String(clientVersion));
    if (clientDateBucket) params.set('clientDateBucket', String(clientDateBucket));
    if (force) params.set('force', '1');
    const qs = params.toString();
    const path = `/access/door-allowlist/${encodeURIComponent(cfg.doorId)}${qs ? `?${qs}` : ''}`;
    return authorizedRequest('GET', path, {
      timeoutMs: cfg.allowlistTimeoutMs || 120000
    });
  };

  const postOfflineEntries = async (events) =>
    authorizedRequest('POST', '/access/offline-entries', {
      body: { events },
      timeoutMs: 60000
    });

  const claimPendingOpens = async () =>
    authorizedRequest('POST', '/lectores/claim-pending-opens', {
      body: {
        doorId: cfg.doorId,
        readerId: cfg.readerId,
        ...(cfg.lectorId ? { lectorId: cfg.lectorId } : {})
      },
      timeoutMs: 15000
    });

  const withNetworkRetry = async (fn, label) => {
    for (;;) {
      try {
        const result = await fn();
        networkBackoffMs = cfg.reconnectMinMs;
        return result;
      } catch (err) {
        if (isCredentialFailure(err)) {
          log(cfg, 'error', authState.message || credentialFailureMessage(cfg));
          throw err;
        }
        const wait = err.retryAfterMs || networkBackoffMs;
        log(cfg, 'warn', `${label} falló, reintento`, {
          error: err.message,
          waitMs: wait
        });
        await sleepFn(wait);
        networkBackoffMs = Math.min(
          cfg.reconnectMaxMs,
          Math.floor(networkBackoffMs * 1.8)
        );
      }
    }
  };

  const beginBackgroundLogin = ({ shouldStop } = {}) => {
    if (loginLoopStop) return loginLoopStop;
    const supervisor = startBackgroundLogin({
      login,
      sleep: sleepFn,
      log: (level, message, extra) => log(cfg, level, message, extra),
      shouldStop,
      isReady: () => Boolean(token),
      labelCfg: cfg,
      onState: (next) => { authState = next; }
    });
    loginLoopStop = supervisor.stop;
    return loginLoopStop;
  };

  return {
    login,
    kioskScan,
    accessIngest,
    scanIdentity,
    heartbeat,
    claimPendingOpens,
    fetchDoorAllowlist,
    postOfflineEntries,
    withNetworkRetry,
    startBackgroundLogin: beginBackgroundLogin,
    getAuthState: () => ({ ...authState })
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

const readJsonBody = (req, limitBytes = 64 * 1024) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > limitBytes) {
      reject(new Error('Body demasiado grande'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
      resolve({});
      return;
    }
    try {
      resolve(JSON.parse(raw));
    } catch (_e) {
      reject(new Error('JSON inválido en el body'));
    }
  });
  req.on('error', reject);
});

const buildLocalTestPageHtml = () => `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Estación local — prueba de apertura</title>
  <style>
    :root { color-scheme: light; font-family: Segoe UI, system-ui, sans-serif; }
    body { margin: 0; padding: 1.5rem; background: #f4f6f8; color: #1a1f2c; }
    main { max-width: 28rem; margin: 0 auto; }
    h1 { font-size: 1.25rem; margin: 0 0 .35rem; }
    p { margin: 0 0 1rem; color: #4b5563; font-size: .95rem; }
    label { display: block; font-size: .85rem; margin-bottom: .35rem; }
    input, select { width: 100%; box-sizing: border-box; padding: .55rem .7rem; margin-bottom: .85rem; border: 1px solid #c5ccd6; border-radius: 6px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
    button { width: 100%; padding: .7rem; border: 0; border-radius: 6px; background: #1d4ed8; color: #fff; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: .55; cursor: wait; }
    #doors { display: grid; gap: .55rem; margin-top: 1rem; }
    .door { padding: .75rem; background: #fff; border: 1px solid #d7dde5; border-radius: 8px; text-align: left; color: #1a1f2c; }
    .door strong { display: block; margin-bottom: .35rem; }
    #msg { margin-top: 1rem; min-height: 1.25rem; font-size: .9rem; }
    .ok { color: #047857; } .err { color: #b91c1c; }
    .hint { font-size: .8rem; color: #6b7280; margin: -.5rem 0 .85rem; }
  </style>
</head>
<body>
  <main>
    <h1>Prueba de apertura local</h1>
    <p>Abrí esta página desde la red de la planta. No uses el admin HTTPS para esta prueba.</p>
    <label for="secret">Secreto de estación</label>
    <input id="secret" type="password" autocomplete="off" placeholder="el de Admin → Estaciones" />
    <p class="hint">Se usa el relé ya configurado para la puerta. Esta página no puede cambiar la IP ni el puerto.</p>
    <label for="relayChannel">Canal (solo si es el de la configuración)</label>
    <select id="relayChannel">
      <option value="1">1</option>
      <option value="2">2</option>
    </select>
    <button type="button" id="load">1) Cargar puertas</button>
    <div id="doors"></div>
    <div id="msg"></div>
  </main>
  <script>
    const msg = document.getElementById('msg');
    const doorsEl = document.getElementById('doors');
    const secretEl = document.getElementById('secret');
    const channelEl = document.getElementById('relayChannel');
    try {
      const saved = JSON.parse(localStorage.getItem('lg.station.test') || '{}');
      if (saved.secret) secretEl.value = saved.secret;
      if (saved.channel) channelEl.value = String(saved.channel);
    } catch (_e) {}
    const persist = () => {
      try {
        localStorage.setItem('lg.station.test', JSON.stringify({
          secret: secretEl.value,
          channel: Number(channelEl.value) || 1
        }));
      } catch (_e) {}
    };
    const setMsg = (text, ok) => {
      msg.textContent = text || '';
      msg.className = ok ? 'ok' : 'err';
    };
    const authHeaders = () => ({
      Accept: 'application/json',
      Authorization: 'Bearer ' + String(secretEl.value || '').trim()
    });
    const relayBody = () => ({
      localRelay: {
        channel: Number(channelEl.value) === 2 ? 2 : 1
      }
    });
    document.getElementById('load').onclick = async () => {
      persist();
      setMsg('Consultando…', true);
      doorsEl.innerHTML = '';
      try {
        const res = await fetch('/status', { headers: authHeaders(), cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || ('HTTP ' + res.status));
        const readers = Array.isArray(data.readers) ? data.readers : [];
        const seen = new Set();
        readers.forEach((r) => {
          const id = String(r.doorId || '').trim();
          if (!id || seen.has(id)) return;
          seen.add(id);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'door';
          btn.innerHTML = '<strong>' + id + '</strong>2) Abrir ahora';
          btn.onclick = async () => {
            persist();
            const body = relayBody();
            btn.disabled = true;
            setMsg('Abriendo ' + id + '…', true);
            try {
              const openRes = await fetch('/open/' + encodeURIComponent(id), {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                cache: 'no-store'
              });
              const openData = await openRes.json().catch(() => ({}));
              if (!openRes.ok) throw new Error(openData.message || ('HTTP ' + openRes.status));
              setMsg(openData.message || ('OK: ' + id), true);
            } catch (e) {
              setMsg(e.message || String(e), false);
            } finally {
              btn.disabled = false;
            }
          };
          doorsEl.appendChild(btn);
        });
        if (!seen.size) setMsg('No hay puertas en esta estación.', false);
        else setMsg('Listo. Bridge ' + (data.bridgeVersion || '?') + ' — ahora abrí una puerta.', true);
      } catch (e) {
        setMsg(e.message || String(e), false);
      }
    };
  </script>
</body>
</html>`;

/**
 * Servidor HTTP local de la estación (solo LAN). Endpoints:
 *   GET  /                página HTML de prueba (sin Mixed Content)
 *   GET  /status
 *   POST /open/:doorId    body opcional: { localRelay: { channel } }
 *                         host, puerto y URL del body se ignoran: se usa el relé configurado
 *   OPTIONS (preflight CORS / PNA) — sin auth
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
  const handlers = {
    getStatus: opts.getStatus,
    openDoor: opts.openDoor
  };
  const logFn = opts.logFn || (() => {});
  const env = opts.env || process.env;

  if (!Number.isFinite(port) || port <= 0) {
    reject(new Error('createLocalStationServer: puerto inválido'));
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

  const sendHtml = (res, statusCode, html) => {
    res.writeHead(statusCode, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store'
    });
    res.end(html);
  };

  const requireAuth = (req, res) => {
    if (!secretsMatch(extractStationSecret(req), secret)) {
      sendJson(res, 401, { ok: false, message: 'Secreto de estación inválido' }, req);
      return false;
    }
    return true;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const method = (req.method || 'GET').toUpperCase();

      // Preflight: no exige secreto (el browser aún no manda Authorization).
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

      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/panel')) {
        sendHtml(res, 200, buildLocalTestPageHtml());
        return;
      }

      if (method === 'GET' && url.pathname === '/status') {
        if (!requireAuth(req, res)) return;
        const status = await Promise.resolve(handlers.getStatus());
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
        const body = await readJsonBody(req);
        const relayRequest = openRelayRequestFromBody(body);
        const result = await Promise.resolve(handlers.openDoor(doorId, relayRequest));
        if (result && result.notFound) {
          sendJson(res, 404, {
            ok: false,
            message: `Esta estación no maneja la puerta "${doorId}"`
          }, req);
          return;
        }
        sendJson(res, 200, {
          ok: true,
          doorId,
          message: 'Relé local disparado',
          ...(result && typeof result === 'object' ? result : {})
        }, req);
        return;
      }

      sendJson(res, 404, { ok: false, message: 'No encontrado' }, req);
    } catch (err) {
      logFn('error', 'Error en servidor local de estación', { error: err.message });
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
      setHandlers: (next = {}) => {
        if (typeof next.getStatus === 'function') handlers.getStatus = next.getStatus;
        if (typeof next.openDoor === 'function') handlers.openDoor = next.openDoor;
      },
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
    openDoor: async (doorId, relayOverride = null) => {
      const key = String(doorId || '').trim();
      const list = byDoorId.get(key);
      if (!list || list.length === 0) return { notFound: true };
      const rt = list[0];
      if (typeof rt.openLocal !== 'function') {
        throw new Error('Runtime sin openLocal');
      }
      const relay = await rt.openLocal(relayOverride);
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
const startReaderRuntime = async (cfg, options = {}) => {
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;
  const skipHardware = Boolean(options.skipHardware);
  const api = createApiClient(cfg, {
    requestJson: options.requestJson,
    sleep: options.sleep
  });
  const cleanups = [];

  let cachedAllowlist = cfg.offlineCache
    ? readJsonFile(cfg.offlineAllowlistFile, null)
    : null;
  let offlineQueue = cfg.offlineCache
    ? readJsonFile(cfg.offlineQueueFile, [])
    : [];
  if (!Array.isArray(offlineQueue)) offlineQueue = [];
  let offlineQueueWarning = null;
  const initialCap = applyOfflineQueueCap(offlineQueue, cfg.offlineQueueMax);
  offlineQueue = initialCap.queue;

  let serialConnected = cfg.inputMode === 'stdin';
  let lastScanAt = null;
  let lastLocalRelay = cachedAllowlist?.localRelay || null;

  const persistQueue = () => {
    if (!cfg.offlineCache) return;
    writeJsonFile(cfg.offlineQueueFile, offlineQueue);
  };

  const noteQueueCap = (result) => {
    const max = cfg.offlineQueueMax || DEFAULT_OFFLINE_QUEUE_MAX;
    if (result.droppedDenied > 0) {
      log(cfg, 'warn', 'Cola offline superó el tope: se descartaron accesos denegados viejos', {
        droppedDenied: result.droppedDenied,
        remaining: result.queue.length,
        max
      });
    }
    if (result.authorizedOverflow) {
      offlineQueueWarning = 'La cola supera el tope y solo quedan eventos autorizados: no se descartan.';
      log(cfg, 'warn', offlineQueueWarning, {
        remaining: result.queue.length,
        max
      });
    } else {
      offlineQueueWarning = null;
    }
  };

  if (cfg.offlineCache && (initialCap.droppedDenied > 0 || initialCap.authorizedOverflow)) {
    noteQueueCap(initialCap);
    if (initialCap.droppedDenied > 0) persistQueue();
  }

  const persistAllowlist = (data) => {
    cachedAllowlist = data;
    if (data?.localRelay?.host || data?.localRelay?.httpUrl) lastLocalRelay = data.localRelay;
    writeJsonFile(cfg.offlineAllowlistFile, data);
  };

  const enqueueOfflineEvent = (event) => {
    offlineQueue.push(event);
    const capped = applyOfflineQueueCap(offlineQueue, cfg.offlineQueueMax);
    offlineQueue = capped.queue;
    if (capped.droppedDenied > 0 || capped.authorizedOverflow) noteQueueCap(capped);
    else offlineQueueWarning = null;
    persistQueue();
  };

  const refreshAllowlist = async (reason = 'scheduled') => {
    if (!cfg.offlineCache) return false;
    const force = reason === 'startup'
      || reason === 'cloud-enable'
      || String(reason).startsWith('forceResync');
    const res = await api.fetchDoorAllowlist({
      clientVersion: force ? undefined : cachedAllowlist?.version,
      clientDateBucket: force ? undefined : cachedAllowlist?.dateBucket,
      force
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(res.data?.message || `allowlist HTTP ${res.status}`);
    }
    if (res.data?.unchanged) {
      log(cfg, 'info', 'Allowlist sin cambios (caché vigente)', {
        reason,
        version: res.data.version,
        count: res.data.count,
        dateBucket: res.data.dateBucket
      });
      return false;
    }
    persistAllowlist(res.data);
    log(cfg, 'info', 'Allowlist offline actualizada', {
      reason,
      count: res.data?.count,
      version: res.data?.version,
      generatedAt: res.data?.generatedAt,
      file: cfg.offlineAllowlistFile
    });
    return true;
  };

  const flushOfflineQueue = async () => {
    if (!cfg.offlineCache || offlineQueue.length === 0) return;
    let accepted = 0;
    let skipped = 0;
    while (offlineQueue.length > 0) {
      const batch = offlineQueue.slice(0, OFFLINE_QUEUE_BATCH_SIZE);
      const res = await api.postOfflineEntries(batch);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(res.data?.message || `offline-entries HTTP ${res.status}`);
      }
      accepted += Number(res.data?.accepted) || 0;
      skipped += Number(res.data?.skipped) || 0;
      const failed = (res.data?.results || []).filter((r) => r.status === 'error');
      if (failed.length) {
        const failedIds = new Set(failed.map((f) => f.offlineLocalId).filter(Boolean));
        const kept = batch.filter((e) => failedIds.has(e.offlineLocalId));
        offlineQueue = [...kept, ...offlineQueue.slice(batch.length)];
        persistQueue();
        log(cfg, 'warn', 'Cola offline parcialmente sincronizada', {
          accepted,
          skipped,
          remaining: offlineQueue.length
        });
        return;
      }
      offlineQueue = offlineQueue.slice(batch.length);
      persistQueue();
    }
    log(cfg, 'info', 'Cola offline sincronizada', { accepted, skipped });
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
    plugin: cfg.plugin || 'serial_dni',
    pluginBrand: getReaderPlugin(cfg.plugin).brand,
    serialPort: cfg.serialPort,
    baudRate: cfg.baudRate,
    offlineCache: cfg.offlineCache,
    localFirstMode: cfg.localFirstMode
  });

  cleanups.push(api.startBackgroundLogin({ shouldStop }));

  // No bloquear el arranque (ni el HTTP local :8787) con la allowlist.
  // Si falla, se usa la caché en disco; el timer/heartbeat reintentan.
  if (cfg.offlineCache) {
    refreshAllowlist('startup').catch((err) => {
      log(cfg, 'warn', 'No se pudo cargar allowlist al iniciar (se usarÃ¡ cachÃ© en disco si hay)', {
        error: err.message
      });
    });
  }

  const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 60 * 1000);
  // 5 s: latencia aceptable al abrir desde Admin y ~60% menos lecturas vacías
  // que el poll anterior de 2 s. Override con OPEN_POLL_MS.
  const OPEN_POLL_MS = Number(process.env.OPEN_POLL_MS || 5000);
  let allowlistTimer = null;

  const processPendingOpens = async (opens, source) => {
    const list = Array.isArray(opens) ? opens : [];
    for (const item of list) {
      const relay = sanitizeLocalRelay(item?.localRelay) || item?.localRelay || null;
      if (!relay?.host && !relay?.httpUrl) {
        log(cfg, 'warn', 'Pedido de apertura sin localRelay', { source, id: item?.id });
        continue;
      }
      try {
        const result = await fireLocalRelay(cfg, relay);
        lastLocalRelay = relay;
        log(cfg, 'info', 'Relé local por cola de admin/guardia', {
          source,
          queueId: item.id,
          driver: relay.driver || 'sr201',
          host: relay.host || null,
          httpUrl: relay.httpUrl || null,
          channel: relay.channel,
          via: result.via
        });
      } catch (err) {
        log(cfg, 'error', 'Falló apertura en cola', {
          source,
          queueId: item?.id,
          error: err.message
        });
      }
    }
  };

  const adoptOfflineFromCloud = async (cloud = {}) => {
    if (!cloud.offlineCache || cfg.offlineCache) return false;
    cfg.offlineCache = true;
    if (cloud.localFirstMode != null) cfg.localFirstMode = Boolean(cloud.localFirstMode);
    if (Number(cloud.offlineCacheRefreshMs) > 0) {
      cfg.offlineCacheRefreshMs = Number(cloud.offlineCacheRefreshMs);
    }
    if (Number(cloud.offlineCacheMaxAgeHours) > 0) {
      cfg.offlineCacheMaxAgeHours = Number(cloud.offlineCacheMaxAgeHours);
    }
    log(cfg, 'info', 'Modo offline activado desde Admin', {
      refreshMs: cfg.offlineCacheRefreshMs,
      maxAgeHours: cfg.offlineCacheMaxAgeHours
    });
    try {
      await refreshAllowlist('cloud-enable');
    } catch (syncErr) {
      log(cfg, 'warn', 'No se pudo bajar allowlist al activar offline', {
        error: syncErr.message
      });
    }
    if (!allowlistTimer) {
      allowlistTimer = setInterval(() => {
        refreshAllowlist('interval').catch((err) => {
          log(cfg, 'warn', 'Refresh periódico de allowlist falló', { error: err.message });
        });
      }, cfg.offlineCacheRefreshMs);
      cleanups.push(() => clearInterval(allowlistTimer));
    }
    return true;
  };

  const reportAllowlistToCloud = async (reason = 'report') => {
    if (!cfg.offlineCache) return;
    const report = await api.heartbeat({
      allowlistGeneratedAt: cachedAllowlist?.generatedAt || null,
      allowlistEntryCount: Array.isArray(cachedAllowlist?.entries)
        ? cachedAllowlist.entries.length
        : (Number.isFinite(Number(cachedAllowlist?.count))
          ? Number(cachedAllowlist.count)
          : null)
    });
    if (report.status < 200 || report.status >= 300) {
      log(cfg, 'warn', `No se pudo reportar allowlist (${reason})`, {
        status: report.status
      });
    }
  };

  const handleForceResync = async (reason = 'forceResync') => {
    if (!cfg.offlineCache) return false;
    await refreshAllowlist(reason);
    await reportAllowlistToCloud(reason);
    return true;
  };

  const sendHeartbeat = async () => {
    try {
      const allowlistPayload = cfg.offlineCache
        ? {
            allowlistGeneratedAt: cachedAllowlist?.generatedAt || null,
            allowlistEntryCount: Array.isArray(cachedAllowlist?.entries)
              ? cachedAllowlist.entries.length
              : (Number.isFinite(Number(cachedAllowlist?.count))
                ? Number(cachedAllowlist.count)
                : null)
          }
        : {};

      const relay = sanitizeLocalRelay(lastLocalRelay)
        || sanitizeLocalRelay(cachedAllowlist?.localRelay)
        || sanitizeLocalRelay(cfg.localRelay)
        || null;
      let relayPayload = {};
      if (relay?.host || relay?.httpUrl) {
        const probed = await probeLocalRelay(relay);
        if (probed) relayPayload = probed;
      }

      const res = await api.heartbeat({
        ...allowlistPayload,
        serialConnected: Boolean(serialConnected),
        // El poll dedicado (OPEN_POLL_MS) ya reclama aperturas; evitar doble lectura.
        claimPendingOpens: false,
        ...relayPayload
      });
      if (res.status >= 200 && res.status < 300) {
        log(cfg, 'info', 'Heartbeat OK', {
          lectorId: res.data?.lectorId,
          status: res.data?.connectionStatus,
          serialConnected: Boolean(serialConnected),
          relayReachable: relayPayload.relayReachable,
          forceResync: Boolean(res.data?.forceResync),
          allowlistGeneratedAt: allowlistPayload.allowlistGeneratedAt || null
        });

        await adoptOfflineFromCloud(res.data);

        if (cfg.offlineCache) {
          try {
            await flushOfflineQueue();
          } catch (flushErr) {
            log(cfg, 'warn', 'No se pudo vaciar cola offline', { error: flushErr.message });
          }
          if (res.data?.forceResync) {
            try {
              await handleForceResync('forceResync-heartbeat');
            } catch (syncErr) {
              log(cfg, 'warn', 'forceResync falló', { error: syncErr.message });
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
      log(cfg, 'warn', 'Heartbeat falló', { error: err.message });
    }
  };

  const pollPendingOpens = async () => {
    try {
      const res = await api.claimPendingOpens();
      if (res.status >= 200 && res.status < 300) {
        await processPendingOpens(res.data?.opens, 'poll');
        await adoptOfflineFromCloud(res.data);
        if (res.data?.forceResync) {
          try {
            await handleForceResync('forceResync-poll');
            log(cfg, 'info', 'Allowlist refrescada por Sincronizar ahora (poll ~2s)', {
              generatedAt: cachedAllowlist?.generatedAt || null,
              count: Array.isArray(cachedAllowlist?.entries)
                ? cachedAllowlist.entries.length
                : cachedAllowlist?.count
            });
          } catch (syncErr) {
            log(cfg, 'warn', 'forceResync (poll) falló', { error: syncErr.message });
          }
        }
      }
    } catch (err) {
      // Silencioso: la red puede fallar; el próximo poll reintenta.
      if (/401|403/.test(String(err.message || ''))) {
        log(cfg, 'warn', 'Poll de aperturas: auth', { error: err.message });
      }
    }
  };

  if (!skipHardware) {
    sendHeartbeat();
    const heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
    cleanups.push(() => clearInterval(heartbeatTimer));

    const openPollTimer = setInterval(pollPendingOpens, OPEN_POLL_MS);
    cleanups.push(() => clearInterval(openPollTimer));
    // Primer poll pronto (sin esperar 2s) para que el admin sienta ~1 clic.
    const firstPoll = setTimeout(() => { pollPendingOpens().catch(() => {}); }, 500);
    cleanups.push(() => clearTimeout(firstPoll));

    if (cfg.offlineCache) {
      allowlistTimer = setInterval(() => {
        refreshAllowlist('interval').catch((err) => {
          log(cfg, 'warn', 'Refresh periódico de allowlist falló', { error: err.message });
        });
      }, cfg.offlineCacheRefreshMs);
      cleanups.push(() => clearInterval(allowlistTimer));
    }
  }

  let busy = false;
  const handleFrame = async ({ text, reason }) => {
    if (!text) {
      log(cfg, 'warn', 'Frame vacío tras limpiar CR/LF', { reason });
      return;
    }
    if (busy) {
      log(cfg, 'warn', 'Lectura ignorada (aún procesando la anterior)', {
        length: text.length
      });
      return;
    }

    busy = true;
    lastScanAt = new Date().toISOString();
    const t0 = Date.now();
    try {
      log(cfg, 'info', 'Escaneo recibido', summarizeScanForLog(text, {
        doorId: cfg.doorId,
        readerId: cfg.readerId,
        reason
      }));

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
            res = await api.scanIdentity(text);
          } catch (err) {
            if (isNetworkError(err)) {
              log(cfg, 'warn', 'access/ingest sin red — modo offline', { error: err.message });
              const offlineResult = await decideOffline(text);
              usedOffline = true;
              res = { status: 200, data: offlineResult };
            } else {
              throw err;
            }
          }
        } else {
          res = await api.withNetworkRetry(
            () => api.scanIdentity(text),
            'access/ingest'
          );
        }
      }

      const data = res.data || {};
      const elapsedMs = Date.now() - t0;
      const level = data.authorized ? 'info' : 'warn';
      const resultLabel = usedLocalFirst
        ? 'Resultado local-first'
        : (usedOffline ? 'Resultado offline' : 'Resultado access/ingest');
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
        plugin: cfg.plugin || 'serial_dni',
        elapsedMs
      });

      if (data.localRelay?.host || data.localRelay?.httpUrl) {
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

  const getStatus = () => {
    const auth = typeof api.getAuthState === 'function' ? api.getAuthState() : {};
    return {
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
      allowlistGeneratedAt: cachedAllowlist?.generatedAt || null,
      offlineQueueLength: cfg.offlineCache ? offlineQueue.length : 0,
      offlineQueueWarning,
      loginOk: Boolean(auth.ok),
      loginError: auth.ok ? null : (auth.message || null),
      loginCredentialError: Boolean(auth.credentialError)
    };
  };

  const openLocal = async (requestRelay = null) => {
    const configured = sanitizeLocalRelay(lastLocalRelay)
      || sanitizeLocalRelay(cachedAllowlist?.localRelay)
      || sanitizeLocalRelay(cfg.localRelay)
      || null;
    const relay = restrictOpenRelayRequest(configured, requestRelay);
    if (!relay?.host && !relay?.httpUrl) {
      throw new Error(
        `Sin datos de relé local para ${cfg.doorId}. `
        + 'Configurá localRelay en la estación o habilitá offlineCache para cachear la allowlist.'
      );
    }
    const result = await fireLocalRelay(cfg, relay);
    log(cfg, 'info', 'Relé local disparado vía servidor de estación', {
      doorId: cfg.doorId,
      driver: relay.driver || 'sr201',
      host: relay.host || null,
      httpUrl: relay.httpUrl || null,
      channel: relay.channel,
      source: lastLocalRelay ? 'cache' : 'config'
    });
    return result;
  };

  const stop = () => {
    cleanups.forEach((fn) => {
      try { fn(); } catch (_e) { /* ignore */ }
    });
  };

  if (!skipHardware) {
    if (cfg.inputMode === 'stdin') {
      const destroy = startStdinReader(cfg, handleFrame);
      cleanups.push(destroy);
    } else {
      // Serie: loop en background (no bloquea otros lectores de la estación).
      runSerialLoop(cfg, handleFrame, shouldStop, {
        onConnected: () => { serialConnected = true; },
        onDisconnected: () => { serialConnected = false; }
      }).catch((err) => {
        log(cfg, 'error', 'Loop serie terminó con error', { error: err.message });
      });
    }
  }

  return { stop, cfg, getStatus, openLocal };
};

const readerFingerprint = (cfg = {}) => [
  cfg.lectorId || '',
  cfg.doorId || '',
  cfg.readerId || '',
  cfg.serialPort || '',
  cfg.username || '',
  cfg.offlineCache ? '1' : '0',
  cfg.localFirstMode ? '1' : '0'
].join('|');

const listDiscoveredSerialPorts = async () => {
  try {
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();
    return (ports || [])
      .map((p) => String(p.path || '').trim())
      .filter(Boolean)
      .sort();
  } catch (_err) {
    return [];
  }
};

const persistStationConfigCache = (configPath, stationMeta, cloudConfig) => {
  if (!configPath || !cloudConfig) return;
  try {
    const prev = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
      : {};
    const next = {
      ...prev,
      apiBaseUrl: cloudConfig.apiBaseUrl || prev.apiBaseUrl,
      estacionId: cloudConfig.estacionId || stationMeta.estacionId || prev.estacionId,
      configVersion: cloudConfig.configVersion != null
        ? cloudConfig.configVersion
        : prev.configVersion,
      localServerPort: cloudConfig.localServerPort != null
        ? cloudConfig.localServerPort
        : prev.localServerPort,
      localServerSecret: cloudConfig.localServerSecret || prev.localServerSecret,
      localServerHost: cloudConfig.localServerHost || prev.localServerHost || '0.0.0.0',
      username: cloudConfig.username || prev.username || stationMeta.stationUsername,
      password: cloudConfig.password || prev.password || stationMeta.stationPassword,
      readers: Array.isArray(cloudConfig.readers) ? cloudConfig.readers : (prev.readers || []),
      _meta: cloudConfig._meta || prev._meta
    };
    if (!cloudConfig.password && prev.password) next.password = prev.password;
    if (!cloudConfig.username && prev.username) next.username = prev.username;
    writeJsonFile(configPath, next);
  } catch (_err) {
    // no romper el servicio por fallo de caché
  }
};

const main = async () => {
  let station = loadConfig();
  let stopping = false;
  const shouldStop = () => stopping;
  /** @type {Array<{ stop: Function, cfg: object, fingerprint: string }>} */
  let runtimes = [];
  let localServer = null;
  let appliedVersion = Number(station.configVersion) || 0;
  const logCfg = () => ({ logFile: station.logFile });

  const rebuildLocalServerHandlers = () => {
    if (!localServer || typeof localServer.setHandlers !== 'function') {
      return;
    }
    const handlers = buildStationLocalHandlers(runtimes);
    localServer.setHandlers(handlers);
  };

  const applyReaderSet = async (readerCfgs = []) => {
    const desired = readerCfgs.map((r) => {
      const cfg = normalizeReaderConfig(r, {
        apiBaseUrl: station.apiBaseUrl,
        logFile: station.logFile,
        reconnectMinMs: station.reconnectMinMs,
        reconnectMaxMs: station.reconnectMaxMs,
        idleMs: r.idleMs,
        inputMode: r.inputMode,
        configPath: station.configPath
      });
      return { cfg, fingerprint: readerFingerprint(cfg) };
    });

    const desiredFp = new Set(desired.map((d) => d.fingerprint));
    const kept = [];
    for (const rt of runtimes) {
      if (desiredFp.has(rt.fingerprint)) {
        kept.push(rt);
      } else {
        try { rt.stop(); } catch (_e) { /* ignore */ }
        log(logCfg(), 'info', 'Lector detenido (ya no asignado o cambió)', {
          doorId: rt.cfg?.doorId,
          readerId: rt.cfg?.readerId,
          serialPort: rt.cfg?.serialPort
        });
      }
    }

    const keptFp = new Set(kept.map((r) => r.fingerprint));
    const pending = desired.filter((item) => !keptFp.has(item.fingerprint));
    const started = await Promise.all(pending.map(async (item) => {
      try {
        const runtime = await startReaderRuntime(item.cfg, { shouldStop });
        log(logCfg(), 'info', 'Lector iniciado (sync Admin)', {
          doorId: item.cfg.doorId,
          readerId: item.cfg.readerId,
          serialPort: item.cfg.serialPort
        });
        return { ...runtime, fingerprint: item.fingerprint };
      } catch (err) {
        log(logCfg(), 'error', 'No se pudo iniciar lector', {
          doorId: item.cfg.doorId,
          error: err.message
        });
        return null;
      }
    }));
    started.forEach((runtime) => {
      if (runtime) kept.push(runtime);
    });

    runtimes = kept;
    rebuildLocalServerHandlers();
  };

  log(logCfg(), 'info', 'door-reader-bridge estación iniciando', {
    bridgeVersion: BRIDGE_VERSION,
    localStationApiVersion: LOCAL_STATION_API_VERSION,
    apiBaseUrl: station.apiBaseUrl,
    estacionId: station.estacionId || null,
    readers: station.readers.length,
    configPath: station.configPath,
    localServerPort: station.localServerPort || null,
    doors: station.readers.map((r) => `${r.doorId}/${r.readerId}@${r.serialPort}`)
  });

  await applyReaderSet(station.readers);

  if (station.localServerPort > 0) {
    const handlers = buildStationLocalHandlers(runtimes);
    localServer = await createLocalStationServer({
      host: station.localServerHost,
      port: station.localServerPort,
      secret: station.localServerSecret,
      getStatus: handlers.getStatus,
      openDoor: handlers.openDoor,
      logFn: (level, message, extra) => log(logCfg(), level, message, extra)
    });
  }

  const stationLogin = async () => {
    const res = await requestJson('POST', `${station.apiBaseUrl}/auth/login`, {
      body: { username: station.stationUsername, password: station.stationPassword },
      timeoutMs: 20000
    });
    if (res.status < 200 || res.status >= 300 || !res.data?.token) {
      throw new Error(res.data?.message || `Login estación falló (${res.status})`);
    }
    return res.data.token;
  };

  const syncFromCloud = async (reason = 'poll') => {
    try {
      const token = await stationLogin();
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      const ports = await listDiscoveredSerialPorts();

      await requestJson('POST', `${station.apiBaseUrl}/estaciones/heartbeat`, {
        headers,
        body: { discoveredPorts: ports, configVersionAck: appliedVersion },
        timeoutMs: 20000
      });

      const cfgRes = await requestJson('GET', `${station.apiBaseUrl}/estaciones/runtime-config`, {
        headers,
        timeoutMs: 60000
      });
      if (cfgRes.status < 200 || cfgRes.status >= 300) {
        throw new Error(cfgRes.data?.message || `runtime-config HTTP ${cfgRes.status}`);
      }

      const payload = cfgRes.data || {};
      const cloudVersion = Number(payload.configVersion) || 0;
      const cloudConfig = payload.config || {};
      const force = Boolean(payload.forceConfigSync);

      if (!force && cloudVersion === appliedVersion) return;

      const readerRows = Array.isArray(cloudConfig.readers) ? cloudConfig.readers : [];
      const merged = readerRows.map((row) => {
        const local = station.readers.find((r) => (
          (row.lectorId && r.lectorId === row.lectorId)
          || (r.doorId === row.doorId && r.readerId === row.readerId)
        ));
        return {
          ...row,
          password: row.password || local?.password || ''
        };
      }).filter((row) => row.username && row.password && row.doorId);

      await applyReaderSet(merged);
      station = {
        ...station,
        readers: merged.map((r) => normalizeReaderConfig(r, {
          apiBaseUrl: station.apiBaseUrl,
          logFile: station.logFile,
          reconnectMinMs: station.reconnectMinMs,
          reconnectMaxMs: station.reconnectMaxMs,
          configPath: station.configPath
        })),
        configVersion: cloudVersion,
        estacionId: cloudConfig.estacionId || station.estacionId
      };
      appliedVersion = cloudVersion;
      persistStationConfigCache(station.configPath, station, {
        ...cloudConfig,
        readers: merged,
        username: station.stationUsername,
        password: station.stationPassword,
        configVersion: cloudVersion
      });

      await requestJson('POST', `${station.apiBaseUrl}/estaciones/heartbeat`, {
        headers,
        body: { discoveredPorts: ports, configVersionAck: appliedVersion },
        timeoutMs: 15000
      });

      log(logCfg(), 'info', 'Config de estación aplicada (hot-reload)', {
        reason,
        configVersion: appliedVersion,
        readers: merged.length
      });
    } catch (err) {
      log(logCfg(), 'warn', 'Sync de estación diferido', { reason, error: err.message });
    }
  };

  // Primera sync pronto; luego cada 45 s.
  setTimeout(() => { syncFromCloud('startup'); }, 3000);
  const syncTimer = setInterval(() => { syncFromCloud('interval'); }, 45 * 1000);

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(syncTimer);
    runtimes.forEach((rt) => {
      try { rt.stop(); } catch (_e) { /* ignore */ }
    });
    if (localServer) {
      localServer.close().catch(() => {});
    }
    log(logCfg(), 'info', 'Cerrando door-reader-bridge…');
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
};

if (require.main === module) {
  installFatalHandlers((level, message, extra) => {
    log({ logFile: process.env.LOG_FILE || '' }, level, message, extra);
  });
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
  sanitizeLocalRelay,
  fireLocalRelay,
  writeJsonFile,
  applyOfflineQueueCap,
  splitOfflineBatches,
  maskIdNumber,
  summarizeScanForLog,
  redactForLog,
  rotateLogFile,
  secretsMatch,
  openRelayRequestFromBody,
  restrictOpenRelayRequest,
  startBackgroundLogin,
  startReaderRuntime,
  nextLoginBackoffMs,
  credentialFailureMessage,
  isCredentialFailure,
  OFFLINE_QUEUE_BATCH_SIZE,
  DEFAULT_OFFLINE_QUEUE_MAX,
  LOGIN_RETRY_MIN_MS,
  LOGIN_RETRY_MAX_MS,
  parseReaderFrame,
  resolvePluginId,
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
