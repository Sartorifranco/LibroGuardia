const { Timestamp } = require('../../firestore');
const { db } = require('../../firestore');

/**
 * ¿Hubo N denegados recientes para el mismo DNI o la misma puerta?
 */
const checkRepeatedDenials = async ({
  idNumber = '',
  doorId = null,
  threshold = 3,
  windowMinutes = 10
} = {}) => {
  const dni = String(idNumber || '').trim();
  const door = doorId ? String(doorId).trim() : '';
  if (!dni && !door) {
    return { triggered: false, count: 0 };
  }

  const since = new Date(Date.now() - (Number(windowMinutes) || 10) * 60 * 1000);
  const snap = await db.collection('accessEvents')
    .where('type', '==', 'denied')
    .where('createdAt', '>=', Timestamp.fromDate(since))
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get()
    .catch(async () => {
      // Fallback sin índice compuesto: lee recientes y filtra en memoria.
      const recent = await db.collection('accessEvents')
        .orderBy('createdAt', 'desc')
        .limit(80)
        .get();
      return recent;
    });

  const sinceMs = since.getTime();
  const matches = snap.docs.filter((doc) => {
    const data = doc.data() || {};
    if (data.type !== 'denied') return false;
    const created = data.createdAt?.toDate ? data.createdAt.toDate().getTime() : 0;
    if (created && created < sinceMs) return false;
    if (dni && String(data.idNumber || '').trim() === dni) return true;
    if (door && String(data.doorId || '').trim() === door) return true;
    return false;
  });

  const count = matches.length;
  const limit = Math.max(2, Number(threshold) || 3);
  return {
    triggered: count >= limit,
    count,
    threshold: limit,
    windowMinutes: Number(windowMinutes) || 10,
    idNumber: dni || null,
    doorId: door || null
  };
};

module.exports = {
  checkRepeatedDenials
};
