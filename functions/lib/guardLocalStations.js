/**
 * Resuelve, para el panel del guardia, la estación LAN asociada a cada puerta
 * (vía lectores.estacionId → estaciones).
 *
 * El secreto local se entrega SOLO a quien ya tiene access.manual_open:
 * es el mismo nivel de confianza que el botón “Abrir” (presencia física en
 * planta + JWT). El servidor HTTP de la estación no está expuesto a internet.
 */

const { db } = require('../firestore');
const { resolveRelayMode } = require('./relayDispatch');
const { buildDoorHealthMap } = require('./stationHealth');

const toIsoOrNull = (value) => {
  if (!value) return null;
  if (typeof value.toDate === 'function') {
    try { return value.toDate().toISOString(); } catch { return null; }
  }
  if (typeof value === 'string') return value;
  return null;
};

const toEstacionMeta = (id, data = {}) => {
  if (!data.activa && data.activa !== undefined) return null;
  const direccionRedLocal = String(data.direccionRedLocal || '').trim();
  const puertoServidorLocal = Number(data.puertoServidorLocal) || 8787;
  const secretoLocal = String(data.secretoLocal || '').trim();
  if (!direccionRedLocal || !secretoLocal) return null;
  return {
    estacionId: id,
    nombre: data.nombre || '',
    direccionRedLocal,
    puertoServidorLocal,
    secretoLocal
  };
};

/**
 * @returns {Promise<{ stationByDoor: Map<string, object>, healthByDoor: Map<string, object> }>}
 */
const loadDoorStationData = async () => {
  const [lectoresSnap, estacionesSnap] = await Promise.all([
    db.collection('lectores').get(),
    db.collection('estaciones').get()
  ]);

  const estacionesById = new Map();
  estacionesSnap.docs.forEach((doc) => {
    const meta = toEstacionMeta(doc.id, doc.data() || {});
    if (meta) estacionesById.set(doc.id, meta);
  });

  const byDoor = new Map();
  const lectores = [];
  lectoresSnap.docs.forEach((doc) => {
    const data = doc.data() || {};
    lectores.push({ id: doc.id, ...data });
    const doorId = String(data.doorId || '').trim();
    const estacionId = String(data.estacionId || '').trim();
    if (!doorId || !estacionId) return;
    const meta = estacionesById.get(estacionId);
    if (!meta) return;
    // Primera estación gana si hay varios lectores de la misma puerta.
    if (!byDoor.has(doorId)) byDoor.set(doorId, meta);
  });

  return { stationByDoor: byDoor, healthByDoor: buildDoorHealthMap(lectores) };
};

/**
 * @returns {Promise<Map<string, object>>} doorId → localStation meta
 */
const buildDoorLocalStationMap = async () => (await loadDoorStationData()).stationByDoor;

/**
 * Enriquece puertas del panel guardia con relayMode + localStation + health.
 * health = peor estado de los lectores de la puerta: {status: online|problem|stale|offline, reason}
 * (null si la puerta no tiene lector de estación, p. ej. solo BioStar).
 */
const enrichDoorsWithLocalStations = async (doors = []) => {
  const { stationByDoor, healthByDoor } = await loadDoorStationData();
  return (doors || []).map((door) => {
    const relayMode = resolveRelayMode(door);
    const key = String(door.id || '').trim();
    const localStation = stationByDoor.get(key) || null;
    return {
      ...door,
      relayMode,
      localStation,
      health: healthByDoor.get(key) || null
    };
  });
};

module.exports = {
  toEstacionMeta,
  buildDoorLocalStationMap,
  enrichDoorsWithLocalStations,
  toIsoOrNull
};
