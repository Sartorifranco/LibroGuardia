const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const firestorePath = require.resolve('../firestore');
const doorAllowlistPath = require.resolve('../lib/doorAllowlist');
const dataVersionsPath = require.resolve('../lib/dataVersions');

const installMocks = ({ meta = null, dataVer = { people: 1, authorizations: 1, doors: 1 }, allowlist } = {}) => {
  const written = [];
  const increments = [];

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      db: {
        collection(name) {
          return {
            doc(id) {
              return {
                async get() {
                  if (name === 'settings' && id === 'dataVersions') {
                    return { exists: true, data: () => ({ ...dataVer }) };
                  }
                  if (name === 'allowlist_cache') {
                    if (!meta) return { exists: false, data: () => ({}) };
                    return { exists: true, data: () => ({ ...meta }) };
                  }
                  return { exists: false, data: () => ({}) };
                },
                async set(payload, opts) {
                  written.push({ name, id, payload, opts });
                  if (payload.people && payload.people.__increment) {
                    increments.push('people');
                  }
                }
              };
            }
          };
        }
      },
      FieldValue: {
        serverTimestamp: () => 'SERVER_TS',
        increment: (n) => ({ __increment: n })
      }
    }
  };

  require.cache[doorAllowlistPath] = {
    id: doorAllowlistPath,
    filename: doorAllowlistPath,
    loaded: true,
    exports: {
      buildDoorAllowlist: async (doorId) => allowlist || {
        doorId,
        generatedAt: '2026-08-05T12:00:00.000Z',
        count: 2,
        entries: [{ dniNormalized: '111' }, { dniNormalized: '222' }]
      }
    }
  };

  delete require.cache[dataVersionsPath];
  delete require.cache[require.resolve('../lib/allowlistCache')];
  return { written, increments };
};

describe('allowlistCache', () => {
  beforeEach(() => {
    delete require.cache[require.resolve('../lib/allowlistCache')];
    delete require.cache[dataVersionsPath];
  });

  it('responde unchanged si la versión del cliente coincide y el padrón no cambió', async () => {
    installMocks({
      meta: {
        version: 7,
        dateBucket: '2099-01-01', // se sobreescribe con today real — ver abajo
        count: 2,
        peopleVer: 1,
        authorizationsVer: 1,
        doorsVer: 1,
        generatedAt: '2026-08-05T10:00:00.000Z'
      },
      dataVer: { people: 1, authorizations: 1, doors: 1 }
    });

    const { resolveDoorAllowlist, dateBucketAR } = require('../lib/allowlistCache');
    const today = dateBucketAR();

    // Reinstalar con dateBucket = hoy
    installMocks({
      meta: {
        version: 7,
        dateBucket: today,
        count: 2,
        peopleVer: 1,
        authorizationsVer: 1,
        doorsVer: 1,
        generatedAt: '2026-08-05T10:00:00.000Z'
      },
      dataVer: { people: 1, authorizations: 1, doors: 1 }
    });
    const mod = require('../lib/allowlistCache');

    const res = await mod.resolveDoorAllowlist('puerta-p1', {
      clientVersion: 7,
      clientDateBucket: today
    });

    assert.equal(res.unchanged, true);
    assert.equal(res.version, 7);
    assert.equal(res.count, 2);
    assert.ok(!res.entries, 'no debe mandar el payload completo');
  });

  it('reconstruye si cambió la versión de people', async () => {
    const today = (() => {
      installMocks();
      return require('../lib/allowlistCache').dateBucketAR();
    })();

    const { written } = installMocks({
      meta: {
        version: 3,
        dateBucket: today,
        count: 1,
        peopleVer: 1,
        authorizationsVer: 1,
        doorsVer: 1
      },
      dataVer: { people: 9, authorizations: 1, doors: 1 },
      allowlist: {
        doorId: 'puerta-p1',
        generatedAt: '2026-08-05T15:00:00.000Z',
        count: 5,
        entries: [{ dniNormalized: '999' }]
      }
    });

    const { resolveDoorAllowlist } = require('../lib/allowlistCache');
    const res = await resolveDoorAllowlist('puerta-p1', { clientVersion: 3 });

    assert.equal(res.unchanged, false);
    assert.equal(res.version, 4);
    assert.equal(res.count, 5);
    assert.equal(res.entries.length, 1);
    assert.ok(written.some((w) => w.name === 'allowlist_cache'));
  });

  it('force=1 reconstruye aunque la versión coincida', async () => {
    const today = (() => {
      installMocks();
      return require('../lib/allowlistCache').dateBucketAR();
    })();

    installMocks({
      meta: {
        version: 2,
        dateBucket: today,
        count: 1,
        peopleVer: 1,
        authorizationsVer: 1,
        doorsVer: 1
      },
      dataVer: { people: 1, authorizations: 1, doors: 1 }
    });

    const { resolveDoorAllowlist } = require('../lib/allowlistCache');
    const res = await resolveDoorAllowlist('puerta-p1', {
      clientVersion: 2,
      force: true
    });

    assert.equal(res.unchanged, false);
    assert.equal(res.version, 3);
  });
});
