const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createSyncHealth,
  buildHeartbeatPayload,
  runEventSync,
  runUserSync
} = require('./biostarEventSync');

const makeEvents = (n, startMs = Date.parse('2026-08-15T04:00:00.000Z')) => Array.from(
  { length: n },
  (_, i) => ({ id: `e${i}`, datetime: new Date(startMs + i * 1000).toISOString() })
);

/** BioStar falso: devuelve eventos con datetime >= since, en orden, hasta limit. */
const fakeBiostar = (all) => ({
  calls: 0,
  async searchEventsSince({ sinceIso, limit }) {
    this.calls += 1;
    return all.filter((e) => e.datetime >= sinceIso).slice(0, limit);
  }
});

/** MSS falso que acepta todo y devuelve el cursor del último evento. */
const fakeMss = ({ failOnCall = null } = {}) => ({
  posted: [],
  async importEvents(payload) {
    this.posted.push(payload.events.length);
    if (failOnCall && this.posted.length === failOnCall) {
      throw new Error('MSS POST /admin/biostar/import-events → 502');
    }
    const last = payload.events[payload.events.length - 1];
    return {
      accepted: payload.events.length,
      skipped: 0,
      processed: payload.events.length,
      partial: false,
      cursorDatetime: last.datetime
    };
  }
});

const baseCfg = {
  defaultDoorId: 'puerta-p2',
  eventsBatchSize: 50,
  eventsFetchLimit: 200,
  eventsMaxRounds: 20,
  eventsLookbackHours: 24
};

describe('runEventSync', () => {
  it('manda lotes de 50 y guarda el cursor después de cada lote', async () => {
    const all = makeEvents(120);
    const saved = [];
    let state = { lastEventDatetime: '2026-08-15T03:59:00.000Z' };
    const mss = fakeMss();
    const health = createSyncHealth();
    const result = await runEventSync({
      biostar: fakeBiostar(all),
      mss,
      cfg: baseCfg,
      loadState: () => state,
      saveState: (s) => { state = s; saved.push(s.lastEventDatetime); },
      health
    });
    assert.deepEqual(mss.posted, [50, 50, 20]);
    assert.equal(saved.length, 3);
    assert.equal(state.lastEventDatetime, all[119].datetime);
    assert.equal(result.accepted, 120);
    assert.equal(health.backlogEstimate, 0);
    assert.ok(health.lastSuccessAt);
    assert.equal(health.events.ok, true);
  });

  it('si falla un lote, lo anterior queda importado y el cursor no retrocede', async () => {
    const all = makeEvents(120);
    let state = { lastEventDatetime: '2026-08-15T03:59:00.000Z' };
    const health = createSyncHealth();
    await assert.rejects(runEventSync({
      biostar: fakeBiostar(all),
      mss: fakeMss({ failOnCall: 2 }),
      cfg: baseCfg,
      loadState: () => state,
      saveState: (s) => { state = s; },
      health
    }), /502/);
    assert.equal(state.lastEventDatetime, all[49].datetime);
    assert.match(health.lastError, /502/);
    assert.ok(health.lastErrorAt);
    assert.equal(health.lastSuccessAt, null);
    assert.equal(health.backlogEstimate, 70);
  });

  it('drena un atraso grande en varias páginas dentro del mismo ciclo', async () => {
    const all = makeEvents(450);
    let state = { lastEventDatetime: '2026-08-15T03:59:00.000Z' };
    const biostar = fakeBiostar(all);
    const health = createSyncHealth();
    const result = await runEventSync({
      biostar,
      mss: fakeMss(),
      cfg: baseCfg,
      loadState: () => state,
      saveState: (s) => { state = s; },
      health
    });
    assert.equal(state.lastEventDatetime, all[449].datetime);
    assert.ok(biostar.calls >= 3);
    // Re-pide desde cursor-1 s: el borde se repite y MSS lo deduplica.
    assert.ok(result.accepted >= 450);
  });

  it('éxito parcial del servidor: avanza hasta donde llegó y manda el resto', async () => {
    const all = makeEvents(50);
    let state = { lastEventDatetime: '2026-08-15T03:59:00.000Z' };
    const sizes = [];
    const mss = {
      async importEvents({ events }) {
        sizes.push(events.length);
        const n = sizes.length === 1 ? 20 : events.length;
        return {
          accepted: n,
          processed: n,
          partial: n < events.length,
          cursorDatetime: events[n - 1].datetime
        };
      }
    };
    await runEventSync({
      biostar: fakeBiostar(all),
      mss,
      cfg: baseCfg,
      loadState: () => state,
      saveState: (s) => { state = s; },
      health: createSyncHealth()
    });
    assert.deepEqual(sizes, [50, 30]);
    assert.equal(state.lastEventDatetime, all[49].datetime);
  });
});

describe('heartbeat del puente', () => {
  it('incluye último éxito, último error, cursor y atraso con "hace X ms"', () => {
    const now = Date.parse('2026-10-08T15:00:00.000Z');
    const payload = buildHeartbeatPayload({
      ...createSyncHealth(),
      lastSuccessAt: '2026-10-08T14:59:00.000Z',
      lastError: 'Pases: 502',
      lastErrorAt: '2026-10-08T14:58:00.000Z',
      cursor: '2026-08-15T03:54:14.000Z',
      backlogEstimate: 200
    }, { nowMs: now, hostname: 'SIS5' });
    assert.equal(payload.lastSuccessAgoMs, 60000);
    assert.equal(payload.lastErrorAgoMs, 120000);
    assert.equal(payload.cursor, '2026-08-15T03:54:14.000Z');
    assert.equal(payload.backlogEstimate, 200);
    assert.equal(payload.hostname, 'SIS5');
  });

  it('usuarios en lotes y error informado', async () => {
    const health = createSyncHealth();
    const calls = [];
    await runUserSync({
      users: Array.from({ length: 120 }, (_, i) => ({ user_id: String(i) })),
      mss: { async importUsers({ users }) { calls.push(users.length); return { updated: users.length }; } },
      cfg: { usersBatchSize: 50 },
      health
    });
    assert.deepEqual(calls, [50, 50, 20]);
    assert.equal(health.users.updated, 120);
    assert.equal(health.users.biostarTotal, 120);
  });
});
