'use strict';

/**
 * Firestore en memoria con contadores de lecturas/escrituras (facturación real:
 * get de documento = 1, query = max(1, docs devueltos), getAll = n, cada
 * set/update/create/delete = 1). Soporta subcolecciones, batch atómico con
 * precondiciones (lastUpdateTime / exists), FieldValue (arrayUnion, arrayRemove,
 * increment, delete, serverTimestamp) y Timestamp. Lo usan los tests del
 * compilador por sitio (siteCompiler*.test.js).
 */

class Timestamp {
  constructor(ms) { this._ms = ms; }
  static fromDate(d) { return new Timestamp(d.getTime()); }
  static fromMillis(ms) { return new Timestamp(ms); }
  static now() { return new Timestamp(Date.now()); }
  toMillis() { return this._ms; }
  toDate() { return new Date(this._ms); }
  isEqual(o) { return o instanceof Timestamp && o._ms === this._ms; }
  valueOf() { return String(this._ms).padStart(16, '0'); }
}

const SENTINEL = Symbol('fieldValue');
const FieldValue = {
  serverTimestamp: () => ({ [SENTINEL]: 'serverTimestamp' }),
  arrayUnion: (...items) => ({ [SENTINEL]: 'arrayUnion', items }),
  arrayRemove: (...items) => ({ [SENTINEL]: 'arrayRemove', items }),
  increment: (n) => ({ [SENTINEL]: 'increment', n }),
  delete: () => ({ [SENTINEL]: 'delete' })
};

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Timestamp)
  && !(v instanceof Date) && !v[SENTINEL];

const clone = (v) => {
  if (v instanceof Timestamp) return new Timestamp(v._ms);
  if (v instanceof Date) return new Timestamp(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object' && !v[SENTINEL]) {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = clone(x);
    return out;
  }
  return v;
};

const applyValue = (prev, value, nowMs) => {
  if (value && value[SENTINEL]) {
    switch (value[SENTINEL]) {
      case 'serverTimestamp': return new Timestamp(nowMs);
      case 'arrayUnion': {
        const base = Array.isArray(prev) ? prev.slice() : [];
        for (const it of value.items) if (!base.some((b) => JSON.stringify(b) === JSON.stringify(it))) base.push(clone(it));
        return base;
      }
      case 'arrayRemove': {
        const base = Array.isArray(prev) ? prev : [];
        return base.filter((b) => !value.items.some((it) => JSON.stringify(b) === JSON.stringify(it)));
      }
      case 'increment': return (Number(prev) || 0) + value.n;
      default: return undefined;
    }
  }
  return clone(value);
};

const comparable = (v) => {
  if (v instanceof Timestamp) return v._ms;
  if (v instanceof Date) return v.getTime();
  return v;
};

const createCountingFirestore = (initial = {}, { now = () => Date.now() } = {}) => {
  const docs = new Map(); // path → {data, updateTime}
  let clock = 1;
  const stats = { reads: 0, writes: 0, log: [] };
  const tick = () => new Timestamp(1e12 + (clock++));

  const countRead = (n, what) => {
    stats.reads += n;
    stats.log.push(`R${n} ${what}`);
  };
  const countWrite = (what) => {
    stats.writes += 1;
    stats.log.push(`W ${what}`);
  };

  const makeSnap = (path) => {
    const row = docs.get(path);
    const id = path.split('/').pop();
    return {
      id,
      exists: Boolean(row),
      ref: docRef(path),
      updateTime: row ? row.updateTime : undefined,
      data: () => (row ? clone(row.data) : undefined),
      get: (field) => (row ? clone(row.data[field]) : undefined)
    };
  };

  const preconditionError = (msg) => Object.assign(new Error(`FAILED_PRECONDITION: ${msg}`), { code: 9 });

  const checkPrecondition = (path, pre) => {
    if (!pre) return;
    const row = docs.get(path);
    if (pre.exists === true && !row) throw Object.assign(new Error(`NOT_FOUND ${path}`), { code: 5 });
    if (pre.exists === false && row) throw Object.assign(new Error(`ALREADY_EXISTS ${path}`), { code: 6 });
    if (pre.lastUpdateTime) {
      if (!row || !row.updateTime.isEqual(pre.lastUpdateTime)) throw preconditionError(path);
    }
  };

  const applyWrite = (op) => {
    const { kind, path, data, opts, pre } = op;
    const row = docs.get(path);
    const t = tick();
    if (kind === 'delete') {
      docs.delete(path);
    } else if (kind === 'create' || (kind === 'set' && !(opts && opts.merge))) {
      const out = {};
      for (const [k, v] of Object.entries(data || {})) {
        if (v === undefined) continue;
        const val = applyValue(undefined, v, now());
        if (val !== undefined) out[k] = val;
      }
      docs.set(path, { data: out, updateTime: t });
    } else {
      // set merge / update: claves de primer nivel (y rutas con punto en update)
      const base = row ? clone(row.data) : {};
      for (const [k, v] of Object.entries(data || {})) {
        if (v === undefined) continue;
        const parts = kind === 'update' ? k.split('.') : [k];
        let target = base;
        for (let i = 0; i < parts.length - 1; i += 1) {
          if (!isPlain(target[parts[i]])) target[parts[i]] = {};
          target = target[parts[i]];
        }
        const leaf = parts[parts.length - 1];
        if (v && v[SENTINEL] === 'delete') delete target[leaf];
        else if (kind === 'set' && isPlain(v) && isPlain(target[leaf])) {
          target[leaf] = { ...target[leaf], ...clone(v) };
        } else target[leaf] = applyValue(target[leaf], v, now());
      }
      docs.set(path, { data: base, updateTime: t });
    }
    void pre;
  };

  const runOps = (ops) => {
    for (const op of ops) {
      if (op.kind === 'update' && !docs.has(op.path)) throw Object.assign(new Error(`NOT_FOUND ${op.path}`), { code: 5 });
      if (op.kind === 'create' && docs.has(op.path)) throw Object.assign(new Error(`ALREADY_EXISTS ${op.path}`), { code: 6 });
      checkPrecondition(op.path, op.pre);
    }
    for (const op of ops) {
      applyWrite(op);
      countWrite(`${op.kind} ${op.path}`);
    }
  };

  function docRef(path) {
    const id = path.split('/').pop();
    return {
      id,
      path,
      _isDocRef: true,
      async get() {
        countRead(1, `get ${path}`);
        return makeSnap(path);
      },
      async set(data, opts) { runOps([{ kind: 'set', path, data, opts }]); },
      async update(data, pre) { runOps([{ kind: 'update', path, data, pre }]); },
      async create(data) { runOps([{ kind: 'create', path, data }]); },
      async delete(pre) { runOps([{ kind: 'delete', path, pre }]); },
      collection(sub) { return collectionRef(`${path}/${sub}`); }
    };
  }

  const childrenOf = (colPath) => {
    const depth = colPath.split('/').length + 1;
    return [...docs.keys()].filter((p) => p.startsWith(`${colPath}/`) && p.split('/').length === depth).sort();
  };

  const makeQuery = (colPath, filters = [], limitN = null, order = null) => ({
    where(field, op, value) { return makeQuery(colPath, [...filters, { field, op, value }], limitN, order); },
    orderBy(field, dir = 'asc') { return makeQuery(colPath, filters, limitN, { field, dir }); },
    limit(n) { return makeQuery(colPath, filters, n, order); },
    async get() {
      let paths = childrenOf(colPath).filter((p) => {
        const row = docs.get(p).data;
        const id = p.split('/').pop();
        return filters.every((f) => {
          const v = f.field === '__name__' ? id : comparable(row[f.field]);
          const want = comparable(f.value);
          if (f.op === '==') return v === want;
          if (f.op === '!=') return v !== want;
          if (f.op === 'in') return Array.isArray(f.value) && f.value.map(comparable).includes(v);
          if (f.op === 'array-contains') return Array.isArray(row[f.field]) && row[f.field].includes(f.value);
          if (v === undefined || v === null) return false;
          if (f.op === '>=') return v >= want;
          if (f.op === '<=') return v <= want;
          if (f.op === '>') return v > want;
          if (f.op === '<') return v < want;
          return false;
        });
      });
      if (order) {
        paths = paths.slice().sort((a, b) => {
          const va = comparable(docs.get(a).data[order.field]);
          const vb = comparable(docs.get(b).data[order.field]);
          const c = va < vb ? -1 : va > vb ? 1 : 0;
          return order.dir === 'desc' ? -c : c;
        });
      }
      if (limitN != null) paths = paths.slice(0, limitN);
      countRead(Math.max(1, paths.length), `query ${colPath} ${JSON.stringify(filters.map((f) => [f.field, f.op]))}`);
      const list = paths.map(makeSnap);
      return { empty: list.length === 0, size: list.length, docs: list, forEach: (fn) => list.forEach(fn) };
    }
  });

  function collectionRef(colPath) {
    let auto = 0;
    return {
      ...makeQuery(colPath),
      id: colPath.split('/').pop(),
      path: colPath,
      doc(id) { return docRef(`${colPath}/${id || `auto${Date.now().toString(36)}${(auto += 1)}`}`); },
      async add(data) {
        const ref = this.doc();
        await ref.set(data);
        return ref;
      }
    };
  }

  const db = {
    collection: (name) => collectionRef(name),
    doc: (path) => docRef(path),
    async getAll(...refs) {
      countRead(refs.length, `getAll ${refs.length}`);
      return refs.map((r) => makeSnap(r.path));
    },
    batch() {
      const ops = [];
      const b = {
        set(ref, data, opts) { ops.push({ kind: 'set', path: ref.path, data, opts }); return b; },
        update(ref, data, pre) { ops.push({ kind: 'update', path: ref.path, data, pre }); return b; },
        create(ref, data) { ops.push({ kind: 'create', path: ref.path, data }); return b; },
        delete(ref, pre) { ops.push({ kind: 'delete', path: ref.path, pre }); return b; },
        async commit() { runOps(ops); }
      };
      return b;
    },
    async runTransaction(fn) {
      const ops = [];
      const tx = {
        get: (ref) => ref.get(),
        set(ref, data, opts) { ops.push({ kind: 'set', path: ref.path, data, opts }); return tx; },
        update(ref, data) { ops.push({ kind: 'update', path: ref.path, data }); return tx; },
        create(ref, data) { ops.push({ kind: 'create', path: ref.path, data }); return tx; },
        delete(ref) { ops.push({ kind: 'delete', path: ref.path }); return tx; }
      };
      const result = await fn(tx);
      runOps(ops);
      return result;
    }
  };

  // Datos iniciales: { 'people/p1': {...}, 'sites/principal': {...} } o { people: {p1: {...}} }.
  for (const [key, value] of Object.entries(initial)) {
    if (key.split('/').length % 2 === 0) docs.set(key, { data: clone(value), updateTime: tick() });
    else for (const [id, data] of Object.entries(value || {})) docs.set(`${key}/${id}`, { data: clone(data), updateTime: tick() });
  }

  return {
    db,
    FieldValue,
    Timestamp,
    stats,
    resetStats: () => {
      stats.reads = 0;
      stats.writes = 0;
      stats.log = [];
    },
    peek: (path) => (docs.has(path) ? clone(docs.get(path).data) : undefined),
    poke: (path, data) => docs.set(path, { data: clone(data), updateTime: tick() }),
    remove: (path) => docs.delete(path),
    paths: (prefix = '') => [...docs.keys()].filter((p) => p.startsWith(prefix)).sort()
  };
};

module.exports = { createCountingFirestore, Timestamp, FieldValue };
