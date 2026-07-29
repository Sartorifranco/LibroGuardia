const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ACTUATOR_TEMPLATES, getActuatorTemplate } = require('../lib/actuatorTemplates');

describe('actuatorTemplates', () => {
  it('incluye SR201 y HTTP genérico', () => {
    assert.equal(ACTUATOR_TEMPLATES.length, 2);
    assert.ok(getActuatorTemplate('sr201'));
    assert.ok(getActuatorTemplate('generic_http'));
    assert.equal(getActuatorTemplate('generic_http').fields.includes('httpUrl'), true);
  });
});
