/**
 * Puente BioStar 2 → MSS Guard.
 * Corre en la PC/servidor de Bacar (misma red que http://192.168.0.9:5001).
 *
 * - Renueva sesión BioStar solo cuando caduca (401).
 * - Importa usuarios (ID biométrico = user_id BioStar).
 * - Importa eventos de acceso al historial MSS.
 *
 * Uso:
 *   1) Copiá configuracion-biostar.ejemplo.json → configuracion-biostar.json
 *   2) Completá claves BioStar + MSS
 *   3) node programa-biostar.js
 *   o 04-arrancar-puente-biostar.cmd
 */

const fs = require('fs');
const path = require('path');
const { createBioStarClient } = require('./lib/biostarClient');
const { writeJsonFileAtomic } = require('./lib/atomicJson');
const { installFatalHandlers } = require('./lib/fatalHandlers');
const os = require('os');
const {
  DEFAULT_EVENTS_BATCH_SIZE,
  DEFAULT_EVENTS_FETCH_LIMIT,
  DEFAULT_EVENTS_MAX_ROUNDS,
  createSyncHealth,
  buildHeartbeatPayload,
  runEventSync,
  runUserSync
} = require('./lib/biostarEventSync');

const BRIDGE_VERSION = '2026.10-lotes';
const MSS_TIMEOUT_MS = 90 * 1000;

const CONFIG_CANDIDATES = [
  path.join(__dirname, 'configuracion-biostar.json'),
  path.join(process.cwd(), 'configuracion-biostar.json')
];

const STATE_FILE = path.join(__dirname, 'biostar-state.json');

const readJson = (file, fallback = null) => {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const writeJson = (file, data) => {
  writeJsonFileAtomic(file, data);
};

const loadConfig = () => {
  const file = CONFIG_CANDIDATES.find((p) => fs.existsSync(p));
  if (!file) {
    throw new Error(
      'Falta configuracion-biostar.json. Copiá configuracion-biostar.ejemplo.json y completá los datos.'
    );
  }
  const raw = readJson(file, {});
  const cfg = {
    biostarBaseUrl: String(raw.biostarBaseUrl || 'http://192.168.0.9:5001').replace(/\/$/, ''),
    biostarLoginId: String(raw.biostarLoginId || '').trim(),
    biostarPassword: String(raw.biostarPassword || ''),
    mssApiBaseUrl: String(raw.mssApiBaseUrl || 'https://mss-guard.web.app/api').replace(/\/$/, ''),
    mssUsername: String(raw.mssUsername || '').trim(),
    mssPassword: String(raw.mssPassword || ''),
    userGroupId: String(raw.userGroupId || '1'),
    defaultDoorId: String(raw.defaultDoorId || '').trim(),
    doorMap: raw.doorMap && typeof raw.doorMap === 'object' ? raw.doorMap : {},
    successEventCodes: Array.isArray(raw.successEventCodes)
      ? raw.successEventCodes.map(String)
      : ['4867', '4102'],
    pollUsersMs: Number(raw.pollUsersMs) || 15 * 60 * 1000,
    pollEventsMs: Number(raw.pollEventsMs) || 30 * 1000,
    eventsLookbackHours: Number(raw.eventsLookbackHours) || 24,
    // Lotes chicos: cada POST a MSS tiene que terminar antes del corte de 60 s de Hosting.
    eventsBatchSize: Number(raw.eventsBatchSize) || DEFAULT_EVENTS_BATCH_SIZE,
    eventsFetchLimit: Number(raw.eventsFetchLimit) || DEFAULT_EVENTS_FETCH_LIMIT,
    eventsMaxRounds: Number(raw.eventsMaxRounds) || DEFAULT_EVENTS_MAX_ROUNDS,
    usersBatchSize: Number(raw.usersBatchSize) || DEFAULT_EVENTS_BATCH_SIZE,
    // Opcional: { "<device_id BioStar>": { doorId, direction: 'ingreso'|'egreso' } }
    devices: raw.devices && typeof raw.devices === 'object' && !Array.isArray(raw.devices) ? raw.devices : {}
  };
  if (!cfg.biostarLoginId || !cfg.biostarPassword) {
    throw new Error('configuracion-biostar.json: faltan biostarLoginId / biostarPassword');
  }
  if (!cfg.mssUsername || !cfg.mssPassword) {
    throw new Error('configuracion-biostar.json: faltan mssUsername / mssPassword');
  }
  if (!cfg.defaultDoorId) {
    throw new Error('configuracion-biostar.json: faltá defaultDoorId (ej. puerta-p1)');
  }
  return { cfg, file };
};

const log = (level, message, extra) => {
  const line = `[biostar-bridge] ${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  if (extra) console.log(line, JSON.stringify(extra));
  else console.log(line);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const createMssClient = ({ apiBaseUrl, username, password }) => {
  let token = null;

  const login = async () => {
    const res = await fetch(`${apiBaseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) {
      throw new Error(data.message || `Login MSS falló (${res.status})`);
    }
    token = data.token;
    return token;
  };

  const authorized = async (method, pathSuffix, body) => {
    if (!token) await login();
    // Sin timeout, un POST colgado dejaba la sync trabada para siempre.
    const doCall = async () => fetch(`${apiBaseUrl}${pathSuffix}`, {
      method,
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(MSS_TIMEOUT_MS)
        : undefined,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let res = await doCall();
    if (res.status === 401) {
      await login();
      res = await doCall();
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || `MSS ${method} ${pathSuffix} → ${res.status}`);
    }
    return data;
  };

  return {
    importUsers: (payload) => authorized('POST', '/admin/biostar/import-users', payload),
    importEvents: (payload) => authorized('POST', '/admin/biostar/import-events', payload),
    heartbeat: (payload) => authorized('POST', '/admin/biostar/heartbeat', payload || {})
  };
};

const loadState = () => readJson(STATE_FILE, { lastEventDatetime: null }) || { lastEventDatetime: null };
const saveState = (state) => writeJson(STATE_FILE, state);

async function main() {
  const { cfg, file } = loadConfig();
  log('info', 'Iniciando puente BioStar → MSS', {
    config: file,
    biostar: cfg.biostarBaseUrl,
    mss: cfg.mssApiBaseUrl,
    defaultDoorId: cfg.defaultDoorId
  });

  const biostar = createBioStarClient({
    baseUrl: cfg.biostarBaseUrl,
    loginId: cfg.biostarLoginId,
    password: cfg.biostarPassword,
    log
  });
  const mss = createMssClient({
    apiBaseUrl: cfg.mssApiBaseUrl,
    username: cfg.mssUsername,
    password: cfg.mssPassword
  });

  let syncingUsers = false;
  let syncingEvents = false;
  // Estado honesto para el heartbeat: último éxito, último error, cursor y atraso.
  const health = createSyncHealth();
  health.cursor = loadState().lastEventDatetime || null;
  let lastReportedOk = null;

  const sendHeartbeat = async () => {
    try {
      await mss.heartbeat(buildHeartbeatPayload(health, {
        hostname: os.hostname(),
        biostarHost: cfg.biostarBaseUrl.replace(/^https?:\/\//, ''),
        version: BRIDGE_VERSION
      }));
    } catch (err) {
      log('warn', 'Heartbeat MSS falló', { error: err.message });
    }
  };

  /** Si la sync cambió de bien a mal (o al revés), avisar enseguida sin esperar 2 min. */
  const reportIfChanged = (ok) => {
    if (lastReportedOk === ok) return;
    lastReportedOk = ok;
    sendHeartbeat().catch(() => {});
  };

  const syncUsers = async () => {
    if (syncingUsers) return;
    syncingUsers = true;
    try {
      const users = await biostar.listAllUsers({ groupId: cfg.userGroupId, pageSize: 50 });
      log('info', 'Usuarios leídos de BioStar', { count: users.length });
      const result = await runUserSync({ users, mss, cfg, health });
      log('info', 'Usuarios importados a MSS', {
        created: result.created,
        updated: result.updated,
        skipped: result.skipped
      });
    } catch (err) {
      health.lastError = `Personas: ${err.message}`;
      health.lastErrorAt = new Date().toISOString();
      log('error', 'Sync usuarios falló', { error: err.message });
    } finally {
      syncingUsers = false;
    }
  };

  const syncEvents = async () => {
    if (syncingEvents) return;
    syncingEvents = true;
    try {
      const result = await runEventSync({
        biostar,
        mss,
        cfg,
        loadState,
        saveState,
        health,
        log
      });
      if (result.batches === 0) {
        log('info', 'Sin eventos nuevos', { since: result.cursor });
      } else {
        log('info', 'Eventos importados a MSS', {
          accepted: result.accepted,
          deviceEvents: result.deviceEvents,
          skipped: result.skipped,
          batches: result.batches,
          cursor: result.cursor,
          backlogEstimate: result.backlogEstimate
        });
      }
      reportIfChanged(true);
    } catch (err) {
      log('error', 'Sync eventos falló', {
        error: err.message,
        cursor: health.cursor,
        importadosAntesDelError: err.syncTotals?.accepted || 0
      });
      reportIfChanged(false);
    } finally {
      syncingEvents = false;
    }
  };

  await biostar.login();
  await syncUsers();
  await syncEvents();

  setInterval(() => { syncUsers().catch(() => {}); }, cfg.pollUsersMs);
  setInterval(() => { syncEvents().catch(() => {}); }, cfg.pollEventsMs);
  setInterval(() => { sendHeartbeat().catch(() => {}); }, 2 * 60 * 1000);
  sendHeartbeat().catch(() => {});

  log('info', 'Puente en marcha', {
    version: BRIDGE_VERSION,
    pollUsersMin: Math.round(cfg.pollUsersMs / 60000),
    pollEventsSec: Math.round(cfg.pollEventsMs / 1000),
    eventsBatchSize: cfg.eventsBatchSize,
    devicesMapeados: Object.keys(cfg.devices).length
  });

  // Mantener proceso vivo
  setInterval(() => {}, 60 * 60 * 1000);
}

if (require.main === module) {
  installFatalHandlers((level, message, extra) => log(level, message, extra));
  main().catch((err) => {
    console.error('[biostar-bridge] FATAL', err.message);
    process.exit(1);
  });
}
