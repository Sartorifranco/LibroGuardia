/**
 * Plano del predio: imagen de la planta guardada como data URL en Firestore
 * (sin Storage). Solo usuarios autenticados con permiso de puertas.
 */

const express = require('express');
const { db, FieldValue } = require('../firestore');
const { auth, requirePermission, requireAnyPermission, sendServerError } = require('../middleware/auth');
const { logAdminAction } = require('../lib/auditLog');

const router = express.Router();

const MAX_IMAGE_BYTES = 900 * 1024;
const MIN_SIDE = 100;
const MAX_SIDE = 8000;
const DATA_URL_RE = /^data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;
const READ_PERMS = ['access.doors.manage', 'access.control'];

const planRef = () => db.collection('sites').doc('principal').collection('plans').doc('planta-baja');

const httpError = (status, message) => Object.assign(new Error(message), { status });

const base64Bytes = (b64) => {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
};

const validatePlanBody = (body = {}) => {
  const imageDataUrl = typeof body.imageDataUrl === 'string' ? body.imageDataUrl.trim() : '';
  const match = DATA_URL_RE.exec(imageDataUrl);
  if (!match) throw httpError(400, 'La imagen tiene que ser WebP, PNG o JPEG.');
  if (base64Bytes(match[2]) > MAX_IMAGE_BYTES) {
    throw httpError(400, 'La imagen es muy pesada (máximo 900 KB).');
  }
  const width = Number(body.width);
  const height = Number(body.height);
  const validSide = (n) => Number.isInteger(n) && n >= MIN_SIDE && n <= MAX_SIDE;
  if (!validSide(width) || !validSide(height)) {
    throw httpError(400, `El ancho y el alto tienen que ser enteros entre ${MIN_SIDE} y ${MAX_SIDE}.`);
  }
  return { imageDataUrl, width, height };
};

const toIso = (value) => (value?.toDate ? value.toDate().toISOString() : value || null);

const readPlan = async () => {
  const snap = await planRef().get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  if (!data.imageDataUrl) return null;
  return {
    imageDataUrl: data.imageDataUrl,
    width: data.width,
    height: data.height,
    version: Number(data.version) || 0,
    updatedAt: toIso(data.updatedAt)
  };
};

const planSummary = (plan) => (plan ? { width: plan.width, height: plan.height, version: plan.version } : null);

router.get('/api/admin/site-plan', auth, requireAnyPermission(READ_PERMS), async (_req, res) => {
  try {
    res.json({ plan: await readPlan() });
  } catch (err) {
    sendServerError(res, err, 'Error al leer el plano');
  }
});

router.get('/api/admin/site-plan/meta', auth, requireAnyPermission(READ_PERMS), async (_req, res) => {
  try {
    const plan = await readPlan();
    res.json({ version: plan ? plan.version : null });
  } catch (err) {
    sendServerError(res, err, 'Error al leer el plano');
  }
});

router.put('/api/admin/site-plan', auth, requirePermission('access.doors.manage'), async (req, res) => {
  try {
    const payload = validatePlanBody(req.body || {});
    const before = await readPlan();
    const version = (before?.version || 0) + 1;
    await planRef().set({
      ...payload,
      version,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: req.user?.username || req.user?.id || 'admin'
    });
    const plan = await readPlan();
    logAdminAction({
      req,
      action: 'site_plan.update',
      targetType: 'site_plan',
      targetId: 'planta-baja',
      before: planSummary(before),
      after: planSummary(plan)
    }).catch((err) => console.error('auditLog site_plan.update:', err.message));
    res.json({ message: 'Plano guardado', plan });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    sendServerError(res, err, 'Error al guardar el plano');
  }
});

router.delete('/api/admin/site-plan', auth, requirePermission('access.doors.manage'), async (req, res) => {
  try {
    const before = await readPlan();
    await planRef().delete();
    logAdminAction({
      req,
      action: 'site_plan.delete',
      targetType: 'site_plan',
      targetId: 'planta-baja',
      before: planSummary(before),
      after: null
    }).catch((err) => console.error('auditLog site_plan.delete:', err.message));
    res.json({ message: 'Plano quitado' });
  } catch (err) {
    sendServerError(res, err, 'Error al quitar el plano');
  }
});

router._test = { validatePlanBody, MAX_IMAGE_BYTES };

module.exports = router;
