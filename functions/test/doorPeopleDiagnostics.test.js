const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const firestorePath = require.resolve('../firestore');
const diagnosticsPath = require.resolve('../lib/doorPeopleDiagnostics');

const installMock = ({ people = [], decidirAccesoFn } = {}) => {
  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      db: {
        collection() {
          return {
            where() { return this; },
            limit() { return this; },
            async get() {
              return {
                docs: people.map((p) => ({
                  id: p.id,
                  data: () => ({ ...p })
                }))
              };
            }
          };
        }
      },
      FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' }
    }
  };
  delete require.cache[diagnosticsPath];
  const api = require('../lib/doorPeopleDiagnostics');
  return {
    api,
    decidirAccesoFn: decidirAccesoFn || (async ({ resolvedPerson }) => {
      if (resolvedPerson?.person?.active === false) {
        return { authorized: false, denialReason: 'persona_inactiva' };
      }
      if (!resolvedPerson?.dniNormalized) {
        return { authorized: false, denialReason: 'no_encontrado' };
      }
      return { authorized: true, authorizationType: 'permanent', denialReason: null };
    })
  };
};

describe('doorPeopleDiagnostics', () => {
  let originalFs;

  beforeEach(() => {
    originalFs = require.cache[firestorePath];
  });

  afterEach(() => {
    if (originalFs) require.cache[firestorePath] = originalFs;
    else delete require.cache[firestorePath];
    delete require.cache[diagnosticsPath];
  });

  it('marca DNI vacío, duplicado e inactiva; cuenta quién puede pasar', async () => {
    const bag = installMock({
      people: [
        {
          id: 'p1',
          name: 'Ana Ok',
          idNumber: '111',
          dniNormalized: '111',
          active: true,
          allowedDoorIds: ['puerta-p1']
        },
        {
          id: 'p2',
          name: 'Sin Dni',
          idNumber: '',
          active: true,
          allowedDoorIds: ['puerta-p1']
        },
        {
          id: 'p3',
          name: 'Dup A',
          idNumber: '222',
          dniNormalized: '222',
          active: true,
          allowedDoorIds: ['puerta-p1']
        },
        {
          id: 'p4',
          name: 'Dup B',
          idNumber: '222',
          dniNormalized: '222',
          active: true,
          allowedDoorIds: ['puerta-p1']
        },
        {
          id: 'p5',
          name: 'Inactiva',
          idNumber: '333',
          dniNormalized: '333',
          active: false,
          allowedDoorIds: ['puerta-p1']
        }
      ]
    });

    const result = await bag.api.diagnoseDoorPeople('puerta-p1', {
      decidirAccesoFn: bag.decidirAccesoFn
    });

    assert.equal(result.summary.assigned, 5);
    assert.equal(result.summary.canPassNow, 2); // Ana + Dup A
    assert.equal(result.summary.blocked, 3);

    const byId = Object.fromEntries(result.people.map((p) => [p.id, p]));
    assert.equal(byId.p1.canPassNow, true);
    assert.equal(byId.p2.canPassNow, false);
    assert.ok(byId.p2.issues.some((i) => i.code === 'dni_vacio'));
    assert.equal(byId.p3.canPassNow, true);
    assert.equal(byId.p4.canPassNow, false);
    assert.ok(byId.p4.issues.some((i) => i.code === 'dni_duplicado'));
    assert.equal(byId.p5.canPassNow, false);
    assert.ok(byId.p5.issues.some((i) => i.code === 'persona_inactiva'));
  });
});
