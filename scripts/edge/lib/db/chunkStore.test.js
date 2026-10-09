'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, makeHead, doorsBody } = require('./_testkit');
const { open } = require('./driver');
const { migrate, readMeta } = require('./migrations');
const { ChunkStore, ChunkHashError, canonicalJson, hashBody } = require('./chunkStore');

function setup({ role = 'controller', myDoorIds = ['p1', 'p2'], deviceId = null } = {}) {
  const db = open(':memory:');
  migrate(db, { role });
  return { db, store: new ChunkStore(db, { role, myDoorIds, deviceId }) };
}

const ch00 = () => ({
  bucket: 0,
  cardholders: [
    {
      id: 'ana', status: 'active', name: 'Ana', accessLevels: ['grp_planta'],
      credentials: [{ type: 'dni', valueHash: 'h_ana' }]
    },
    { id: 'beto', status: 'active', name: 'Beto', accessAll: true, credentials: [{ type: 'dni', valueHash: 'h_beto' }] },
    { id: 'caro', status: 'active', name: 'Caro', doors: [{ doorId: 'p2', scheduleId: 'sch_turno_m' }, { doorId: 'p4' }] },
    { id: 'dani', status: 'active', name: 'Dani', accessLevels: ['grp_total'] }
  ]
});

const ch01 = () => ({
  bucket: 1,
  cardholders: [{ id: 'eli', status: 'inactive', name: 'Eli', allowedDoorIds: ['p1', 'p3'] }],
  credentials: [{ type: 'card', valueHash: 'h_eli_card', cardholderId: 'eli' }]
});

function rights(db, id) {
  return db.all('SELECT door_id, schedule_id, source, ref_id FROM rights WHERE cardholder_id = ? ORDER BY door_id, source', id);
}

describe('chunkStore', { skip: SKIP }, () => {
  it('canonicalJson ordena claves y el hash no depende del orden', () => {
    assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: null }], u: undefined }), '{"a":[{"c":null,"d":2}],"b":1}');
    assert.equal(hashBody({ x: 1, y: 2 }), hashBody('{"y":2,"x":1}'));
  });

  it('storeChunk verifica el hash y marca verified; un hash incorrecto no guarda nada', () => {
    const { db, store } = setup();
    try {
      const body = doorsBody();
      const r = store.storeChunk('doors', 3, body, { expectedHash: `sha256:${hashBody(body)}` });
      assert.equal(r.verified, true);
      assert.equal(store.getChunk('doors').verified, true);
      assert.equal(store.verifyChunk('doors'), true);
      assert.throws(() => store.storeChunk('passes', 3, { passes: [] }, { expectedHash: 'deadbeef' }), ChunkHashError);
      assert.equal(store.getChunk('passes'), null);
      db.run("UPDATE chunks SET body = '{\"doors\":[]}' WHERE name = 'doors'");
      assert.equal(store.verifyChunk('doors'), false, 'cuerpo alterado en disco → no verificado');
    } finally {
      db.close();
    }
  });

  it('applyHead materializa todo y rechaza versiones viejas (stale) e iguales (up_to_date)', () => {
    const { db, store } = setup();
    try {
      const bodies = { doors: doorsBody(), 'ch-00': ch00(), 'ch-01': ch01() };
      const head = makeHead(5, bodies);
      assert.deepEqual(store.needsChunks(head), ['ch-00', 'ch-01', 'doors']);
      const r = store.applyHead(head, bodies);
      assert.equal(r.applied, true);
      assert.deepEqual(r.changed, ['doors', 'ch-00', 'ch-01']);
      assert.equal(store.configVersion(), 5);
      assert.deepEqual(store.needsChunks(head), []);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM doors').n, 4);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM schedules').n, 2);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM holidays').n, 2);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM interlocks').n, 1);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM cardholders').n, 5);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM credentials').n, 3);
      assert.deepEqual(JSON.parse(readMeta(db, 'policy')).apb, 'soft');

      assert.deepEqual(store.applyHead(head, {}), { applied: false, reason: 'up_to_date', current: 5 });
      const old = makeHead(4, { ...bodies, 'ch-00': { bucket: 0, cardholders: [] } });
      assert.deepEqual(store.applyHead(old, { 'ch-00': { bucket: 0, cardholders: [] } }), { applied: false, reason: 'stale', current: 5 });
      assert.equal(db.get('SELECT COUNT(*) AS n FROM cardholders').n, 5, 'la versión vieja no tocó nada');
      assert.deepEqual(store.applyChunk('ch-00', { bucket: 0, cardholders: [] }, { configVersion: 4 }).reason, 'stale');
    } finally {
      db.close();
    }
  });

  it('rights solo para myDoorIds; accessAll queda como flag sin filas; grp_total se limita a mis puertas', () => {
    const { db, store } = setup({ myDoorIds: ['p1', 'p2'] });
    try {
      const bodies = { doors: doorsBody(), 'ch-00': ch00(), 'ch-01': ch01() };
      store.applyHead(makeHead(1, bodies), bodies);
      assert.deepEqual(rights(db, 'ana'), [{ door_id: 'p1', schedule_id: 'sch_turno_m', source: 'group', ref_id: 'grp_planta' }]);
      assert.deepEqual(rights(db, 'beto'), []);
      assert.equal(JSON.parse(db.get("SELECT flags_json FROM cardholders WHERE id = 'beto'").flags_json).accessAll, true);
      assert.deepEqual(rights(db, 'caro'), [{ door_id: 'p2', schedule_id: 'sch_turno_m', source: 'direct', ref_id: null }]);
      assert.deepEqual(rights(db, 'dani').map((r) => r.door_id), ['p1', 'p2']);
      assert.deepEqual(rights(db, 'eli'), [{ door_id: 'p1', schedule_id: '24x7', source: 'direct', ref_id: null }]);
      const doors = db.all('SELECT DISTINCT door_id FROM rights ORDER BY door_id').map((r) => r.door_id);
      assert.deepEqual(doors, ['p1', 'p2']);
    } finally {
      db.close();
    }
  });

  it('controller sin myDoorIds deriva sus puertas de doors.controllerId; el hub materializa todas', () => {
    const bodies = { doors: doorsBody(), 'ch-00': ch00() };
    const c = setup({ myDoorIds: null, deviceId: 'ctl-b' });
    const h = setup({ role: 'hub', myDoorIds: null });
    try {
      c.store.applyHead(makeHead(1, bodies), bodies);
      h.store.applyHead(makeHead(1, bodies), bodies);
      assert.deepEqual(c.db.all('SELECT DISTINCT door_id FROM rights ORDER BY 1').map((r) => r.door_id), ['p3', 'p4']);
      assert.deepEqual(h.db.all('SELECT DISTINCT door_id FROM rights ORDER BY 1').map((r) => r.door_id), ['p1', 'p2', 'p3', 'p4']);
      assert.deepEqual(rights(h.db, 'dani').map((r) => r.door_id), ['p1', 'p2', 'p3', 'p4']);
    } finally {
      c.db.close();
      h.db.close();
    }
  });

  it('reemplazo por bucket: cambiar ch-00 no toca ch-01; cambiar un grupo rematerializa', () => {
    const { db, store } = setup({ myDoorIds: ['p1', 'p2', 'p3', 'p4'] });
    try {
      let bodies = { doors: doorsBody(), 'ch-00': ch00(), 'ch-01': ch01() };
      store.applyHead(makeHead(1, bodies), bodies);
      const newCh00 = { bucket: 0, cardholders: [{ id: 'ana', status: 'active', accessLevels: ['grp_planta'], credentials: [{ type: 'dni', valueHash: 'h_ana2' }] }] };
      bodies = { ...bodies, 'ch-00': newCh00 };
      const r = store.applyHead(makeHead(2, bodies), { 'ch-00': newCh00 });
      assert.deepEqual(r.changed, ['ch-00']);
      assert.deepEqual(db.all('SELECT id FROM cardholders ORDER BY id').map((x) => x.id), ['ana', 'eli']);
      assert.deepEqual(db.all('SELECT value_hash FROM credentials ORDER BY 1').map((x) => x.value_hash), ['h_ana2', 'h_eli_card']);
      assert.equal(rights(db, 'caro').length, 0);
      assert.equal(rights(db, 'eli').length, 2);

      // grp_planta pasa a solo p4 → se rehacen los rights de ana sin bajar su bucket
      const doors = doorsBody();
      doors.accessGroups[1] = { id: 'grp_planta', doors: ['p4'], scheduleId: 'sch_turno_m' };
      bodies = { ...bodies, doors };
      assert.deepEqual(store.applyHead(makeHead(3, bodies), { doors }).changed, ['doors']);
      assert.deepEqual(rights(db, 'ana'), [{ door_id: 'p4', schedule_id: 'sch_turno_m', source: 'group', ref_id: 'grp_planta' }]);
      assert.equal(rights(db, 'eli').length, 2);
    } finally {
      db.close();
    }
  });

  it('grants del día, pases y revocaciones; un grants que sale del head se borra', () => {
    const { db, store } = setup({ myDoorIds: ['p1', 'p2'] });
    try {
      const grants = {
        date: '2026-10-08',
        grants: [
          { id: 'g1', cardholderId: 'caro', doors: ['p1', 'p3'], from: '2026-10-08T10:00:00Z', to: '2026-10-08T12:00:00Z', source: 'citacion', refId: 'cit_9' },
          { id: 'g2', cardholderId: 'eli', doors: '*', from: 1, to: 2, source: 'visita' }
        ]
      };
      const passes = {
        passes: [{ id: 'qr_1', dni: '30111222', doors: ['p1'], validFrom: '2026-10-08T08:00:00Z', validTo: '2026-10-08T23:59:59Z', estado: 'activo' }],
        revoked: ['qr_viejo', 'cred_x']
      };
      let bodies = { doors: doorsBody(), 'ch-00': ch00(), 'grants-20261008': grants, passes };
      store.applyHead(makeHead(1, bodies), bodies);
      const g = db.all("SELECT cardholder_id, door_id, source, ref_id, valid_from, valid_to FROM rights WHERE chunk = 'grants-20261008' ORDER BY 1, 2");
      assert.deepEqual(g, [
        { cardholder_id: 'caro', door_id: 'p1', source: 'citacion', ref_id: 'cit_9', valid_from: Date.parse('2026-10-08T10:00:00Z'), valid_to: Date.parse('2026-10-08T12:00:00Z') },
        { cardholder_id: 'eli', door_id: 'p1', source: 'visita', ref_id: 'g2', valid_from: 1, valid_to: 2 },
        { cardholder_id: 'eli', door_id: 'p2', source: 'visita', ref_id: 'g2', valid_from: 1, valid_to: 2 }
      ]);
      assert.equal(db.get("SELECT dni FROM passes WHERE id = 'qr_1'").dni, '30111222');
      assert.equal(db.get('SELECT COUNT(*) AS n FROM revocations').n, 2);

      const { 'grants-20261008': _drop, ...rest } = bodies;
      bodies = { ...rest, 'grants-20261009': { date: '2026-10-09', grants: [] } };
      const r = store.applyHead(makeHead(2, bodies), { 'grants-20261009': bodies['grants-20261009'] });
      assert.deepEqual(r.removed, ['grants-20261008']);
      assert.equal(db.get("SELECT COUNT(*) AS n FROM rights WHERE source IN ('citacion', 'visita')").n, 0);
      assert.equal(store.getChunk('grants-20261008'), null);
    } finally {
      db.close();
    }
  });

  it('applyChunk suelto: monotónico por versión de chunk', () => {
    const { db, store } = setup();
    try {
      store.applyHead(makeHead(1, { doors: doorsBody() }), { doors: doorsBody() });
      assert.equal(store.applyChunk('grants-20261010', { grants: [{ cardholderId: 'x', doors: ['p1'] }] }, { version: 3 }).applied, true);
      assert.equal(db.get("SELECT COUNT(*) AS n FROM rights WHERE chunk = 'grants-20261010'").n, 1);
      assert.deepEqual(store.applyChunk('grants-20261010', { grants: [] }, { version: 2 }).reason, 'stale');
      assert.equal(db.get("SELECT COUNT(*) AS n FROM rights WHERE chunk = 'grants-20261010'").n, 1);
      assert.equal(store.applyChunk('bogus', {}).reason, 'unknown_chunk');
    } finally {
      db.close();
    }
  });

  it('operators solo en el hub; el controlador ni lo pide ni lo guarda', () => {
    const operators = { operators: [{ username: 'guardia1', hash: '$2b$10$abc', passwordVersion: 2, perms: ['puertas.abrir'], posts: ['porteria'] }] };
    const bodies = { doors: doorsBody(), operators };
    const c = setup();
    const h = setup({ role: 'hub', myDoorIds: null });
    try {
      const head = makeHead(1, bodies);
      assert.deepEqual(c.store.needsChunks(head), ['doors']);
      assert.equal(c.store.applyHead(head, { doors: bodies.doors }).applied, true);
      assert.equal(c.store.getChunk('operators'), null);
      assert.equal(h.store.applyHead(head, bodies).applied, true);
      assert.deepEqual(h.db.get('SELECT username, hash, pwd_version FROM operators'), { username: 'guardia1', hash: '$2b$10$abc', pwd_version: 2 });
    } finally {
      c.db.close();
      h.db.close();
    }
  });

  it('faltantes, hash incorrecto y firma inválida no aplican nada', () => {
    const { db, store } = setup();
    try {
      const bodies = { doors: doorsBody(), 'ch-00': ch00() };
      const head = makeHead(1, bodies);
      assert.deepEqual(store.applyHead(head, { doors: bodies.doors }), { applied: false, reason: 'missing_chunks', missing: ['ch-00'] });
      assert.throws(() => store.applyHead(head, { doors: bodies.doors, 'ch-00': { bucket: 0, cardholders: [] } }), ChunkHashError);
      assert.equal(store.configVersion(), 0);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM doors').n, 0);
      const signed = new ChunkStore(db, { verifyHead: (h) => h.sig === 'ok' });
      assert.equal(signed.applyHead(head, bodies).reason, 'bad_signature');
    } finally {
      db.close();
    }
  });

  it('una falla a mitad de la materialización revierte todo (versión y tablas)', () => {
    const { db, store } = setup();
    try {
      const v1 = { doors: doorsBody(), 'ch-00': ch00() };
      store.applyHead(makeHead(1, v1), v1);
      const v2 = { doors: doorsBody({ doorCount: 6 }), 'ch-00': { bucket: 0, cardholders: [] } };
      const orig = store.applyCardholders.bind(store);
      store.applyCardholders = () => { throw new Error('corte simulado'); };
      assert.throws(() => store.applyHead(makeHead(2, v2), v2), /corte simulado/);
      store.applyCardholders = orig;
      assert.equal(store.configVersion(), 1);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM doors').n, 4);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM cardholders').n, 4);
      assert.equal(store.getChunk('ch-00').hash, hashBody(v1['ch-00']));
      assert.equal(store.applyHead(makeHead(2, v2), v2).applied, true);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM doors').n, 6);
    } finally {
      db.close();
    }
  });

  it('chunk secrets: lo guardan hub y controlador, es parte del todo-o-nada y pasa a meta', () => {
    for (const role of ['hub', 'controller']) {
      const { db, store } = setup({ role });
      try {
        const secrets = { secrets: { credentialKey: 'a2V5LWRlLXBydWViYQ==', keyId: 'k1', alg: 'HMAC-SHA256' } };
        const v1 = { doors: doorsBody(), secrets };
        assert.equal(store.isRelevant('secrets'), true);
        assert.deepEqual(store.needsChunks(makeHead(1, v1)), ['doors', 'secrets']);
        const sinSecrets = store.applyHead(makeHead(1, v1), { doors: v1.doors });
        assert.deepEqual(sinSecrets, { applied: false, reason: 'missing_chunks', missing: ['secrets'] });
        assert.equal(store.applyHead(makeHead(1, v1), v1).applied, true);
        assert.equal(readMeta(db, 'credential_key'), 'a2V5LWRlLXBydWViYQ==');
        assert.equal(readMeta(db, 'credential_key_id'), 'k1');
        assert.deepEqual(store.getChunk('secrets').body, secrets);
        // head sin secrets → se borra
        const v2 = { doors: doorsBody() };
        assert.equal(store.applyHead(makeHead(2, v2), v2).applied, true);
        assert.equal(readMeta(db, 'credential_key'), null);
        assert.equal(store.getChunk('secrets'), null);
      } finally {
        db.close();
      }
    }
  });

  it('pases con dniHash se indexan en passes.dni', () => {
    const { db, store } = setup();
    try {
      const v1 = { doors: doorsBody(), passes: { passes: [{ id: 'QR1', dniHash: 'f'.repeat(64), doors: ['p1'] }, { id: 'QR2', dni: '123', doors: ['p1'] }] } };
      assert.equal(store.applyHead(makeHead(1, v1), v1).applied, true);
      assert.equal(db.get('SELECT id FROM passes WHERE dni = ?', 'f'.repeat(64)).id, 'QR1');
      assert.equal(db.get('SELECT id FROM passes WHERE dni = ?', '123').id, 'QR2');
    } finally {
      db.close();
    }
  });
});
