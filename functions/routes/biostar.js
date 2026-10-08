/**
 * API Admin / bridge BioStar 2 → MSS Guard.
 */

const express = require('express');
const { auth, requireAnyPermission } = require('../middleware/auth');
const { logAdminAction } = require('../lib/auditLog');
const { importBiostarUsers, importBiostarEvents } = require('../lib/biostarImport');
const {
  touchBiostarHeartbeat,
  getBiostarBridgeStatus,
  recordBiostarEventsImport
} = require('../lib/biostarBridgeStatus');

const router = express.Router();

const canManage = requireAnyPermission([
  'access.doors.manage',
  'access.control',
  'master.nomina.write',
  'lectores.manage'
]);

/**
 * Importa usuarios BioStar (UserCollection.rows) a people.
 * Body: { users: [...], defaultDoorId?: string }
 */
router.post('/api/admin/biostar/import-users', auth, canManage, async (req, res) => {
  try {
    const users = req.body?.users || req.body?.UserCollection?.rows || [];
    const result = await importBiostarUsers(users, {
      defaultDoorId: req.body?.defaultDoorId || null
    });
    logAdminAction({
      req,
      action: 'biostar.import_users',
      targetType: 'biostar',
      targetId: 'users',
      after: {
        created: result.created,
        updated: result.updated,
        total: result.total
      }
    }).catch(() => {});
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al importar usuarios BioStar',
      code: err.code
    });
  }
});

/**
 * Importa eventos BioStar a entries.
 * Body: { events: [...], defaultDoorId?, doorMap?, devices?, successEventCodes?, cursorDatetime? }
 * Respuesta: accepted, deviceEvents, skipped, processed, partial, cursorDatetime, lastEventId.
 * Si partial es true, el puente avanza el cursor hasta cursorDatetime y reenvía el resto.
 */
router.post('/api/admin/biostar/import-events', auth, canManage, async (req, res) => {
  try {
    const events = req.body?.events || req.body?.EventCollection?.rows || [];
    const result = await importBiostarEvents(events, {
      defaultDoorId: req.body?.defaultDoorId || null,
      doorMap: req.body?.doorMap || {},
      devices: req.body?.devices || {},
      successEventCodes: req.body?.successEventCodes,
      cursorDatetime: req.body?.cursorDatetime || null
    });
    await recordBiostarEventsImport(result).catch((err) => {
      console.warn('[biostar] No se pudo registrar la importación', err.message);
    });
    // El detalle por evento no le sirve al puente y engorda la respuesta.
    const { results, ...summary } = result;
    res.json({ ok: true, ...summary });
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al importar eventos BioStar',
      code: err.code
    });
  }
});

router.post('/api/admin/biostar/heartbeat', auth, canManage, async (req, res) => {
  try {
    const status = await touchBiostarHeartbeat(req.body || {});
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error en heartbeat BioStar'
    });
  }
});

router.get('/api/admin/biostar/status', auth, canManage, async (_req, res) => {
  try {
    const status = await getBiostarBridgeStatus();
    res.json({ status });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Error al leer estado BioStar' });
  }
});

module.exports = router;
