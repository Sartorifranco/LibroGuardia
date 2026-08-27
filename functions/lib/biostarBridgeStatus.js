/**
 * Heartbeat del puente BioStar (settings/biostarBridge).
 */

const { db, FieldValue } = require('../firestore');

const SETTINGS_DOC = 'biostarBridge';

const DEFAULT_BIOSTAR_BRIDGE = {
  lastHeartbeatAt: null,
  lastError: null
};

const serializeTs = (value) => {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  return value;
};

const getBiostarBridgeStatus = async () => {
  const snap = await db.collection('settings').doc(SETTINGS_DOC).get();
  if (!snap.exists) return { ...DEFAULT_BIOSTAR_BRIDGE };
  const data = snap.data() || {};
  return {
    lastHeartbeatAt: serializeTs(data.lastHeartbeatAt),
    lastError: data.lastError || null
  };
};

const touchBiostarHeartbeat = async ({ lastError = null } = {}) => {
  await db.collection('settings').doc(SETTINGS_DOC).set({
    lastHeartbeatAt: FieldValue.serverTimestamp(),
    lastError: lastError == null ? null : String(lastError).slice(0, 400),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return getBiostarBridgeStatus();
};

module.exports = {
  SETTINGS_DOC,
  getBiostarBridgeStatus,
  touchBiostarHeartbeat
};
