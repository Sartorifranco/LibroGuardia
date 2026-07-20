const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const firestorePath = require.resolve('../firestore');
const emailPath = require.resolve('../lib/notifications/email');
const configPath = require.resolve('../lib/notifications/config');
const indexPath = require.resolve('../lib/notifications/index');
const denialPath = require.resolve('../lib/notifications/denialThreshold');

const installMocks = ({ config, sendImpl } = {}) => {
  const auditWrites = [];
  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      db: {
        collection() {
          return {
            doc() {
              return {
                async get() {
                  return {
                    exists: true,
                    data: () => config
                  };
                },
                async set() {
                  return undefined;
                }
              };
            },
            where() { return this; },
            orderBy() { return this; },
            limit() { return this; },
            async get() {
              return { docs: [], empty: true };
            },
            async add(payload) {
              auditWrites.push(payload);
              return { id: `n-${auditWrites.length}` };
            }
          };
        }
      },
      FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' },
      Timestamp: { fromDate: (d) => d }
    }
  };

  delete require.cache[emailPath];
  delete require.cache[configPath];
  delete require.cache[indexPath];
  delete require.cache[denialPath];

  const sendNotification = mock.fn(async (...args) => {
    if (typeof sendImpl === 'function') return sendImpl(...args);
    return { sent: true, via: 'email' };
  });

  require.cache[emailPath] = {
    id: emailPath,
    filename: emailPath,
    loaded: true,
    exports: {
      id: 'email',
      sendNotification
    }
  };

  return {
    sendNotification,
    api: require('../lib/notifications')
  };
};

describe('notifications', () => {
  let originalFirestore;

  beforeEach(() => {
    originalFirestore = require.cache[firestorePath];
  });

  afterEach(() => {
    if (originalFirestore) require.cache[firestorePath] = originalFirestore;
    else delete require.cache[firestorePath];
    delete require.cache[emailPath];
    delete require.cache[configPath];
    delete require.cache[indexPath];
    delete require.cache[denialPath];
  });

  it('dispara email con config correcta', async () => {
    const { sendNotification, api } = installMocks({
      config: {
        enabled: true,
        smtp: {
          host: 'smtp.test',
          port: 587,
          user: 'u',
          password: 'secret',
          from: 'alertas@test.com'
        },
        events: {
          exceptional_entry: {
            enabled: true,
            recipients: ['seguridad@empresa.com']
          }
        }
      }
    });

    const result = await api.notify('exceptional_entry', {
      name: 'Juan Perez',
      idNumber: '30111222',
      reason: 'Visita urgente'
    });

    assert.equal(result.sent, true);
    assert.equal(sendNotification.mock.calls.length, 1);
    const [message, channelConfig] = sendNotification.mock.calls[0].arguments;
    assert.deepEqual(message.to, ['seguridad@empresa.com']);
    assert.match(message.subject, /ingreso excepcional/i);
    assert.match(message.text, /Juan Perez/);
    assert.equal(channelConfig.smtp.host, 'smtp.test');
    assert.equal(channelConfig.smtp.from, 'alertas@test.com');
  });

  it('canal/evento deshabilitado no dispara', async () => {
    const { sendNotification, api } = installMocks({
      config: {
        enabled: true,
        smtp: { host: 'smtp.test', from: 'a@b.com', password: 'x' },
        events: {
          exceptional_entry: {
            enabled: false,
            recipients: ['seguridad@empresa.com']
          }
        }
      }
    });

    const result = await api.notify('exceptional_entry', { name: 'X' });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'evento_deshabilitado');
    assert.equal(sendNotification.mock.calls.length, 0);
  });

  it('fallo de envío no rompe el flujo (notify atrapa el error)', async () => {
    const { api } = installMocks({
      config: {
        enabled: true,
        smtp: { host: 'smtp.test', from: 'a@b.com', password: 'x' },
        events: {
          door_relay_failure: {
            enabled: true,
            recipients: ['ops@empresa.com']
          }
        }
      },
      sendImpl: async () => {
        throw new Error('SMTP down');
      }
    });

    const result = await api.notify('door_relay_failure', {
      doorName: 'Principal',
      error: 'Timeout'
    });

    assert.equal(result.sent, false);
    assert.match(result.error, /SMTP down/);
  });

  it('publicNotificationsConfig oculta el password SMTP', () => {
    const { api } = installMocks({
      config: {
        enabled: true,
        smtp: { host: 'h', password: 'super-secret', from: 'a@b.com' },
        events: {}
      }
    });
    const pub = api.publicNotificationsConfig({
      enabled: true,
      smtp: { host: 'h', password: 'super-secret', from: 'a@b.com' },
      events: {}
    });
    assert.equal(pub.smtp.password, '');
    assert.equal(pub.smtp.hasPassword, true);
  });
});
