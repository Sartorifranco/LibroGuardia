const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/**
 * evaluateAirlockForOpen lee doorAirlockStates vía Firestore.
 * En CI no hay credenciales: mockeamos firestore antes de cargar el módulo.
 */
const loadDoorControllerWithAirlock = (airlockByGroupId = {}) => {
  const firestorePath = require.resolve('../firestore');
  const doorControllerPath = require.resolve('../doorController');

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
                  if (name !== 'doorAirlockStates') {
                    return { exists: false, data: () => ({}) };
                  }
                  const data = airlockByGroupId[id];
                  return {
                    exists: Boolean(data),
                    data: () => (data ? { ...data } : {})
                  };
                },
                async set() {
                  return undefined;
                }
              };
            },
            async add() {
              return { id: 'event-1' };
            }
          };
        }
      },
      FieldValue: {
        serverTimestamp: () => 'SERVER_TIMESTAMP'
      },
      Timestamp: {}
    }
  };

  delete require.cache[doorControllerPath];
  return require('../doorController');
};

describe('doorController airlock', () => {
  const group = {
    id: 'estanco-1',
    name: 'Ingreso estanco',
    outerCloseDelayMs: 1000,
    interDoorDelayMs: 500,
    transitTimeoutMs: 60000
  };

  const outerDoor = { id: 'ext', name: 'Exterior', airlockRole: 'outer', airlockGroupId: 'estanco-1' };
  const innerDoor = { id: 'int', name: 'Interior', airlockRole: 'inner', airlockGroupId: 'estanco-1' };

  it('permite abrir puerta exterior cuando estanco idle', async () => {
    const { evaluateAirlockForOpen } = loadDoorControllerWithAirlock({});
    const result = await evaluateAirlockForOpen({
      door: outerDoor,
      group,
      bypassAirlock: false,
      manual: false
    });
    assert.equal(result.allowed, true);
  });

  it('bloquea interior si exterior sigue abierta', async () => {
    const { evaluateAirlockForOpen } = loadDoorControllerWithAirlock({
      'estanco-1': { phase: 'outer_open' }
    });
    const result = await evaluateAirlockForOpen({
      door: innerDoor,
      group,
      bypassAirlock: false,
      manual: false
    });
    assert.equal(result.allowed, false);
  });

  it('manual bypass permite abrir interior', async () => {
    const { evaluateAirlockForOpen } = loadDoorControllerWithAirlock({
      'estanco-1': { phase: 'outer_open' }
    });
    const result = await evaluateAirlockForOpen({
      door: innerDoor,
      group,
      bypassAirlock: false,
      manual: true
    });
    assert.equal(result.allowed, true);
  });
});
