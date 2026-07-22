/**
 * Alertas operativas en vivo (capa de visibilidad; la fuente de verdad
 * sigue siendo entries / accessEvents / auditoría).
 */

const { Timestamp } = require('../firestore');
const { db } = require('../firestore');
const { getNotificationsConfig } = require('./notifications/config');
const { getDoorsConfig } = require('./doorsConfig');

const toIso = (value) => {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const toMs = (value) => {
  if (!value) return 0;
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
};

/**
 * Pure: selecciona alertas a partir de docs ya cargados (testable).
 */
const buildLiveAlertsFromDocs = ({
  accessEvents = [],
  exceptionalEntries = [],
  doorNamesById = {},
  denialThreshold = 3,
  denialWindowMinutes = 10,
  nowMs = Date.now()
} = {}) => {
  const alerts = [];
  const sinceMs = nowMs - Math.max(30, denialWindowMinutes) * 60 * 1000;

  for (const entry of exceptionalEntries) {
    const at = toIso(entry.timestamp) || toIso(entry.createdAt);
    const atMs = toMs(entry.timestamp) || toMs(entry.createdAt);
    if (atMs && atMs < nowMs - 5 * 60 * 1000) continue;
    alerts.push({
      id: `exceptional:${entry.id}`,
      type: 'exceptional_entry',
      severity: 'warn',
      title: 'Ingreso excepcional',
      message: `${entry.name || 'Persona'}${entry.idNumber ? ` (${entry.idNumber})` : ''}: ${entry.exceptionalReason || entry.notes || 'sin motivo'}`,
      at,
      meta: { entryId: entry.id }
    });
  }

  for (const ev of accessEvents) {
    const atMs = toMs(ev.createdAt);
    if (atMs && atMs < nowMs - 5 * 60 * 1000) continue;

    if (ev.relayError) {
      const doorLabel = ev.doorName || doorNamesById[ev.doorId] || ev.doorId || 'Puerta';
      alerts.push({
        id: `relay:${ev.id}`,
        type: 'door_relay_failure',
        severity: 'error',
        title: 'Falla de puerta / relé',
        message: `${doorLabel}: ${ev.relayError}`,
        at: toIso(ev.createdAt),
        meta: { doorId: ev.doorId || null, eventId: ev.id }
      });
    }
  }

  // Denegados: mismo umbral que email; un alerta por clave (dni|puerta) por ventana.
  const denials = accessEvents.filter((ev) => {
    if (ev.type !== 'denied') return false;
    const atMs = toMs(ev.createdAt);
    return !atMs || atMs >= sinceMs;
  });

  const groups = new Map();
  for (const ev of denials) {
    const dni = String(ev.idNumber || '').trim();
    const door = String(ev.doorId || '').trim();
    const key = dni ? `dni:${dni}` : (door ? `door:${door}` : null);
    if (!key) continue;
    const list = groups.get(key) || [];
    list.push(ev);
    groups.set(key, list);
  }

  const threshold = Math.max(2, Number(denialThreshold) || 3);
  for (const [key, list] of groups.entries()) {
    if (list.length < threshold) continue;
    const newest = list[0];
    const windowBucket = Math.floor(nowMs / (denialWindowMinutes * 60 * 1000));
    const doorLabel = newest.doorName || doorNamesById[newest.doorId] || newest.doorId || '';
    alerts.push({
      id: `repeated:${key}:${windowBucket}`,
      type: 'repeated_denials',
      severity: 'warn',
      title: 'Accesos denegados repetidos',
      message: [
        newest.name || newest.idNumber || 'Persona',
        doorLabel ? `· ${doorLabel}` : '',
        `· ${list.length} intentos (umbral ${threshold})`
      ].filter(Boolean).join(' '),
      at: toIso(newest.createdAt),
      meta: {
        count: list.length,
        threshold,
        idNumber: newest.idNumber || null,
        doorId: newest.doorId || null
      }
    });
  }

  alerts.sort((a, b) => (toMs(b.at) - toMs(a.at)));
  return alerts;
};

const getLiveAlerts = async ({
  lookbackMinutes = 5,
  denialLookbackMinutes = null
} = {}) => {
  const config = await getNotificationsConfig().catch(() => null);
  const denialCfg = config?.events?.repeated_denials || {};
  const threshold = denialCfg.threshold || 3;
  const windowMinutes = denialLookbackMinutes || denialCfg.windowMinutes || 10;
  const lookbackMs = Math.max(lookbackMinutes, windowMinutes) * 60 * 1000;
  const since = new Date(Date.now() - lookbackMs);

  let eventSnap;
  try {
    eventSnap = await db.collection('accessEvents')
      .where('createdAt', '>=', Timestamp.fromDate(since))
      .orderBy('createdAt', 'desc')
      .limit(80)
      .get();
  } catch {
    eventSnap = await db.collection('accessEvents')
      .orderBy('createdAt', 'desc')
      .limit(80)
      .get();
  }

  const accessEvents = eventSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  let entrySnap;
  try {
    entrySnap = await db.collection('entries')
      .where('exceptionalEntry', '==', true)
      .where('timestamp', '>=', Timestamp.fromDate(new Date(Date.now() - lookbackMinutes * 60 * 1000)))
      .orderBy('timestamp', 'desc')
      .limit(20)
      .get();
  } catch {
    // Sin índice: recientes y filtrar
    const recent = await db.collection('entries')
      .orderBy('timestamp', 'desc')
      .limit(60)
      .get();
    const minMs = Date.now() - lookbackMinutes * 60 * 1000;
    entrySnap = {
      docs: recent.docs.filter((doc) => {
        const data = doc.data() || {};
        if (data.exceptionalEntry !== true) return false;
        return toMs(data.timestamp) >= minMs;
      })
    };
  }

  const exceptionalEntries = entrySnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  let doorNamesById = {};
  try {
    const doorsConfig = await getDoorsConfig();
    doorNamesById = Object.fromEntries(
      (doorsConfig.doors || []).map((d) => [d.id, d.name || d.id])
    );
  } catch {
    doorNamesById = {};
  }

  // Revalidar umbral con checkRepeatedDenials solo para claves recientes denegadas
  // (buildLiveAlertsFromDocs ya cuenta en memoria; alinear threshold de config).
  const alerts = buildLiveAlertsFromDocs({
    accessEvents,
    exceptionalEntries,
    doorNamesById,
    denialThreshold: threshold,
    denialWindowMinutes: windowMinutes
  });

  return {
    alerts,
    queriedAt: new Date().toISOString(),
    threshold,
    windowMinutes
  };
};

module.exports = {
  buildLiveAlertsFromDocs,
  getLiveAlerts
};
