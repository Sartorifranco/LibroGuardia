const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDoorAllowlist,
  resolveValidUntil,
  combineDateAndTimeAr
} = require('../lib/doorAllowlist');

const doorsConfigPath = require.resolve('../lib/doorsConfig');
const accessStorePath = require.resolve('../lib/accessControlStore');
const firestorePath = require.resolve('../firestore');

const installSettingsMocks = ({ doorId = 'puerta-p1' } = {}) => {
  require.cache[doorsConfigPath] = {
    id: doorsConfigPath,
    filename: doorsConfigPath,
    loaded: true,
    exports: {
      getDoorsConfig: async () => ({
        doors: [{
          id: doorId,
          name: 'Puerta 1',
          active: true,
          relayMode: 'local',
          device: { host: '192.168.0.38', port: 6722, channel: 1 },
          pulseSeconds: 3,
          pulseMode: 'timed'
        }]
      }),
      findDoorById: (cfg, id) => (cfg.doors || []).find((d) => d.id === id) || null
    }
  };

  require.cache[accessStorePath] = {
    id: accessStorePath,
    filename: accessStorePath,
    loaded: true,
    exports: {
      getAccessControlConfig: async () => ({
        enabled: true,
        host: '192.168.0.38',
        port: 6722,
        relayChannel: 1,
        pulseMode: 'timed',
        pulseSeconds: 3
      })
    }
  };

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      db: {
        collection() {
          return mockQuery([]);
        }
      },
      FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' },
      Timestamp: { fromDate: (d) => d }
    }
  };

  delete require.cache[require.resolve('../lib/doorAllowlist')];
  delete require.cache[require.resolve('../doorController')];
  delete require.cache[require.resolve('../lib/relayDispatch')];
};

/**
 * Query mockeada que aplica de verdad los where de igualdad, para que los tests
 * vean el mismo subconjunto que vería Firestore.
 */
const mockQuery = (rows = [], log = null) => {
  const build = (current, filters) => ({
    where(field, op, value) {
      const next = filters.concat([{ field, op, value }]);
      if (op !== '==') return build(current, next);
      return build(current.filter((r) => r[field] === value), next);
    },
    limit() { return build(current, filters); },
    orderBy() { return build(current, filters); },
    async get() {
      if (log) log.push({ filters, leidos: current.length });
      return {
        empty: current.length === 0,
        size: current.length,
        docs: current.map((row) => ({
          id: row.id,
          ref: { id: row.id },
          data: () => {
            const { id, ...rest } = row;
            return rest;
          }
        }))
      };
    }
  });
  return build(rows, []);
};

describe('doorAllowlist', () => {
  it('resolveValidUntil usa fin de ventana de citación', () => {
    const until = resolveValidUntil({
      authorizationType: 'citacion',
      authorization: {
        type: 'citacion',
        appointmentDate: '2026-07-23',
        timeWindow: { from: '08:00', to: '12:30' }
      }
    }, new Date('2026-07-23T10:00:00-03:00'));
    assert.equal(until, combineDateAndTimeAr('2026-07-23', '12:30').toISOString());
  });

  it('buildDoorAllowlist solo incluye autorizados vigentes para esa puerta', async () => {
    const people = [
      {
        id: 'p-ok',
        dniNormalized: '11111111',
        nombre: 'Permitido Uno',
        allowedDoorIds: ['puerta-p1'],
        active: true
      },
      {
        id: 'p-other-door',
        dniNormalized: '22222222',
        nombre: 'Otra Puerta',
        allowedDoorIds: ['puerta-otra'],
        active: true
      },
      {
        id: 'p-inactive',
        dniNormalized: '33333333',
        nombre: 'Inactivo',
        allowedDoorIds: ['puerta-p1'],
        active: false
      }
    ];

    installSettingsMocks({ doorId: 'puerta-p1' });
    require.cache[firestorePath].exports.db = {
      collection(name) {
        return mockQuery(name === 'people' ? people : []);
      }
    };

    delete require.cache[require.resolve('../lib/doorAllowlist')];
    const { buildDoorAllowlist: build } = require('../lib/doorAllowlist');

    const decidirAccesoFn = async ({ dni, doorId, resolvedPerson }) => {
      const person = resolvedPerson?.person;
      if (!person || person.active === false) {
        return { authorized: false, denialReason: 'persona_inactiva', dniNormalized: dni };
      }
      const doors = person.allowedDoorIds || [];
      if (!doors.includes(doorId)) {
        return { authorized: false, denialReason: 'puerta_no_autorizada', dniNormalized: dni };
      }
      return {
        authorized: true,
        personId: person.id,
        personName: person.nombre,
        dniNormalized: dni,
        authorizationType: 'permanent',
        authorization: { type: 'permanent', id: 'auth-1' }
      };
    };

    const result = await build('puerta-p1', { decidirAccesoFn, concurrency: 4 });
    assert.equal(result.doorId, 'puerta-p1');
    assert.equal(result.relayMode, 'local');
    assert.equal(result.localRelay.host, '192.168.0.38');
    assert.equal(result.count, 1);
    assert.equal(result.entries[0].dniNormalized, '11111111');
    assert.equal(result.entries[0].nombre, 'Permitido Uno');
  });

  it('respeta ventana de visita vía decidirAcceso (no incluye fuera de ventana)', async () => {
    installSettingsMocks({ doorId: 'puerta-p1' });
    require.cache[firestorePath].exports.db = {
      collection(name) {
        return mockQuery(name === 'people' ? [{
          id: 'vis-person',
          dniNormalized: '44444444',
          nombre: 'Visitante',
          allowedDoorIds: [],
          active: true
        }] : []);
      }
    };

    delete require.cache[require.resolve('../lib/doorAllowlist')];
    const { buildDoorAllowlist: build } = require('../lib/doorAllowlist');

    const now = new Date('2026-07-23T15:00:00-03:00');
    const decidirAccesoFn = async ({ dni }) => {
      if (dni === '44444444') {
        return {
          authorized: false,
          denialReason: 'fuera_de_horario',
          dniNormalized: dni,
          authorizationType: null,
          authorization: null
        };
      }
      return { authorized: false, dniNormalized: dni };
    };

    const result = await build('puerta-p1', {
      decidirAccesoFn,
      referenceDate: now,
      concurrency: 2
    });
    assert.equal(result.count, 0);
  });

  it('path en lote: arma allowlist sin decidirAccesoFn (pocas lecturas)', async () => {
    const people = [
      {
        id: 'p-ok',
        dniNormalized: '11111111',
        nombre: 'Permitido Uno',
        allowedDoorIds: ['puerta-p1'],
        active: true
      },
      {
        id: 'p-other-door',
        dniNormalized: '22222222',
        nombre: 'Otra Puerta',
        allowedDoorIds: ['puerta-otra'],
        active: true
      },
      {
        id: 'p-inactive',
        dniNormalized: '33333333',
        nombre: 'Inactivo',
        allowedDoorIds: ['puerta-p1'],
        active: false
      },
      {
        id: 'p-no-auth',
        dniNormalized: '55555555',
        nombre: 'Sin Auth',
        allowedDoorIds: ['puerta-p1'],
        active: true
      }
    ];
    const authorizations = [
      {
        id: 'auth-ok',
        personId: 'p-ok',
        active: true,
        type: 'permanent'
      },
      {
        id: 'auth-other',
        personId: 'p-other-door',
        active: true,
        type: 'permanent'
      },
      {
        id: 'auth-inactive-person',
        personId: 'p-inactive',
        active: true,
        type: 'permanent'
      }
    ];

    const chainable = (docs) => {
      const q = {
        where() { return q; },
        limit() { return q; },
        async get() {
          return {
            empty: !docs.length,
            docs: docs.map((row) => ({
              id: row.id,
              data: () => {
                const { id, ...rest } = row;
                return rest;
              }
            }))
          };
        }
      };
      return q;
    };

    installSettingsMocks({ doorId: 'puerta-p1' });
    require.cache[firestorePath].exports.db = {
      collection(name) {
        if (name === 'people') return chainable(people);
        if (name === 'authorizations') return chainable(authorizations);
        if (name === 'visitas') return chainable([]);
        return chainable([]);
      }
    };

    delete require.cache[require.resolve('../lib/doorAllowlist')];
    delete require.cache[require.resolve('../lib/visitasAccess')];
    const { buildDoorAllowlist: build } = require('../lib/doorAllowlist');

    const result = await build('puerta-p1', {
      referenceDate: new Date('2026-07-23T10:00:00-03:00')
    });
    assert.equal(result.count, 1);
    assert.equal(result.entries[0].dniNormalized, '11111111');
    assert.equal(result.entries[0].authorizationType, 'permanent');
  });

  // Guarda del incidente del 31/7 al 4/8: el path viejo consultaba
  // authorizations por persona y la allowlist llegó a 226.562 lecturas por
  // llamada. Las lecturas tienen que ser constantes, no proporcionales al
  // padrón.
  it('las lecturas no crecen con la cantidad de personas', async () => {
    const countGetsFor = async (cantidadPersonas) => {
      const people = Array.from({ length: cantidadPersonas }, (_, i) => ({
        id: `p-${i}`,
        dniNormalized: String(10_000_000 + i),
        nombre: `Persona ${i}`,
        allowedDoorIds: ['puerta-p1'],
        active: true
      }));
      const authorizations = people.map((p, i) => ({
        id: `auth-${i}`,
        personId: p.id,
        active: true,
        type: 'permanent'
      }));

      let gets = 0;
      const chainable = (docs) => {
        const q = {
          where() { return q; },
          limit() { return q; },
          orderBy() { return q; },
          async get() {
            gets += 1;
            return {
              empty: !docs.length,
              docs: docs.map((row) => ({
                id: row.id,
                data: () => {
                  const { id, ...rest } = row;
                  return rest;
                }
              }))
            };
          }
        };
        return q;
      };

      installSettingsMocks({ doorId: 'puerta-p1' });
      require.cache[firestorePath].exports.db = {
        collection(name) {
          if (name === 'people') return chainable(people);
          if (name === 'authorizations') return chainable(authorizations);
          return chainable([]);
        }
      };

      delete require.cache[require.resolve('../lib/doorAllowlist')];
      delete require.cache[require.resolve('../lib/visitasAccess')];
      const { buildDoorAllowlist: build } = require('../lib/doorAllowlist');

      const result = await build('puerta-p1', {
        referenceDate: new Date('2026-07-23T10:00:00-03:00')
      });
      assert.equal(result.count, cantidadPersonas);
      return gets;
    };

    const pocas = await countGetsFor(5);
    const muchas = await countGetsFor(400);

    assert.equal(muchas, pocas, `80x más personas disparó ${muchas} consultas en vez de ${pocas}`);
    assert.ok(muchas <= 10, `la allowlist hizo ${muchas} consultas a Firestore, esperaba un puñado fijo`);
  });

  // Las fichas dadas de baja nunca entran a la allowlist, así que traerlas solo
  // cuesta lecturas: en agosto de 2026 eran 583 de las 847 de la colección.
  it('no lee las fichas inactivas', async () => {
    const people = [
      {
        id: 'activa',
        dniNormalized: '11111111',
        nombre: 'Activa Una',
        allowedDoorIds: ['puerta-p1'],
        active: true
      },
      ...Array.from({ length: 50 }, (_, i) => ({
        id: `baja-${i}`,
        dniNormalized: String(90_000_000 + i),
        nombre: `Baja ${i}`,
        allowedDoorIds: ['puerta-p1'],
        active: false
      }))
    ];
    const authorizations = [
      { id: 'auth-activa', personId: 'activa', active: true, type: 'permanent' }
    ];

    const log = [];
    installSettingsMocks({ doorId: 'puerta-p1' });
    require.cache[firestorePath].exports.db = {
      collection(name) {
        if (name === 'people') return mockQuery(people, log);
        if (name === 'authorizations') return mockQuery(authorizations);
        return mockQuery([]);
      }
    };

    delete require.cache[require.resolve('../lib/doorAllowlist')];
    delete require.cache[require.resolve('../lib/visitasAccess')];
    const { buildDoorAllowlist: build } = require('../lib/doorAllowlist');

    const result = await build('puerta-p1', {
      referenceDate: new Date('2026-07-23T10:00:00-03:00')
    });

    assert.equal(result.count, 1);
    assert.equal(result.entries[0].dniNormalized, '11111111');

    const consultaPeople = log[0];
    assert.ok(consultaPeople, 'se esperaba una consulta a people');
    assert.deepEqual(
      consultaPeople.filters,
      [{ field: 'active', op: '==', value: true }],
      'people tiene que consultarse filtrando por active'
    );
    assert.equal(
      consultaPeople.leidos,
      1,
      `se leyeron ${consultaPeople.leidos} fichas habiendo 50 dadas de baja`
    );
  });
});
