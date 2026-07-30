const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createBioStarClient } = require('./biostarClient');

describe('biostarClient', () => {
  let originalFetch;
  let calls;

  beforeEach(() => {
    originalFetch = global.fetch;
    calls = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const mockFetch = (handler) => {
    global.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), opts });
      return handler(String(url), opts);
    };
  };

  const jsonRes = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        const map = Object.fromEntries(
          Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
        );
        return map[key] || null;
      }
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    }
  });

  it('login guarda bs-session-id y lo reusa', async () => {
    mockFetch((url) => {
      if (url.endsWith('/api/login')) {
        return jsonRes(200, { Response: { code: '0' } }, { 'bs-session-id': 'SID-1' });
      }
      if (url.includes('/api/users')) {
        return jsonRes(200, {
          UserCollection: { total: 1, rows: [{ user_id: '1', name: 'A' }] }
        });
      }
      return jsonRes(404, {});
    });

    const client = createBioStarClient({
      baseUrl: 'http://192.168.0.9:5001',
      loginId: 'admin',
      password: 'x'
    });
    await client.login();
    assert.equal(client.getSessionId(), 'SID-1');

    const users = await client.listAllUsers({ groupId: '1', pageSize: 50 });
    assert.equal(users.length, 1);
    assert.equal(users[0].user_id, '1');
    const usersCall = calls.find((c) => c.url.includes('/api/users'));
    assert.equal(usersCall.opts.headers['bs-session-id'], 'SID-1');
  });

  it('re-loguea ante 401 en listado', async () => {
    let loginCount = 0;
    mockFetch((url, opts) => {
      if (url.endsWith('/api/login')) {
        loginCount += 1;
        return jsonRes(200, {}, { 'bs-session-id': `SID-${loginCount}` });
      }
      if (url.includes('/api/users')) {
        if (opts.headers['bs-session-id'] === 'SID-1') {
          return jsonRes(401, { Response: { message: 'Login required' } });
        }
        return jsonRes(200, {
          UserCollection: { total: 0, rows: [] }
        });
      }
      return jsonRes(404, {});
    });

    const client = createBioStarClient({
      baseUrl: 'http://host',
      loginId: 'admin',
      password: 'x'
    });
    await client.login();
    await client.listAllUsers();
    assert.equal(loginCount, 2);
    assert.equal(client.getSessionId(), 'SID-2');
  });

  it('pagina usuarios hasta total', async () => {
    mockFetch((url) => {
      if (url.endsWith('/api/login')) {
        return jsonRes(200, {}, { 'bs-session-id': 'S' });
      }
      const u = new URL(url);
      const offset = Number(u.searchParams.get('offset') || 0);
      if (offset === 0) {
        return jsonRes(200, {
          UserCollection: {
            total: 3,
            rows: [{ user_id: '1' }, { user_id: '2' }]
          }
        });
      }
      return jsonRes(200, {
        UserCollection: {
          total: 3,
          rows: [{ user_id: '3' }]
        }
      });
    });

    const client = createBioStarClient({
      baseUrl: 'http://host',
      loginId: 'a',
      password: 'b'
    });
    const users = await client.listAllUsers({ pageSize: 2 });
    assert.deepEqual(users.map((u) => u.user_id), ['1', '2', '3']);
  });
});
