const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTransportCsvLine,
  militaryTimeToHHMM,
  expandTransportRow,
  applyTransportParseToCitacion,
  canConfidentlyRepairCitacion,
  hydrateAuthorizationForRead
} = require('../lib/transportCsvParser');

describe('transportCsvParser', () => {
  const sample = '0026,"Sosa Franco Ariel","Operaciones","Chofer Camion Blindado","06-Jul-2026",640,"",0,1300';

  it('parsea legajo, nombre, centro, puesto, fecha y hora militar', () => {
    const parsed = parseTransportCsvLine(sample);
    assert.equal(parsed.legajo, '0026');
    assert.equal(parsed.name, 'Sosa Franco Ariel');
    assert.equal(parsed.centroCosto, 'Operaciones');
    assert.equal(parsed.role, 'Chofer Camion Blindado');
    assert.equal(parsed.startDate, '2026-07-06');
    assert.equal(parsed.appointmentTime, '06:40');
  });

  it('convierte horario militar 730 a 07:30', () => {
    assert.equal(militaryTimeToHHMM(730), '07:30');
    assert.equal(militaryTimeToHHMM(1300), '13:00');
  });

  it('expande fila cruda de planilla sin encabezados', () => {
    const expanded = expandTransportRow({ [sample]: '' });
    assert.equal(expanded.per__des, 'Sosa Franco Ariel');
    assert.equal(expanded.sector__des, 'Operaciones');
    assert.equal(expanded.appointmentTime, '06:40');
  });

  it('repara citacion ya guardada con csv embebido', () => {
    const fixed = applyTransportParseToCitacion({
      name: `Legajo ${sample}`,
      legajo: sample,
      destination: ''
    });
    assert.equal(fixed.name, 'Sosa Franco Ariel');
    assert.equal(fixed.legajo, '0026');
    assert.equal(fixed.destination, 'Operaciones');
    assert.equal(fixed.appointmentTime, '06:40');
    assert.equal(fixed.nameKey, 'ariel franco sosa');
  });

  it('canConfidentlyRepairCitacion acepta CSV transporte y rechaza basura', () => {
    assert.equal(canConfidentlyRepairCitacion({
      type: 'citacion',
      name: `Legajo ${sample}`,
      legajo: sample
    }), true);
    assert.equal(canConfidentlyRepairCitacion({
      type: 'citacion',
      name: 'Brizuela Hector Daniel',
      legajo: '174'
    }), false);
    assert.equal(canConfidentlyRepairCitacion({
      type: 'citacion',
      name: 'texto sin formato csv',
      legajo: '??'
    }), false);
  });

  it('hydrateAuthorizationForRead no toca permanent limpia', () => {
    const permanent = { type: 'permanent', name: 'CORDOBA Omar', legajo: '100' };
    assert.equal(hydrateAuthorizationForRead(permanent), permanent);
  });

  it('parsea línea colapsada con legajo sin comillas (formato que ya andaba)', () => {
    const unquoted = '2924,"Heredia Juan Ignacio","Veeduria","Veedor","28-May-2026",800,"",0,0';
    const parsed = parseTransportCsvLine(unquoted);
    assert.equal(parsed.legajo, '2924');
    assert.equal(parsed.name, 'Heredia Juan Ignacio');
    assert.equal(parsed.startDate, '2026-05-28');
    assert.equal(parsed.appointmentTime, '08:00');

    const expanded = expandTransportRow({ legajo: unquoted });
    assert.equal(expanded.legajo, '2924');
    assert.equal(expanded.per__des, 'Heredia Juan Ignacio');
  });

  it('parsea línea colapsada con legajo entre comillas (formato que fallaba)', () => {
    const quoted = '"2794","Aguilar Edgardo Marcelo","Operaciones","Chofer Con Firma","15-Dic-2023",700,"15-Dic-2023",0,0';
    const parsed = parseTransportCsvLine(quoted);
    assert.equal(parsed.legajo, '2794');
    assert.equal(parsed.name, 'Aguilar Edgardo Marcelo');
    assert.equal(parsed.centroCosto, 'Operaciones');
    assert.equal(parsed.role, 'Chofer Con Firma');
    assert.equal(parsed.startDate, '2023-12-15');
    assert.equal(parsed.appointmentTime, '07:00');

    const expanded = expandTransportRow({ legajo: quoted });
    assert.equal(expanded.legajo, '2794');
    assert.equal(expanded.per__des, 'Aguilar Edgardo Marcelo');
    assert.equal(expanded.sector__des, 'Operaciones');
    assert.equal(expanded.appointmentTime, '07:00');

    const withLegajoPrefix = expandTransportRow({
      legajo: `Legajo ${quoted}`,
      nombre: `Legajo ${quoted}`
    });
    assert.equal(withLegajoPrefix.legajo, '2794');
    assert.equal(withLegajoPrefix.per__des, 'Aguilar Edgardo Marcelo');
  });
});
