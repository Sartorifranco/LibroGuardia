const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  scorePersonNameMatch,
  buildNameKeyWithInitials,
  looksLikeDateDni,
  looksLikeSuspiciousDni
} = require('../lib/personIdentity');
const { analyzePeopleAlerts } = require('../lib/peopleAlerts');

describe('personIdentity', () => {
  it('distingue Marcos G de Marcos C', () => {
    assert.notEqual(
      buildNameKeyWithInitials('Marcos G'),
      buildNameKeyWithInitials('Marcos C')
    );
    assert.ok(scorePersonNameMatch('Marcos G', 'Marcos C') < 0.5);
  });

  it('une SARTORI Franco con Franco S', () => {
    assert.ok(scorePersonNameMatch('SARTORI Franco', 'Franco S') >= 0.72);
  });

  it('detecta DNI fecha', () => {
    assert.equal(looksLikeDateDni('20260716'), true);
    assert.equal(looksLikeSuspiciousDni('20260716'), true);
    assert.equal(looksLikeDateDni('38646611'), false);
    // DNI real argentino 20xxxxxxx no es “fecha de carga”
    assert.equal(looksLikeDateDni('20300227'), false);
  });
});

describe('peopleAlerts identity', () => {
  it('no agrupa Marcos G/C como mismo nameKey y marca DNI fecha', () => {
    const people = [
      {
        id: '1',
        name: 'Marcos G',
        idNumber: '',
        active: true,
        allowedDoorIds: [],
        biometricExternalId: ''
      },
      {
        id: '2',
        name: 'Marcos C',
        idNumber: '',
        active: true,
        allowedDoorIds: [],
        biometricExternalId: ''
      },
      {
        id: '3',
        name: 'A',
        idNumber: '20260716',
        active: true,
        allowedDoorIds: [],
        biometricExternalId: ''
      },
      {
        id: '4',
        name: 'B',
        idNumber: '20260716',
        active: true,
        allowedDoorIds: [],
        biometricExternalId: ''
      }
    ];
    const alerts = analyzePeopleAlerts(people, { activeDoorCount: 2 });
    const nameDupes = alerts.duplicates.filter((d) => d.reason === 'name_no_dni');
    assert.equal(nameDupes.length, 0);
    assert.ok(alerts.suspiciousDnis.some((d) => d.key === '20260716'));
  });

  it('sugiere Franco S → SARTORI Franco', () => {
    const people = [
      {
        id: 'emp',
        name: 'SARTORI Franco',
        idNumber: '38646611',
        legajo: '3451',
        active: true,
        allowedDoorIds: ['puerta-p1'],
        biometricExternalId: ''
      },
      {
        id: 'bio',
        name: 'Franco S',
        idNumber: '',
        active: true,
        source: 'biostar',
        biometricExternalId: '55',
        biometricBrand: 'suprema',
        allowedDoorIds: ['puerta-p1', 'puerta-p2']
      }
    ];
    const alerts = analyzePeopleAlerts(people, { activeDoorCount: 2 });
    assert.ok(alerts.biostarSuggestions.some((s) => s.orphan.id === 'bio' && s.candidate.id === 'emp'));
    assert.ok(alerts.biostarDoorIssues.some((p) => p.id === 'bio'));
  });
});
