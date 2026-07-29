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

/** Eventos que no representan un disparo de relé. */
const NON_PULSE_TYPES = new Set([
  'identity_verification',
  'repeated_denials'
]);

/**
 * ¿Este accessEvent cuenta como intento de apertura / relé?
 */
const isRelayPulseEvent = (data = {}) => {
  const type = String(data.type || '').toLowerCase();
  if (NON_PULSE_TYPES.has(type)) return false;
  if (data.relayError) return true;
  if (typeof data.relayTriggered === 'boolean') return true;
  return type === 'manual_open' || type === 'door_open';
};

/**
 * Éxito del disparo: relé nube OK, o modo local sin error (el bridge abre en planta).
 */
const isRelayPulseOk = (data = {}) => {
  if (data.relayError) return false;
  if (data.relayTriggered === true) return true;
  if (data.relayMode === 'local') return true;
  return false;
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
    return doors.map((door) => ({
      ...door,
      lastPulse: null,
      lastPulseError: err.message
    }));
  }

  const lastByDoor = new Map();
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (!isRelayPulseEvent(data)) continue;
    const doorId = data.doorId || data.door?.id || null;
    if (!doorId || lastByDoor.has(doorId)) continue;
    const createdAt = toDate(data.createdAt);
    lastByDoor.set(doorId, {
      at: createdAt ? createdAt.toISOString() : null,
      ok: isRelayPulseOk(data),
      type: data.type || null,
      message: data.message || data.error || data.relayError || null
    });
  }

  return doors.map((door) => ({
    ...door,
    lastPulse: lastByDoor.get(door.id) || null
  }));
};

module.exports = {
  enrichDoorsWithLastPulse,
  isRelayPulseEvent,
  isRelayPulseOk
};
