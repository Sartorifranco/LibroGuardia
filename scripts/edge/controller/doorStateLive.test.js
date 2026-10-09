'use strict';

/**
 * Controlador real en memoria → journal door_state → hub → SSE y /api/guard/doors.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('../../../functions/node_modules/bcryptjs');
const k = require('../hub/_hubkit');
const { SKIP, createTestController } = require('./_fixture');

const skip = SKIP || k.SKIP;

async function api(base, path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

describe('door_state: controlador → hub → SSE', { skip }, () => {
  const dirs = [];
  let t;
  let built;
  let token;

  before(async () => {
    t = await createTestController();
    const hubKeys = k.generateKeyPair();
    const dir = k.tmpDir('lg-door-live-');
    dirs.push(dir);
    built = await k.buildHub({
      dir,
      cloud: null,
      hubKeys,
      controllers: [{ deviceId: 'ctl-test', publicKey: hubKeys.publicKeyPem, url: 'http://127.0.0.1:9', doorIds: ['p1'] }]
    });
    const hash = bcrypt.hashSync('clave123', 4);
    built.hub.edge.db.run(
      'INSERT INTO operators(username, hash, pwd_version, perms_json, posts_json) VALUES (?, ?, 1, ?, ?)',
      'guardia', hash, JSON.stringify(['access.manual_open', 'entries.view']), '[]'
    );
    built.hub.edge.db.run(
      'INSERT INTO doors(id, json) VALUES (?, ?)',
      'p1',
      JSON.stringify({ id: 'p1', name: 'Exterior', enabled: true, controllerId: 'ctl-test', sides: ['in', 'out'] })
    );
    built.hub.controllers.markSeen('ctl-test');
    const login = await api(built.url, '/api/auth/login', { method: 'POST', body: { username: 'guardia', password: 'clave123' } });
    assert.equal(login.status, 200);
    token = login.data.token;
  });

  after(async () => {
    if (t) await t.cleanup();
    if (built) await built.hub.stop();
    dirs.forEach(k.rmDir);
  });

  it('un pulso deja DESBLOQUEADA en el journal, en la puerta del guardia y en el SSE', async () => {
    const ac = new AbortController();
    const res = await fetch(`${built.url}/api/live?token=${encodeURIComponent(token)}`, { signal: ac.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const pull = async () => {
      const { value, done } = await reader.read();
      if (!done && value) buf += dec.decode(value, { stream: true });
    };
    await pull();
    assert.match(buf, /: ping/);

    await t.scan('p1', 'ana');
    t.clock.advance(200);
    const local = t.events('door_state');
    assert.equal(local.length, 1);
    assert.equal(local[0].payload.state, 'DESBLOQUEADA');
    assert.equal(local[0].doorId, 'p1');

    built.hub.ingestFromController('ctl-test', { events: local });
    const row = built.hub.edge.db.get('SELECT state, dps, bond, since FROM door_state WHERE door_id = ?', 'p1');
    assert.equal(row.state, 'DESBLOQUEADA');
    assert.equal(row.dps, 'closed');
    assert.equal(row.bond, 'engaged');
    assert.equal(Number(row.since), local[0].payload.since);

    const doors = await api(built.url, '/api/guard/doors', { token });
    assert.equal(doors.status, 200);
    const p1 = doors.data.doors.find((d) => d.id === 'p1');
    assert.equal(p1.live.state, 'DESBLOQUEADA');
    assert.equal(p1.live.dps, 'closed');
    assert.equal(p1.live.since, local[0].payload.since);

    const deadline = Date.now() + 2000;
    while (!buf.includes('event: door') && Date.now() < deadline) await pull();
    assert.match(buf, /event: door/);
    assert.match(buf, /DESBLOQUEADA/);
    assert.match(buf, new RegExp(`"since":${local[0].payload.since}`));
    ac.abort();
  });
});
