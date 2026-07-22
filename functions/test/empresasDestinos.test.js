const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDomain,
  isValidDomain,
  normalizeDomainList,
  validateDestinationDoorIds,
  sanitizeEmpresaPayload,
  sanitizeDestinoPayload
} = require('../lib/empresasDestinos');

describe('empresasDestinos — dominios', () => {
  it('normaliza sin @, minúsculas; acepta input con @', () => {
    assert.equal(normalizeDomain('Vespasiani.COM'), 'vespasiani.com');
    assert.equal(normalizeDomain('@vespasiani.com'), 'vespasiani.com');
    assert.equal(normalizeDomain('user@vespasiani.com'), 'vespasiani.com');
    assert.equal(normalizeDomain('  mailto:Admin@Mail.Empresa.com.ar '), 'mail.empresa.com.ar');
  });

  it('valida formato de host', () => {
    assert.equal(isValidDomain('vespasiani.com'), true);
    assert.equal(isValidDomain('a.co'), true);
    assert.equal(isValidDomain('no'), false);
    assert.equal(isValidDomain('.com'), false);
    assert.equal(isValidDomain('bad domain.com'), false);
  });

  it('normalizeDomainList rechaza inválidos y deduplica', () => {
    assert.deepEqual(
      normalizeDomainList(['Vespasiani.com', 'user@vespasiani.com', 'otro.com.ar']),
      ['vespasiani.com', 'otro.com.ar']
    );
    assert.throws(() => normalizeDomainList(['novalido']), /Dominio inválido/);
  });
});

describe('empresasDestinos — doorIds', () => {
  const doorsConfig = {
    doors: [
      { id: 'molinete-a', name: 'Molinete A' },
      { id: 'porton-1', name: 'Portón' }
    ]
  };

  it('acepta doorIds existentes y deduplica', () => {
    assert.deepEqual(
      validateDestinationDoorIds(['molinete-a', 'porton-1', 'molinete-a'], doorsConfig),
      ['molinete-a', 'porton-1']
    );
  });

  it('rechaza doorId inexistente', () => {
    assert.throws(
      () => validateDestinationDoorIds(['molinete-a', 'puerta-fantasma'], doorsConfig),
      (err) => err.code === 'unknown_door' && err.status === 400
    );
  });

  it('sanitizeDestinoPayload rechaza puerta inexistente', () => {
    assert.throws(
      () => sanitizeDestinoPayload({ nombre: 'Sistemas', doorIds: ['no-existe'] }, doorsConfig),
      /Puerta inexistente/
    );
    const ok = sanitizeDestinoPayload({ nombre: 'Sistemas', doorIds: ['molinete-a'] }, doorsConfig);
    assert.equal(ok.nombre, 'Sistemas');
    assert.deepEqual(ok.doorIds, ['molinete-a']);
    assert.equal(ok.activo, true);
  });
});

describe('empresasDestinos — payloads', () => {
  it('sanitizeEmpresaPayload normaliza dominios', () => {
    const emp = sanitizeEmpresaPayload({
      nombre: 'DICOM SA',
      dominiosPermitidos: ['Dicom.com.ar', 'user@otro.com']
    });
    assert.equal(emp.nombre, 'DICOM SA');
    assert.deepEqual(emp.dominiosPermitidos, ['dicom.com.ar', 'otro.com']);
    assert.equal(emp.activa, true);
  });
});
