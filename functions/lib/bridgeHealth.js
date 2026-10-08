/**
 * Salud de puentes locales: ¿reportaron en los últimos X minutos y están sanos?
 * Además del heartbeat, mira los chequeos de cada lector (lector serie, relé,
 * credenciales) y la salud real del puente BioStar (último éxito / último error).
 */

const { listLectores } = require('./lectores');
const { listEstaciones } = require('./estaciones');
const { getCitacionesBridgeConfig } = require('../citacionesBridge');
const { getBiostarBridgeStatus } = require('./biostarBridgeStatus');
const { notify } = require('./notifications');
const { db, FieldValue } = require('../firestore');
const {
  toBridgeRow,
  shouldAlertOffline,
  decideBridgeNotification,
  formatArShort
} = require('./bridgeHealthEvaluate');
const { listLectorProblems } = require('./stationHealth');

const ALERTS_DOC = 'bridgeHealthAlerts';

const collectBridgeStatuses = async (nowMs = Date.now()) => {
  const [lectores, estaciones, citaciones, biostar] = await Promise.all([
    listLectores(),
    listEstaciones(),
    getCitacionesBridgeConfig(),
    getBiostarBridgeStatus(nowMs)
  ]);

  const rows = [];

  lectores.forEach((l) => {
    const problems = listLectorProblems(l);
    const problem = problems.length
      ? {
        code: problems[0].code,
        reason: problems.map((p) => p.reason).join(' · '),
        since: problems[0].since
      }
      : null;
    rows.push(toBridgeRow({
      kind: 'lector',
      id: l.id,
      name: l.nombre || l.usuarioSistemaId || l.id,
      lastAt: l.ultimaConexion,
      enabled: true,
      problem,
      nowMs
    }));
  });

  estaciones.forEach((e) => {
    rows.push(toBridgeRow({
      kind: 'estacion',
      id: e.id,
      name: e.nombre || e.id,
      lastAt: e.ultimaConexion,
      enabled: e.activa !== false,
      nowMs
    }));
  });

  rows.push(toBridgeRow({
    kind: 'citaciones',
    id: 'citaciones-folder-bridge',
    name: 'Puente de citados (carpeta Excel)',
    lastAt: citaciones.lastHeartbeatAt || citaciones.lastSyncAt,
    enabled: citaciones.enabled === true,
    nowMs
  }));

  const biostarHealth = biostar.health || {};
  rows.push(toBridgeRow({
    kind: 'biostar',
    id: 'biostar-bridge',
    name: 'Puente BioStar 2',
    lastAt: biostar.lastHeartbeatAt,
    enabled: true,
    problem: biostarHealth.status === 'degraded'
      ? {
        code: biostarHealth.problemCode || 'biostar',
        reason: biostarHealth.reason,
        since: biostarHealth.problemSince
      }
      : null,
    nowMs
  }));

  return rows;
};

const checkAndNotifyStaleBridges = async (nowMs = Date.now()) => {
  const rows = await collectBridgeStatuses(nowMs);
  const snap = await db.collection('settings').doc(ALERTS_DOC).get();
  const prevAll = snap.exists ? (snap.data().byId || {}) : {};
  const nextById = { ...prevAll };
  const notified = [];

  for (const row of rows) {
    const key = `${row.kind}:${row.id}`;
    const stored = prevAll[key] || {};
    // Estados guardados antes de existir `alerted`: offline ya avisado cuenta como alertado.
    const prev = {
      ...stored,
      alerted: stored.alerted ?? (stored.lastStatus === 'offline' && Boolean(stored.lastNotifiedAt))
    };
    const action = decideBridgeNotification(row, prev, nowMs);
    const next = {
      lastStatus: row.status,
      problemCode: row.problemCode || null,
      lastNotifiedAt: prev.lastNotifiedAt || null,
      alerted: Boolean(prev.alerted)
    };
    if (action) {
      const result = await notify('bridge_offline', {
        variant: action,
        kind: row.kind,
        name: row.name,
        id: row.id,
        lastAt: row.lastAt ? (formatArShort(row.lastAt) || String(row.lastAt)) : null,
        reason: row.reason || null
      });
      if (action === 'recovered') {
        next.alerted = false;
        next.lastNotifiedAt = null;
      } else {
        next.alerted = true;
        next.lastNotifiedAt = nowMs;
      }
      notified.push({ ...row, action, notify: result });
    }
    nextById[key] = next;
  }

  if (JSON.stringify(nextById) !== JSON.stringify(prevAll)) {
    await db.collection('settings').doc(ALERTS_DOC).set({
      byId: nextById,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }

  return { rows, notified };
};

module.exports = {
  ALERTS_DOC,
  collectBridgeStatuses,
  checkAndNotifyStaleBridges,
  toBridgeRow,
  shouldAlertOffline
};
