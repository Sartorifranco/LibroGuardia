'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCountingFirestore, FieldValue } = require('./helpers/countingFirestore');
const { createSiteCompiler } = require('../lib/siteCompiler/compiler');
const signing = require('../lib/siteCompiler/signing');
const build = require('../lib/siteCompiler/build');
const { buildInitial } = require('./siteCompilerFixture');

const signingKey = signing.loadSigningKey({});

test('el compilador emite los lugares cargados y los lados de la puerta', async () => {
  const initial = buildInitial();
  initial['sites/principal/areas/oficinas'] = { name: 'Oficinas' };
  initial['sites/principal/areas/tesoreria'] = { name: 'Tesorería' };
  initial['settings/doorsConfig'].doors[0] = {
    ...initial['settings/doorsConfig'].doors[0],
    id: 'P1',
    sides: {
      in: { zoneFrom: 'oficinas', zoneTo: 'tesoreria' },
      out: { zoneFrom: 'tesoreria', zoneTo: 'oficinas' }
    }
  };
  const fs = createCountingFirestore(initial);
  const compiler = createSiteCompiler({
    deps: () => ({ db: fs.db, FieldValue }),
    now: () => Date.parse('2026-10-08T13:00:00.000Z'),
    signingKey,
    autoCompile: false
  });
  await compiler.compileSite('principal', { full: true });
  const body = JSON.parse(fs.peek('sites/principal/compiledChunks/doors').json);
  const p1 = body.doors.find((door) => door.id === 'P1');
  assert.deepEqual(p1.sides, {
    in: { zoneFrom: 'oficinas', zoneTo: 'tesoreria' },
    out: { zoneFrom: 'tesoreria', zoneTo: 'oficinas' }
  });
  const oficinas = body.areas.find((area) => area.id === 'oficinas');
  const tesoreria = body.areas.find((area) => area.id === 'tesoreria');
  const exterior = body.areas.find((area) => area.id === 'exterior');
  assert.equal(oficinas.name, 'Oficinas');
  assert.equal(tesoreria.name, 'Tesorería');
  assert.equal(exterior.exterior, true);
  assert.equal(body.areas.some((area) => area.updatedAt), false);
});

test('sin lados propios la puerta sigue saliendo de exterior a planta', () => {
  const chunk = build.buildDoorsChunk({
    siteId: 'principal',
    site: { areas: [{ id: 'planta', name: 'Planta' }] },
    doorsConfig: { doors: [{ id: 'P1', name: 'Portón', active: true }] }
  });
  assert.deepEqual(chunk.doors[0].sides, {
    in: { zoneFrom: 'exterior', zoneTo: 'planta' },
    out: { zoneFrom: 'planta', zoneTo: 'exterior' }
  });
  assert.equal(chunk.areas.find((area) => area.id === 'planta').name, 'Planta');
});
