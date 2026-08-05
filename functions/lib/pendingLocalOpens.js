/**
 * Cola de aperturas para puertas en modo local.
 * El admin/guardia pide por HTTPS; el bridge de planta reclama y dispara el relé por LAN.
 * Evita Mixed Content (HTTPS → HTTP) y secretos pegados a mano.
 */

const { db, FieldValue } = require('../firestore');

const COLLECTION = 'pending_local_opens';
const TTL_MS = 45_000;

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

/**
 * @param {{
 *   doorId: string,
 *   localRelay: object,
 *   requestedBy?: string|null,
 *   reason?: string
 * }} opts
 */
const enqueuePendingLocalOpen = async ({
  doorId,
  localRelay,
  requestedBy = null,
  reason = 'manual_open'
} = {}) => {
  const id = String(doorId || '').trim();
  if (!id) throw httpError(400, 'doorId requerido');
  const driver = localRelay?.driver === 'generic_http' ? 'generic_http' : 'sr201';
  const host = String(localRelay?.host || '').trim();
  const httpUrl = String(localRelay?.httpUrl || '').trim();
  if (driver === 'generic_http' ? !httpUrl : !host) {
    throw httpError(
      503,
      driver === 'generic_http'
        ? 'Puerta en modo local sin URL HTTP. Completá la URL en Admin → Equipos de acceso → Puertas.'
        : 'Puerta en modo local sin IP de relé. Completá Host en Admin → Puertas.'
    );
  }

  const now = Date.now();
  const ref = db.collection(COLLECTION).doc();
  const payload = {
    doorId: id,
    localRelay: {
      driver,
      host: driver === 'generic_http' ? '' : host,
      port: driver === 'generic_http' ? 0 : (Number(localRelay.port) || 6722),
      channel: Number(localRelay.channel) === 2 ? 2 : 1,
      pulseMode: localRelay.pulseMode === 'jog' ? 'jog' : 'timed',
      pulseSeconds: Math.max(1, Math.min(99, Number(localRelay.pulseSeconds) || 3)),
      httpUrl: driver === 'generic_http' ? httpUrl : '',
      httpMethod: String(localRelay.httpMethod || 'POST').toUpperCase(),
      httpAuthToken: String(localRelay.httpAuthToken || '')
    },
    requestedBy: requestedBy || null,
    reason: String(reason || 'manual_open').slice(0, 80),
    status: 'pending',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString(),
    createdAtMs: now
  };
  await ref.set({
    ...payload,
    createdAtServer: FieldValue.serverTimestamp()
  });

  return {
    id: ref.id,
    via: 'local-queue',
    doorId: id,
    message: 'Pedido enviado a la estación. La puerta abre en unos segundos.',
    localRelay: payload.localRelay,
    expiresAt: payload.expiresAt
  };
};

/**
 * Reclama (y marca claimed) los pedidos pendientes de una puerta.
 * Solo el bridge kiosk debe llamar esto.
 */
const claimPendingLocalOpens = async (doorId, { limit = 5 } = {}) => {
  const id = String(doorId || '').trim();
  if (!id) throw httpError(400, 'doorId requerido');

  // La estación pollea cada ~2 s. Sin filtrar por status, cada poll pagaba una
  // lectura por cada apertura histórica de la puerta y el costo crecía para
  // siempre; los pedidos ya resueltos se borran justamente para que la consulta
  // vuelva vacía.
  const snap = await db.collection(COLLECTION)
    .where('doorId', '==', id)
    .where('status', '==', 'pending')
    .limit(30)
    .get();

  const now = Date.now();
  const max = Math.max(1, Math.min(20, Number(limit) || 5));
  const claimed = [];
  const batch = db.batch();
  let writes = 0;

  for (const doc of snap.docs) {
    if (claimed.length >= max) break;
    const data = doc.data() || {};

    batch.delete(doc.ref);
    writes += 1;

    const expiresAtMs = Date.parse(data.expiresAt || '') || 0;
    if (expiresAtMs && expiresAtMs < now) continue;

    claimed.push({
      id: doc.id,
      doorId: data.doorId,
      localRelay: data.localRelay || null,
      reason: data.reason || null,
      requestedBy: data.requestedBy || null,
      createdAt: data.createdAt || null
    });
  }

  if (writes > 0) await batch.commit();
  return { opens: claimed };
};

module.exports = {
  COLLECTION,
  TTL_MS,
  enqueuePendingLocalOpen,
  claimPendingLocalOpens
};
