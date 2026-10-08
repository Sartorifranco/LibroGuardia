'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createCountingFirestore, FieldValue, Timestamp } = require('./helpers/countingFirestore');
const { createSiteCompiler } = require('../lib/siteCompiler/compiler');
const { canonicalJson, chunkHash } = require('../lib/siteCompiler/canonical');
const signing = require('../lib/siteCompiler/signing');
const build = require('../lib/siteCompiler/build');
const { decide, validateSnapshotChunk, hashCredential, createMemorySnapshot } = require('../lib/accessEngine');
const { ar, TODAY, NOW, buildInitial, PARITY_CASES } = require('./siteCompilerFixture');

const SITE = 'principal';
const signingKey = signing.loadSigningKey({});

const setup = (initial = buildInitial()) => {
  const fs = createCountingFirestore(initial);
  const clock = { now: NOW };
  const compiler = createSiteCompiler({
    deps: () => ({ db: fs.db, FieldValue }),
    now: () => clock.now,
    signingKey,
    autoCompile: false
  });
  return { fs, clock, compiler };
};

const headOf = (fs) => fs.peek(`sites/${SITE}/compiled/head`);
const chunkBody = (fs, name) => JSON.parse(fs.peek(`sites/${SITE}/compiledChunks/${name}`).json);

const decideDni = (snap, c) => decide({
  snap,
  credential: { type: 'dni', value: c.dni },
  doorId: c.door,
  side: c.readerId ? undefined : (c.side || 'in'),
  readerId: c.readerId || null,
  at: c.at,
  state: { doorStates: { EA: { state: 'SEGURA', dps: 'closed', bond: 'locked' }, EB: { state: 'SEGURA', dps: 'closed', bond: 'locked' } } }
});

test('compilado completo: chunks válidos, hash canónico, firma y sin secretos en claro', async () => {
  const { fs, compiler } = setup();
  const res = await compiler.compileSite(SITE, { full: true });
  assert.equal(res.mode, 'full');
  assert.equal(res.version, 1);
  const head = headOf(fs);
  assert.equal(head.version, 1);
  assert.equal(head.day, TODAY);
  assert.equal(head.keyId, signingKey.keyId);
  assert.ok(signing.verifyHead(head, signingKey.publicKeyPem), 'firma válida');
  assert.ok(signing.verifyHead(head, compiler.getSigningPublicKey()), 'firma válida con getSigningPublicKey()');
  // La firma cubre exactamente canonicalJson({version, chunks}) (contrato con el hub).
  const payload = Buffer.from(canonicalJson({ version: head.version, chunks: head.chunks }), 'utf8');
  assert.ok(crypto.verify(null, payload, crypto.createPublicKey(signingKey.publicKeyPem), Buffer.from(head.sig, 'base64')));
  assert.equal(signing.verifyHead({ ...head, version: 2 }, signingKey.publicKeyPem), false, 'head adulterado');

  const names = Object.keys(head.chunks).sort();
  assert.ok(names.includes('doors') && names.includes('passes') && names.includes('operators') && names.includes('secrets'));
  assert.ok(names.includes('grants-20261008') && names.includes('grants-20261009'));
  assert.ok(!names.includes('grants-20260901'), 'fuera de la ventana D-1..D+7');
  assert.ok(names.filter((n) => /^ch-\d{2}$/.test(n)).length >= 5);

  for (const name of names) {
    const doc = fs.peek(`sites/${SITE}/compiledChunks/${name}`);
    const body = JSON.parse(doc.json);
    assert.equal(doc.json, canonicalJson(body), `${name}: JSON canónico`);
    assert.equal(head.chunks[name].hash, chunkHash(body), `${name}: hash`);
    const v = validateSnapshotChunk(name, body);
    assert.ok(v.ok, `${name}: ${v.errors.join('; ')}`);
  }

  const all = names.map((n) => fs.peek(`sites/${SITE}/compiledChunks/${n}`).json).join('\n');
  assert.ok(!all.includes('30111222'), 'ningún DNI en claro');
  assert.ok(!all.includes('40111222'), 'ni el DNI de la visita');
  assert.ok(!all.includes('NO-VIAJA'), 'sin secretos de equipos');

  // HMAC con la clave del sitio (no sha256 pelado).
  const key = fs.peek(`sites/${SITE}/secrets/credentialKey`).key;
  assert.equal(Buffer.from(key, 'base64').length, 32);
  const perm1 = chunkBody(fs, build.chunkNameForPerson('perm1')).cardholders.find((c) => c.id === 'perm1');
  assert.equal(perm1.credentials[0].valueHash, hashCredential('dni', '30111222', key));
  assert.notEqual(perm1.credentials[0].valueHash, hashCredential('dni', '30111222'));
  assert.equal(chunkBody(fs, 'secrets').secrets.credentialKey, key);

  const passes = chunkBody(fs, 'passes');
  assert.deepEqual(passes.passes.map((p) => p.id), ['v1']);
  assert.equal(passes.passes[0].dni, undefined);
  assert.equal(passes.passes[0].dniHash, hashCredential('dni', '40111222', key));
  assert.equal(passes.passes[0].validFrom, ar(TODAY, '09:00'));
  assert.equal(passes.passes[0].validTo, ar('2026-10-09', '00:00') - 1);
  assert.deepEqual(passes.revoked, ['pass:v2']);

  const doors = chunkBody(fs, 'doors');
  assert.deepEqual(doors.doors.map((d) => d.id), ['EA', 'EB', 'P1', 'P2', 'P9']);
  assert.equal(doors.doors.find((d) => d.id === 'P9').enabled, false);
  assert.deepEqual(doors.interlockGroups, [{ id: 'estanco-1', name: 'Estanco', doorIds: ['EA', 'EB'], mode: 'timed', outerDoorId: 'EA',
    timings: { outerCloseDelayMs: 5000, interDoorDelayMs: 2000, transitTimeoutMs: 120000 } }]);
  assert.deepEqual(doors.doors.find((d) => d.id === 'P1').readers, [{ id: 'INGRESO_P1', side: 'in' }, { id: 'EGRESO_P1', side: 'out' }]);
  assert.ok(doors.schedules.some((s) => s.id === 'sch_sin_turno'));

  const ops = chunkBody(fs, 'operators').operators;
  assert.deepEqual(ops.map((o) => o.username), ['guardia1', 'operador']);
  assert.equal(ops[0].passwordVersion, 3);
  assert.deepEqual(ops[0].posts, ['porton']);
  assert.ok(ops[0].hash.startsWith('$2'));
});

test('paridad: decide() sobre el snapshot compilado = resultados de PARITY.md', async () => {
  const { compiler, clock } = setup();
  await compiler.compileSite(SITE, { full: true });
  const snap = await compiler.getCloudSnapshot(SITE);
  assert.equal(snap.version(), 1);
  const failures = [];
  for (const c of PARITY_CASES) {
    clock.now = c.at;
    const r = decideDni(snap, c);
    const ok = r.decision === c.decision && (!c.reason || r.reason === c.reason)
      && (!c.warning || r.warnings.includes(c.warning));
    if (!ok) failures.push(`${c.name}: esperado ${c.decision}/${c.reason || '*'} → ${r.decision}/${r.reason} ${r.warnings.join(',')}`);
  }
  assert.deepEqual(failures, []);
});

test('compilado sin clave del sitio: compatibilidad con sha256 y pases con dni', async () => {
  const { compiler } = setup();
  const entry = build.buildPersonEntry({ person: { id: 'x', dniNormalized: '123', allowedDoorIds: ['P1'] }, key: null, days: [TODAY] });
  assert.equal(entry.cardholder.credentials[0].valueHash, hashCredential('dni', '123'));
  const { pass } = build.buildPass({ id: 'v', estado: 'autorizada', dniVisitanteNormalized: '555', fechaHoraEsperada: NOW, allowedDoorIds: ['P1'] }, { key: null });
  assert.equal(pass.dni, '555');
  assert.equal(pass.dniHash, undefined);
  // y el motor encuentra el pase por dniHash cuando hay clave
  const key = crypto.randomBytes(32).toString('base64');
  const hashed = build.buildPass({ id: 'v', estado: 'autorizada', dniVisitanteNormalized: '555', fechaHoraEsperada: NOW, allowedDoorIds: ['P1'] }, { key }).pass;
  const snap = createMemorySnapshot({
    doors: { doors: [{ id: 'P1', sides: ['in', 'out'] }] },
    passes: { passes: [hashed] },
    secrets: { secrets: { credentialKey: key } }
  });
  const r = decide({ snap, credential: { type: 'dni', value: '555' }, doorId: 'P1', side: 'in', at: NOW });
  assert.equal(r.decision, 'grant');
  assert.equal(r.reason, 'pase_visita');
  void compiler;
});

test('delta: cambio de una persona recompila solo su bucket (≤35 lecturas, ≤3 escrituras)', async () => {
  const { fs, compiler } = setup();
  await compiler.compileSite(SITE, { full: true });
  const before = headOf(fs);
  let snap = await compiler.getCloudSnapshot(SITE);
  assert.equal(decideDni(snap, { dni: '30111333', door: 'P2', at: NOW }).reason, 'puerta_no_autorizada');

  fs.poke('people/perm24', { ...fs.peek('people/perm24'), allowedDoorIds: ['P1', 'P2'] });
  await compiler.markDirty({ people: ['perm24'] });
  fs.resetStats();
  const res = await compiler.compileSite(SITE);
  assert.equal(res.mode, 'delta');
  assert.deepEqual(res.changed, [build.chunkNameForPerson('perm24')]);
  assert.ok(fs.stats.reads <= 35, `lecturas ${fs.stats.reads}: ${fs.stats.log.join(' | ')}`);
  assert.ok(fs.stats.writes <= 3, `escrituras ${fs.stats.writes}: ${fs.stats.log.join(' | ')}`);

  const head = headOf(fs);
  assert.equal(head.version, before.version + 1);
  assert.ok(signing.verifyHead(head, signingKey.publicKeyPem));
  for (const [name, meta] of Object.entries(head.chunks)) {
    if (name === build.chunkNameForPerson('perm24')) assert.equal(meta.v, head.version);
    else assert.deepEqual(meta, before.chunks[name], `${name} no cambia`);
  }
  assert.equal(fs.peek(`sites/${SITE}/compiled/_dirty`), undefined, '_dirty borrado');

  snap = await compiler.getCloudSnapshot(SITE);
  assert.equal(snap.version(), head.version);
  assert.equal(decideDni(snap, { dni: '30111333', door: 'P2', at: NOW }).decision, 'grant');

  // El delta deja exactamente lo mismo que un compilado completo.
  fs.resetStats();
  const full = await compiler.compileSite(SITE, { full: true });
  assert.deepEqual(full.changed, []);
  assert.deepEqual(full.removed, []);
  assert.equal(fs.stats.writes, 0);
});

test('delta: alta de citación toca solo el chunk del día; baja de persona la saca del bucket', async () => {
  const { fs, compiler } = setup();
  await compiler.compileSite(SITE, { full: true });
  fs.poke('authorizations/a_new', { type: 'citacion', personId: 'noauth', active: true, appointmentDate: '2026-10-10' });
  await compiler.markDirty({ auths: ['a_new'] });
  fs.resetStats();
  let res = await compiler.compileSite(SITE);
  assert.equal(res.mode, 'delta');
  // noauth deja de ser "sin base" (requiresGrant) → cambia también su bucket.
  assert.deepEqual(res.changed, [build.chunkNameForPerson('noauth'), 'grants-20261010'].sort());
  assert.ok(fs.stats.reads <= 35, `lecturas ${fs.stats.reads}`);
  assert.ok(fs.stats.writes <= 4, `escrituras ${fs.stats.writes}`);
  assert.deepEqual(chunkBody(fs, 'grants-20261010').grants.map((g) => g.refId), ['a_new']);

  fs.poke('people/perm1', { ...fs.peek('people/perm1'), active: false });
  await compiler.markDirty({ people: ['perm1'] });
  fs.resetStats();
  res = await compiler.compileSite(SITE);
  assert.deepEqual(res.changed.length + res.removed.length, 1);
  assert.ok(fs.stats.writes <= 3);
  const snap = await compiler.getCloudSnapshot(SITE);
  assert.equal(decideDni(snap, { dni: '30111222', door: 'P1', at: NOW }).reason, 'credencial_desconocida');

  // borrar la autorización (doc ya no existe): el grant huérfano se elimina por refId
  fs.remove('authorizations/a_new');
  await compiler.markDirty({ auths: ['a_new'] });
  res = await compiler.compileSite(SITE);
  assert.ok(res.removed.includes('grants-20261010'));
  assert.equal(headOf(fs).chunks['grants-20261010'], undefined);
  assert.equal(fs.peek(`sites/${SITE}/compiledChunks/grants-20261010`), undefined);
});

test('delta: nuevo horario autogenerado se agrega al chunk doors', async () => {
  const { fs, compiler } = setup();
  await compiler.compileSite(SITE, { full: true });
  fs.poke('authorizations/a_noche', { type: 'permanent', personId: 'noauth', active: true, daysOfWeek: ['Sa'], timeWindow: { from: '22:00', to: '06:00' } });
  await compiler.markDirty({ auths: ['a_noche'] });
  fs.resetStats();
  const res = await compiler.compileSite(SITE);
  assert.deepEqual(res.changed, ['doors', build.chunkNameForPerson('noauth')].sort());
  assert.ok(fs.stats.writes <= 4);
  const snap = await compiler.getCloudSnapshot(SITE);
  // sábado 23:00 y domingo 05:00 (cruce de medianoche) habilitados
  assert.equal(decideDni(snap, { dni: '30111444', door: 'P1', at: ar('2026-10-10', '23:00') }).decision, 'grant');
  assert.equal(decideDni(snap, { dni: '30111444', door: 'P1', at: ar('2026-10-11', '05:00') }).decision, 'grant');
  assert.equal(decideDni(snap, { dni: '30111444', door: 'P1', at: ar('2026-10-11', '10:00') }).reason, 'fuera_de_horario');
});

test('delta: visitas, puertas y operadores', async () => {
  const { fs, compiler } = setup();
  await compiler.compileSite(SITE, { full: true });

  fs.poke('visitas/v4', { nombreVisitante: 'Nueva', dniVisitanteNormalized: '40999000', estado: 'autorizada',
    fechaHoraEsperada: Timestamp.fromMillis(ar(TODAY, '10:30')), allowedDoorIds: ['P2'] });
  fs.poke('visitas/v1', { ...fs.peek('visitas/v1'), estado: 'cancelada' });
  await compiler.markDirty({ visitas: ['v4', 'v1'] });
  fs.resetStats();
  let res = await compiler.compileSite(SITE);
  assert.deepEqual(res.changed, ['passes']);
  assert.ok(fs.stats.reads <= 10 && fs.stats.writes <= 3, fs.stats.log.join(' | '));
  const passes = chunkBody(fs, 'passes');
  assert.deepEqual(passes.passes.map((p) => p.id), ['v4']);
  assert.deepEqual(passes.revoked, ['pass:v1', 'pass:v2']);

  const cfg = fs.peek('settings/doorsConfig');
  cfg.doors.push({ id: 'P3', name: 'Nueva', active: true, readers: [{ id: 'default', direction: 'ambos' }], pulseSeconds: 5 });
  fs.poke('settings/doorsConfig', cfg);
  await compiler.markDirty({ doors: true });
  res = await compiler.compileSite(SITE);
  assert.deepEqual(res.changed, ['doors']);
  const p3 = chunkBody(fs, 'doors').doors.find((d) => d.id === 'P3');
  assert.equal(p3.unlockSec, 5);
  assert.deepEqual(p3.readers, [], 'lector "ambos" no tiene lado fijo');
  assert.ok(chunkBody(fs, 'doors').schedules.length >= 2, 'conserva los horarios autogenerados');

  fs.poke('users/guardia2', { username: 'guardia2', password: '$2a$10$x', role: 'guardia', active: true });
  await compiler.markDirty({ operators: true });
  res = await compiler.compileSite(SITE);
  assert.deepEqual(res.changed, ['operators']);
  assert.ok(chunkBody(fs, 'operators').operators.some((o) => o.username === 'guardia2'));
});

test('getHead compila perezoso si hay cambios; cambio de día → completo', async () => {
  const { fs, compiler, clock } = setup();
  let head = await compiler.getHead(SITE);
  assert.equal(head.version, 1, 'sin head → compila');
  fs.resetStats();
  head = await compiler.getHead(SITE);
  assert.equal(head.version, 1);
  assert.equal(fs.stats.reads, 2, 'sin cambios: head + _dirty');
  assert.equal(fs.stats.writes, 0);

  fs.poke('people/perm24', { ...fs.peek('people/perm24'), allowedDoorIds: [] });
  await compiler.markDirty({ people: ['perm24'] });
  head = await compiler.getHead(SITE);
  assert.equal(head.version, 2);
  assert.equal(head.mode, 'delta');

  clock.now = ar('2026-10-09', '00:05');
  head = await compiler.getHead(SITE);
  assert.equal(head.version, 3);
  assert.equal(head.mode, 'full');
  assert.equal(head.day, '2026-10-09');
  assert.ok(!head.chunks['grants-20261007'], 'sale D-2');
  assert.ok(signing.verifyHead(head, signingKey.publicKeyPem));

  const got = await compiler.getChunks(SITE, ['doors', 'passes', 'no-existe']);
  assert.deepEqual(Object.keys(got).sort(), ['doors', 'passes']);
  assert.ok(Array.isArray(got.doors.doors), 'getChunks devuelve {name: body}');
});

test('mutación durante el compilado: la precondición fuerza reintento y no se pierde', async () => {
  const { fs, compiler } = setup();
  await compiler.compileSite(SITE, { full: true });
  fs.poke('people/perm24', { ...fs.peek('people/perm24'), allowedDoorIds: ['P2'] });
  await compiler.markDirty({ people: ['perm24'] });
  const run = compiler.compileSite(SITE);
  // entra otra mutación mientras compila
  fs.poke('people/noauth', { ...fs.peek('people/noauth'), allowedDoorIds: ['P2'] });
  await compiler.markDirty({ people: ['noauth'] });
  await run;
  const after = await compiler.getHead(SITE);
  assert.equal(fs.peek(`sites/${SITE}/compiled/_dirty`), undefined);
  const snap = await compiler.getCloudSnapshot(SITE);
  assert.equal(snap.version(), after.version);
  assert.equal(decideDni(snap, { dni: '30111333', door: 'P2', at: NOW }).decision, 'grant');
  assert.equal(decideDni(snap, { dni: '30111444', door: 'P2', at: NOW }).reason, 'sin_citacion_para_hoy');
  assert.equal(decideDni(snap, { dni: '30111444', door: 'P1', at: NOW }).reason, 'puerta_no_autorizada');
});

test('getCloudSnapshot: como mucho un chequeo de head cada 15 s y solo chunks cambiados', async () => {
  const { fs, compiler, clock } = setup();
  await compiler.compileSite(SITE, { full: true });
  fs.resetStats();
  const s1 = await compiler.getCloudSnapshot(SITE);
  const firstReads = fs.stats.reads;
  assert.equal(firstReads, 2 + Object.keys(headOf(fs).chunks).length - 1, 'head + _dirty + chunks (sin operators)');
  fs.resetStats();
  const s2 = await compiler.getCloudSnapshot(SITE);
  assert.equal(s2, s1);
  assert.equal(fs.stats.reads, 0, 'dentro de 15 s: cache');
  clock.now += 16000;
  await compiler.getCloudSnapshot(SITE);
  assert.equal(fs.stats.reads, 2, 'después de 15 s: head + _dirty');

  fs.poke('people/perm24', { ...fs.peek('people/perm24'), allowedDoorIds: ['P2'] });
  await compiler.markDirty({ people: ['perm24'] });
  fs.resetStats();
  const s3 = await compiler.getCloudSnapshot(SITE);
  assert.equal(s3.version(), 2);
  assert.ok(fs.stats.reads <= 40, `${fs.stats.reads}`);
  assert.ok(fs.stats.log.filter((l) => l.startsWith('R1 getAll') || l.startsWith('R2 getAll')).length >= 1);
});

test('markDirty nunca rechaza (fire-and-forget) y agrupa ids', async () => {
  const broken = createSiteCompiler({ deps: () => { throw new Error('sin firestore'); }, autoCompile: false });
  const orig = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try {
    assert.equal(await broken.markDirty({ people: ['x'] }), false);
  } finally {
    console.error = orig;
  }
  assert.ok(logged.some((l) => l.includes('markDirty')));

  const { fs, compiler } = setup();
  await compiler.markDirty({ people: ['a', 'b'] });
  await compiler.markDirty('principal', { people: 'b', auths: ['z'], doors: true });
  const dirty = fs.peek(`sites/${SITE}/compiled/_dirty`);
  assert.deepEqual(dirty.people, ['a', 'b']);
  assert.deepEqual(dirty.auths, ['z']);
  assert.equal(dirty.doors, true);
  assert.equal(dirty.rev, 2);
  assert.equal(await compiler.markDirty({}), false);
  const many = Array.from({ length: 400 }, (_, i) => `p${i}`);
  await compiler.markDirty({ people: many });
  assert.equal(fs.peek(`sites/${SITE}/compiled/_dirty`).full, true);
});

test('hashCredential: compatibilidad hacia atrás y HMAC con clave', () => {
  const plain = crypto.createHash('sha256').update('dni:30111222').digest('hex');
  assert.equal(hashCredential('dni', '30.111.222'), plain);
  assert.equal(hashCredential('dni', '30.111.222', null), plain);
  const key = Buffer.alloc(32, 7);
  const hmac = crypto.createHmac('sha256', key).update('dni:30111222').digest('hex');
  assert.equal(hashCredential('dni', '30111222', key), hmac);
  assert.equal(hashCredential('dni', '30111222', key.toString('base64')), hmac);
  assert.equal(hashCredential('dni', '', key), null);
});

test('buckets estables y horarios autogenerados deduplicados', () => {
  assert.equal(build.bucketOf('perm1'), build.bucketOf('perm1'));
  assert.match(build.chunkNameForPerson('perm1'), /^ch-\d{2}$/);
  const a = build.buildAutoSchedule({ daysOfWeek: ['Lu', 'Ma'], timeWindow: { from: '8:00', to: '17:00' }, before: 15, after: 15 });
  const b = build.buildAutoSchedule({ daysOfWeek: ['Ma', 'Lu', 'Fe'], timeWindow: { from: '08:00', to: '17:00' }, before: 15, after: 15 });
  assert.equal(a.id, b.id);
  assert.equal(build.buildAutoSchedule({ daysOfWeek: [], timeWindow: null }), null);
  assert.equal(build.localToMs('2026-10-08', '24:00'), ar('2026-10-09', '00:00'));
});
