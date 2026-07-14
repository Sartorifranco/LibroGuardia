const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTransportCsvLine,
  militaryTimeToHHMM,
  expandTransportRow,
  applyTransportParseToCitacion
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
  });
});
