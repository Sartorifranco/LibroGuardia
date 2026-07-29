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
  movementEntries = [],
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

  // Movimientos recientes (personas / vehículos) para aviso en puesto de guardia.
  for (const entry of movementEntries) {
    const at = toIso(entry.timestamp) || toIso(entry.createdAt);
    const atMs = toMs(entry.timestamp) || toMs(entry.createdAt);
    if (atMs && atMs < nowMs - 2 * 60 * 1000) continue;
    const type = String(entry.type || '').toLowerCase();
    const direction = String(entry.direction || entry.movementType || '').toLowerCase();
    const isOut = /egreso|salida|out/.test(direction);
    const who = entry.name || entry.plate || entry.idNumber || 'Registro';
    let title = 'Movimiento';
    let severity = 'info';
    if (type === 'personal' || type === 'persona') {
      title = isOut ? 'Egreso de personal' : 'Ingreso de personal';
    } else if (type === 'vehiculo' || type === 'vehículo' || type === 'externo') {
      title = isOut ? 'Egreso de vehículo' : 'Ingreso de vehículo';
    } else if (type === 'flota' || type === 'blindado') {
      title = isOut ? 'Egreso de flota' : 'Ingreso de flota';
      severity = 'info';
    } else {
      continue;
    }
    alerts.push({
      id: `movement:${entry.id}`,
      type: 'movement',
      severity,
      title,
      message: `${who}${entry.plate && entry.name ? ` · ${entry.plate}` : ''}${direction ? ` · ${direction}` : ''}`,
      at,
      meta: { entryId: entry.id, entryType: type }
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

    // Accesos automáticos autorizados (lector / kiosk).
    const evType = String(ev.type || '').toLowerCase();
    if (evType === 'identity_verification') {
      if (atMs && atMs < nowMs - 2 * 60 * 1000) continue;
      const doorLabel = ev.doorName || doorNamesById[ev.doorId] || ev.doorId || 'Ingreso principal';
      const who = ev.name || ev.idNumber || 'Persona';
      alerts.push({
        id: `identity:${ev.id}`,
        type: 'identity_verification',
        severity: 'warn',
        title: 'Verificar identidad',
        message: `${who} · ${doorLabel}`,
        at: toIso(ev.createdAt),
        meta: {
          doorId: ev.doorId || null,
          doorName: doorLabel,
          eventId: ev.id,
          name: ev.name || null,
          idNumber: ev.idNumber || null,
          company: ev.company || null,
          legajo: ev.legajo || null,
          personId: ev.personId || null,
          authorizationLabel: ev.authorizationLabel || ev.authorizationType || null,
          authorizationType: ev.authorizationType || null,
          photoUrl: ev.photoDataUrl || ev.photoUrl || null,
          hasPhoto: ev.hasPhoto === true || Boolean(ev.photoDataUrl || ev.photoUrl)
        }
      });
      continue;
    }
    if ((evType === 'authorized' || evType === 'door_open' || evType === 'manual_open') && !ev.relayError) {
      if (atMs && atMs < nowMs - 2 * 60 * 1000) continue;
      const doorLabel = ev.doorName || doorNamesById[ev.doorId] || ev.doorId || 'Puerta';
      const who = ev.name || ev.idNumber || 'Acceso';
      const movement = String(ev.movementType || '').toLowerCase();
      const isOut = /egreso|salida/.test(movement);
      alerts.push({
        id: `access:${ev.id}`,
        type: 'access_ok',
        severity: 'info',
        title: isOut ? 'Egreso autorizado' : 'Ingreso autorizado',
        message: `${who} · ${doorLabel}`,
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

  let movementEntries = [];
  try {
    const recent = await db.collection('entries')
      .orderBy('timestamp', 'desc')
      .limit(40)
      .get();
    const minMs = Date.now() - Math.min(lookbackMinutes, 3) * 60 * 1000;
    movementEntries = recent.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((row) => {
        const t = String(row.type || '').toLowerCase();
        if (!['personal', 'persona', 'vehiculo', 'vehículo', 'externo', 'flota', 'blindado'].includes(t)) {
          return false;
        }
        return toMs(row.timestamp) >= minMs;
      });
  } catch {
    movementEntries = [];
  }

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
    movementEntries,
    doorNamesById,
    denialThreshold: threshold,
    denialWindowMinutes: windowMinutes
  });

  // Resolver fotos para verificación de identidad (no viajan en accessEvents).
  const identityAlerts = alerts.filter((a) => a.type === 'identity_verification');
  if (identityAlerts.length) {
    await Promise.all(identityAlerts.map(async (alert) => {
      if (alert.meta?.photoUrl) return;
      try {
        let person = null;
        if (alert.meta?.personId) {
          const snap = await db.collection('people').doc(String(alert.meta.personId)).get();
          if (snap.exists) person = snap.data();
        }
        if (!person && alert.meta?.idNumber) {
          const snap = await db.collection('people')
            .where('dniNormalized', '==', String(alert.meta.idNumber).replace(/\D/g, ''))
            .limit(1)
            .get();
          if (!snap.empty) person = snap.docs[0].data();
        }
        if (person?.photoDataUrl) {
          alert.meta.photoUrl = person.photoDataUrl;
          alert.meta.hasPhoto = true;
        }
        if (person && !alert.meta.company) {
          alert.meta.company = person.company || person.empresa || person.centroCosto || null;
        }
        if (person && !alert.meta.legajo) {
          alert.meta.legajo = person.legajoNormalized || person.legajo || null;
        }
      } catch {
        // silencioso
      }
    }));
  }

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
