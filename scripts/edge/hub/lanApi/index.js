'use strict';

/**
 * Router de /api/* para la app de guardia. Lo monta lanServer.js.
 * Cualquier ruta que no esté en el contrato responde 501 EDGE_UNSUPPORTED.
 */

const { EventEmitter } = require('events');
const { clientIp, corsHeaders, sendJson, readJson } = require('./http');
const { signOperatorToken, verifyOperatorToken } = require('./jwt');
const { loadOperator, publicUser, checkPassword } = require('./operators');
const { LoginRateLimit } = require('./rateLimit');
const { listGuardDoors } = require('./doors');
const { openGuardDoor } = require('./openDoor');
const { listEntries } = require('./entries');
const { listLiveAlerts, listAlarms, ackAlarm } = require('./alarms');
const { attachSse } = require('./sse');

const CAPABILITIES = ['auth', 'doors', 'open', 'entries', 'alarms', 'live', 'scan'];

const UNSUPPORTED = { code: 'EDGE_UNSUPPORTED', message: 'Disponible solo con internet' };
const CHANGE_PASSWORD = { code: 'EDGE_UNSUPPORTED', message: 'Cambiá tu contraseña cuando haya internet' };

function runtimePayload(hub) {
  return {
    mode: 'lan',
    siteId: hub.config.siteId,
    hubId: hub.deviceId,
    configVersion: hub.configSync.configVersion(),
    cloudOnline: Boolean(hub.client && hub.client.online === true),
    capabilities: CAPABILITIES
  };
}

function bearer(req) {
  const header = req.headers.authorization || '';
  const match = String(header).match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : '';
}

function requireOperator(hub, token) {
  if (!token) return { error: { status: 401, body: { message: 'No token, autorización denegada' } } };
  const checked = verifyOperatorToken(hub.edge.db, token, hub.now());
  if (!checked.ok) {
    const message = checked.code === 'EXPIRED'
      ? 'Tu sesión expiró. Iniciá sesión de nuevo.'
      : 'Token no válido';
    return { error: { status: 401, body: { message } } };
  }
  const op = loadOperator(hub.edge.db, checked.payload.username || checked.payload.id);
  if (!op) return { error: { status: 401, body: { message: 'Token no válido' } } };
  if (Number(checked.payload.passwordVersion) !== Number(op.passwordVersion)) {
    return {
      error: {
        status: 401,
        body: { message: 'Tu sesión expiró porque la contraseña fue actualizada, iniciá sesión de nuevo' }
      }
    };
  }
  if (op.active === false) {
    return {
      error: {
        status: 401,
        body: {
          message: 'Su cuenta ha sido deshabilitada. Contacte a un administrador.',
          code: 'USER_INACTIVE'
        }
      }
    };
  }
  return { op };
}

async function login(hub, limiter, req, body) {
  const username = String((body && body.username) || '').trim().toLowerCase();
  const password = body && body.password;
  if (!username || password == null || password === '') {
    return { status: 400, body: { message: 'Usuario y contraseña son obligatorios' } };
  }
  const ip = clientIp(req);
  const blocked = limiter.check(username, ip);
  if (blocked.blocked) {
    return { status: 429, body: { message: blocked.message, code: 'LOGIN_LOCKED', retryAfterSeconds: blocked.retryAfterSeconds } };
  }
  const op = loadOperator(hub.edge.db, username);
  if (op && op.active === false) {
    return { status: 403, body: { message: 'Su cuenta ha sido deshabilitada. Contacte a un administrador.', code: 'USER_INACTIVE' } };
  }
  const ok = op ? await checkPassword(op, password) : false;
  if (!op || !ok) {
    const after = limiter.fail(username, ip);
    if (after.blocked) {
      return { status: 429, body: { message: after.message, code: 'LOGIN_LOCKED', retryAfterSeconds: after.retryAfterSeconds } };
    }
    return { status: 400, body: { message: 'Credenciales inválidas' } };
  }
  limiter.clear(username, ip);
  return { status: 200, body: { token: signOperatorToken(hub.edge.db, op, hub.now()), user: publicUser(op) } };
}

class LanApi {
  constructor(hub) {
    this.hub = hub;
    this.limiter = new LoginRateLimit(() => hub.now());
  }

  async handle(req, res) {
    const url = new URL(req.url || '/', 'http://hub.local');
    const pathname = url.pathname;
    const method = req.method || 'GET';
    const headers = corsHeaders(req);
    const fail = (status, body) => sendJson(res, status, body, headers);

    if (method === 'OPTIONS') {
      if (req.headers.origin && !headers['access-control-allow-origin']) {
        return fail(403, { message: 'Origen no permitido' });
      }
      res.writeHead(204, headers);
      res.end();
      return undefined;
    }

    if (method === 'GET' && pathname === '/api/runtime') return fail(200, runtimePayload(this.hub));

    if (pathname === '/api/auth/login') {
      if (method !== 'POST') return fail(405, { message: 'Método no permitido' });
      const body = await readJson(req);
      const out = await login(this.hub, this.limiter, req, body);
      return fail(out.status, out.body);
    }

    if (pathname === '/api/auth/me') {
      if (method !== 'GET') return fail(405, { message: 'Método no permitido' });
      const auth = requireOperator(this.hub, bearer(req));
      if (auth.error) return fail(auth.error.status, auth.error.body);
      return fail(200, { user: publicUser(auth.op) });
    }

    if (pathname === '/api/auth/change-password') {
      if (method !== 'POST') return fail(405, { message: 'Método no permitido' });
      const auth = requireOperator(this.hub, bearer(req));
      if (auth.error) return fail(auth.error.status, auth.error.body);
      await readJson(req);
      return fail(501, CHANGE_PASSWORD);
    }

    if (pathname === '/api/guard/doors') {
      if (method !== 'GET') return fail(405, { message: 'Método no permitido' });
      const auth = requireOperator(this.hub, bearer(req));
      if (auth.error) return fail(auth.error.status, auth.error.body);
      const out = listGuardDoors(this.hub, auth.op);
      return fail(out.status, out.body);
    }

    if (pathname === '/api/guard/open-door') {
      if (method !== 'POST') return fail(405, { message: 'Método no permitido' });
      const auth = requireOperator(this.hub, bearer(req));
      if (auth.error) return fail(auth.error.status, auth.error.body);
      const body = await readJson(req);
      const out = await openGuardDoor(this.hub, auth.op, body);
      return fail(out.status, out.body);
    }

    if (pathname === '/api/entries') {
      if (method !== 'GET') return fail(405, { message: 'Método no permitido' });
      const auth = requireOperator(this.hub, bearer(req));
      if (auth.error) return fail(auth.error.status, auth.error.body);
      const out = listEntries(this.hub, auth.op, url.searchParams);
      return fail(out.status, out.body);
    }

    if (pathname === '/api/guard/alarms' && method === 'GET') {
      const auth = requireOperator(this.hub, bearer(req));
      if (auth.error) return fail(auth.error.status, auth.error.body);
      const out = listAlarms(this.hub, auth.op, url.searchParams);
      return fail(out.status, out.body);
    }

    if (pathname === '/api/guard/live-alerts') {
      if (method !== 'GET') return fail(405, { message: 'Método no permitido' });
      const auth = requireOperator(this.hub, bearer(req));
      if (auth.error) return fail(auth.error.status, auth.error.body);
      const out = listLiveAlerts(this.hub, auth.op);
      return fail(out.status, out.body);
    }

    const ack = pathname.match(/^\/api\/guard\/alarms\/([^/]+)\/ack$/);
    if (ack) {
      if (method !== 'POST') return fail(405, { message: 'Método no permitido' });
      const auth = requireOperator(this.hub, bearer(req));
      if (auth.error) return fail(auth.error.status, auth.error.body);
      const body = await readJson(req);
      let alarmId = ack[1];
      try { alarmId = decodeURIComponent(alarmId); } catch (_) { /* id crudo */ }
      const out = ackAlarm(this.hub, auth.op, alarmId, body.note, { close: body.close === true });
      return fail(out.status, out.body);
    }

    if (pathname === '/api/live') {
      if (method !== 'GET') return fail(405, { message: 'Método no permitido' });
      const token = url.searchParams.get('token') || bearer(req);
      const auth = requireOperator(this.hub, token);
      if (auth.error) return fail(auth.error.status, auth.error.body);
      if (!this.hub.bus) this.hub.bus = new EventEmitter();
      attachSse(req, res, this.hub, headers);
      return undefined;
    }

    return fail(501, UNSUPPORTED);
  }
}

function createLanApi(hub) {
  if (!hub.lanApi) hub.lanApi = new LanApi(hub);
  return hub.lanApi;
}

/** Avisa por el bus cuando la nube pasa de online a offline o al revés. */
function watchCloudOnline(hub) {
  const client = hub.client;
  if (!client || !hub.bus) return;
  let value = client.online;
  let exposed = value === true;
  try {
    Object.defineProperty(client, 'online', {
      configurable: true,
      enumerable: true,
      get() { return value; },
      set(next) {
        value = next;
        const nowOnline = next === true;
        if (nowOnline !== exposed) {
          exposed = nowOnline;
          try { hub.bus.emit('runtime', { cloudOnline: nowOnline }); } catch (err) {
            hub.log.warn(`[hub] sse runtime: ${err.message}`);
          }
        }
      }
    });
  } catch (err) {
    hub.log.warn(`[hub] no se pudo observar cloudOnline: ${err.message}`);
  }
}

module.exports = {
  LanApi,
  createLanApi,
  watchCloudOnline,
  runtimePayload,
  CAPABILITIES,
  UNSUPPORTED,
  CHANGE_PASSWORD
};
