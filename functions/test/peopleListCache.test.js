const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const firestorePath = require.resolve('../firestore');

const installMocks = ({ peopleVer = 5, metaVer = 3, metaPeopleVer = 5 } = {}) => {
  const written = [];
  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      db: {
        collection() {
          return {
            doc(id) {
              return {
                async get() {
                  if (id === 'dataVersions') {
                    return { exists: true, data: () => ({ people: peopleVer, authorizations: 0, doors: 0 }) };
                  }
                  if (id === 'peopleListCache') {
                    return {
                      exists: metaVer > 0,
                      data: () => ({ version: metaVer, peopleVer: metaPeopleVer, count: 10 })
                    };
                  }
                  return { exists: false, data: () => ({}) };
                },
                async set(payload) {
                  written.push(payload);
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
  delete require.cache[require.resolve('../lib/dataVersions')];
  delete require.cache[require.resolve('../lib/peopleListCache')];
  return { written };
};

describe('peopleListCache', () => {
  it('unchanged cuando clientVersion coincide y people no bumpeó', async () => {
    installMocks({ peopleVer: 5, metaVer: 3, metaPeopleVer: 5 });
    const { resolvePeopleListVersion } = require('../lib/peopleListCache');
    const res = await resolvePeopleListVersion(3);
    assert.equal(res.unchanged, true);
    assert.equal(res.version, 3);
  });

  it('needs rebuild si people bumpeó', async () => {
    installMocks({ peopleVer: 8, metaVer: 3, metaPeopleVer: 5 });
    const { resolvePeopleListVersion } = require('../lib/peopleListCache');
    const res = await resolvePeopleListVersion(3);
    assert.equal(res.unchanged, false);
    assert.equal(res.needsRebuild, true);
    assert.equal(res.version, 4);
  });

  it('sin clientVersion siempre rebuild', async () => {
    installMocks({ peopleVer: 5, metaVer: 3, metaPeopleVer: 5 });
    const { resolvePeopleListVersion } = require('../lib/peopleListCache');
    const res = await resolvePeopleListVersion(undefined);
    assert.equal(res.unchanged, false);
    assert.equal(res.version, 3);
  });
});
