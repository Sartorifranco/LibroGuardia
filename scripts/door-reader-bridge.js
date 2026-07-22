/**
 * Puente headless: lector GADNIC (USB keyboard-wedge) → Cloud Functions kiosk-scan.
 *
 * Corre en la mini PC de CADA puerta (el USB está enchufado ahí).
 * El relé SR201 NO lo maneja este script: lo dispara el backend vía sr201-bridge
 * (un solo bridge/túnel por planta alcanza para todos los SR201 de la misma LAN).
 *
 * Captura: lectura directa de /dev/input/event* (evdev), sin X11 ni navegador.
 * Referencia de buffer/timeout: frontend useUsbScanner.js (SCAN_GAP_MS = 120).
 *
 * Uso:
 *   set DOOR_READER_CONFIG=./door-reader.config.json
 *   node scripts/door-reader-bridge.js
 *
 * Docs: docs/INSTALACION-LECTOR-PUERTA.md
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const SCAN_GAP_MS = 120;
const EVENT_SIZE = 24; // struct input_event en Linux 64-bit
const EV_KEY = 1;
const KEY_ENTER = 28;
const KEY_LEFTSHIFT = 42;
const KEY_RIGHTSHIFT = 54;

/** Mapa parcial keycode Linux → carácter (sin shift / con shift). */
const KEYMAP = {
  2: ['1', '!'], 3: ['2', '"'], 4: ['3', '#'], 5: ['4', '$'], 6: ['5', '%'],
  7: ['6', '&'], 8: ['7', '/'], 9: ['8', '('], 10: ['9', ')'], 11: ['0', '='],
  12: ['\'', '?'], 13: ['¿', '¡'],
  16: ['q', 'Q'], 17: ['w', 'W'], 18: ['e', 'E'], 19: ['r', 'R'], 20: ['t', 'T'],
  21: ['y', 'Y'], 22: ['u', 'U'], 23: ['i', 'I'], 24: ['o', 'O'], 25: ['p', 'P'],
  30: ['a', 'A'], 31: ['s', 'S'], 32: ['d', 'D'], 33: ['f', 'F'], 34: ['g', 'G'],
  35: ['h', 'H'], 36: ['j', 'J'], 37: ['k', 'K'], 38: ['l', 'L'],
  44: ['z', 'Z'], 45: ['x', 'X'], 46: ['c', 'C'], 47: ['v', 'V'], 48: ['b', 'B'],
  49: ['n', 'N'], 50: ['m', 'M'],
  51: [',', ';'], 52: ['.', ':'], 53: ['-', '_'],
  39: ['ñ', 'Ñ'],
  86: ['<', '>'],
  57: [' ', ' ']
};

const loadConfig = () => {
  const configPath = process.env.DOOR_READER_CONFIG
    || path.join(__dirname, 'door-reader.config.json');

  let fileCfg = {};
  if (fs.existsSync(configPath)) {
    fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  const cfg = {
    apiBaseUrl: String(process.env.API_BASE_URL || fileCfg.apiBaseUrl || '').replace(/\/$/, ''),
    username: String(process.env.KIOSK_USERNAME || fileCfg.username || '').trim(),
    password: String(process.env.KIOSK_PASSWORD || fileCfg.password || ''),
    doorId: String(process.env.DOOR_ID || fileCfg.doorId || '').trim(),
    readerId: String(process.env.READER_ID || fileCfg.readerId || 'default').trim(),
    inputDevice: String(process.env.INPUT_DEVICE || fileCfg.inputDevice || '').trim(),
    inputMode: String(process.env.INPUT_MODE || fileCfg.inputMode || 'evdev').trim(),
    logFile: String(process.env.LOG_FILE || fileCfg.logFile || '').trim(),
    reconnectMinMs: Number(process.env.RECONNECT_MIN_MS || fileCfg.reconnectMinMs || 2000),
    reconnectMaxMs: Number(process.env.RECONNECT_MAX_MS || fileCfg.reconnectMaxMs || 60000)
  };

  if (!cfg.apiBaseUrl) throw new Error('Falta apiBaseUrl (URL de la API, ej. https://xxx.web.app/api)');
  if (!cfg.username || !cfg.password) throw new Error('Faltan username/password del usuario kiosk');
  if (!cfg.doorId) throw new Error('Falta doorId');
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
    req.setTimeout(20000, () => {
      req.destroy(new Error('Timeout de red'));
    });
    if (payload) req.write(payload);
    req.end();
  });

const createApiClient = (cfg) => {
  let token = null;
  let loginBackoffMs = cfg.reconnectMinMs;

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
    loginBackoffMs = cfg.reconnectMinMs;
    log(cfg, 'info', 'Sesión kiosk OK', { username: cfg.username });
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
      token = null;
      await login();
      res = await doCall();
    }
    return res;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const withNetworkRetry = async (fn, label) => {
    for (;;) {
      try {
        const result = await fn();
        loginBackoffMs = cfg.reconnectMinMs;
        return result;
      } catch (err) {
        const wait = err.retryAfterMs || loginBackoffMs;
        log(cfg, 'warn', `${label} falló, reintento`, {
          error: err.message,
          waitMs: wait
        });
        await sleep(wait);
        loginBackoffMs = Math.min(cfg.reconnectMaxMs, Math.floor(loginBackoffMs * 1.8));
      }
    }
  };

  return { login, kioskScan, withNetworkRetry };
};

const createScanBuffer = (onComplete) => {
  let buffer = '';
  let lastKeyAt = 0;

  const pushChar = (ch) => {
    const now = Date.now();
    if (now - lastKeyAt > SCAN_GAP_MS) buffer = '';
    lastKeyAt = now;
    buffer += ch;
  };

  const submit = () => {
    const value = buffer.trim();
    buffer = '';
    if (value) onComplete(value);
  };

  return { pushChar, submit };
};

/**
 * Decodifica eventos evdev (KEY down) a caracteres.
 * Solo Linux. Requiere permisos de lectura sobre el device (grupo `input`).
 */
const startEvdevReader = (cfg, onScan) => {
  if (!cfg.inputDevice) {
    throw new Error('Falta inputDevice (ej. /dev/input/by-id/usb-...-event-kbd)');
  }
  if (!fs.existsSync(cfg.inputDevice)) {
    throw new Error(`No existe el dispositivo de entrada: ${cfg.inputDevice}`);
  }

  const stream = fs.createReadStream(cfg.inputDevice);
  const scan = createScanBuffer(onScan);
  let shift = false;
  let leftover = Buffer.alloc(0);

  stream.on('data', (chunk) => {
    const buf = Buffer.concat([leftover, chunk]);
    const complete = buf.length - (buf.length % EVENT_SIZE);
    leftover = buf.slice(complete);

    for (let offset = 0; offset < complete; offset += EVENT_SIZE) {
      const type = buf.readUInt16LE(offset + 16);
      const code = buf.readUInt16LE(offset + 18);
      const value = buf.readInt32LE(offset + 20);
      if (type !== EV_KEY) continue;

      if (code === KEY_LEFTSHIFT || code === KEY_RIGHTSHIFT) {
        shift = value !== 0;
        continue;
      }
      // value 1 = key down, 2 = autorepeat, 0 = up
      if (value !== 1) continue;

      if (code === KEY_ENTER) {
        scan.submit();
        continue;
      }
      const mapped = KEYMAP[code];
      if (!mapped) continue;
      scan.pushChar(shift ? mapped[1] : mapped[0]);
    }
  });

  stream.on('error', (err) => {
    log(cfg, 'error', 'Error leyendo input device', { error: err.message });
  });

  log(cfg, 'info', 'Escuchando lector evdev', { device: cfg.inputDevice });
  return () => stream.destroy();
};

/** Modo prueba sin hardware: pegá el código y Enter en la consola. */
const startStdinReader = (cfg, onScan) => {
  const scan = createScanBuffer(onScan);
  process.stdin.setEncoding('utf8');
  if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    for (const ch of String(chunk)) {
      if (ch === '\n' || ch === '\r') scan.submit();
      else if (ch.length === 1) scan.pushChar(ch);
    }
  });
  log(cfg, 'info', 'Modo stdin (prueba). Escaneá o tipeá + Enter.');
  return () => process.stdin.pause();
};

const main = async () => {
  const cfg = loadConfig();
  const api = createApiClient(cfg);

  log(cfg, 'info', 'door-reader-bridge iniciando', {
    doorId: cfg.doorId,
    readerId: cfg.readerId,
    apiBaseUrl: cfg.apiBaseUrl,
    inputMode: cfg.inputMode
  });

  await api.withNetworkRetry(() => api.login(), 'login');

  let busy = false;
  const handleScan = async (rawData) => {
    if (busy) {
      log(cfg, 'warn', 'Lectura ignorada (aún procesando la anterior)', { rawData });
      return;
    }
    busy = true;
    try {
      log(cfg, 'info', 'Escaneo recibido', { rawData: rawData.slice(0, 80) });
      const res = await api.withNetworkRetry(
        () => api.kioskScan(rawData),
        'kiosk-scan'
      );
      const data = res.data || {};
      log(cfg, data.authorized ? 'info' : 'warn', 'Resultado kiosk-scan', {
        status: res.status,
        authorized: data.authorized,
        movementType: data.movementType,
        message: data.message,
        relayTriggered: data.relayTriggered,
        relayError: data.relayError || null
      });
    } catch (err) {
      log(cfg, 'error', 'Fallo al procesar escaneo', { error: err.message });
    } finally {
      busy = false;
    }
  };

  if (cfg.inputMode === 'stdin') {
    startStdinReader(cfg, handleScan);
  } else {
    startEvdevReader(cfg, handleScan);
  }
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  loadConfig,
  createScanBuffer,
  SCAN_GAP_MS,
  KEYMAP
};
