/**
 * Sincronización de eventos BioStar → MSS en lotes chicos.
 *
 * - Pide a BioStar hasta `eventsFetchLimit` eventos desde el cursor.
 * - Los manda a MSS de a `eventsBatchSize` (50): cada lote entra holgado en el
 *   corte de 60 s de Firebase Hosting.
 * - Después de CADA lote aceptado guarda el cursor (escritura atómica): si el
 *   siguiente falla, no se pierde lo ya importado y no se queda trabado.
 * - Si MSS responde éxito parcial, avanza hasta donde llegó y reintenta el resto.
 * - Si la página vino llena, sigue enseguida (drena atrasos) hasta `eventsMaxRounds`.
 *
 * También lleva el estado de salud que el puente informa en el heartbeat.
 */

const DEFAULT_EVENTS_BATCH_SIZE = 50;
const DEFAULT_EVENTS_FETCH_LIMIT = 200;
const DEFAULT_EVENTS_MAX_ROUNDS = 20;

const createSyncHealth = () => ({
  lastSuccessAt: null,
  lastError: null,
  lastErrorAt: null,
  cursor: null,
  backlogEstimate: null,
  users: null,
  events: null
});

const toMs = (iso) => {
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Payload del heartbeat. Manda "hace cuántos ms" además de la hora absoluta:
 * el servidor usa su reloj (la PC de planta puede estar desfasada).
 */
const buildHeartbeatPayload = (health, { nowMs = Date.now(), hostname, biostarHost, version } = {}) => {
  const ago = (iso) => {
    const ms = toMs(iso);
    return ms == null ? null : Math.max(0, nowMs - ms);
  };
  const summary = (s) => (s ? { ...s, agoMs: ago(s.at) } : undefined);
  return {
    lastSuccessAt: health.lastSuccessAt,
    lastSuccessAgoMs: ago(health.lastSuccessAt),
    lastError: health.lastError,
    lastErrorAt: health.lastErrorAt,
    lastErrorAgoMs: ago(health.lastErrorAt),
    cursor: health.cursor,
    backlogEstimate: health.backlogEstimate,
    users: summary(health.users),
    events: summary(health.events),
    hostname: hostname || undefined,
    biostarHost: biostarHost || undefined,
    version: version || undefined
  };
};

/**
 * @param {object} deps
 * @param {{ searchEventsSince: Function }} deps.biostar
 * @param {{ importEvents: Function }} deps.mss
 * @param {object} deps.cfg
 * @param {() => {lastEventDatetime: string|null}} deps.loadState
 * @param {(state: object) => void} deps.saveState
 * @param {object} deps.health  objeto mutable de createSyncHealth()
 */
const runEventSync = async ({
  biostar,
  mss,
  cfg,
  loadState,
  saveState,
  health,
  log = () => {},
  now = () => Date.now()
}) => {
  const batchSize = Math.max(1, Math.min(500, Number(cfg.eventsBatchSize) || DEFAULT_EVENTS_BATCH_SIZE));
  const fetchLimit = Math.max(batchSize, Number(cfg.eventsFetchLimit) || DEFAULT_EVENTS_FETCH_LIMIT);
  const maxRounds = Math.max(1, Number(cfg.eventsMaxRounds) || DEFAULT_EVENTS_MAX_ROUNDS);

  const state = loadState() || {};
  let cursor = state.lastEventDatetime || null;
  health.cursor = cursor;
  const totals = { accepted: 0, skipped: 0, deviceEvents: 0, batches: 0 };
  let pendingInPage = 0;
  let lastPageFull = false;

  try {
    for (let round = 0; round < maxRounds; round += 1) {
      const lookback = new Date(
        now() - Math.max(1, Number(cfg.eventsLookbackHours) || 24) * 60 * 60 * 1000
      ).toISOString();
      const since = cursor || lookback;
      // Retroceder 1 s para no perder el borde; MSS deduplica por id.
      const sinceDate = new Date(since);
      if (!Number.isNaN(sinceDate.getTime())) sinceDate.setSeconds(sinceDate.getSeconds() - 1);

      const events = await biostar.searchEventsSince({
        sinceIso: sinceDate.toISOString(),
        limit: fetchLimit
      });
      lastPageFull = events.length >= fetchLimit;
      if (!events.length) {
        pendingInPage = 0;
        break;
      }

      const cursorAtRoundStart = cursor;
      let offset = 0;
      pendingInPage = events.length;
      while (offset < events.length) {
        const chunk = events.slice(offset, offset + batchSize);
        const result = await mss.importEvents({
          events: chunk,
          defaultDoorId: cfg.defaultDoorId,
          doorMap: cfg.doorMap,
          devices: cfg.devices,
          successEventCodes: cfg.successEventCodes,
          cursorDatetime: cursor
        });
        totals.batches += 1;
        totals.accepted += Number(result.accepted) || 0;
        totals.skipped += Number(result.skipped) || 0;
        totals.deviceEvents += Number(result.deviceEvents) || 0;

        const processed = Number.isFinite(Number(result.processed))
          ? Number(result.processed)
          : chunk.length;
        if (result.cursorDatetime && result.cursorDatetime !== cursor) {
          cursor = result.cursorDatetime;
          saveState({ lastEventDatetime: cursor });
          health.cursor = cursor;
        }
        offset += Math.max(processed, result.partial ? 0 : chunk.length);
        pendingInPage = Math.max(0, events.length - offset);
        if (result.partial) {
          log('warn', 'MSS procesó el lote en parte; sigue con el resto', {
            processed,
            cursor
          });
          if (processed <= 0) break; // sin avance: reintenta en el próximo ciclo
        }
      }

      if (!lastPageFull) break;
      if (cursor === cursorAtRoundStart) {
        log('warn', 'Página llena sin avance del cursor; se reintenta en el próximo ciclo', { cursor });
        break;
      }
    }

    const at = new Date(now()).toISOString();
    health.lastSuccessAt = at;
    health.backlogEstimate = lastPageFull ? Math.max(pendingInPage, fetchLimit) : pendingInPage;
    health.events = {
      at,
      ok: true,
      error: null,
      accepted: totals.accepted,
      skipped: totals.skipped,
      deviceEvents: totals.deviceEvents,
      cursorDatetime: cursor
    };
    return { ok: true, ...totals, cursor, backlogEstimate: health.backlogEstimate };
  } catch (err) {
    const at = new Date(now()).toISOString();
    health.lastError = `Pases: ${String(err.message || err).slice(0, 300)}`;
    health.lastErrorAt = at;
    health.backlogEstimate = Math.max(pendingInPage, lastPageFull ? fetchLimit : 0);
    health.events = {
      at,
      ok: false,
      error: String(err.message || err).slice(0, 300),
      accepted: totals.accepted,
      skipped: totals.skipped,
      deviceEvents: totals.deviceEvents,
      cursorDatetime: cursor
    };
    err.syncTotals = { ...totals, cursor };
    throw err;
  }
};

/**
 * Usuarios en lotes (99 usuarios ya tardaban ~38 s en un solo POST).
 */
const runUserSync = async ({ users, mss, cfg, health, now = () => Date.now() }) => {
  const batchSize = Math.max(1, Number(cfg.usersBatchSize) || DEFAULT_EVENTS_BATCH_SIZE);
  const totals = { created: 0, updated: 0, skipped: 0 };
  try {
    for (let i = 0; i < users.length; i += batchSize) {
      const result = await mss.importUsers({
        users: users.slice(i, i + batchSize),
        defaultDoorId: cfg.defaultDoorId
      });
      totals.created += Number(result.created) || 0;
      totals.updated += Number(result.updated) || 0;
      totals.skipped += Number(result.skipped) || 0;
    }
    health.users = {
      at: new Date(now()).toISOString(),
      ok: true,
      error: null,
      biostarTotal: users.length,
      ...totals
    };
    return totals;
  } catch (err) {
    const at = new Date(now()).toISOString();
    health.lastError = `Personas: ${String(err.message || err).slice(0, 300)}`;
    health.lastErrorAt = at;
    health.users = {
      at,
      ok: false,
      error: String(err.message || err).slice(0, 300),
      biostarTotal: users.length,
      ...totals
    };
    throw err;
  }
};

module.exports = {
  DEFAULT_EVENTS_BATCH_SIZE,
  DEFAULT_EVENTS_FETCH_LIMIT,
  DEFAULT_EVENTS_MAX_ROUNDS,
  createSyncHealth,
  buildHeartbeatPayload,
  runEventSync,
  runUserSync
};
