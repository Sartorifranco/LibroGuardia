/**
 * Salud de puentes locales: ¿reportaron en los últimos X minutos?
 */

const { listLectores } = require('./lectores');
const { listEstaciones } = require('./estaciones');
const { getCitacionesBridgeConfig } = require('../citacionesBridge');
const { getBiostarBridgeStatus } = require('./biostarBridgeStatus');
const { notify } = require('./notifications');
const { db, FieldValue } = require('../firestore');
const { toBridgeRow, shouldAlertOffline } = require('./bridgeHealthEvaluate');

const ALERTS_DOC = 'bridgeHealthAlerts';

const collectBridgeStatuses = async () => {
  const [lectores, estaciones, citaciones, biostar] = await Promise.all([
    listLectores(),
    listEstaciones(),
    getCitacionesBridgeConfig(),
    getBiostarBridgeStatus()
  ]);

  const rows = [];

  lectores.forEach((l) => {
    rows.push(toBridgeRow({
      kind: 'lector',
      id: l.id,
      name: l.nombre || l.usuarioSistemaId || l.id,
      lastAt: l.ultimaConexion,
      enabled: true
    }));
  });

  estaciones.forEach((e) => {
    rows.push(toBridgeRow({
      kind: 'estacion',
      id: e.id,
      name: e.nombre || e.id,
      lastAt: e.ultimaConexion,
      enabled: e.activa !== false
    }));
  });

  rows.push(toBridgeRow({
    kind: 'citaciones',
    id: 'citaciones-folder-bridge',
    name: 'Puente de citados (carpeta Excel)',
    lastAt: citaciones.lastHeartbeatAt || citaciones.lastSyncAt,
    enabled: citaciones.enabled === true
  }));

  rows.push(toBridgeRow({
    kind: 'biostar',
    id: 'biostar-bridge',
    name: 'Puente BioStar 2',
    lastAt: biostar.lastHeartbeatAt,
    enabled: true
  }));

  return rows;
};

const checkAndNotifyStaleBridges = async () => {
  const rows = await collectBridgeStatuses();
  const snap = await db.collection('settings').doc(ALERTS_DOC).get();
  const prevAll = snap.exists ? (snap.data().byId || {}) : {};
  const nextById = { ...prevAll };
  const notified = [];

  for (const row of rows) {
    const key = `${row.kind}:${row.id}`;
    const prev = prevAll[key] || {};
    if (shouldAlertOffline(row, prev)) {
      const result = await notify('bridge_offline', {
        kind: row.kind,
        name: row.name,
        id: row.id,
        lastAt: row.lastAt
      });
      nextById[key] = {
        lastStatus: row.status,
        lastNotifiedAt: Date.now()
      };
      notified.push({ ...row, notify: result });
    } else {
      nextById[key] = {
        lastStatus: row.status,
        lastNotifiedAt: prev.lastNotifiedAt || null
      };
    }
  }

  await db.collection('settings').doc(ALERTS_DOC).set({
    byId: nextById,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  return { rows, notified };
};

module.exports = {
  ALERTS_DOC,
  collectBridgeStatuses,
  checkAndNotifyStaleBridges,
  toBridgeRow,
  shouldAlertOffline
};
