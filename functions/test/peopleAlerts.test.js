const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyzePeopleAlerts } = require('../lib/peopleAlerts');

describe('peopleAlerts', () => {
  it('detecta DNI duplicado e incompletos BioStar', () => {
    const people = [
      {
        id: 'a',
        name: 'Ana',
        idNumber: '30111222',
        nameKey: 'ana',
        active: true,
        allowedDoorIds: ['puerta-p1'],
        biometricExternalId: ''
      },
      {
        id: 'b',
        name: 'Ana Dup',
        idNumber: '30111222',
        nameKey: 'ana dup',
        active: true,
        allowedDoorIds: [],
        biometricExternalId: ''
      },
      {
        id: 'c',
        name: 'BioStar 9',
        idNumber: '',
        nameKey: 'biostar',
        active: true,
        source: 'biostar',
        biometricExternalId: '9',
        biometricBrand: 'suprema',
        allowedDoorIds: ['puerta-p2']
      }
    ];
    const alerts = analyzePeopleAlerts(people);
    assert.ok(alerts.duplicates.some((d) => d.reason === 'dni' && d.people.length === 2));
    assert.ok(alerts.incomplete.some((p) => p.id === 'c'));
  });

  it('sugiere match BioStar por nombre', () => {
    const people = [
      {
        id: 'emp',
        name: 'Sartori Franco',
        idNumber: '38646611',
        nameKey: 'franco sartori',
        active: true,
        allowedDoorIds: ['puerta-p1'],
        biometricExternalId: ''
      },
      {
        id: 'bio',
        name: 'SARTORI Franco',
        idNumber: '',
        nameKey: 'franco sartori',
        active: true,
        source: 'biostar',
        biometricExternalId: '55',
        biometricBrand: 'suprema',
        allowedDoorIds: ['puerta-p2']
      }
    ];
    const alerts = analyzePeopleAlerts(people);
    assert.ok(alerts.biostarSuggestions.some((s) => s.orphan.id === 'bio' && s.candidate.id === 'emp'));
  });
});
