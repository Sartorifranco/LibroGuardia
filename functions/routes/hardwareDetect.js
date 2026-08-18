/**
 * Auto-detección de marca de hardware (Admin + estación LAN).
 * Los endpoints con password NO loguean body/response completos.
 */

const express = require('express');
const { auth, requirePermission } = require('../middleware/auth');
const { logAdminAction } = require('../lib/auditLog');
const { resolveAuthUsername } = require('../lib/lectores');
const {
  createHardwareDetectJob,
  claimHardwareDetectJobs,
  reportHardwareDetectResult,
  getHardwareDetectJob
} = require('../lib/hardwareDetectJobs');

const router = express.Router();

/**
 * Importante (seguridad): no hay morgan/body-logger global en app.js.
 * Aun así, audit/console de estos endpoints NUNCA incluyen password en claro:
 * - create: after solo tiene jobId/host/estacionId (sin password)
 * - claim: no se hace logAdminAction del payload con password
 */

router.post(
  '/api/admin/hardware/detect',
  auth,
  requirePermission('lectores.manage'),
  async (req, res) => {
    try {
      // No loguear req.body (contiene password tipado por el admin).
      const result = await createHardwareDetectJob({
        estacionId: req.body?.estacionId,
        host: req.body?.host,
        port: req.body?.port,
        username: req.body?.username,
        password: req.body?.password,
        httpsPreferred: Boolean(req.body?.httpsPreferred),
        requestedBy: req.user?.username || req.user?.id || null
      });
      logAdminAction({
        req,
        action: 'hardware.detect_create',
        targetType: 'hardware_detect_job',
        targetId: result.jobId,
        after: {
          jobId: result.jobId,
          estacionId: String(req.body?.estacionId || ''),
          host: String(req.body?.host || ''),
          // password omitido / redactado a propósito
          password: '[REDACTED]'
        }
      }).catch(() => {});
      res.status(202).json(result);
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message || 'Error al crear detección',
        code: err.code
      });
    }
  }
);

router.get(
  '/api/admin/hardware/detect/:jobId',
  auth,
  requirePermission('lectores.manage'),
  async (req, res) => {
    try {
      const job = await getHardwareDetectJob(req.params.jobId);
      res.json({ ok: true, job });
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message || 'Error al consultar job' });
    }
  }
);

router.post('/api/estaciones/claim-hardware-detect', auth, async (req, res) => {
  try {
    const username = resolveAuthUsername(req.user);
    // Response incluye password en claro hacia la estación — no loguear res.json ni jobs[].password
    const result = await claimHardwareDetectJobs(username, {
      limit: req.body?.limit
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al reclamar jobs de detección',
      code: err.code
    });
  }
});

router.post('/api/estaciones/hardware-detect-result', auth, async (req, res) => {
  try {
    const username = resolveAuthUsername(req.user);
    const job = await reportHardwareDetectResult(username, req.body || {});
    res.json({ ok: true, job });
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al reportar resultado',
      code: err.code
    });
  }
});

module.exports = router;
