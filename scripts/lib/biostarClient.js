/**
 * Cliente HTTP mínimo para BioStar 2 Local API.
 * Renueva bs-session-id solo cuando hace falta (401 / Login required).
 */

const DEFAULT_TIMEOUT_MS = 30000;

const requestJson = async (method, url, { headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => {
    try { controller?.abort(); } catch { /* ignore */ }
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller?.signal
    });
    let data = null;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    const sessionId = res.headers.get('bs-session-id') || null;
    return { status: res.status, ok: res.ok, data, sessionId, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
};

const createBioStarClient = ({
  baseUrl,
  loginId,
  password,
  log = () => {}
} = {}) => {
  const root = String(baseUrl || '').replace(/\/$/, '');
  let sessionId = null;

  const login = async () => {
    const res = await requestJson('POST', `${root}/api/login`, {
      body: {
        User: {
          login_id: String(loginId || '').trim(),
          password: String(password || '')
        }
      }
    });
    if (!res.ok || !res.sessionId) {
      const msg = res.data?.Response?.message || `Login BioStar falló (${res.status})`;
      throw new Error(msg);
    }
    sessionId = res.sessionId;
    log('info', 'BioStar login OK', { loginId: String(loginId || '').trim() });
    return sessionId;
  };

  const ensureSession = async () => {
    if (!sessionId) await login();
    return sessionId;
  };

  const authorized = async (method, path, { body, query } = {}) => {
    const run = async () => {
      const sid = await ensureSession();
      let url = `${root}${path.startsWith('/') ? path : `/${path}`}`;
      if (query && typeof query === 'object') {
        const qs = new URLSearchParams();
        Object.entries(query).forEach(([k, v]) => {
          if (v === undefined || v === null || v === '') return;
          qs.set(k, String(v));
        });
        const s = qs.toString();
        if (s) url += `?${s}`;
      }
      return requestJson(method, url, {
        headers: { 'bs-session-id': sid },
        body
      });
    };

    let res = await run();
    const needsRelogin = res.status === 401
      || String(res.data?.Response?.message || '').toLowerCase().includes('login required');
    if (needsRelogin) {
      sessionId = null;
      await login();
      res = await run();
    }
    return res;
  };

  const listUsersPage = async ({
    groupId = '1',
    limit = 50,
    offset = 0,
    orderBy = 'user_id:false'
  } = {}) => authorized('GET', '/api/users', {
    query: {
      group_id: groupId,
      limit,
      offset,
      order_by: orderBy
    }
  });

  const listAllUsers = async ({ groupId = '1', pageSize = 50 } = {}) => {
    const rows = [];
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const res = await listUsersPage({ groupId, limit: pageSize, offset });
      if (!res.ok) {
        throw new Error(res.data?.Response?.message || `Listar usuarios falló (${res.status})`);
      }
      const collection = res.data?.UserCollection || res.data?.userCollection || {};
      const page = Array.isArray(collection.rows) ? collection.rows : [];
      total = Number(collection.total);
      if (!Number.isFinite(total)) total = page.length;
      rows.push(...page);
      if (page.length === 0) break;
      offset += page.length;
      if (page.length < pageSize) break;
    }
    return rows;
  };

  /**
   * Eventos desde `sinceIso` (inclusive) hasta ahora.
   * operator 5 = GREATER para datetime (evita re-traer el mismo al borde).
   */
  const searchEventsSince = async ({ sinceIso, limit = 200 } = {}) => {
    const end = new Date().toISOString();
    const start = sinceIso || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const res = await authorized('POST', '/api/events/search', {
      body: {
        Query: {
          limit: Math.min(2000, Math.max(1, Number(limit) || 200)),
          conditions: [
            {
              column: 'datetime',
              operator: 3,
              values: [start, end]
            }
          ],
          orders: [{ column: 'datetime', descending: false }]
        }
      }
    });
    if (!res.ok) {
      throw new Error(res.data?.Response?.message || `Buscar eventos falló (${res.status})`);
    }
    const collection = res.data?.EventCollection || res.data?.eventCollection || {};
    return Array.isArray(collection.rows) ? collection.rows : [];
  };

  return {
    login,
    listAllUsers,
    searchEventsSince,
    getSessionId: () => sessionId
  };
};

module.exports = {
  createBioStarClient,
  requestJson
};
