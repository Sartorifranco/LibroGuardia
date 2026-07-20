const { db, FieldValue, Timestamp } = require('../firestore');

const AUDIT_COLLECTION = 'auditLog';
const SENSITIVE_KEYS = new Set(['password', 'passwordHash', 'bridgeSecret', 'httpAuthToken', 'token']);

const sanitizeValue = (value) => {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value !== 'object') return value;
  const out = {};
  Object.keys(value).forEach((key) => {
    if (SENSITIVE_KEYS.has(key)) {
      out[key] = '[REDACTED]';
      return;
    }
    out[key] = sanitizeValue(value[key]);
  });
  return out;
};

const valuesEqual = (a, b) => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
};

/**
 * Diff superficial: solo claves de primer nivel que cambiaron.
 * Si before/after no son objetos planos, se guardan completos.
 * La comparación usa valores reales; el output se sanitiza (secrets → [REDACTED]).
 */
const shallowDiff = (before, after) => {
  if (before == null && after == null) {
    return { before: null, after: null, changedKeys: [] };
  }
  if (before == null || after == null) {
    return {
      before: before == null ? null : sanitizeValue(before),
      after: after == null ? null : sanitizeValue(after),
      changedKeys: ['*']
    };
  }
  if (
    typeof before !== 'object'
    || typeof after !== 'object'
    || Array.isArray(before)
    || Array.isArray(after)
  ) {
    return {
      before: sanitizeValue(before),
      after: sanitizeValue(after),
      changedKeys: ['*']
    };
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const beforeDiff = {};
  const afterDiff = {};
  const changedKeys = [];

  keys.forEach((key) => {
    const left = before[key];
    const right = after[key];
    if (!valuesEqual(left, right)) {
      changedKeys.push(key);
      if (Object.prototype.hasOwnProperty.call(before, key)) {
        beforeDiff[key] = SENSITIVE_KEYS.has(key) ? '[REDACTED]' : sanitizeValue(left);
      }
      if (Object.prototype.hasOwnProperty.call(after, key)) {
        afterDiff[key] = SENSITIVE_KEYS.has(key) ? '[REDACTED]' : sanitizeValue(right);
      }
    }
  });

  if (!changedKeys.length) {
    return { before: {}, after: {}, changedKeys: [] };
  }

  return { before: beforeDiff, after: afterDiff, changedKeys };
};

const extractRequestMeta = (req) => {
  if (!req) return { ip: null, userAgent: null };
  const forwarded = req.headers?.['x-forwarded-for'];
  const ip = (typeof forwarded === 'string' && forwarded.split(',')[0].trim())
    || req.ip
    || req.socket?.remoteAddress
    || null;
  const userAgent = req.headers?.['user-agent'] || null;
  return { ip, userAgent };
};

/**
 * Registra una acción administrativa en la colección auditLog.
 * No debe romper el flujo de negocio: los callers pueden usar .catch().
 */
const logAdminAction = async ({
  actorId = null,
  actorUsername = null,
  action,
  targetType = null,
  targetId = null,
  before = null,
  after = null,
  req = null
} = {}) => {
  if (!action) return null;

  const user = req?.user || {};
  const { ip, userAgent } = extractRequestMeta(req);
  const { before: beforeDiff, after: afterDiff, changedKeys } = shallowDiff(before, after);

  const payload = {
    actorId: String(actorId || user.id || '').trim() || null,
    actorUsername: String(actorUsername || user.username || user.id || '').trim() || null,
    action: String(action).trim(),
    targetType: targetType ? String(targetType).trim() : null,
    targetId: targetId != null ? String(targetId) : null,
    before: beforeDiff,
    after: afterDiff,
    changedKeys,
    ip,
    userAgent,
    createdAt: FieldValue.serverTimestamp()
  };

  const ref = await db.collection(AUDIT_COLLECTION).add(payload);

  // Notificaciones de cambios admin sensibles — centralizado aquí (no en cada endpoint).
  try {
    const { onAdminAuditLogged } = require('./notifications');
    onAdminAuditLogged({ id: ref.id, ...payload });
  } catch (err) {
    console.error('[auditLog] notify hook', err.message);
  }

  return { id: ref.id, ...payload };
};

const toIso = (value) => {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return value;
};

const parseDateBound = (value, endOfDay = false) => {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const date = new Date(raw.includes('T') ? raw : `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`);
  if (Number.isNaN(date.getTime())) return null;
  return Timestamp.fromDate(date);
};

/**
 * Listado paginado (más reciente primero) con filtros opcionales.
 * Filtros actorId/action se aplican en memoria tras orderBy createdAt para evitar
 * índices compuestos obligatorios en la primera versión.
 */
const listAuditLog = async ({
  limit = 50,
  actorId = '',
  action = '',
  from = '',
  to = '',
  startAfter = null
} = {}) => {
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const actorFilter = String(actorId || '').trim();
  const actionFilter = String(action || '').trim();
  const fromTs = parseDateBound(from, false);
  const toTs = parseDateBound(to, true);

  let query = db.collection(AUDIT_COLLECTION).orderBy('createdAt', 'desc');
  if (fromTs) query = query.where('createdAt', '>=', fromTs);
  if (toTs) query = query.where('createdAt', '<=', toTs);
  if (startAfter) {
    const cursorSnap = await db.collection(AUDIT_COLLECTION).doc(String(startAfter)).get();
    if (cursorSnap.exists) query = query.startAfter(cursorSnap);
  }

  // Si hay filtros de actor/action, pedimos un poco más y filtramos en memoria.
  const fetchLimit = (actorFilter || actionFilter) ? Math.min(pageSize * 5, 250) : pageSize;
  const snap = await query.limit(fetchLimit).get();

  let items = snap.docs.map((doc) => {
    const data = doc.data() || {};
    return {
      id: doc.id,
      actorId: data.actorId || null,
      actorUsername: data.actorUsername || null,
      action: data.action || '',
      targetType: data.targetType || null,
      targetId: data.targetId || null,
      before: data.before ?? null,
      after: data.after ?? null,
      changedKeys: Array.isArray(data.changedKeys) ? data.changedKeys : [],
      ip: data.ip || null,
      userAgent: data.userAgent || null,
      createdAt: toIso(data.createdAt)
    };
  });

  if (actorFilter) items = items.filter((item) => item.actorId === actorFilter);
  if (actionFilter) items = items.filter((item) => item.action === actionFilter);

  const page = items.slice(0, pageSize);
  const nextCursor = page.length === pageSize ? page[page.length - 1].id : null;

  return { items: page, nextCursor };
};

module.exports = {
  AUDIT_COLLECTION,
  shallowDiff,
  sanitizeValue,
  logAdminAction,
  listAuditLog
};
