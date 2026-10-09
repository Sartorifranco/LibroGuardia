'use strict';

const express = require('express');
const { auth, requireAnyPermission } = require('../middleware/auth');
const { logAdminAction } = require('../lib/auditLog');
const { listAreas, createArea, updateArea, deleteArea } = require('../lib/areas');

const router = express.Router();
const canManage = requireAnyPermission(['access.doors.manage', 'access.control']);

router.get('/api/admin/areas', auth, canManage, async (_req, res) => {
  try {
    const areas = await listAreas();
    res.json({ areas });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.status ? err.message : 'No se pudieron leer los lugares.' });
  }
});

router.post('/api/admin/areas', auth, canManage, async (req, res) => {
  try {
    const area = await createArea(req.body && req.body.name);
    if (!area.fixed) {
      await logAdminAction({
        req,
        action: 'area.create',
        targetType: 'area',
        targetId: area.id,
        after: area
      }).catch((err) => console.error('auditLog area.create', err.message));
    }
    res.status(area.fixed ? 200 : 201).json({ message: area.fixed ? 'El exterior ya está.' : 'Lugar creado.', area });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.status ? err.message : 'No se pudo crear el lugar.' });
  }
});

router.put('/api/admin/areas/:id', auth, canManage, async (req, res) => {
  try {
    const { before, after } = await updateArea(req.params.id, req.body && req.body.name);
    await logAdminAction({
      req,
      action: 'area.update',
      targetType: 'area',
      targetId: after.id,
      before,
      after
    }).catch((err) => console.error('auditLog area.update', err.message));
    res.json({ message: 'Lugar actualizado.', area: after });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.status ? err.message : 'No se pudo guardar el lugar.' });
  }
});

router.delete('/api/admin/areas/:id', auth, canManage, async (req, res) => {
  try {
    const before = await deleteArea(req.params.id);
    await logAdminAction({
      req,
      action: 'area.delete',
      targetType: 'area',
      targetId: before.id,
      before
    }).catch((err) => console.error('auditLog area.delete', err.message));
    res.json({ message: 'Lugar borrado.' });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.status ? err.message : 'No se pudo borrar el lugar.' });
  }
});

module.exports = router;
