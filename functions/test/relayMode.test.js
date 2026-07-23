const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  RELAY_MODES,
  shouldAttemptRelay,
  resolveRelayMode,
  buildLocalRelayPayload
} = require('../lib/relayDispatch');
const { normalizeDoorsConfig } = require('../lib/doorsConfig');

/* ───────────────────────── unit: relayDispatch (puro) ───────────────────────── */

describe('relayDispatch — decisión de disparo', () => {
  it('RELAY_MODES expone cloud y local', () => {
    assert.deepEqual(RELAY_MODES, ['cloud', 'local']);
  });

  it('resolveRelayMode: default cloud, local explícito, valor raro → cloud', () => {
    assert.equal(resolveRelayMode({}), 'cloud');
    assert.equal(resolveRelayMode({ relayMode: 'local' }), 'local');
    assert.equal(resolveRelayMode({ relayMode: 'cloud' }), 'cloud');
    assert.equal(resolveRelayMode({ relayMode: 'otra-cosa' }), 'cloud');
    assert.equal(resolveRelayMode(undefined), 'cloud');
  });

  it('shouldAttemptRelay reproduce el gating actual (shouldTryRelay)', () => {
    const base = {
      isGuardDesk: false,
      movementType: 'ingreso',
      authorized: true,
      config: { enabled: true, triggerOn: 'ingreso' },
      door: { autoOpenOnAuth: true }
    };
    assert.equal(shouldAttemptRelay(base), true);

    // Cada condición que hoy bloquea el disparo debe seguir bloqueándolo.
    assert.equal(shouldAttemptRelay({ ...base, isGuardDesk: true }), false);
    assert.equal(shouldAttemptRelay({ ...base, movementType: 'egreso' }), false);
    assert.equal(shouldAttemptRelay({ ...base, authorized: false }), false);
    assert.equal(shouldAttemptRelay({ ...base, config: { enabled: false, triggerOn: 'ingreso' } }), false);
    assert.equal(shouldAttemptRelay({ ...base, config: { enabled: true, triggerOn: 'egreso' } }), false);
    assert.equal(shouldAttemptRelay({ ...base, door: { autoOpenOnAuth: false } }), false);
  });

  it('buildLocalRelayPayload arma host/puerto/canal/pulso desde el relayConfig', () => {
    const payload = buildLocalRelayPayload({
      driver: 'sr201',
      host: '192.168.0.38',
      port: 6722,
      relayChannel: 2,
      pulseMode: 'timed',
      pulseSeconds: 7
    });
    assert.deepEqual(payload, {
      driver: 'sr201',
      host: '192.168.0.38',
      port: 6722,
      channel: 2,
      pulseMode: 'timed',
      pulseSeconds: 7
    });
  });

  it('buildLocalRelayPayload aplica defaults sanos', () => {
    const payload = buildLocalRelayPayload({});
    assert.equal(payload.driver, 'sr201');
    assert.equal(payload.port, 6722);
    assert.equal(payload.channel, 1);
    assert.equal(payload.pulseMode, 'timed');
    assert.equal(payload.pulseSeconds, 3);
  });
});

/* ───────────────────────── unit: doorsConfig.relayMode ───────────────────────── */

describe('doorsConfig — relayMode por puerta', () => {
  it('default cloud si no se especifica (retrocompatible)', () => {
    const config = normalizeDoorsConfig({
      doors: [{ id: 'p1', name: 'P1', device: { host: '10.0.0.1' } }]
    });
    assert.equal(config.doors[0].relayMode, 'cloud');
  });

  it('acepta local explícito', () => {
    const config = normalizeDoorsConfig({
      doors: [{ id: 'p1', name: 'P1', relayMode: 'local' }]
    });
    assert.equal(config.doors[0].relayMode, 'local');
  });

  it('valor inválido cae a cloud', () => {
    const config = normalizeDoorsConfig({
      doors: [{ id: 'p1', name: 'P1', relayMode: 'satelite' }]
    });
    assert.equal(config.doors[0].relayMode, 'cloud');
  });
});

/* ─────────────── integración: processKioskScan cloud vs local ───────────────── */

const firestorePath = require.resolve('../firestore');
const functionsRoot = path.dirname(firestorePath);

const clearFunctionsCache = () => {
  Object.keys(require.cache).forEach((key) => {
    if (key.startsWith(functionsRoot) && !key.includes(`${path.sep}node_modules${path.sep}`)) {
      delete require.cache[key];
    }
  });
};

const makeFirestoreMock = ({ settings = {}, collections = {} } = {}) => {
  const settingsDocs = { ...settings };
  const stores = {
    people: [],
    authorizations: [],
    personalMaster: [],
    entries: [],
    accessEvents: [],
    doorAirlockStates: [],
    ...collections
  };

  const makeQuery = (name, filters = []) => ({
    where(f, op, v) { return makeQuery(name, [...filters, { f, op, v }]); },
    limit(n) { return makeQuery(name, [...filters, { limit: n }]); },
    orderBy() { return makeQuery(name, filters); },
    async get() {
      const arr = stores[name] || [];
      const lim = filters.find((x) => x.limit != null);
      const active = filters.filter((x) => x.limit == null);
      let rows = arr.filter((doc) => active.every(({ f, op, v }) => {
        const val = doc[f];
        if (op === '==') return val === v;
        if (op === 'in') return Array.isArray(v) && v.includes(val);
        if (op === '<=') return val <= v;
        if (op === '>=') return val >= v;
        return true;
      }));
      if (lim) rows = rows.slice(0, lim.limit);
      return {
        empty: rows.length === 0,
        size: rows.length,
        docs: rows.map((r) => ({
          id: r.id,
          ref: { async set() {}, async update() {} },
          data: () => ({ ...r })
        }))
      };
    }
  });

  const makeCollection = (name) => {
    if (name === 'settings') {
      return {
        doc(id) {
          return {
            async get() {
              const d = settingsDocs[id];
              return { exists: d != null, id, data: () => (d ? { ...d } : {}) };
            },
            async set(payload, opts = {}) {
              settingsDocs[id] = opts.merge
                ? { ...(settingsDocs[id] || {}), ...payload }
                : { ...payload };
            }
          };
        }
      };
    }
    const arr = stores[name] || (stores[name] = []);
    return {
      where(f, op, v) { return makeQuery(name, [{ f, op, v }]); },
      orderBy() { return makeQuery(name, []); },
      limit(n) { return makeQuery(name, [{ limit: n }]); },
      doc(id) {
        const realId = id || `auto-${Math.random().toString(36).slice(2)}`;
        return {
          id: realId,
          async get() {
            const d = arr.find((x) => x.id === realId);
            return { exists: Boolean(d), id: realId, data: () => (d ? { ...d } : undefined), ref: {} };
          },
          async set(payload, opts = {}) {
            const i = arr.findIndex((x) => x.id === realId);
            if (i >= 0) arr[i] = opts.merge ? { ...arr[i], ...payload } : { id: realId, ...payload };
            else arr.push({ id: realId, ...payload });
          },
          async update(payload) {
            const i = arr.findIndex((x) => x.id === realId);
            if (i >= 0) arr[i] = { ...arr[i], ...payload };
            else arr.push({ id: realId, ...payload });
          }
        };
      },
      async add(payload) {
        const id = `${name}-${arr.length + 1}`;
        arr.push({ id, ...payload });
        return { id };
      }
    };
  };

  return {
    db: { collection: makeCollection },
    FieldValue: {
      serverTimestamp: () => 'SERVER_TIMESTAMP',
      increment: (n) => ({ __inc: n }),
      arrayUnion: (...a) => ({ __arrayUnion: a })
    },
    Timestamp: {},
    stores,
    settingsDocs
  };
};

const buildDoorsSettings = () => ({
  doorsConfig: {
    defaultDoorId: 'puerta-cloud',
    doors: [
      {
        id: 'puerta-cloud',
        name: 'Puerta Cloud',
        relayMode: 'cloud',
        autoOpenOnAuth: true,
        authMethods: ['dni', 'credential'],
        readers: [{ id: 'INGRESO_P1', direction: 'ingreso' }],
        readerIds: ['INGRESO_P1'],
        pulseSeconds: 3,
        // Driver HTTP genérico → openDoor dispara vía fetch (mockeado) sin red real.
        device: { driver: 'generic_http', httpUrl: 'https://relay.example/open', httpMethod: 'POST' }
      },
      {
        id: 'puerta-local',
        name: 'Puerta Local',
        relayMode: 'local',
        autoOpenOnAuth: true,
        authMethods: ['dni', 'credential'],
        readers: [{ id: 'INGRESO_P1', direction: 'ingreso' }],
        readerIds: ['INGRESO_P1'],
        pulseSeconds: 5,
        device: { driver: 'sr201', host: '192.168.0.38', channel: 1, port: 6722 }
      }
    ]
  },
  accessControl: {
    enabled: true,
    triggerOn: 'ingreso',
    pulseMode: 'timed',
    pulseSeconds: 3,
    host: '',
    bridgeUrl: ''
  }
});

// Autorización por credencial (evita depender del parser de DNI en el test).
const CARD_AUTH = {
  id: 'auth-card',
  active: true,
  credentialCode: 'ABC123',
  personId: null,
  type: 'credential',
  name: 'Tarjeta Test',
  allowedDoorIds: ['puerta-cloud', 'puerta-local']
};

const RAW = 'INGRESO_P1#CARD:ABC123';

describe('processKioskScan — cloud vs local', () => {
  let accessControl;
  let originalFirestore;
  let originalFetch;

  beforeEach(() => {
    originalFirestore = require.cache[firestorePath];
    originalFetch = global.fetch;

    const mock = makeFirestoreMock({
      settings: buildDoorsSettings(),
      collections: { authorizations: [{ ...CARD_AUTH }] }
    });

    clearFunctionsCache();
    require.cache[firestorePath] = {
      id: firestorePath,
      filename: firestorePath,
      loaded: true,
      exports: mock
    };
    accessControl = require('../accessControl');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearFunctionsCache();
    if (originalFirestore) require.cache[firestorePath] = originalFirestore;
    else delete require.cache[firestorePath];
  });

  after(() => {
    clearFunctionsCache();
  });

  it('cloud (default): la nube dispara el relé (comportamiento actual)', async () => {
    const fetchCalls = [];
    global.fetch = async (url, options) => {
      fetchCalls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const res = await accessControl.processKioskScan({
      rawData: RAW,
      username: 'kiosk',
      doorId: 'puerta-cloud',
      readerId: 'INGRESO_P1'
    });

    assert.equal(res.authorized, true);
    assert.equal(res.relayMode, 'cloud');
    assert.equal(res.relayTriggered, true, 'la nube debe disparar el relé en modo cloud');
    assert.equal(res.localRelay, null, 'cloud no devuelve datos de relé local');
    assert.equal(fetchCalls.length, 1, 'el disparo server-side debe ocurrir (fetch al relé)');
    assert.equal(fetchCalls[0].url, 'https://relay.example/open');
  });

  it('local: la nube NO dispara; devuelve datos para el bridge', async () => {
    const fetchCalls = [];
    global.fetch = async (url, options) => {
      fetchCalls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const res = await accessControl.processKioskScan({
      rawData: RAW,
      username: 'kiosk',
      doorId: 'puerta-local',
      readerId: 'INGRESO_P1'
    });

    assert.equal(res.authorized, true, 'la decisión de autorización no cambia');
    assert.equal(res.relayMode, 'local');
    assert.equal(res.relayTriggered, false, 'la nube NO dispara en modo local');
    assert.equal(fetchCalls.length, 0, 'el servidor no debe intentar disparar nada');
    assert.ok(res.localRelay, 'debe devolver datos de relé local');
    assert.deepEqual(res.localRelay, {
      driver: 'sr201',
      host: '192.168.0.38',
      port: 6722,
      channel: 1,
      pulseMode: 'timed',
      pulseSeconds: 5
    });
  });
});
