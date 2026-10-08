/**
 * Caché en memoria (por instancia) de las respuestas pesadas del puesto de guardia.
 *
 * Cada pantalla de guardia abierta consulta /guard/fleet-presence, /attendance/missing,
 * /citados/today, /doors y /live-alerts cada pocos segundos; cada consulta relee
 * colecciones enteras. Con 15 s de TTL, N pantallas abiertas cuestan como una.
 *
 * - Clave: endpoint + query ordenada + alcance (scope) del usuario. Hoy estos
 *   endpoints no dependen del usuario (el permiso lo filtra el middleware antes),
 *   pero si alguno pasa a filtrar por puertas/permiso hay que pasar `scope`.
 * - Requests simultáneos con la misma clave comparten la misma promesa.
 * - Los errores no se guardan.
 */

const DEFAULT_TTL_MS = 15 * 1000;
const MAX_ENTRIES = 200;

const store = new Map(); // key → { at, value }
const inflight = new Map(); // key → Promise

const normalizeQuery = (query = {}) => {
  if (!query || typeof query !== 'object') return '';
  return Object.keys(query)
    .sort()
    .map((k) => `${k}=${Array.isArray(query[k]) ? query[k].join(',') : String(query[k])}`)
    .join('&');
};

const buildCacheKey = (endpoint, query = {}, scope = 'global') =>
  `${endpoint}?${normalizeQuery(query)}#${scope}`;

const prune = (nowMs) => {
  if (store.size < MAX_ENTRIES) return;
  for (const [key, entry] of store) {
    if (nowMs - entry.at >= entry.ttlMs) store.delete(key);
  }
  while (store.size >= MAX_ENTRIES) {
    store.delete(store.keys().next().value);
  }
};

/**
 * @param {string} key
 * @param {() => Promise<any>} producer
 * @param {{ ttlMs?: number, now?: () => number }} opts
 */
const getOrCompute = async (key, producer, { ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) => {
  const nowMs = now();
  const hit = store.get(key);
  if (hit && nowMs - hit.at < hit.ttlMs) return hit.value;
  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    try {
      const value = await producer();
      prune(now());
      store.set(key, { at: now(), ttlMs, value });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
};

/** Invalida todas las claves de un endpoint (p. ej. después de abrir una puerta). */
const invalidateGuardCache = (endpoint = null) => {
  if (!endpoint) {
    store.clear();
    return;
  }
  for (const key of [...store.keys()]) {
    if (key.startsWith(`${endpoint}?`)) store.delete(key);
  }
};

/**
 * Handler Express cacheado que responde JSON.
 * @param {string} endpoint  nombre estable (p. ej. '/api/guard/doors')
 * @param {(req) => Promise<any>} producer
 * @param {{ ttlMs?: number, scope?: (req) => string, onError: (res, err) => void }} opts
 */
const cachedGuardHandler = (endpoint, producer, { ttlMs = DEFAULT_TTL_MS, scope, onError }) =>
  async (req, res) => {
    try {
      const key = buildCacheKey(endpoint, req.query, scope ? scope(req) : 'global');
      const value = await getOrCompute(key, () => producer(req), { ttlMs });
      res.set('Cache-Control', 'private, no-store');
      res.json(value);
    } catch (err) {
      onError(res, err);
    }
  };

module.exports = {
  DEFAULT_TTL_MS,
  buildCacheKey,
  getOrCompute,
  invalidateGuardCache,
  cachedGuardHandler
};
