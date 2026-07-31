const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractBiostarDniCandidates,
  looksLikeDni,
  biostarDisplayName
} = require('../lib/biostarMatch');

describe('biostarMatch', () => {
  it('detecta DNI en user_id', () => {
    const c = extractBiostarDniCandidates({ user_id: '38646611', name: 'Franco' });
    assert.equal(c[0].dni, '38646611');
    assert.equal(c[0].source, 'user_id');
  });

  it('ignora user_id corto que no parece DNI', () => {
    assert.equal(looksLikeDni('42'), false);
    const c = extractBiostarDniCandidates({ user_id: '42', name: 'Juan' });
    assert.equal(c.length, 0);
  });

  it('extrae dígitos del nombre', () => {
    const c = extractBiostarDniCandidates({ user_id: '7', name: 'PEREZ Juan 30111222' });
    assert.ok(c.some((x) => x.dni === '30111222'));
  });

  it('ignora user_id que parece fecha YYYYMMDD', () => {
    assert.equal(looksLikeDni('20260716'), false);
    const c = extractBiostarDniCandidates({ user_id: '20260716', name: 'Limpieza' });
    assert.equal(c.length, 0);
  });

  it('nombre display evita puro número', () => {
    assert.equal(biostarDisplayName({ name: '12345' }, '9'), 'BioStar 9');
    assert.equal(biostarDisplayName({ name: 'Ana López' }, '9'), 'Ana López');
  });
});
