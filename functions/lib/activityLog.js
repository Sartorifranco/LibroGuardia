/**
 * Auditoría de acciones administrativas (borra, desactiva, etc.).
 * No bloquea el flujo principal: los callers deben usar .catch().
 */
const logActivity = async (db, FieldValue, {
  actorUsername = '',
  actorId = '',
  action = '',
  summary = '',
  meta = null
} = {}) => {
  if (!db || !FieldValue) return null;
  const payload = {
    actorUsername: String(actorUsername || '').trim(),
    actorId: String(actorId || '').trim(),
    action: String(action || '').trim(),
    summary: String(summary || '').trim(),
    createdAt: FieldValue.serverTimestamp()
  };
  if (meta && typeof meta === 'object') {
    payload.meta = meta;
  }
  const ref = await db.collection('activityLog').add(payload);
  return ref.id;
};

module.exports = { logActivity };
