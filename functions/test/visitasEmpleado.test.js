const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isVisitaWithinWindow,
  findEligibleVisita,
  endOfArgentinaDay,
  filterOwnVisitas,
  listVisitasEsperadasForDate,
  visitaToAuthorizationRow,
  argentinaDayBounds
} = require('../lib/visitasAccess');
const { normalizeDomain } = require('../lib/empresasDestinos');
const { validateNewPassword } = require('../lib/changePassword');
const { findEmpresaByEmailDomain } = require('../lib/selfRegister');

describe('visitasAccess — ventana de vigencia', () => {
  it('acepta desde 2h antes hasta fin del día AR', () => {
    // Esperado: 22 jul 2026 14:00 AR = 17:00 UTC
    const expected = new Date('2026-07-22T17:00:00.000Z');
    const earlyOk = new Date(expected.getTime() - 90 * 60 * 1000); // 1.5h antes
    const tooEarly = new Date(expected.getTime() - 3 * 60 * 60 * 1000);
    const endOk = endOfArgentinaDay(expected);
    const afterEnd = new Date(endOk.getTime() + 1000);

    assert.equal(isVisitaWithinWindow(expected, earlyOk).ok, true);
    assert.equal(isVisitaWithinWindow(expected, tooEarly).ok, false);
    assert.equal(isVisitaWithinWindow(expected, endOk).ok, true);
    assert.equal(isVisitaWithinWindow(expected, afterEnd).ok, false);
  });
});

describe('visitasAccess — match acceso', () => {
  const baseVisita = {
    id: 'v1',
    dniVisitante: '30111222',
    dniVisitanteNormalized: '30111222',
    nombreVisitante: 'Visitante Test',
    fechaHoraEsperada: '2026-07-22T17:00:00.000Z',
    allowedDoorIds: ['molinete-a'],
    estado: 'pendiente',
    createdByUserId: 'emp1@empresa.com',
    empresaId: 'emp-a'
  };

  it('autoriza ingreso vigente en puerta permitida', async () => {
    const now = new Date('2026-07-22T16:30:00.000Z');
    const r = await findEligibleVisita({
      dniNormalized: '30111222',
      doorId: 'molinete-a',
      movementType: 'ingreso',
      now,
      visitasDocs: [baseVisita]
    });
    assert.ok(r.visita);
    assert.equal(r.visita.id, 'v1');
  });

  it('rechaza ingreso fuera de ventana', async () => {
    const now = new Date('2026-07-23T12:00:00.000Z'); // día siguiente
    const r = await findEligibleVisita({
      dniNormalized: '30111222',
      doorId: 'molinete-a',
      movementType: 'ingreso',
      now,
      visitasDocs: [baseVisita]
    });
    assert.equal(r.visita, null);
    assert.equal(r.reason, 'visita_fuera_de_ventana');
  });

  it('rechaza puerta fuera de allowedDoorIds aunque esté vigente', async () => {
    const now = new Date('2026-07-22T16:30:00.000Z');
    const r = await findEligibleVisita({
      dniNormalized: '30111222',
      doorId: 'otra-puerta',
      movementType: 'ingreso',
      now,
      visitasDocs: [baseVisita]
    });
    assert.equal(r.visita, null);
    assert.equal(r.reason, 'puerta_no_autorizada');
  });

  it('rechaza visita sin allowedDoorIds (ninguna puerta)', async () => {
    const now = new Date('2026-07-22T16:30:00.000Z');
    const r = await findEligibleVisita({
      dniNormalized: '30111222',
      doorId: 'molinete-a',
      movementType: 'ingreso',
      now,
      visitasDocs: [{ ...baseVisita, allowedDoorIds: [] }]
    });
    assert.equal(r.visita, null);
    assert.equal(r.reason, 'puerta_no_autorizada');
  });

  it('egreso solo con estado ingreso_registrado', async () => {
    const now = new Date('2026-07-22T20:00:00.000Z');
    const pending = await findEligibleVisita({
      dniNormalized: '30111222',
      doorId: 'molinete-a',
      movementType: 'egreso',
      now,
      visitasDocs: [baseVisita]
    });
    assert.equal(pending.visita, null);

    const entered = await findEligibleVisita({
      dniNormalized: '30111222',
      doorId: 'molinete-a',
      movementType: 'egreso',
      now,
      visitasDocs: [{ ...baseVisita, estado: 'ingreso_registrado' }]
    });
    assert.ok(entered.visita);
  });
});

describe('visitas — scoping por empleado', () => {
  it('un empleado NO ve visitas de otro de la misma empresa', () => {
    const list = [
      { id: '1', createdByUserId: 'a@co.com', empresaId: 'e1' },
      { id: '2', createdByUserId: 'b@co.com', empresaId: 'e1' },
      { id: '3', createdByUserId: 'a@co.com', empresaId: 'e1' }
    ];
    const mine = filterOwnVisitas(list, 'a@co.com');
    assert.deepEqual(mine.map((v) => v.id), ['1', '3']);
    assert.equal(mine.some((v) => v.createdByUserId === 'b@co.com'), false);
  });
});

describe('visitas — listado Autorizados por día AR', () => {
  const docs = [
    {
      id: 'v-ok',
      nombreVisitante: 'Ana Visitante',
      dniVisitanteNormalized: '30111222',
      destinoNombre: 'Planta Norte',
      fechaHoraEsperada: '2026-07-28T17:00:00.000Z', // 14:00 AR
      estado: 'pendiente'
    },
    {
      id: 'v-other-day',
      nombreVisitante: 'Otro Día',
      dniVisitanteNormalized: '20999888',
      destinoNombre: 'Planta Norte',
      fechaHoraEsperada: '2026-07-27T17:00:00.000Z',
      estado: 'pendiente'
    },
    {
      id: 'v-egreso',
      nombreVisitante: 'Ya Salió',
      dniVisitanteNormalized: '11122333',
      destinoNombre: 'Planta Norte',
      fechaHoraEsperada: '2026-07-28T15:00:00.000Z',
      estado: 'egreso_registrado'
    },
    {
      id: 'v-ingreso',
      nombreVisitante: 'Ya Entró',
      dniVisitanteNormalized: '44555666',
      destinoNombre: 'Oficinas',
      fechaHoraEsperada: '2026-07-28T12:00:00.000Z',
      estado: 'ingreso_registrado'
    }
  ];

  it('argentinaDayBounds arma inicio/fin AR', () => {
    const b = argentinaDayBounds('2026-07-28');
    assert.ok(b);
    assert.equal(b.start.toISOString(), '2026-07-28T03:00:00.000Z');
    assert.equal(b.end.toISOString(), '2026-07-29T02:59:59.999Z');
  });

  it('visitaToAuthorizationRow mapea tipo visita_empleado', () => {
    const row = visitaToAuthorizationRow(docs[0], {
      empresaNombre: 'Bacarsa',
      autorizadoPor: 'Juan Empleado'
    });
    assert.equal(row.type, 'visita_empleado');
    assert.equal(row.source, 'empleado');
    assert.equal(row.id, 'visita:v-ok');
    assert.equal(row.startDate, '2026-07-28');
    assert.equal(row.idNumber, '30111222');
    assert.equal(row.company, 'Planta Norte');
    assert.equal(row.empresaNombre, 'Bacarsa');
    assert.equal(row.autorizadoPor, 'Juan Empleado');
  });

  it('prioriza createdByNombre denormalizado sobre lookup', () => {
    const row = visitaToAuthorizationRow({
      ...docs[0],
      createdByUserId: 'id-viejo',
      createdByNombre: 'Nombre Guardado'
    });
    assert.equal(row.autorizadoPor, 'Nombre Guardado');
  });

  it('listVisitasEsperadasForDate filtra día y estados operativos', async () => {
    const rows = await listVisitasEsperadasForDate('2026-07-28', {
      visitasDocs: [
        {
          ...docs[0],
          empresaId: 'e1',
          empresaNombre: 'Bacarsa',
          createdByUserId: 'juan@co.com',
          autorizadoPor: 'Juan Empleado'
        },
        docs[1],
        docs[2],
        docs[3]
      ]
    });
    const ids = rows.map((r) => r.visitaId).sort();
    assert.deepEqual(ids, ['v-ingreso', 'v-ok']);
    assert.ok(rows.every((r) => r.type === 'visita_empleado'));
    const ana = rows.find((r) => r.visitaId === 'v-ok');
    assert.equal(ana.empresaNombre, 'Bacarsa');
    assert.equal(ana.autorizadoPor, 'Juan Empleado');
  });
});

describe('self-register — dominio', () => {
  const empresas = [
    {
      id: 'emp-vespa',
      nombre: 'Vespa',
      activa: true,
      dominiosPermitidos: ['vespasiani.com']
    },
    {
      id: 'emp-off',
      nombre: 'Inactiva',
      activa: false,
      dominiosPermitidos: ['inactiva.com']
    }
  ];

  it('extrae dominio como empresas (sin @, minúsculas)', () => {
    assert.equal(normalizeDomain('User@Vespasiani.COM'), 'vespasiani.com');
  });

  it('dominio válido encuentra empresa activa', async () => {
    const emp = await findEmpresaByEmailDomain('juan@vespasiani.com', { empresasDocs: empresas });
    assert.ok(emp);
    assert.equal(emp.id, 'emp-vespa');
  });

  it('dominio inválido o empresa inactiva → sin match', async () => {
    assert.equal(
      await findEmpresaByEmailDomain('x@otro.com', { empresasDocs: empresas }),
      null
    );
    assert.equal(
      await findEmpresaByEmailDomain('x@inactiva.com', { empresasDocs: empresas }),
      null
    );
  });

  it('política de password misma que change-password', () => {
    assert.match(validateNewPassword('corta', { username: 'a@b.com' }) || '', /8/);
    assert.match(
      validateNewPassword('usuario@empresa.com', { username: 'usuario@empresa.com' }) || '',
      /usuario/i
    );
    assert.equal(validateNewPassword('claveSegura1', { username: 'a@b.com' }), null);
  });
});
