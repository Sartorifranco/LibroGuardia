/**
 * Decisión de acceso: casos de seguridad (fail-closed).
 * - DNI desconocido + homónimo → denegado, sin escribir DNI en otra ficha.
 * - DNI duplicado entre personas activas → dni_duplicado.
 * - Nómina / visita no reviven bajas (active=false).
 * - Fecha "hoy" en hora Argentina.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockFirestore, installFirestoreMock } = require('./helpers/mockFirestore');

const referenceDate = new Date('2026-07-03T14:30:00-03:00');

const homonimos = () => ([
  {
    id: 'p-juan-a',
    dniNormalized: '20111222',
    nombre: 'Juan Perez',
    nameKey: 'juan perez',
    active: true,
    allowedDoorIds: ['puerta-planta']
  }
]);

test('DNI desconocido con homónimo en people → denegado y no se escribe el DNI', async () => {
  const mock = createMockFirestore({
    people: [
      ...homonimos(),
      {
        id: 'p-juan-sin-dni',
        dniNormalized: null,
        nombre: 'Juan Perez',
        nameKey: 'juan perez',
        active: true,
        allowedDoorIds: ['puerta-planta']
      }
    ],
    authorizations: [
      { id: 'auth-a', personId: 'p-juan-a', type: 'permanent', active: true, name: 'Juan Perez', nameKey: 'juan perez' }
    ]
  });
  const accessControl = installFirestoreMock(mock);

  const result = await accessControl.decidirAcceso({
    dni: '33999888',
    nombre: 'Juan',
    apellido: 'Perez',
    tipoMovimiento: 'ingreso',
    doorId: 'puerta-planta',
    referenceDate
  });

  assert.equal(result.authorized, false);
  assert.equal(result.denialReason, 'no_encontrado');
  assert.equal(result.personId, null);
  assert.equal(mock.peopleUpdates.length, 0, 'nunca se graba el DNI leído en otra persona');
  // Solo se consultó people por DNI, nunca por nameKey.
  const fields = mock.peopleQueries.flat().map((f) => f.field).filter(Boolean);
  assert.ok(!fields.includes('nameKey'));
  // Tampoco se buscó autorización por nombre.
  const authFields = mock.authQueries.flat().map((f) => f.field);
  assert.ok(!authFields.includes('nameKey'));
  assert.ok(!authFields.includes('nameTokens'));
});

test('resolvePersonForValidarAcceso con DNI desconocido no resuelve por nombre', async () => {
  const mock = createMockFirestore({ people: homonimos() });
  const accessControl = installFirestoreMock(mock);
  const resolved = await accessControl.resolvePersonForValidarAcceso({
    dni: '33999888',
    nombre: 'Juan',
    apellido: 'Perez'
  });
  assert.equal(resolved.personId, null);
  assert.equal(resolved.resolutionPath, 'no_encontrado');
});

test('lectura SIN DNI: nameKey exacto con candidato único resuelve; con dos, no', async () => {
  const unico = createMockFirestore({ people: homonimos() });
  let accessControl = installFirestoreMock(unico);
  let resolved = await accessControl.resolvePersonForValidarAcceso({ dni: '', nombre: 'Juan', apellido: 'Perez' });
  assert.equal(resolved.personId, 'p-juan-a');
  assert.equal(resolved.resolutionPath, 'nameKey');
  assert.equal(unico.peopleUpdates.length, 0);

  const ambiguo = createMockFirestore({
    people: [
      ...homonimos(),
      { id: 'p-juan-b', dniNormalized: '27000111', nombre: 'Juan Perez', nameKey: 'juan perez', active: true }
    ]
  });
  accessControl = installFirestoreMock(ambiguo);
  resolved = await accessControl.resolvePersonForValidarAcceso({ dni: '', nombre: 'Juan', apellido: 'Perez' });
  assert.equal(resolved.personId, null);
  assert.equal(resolved.resolutionPath, 'nombre_ambiguo');
});

test('DNI compartido por dos personas ACTIVAS → dni_duplicado (denegado)', async () => {
  const mock = createMockFirestore({
    people: [
      { id: 'p-dup-1', dniNormalized: '30123456', nombre: 'Ana Uno', active: true, allowedDoorIds: ['puerta-planta'] },
      { id: 'p-dup-2', dniNormalized: '30123456', nombre: 'Ana Dos', active: true, allowedDoorIds: ['puerta-planta'] }
    ],
    authorizations: [
      { id: 'auth-dup-1', personId: 'p-dup-1', type: 'permanent', active: true }
    ]
  });
  const accessControl = installFirestoreMock(mock);
  const result = await accessControl.decidirAcceso({
    dni: '30123456',
    tipoMovimiento: 'ingreso',
    doorId: 'puerta-planta',
    referenceDate
  });
  assert.equal(result.authorized, false);
  assert.equal(result.denialReason, 'dni_duplicado');
  assert.equal(result.personId, null);
  // La consulta por DNI trae más de un doc (no limit(1)).
  const limit = mock.peopleQueries[0].find((f) => Object.prototype.hasOwnProperty.call(f, 'limit'));
  assert.ok(limit.limit > 1);
});

test('DNI repetido con una sola ficha activa (la otra de baja) → usa la activa', async () => {
  const mock = createMockFirestore({
    people: [
      { id: 'p-baja', dniNormalized: '30123456', nombre: 'Ana Vieja', active: false },
      { id: 'p-activa', dniNormalized: '30123456', nombre: 'Ana Activa', active: true, allowedDoorIds: ['puerta-planta'] }
    ],
    authorizations: [
      { id: 'auth-activa', personId: 'p-activa', type: 'permanent', active: true }
    ]
  });
  const accessControl = installFirestoreMock(mock);
  const result = await accessControl.decidirAcceso({
    dni: '30123456',
    tipoMovimiento: 'ingreso',
    doorId: 'puerta-planta',
    referenceDate
  });
  assert.equal(result.authorized, true);
  assert.equal(result.personId, 'p-activa');
});

test('visita aprobada NO revive a una persona de baja en people', async () => {
  const mock = createMockFirestore({
    people: [{ id: 'p-baja', dniNormalized: '28777666', nombre: 'Baja Visitante', active: false, allowedDoorIds: [] }],
    collections: {
      visitas: [{
        id: 'visita-1',
        dniVisitanteNormalized: '28777666',
        nombreVisitante: 'Baja Visitante',
        estado: 'autorizada',
        fechaHoraEsperada: new Date().toISOString(),
        allowedDoorIds: ['puerta-planta']
      }]
    }
  });
  const accessControl = installFirestoreMock(mock);
  const result = await accessControl.decidirAcceso({
    dni: '28777666',
    tipoMovimiento: 'ingreso',
    doorId: 'puerta-planta',
    referenceDate
  });
  assert.equal(result.authorized, false);
  assert.equal(result.denialReason, 'persona_inactiva');
  assert.equal(result.visitaId, null);
});

test('visita aprobada sigue autorizando a un visitante que no está en people', async () => {
  const mock = createMockFirestore({
    people: [],
    collections: {
      visitas: [{
        id: 'visita-2',
        dniVisitanteNormalized: '28777667',
        nombreVisitante: 'Visitante Externo',
        estado: 'autorizada',
        fechaHoraEsperada: new Date().toISOString(),
        allowedDoorIds: ['puerta-planta']
      }]
    }
  });
  const accessControl = installFirestoreMock(mock);
  const result = await accessControl.decidirAcceso({
    dni: '28777667',
    tipoMovimiento: 'ingreso',
    doorId: 'puerta-planta',
    referenceDate
  });
  assert.equal(result.authorized, true);
  assert.equal(result.visitaId, 'visita-2');
});

test('autorización de otra persona (otro DNI) no autoriza ni aporta puertas', async () => {
  const mock = createMockFirestore({
    people: [{ id: 'p-yo', dniNormalized: '25000001', nombre: 'Yo', active: true, allowedDoorIds: [] }],
    authorizations: [
      // Legacy por DNI pero vinculada a otra persona con otro DNI (dato corrupto).
      {
        id: 'auth-ajena',
        personId: 'p-otro',
        idNumberNormalized: '25000001',
        type: 'permanent',
        active: true,
        allowedDoorIds: ['puerta-planta']
      }
    ]
  });
  // El DNI coincide → misma identidad (ficha fusionada): se respeta.
  let accessControl = installFirestoreMock(mock);
  let result = await accessControl.decidirAcceso({
    dni: '25000001', tipoMovimiento: 'ingreso', doorId: 'puerta-planta', referenceDate
  });
  assert.equal(result.authorized, true);

  // Legacy por legajo (personalMaster) que apunta a una autorización de OTRA
  // persona con otro DNI → se descarta: no autoriza ni presta sus puertas.
  const ajena = createMockFirestore({
    people: [{ id: 'p-yo', dniNormalized: '25000001', nombre: 'Yo', active: true, allowedDoorIds: [] }],
    authorizations: [{
      id: 'auth-ajena',
      personId: 'p-otro',
      idNumberNormalized: '40000000',
      legajoNormalized: 'L-77',
      type: 'permanent',
      active: true,
      allowedDoorIds: ['puerta-planta']
    }],
    collections: {
      personalMaster: [{ id: 'pm-yo', idNumberNormalized: '25000001', legajoNormalized: 'L-77' }]
    }
  });
  accessControl = installFirestoreMock(ajena);
  result = await accessControl.decidirAcceso({
    dni: '25000001', tipoMovimiento: 'ingreso', doorId: 'puerta-planta', referenceDate
  });
  assert.equal(result.authorized, false);
  assert.equal(result.authorization, null);
  assert.deepEqual(result.allowedDoorIds, []);
});

test('nómina: canNominaOverrideDenial no revive bajas ni identidades no resueltas', () => {
  const { canNominaOverrideDenial } = require('../lib/accessNominaMessages');
  const activa = { id: 'p1', active: true };
  assert.equal(canNominaOverrideDenial({ person: activa, denialReason: 'sin_citacion_para_hoy' }), true);
  assert.equal(canNominaOverrideDenial({ person: { id: 'p1', active: false }, denialReason: 'sin_citacion_para_hoy' }), false);
  assert.equal(canNominaOverrideDenial({ person: activa, denialReason: 'persona_inactiva' }), false);
  assert.equal(canNominaOverrideDenial({ person: activa, denialReason: 'no_encontrado' }), false);
  assert.equal(canNominaOverrideDenial({ person: activa, denialReason: 'error_interno' }), false);
  assert.equal(canNominaOverrideDenial({ person: activa, denialReason: 'dni_duplicado' }), false);
  assert.equal(canNominaOverrideDenial({ person: null, denialReason: 'sin_citacion_para_hoy' }), false);
});

test('nómina: Sistemas solo autoriza a persona activa y en una puerta de su lista', async () => {
  const mock = createMockFirestore({});
  installFirestoreMock(mock);
  const { buildNominaAccessMessage } = require('../lib/accessNominaMessages');
  const prefetched = {
    employee: { id: 'pm-1', name: 'Tecnico Sistemas', centroCosto: 'Sistemas', active: true },
    citacionesToday: []
  };

  const baja = await buildNominaAccessMessage({
    personId: 'p-sis',
    dniNormalized: '31000000',
    prefetched,
    referenceDate,
    person: { id: 'p-sis', active: false, allowedDoorIds: ['puerta-planta'] },
    doorId: 'puerta-planta'
  });
  assert.equal(baja, null, 'persona de baja en people: sin override');

  const otraPuerta = await buildNominaAccessMessage({
    personId: 'p-sis',
    dniNormalized: '31000000',
    prefetched,
    referenceDate,
    person: { id: 'p-sis', active: true, allowedDoorIds: ['puerta-oficinas'] },
    doorId: 'puerta-planta'
  });
  assert.equal(otraPuerta, null, 'puerta fuera de allowedDoorIds: sin override');

  const sinPeople = await buildNominaAccessMessage({
    personId: null,
    dniNormalized: '31000000',
    prefetched,
    referenceDate,
    person: null,
    doorId: 'puerta-planta'
  });
  assert.equal(sinPeople, null, 'no está en people: sin override');

  const ok = await buildNominaAccessMessage({
    personId: 'p-sis',
    dniNormalized: '31000000',
    prefetched,
    referenceDate,
    person: { id: 'p-sis', active: true, allowedDoorIds: ['puerta-planta'] },
    doorId: 'puerta-planta'
  });
  assert.equal(ok.authorized, true);
  assert.equal(ok.reason, 'sistemas_acceso_permanente');
});

test('nómina: persona de baja en people → buildNominaAccessMessage no opina (null)', async () => {
  const mock = createMockFirestore({});
  installFirestoreMock(mock);
  const { buildNominaAccessMessage } = require('../lib/accessNominaMessages');
  const res = await buildNominaAccessMessage({
    personId: 'p-x',
    dniNormalized: '32000000',
    referenceDate,
    prefetched: {
      employee: { id: 'pm-2', name: 'Operario', centroCosto: 'Planta', active: true, turnoRaw: 'Lu a Do' },
      citacionesToday: []
    },
    person: { id: 'p-x', active: false }
  });
  assert.equal(res, null);
});

test('fecha "hoy": 22:30 ART sigue siendo el mismo día (no el siguiente UTC)', () => {
  const { getArgentinaDateParts, getArgentinaDateString } = require('../lib/normalize');
  const at2230 = new Date('2026-07-03T22:30:00-03:00'); // = 2026-07-04T01:30Z
  assert.equal(at2230.toISOString().slice(0, 10), '2026-07-04', 'precondición: en UTC ya es mañana');
  assert.equal(getArgentinaDateString(at2230), '2026-07-03');
  const parts = getArgentinaDateParts(at2230);
  assert.equal(parts.timeString, '22:30');
  assert.equal(parts.dayCode, 'Vi');

  const mock = createMockFirestore({});
  installFirestoreMock(mock);
  const { todayDateString } = require('../authorizations');
  assert.equal(todayDateString(at2230), '2026-07-03');
});

test('fecha: medianoche ART se informa como 00:xx (no 24:xx)', () => {
  const { getArgentinaDateParts } = require('../lib/normalize');
  const parts = getArgentinaDateParts(new Date('2026-07-04T00:05:00-03:00'));
  assert.equal(parts.timeString, '00:05');
  assert.equal(parts.dateString, '2026-07-04');
});

test('autorización por nombre: homónimos de distinto titular → null; sin barrido difuso', async () => {
  const mock = createMockFirestore({
    authorizations: [
      { id: 'a1', personId: 'p-1', nameKey: 'juan perez', type: 'permanent', active: true, name: 'Juan Perez' },
      { id: 'a2', personId: 'p-2', nameKey: 'juan perez', type: 'permanent', active: true, name: 'Juan Perez' },
      { id: 'a3', personId: 'p-3', nameKey: 'juan carlos perez', type: 'permanent', active: true, name: 'Juan Carlos Perez' }
    ]
  });
  installFirestoreMock(mock);
  const { resolveAuthorizationByName } = require('../authorizations');
  assert.equal(await resolveAuthorizationByName('Juan Perez', '2026-07-03'), null);
  // No hay consulta "todas las activas" (solo filtros por nameKey/nameTokens).
  const sweep = mock.authQueries.find((filters) => filters.length === 1 && filters[0].field === 'active');
  assert.equal(sweep, undefined);

  const single = createMockFirestore({
    authorizations: [
      { id: 'a1', personId: 'p-1', nameKey: 'juan perez', type: 'permanent', active: true, name: 'Juan Perez' }
    ]
  });
  installFirestoreMock(single);
  const auth2 = require('../authorizations');
  const match = await auth2.resolveAuthorizationByName('Juan Perez', '2026-07-03');
  assert.equal(match.id, 'a1');
});
