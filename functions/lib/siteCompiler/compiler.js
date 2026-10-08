'use strict';

/**
 * Compilador por sitio (docs/ETAPA2-DISENO.md §3, tarea T2).
 *
 * Firestore:
 *   sites/{s}/compiled/head          {siteId, version, day, tz, chunks:{name:{v,hash}}, keyId,
 *                                     credentialKeyId, compiledAt, sig, mode}
 *   sites/{s}/compiled/_dirty        {people[], auths[], visitas[], doors, operators, full, at, rev}
 *   sites/{s}/compiledChunks/{name}  {name, v, hash, json}   (json = JSON canónico del body)
 *   sites/{s}/secrets/credentialKey  {key (base64, 32 bytes), keyId, createdAt}   (solo Admin SDK)
 *
 * Delta: las mutaciones llaman `markDirty(...)` (1 escritura en _dirty). El
 * compilado se hace perezoso al leer el head (getHead / getCloudSnapshot) o con
 * compileDirtySites(); solo se recompilan los buckets/días/chunks tocados y se
 * escriben solo los chunks cuyo hash cambió + head + borrado de _dirty, en un
 * único batch con precondición (lastUpdateTime) sobre head y _dirty: si entra
 * otra mutación mientras se compila, el batch falla y se reintenta (no se pierde
 * ningún cambio). Cambio de día → compilado completo (ventana de grants D-1..D+7
 * y red de seguridad para mutaciones sin hook).
 */

const crypto = require('node:crypto');
const { credentialKeyId } = require('../accessEngine/snapshotSchema');
const { createMemorySnapshot } = require('../accessEngine/memorySnapshot');
const { canonicalJson, chunkHash } = require('./canonical');
const signing = require('./signing');
const build = require('./build');

const DEFAULT_SITE_ID = 'principal';
const MAX_DIRTY_IDS = 300;
const IN_QUERY_MAX = 30;
const HEAD_CHECK_MS = 15000;
const AUTO_COMPILE_DEBOUNCE_MS = 5000;
const RANGE_TYPES = ['visita', 'visit', 'temporal'];
const DIRTY_LISTS = ['people', 'auths', 'visitas'];

const defaultSiteId = () => String(process.env.SITE_ID || DEFAULT_SITE_ID);

const isPreconditionError = (err) => {
  const code = err && err.code;
  return code === 9 || code === 10 || code === 6 || code === 'failed-precondition' || code === 'aborted'
    || code === 'already-exists' || /FAILED_PRECONDITION|ABORTED|ALREADY_EXISTS/i.test(String(err && err.message));
};

const chunksOf = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

const docData = (snap) => (snap && snap.exists ? { id: snap.id, ...snap.data() } : null);

const parseChunkDoc = (snap) => {
  if (!snap || !snap.exists) return null;
  const d = snap.data() || {};
  let body = null;
  try { body = typeof d.json === 'string' ? JSON.parse(d.json) : (d.body || null); } catch { body = null; }
  return body ? { name: snap.id, v: Number(d.v) || 0, hash: d.hash || null, body, json: d.json } : null;
};

/** Saca campos internos (day) de los grants antes de serializar. */
const grantForChunk = (g) => {
  const { day, ...rest } = g;
  return rest;
};

const sortById = (list) => list.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));

/**
 * @param {object} [opts]
 * @param {() => {db:object, FieldValue:object}} [opts.deps]  default: require('../../firestore') en cada llamada
 * @param {() => number} [opts.now]
 * @param {object} [opts.signingKey]  ver signing.getSigningKey()
 * @param {boolean} [opts.autoCompile]  compilado diferido en proceso tras markDirty (default: solo en Cloud Functions)
 */
const createSiteCompiler = (opts = {}) => {
  const deps = opts.deps || (() => require('../../firestore'));
  const now = opts.now || (() => Date.now());
  const signingKey = () => opts.signingKey || signing.getSigningKey();
  const autoCompile = opts.autoCompile != null
    ? opts.autoCompile
    : (process.env.SITE_COMPILER_AUTOCOMPILE === '1'
      || (process.env.SITE_COMPILER_AUTOCOMPILE !== '0' && Boolean(process.env.K_SERVICE || process.env.FUNCTION_TARGET)));

  const keyCache = new Map();      // siteId → {key, at}
  const inflight = new Map();      // siteId → Promise (compileSite)
  const cloudCache = new Map();    // siteId → {version, bodies, snap, checkedAt, head}
  const cloudInflight = new Map();
  const autoTimers = new Map();

  const refs = (db, siteId) => {
    const site = db.collection('sites').doc(siteId);
    return {
      site,
      head: site.collection('compiled').doc('head'),
      dirty: site.collection('compiled').doc('_dirty'),
      key: site.collection('secrets').doc('credentialKey'),
      chunk: (name) => site.collection('compiledChunks').doc(name)
    };
  };

  const getAllDocs = async (db, docRefs) => {
    if (!docRefs.length) return [];
    if (typeof db.getAll === 'function') return db.getAll(...docRefs);
    return Promise.all(docRefs.map((r) => r.get()));
  };

  // ─────────────────────────── Clave de credenciales ───────────────────────────

  /**
   * Clave HMAC del sitio. `create`: si no existe, la genera (32 bytes aleatorios).
   * TODO(fase 2): distribuirla en un chunk `secrets` cifrado a la clave pública de
   * cada equipo; hoy viaja en claro dentro del bundle firmado.
   */
  const loadCredentialKey = async (db, siteId, { create = false } = {}) => {
    const cached = keyCache.get(siteId);
    if (cached && now() - cached.at < 10 * 60 * 1000 && (cached.key || !create)) return cached.key;
    const r = refs(db, siteId);
    const snap = await r.key.get();
    let key = snap.exists ? (snap.data() || {}).key || null : null;
    if (!key && create) {
      const fresh = crypto.randomBytes(32).toString('base64');
      try {
        await r.key.create({ key: fresh, keyId: credentialKeyId(fresh), alg: 'HMAC-SHA256', createdAt: new Date(now()) });
        key = fresh;
      } catch (err) {
        if (!isPreconditionError(err)) throw err;
        const again = await r.key.get();
        key = again.exists ? (again.data() || {}).key || null : null;
      }
    }
    keyCache.set(siteId, { key, at: now() });
    return key;
  };

  // ─────────────────────────── Lectura de fuentes ───────────────────────────

  const loadSiteDoc = async (db, siteId) => docData(await refs(db, siteId).site.get()) || {};
  const loadDoorsConfig = async (db) => docData(await db.collection('settings').doc('doorsConfig').get()) || {};

  const loadRoleTemplates = async (db) => {
    const { DEFAULT_ROLE_PERMISSIONS } = require('../../permissions');
    const templates = { ...DEFAULT_ROLE_PERMISSIONS };
    const snap = await db.collection('roles').get();
    for (const d of snap.docs) {
      const data = d.data() || {};
      if (Array.isArray(data.permissions)) templates[d.id] = data.permissions;
    }
    return templates;
  };

  const loadOperators = async (db) => {
    const [usersSnap, templates] = await Promise.all([db.collection('users').get(), loadRoleTemplates(db)]);
    const users = usersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return { operators: build.buildOperators(users, templates) };
  };

  const visitaWindow = (days, tz) => ({
    from: build.dayStartMs(days[0], tz),
    to: build.dayEndMs(days[days.length - 1], tz)
  });

  const passInWindow = (pass, win) => pass.validTo >= win.from && pass.validFrom <= win.to;

  // ─────────────────────────── Compilado completo ───────────────────────────

  const compileFull = async (db, siteId, ctx) => {
    const { day, key } = ctx;
    const [site, doorsConfig] = await Promise.all([loadSiteDoc(db, siteId), loadDoorsConfig(db)]);
    const tz = site.tz || (site.policy && site.policy.tz) || build.DEFAULT_TZ;
    const today = build.ymdOf(now(), tz);
    const days = build.windowDays(today);
    const win = visitaWindow(days, tz);
    const auths = db.collection('authorizations');

    const [peopleSnap, permSnap, citSnap, rangeSnap, nominaSnap, visitasSnap, operators] = await Promise.all([
      db.collection('people').where('active', '==', true).get(),
      auths.where('active', '==', true).where('type', '==', 'permanent').get(),
      // Rango sobre un solo campo (índice automático); tipo/activa se filtran en memoria.
      auths.where('appointmentDate', '>=', days[0]).where('appointmentDate', '<=', days[days.length - 1]).get(),
      auths.where('active', '==', true).where('type', 'in', RANGE_TYPES).get(),
      db.collection('personalMaster').where('source', '==', 'nomina').get(),
      db.collection('visitas').where('fechaHoraEsperada', '>=', new Date(win.from - 2 * 3600 * 1000))
        .where('fechaHoraEsperada', '<=', new Date(win.to)).get(),
      loadOperators(db)
    ]);

    const authByPerson = new Map();
    const pushAuth = (a) => {
      if (!a.personId || a.active === false) return;
      const k = String(a.personId);
      if (!authByPerson.has(k)) authByPerson.set(k, new Map());
      authByPerson.get(k).set(a.id, a);
    };
    permSnap.docs.forEach((d) => pushAuth({ id: d.id, ...d.data() }));
    citSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((a) => String(a.type || '').toLowerCase() === 'citacion')
      .forEach(pushAuth);
    rangeSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((a) => {
        const end = a.endDate || a.startDate;
        return a.startDate && end && a.startDate <= days[days.length - 1] && end >= days[0];
      })
      .forEach(pushAuth);

    const employeeByPerson = new Map();
    for (const d of nominaSnap.docs) {
      const e = { id: d.id, ...d.data() };
      if (!e.personId || e.active === false) continue;
      if (!employeeByPerson.has(String(e.personId))) employeeByPerson.set(String(e.personId), e);
    }

    const buckets = new Map();
    const grantsByDay = new Map(days.map((d) => [d, []]));
    const schedules = new Map();
    for (const d of peopleSnap.docs) {
      const person = { id: d.id, ...d.data() };
      const entry = build.buildPersonEntry({
        person,
        auths: [...(authByPerson.get(d.id) || new Map()).values()],
        employee: employeeByPerson.get(d.id) || null,
        key,
        tz,
        days
      });
      if (!entry.cardholder) continue;
      const b = build.bucketOf(d.id);
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(entry.cardholder);
      entry.schedules.forEach((s) => schedules.set(s.id, s));
      entry.grants.forEach((g) => { if (grantsByDay.has(g.day)) grantsByDay.get(g.day).push(g); });
    }

    const passes = [];
    const revoked = [];
    for (const d of visitasSnap.docs) {
      const r = build.buildPass({ id: d.id, ...d.data() }, { key, tz });
      if (r.pass && passInWindow(r.pass, win)) passes.push(r.pass);
      if (r.revoked) revoked.push(r.revoked);
    }

    const next = {};
    next.doors = build.buildDoorsChunk({ siteId, site, doorsConfig, schedules: [...schedules.values()] });
    for (const [b, list] of buckets) next[build.bucketChunkName(b)] = { bucket: b, cardholders: sortById(list) };
    for (const [d, list] of grantsByDay) {
      if (list.length) next[build.grantsChunkName(d)] = { date: d, grants: sortById(list).map(grantForChunk) };
    }
    next.passes = { passes: sortById(passes), revoked: [...new Set(revoked)].sort() };
    next.operators = operators;
    const secrets = build.buildSecretsChunk(key);
    if (secrets) next.secrets = secrets;
    return { next, replaceAll: true, day: today, tz, reason: ctx.reason };
  };

  // ─────────────────────────── Compilado delta ───────────────────────────

  const compileDelta = async (db, siteId, ctx) => {
    const { head, dirty, key } = ctx;
    const r = refs(db, siteId);
    const tz = head.tz || build.DEFAULT_TZ;
    const days = build.windowDays(head.day);
    const next = {};
    const loaded = new Map(); // name → body actual

    const loadChunks = async (names) => {
      const want = names.filter((n) => !loaded.has(n) && head.chunks && head.chunks[n]);
      const snaps = await getAllDocs(db, want.map((n) => r.chunk(n)));
      snaps.forEach((s, i) => {
        const c = parseChunkDoc(s);
        loaded.set(want[i], c ? c.body : null);
      });
      names.forEach((n) => { if (!loaded.has(n)) loaded.set(n, null); });
    };

    await loadChunks(['doors']);
    let doorsBody = loaded.get('doors');
    if (!doorsBody) return null; // sin chunk doors no hay delta posible → completo

    if (dirty.doors) {
      const [site, doorsConfig] = await Promise.all([loadSiteDoc(db, siteId), loadDoorsConfig(db)]);
      doorsBody = build.buildDoorsChunk({ siteId, site, doorsConfig, schedules: doorsBody.schedules || [] });
      if ((doorsBody.policy && doorsBody.policy.tz) !== tz) return null; // cambió la zona → completo
      next.doors = doorsBody;
    }

    const peopleIds = new Set((dirty.people || []).map(String));
    const authIds = [...new Set((dirty.auths || []).map(String))];
    const orphanAuthIds = new Set();
    if (authIds.length) {
      const snaps = await getAllDocs(db, authIds.map((id) => db.collection('authorizations').doc(id)));
      snaps.forEach((s, i) => {
        const a = docData(s);
        if (a && a.personId) peopleIds.add(String(a.personId));
        else orphanAuthIds.add(authIds[i]);
      });
    }

    if (peopleIds.size || orphanAuthIds.size) {
      const ids = [...peopleIds].sort();
      const [personSnaps, authSnaps, nominaSnaps] = await Promise.all([
        getAllDocs(db, ids.map((id) => db.collection('people').doc(id))),
        Promise.all(chunksOf(ids, IN_QUERY_MAX).map((part) => db.collection('authorizations').where('personId', 'in', part).get())),
        Promise.all(chunksOf(ids, IN_QUERY_MAX).map((part) => db.collection('personalMaster').where('personId', 'in', part).get()))
      ]);
      const authByPerson = new Map();
      authSnaps.flatMap((s) => s.docs).forEach((d) => {
        const a = { id: d.id, ...d.data() };
        const k = String(a.personId);
        if (!authByPerson.has(k)) authByPerson.set(k, []);
        authByPerson.get(k).push(a);
      });
      const employeeByPerson = new Map();
      nominaSnaps.flatMap((s) => s.docs).forEach((d) => {
        const e = { id: d.id, ...d.data() };
        if (e.source !== 'nomina' || e.active === false) return;
        if (!employeeByPerson.has(String(e.personId))) employeeByPerson.set(String(e.personId), e);
      });

      const bucketNames = [...new Set(ids.map(build.chunkNameForPerson))];
      const dayNames = days.map(build.grantsChunkName);
      await loadChunks([...bucketNames, ...dayNames]);

      const bucketBodies = new Map(bucketNames.map((n) => {
        const body = loaded.get(n);
        return [n, (body && Array.isArray(body.cardholders) ? body.cardholders : []).filter((c) => !peopleIds.has(String(c.id)))];
      }));
      const grantBodies = new Map(dayNames.map((n) => {
        const body = loaded.get(n);
        return [n, (body && Array.isArray(body.grants) ? body.grants : [])
          .filter((g) => !peopleIds.has(String(g.cardholderId)) && !orphanAuthIds.has(String(g.refId)))];
      }));

      const knownSchedules = new Set((doorsBody.schedules || []).map((s) => s.id));
      const newSchedules = [];
      personSnaps.forEach((s, i) => {
        const person = docData(s);
        const entry = build.buildPersonEntry({
          person,
          auths: authByPerson.get(ids[i]) || [],
          employee: employeeByPerson.get(ids[i]) || null,
          key,
          tz,
          days
        });
        if (!entry.cardholder) return;
        bucketBodies.get(build.chunkNameForPerson(ids[i])).push(entry.cardholder);
        entry.schedules.forEach((sch) => {
          if (!knownSchedules.has(sch.id)) {
            knownSchedules.add(sch.id);
            newSchedules.push(sch);
          }
        });
        entry.grants.forEach((g) => {
          const name = build.grantsChunkName(g.day);
          if (grantBodies.has(name)) grantBodies.get(name).push(grantForChunk(g));
        });
      });

      for (const [name, list] of bucketBodies) {
        const bucket = Number(name.slice(3));
        next[name] = list.length ? { bucket, cardholders: sortById(list) } : null;
      }
      for (const [name, list] of grantBodies) {
        const had = loaded.get(name);
        if (!had && !list.length) continue;
        next[name] = list.length ? { date: build.chunkDay(name), grants: sortById(list) } : null;
      }
      if (newSchedules.length) {
        doorsBody = { ...doorsBody, schedules: sortById([...(doorsBody.schedules || []), ...newSchedules]) };
        next.doors = doorsBody;
      }
    }

    const visitaIds = [...new Set((dirty.visitas || []).map(String))];
    if (visitaIds.length) {
      await loadChunks(['passes']);
      const current = loaded.get('passes') || { passes: [], revoked: [] };
      const snaps = await getAllDocs(db, visitaIds.map((id) => db.collection('visitas').doc(id)));
      const touched = new Set(visitaIds);
      const touchedPassIds = new Set();
      const added = [];
      const addedRevoked = [];
      const win = visitaWindow(days, tz);
      snaps.forEach((s, i) => {
        const v = docData(s);
        touchedPassIds.add(visitaIds[i]);
        if (!v) return;
        if (v.qrId) touchedPassIds.add(String(v.qrId));
        const res = build.buildPass(v, { key, tz });
        if (res.pass && passInWindow(res.pass, win)) added.push(res.pass);
        if (res.revoked) addedRevoked.push(res.revoked);
      });
      const passes = (current.passes || []).filter((p) => !touched.has(String(p.visitaId || p.id)) && !touchedPassIds.has(String(p.id)));
      const revoked = (current.revoked || []).filter((k) => !touchedPassIds.has(String(k).replace(/^pass:/, '')));
      next.passes = { passes: sortById([...passes, ...added]), revoked: [...new Set([...revoked, ...addedRevoked])].sort() };
    }

    if (dirty.operators) next.operators = await loadOperators(db);

    return { next, replaceAll: false, day: head.day, tz, reason: ctx.reason };
  };

  // ─────────────────────────── Commit ───────────────────────────

  const commit = async (db, siteId, { headSnap, dirtySnap, head, plan, key }) => {
    const r = refs(db, siteId);
    const prevChunks = (head && head.chunks) || {};
    const version = (Number(head && head.version) || 0) + 1;
    const chunks = plan.replaceAll ? {} : { ...prevChunks };
    const writes = [];
    const removed = [];
    const changed = [];
    for (const [name, body] of Object.entries(plan.next)) {
      if (body == null) {
        if (chunks[name]) {
          delete chunks[name];
          removed.push(name);
        }
        continue;
      }
      const json = canonicalJson(body);
      const hash = chunkHash(body);
      if (prevChunks[name] && prevChunks[name].hash === hash) {
        chunks[name] = prevChunks[name];
        continue;
      }
      chunks[name] = { v: version, hash };
      changed.push(name);
      writes.push({ name, json, hash });
    }
    if (plan.replaceAll) {
      for (const name of Object.keys(prevChunks)) if (!chunks[name]) removed.push(name);
    }

    const sk = signingKey();
    const nothingChanged = !changed.length && !removed.length && head && head.version
      && head.day === plan.day && head.keyId === sk.keyId && (head.credentialKeyId || null) === credentialKeyId(key);
    const batch = db.batch();
    const dirtyPrecondition = dirtySnap && dirtySnap.exists ? { lastUpdateTime: dirtySnap.updateTime } : null;

    if (nothingChanged) {
      if (!dirtyPrecondition) return { head, version: head.version, changed: [], removed: [], mode: 'noop' };
      batch.delete(r.dirty, dirtyPrecondition);
      await batch.commit();
      return { head, version: head.version, changed: [], removed: [], mode: plan.replaceAll ? 'full' : 'delta' };
    }

    for (const w of writes) {
      batch.set(r.chunk(w.name), { name: w.name, v: version, hash: w.hash, json: w.json, updatedAt: new Date(now()) });
    }
    for (const name of removed) batch.delete(r.chunk(name));
    const nextHead = signing.signHead({
      siteId,
      version,
      day: plan.day,
      tz: plan.tz,
      chunks,
      credentialKeyId: credentialKeyId(key),
      compiledAt: now()
    }, sk);
    nextHead.mode = plan.replaceAll ? 'full' : 'delta';
    if (headSnap && headSnap.exists) batch.update(r.head, nextHead, { lastUpdateTime: headSnap.updateTime });
    else batch.create(r.head, nextHead);
    if (dirtyPrecondition) batch.delete(r.dirty, dirtyPrecondition);
    await batch.commit();
    return { head: nextHead, version, changed: changed.sort(), removed: removed.sort(), mode: nextHead.mode };
  };

  // ─────────────────────────── API ───────────────────────────

  const needsFull = (head, dirty, today, key) => {
    if (!head || !head.version || !head.chunks || !head.chunks.doors) return 'sin_head';
    if (head.day !== today) return 'cambio_de_dia';
    if (dirty && dirty.full) return 'marcado_completo';
    if (head.keyId !== signingKey().keyId) return 'clave_de_firma';
    if ((head.credentialKeyId || null) !== credentialKeyId(key)) return 'clave_de_credenciales';
    if (dirty && DIRTY_LISTS.some((k) => Array.isArray(dirty[k]) && dirty[k].length > MAX_DIRTY_IDS)) return 'demasiados_cambios';
    return null;
  };

  const compileOnce = async (siteId, { full = false } = {}) => {
    const { db } = deps();
    const r = refs(db, siteId);
    const [headSnap, dirtySnap] = await Promise.all([r.head.get(), r.dirty.get()]);
    const head = docData(headSnap);
    if (head) delete head.id;
    const dirty = docData(dirtySnap);
    const tz = (head && head.tz) || build.DEFAULT_TZ;
    const today = build.ymdOf(now(), tz);
    let fullReason = full ? 'pedido' : null;
    const keyNow = await loadCredentialKey(db, siteId, { create: Boolean(full || !head || !head.version) });
    if (!fullReason) fullReason = needsFull(head, dirty, today, keyNow);
    if (!fullReason && !dirty) return { head, version: head.version, changed: [], removed: [], mode: 'noop' };

    let plan = null;
    let key = keyNow;
    if (!fullReason) {
      plan = await compileDelta(db, siteId, { head, dirty: dirty || {}, key, reason: 'delta' });
      if (!plan) fullReason = 'delta_imposible';
    }
    if (fullReason) {
      key = await loadCredentialKey(db, siteId, { create: true });
      plan = await compileFull(db, siteId, { day: today, key, reason: fullReason });
    }
    return commit(db, siteId, { headSnap, dirtySnap, head, plan, key });
  };

  /**
   * Compila el sitio (delta si se puede). Una sola compilación en vuelo por sitio
   * y proceso; reintenta si otra mutación/compilación ganó la precondición.
   * @returns {Promise<{head, version, changed:string[], removed:string[], mode:'full'|'delta'|'noop'}>}
   */
  const compileSite = (siteId = defaultSiteId(), options = {}) => {
    const key = `${siteId}|${options.full ? 'full' : 'auto'}`;
    if (inflight.has(key)) return inflight.get(key);
    const run = (async () => {
      let lastErr = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          const res = await compileOnce(siteId, options);
          const cached = cloudCache.get(siteId);
          if (cached) cached.checkedAt = 0;
          return res;
        } catch (err) {
          lastErr = err;
          if (!isPreconditionError(err)) throw err;
        }
      }
      throw lastErr;
    })();
    inflight.set(key, run);
    run.finally(() => inflight.delete(key)).catch(() => {});
    return run;
  };

  /**
   * Head actual (compila antes si hay cambios pendientes o cambió el día).
   * 2 lecturas (head + _dirty) si no hay nada que compilar.
   */
  const getHead = async (siteId = defaultSiteId(), { compile = true } = {}) => {
    const { db } = deps();
    const r = refs(db, siteId);
    const [headSnap, dirtySnap] = await Promise.all([r.head.get(), r.dirty.get()]);
    const head = docData(headSnap);
    if (head) delete head.id;
    if (!compile) return head;
    const stale = !head || !head.version || head.day !== build.ymdOf(now(), head.tz || build.DEFAULT_TZ);
    if (!dirtySnap.exists && !stale) return head;
    const res = await compileSite(siteId);
    return res.head;
  };

  /** Cuerpos de chunks por nombre → { name: body } (los que no existen se omiten). */
  const getChunks = async (siteId = defaultSiteId(), names = []) => {
    const docs = await getChunkDocs(siteId, names);
    return Object.fromEntries(Object.entries(docs).map(([n, c]) => [n, c.body]));
  };

  /** Igual que getChunks pero con metadatos → { name: {name, v, hash, body, json} }. */
  const getChunkDocs = async (siteId = defaultSiteId(), names = []) => {
    const { db } = deps();
    const r = refs(db, siteId);
    const list = [...new Set((names || []).map(String))];
    const snaps = await getAllDocs(db, list.map((n) => r.chunk(n)));
    const out = {};
    snaps.forEach((s) => {
      const c = parseChunkDoc(s);
      if (c) out[c.name] = c;
    });
    return out;
  };

  const markDirtyNow = async (siteId, change = {}) => {
    const { db, FieldValue } = deps();
    const payload = { at: now() };
    if (FieldValue && typeof FieldValue.increment === 'function') payload.rev = FieldValue.increment(1);
    let any = false;
    for (const k of DIRTY_LISTS) {
      const ids = [...new Set((Array.isArray(change[k]) ? change[k] : (change[k] ? [change[k]] : []))
        .map((x) => String(x || '').trim()).filter(Boolean))];
      if (!ids.length) continue;
      any = true;
      if (ids.length > MAX_DIRTY_IDS) payload.full = true;
      else payload[k] = FieldValue.arrayUnion(...ids);
    }
    for (const k of ['doors', 'operators', 'full']) {
      if (change[k]) {
        payload[k] = true;
        any = true;
      }
    }
    if (!any) return false;
    await refs(db, siteId).dirty.set(payload, { merge: true });
    const cached = cloudCache.get(siteId);
    if (cached) cached.checkedAt = 0;
    if (autoCompile) scheduleCompile(siteId);
    return true;
  };

  /**
   * Marca cambios pendientes. Nunca rechaza (fire-and-forget desde las rutas):
   * los errores se registran por consola.
   *   markDirty({ people: [id] })            markDirty('principal', { doors: true })
   * Claves: people, auths, visitas (ids), doors, operators, full (booleanos).
   */
  const markDirty = (a, b) => {
    const [siteId, change] = typeof a === 'string' ? [a, b || {}] : [defaultSiteId(), a || {}];
    try {
      return markDirtyNow(siteId, change).catch((err) => {
        console.error('[siteCompiler] markDirty', err && err.message);
        return false;
      });
    } catch (err) {
      console.error('[siteCompiler] markDirty', err && err.message);
      return Promise.resolve(false);
    }
  };

  function scheduleCompile(siteId) {
    clearTimeout(autoTimers.get(siteId));
    const t = setTimeout(() => {
      autoTimers.delete(siteId);
      compileSite(siteId).catch((err) => console.error('[siteCompiler] compilado diferido', err && err.message));
    }, AUTO_COMPILE_DEBOUNCE_MS);
    if (typeof t.unref === 'function') t.unref();
    autoTimers.set(siteId, t);
  }

  /**
   * Compila los sitios con cambios pendientes (para colgar de un scheduler
   * existente; no exporta un onSchedule nuevo: el cupo gratis es de 3 jobs).
   */
  const compileDirtySites = async ({ siteIds = null } = {}) => {
    const { db } = deps();
    const ids = siteIds || String(process.env.SITE_IDS || defaultSiteId()).split(',').map((s) => s.trim()).filter(Boolean);
    const results = {};
    for (const siteId of ids) {
      try {
        const r = refs(db, siteId);
        const [dirtySnap, headSnap] = await Promise.all([r.dirty.get(), r.head.get()]);
        const head = docData(headSnap);
        const stale = !head || head.day !== build.ymdOf(now(), (head && head.tz) || build.DEFAULT_TZ);
        results[siteId] = dirtySnap.exists || stale
          ? await compileSite(siteId)
          : { mode: 'noop', version: head && head.version, changed: [], removed: [] };
      } catch (err) {
        console.error('[siteCompiler] compileDirtySites', siteId, err && err.message);
        results[siteId] = { error: err && err.message };
      }
    }
    return results;
  };

  /**
   * Snapshot en memoria del sitio para decisiones en la nube (vista previa,
   * adaptadores T10). Revisa el head como mucho cada 15 s (2 lecturas: head +
   * _dirty) y baja solo los chunks cuyo hash cambió. El chunk `operators` no se baja.
   * Devuelve un SnapLookup + `version()` y `head()`.
   */
  const getCloudSnapshot = (siteId = defaultSiteId()) => {
    const entry = cloudCache.get(siteId);
    if (entry && entry.snap && now() - entry.checkedAt < HEAD_CHECK_MS) return Promise.resolve(entry.snap);
    if (cloudInflight.has(siteId)) return cloudInflight.get(siteId);
    const run = (async () => {
      const head = await getHead(siteId);
      if (!head || !head.chunks) throw new Error(`[siteCompiler] sitio ${siteId} sin head compilado`);
      const current = cloudCache.get(siteId);
      if (current && current.snap && current.version === head.version) {
        current.checkedAt = now();
        return current.snap;
      }
      const bodies = { ...((current && current.bodies) || {}) };
      const names = Object.keys(head.chunks).filter((n) => n !== 'operators');
      for (const n of Object.keys(bodies)) if (!head.chunks[n] || n === 'operators') delete bodies[n];
      const missing = names.filter((n) => !bodies[n] || bodies[n].hash !== head.chunks[n].hash);
      const got = await getChunkDocs(siteId, missing);
      for (const n of missing) {
        const c = got[n];
        if (!c || chunkHash(c.body) !== head.chunks[n].hash) {
          throw new Error(`[siteCompiler] chunk ${n} inconsistente con el head v${head.version}`);
        }
        bodies[n] = { hash: c.hash, body: c.body };
      }
      const base = createMemorySnapshot(Object.fromEntries(Object.entries(bodies).map(([n, c]) => [n, c.body])));
      const snap = { ...base, version: () => head.version, head: () => head };
      cloudCache.set(siteId, { version: head.version, bodies, snap, checkedAt: now(), head });
      return snap;
    })();
    cloudInflight.set(siteId, run);
    run.finally(() => cloudInflight.delete(siteId)).catch(() => {});
    return run;
  };

  return {
    compileSite,
    compileDirtySites,
    getHead,
    getChunks,
    getChunkDocs,
    markDirty,
    getCloudSnapshot,
    getSigningPublicKey: () => {
      const k = signingKey();
      return { alg: 'Ed25519', keyId: k.keyId, publicKeyPem: k.publicKeyPem, ephemeral: Boolean(k.ephemeral) };
    },
    loadCredentialKey: (siteId = defaultSiteId(), o) => loadCredentialKey(deps().db, siteId, o),
    _clearCaches: () => {
      keyCache.clear();
      cloudCache.clear();
    }
  };
};

module.exports = { createSiteCompiler, DEFAULT_SITE_ID, MAX_DIRTY_IDS, HEAD_CHECK_MS, defaultSiteId };
