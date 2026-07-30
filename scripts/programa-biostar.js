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
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
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
    eventsLookbackHours: Number(raw.eventsLookbackHours) || 24
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
    const doCall = async () => fetch(`${apiBaseUrl}${pathSuffix}`, {
      method,
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
    importEvents: (payload) => authorized('POST', '/admin/biostar/import-events', payload)
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

  const syncUsers = async () => {
    if (syncingUsers) return;
    syncingUsers = true;
    try {
      const users = await biostar.listAllUsers({ groupId: cfg.userGroupId, pageSize: 50 });
      log('info', 'Usuarios leídos de BioStar', { count: users.length });
      const result = await mss.importUsers({
        users,
        defaultDoorId: cfg.defaultDoorId
      });
      log('info', 'Usuarios importados a MSS', {
        created: result.created,
        updated: result.updated,
        skipped: result.skipped
      });
    } catch (err) {
      log('error', 'Sync usuarios falló', { error: err.message });
    } finally {
      syncingUsers = false;
    }
  };

  const syncEvents = async () => {
    if (syncingEvents) return;
    syncingEvents = true;
    try {
      const state = loadState();
      const lookback = new Date(
        Date.now() - Math.max(1, cfg.eventsLookbackHours) * 60 * 60 * 1000
      ).toISOString();
      const since = state.lastEventDatetime || lookback;
      // Retroceder 1s para no perder el borde; MSS deduplica por id
      const sinceDate = new Date(since);
      if (!Number.isNaN(sinceDate.getTime())) {
        sinceDate.setSeconds(sinceDate.getSeconds() - 1);
      }
      const events = await biostar.searchEventsSince({
        sinceIso: sinceDate.toISOString(),
        limit: 500
      });
      if (!events.length) {
        log('info', 'Sin eventos nuevos', { since });
        return;
      }
      const result = await mss.importEvents({
        events,
        defaultDoorId: cfg.defaultDoorId,
        doorMap: cfg.doorMap,
        successEventCodes: cfg.successEventCodes,
        cursorDatetime: state.lastEventDatetime
      });
      if (result.cursorDatetime) {
        saveState({ lastEventDatetime: result.cursorDatetime });
      }
      log('info', 'Eventos importados a MSS', {
        accepted: result.accepted,
        skipped: result.skipped,
        cursor: result.cursorDatetime
      });
    } catch (err) {
      log('error', 'Sync eventos falló', { error: err.message });
    } finally {
      syncingEvents = false;
    }
  };

  await biostar.login();
  await syncUsers();
  await syncEvents();

  setInterval(() => { syncUsers().catch(() => {}); }, cfg.pollUsersMs);
  setInterval(() => { syncEvents().catch(() => {}); }, cfg.pollEventsMs);

  log('info', 'Puente en marcha', {
    pollUsersMin: Math.round(cfg.pollUsersMs / 60000),
    pollEventsSec: Math.round(cfg.pollEventsMs / 1000)
  });

  // Mantener proceso vivo
  setInterval(() => {}, 60 * 60 * 1000);
}

main().catch((err) => {
  console.error('[biostar-bridge] FATAL', err.message);
  process.exit(1);
});
