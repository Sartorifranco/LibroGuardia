const { db, FieldValue } = require('../firestore');

const DEFAULT_ACCESS_CONTROL = {
  enabled: false,
  host: '192.168.1.100',
  port: 6722,
  bridgeUrl: '',
  bridgeSecret: '',
  relayChannel: 1,
  pulseMode: 'jog',
  pulseSeconds: 3,
  triggerOn: 'ingreso',
  allowManualOverride: false,
  denyMessage: 'Acceso denegado: no tiene autorización vigente',
  kioskResetSeconds: 4,
  /** Feature opcional por cliente: popup con foto en puerta de ingreso principal. */
  identityVerificationAtMainEntry: false
};

const getAccessControlConfig = async () => {
  const snap = await db.collection('settings').doc('accessControl').get();
  if (!snap.exists) return { ...DEFAULT_ACCESS_CONTROL };
  const data = snap.data() || {};
  return {
    ...DEFAULT_ACCESS_CONTROL,
    ...data,
    identityVerificationAtMainEntry: data.identityVerificationAtMainEntry === true
  };
};

const logAccessEvent = async (event) => {
  await db.collection('accessEvents').add({
    ...event,
    createdAt: FieldValue.serverTimestamp()
  });
  // Notificaciones: fire-and-forget (no afecta el flujo de acceso).
  try {
    const { onAccessEventLogged } = require('./notifications');
    onAccessEventLogged(event);
  } catch (err) {
    console.error('[accessControlStore] notify hook', err.message);
  }
};

const GLOBAL_ACCESS_KEYS = [
  'enabled',
  'host',
  'port',
  'bridgeUrl',
  'bridgeSecret',
  'relayChannel',
  'pulseMode',
  'pulseSeconds',
  'allowManualOverride',
  'denyMessage',
  'kioskResetSeconds',
  'identityVerificationAtMainEntry'
];

const saveGlobalAccessSettings = async (globalAccess = {}) => {
  const updates = { updatedAt: FieldValue.serverTimestamp() };
  GLOBAL_ACCESS_KEYS.forEach((key) => {
    if (globalAccess[key] === undefined) return;
    if (key === 'identityVerificationAtMainEntry') {
      updates[key] = globalAccess[key] === true;
      return;
    }
    updates[key] = globalAccess[key];
  });
  await db.collection('settings').doc('accessControl').set(updates, { merge: true });
  return getAccessControlConfig();
};

module.exports = {
  DEFAULT_ACCESS_CONTROL,
  GLOBAL_ACCESS_KEYS,
  getAccessControlConfig,
  saveGlobalAccessSettings,
  logAccessEvent
};
