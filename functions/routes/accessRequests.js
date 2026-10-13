/**
 * Bandeja de autorizaciones: pedir, listar, aprobar, rechazar, cancelar.
 */

const express = require('express');
const {
  auth,
  requireAnyPermission,
  sendServerError
} = require('../middleware/auth');
const {
  actorFromUser,
  createAccessRequest,
  listAccessRequests,
  approveAccessRequest,
  rejectAccessRequest,
  cancelAccessRequest,
  listOptions
} = require('../lib/accessRequests');

const router = express.Router();

const CAN_SEE = ['autorizaciones.solicitar', 'autorizaciones.aprobar', 'autorizaciones.aprobar_todas'];
const CAN_ASK = ['autorizaciones.solicitar', 'master.citaciones.preregister', 'access.exceptional_entry', 'visitas.request', 'visitas.create'];
const CAN_DECIDE = ['autorizaciones.aprobar', 'autorizaciones.aprobar_todas'];

router.get('/api/requests/options', auth, requireAnyPermission([...CAN_SEE, 'users.edit']), async (req, res) => {
  try {
    res.json(await listOptions());
  } catch (err) {
    sendServerError(res, err, 'Error al cargar opciones');
  }
});

router.post('/api/requests', auth, requireAnyPermission(CAN_ASK), async (req, res) => {
  try {
    const actor = await actorFromUser(req);
    const created = await createAccessRequest({
      ...req.body,
      origen: req.body?.origen
    }, actor, { req, requireDoors: true });
    res.status(201).json({
      message: created.message,
      request: created
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'No se pudo enviar la solicitud' });
  }
});

router.get('/api/requests', auth, requireAnyPermission(CAN_SEE), async (req, res) => {
  try {
    const actor = await actorFromUser(req);
    const page = await listAccessRequests(actor, {
      estado: req.query.estado,
      empresaId: req.query.empresaId,
      limit: req.query.limit
    });
    res.json(page);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'No se pudieron listar las solicitudes' });
  }
});

router.post('/api/requests/:id/approve', auth, requireAnyPermission(CAN_DECIDE), async (req, res) => {
  try {
    const actor = await actorFromUser(req);
    const request = await approveAccessRequest(req.params.id, actor, {
      nota: req.body?.nota,
      req
    });
    res.json({ message: 'Solicitud aprobada. Ya puede ingresar en el horario indicado.', request });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'No se pudo aprobar' });
  }
});

router.post('/api/requests/:id/reject', auth, requireAnyPermission(CAN_DECIDE), async (req, res) => {
  try {
    const actor = await actorFromUser(req);
    const request = await rejectAccessRequest(req.params.id, actor, {
      nota: req.body?.nota,
      req
    });
    res.json({ message: 'Solicitud rechazada.', request });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'No se pudo rechazar' });
  }
});

router.post('/api/requests/:id/cancel', auth, requireAnyPermission(CAN_SEE), async (req, res) => {
  try {
    const actor = await actorFromUser(req);
    const request = await cancelAccessRequest(req.params.id, actor, { req });
    res.json({ message: 'Solicitud cancelada.', request });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'No se pudo cancelar' });
  }
});

module.exports = router;
