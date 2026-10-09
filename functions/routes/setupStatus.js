'use strict';

const express = require('express');
const { auth, requireAnyPermission } = require('../middleware/auth');
const { getSetupStatus } = require('../lib/setupStatus');

const router = express.Router();

/** Cualquier permiso que abre el panel. No es un permiso nuevo. */
const canSeeAdmin = requireAnyPermission([
  'users.view',
  'roles.view',
  'roles.manage',
  'master.vehicles.write',
  'master.citaciones.write',
  'master.nomina.write',
  'fleet.upload',
  'settings.permissions',
  'access.control',
  'access.doors.manage',
  'audit.view',
  'notifications.config',
  'empresas.manage',
  'destinos.manage',
  'lectores.manage',
  'visitas.approve',
  'access.groups.manage',
  'personas.puertas.asignar'
]);

router.get('/api/admin/setup-status', auth, canSeeAdmin, async (_req, res) => {
  try {
    const status = await getSetupStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ message: 'No se pudo revisar la puesta en marcha.' });
  }
});

module.exports = router;
