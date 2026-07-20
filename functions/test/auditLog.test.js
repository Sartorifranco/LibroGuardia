const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const firestorePath = require.resolve('../firestore');
const rolesPath = require.resolve('../roles');
const auditPath = require.resolve('../lib/auditLog');

const installAuditFirestoreMock = () => {
  const auditWrites = [];
  const roles = new Map();

  const mockDb = {
    collection(name) {
      if (name === 'auditLog') {
        return {
          add: async (payload) => {
            const id = `audit-${auditWrites.length + 1}`;
            auditWrites.push({ id, ...payload });
            return { id };
          },
          orderBy() {
            return this;
          },
          where() {
            return this;
          },
          limit() {
            return this;
          },
          startAfter() {
            return this;
          },
          async get() {
            return { docs: [], empty: true };
          },
          doc() {
            return {
              async get() {
                return { exists: false };
              }
            };
          }
        };
      }

      if (name === 'roles') {
        return {
          doc(id) {
            return {
              async get() {
                const data = roles.get(id);
                return {
                  exists: Boolean(data),
                  id,
                  data: () => (data ? { ...data } : undefined)
                };
              },
              async set(data) {
                roles.set(id, { ...(roles.get(id) || {}), ...data });
              },
              async update(data) {
                roles.set(id, { ...(roles.get(id) || {}), ...data });
              },
              async delete() {
                roles.delete(id);
              }
            };
          },
          orderBy() {
            return {
              async get() {
                const docs = [...roles.entries()].map(([id, data]) => ({
                  id,
                  data: () => ({ ...data })
                }));
                return { empty: docs.length === 0, docs };
              }
            };
          }
        };
      }

      if (name === 'users') {
        return {
          where() {
            return {
              limit() {
                return {
                  async get() {
                    return { size: 0, empty: true, docs: [] };
                  }
                };
              }
            };
          }
        };
      }

      if (name === 'settings') {
        return {
          doc() {
            return {
              async get() {
                return { exists: false, data: () => ({}) };
              }
            };
          }
        };
      }

      return {
        doc() {
          return {
            async get() {
              return { exists: false };
            }
          };
        }
      };
    }
  };

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      db: mockDb,
      FieldValue: {
        serverTimestamp: () => 'SERVER_TIMESTAMP'
      },
      Timestamp: {
        fromDate: (d) => d
      }
    }
  };

  delete require.cache[rolesPath];
  delete require.cache[auditPath];

  return {
    auditWrites,
    roles,
    rolesApi: require('../roles'),
    auditApi: require('../lib/auditLog')
  };
};

describe('auditLog', () => {
  let originalFirestoreCache;

  beforeEach(() => {
    originalFirestoreCache = require.cache[firestorePath];
  });

  afterEach(() => {
    if (originalFirestoreCache) require.cache[firestorePath] = originalFirestoreCache;
    else delete require.cache[firestorePath];
    delete require.cache[rolesPath];
    delete require.cache[auditPath];
  });

  it('logAdminAction guarda campos esperados y hace shallow diff', async () => {
    const { auditWrites, auditApi } = installAuditFirestoreMock();
    const { logAdminAction, shallowDiff } = auditApi;

    const diff = shallowDiff(
      { role: 'guardia', active: true, password: 'secret' },
      { role: 'supervisor', active: true, password: 'secret2' }
    );
    assert.deepEqual(diff.changedKeys.sort(), ['password', 'role'].sort());
    assert.equal(diff.before.password, '[REDACTED]');
    assert.equal(diff.after.password, '[REDACTED]');

    const req = {
      user: { id: 'admin1', username: 'admin' },
      ip: '10.0.0.8',
      headers: { 'user-agent': 'jest-agent' }
    };

    const saved = await logAdminAction({
      req,
      action: 'user.update',
      targetType: 'user',
      targetId: 'guardia1',
      before: { role: 'guardia', active: true },
      after: { role: 'supervisor', active: true }
    });

    assert.ok(saved.id);
    assert.equal(auditWrites.length, 1);
    const entry = auditWrites[0];
    assert.equal(entry.action, 'user.update');
    assert.equal(entry.actorId, 'admin1');
    assert.equal(entry.actorUsername, 'admin');
    assert.equal(entry.targetType, 'user');
    assert.equal(entry.targetId, 'guardia1');
    assert.equal(entry.ip, '10.0.0.8');
    assert.equal(entry.userAgent, 'jest-agent');
    assert.equal(entry.createdAt, 'SERVER_TIMESTAMP');
    assert.deepEqual(entry.before, { role: 'guardia' });
    assert.deepEqual(entry.after, { role: 'supervisor' });
    assert.deepEqual(entry.changedKeys, ['role']);
  });

  it('crear un rol dispara una entrada en auditLog (flujo app.js)', async () => {
    const { auditWrites, rolesApi, auditApi } = installAuditFirestoreMock();

    const role = await rolesApi.createRole({
      id: 'auditor_test',
      label: 'Auditor Test',
      description: 'rol de prueba',
      permissions: ['entries.view'],
      dashboardProfile: 'operational'
    });

    await auditApi.logAdminAction({
      req: { user: { id: 'admin', username: 'admin' }, headers: {} },
      action: 'role.create',
      targetType: 'role',
      targetId: role.id,
      before: null,
      after: role
    });

    assert.equal(auditWrites.length, 1);
    assert.equal(auditWrites[0].action, 'role.create');
    assert.equal(auditWrites[0].targetType, 'role');
    assert.equal(auditWrites[0].targetId, 'auditor_test');
    assert.equal(auditWrites[0].after.label, 'Auditor Test');
  });
});
