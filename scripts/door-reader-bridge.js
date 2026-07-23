/**
 * Puente de producción (mini PC por puerta):
 *   lector GADNIC CODBAR14 (RS-232) → POST /api/access/kiosk-scan
 *
 * NO dispara el relé en local: eso lo hace Cloud Functions vía sr201-bridge + túnel
 * (triggerRelay rechaza IPs privadas sin bridgeUrl).
 *
 * Framing serie: mismo criterio validado en scripts/test-lector-rele.js
 * (buffer hasta CR / CRLF / LF, o silencio idleMs).
 *
 * Instalación (una vez):
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

// Driver SR201 (sólo usa 'net', sin Firebase) — reusado del mismo módulo que
// producción y que scripts/test-lector-rele.js (framing/TCP ya validado).
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
  /** Si la lista tiene más de N horas, no confiar y denegar offline. */
  offlineCacheMaxAgeHours: 24,
  /**
   * Con offlineCache + caché vigente: decide YA con la lista (sin kiosk-scan),
   * abre relé al instante y reporta el evento en background vía cola offline.
   */
  localFirstMode: false,
  offlineAllowlistFile: '',
  offlineQueueFile: '',
  onlineScanTimeoutMs: 12000,
  allowlistTimeoutMs: 120000
};

const CONTROL_NAMES = {
  0: 'NUL', 7: 'BEL', 8: 'BS', 9: 'TAB', 10: 'LF', 11: 'VT', 12: 'FF',
  13: 'CR', 27: 'ESC', 32: 'SPC'
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

  const env = process.env;
  const parseBool = (raw, fallback = false) => {
    if (raw === true || raw === '1' || String(raw).toLowerCase() === 'true') return true;
    if (raw === false || raw === '0' || String(raw).toLowerCase() === 'false') return false;
    return fallback;
  };

  const offlineCache = parseBool(
    env.OFFLINE_CACHE != null ? env.OFFLINE_CACHE : fileCfg.offlineCache,
    false
  );
  let localFirstMode = parseBool(
    env.LOCAL_FIRST_MODE != null ? env.LOCAL_FIRST_MODE : fileCfg.localFirstMode,
    false
  );
  if (!offlineCache) localFirstMode = false;

  const cfg = {
    serialPort: String(env.SERIAL_PORT || fileCfg.serialPort || DEFAULTS.serialPort).trim(),
    baudRate: Number(env.SERIAL_BAUD || fileCfg.baudRate || DEFAULTS.baudRate) || DEFAULTS.baudRate,
    idleMs: Number(env.IDLE_MS || fileCfg.idleMs || DEFAULTS.idleMs) || DEFAULTS.idleMs,
    apiBaseUrl: String(env.API_BASE_URL || fileCfg.apiBaseUrl || DEFAULTS.apiBaseUrl)
      .replace(/\/$/, ''),
    username: String(env.KIOSK_USERNAME || fileCfg.username || DEFAULTS.username).trim(),
    password: String(env.KIOSK_PASSWORD || fileCfg.password || DEFAULTS.password),
    doorId: String(env.DOOR_ID || fileCfg.doorId || DEFAULTS.doorId).trim(),
    readerId: String(env.READER_ID || fileCfg.readerId || DEFAULTS.readerId).trim(),
    lectorId: String(env.LECTOR_ID || fileCfg.lectorId || '').trim(),
    logFile: String(env.LOG_FILE || fileCfg.logFile || DEFAULTS.logFile).trim(),
    reconnectMinMs: Number(env.RECONNECT_MIN_MS || fileCfg.reconnectMinMs || DEFAULTS.reconnectMinMs),
    reconnectMaxMs: Number(env.RECONNECT_MAX_MS || fileCfg.reconnectMaxMs || DEFAULTS.reconnectMaxMs),
    inputMode: String(env.INPUT_MODE || fileCfg.inputMode || DEFAULTS.inputMode).trim().toLowerCase(),
    offlineCache,
    localFirstMode,
    offlineCacheRefreshMs: Number(
      env.OFFLINE_CACHE_REFRESH_MS || fileCfg.offlineCacheRefreshMs || DEFAULTS.offlineCacheRefreshMs
    ) || DEFAULTS.offlineCacheRefreshMs,
    offlineCacheMaxAgeHours: Number(
      env.OFFLINE_CACHE_MAX_AGE_HOURS || fileCfg.offlineCacheMaxAgeHours || DEFAULTS.offlineCacheMaxAgeHours
    ) || DEFAULTS.offlineCacheMaxAgeHours,
    offlineAllowlistFile: String(
      env.OFFLINE_ALLOWLIST_FILE
      || fileCfg.offlineAllowlistFile
      || path.join(path.dirname(configPath), `door-allowlist-${String(env.DOOR_ID || fileCfg.doorId || 'door').trim()}.json`)
    ).trim(),
    offlineQueueFile: String(
      env.OFFLINE_QUEUE_FILE
      || fileCfg.offlineQueueFile
      || path.join(path.dirname(configPath), `offline-queue-${String(env.DOOR_ID || fileCfg.doorId || 'door').trim()}.json`)
    ).trim(),
    onlineScanTimeoutMs: Number(
      env.ONLINE_SCAN_TIMEOUT_MS || fileCfg.onlineScanTimeoutMs || DEFAULTS.onlineScanTimeoutMs
    ) || DEFAULTS.onlineScanTimeoutMs,
    allowlistTimeoutMs: Number(
      env.ALLOWLIST_TIMEOUT_MS || fileCfg.allowlistTimeoutMs || DEFAULTS.allowlistTimeoutMs
    ) || DEFAULTS.allowlistTimeoutMs,
    configPath
  };

  if (!cfg.apiBaseUrl) {
    throw new Error('Falta apiBaseUrl (ej. https://bacarguard.web.app/api)');
  }
  if (!cfg.username || !cfg.password) {
    throw new Error('Faltan username/password del usuario kiosk de esta puerta');
  }
  if (!cfg.doorId) {
    throw new Error('Falta doorId (ID de la puerta en Admin → Puertas)');
  }
  return cfg;
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
 * MODO LOCAL: dispara el relé SR201 directo por la LAN, con los datos de
 * conexión (host/puerto/canal/pulseSeconds) que devuelve /api/access/kiosk-scan
 * cuando la puerta está en relayMode 'local'. Reusa el driver ya validado.
 *
 * No bloquea: en 'timed' el ON confirma y el OFF sigue async (mismo criterio
 * que producción), así el escaneo queda libre para la próxima lectura.
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

/** true si debe decidir con caché sin llamar a kiosk-scan (modo instantáneo). */
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
      throw new Error(res.data.message || `Login falló (${res.status})`);
    }
    token = res.data.token;
    networkBackoffMs = cfg.reconnectMinMs;
    log(cfg, 'info', 'Sesión kiosk OK', {
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
      log(cfg, 'warn', 'Token expirado o inválido (401) — re-login');
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
        log(cfg, 'warn', `${label} falló, reintento`, {
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
        'No se encontró el paquete "serialport". Ejecutá:\n'
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
        hint = ' Revisá el nombre del puerto (Administrador de dispositivos → Puertos COM).';
      }
      reject(new Error(`No se pudo abrir ${cfg.serialPort}: ${msg}.${hint}`));
      return;
    }
    resolve(port);
  });
});

/**
 * Mantiene el puerto serie abierto con reconexión y backoff.
 * Nunca termina el loop salvo shutdown.
 */
const runSerialLoop = async (cfg, onFrame, shouldStop) => {
  let backoff = cfg.reconnectMinMs;

  while (!shouldStop()) {
    let port = null;
    const framer = createSerialFramer(cfg, onFrame);

    try {
      port = await openSerialOnce(cfg);
      backoff = cfg.reconnectMinMs;
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
          resolve();
        }
      });
    } catch (err) {
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

const startStdinReader = (cfg, onFrame) => {
  const framer = createSerialFramer(cfg, onFrame);
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    framer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
  });
  log(cfg, 'info', 'Modo stdin (prueba). Pegá rawData + Enter/CR.');
  return () => framer.destroy();
};

const main = async () => {
  const cfg = loadConfig();
  const api = createApiClient(cfg);
  let stopping = false;
  const shouldStop = () => stopping;

  let cachedAllowlist = cfg.offlineCache
    ? readJsonFile(cfg.offlineAllowlistFile, null)
    : null;
  let offlineQueue = cfg.offlineCache
    ? readJsonFile(cfg.offlineQueueFile, [])
    : [];
  if (!Array.isArray(offlineQueue)) offlineQueue = [];

  const persistQueue = () => {
    if (!cfg.offlineCache) return;
    writeJsonFile(cfg.offlineQueueFile, offlineQueue);
  };

  const persistAllowlist = (data) => {
    cachedAllowlist = data;
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
      log(cfg, 'warn', `${label}: allowlist ausente o vencida — denegado`, {
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
        message: 'Sin conexión y lista local vencida o ausente. Acceso denegado.',
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
        log(cfg, 'error', `Fallo relé local (${label})`, { error: relayErr.message });
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

    // Reportar a la nube en background (misma cola / idempotencia).
    flushOfflineQueue().catch((err) => {
      log(cfg, 'warn', `Cola ${label}: sync diferido falló (reintento en heartbeat)`, {
        error: err.message
      });
    });

    return {
      authorized,
      message: authorized
        ? `${label === 'local-first' ? 'Instantáneo' : 'Offline'} OK: ${match.nombre || identity.dniNormalized}`
        : `${label === 'local-first' ? 'Instantáneo' : 'Offline'}: no autorizado en lista local`,
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

  log(cfg, 'info', 'door-reader-bridge iniciando', {
    doorId: cfg.doorId,
    readerId: cfg.readerId,
    apiBaseUrl: cfg.apiBaseUrl,
    inputMode: cfg.inputMode,
    serialPort: cfg.serialPort,
    baudRate: cfg.baudRate,
    offlineCache: cfg.offlineCache,
    localFirstMode: cfg.localFirstMode,
    configPath: cfg.configPath
  });

  await api.withNetworkRetry(() => api.login(), 'login');

  if (cfg.offlineCache) {
    try {
      await refreshAllowlist('startup');
    } catch (err) {
      log(cfg, 'warn', 'No se pudo cargar allowlist al iniciar (se usará caché en disco si hay)', {
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
  sendHeartbeat();
  const heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);

  let allowlistTimer = null;
  if (cfg.offlineCache) {
    allowlistTimer = setInterval(() => {
      refreshAllowlist('interval').catch((err) => {
        log(cfg, 'warn', 'Refresh periódico de allowlist falló', { error: err.message });
      });
    }, cfg.offlineCacheRefreshMs);
  }

  let busy = false;
  const handleFrame = async ({ text, pretty, hex, reason }) => {
    if (!text) {
      log(cfg, 'warn', 'Frame vacío tras limpiar CR/LF', { reason, pretty });
      return;
    }
    if (busy) {
      log(cfg, 'warn', 'Lectura ignorada (aún procesando la anterior)', {
        preview: text.slice(0, 80)
      });
      return;
    }

    busy = true;
    const t0 = Date.now();
    try {
      log(cfg, 'info', 'Escaneo recibido', {
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
              log(cfg, 'warn', 'kiosk-scan sin red — modo offline', { error: err.message });
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

      // MODO LOCAL online: la nube autorizó pero NO disparó el relé; lo hacemos acá.
      // (En offline/local-first, decideFromCache ya disparó el relé si correspondía.)
      if (!usedOffline && data.authorized && data.relayMode === 'local' && data.localRelay) {
        const tRelay = Date.now();
        try {
          const relayResult = await fireLocalRelay(cfg, data.localRelay);
          log(cfg, 'info', 'Relé local disparado (sin túnel)', {
            ...relayResult,
            relayMs: Date.now() - tRelay
          });
        } catch (relayErr) {
          log(cfg, 'error', 'Fallo al disparar relé local', {
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

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeatTimer);
    if (allowlistTimer) clearInterval(allowlistTimer);
    log(cfg, 'info', 'Cerrando door-reader-bridge…');
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (cfg.inputMode === 'stdin') {
    startStdinReader(cfg, handleFrame);
    return;
  }

  await runSerialLoop(cfg, handleFrame, shouldStop);
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  loadConfig,
  createSerialFramer,
  formatChunk,
  isNetworkError,
  isAllowlistFresh,
  canDecideLocalFirst,
  findAllowlistMatch,
  extractScanIdentity,
  /**
   * Camino de decisión testable (sin I/O de red real).
   * Si local-first + caché vigente → no invoca kioskScanFn.
   */
  resolveScanPath: ({ cfg, allowlist, nowMs = Date.now() }) => {
    if (canDecideLocalFirst(cfg, allowlist, nowMs)) return 'local-first';
    if (cfg.offlineCache) return 'online-with-offline-fallback';
    return 'online-only';
  },
  DEFAULTS
};
