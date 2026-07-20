const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  REPORTS_PERMISSION,
  MAX_RANGE_DAYS,
  aggregateReports,
  buildReportsSummary,
  eachYmdInRange
} = require('../reports');

const ts = (iso) => ({ toDate: () => new Date(iso) });

describe('reports summary', () => {
  it('usa el permiso reports.export (contrato del endpoint)', () => {
    assert.equal(REPORTS_PERMISSION, 'reports.export');
  });

  it('agrega ingresos/egresos por tipo y día, ignorando fuera de rango', () => {
    const summary = aggregateReports({
      from: '2026-07-10',
      to: '2026-07-12',
      entryDocs: [
        // dentro: personal ingreso 10
        {
          type: 'personal',
          movementType: 'ingreso',
          timestamp: ts('2026-07-10T12:00:00-03:00')
        },
        // dentro: personal egreso 10
        {
          type: 'personal',
          movementType: 'egreso',
          timestamp: ts('2026-07-10T18:00:00-03:00')
        },
        // dentro: vehiculo 11
        {
          type: 'vehiculo',
          movementType: 'ingreso',
          timestamp: ts('2026-07-11T09:00:00-03:00')
        },
        // GPS vehiculo → flota
        {
          type: 'vehiculo',
          movementType: 'ingreso',
          gpsAuto: true,
          timestamp: ts('2026-07-11T10:00:00-03:00')
        },
        // excepcional
        {
          type: 'personal',
          movementType: 'ingreso',
          exceptionalEntry: true,
          timestamp: ts('2026-07-12T08:00:00-03:00')
        },
        // fuera de rango (antes)
        {
          type: 'personal',
          movementType: 'ingreso',
          timestamp: ts('2026-07-09T12:00:00-03:00')
        },
        // fuera de rango (después)
        {
          type: 'flota',
          movementType: 'egreso',
          timestamp: ts('2026-07-13T12:00:00-03:00')
        },
        // novedad no suma a tipos operativos
        {
          type: 'novedad',
          movementType: 'ingreso',
          timestamp: ts('2026-07-11T12:00:00-03:00')
        }
      ],
      accessEventDocs: []
    });

    assert.equal(summary.from, '2026-07-10');
    assert.equal(summary.to, '2026-07-12');
    assert.equal(summary.dailySeries.length, 3);

    const day10 = summary.dailySeries.find((d) => d.date === '2026-07-10');
    assert.equal(day10.personalIngreso, 1);
    assert.equal(day10.personalEgreso, 1);

    const day11 = summary.dailySeries.find((d) => d.date === '2026-07-11');
    assert.equal(day11.vehiculoIngreso, 1);
    assert.equal(day11.flotaIngreso, 1);

    assert.equal(summary.totals.personal.ingreso, 2); // 10 + excepcional 12
    assert.equal(summary.totals.personal.egreso, 1);
    assert.equal(summary.totals.vehiculo.ingreso, 1);
    assert.equal(summary.totals.flota.ingreso, 1);
    assert.equal(summary.totals.exceptionalEntries, 1);
    assert.equal(summary.totals.entriesScanned, 6); // 5 operativos en rango + 1 novedad
  });

  it('rankea top denegados por persona y por puerta', () => {
    const summary = aggregateReports({
      from: '2026-07-01',
      to: '2026-07-31',
      entryDocs: [],
      accessEventDocs: [
        { type: 'denied', idNumber: '111', name: 'Ana', doorId: 'd1', doorName: 'Molinete A', createdAt: ts('2026-07-05T10:00:00-03:00') },
        { type: 'denied', idNumber: '111', name: 'Ana', doorId: 'd1', doorName: 'Molinete A', createdAt: ts('2026-07-05T10:05:00-03:00') },
        { type: 'denied', idNumber: '111', name: 'Ana', doorId: 'd2', doorName: 'Portón', createdAt: ts('2026-07-06T10:00:00-03:00') },
        { type: 'denied', idNumber: '222', name: 'Bruno', doorId: 'd1', doorName: 'Molinete A', createdAt: ts('2026-07-07T10:00:00-03:00') },
        { type: 'granted', idNumber: '111', name: 'Ana', doorId: 'd1', createdAt: ts('2026-07-08T10:00:00-03:00') },
        // fuera de rango
        { type: 'denied', idNumber: '111', name: 'Ana', doorId: 'd1', createdAt: ts('2026-06-01T10:00:00-03:00') }
      ]
    });

    assert.equal(summary.topDenialsByPerson[0].key, '111');
    assert.equal(summary.topDenialsByPerson[0].count, 3);
    assert.equal(summary.topDenialsByPerson[1].key, '222');
    assert.equal(summary.topDenialsByPerson[1].count, 1);

    assert.equal(summary.topDenialsByDoor[0].key, 'd1');
    assert.equal(summary.topDenialsByDoor[0].count, 3);
    assert.equal(summary.topDenialsByDoor[1].key, 'd2');
    assert.equal(summary.topDenialsByDoor[1].count, 1);
    assert.equal(summary.totals.denialsScanned, 4);
  });

  it('eachYmdInRange cubre extremos inclusive', () => {
    assert.deepEqual(eachYmdInRange('2026-07-01', '2026-07-03'), [
      '2026-07-01',
      '2026-07-02',
      '2026-07-03'
    ]);
  });

  it('buildReportsSummary valida fechas y rango máximo', async () => {
    const fakeDb = {
      collection() {
        return {
          where() { return this; },
          orderBy() { return this; },
          limit() { return this; },
          startAfter() { return this; },
          async get() { return { empty: true, docs: [] }; }
        };
      }
    };

    await assert.rejects(
      () => buildReportsSummary(fakeDb, { from: 'malo', to: '2026-07-01' }),
      (err) => err.status === 400
    );

    await assert.rejects(
      () => buildReportsSummary(fakeDb, { from: '2026-07-10', to: '2026-07-01' }),
      (err) => err.status === 400 && /posterior/.test(err.message)
    );

    await assert.rejects(
      () => buildReportsSummary(fakeDb, { from: '2026-01-01', to: '2026-05-01' }),
      (err) => err.status === 400 && /máximo/.test(err.message)
    );
    assert.ok(MAX_RANGE_DAYS < 120);

    const ok = await buildReportsSummary(fakeDb, { from: '2026-07-01', to: '2026-07-07' });
    assert.equal(ok.dailySeries.length, 7);
    assert.equal(ok.totals.exceptionalEntries, 0);
  });
});
