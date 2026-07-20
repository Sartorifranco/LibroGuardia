const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const firestorePath = require.resolve('../firestore');
const changePasswordPath = require.resolve('../lib/changePassword');
const passwordVersionPath = require.resolve('../lib/passwordVersion');

const installUserStore = (initial) => {
  const store = new Map();
  if (initial) store.set(initial.id, { ...initial.data });

  const mockDb = {
    collection(name) {
      if (name !== 'users') {
        return {
          doc() {
            return { async get() { return { exists: false }; } };
          }
        };
      }
      return {
        doc(id) {
          return {
            async get() {
              const data = store.get(id);
              return {
                exists: Boolean(data),
                id,
                data: () => (data ? { ...data } : undefined)
              };
            },
            async update(patch) {
              store.set(id, { ...(store.get(id) || {}), ...patch });
            },
            async set(patch, opts = {}) {
              if (opts.merge) {
                store.set(id, { ...(store.get(id) || {}), ...patch });
              } else {
                store.set(id, { ...patch });
              }
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
      FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' }
    }
  };

  delete require.cache[changePasswordPath];
  delete require.cache[passwordVersionPath];

  return {
    store,
    db: mockDb,
    FieldValue: require.cache[firestorePath].exports.FieldValue,
    changePassword: require('../lib/changePassword'),
    passwordVersion: require('../lib/passwordVersion')
  };
};

describe('passwordVersion', () => {
  let originalFirestore;

  beforeEach(() => {
    originalFirestore = require.cache[firestorePath];
  });

  afterEach(() => {
    if (originalFirestore) require.cache[firestorePath] = originalFirestore;
    else delete require.cache[firestorePath];
    delete require.cache[changePasswordPath];
    delete require.cache[passwordVersionPath];
  });

  it('token con passwordVersion viejo se rechaza tras cambio de contraseña', async () => {
    const hash = await bcrypt.hash('Temporal123', 10);
    const { db, FieldValue, changePassword, passwordVersion, store } = installUserStore({
      id: 'guardia01',
      data: {
        username: 'guardia01',
        password: hash,
        passwordVersion: 1,
        mustChangePassword: true,
        role: 'guardia',
        active: true
      }
    });

    passwordVersion._clearPasswordVersionCacheForTests();
    passwordVersion.setCachedPasswordVersion('guardia01', 1);

    // Token emitido antes del cambio (version 1) — aún válido
    await passwordVersion.assertTokenPasswordVersion(db, {
      id: 'guardia01',
      passwordVersion: 1
    });

    await changePassword.changeOwnPassword({
      db,
      FieldValue,
      userId: 'guardia01',
      currentPassword: 'Temporal123',
      newPassword: 'NuevaClave99'
    });

    assert.equal(store.get('guardia01').passwordVersion, 2);

    await assert.rejects(
      () => passwordVersion.assertTokenPasswordVersion(db, {
        id: 'guardia01',
        passwordVersion: 1
      }),
      (err) => (
        err.status === 401
        && err.code === 'PASSWORD_VERSION_MISMATCH'
        && /contraseña fue actualizada/i.test(err.message)
      )
    );

    // Token nuevo con version 2 — ok
    await passwordVersion.assertTokenPasswordVersion(db, {
      id: 'guardia01',
      passwordVersion: 2
    });
  });

  it('usuarios sin passwordVersion en doc se tratan como 1', async () => {
    const { db, passwordVersion } = installUserStore({
      id: 'legacy',
      data: {
        username: 'legacy',
        password: 'x',
        role: 'guardia'
      }
    });
    passwordVersion._clearPasswordVersionCacheForTests();
    const version = await passwordVersion.resolvePasswordVersion(db, 'legacy');
    assert.equal(version, 1);
    await passwordVersion.assertTokenPasswordVersion(db, { id: 'legacy' });
  });
});
