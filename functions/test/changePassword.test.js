const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const firestorePath = require.resolve('../firestore');
const changePasswordPath = require.resolve('../lib/changePassword');

const installUsersMock = (initialUser) => {
  const store = new Map();
  if (initialUser) {
    store.set(initialUser.id, { ...initialUser.data });
  }

  const mockDb = {
    collection(name) {
      if (name !== 'users') {
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
              const current = store.get(id) || {};
              store.set(id, { ...current, ...patch });
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
      }
    }
  };

  delete require.cache[changePasswordPath];
  return {
    store,
    api: require('../lib/changePassword'),
    FieldValue: require.cache[firestorePath].exports.FieldValue,
    db: mockDb
  };
};

describe('changePassword', () => {
  let originalFirestore;

  beforeEach(() => {
    originalFirestore = require.cache[firestorePath];
  });

  afterEach(() => {
    if (originalFirestore) require.cache[firestorePath] = originalFirestore;
    else delete require.cache[firestorePath];
    delete require.cache[changePasswordPath];
  });

  it('validateNewPassword rechaza política (corta / igual al username)', () => {
    const { api } = installUsersMock();
    assert.match(api.validateNewPassword('corta'), /al menos 8/);
    assert.match(
      api.validateNewPassword('guardia01', { username: 'guardia01' }),
      /nombre de usuario/
    );
    assert.match(
      api.validateNewPassword('MismaClave1', { currentPassword: 'MismaClave1' }),
      /igual a la actual/
    );
    assert.equal(
      api.validateNewPassword('ClaveValida1', { username: 'guardia01', currentPassword: 'OtraClave1' }),
      null
    );
  });

  it('cambio exitoso y mustChangePassword pasa a false', async () => {
    const hash = await bcrypt.hash('Temporal123', 10);
    const { api, db, FieldValue, store } = installUsersMock({
      id: 'guardia01',
      data: {
        username: 'guardia01',
        password: hash,
        mustChangePassword: true,
        passwordVersion: 1,
        role: 'guardia',
        active: true
      }
    });

    const result = await api.changeOwnPassword({
      db,
      FieldValue,
      userId: 'guardia01',
      currentPassword: 'Temporal123',
      newPassword: 'NuevaClave99'
    });

    assert.equal(result.mustChangePassword, false);
    assert.equal(store.get('guardia01').mustChangePassword, false);
    assert.equal(store.get('guardia01').passwordVersion, 2);
    const ok = await bcrypt.compare('NuevaClave99', store.get('guardia01').password);
    assert.equal(ok, true);
  });

  it('rechaza contraseña actual incorrecta con 401', async () => {
    const hash = await bcrypt.hash('Temporal123', 10);
    const { api, db, FieldValue } = installUsersMock({
      id: 'guardia01',
      data: {
        username: 'guardia01',
        password: hash,
        mustChangePassword: true
      }
    });

    await assert.rejects(
      () => api.changeOwnPassword({
        db,
        FieldValue,
        userId: 'guardia01',
        currentPassword: 'Incorrecta',
        newPassword: 'NuevaClave99'
      }),
      (err) => err.status === 401 && /incorrecta/i.test(err.message)
    );
  });

  it('rechaza nueva contraseña igual a la actual (hash)', async () => {
    const hash = await bcrypt.hash('Temporal123', 10);
    const { api, db, FieldValue } = installUsersMock({
      id: 'guardia01',
      data: {
        username: 'guardia01',
        password: hash,
        mustChangePassword: true
      }
    });

    await assert.rejects(
      () => api.changeOwnPassword({
        db,
        FieldValue,
        userId: 'guardia01',
        currentPassword: 'Temporal123',
        newPassword: 'Temporal123'
      }),
      (err) => err.status === 400 && /igual a la actual/i.test(err.message)
    );
  });
});
