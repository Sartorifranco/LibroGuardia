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
 * @returns {Promise<Map<string, object>>} doorId → localStation meta
 */
const buildDoorLocalStationMap = async () => {
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
  lectoresSnap.docs.forEach((doc) => {
    const data = doc.data() || {};
    const doorId = String(data.doorId || '').trim();
    const estacionId = String(data.estacionId || '').trim();
    if (!doorId || !estacionId) return;
    const meta = estacionesById.get(estacionId);
    if (!meta) return;
    // Primera estación gana si hay varios lectores de la misma puerta.
    if (!byDoor.has(doorId)) byDoor.set(doorId, meta);
  });

  return byDoor;
};

/**
 * Enriquece puertas del panel guardia con relayMode + localStation.
 */
const enrichDoorsWithLocalStations = async (doors = []) => {
  const map = await buildDoorLocalStationMap();
  return (doors || []).map((door) => {
    const relayMode = resolveRelayMode(door);
    const localStation = map.get(String(door.id || '').trim()) || null;
    return {
      ...door,
      relayMode,
      localStation
    };
  });
};

module.exports = {
  toEstacionMeta,
  buildDoorLocalStationMap,
  enrichDoorsWithLocalStations,
  toIsoOrNull
};
