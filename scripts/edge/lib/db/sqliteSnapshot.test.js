'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SKIP, DRIVER, tmpDir, rmDir, makeHead, doorsBody, cardholderChunks } = require('./_testkit');
const { openEdgeDb } = require('./index');

const SNAP_METHODS = ['findCredential', 'cardholder', 'rightsFor', 'schedule', 'isHoliday', 'door',
  'interlockGroup', 'pass', 'isRevoked', 'policy'];

function siteBodies() {
  return {
    doors: doorsBody(),
    'ch-00': {
      bucket: 0,
      cardholders: [
        { id: 'ana', status: 'active', name: 'Ana', accessLevels: ['grp_planta'], shiftScheduleId: 'sch_turno_m', credentials: [{ type: 'dni', valueHash: 'h_ana' }] },
        { id: 'beto', status: 'active', name: 'Beto', accessAll: true, credentials: [{ type: 'dni', valueHash: 'h_dup' }] }
      ]
    },
    'ch-07': {
      bucket: 7,
      cardholders: [
        { id: 'caro', status: 'active', name: 'Caro', requiresGrant: true, credentials: [{ type: 'dni', valueHash: 'h_dup' }, { type: 'qr', valueHash: 'h_qr', status: 'revoked' }] }
      ]
    },
    'grants-20261008': { date: '2026-10-08', grants: [{ id: 'g1', cardholderId: 'caro', doors: ['p1'], from: 100, to: 200, source: 'citacion', refId: 'cit_1' }] },
    passes: {
      passes: [
        { id: 'qr_a', dni: '30111222', doors: ['p1'], validFrom: '2026-10-01T00:00:00Z', validTo: '2026-10-01T23:59:59Z' },
        { id: 'qr_b', dni: '30111222', doors: ['p1'], validFrom: '2026-10-08T00:00:00Z', validTo: '2026-10-08T23:59:59Z' }
      ],
      revoked: ['qr_a']
    }
  };
}

describe('SqliteSnapshot (interfaz snap del motor)', { skip: SKIP }, () => {
  const dirs = [];
  after(() => dirs.forEach(rmDir));

  it('implementa todos los métodos de la interfaz', () => {
    const e = openEdgeDb(':memory:', { role: 'controller', deviceId: 'ctl-a', myDoorIds: ['p1', 'p2'] });
    try {
      for (const m of SNAP_METHODS) assert.equal(typeof e.snapshot[m], 'function', m);
    } finally {
      e.db.close();
    }
  });

  it('responde sobre datos de chunks sintéticos', () => {
    const e = openEdgeDb(':memory:', { role: 'controller', deviceId: 'ctl-a', myDoorIds: ['p1', 'p2'] });
    const snap = e.snapshot;
    try {
      const bodies = siteBodies();
      assert.equal(e.chunks.applyHead(makeHead(9, bodies), bodies).applied, true);
      snap.refresh();
      assert.equal(snap.version(), 9);

      assert.deepEqual(snap.findCredential('dni', 'h_ana'), { type: 'dni', valueHash: 'h_ana', cardholderId: 'ana', status: 'active', validFrom: null, validTo: null });
      assert.equal(snap.findCredential('dni', 'nadie'), null);
      const dup = snap.findCredential('dni', 'h_dup');
      assert.equal(dup.status, 'duplicate');
      assert.deepEqual(dup.cardholderIds, ['beto', 'caro']);
      assert.equal(snap.findCredential('qr', 'h_qr').status, 'revoked');

      const ana = snap.cardholder('ana');
      assert.equal(ana.name, 'Ana');
      assert.equal(ana.accessAll, false);
      assert.equal(ana.shiftScheduleId, 'sch_turno_m');
      assert.deepEqual(ana.accessLevels, ['grp_planta']);
      assert.equal(snap.cardholder('beto').accessAll, true);
      assert.equal(snap.cardholder('caro').requiresGrant, true);
      assert.equal(snap.cardholder('zz'), null);

      assert.deepEqual(snap.rightsFor('ana', 'p1'), [{ doorId: 'p1', scheduleId: 'sch_turno_m', source: 'group', refId: 'grp_planta', validFrom: null, validTo: null }]);
      assert.deepEqual(snap.rightsFor('ana', 'p3'), [], 'p3 no es de este controlador');
      assert.deepEqual(snap.rightsFor('beto', 'p1'), [], 'accessAll no se explota en rights');
      assert.deepEqual(snap.rightsFor('caro', 'p1'), [{ doorId: 'p1', scheduleId: null, source: 'citacion', refId: 'cit_1', validFrom: 100, validTo: 200 }]);

      assert.deepEqual(snap.schedule('sch_turno_m').days, [1, 2, 3, 4, 5]);
      assert.equal(snap.schedule('24x7').always, true);
      assert.equal(snap.schedule('no_existe'), null);
      assert.equal(snap.isHoliday('2026-10-12', 'AR'), true);
      assert.equal(snap.isHoliday('2026-10-12'), true);
      assert.equal(snap.isHoliday('2026-10-12', 'UY'), false);
      assert.equal(snap.isHoliday('2026-10-13', 'AR'), false);

      assert.equal(snap.door('p1').controllerId, 'ctl-a');
      assert.equal(snap.door('p9'), null);
      assert.equal(snap.interlockGroup('p2').id, 'est1');
      assert.equal(snap.interlockGroup('p3'), null);

      assert.equal(snap.pass('qr_a').id, 'qr_a');
      assert.equal(snap.pass('30111222').id, 'qr_b', 'por DNI devuelve el pase más reciente');
      assert.equal(snap.pass('nada'), null);
      assert.equal(snap.isRevoked('qr_a'), true);
      assert.equal(snap.isRevoked('qr_b'), false);
      assert.equal(snap.policy().apb, 'soft');
      assert.equal(snap.site().tz, 'America/Argentina/Buenos_Aires');
    } finally {
      e.db.close();
    }
  });

  it('refresh() invalida el caché de config tras aplicar un head nuevo', () => {
    const e = openEdgeDb(':memory:', { role: 'hub', deviceId: 'hub-1' });
    try {
      let bodies = { doors: doorsBody() };
      e.chunks.applyHead(makeHead(1, bodies), bodies);
      assert.equal(e.snapshot.refresh().door('p1').name, 'Puerta 1');
      const doors = doorsBody();
      doors.doors[0].name = 'Portón';
      bodies = { doors };
      e.chunks.applyHead(makeHead(2, bodies), bodies);
      assert.equal(e.snapshot.refresh().door('p1').name, 'Portón');
    } finally {
      e.db.close();
    }
  });

  it(`micro benchmark: 5.000 personas / 10.000 credenciales (driver ${DRIVER})`, () => {
    const dir = tmpDir();
    dirs.push(dir);
    const e = openEdgeDb(path.join(dir, 'bench.db'), { role: 'controller', deviceId: 'ctl-a', myDoorIds: ['p1', 'p2'] });
    try {
      const people = cardholderChunks(5000);
      const bodies = { doors: doorsBody(), ...people };
      const t0 = process.hrtime.bigint();
      const r = e.chunks.applyHead(makeHead(1, bodies), bodies);
      const applyMs = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.equal(r.applied, true);
      assert.equal(e.db.get('SELECT COUNT(*) AS n FROM cardholders').n, 5000);
      assert.equal(e.db.get('SELECT COUNT(*) AS n FROM credentials').n, 10000);
      const rightsRows = e.db.get('SELECT COUNT(*) AS n FROM rights').n;

      const snap = e.snapshot.refresh();
      const N = 20000;
      let found = 0;
      // calentamiento
      for (let i = 0; i < 500; i += 1) snap.rightsFor(snap.findCredential('dni', `h_dni_${i}`).cardholderId, 'p1');
      const t1 = process.hrtime.bigint();
      for (let k = 0; k < N; k += 1) {
        const i = (k * 7919) % 5000;
        const cred = snap.findCredential(k % 2 ? 'card' : 'dni', `${k % 2 ? 'h_card' : 'h_dni'}_${i}`);
        snap.cardholder(cred.cardholderId);
        found += snap.rightsFor(cred.cardholderId, k % 3 ? 'p1' : 'p2').length;
      }
      const perLookupMs = Number(process.hrtime.bigint() - t1) / 1e6 / N;
      // eslint-disable-next-line no-console
      console.log(`[bench edge/db] driver=${DRIVER} applyHead(5000 personas, 10000 credenciales, ${rightsRows} rights)=${applyMs.toFixed(0)} ms; `
        + `findCredential+cardholder+rightsFor = ${(perLookupMs * 1000).toFixed(1)} µs/lookup (${N} lookups, ${found} rights encontrados)`);
      assert.ok(found > 0);
      assert.ok(perLookupMs < 2, `lookup ${perLookupMs} ms > 2 ms`);
    } finally {
      e.db.close();
    }
  });
});
