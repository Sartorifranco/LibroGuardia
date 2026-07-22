/**
 * Enriquece puertas con el último disparo de relé (accessEvents).
 * No toca doorController — solo lectura de eventos.
 */

const { db } = require('../firestore');

const toDate = (value) => {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * @param {Array<{id:string}>} doors
 * @param {{ limit?: number }} [opts]
 */
const enrichDoorsWithLastPulse = async (doors = [], { limit = 200 } = {}) => {
  if (!doors.length) return [];

  let snap;
  try {
    snap = await db.collection('accessEvents')
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
  } catch (err) {
    // Índice faltante u otro: devolver puertas sin enriquecer
    return doors.map((door) => ({
      ...door,
      lastPulse: null,
      lastPulseError: err.message
    }));
  }

  const lastByDoor = new Map();
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const doorId = data.doorId || data.door?.id || null;
    if (!doorId || lastByDoor.has(doorId)) continue;
    const createdAt = toDate(data.createdAt);
    const relayOk = data.relayTriggered === true;
    lastByDoor.set(doorId, {
      at: createdAt ? createdAt.toISOString() : null,
      ok: relayOk,
      type: data.type || null,
      message: data.message || data.error || null
    });
  }

  return doors.map((door) => ({
    ...door,
    lastPulse: lastByDoor.get(door.id) || null
  }));
};

module.exports = {
  enrichDoorsWithLastPulse
};
