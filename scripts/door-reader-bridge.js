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
  inputMode: 'serial' // serial | stdin
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

const requestJson = (method, urlString, { headers = {}, body } = {}) =>
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
    req.setTimeout(25000, () => {
      req.destroy(new Error('Timeout de red'));
    });
    if (payload) req.write(payload);
    req.end();
  });

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

  const kioskScan = async (rawData) => {
    const doCall = async () => {
      const bearer = await ensureToken();
      return requestJson('POST', `${cfg.apiBaseUrl}/access/kiosk-scan`, {
        headers: { Authorization: `Bearer ${bearer}` },
        body: {
          rawData,
          doorId: cfg.doorId,
          readerId: cfg.readerId
        }
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

  const heartbeat = async () => {
    const doCall = async () => {
      const bearer = await ensureToken();
      return requestJson('POST', `${cfg.apiBaseUrl}/lectores/heartbeat`, {
        headers: { Authorization: `Bearer ${bearer}` },
        body: {
          doorId: cfg.doorId,
          readerId: cfg.readerId,
          ...(cfg.lectorId ? { lectorId: cfg.lectorId } : {})
        }
      });
    };

    let res = await doCall();
    if (res.status === 401) {
      token = null;
      await login();
      res = await doCall();
    }
    return res;
  };

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

  return { login, kioskScan, heartbeat, withNetworkRetry };
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

  log(cfg, 'info', 'door-reader-bridge iniciando', {
    doorId: cfg.doorId,
    readerId: cfg.readerId,
    apiBaseUrl: cfg.apiBaseUrl,
    inputMode: cfg.inputMode,
    serialPort: cfg.serialPort,
    baudRate: cfg.baudRate,
    configPath: cfg.configPath
  });

  await api.withNetworkRetry(() => api.login(), 'login');

  const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 5 * 60 * 1000);
  const sendHeartbeat = async () => {
    try {
      const res = await api.heartbeat();
      if (res.status >= 200 && res.status < 300) {
        log(cfg, 'info', 'Heartbeat OK', {
          lectorId: res.data?.lectorId,
          status: res.data?.connectionStatus
        });
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

      const res = await api.withNetworkRetry(
        () => api.kioskScan(text),
        'kiosk-scan'
      );
      const data = res.data || {};
      const elapsedMs = Date.now() - t0;
      const level = data.authorized ? 'info' : 'warn';
      log(cfg, level, 'Resultado kiosk-scan', {
        status: res.status,
        authorized: data.authorized,
        ok: data.ok,
        movementType: data.movementType,
        message: data.message,
        relayMode: data.relayMode || 'cloud',
        relayTriggered: data.relayTriggered,
        relayError: data.relayError || null,
        elapsedMs
      });

      // MODO LOCAL: la nube autorizó pero NO disparó el relé; lo hacemos acá.
      if (data.authorized && data.relayMode === 'local' && data.localRelay) {
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
  DEFAULTS
};
