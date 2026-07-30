/**
 * API Admin / bridge BioStar 2 → MSS Guard.
 */

const express = require('express');
const { auth, requireAnyPermission } = require('../middleware/auth');
const { logAdminAction } = require('../lib/auditLog');
const { importBiostarUsers, importBiostarEvents } = require('../lib/biostarImport');

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
 * Body: { events: [...], defaultDoorId?, doorMap?, successEventCodes?, cursorDatetime? }
 */
router.post('/api/admin/biostar/import-events', auth, canManage, async (req, res) => {
  try {
    const events = req.body?.events || req.body?.EventCollection?.rows || [];
    const result = await importBiostarEvents(events, {
      defaultDoorId: req.body?.defaultDoorId || null,
      doorMap: req.body?.doorMap || {},
      successEventCodes: req.body?.successEventCodes,
      cursorDatetime: req.body?.cursorDatetime || null
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al importar eventos BioStar',
      code: err.code
    });
  }
});

module.exports = router;
