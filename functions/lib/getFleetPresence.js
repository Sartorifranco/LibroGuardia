const { db } = require('../firestore');
const { computeFleetPresence } = require('./lib/fleetPresence');
const { getEffectiveEntryType } = require('./lib/entriesQuery');

/**
 * Carga móviles + entradas recientes de flota y calcula adentro/afuera.
 */
const getFleetPresence = async ({ entryLimit = 400 } = {}) => {
  const [mobilesSnap, entriesSnap] = await Promise.all([
    db.collection('mobiles').get().catch(() => ({ docs: [] })),
    db.collection('entries')
      .orderBy('timestamp', 'desc')
      .limit(entryLimit)
      .get()
  ]);

  const mobiles = (mobilesSnap.docs || []).map((doc) => ({ id: doc.id, ...doc.data() }));
  const entries = entriesSnap.docs.map((doc) => {
    const data = doc.data() || {};
    return {
      id: doc.id,
      ...data,
      type: getEffectiveEntryType(data) || data.type
    };
  });

  return computeFleetPresence({ mobiles, entries });
};

module.exports = {
  getFleetPresence
};
