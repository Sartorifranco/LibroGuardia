const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scheduleResumen, diasTexto } = require('../lib/scheduleResumen');

describe('scheduleResumen — horario en texto simple', () => {
  it('lunes a viernes en una franja', () => {
    assert.equal(scheduleResumen([{ days: [1, 2, 3, 4, 5], from: '08:00', to: '17:00' }]), 'lun a vie 8:00 a 17:00');
  });

  it('días sueltos y domingo al final', () => {
    assert.equal(diasTexto([0, 1, 3]), 'lun, mié y dom');
    assert.equal(diasTexto([6, 0]), 'sáb y dom');
  });

  it('todos los días y varias franjas', () => {
    assert.equal(
      scheduleResumen([
        { days: [0, 1, 2, 3, 4, 5, 6], from: '07:30', to: '12:00' },
        { days: [1, 2, 3], from: '14:00', to: '18:00' }
      ]),
      'todos los días 7:30 a 12:00; lun a mié 14:00 a 18:00'
    );
  });

  it('sin franjas → vacío', () => {
    assert.equal(scheduleResumen(null), '');
    assert.equal(scheduleResumen([]), '');
  });
});
