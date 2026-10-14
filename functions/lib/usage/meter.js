'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const USAGE_CATEGORIES = [
  'gps',
  'guardia',
  'edge',
  'admin',
  'biostar',
  'compilador',
  'auth',
  'notificaciones',
  'otros'
];

const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const als = new AsyncLocalStorage();
const forceAls = new AsyncLocalStorage();

const emptyBuckets = () => ({
  reads: {},
  writes: {},
  deletes: {},
  invocations: {}
});

let mem = emptyBuckets();
let suspend = 0;
let lastFlushAt = 0;
let flushLock = null;
let forcedEnabled = null;

const isTestProcess = () => Boolean(process.env.NODE_TEST_CONTEXT)
  || process.execArgv.includes('--test')
  || process.argv.includes('--test')
  || process.argv.some((arg) => String(arg).endsWith('.test.js'));

const isUsageMeterEnabled = () => {
  const forcedNow = forceAls.getStore();
  if (forcedNow === true) return true;
  if (forcedNow === false) return false;
  if (forcedEnabled != null) return Boolean(forcedEnabled);
  if (process.env.USAGE_METER === '0') return false;
  if (isTestProcess()) return false;
  return true;
};

const runWithUsageMeter = (fn) => forceAls.run(true, fn);

const setUsageMeterEnabledForTests = (value) => {
  forcedEnabled = value == null ? null : Boolean(value);
};

const resetUsageForTests = () => {
  mem = emptyBuckets();
  lastFlushAt = 0;
  suspend = 0;
};

const currentCategory = () => als.getStore() || 'otros';

const addCount = (kind, n, category) => {
  if (!isUsageMeterEnabled() || suspend > 0) return;
  const amount = Number(n) || 0;
  if (amount <= 0) return;
  const cat = category || currentCategory();
  mem[kind][cat] = (mem[kind][cat] || 0) + amount;
};

const recordReads = (n, category) => addCount('reads', n, category);
const recordWrites = (n, category) => addCount('writes', n, category);
const recordDeletes = (n, category) => addCount('deletes', n, category);
const recordInvocations = (n, category) => addCount('invocations', n, category);

const getUsageSnapshot = () => ({
  reads: { ...mem.reads },
  writes: { ...mem.writes },
  deletes: { ...mem.deletes },
  invocations: { ...mem.invocations }
});

const takeBuckets = () => {
  const snapshot = getUsageSnapshot();
  mem = emptyBuckets();
  return snapshot;
};

const mergeBuckets = (snapshot) => {
  ['reads', 'writes', 'deletes', 'invocations'].forEach((kind) => {
    Object.entries(snapshot[kind] || {}).forEach(([cat, n]) => {
      mem[kind][cat] = (mem[kind][cat] || 0) + n;
    });
  });
};

const hasCounts = (snapshot) => ['reads', 'writes', 'deletes', 'invocations'].some(
  (kind) => Object.values(snapshot[kind] || {}).some((n) => n > 0)
);

const pacificDateKey = (now = new Date()) => {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
  return formatted.replace(/-/g, '');
};

const withUsageCategory = (category, fn) => {
  const cat = USAGE_CATEGORIES.includes(category) ? category : 'otros';
  if (!isUsageMeterEnabled()) return fn();
  return als.run(cat, () => {
    recordInvocations(1, cat);
    return fn();
  });
};

const categoryForPath = (path = '') => {
  const value = String(path || '').split('?')[0];
  if (value.startsWith('/api/edge')) return 'edge';
  if (value.startsWith('/api/guard') || value.startsWith('/api/entries')) return 'guardia';
  if (value.includes('/biostar')) return 'biostar';
  if (value.startsWith('/api/auth') || value.startsWith('/api/login') || value.startsWith('/api/public')) {
    return 'auth';
  }
  if (value.includes('fleet-gps') || value.startsWith('/api/fleet')) return 'gps';
  if (value.includes('/compiler') || value.startsWith('/api/sites')) return 'compilador';
  if (value.startsWith('/api/notifications')) return 'notificaciones';
  if (value.startsWith('/api/admin')) return 'admin';
  return 'otros';
};

const usageCategoryMiddleware = (req, res, next) => {
  if (!isUsageMeterEnabled()) return next();
  const category = categoryForPath(req.path || req.originalUrl || '');
  return als.run(category, () => {
    recordInvocations(1, category);
    res.on('finish', () => {
      flushUsage().catch((err) => {
        console.error('[usage] flush', err.message);
      });
    });
    return next();
  });
};

const buildIncrementPayload = (snapshot, FieldValue) => {
  const payload = {};
  ['reads', 'writes', 'deletes', 'invocations'].forEach((kind) => {
    const nested = {};
    Object.entries(snapshot[kind] || {}).forEach(([cat, n]) => {
      if (n > 0) nested[cat] = FieldValue.increment(n);
    });
    if (Object.keys(nested).length) payload[kind] = nested;
  });
  return payload;
};

const flushUsage = (options = {}) => {
  if (flushLock) return flushLock;
  flushLock = doFlush(options).finally(() => {
    flushLock = null;
  });
  return flushLock;
};

const doFlush = async ({ force = false, db, FieldValue, now = new Date() } = {}) => {
  if (!isUsageMeterEnabled()) return { flushed: false, reason: 'disabled' };
  const at = now instanceof Date ? now.getTime() : Date.now();
  if (!force && lastFlushAt && (at - lastFlushAt) < FLUSH_INTERVAL_MS) {
    return { flushed: false, reason: 'interval' };
  }
  if (!hasCounts(mem)) return { flushed: false, reason: 'empty' };

  const snapshot = takeBuckets();
  const cat = als.getStore() || 'otros';
  snapshot.writes[cat] = (snapshot.writes[cat] || 0) + 1;

  suspend += 1;
  try {
    const store = db && FieldValue ? { db, FieldValue } : require('../../firestore');
    const payload = buildIncrementPayload(snapshot, store.FieldValue);
    payload.updatedAt = store.FieldValue.serverTimestamp();
    const dateKey = pacificDateKey(now instanceof Date ? now : new Date(at));
    await store.db.collection('usage').doc(dateKey).set(payload, { merge: true });
    lastFlushAt = at;
    return { flushed: true, date: dateKey, counts: snapshot };
  } catch (err) {
    snapshot.writes[cat] = Math.max(0, (snapshot.writes[cat] || 0) - 1);
    if (!snapshot.writes[cat]) delete snapshot.writes[cat];
    mergeBuckets(snapshot);
    console.error('[usage] no se pudo volcar el consumo', err.message);
    return { flushed: false, reason: err.message };
  } finally {
    suspend -= 1;
  }
};

const unwrap = (ref) => (ref && typeof ref === 'object' && ref.__raw ? ref.__raw : ref);

const queryReadCount = (snap) => {
  const size = snap && typeof snap.size === 'number'
    ? snap.size
    : (Array.isArray(snap?.docs) ? snap.docs.length : 0);
  return Math.max(1, size || 0);
};

const QUERY_CHAIN = new Set([
  'where', 'orderBy', 'limit', 'limitToLast', 'offset',
  'startAfter', 'startAt', 'endBefore', 'endAt', 'select'
]);

const wrapQuery = (query) => {
  if (!query || query.__usageWrapped) return query;
  return new Proxy(query, {
    get(target, prop) {
      if (prop === '__usageWrapped') return true;
      if (prop === '__raw') return target;
      if (prop === 'get') {
        return async (...args) => {
          const snap = await target.get(...args);
          recordReads(queryReadCount(snap));
          return snap;
        };
      }
      if (QUERY_CHAIN.has(prop) && typeof target[prop] === 'function') {
        return (...args) => wrapQuery(target[prop](...args));
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
};

const wrapDoc = (ref) => {
  if (!ref || ref.__usageWrapped) return ref;
  return new Proxy(ref, {
    get(target, prop) {
      if (prop === '__usageWrapped') return true;
      if (prop === '__raw') return target;
      if (prop === 'get') {
        return async (...args) => {
          const snap = await target.get(...args);
          recordReads(1);
          return snap;
        };
      }
      if (prop === 'set' || prop === 'update' || prop === 'create') {
        return async (...args) => {
          const result = await target[prop](...args);
          recordWrites(1);
          return result;
        };
      }
      if (prop === 'delete') {
        return async (...args) => {
          const result = await target.delete(...args);
          recordDeletes(1);
          return result;
        };
      }
      if (prop === 'collection') {
        return (name) => wrapCollection(target.collection(name));
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
};

const wrapCollection = (collection) => {
  if (!collection || collection.__usageWrapped) return collection;
  return new Proxy(collection, {
    get(target, prop) {
      if (prop === '__usageWrapped') return true;
      if (prop === '__raw') return target;
      // Sin argumento = id automático: no pasar `undefined` (Firestore lo rechaza).
      if (prop === 'doc') return (...args) => wrapDoc(target.doc(...args));
      if (prop === 'add') {
        return async (data) => {
          const ref = await target.add(data);
          recordWrites(1);
          return wrapDoc(ref);
        };
      }
      if (prop === 'get') {
        return async (...args) => {
          const snap = await target.get(...args);
          recordReads(queryReadCount(snap));
          return snap;
        };
      }
      if (QUERY_CHAIN.has(prop) && typeof target[prop] === 'function') {
        return (...args) => wrapQuery(target[prop](...args));
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
};

const wrapBatch = (batch) => {
  let writes = 0;
  let deletes = 0;
  const api = {
    set(ref, data, opts) {
      writes += 1;
      batch.set(unwrap(ref), data, opts);
      return api;
    },
    update(ref, data, pre) {
      writes += 1;
      batch.update(unwrap(ref), data, pre);
      return api;
    },
    create(ref, data) {
      writes += 1;
      batch.create(unwrap(ref), data);
      return api;
    },
    delete(ref, pre) {
      deletes += 1;
      batch.delete(unwrap(ref), pre);
      return api;
    },
    async commit() {
      const result = await batch.commit();
      recordWrites(writes);
      recordDeletes(deletes);
      return result;
    }
  };
  return api;
};

const wrapRunTransaction = (db, fn) => db.runTransaction(async (tx) => {
  let writes = 0;
  let deletes = 0;
  const wrapped = {
    get: async (ref) => {
      const snap = await tx.get(unwrap(ref));
      recordReads(ref && typeof ref.get === 'function' && !ref.path && ref.where ? queryReadCount(snap) : 1);
      return snap;
    },
    set(ref, data, opts) {
      writes += 1;
      return tx.set(unwrap(ref), data, opts);
    },
    update(ref, data) {
      writes += 1;
      return tx.update(unwrap(ref), data);
    },
    create(ref, data) {
      writes += 1;
      return tx.create(unwrap(ref), data);
    },
    delete(ref) {
      deletes += 1;
      return tx.delete(unwrap(ref));
    }
  };
  const result = await fn(wrapped);
  recordWrites(writes);
  recordDeletes(deletes);
  return result;
});

const wrapFirestore = (db) => {
  if (!db || db.__usageWrapped) return db;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === '__usageWrapped') return true;
      if (prop === 'collection') return (name) => wrapCollection(target.collection(name));
      if (prop === 'doc') return (path) => wrapDoc(target.doc(path));
      if (prop === 'batch') return () => wrapBatch(target.batch());
      if (prop === 'runTransaction') return (fn) => wrapRunTransaction(target, fn);
      if (prop === 'getAll') {
        return async (...refs) => {
          const snaps = await target.getAll(...refs.map(unwrap));
          recordReads(refs.length);
          return snaps;
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
};

module.exports = {
  USAGE_CATEGORIES,
  FLUSH_INTERVAL_MS,
  isUsageMeterEnabled,
  setUsageMeterEnabledForTests,
  resetUsageForTests,
  withUsageCategory,
  categoryForPath,
  usageCategoryMiddleware,
  recordReads,
  recordWrites,
  recordDeletes,
  recordInvocations,
  getUsageSnapshot,
  flushUsage,
  wrapFirestore,
  pacificDateKey,
  runWithUsageMeter
};
