/**
 * CRUD admin: empresas + destinos (predio multi-empresa).
 * Router propio: no mezclar con masterData (personal/vehículos) ni access (puertas/hardware).
 */

const express = require('express');
const { db, FieldValue } = require('../firestore');
const { getDoorsConfig } = require('../lib/doorsConfig');
const {
  sanitizeEmpresaPayload,
  sanitizeDestinoPayload
} = require('../lib/empresasDestinos');
const { auth, requirePermission } = require('../middleware/auth');
const { logAdminAction } = require('../lib/auditLog');

const router = express.Router();

const EMPRESAS = 'empresas';
const DESTINOS = 'destinos';

const toJson = (doc) => ({ id: doc.id, ...doc.data() });

// —— Empresas ——

router.get('/api/admin/empresas', auth, requirePermission('empresas.manage'), async (_req, res) => {
  try {
    const snap = await db.collection(EMPRESAS).orderBy('nombre').get();
    res.json({ empresas: snap.docs.map(toJson) });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Error al listar empresas' });
  }
});

router.post('/api/admin/empresas', auth, requirePermission('empresas.manage'), async (req, res) => {
  try {
    const payload = sanitizeEmpresaPayload(req.body || {});
    const ref = db.collection(EMPRESAS).doc();
    const doc = {
      ...payload,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    await ref.set(doc);
    const saved = { id: ref.id, ...payload };
    logAdminAction({
      req,
      action: 'empresa.create',
      targetType: 'empresa',
      targetId: ref.id,
      after: saved
    });
    res.status(201).json({ message: 'Empresa creada', empresa: saved });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'Error al crear empresa', code: err.code });
  }
});

router.put('/api/admin/empresas/:id', auth, requirePermission('empresas.manage'), async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const ref = db.collection(EMPRESAS).doc(id);
    const beforeSnap = await ref.get();
    if (!beforeSnap.exists) {
      return res.status(404).json({ message: 'Empresa no encontrada' });
    }
    const payload = sanitizeEmpresaPayload({ ...beforeSnap.data(), ...req.body });
    await ref.set({
      ...payload,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    const saved = { id, ...payload };
    logAdminAction({
      req,
      action: 'empresa.update',
      targetType: 'empresa',
      targetId: id,
      before: { id, ...beforeSnap.data() },
      after: saved
    });
    res.json({ message: 'Empresa actualizada', empresa: saved });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'Error al actualizar empresa', code: err.code });
  }
});

router.delete('/api/admin/empresas/:id', auth, requirePermission('empresas.manage'), async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const ref = db.collection(EMPRESAS).doc(id);
    const beforeSnap = await ref.get();
    if (!beforeSnap.exists) {
      return res.status(404).json({ message: 'Empresa no encontrada' });
    }
    await ref.delete();
    logAdminAction({
      req,
      action: 'empresa.delete',
      targetType: 'empresa',
      targetId: id,
      before: { id, ...beforeSnap.data() }
    });
    res.json({ message: 'Empresa eliminada', id });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Error al eliminar empresa' });
  }
});

// —— Destinos ——

router.get('/api/admin/destinos', auth, requirePermission('destinos.manage'), async (_req, res) => {
  try {
    const snap = await db.collection(DESTINOS).orderBy('nombre').get();
    res.json({ destinos: snap.docs.map(toJson) });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Error al listar destinos' });
  }
});

router.post('/api/admin/destinos', auth, requirePermission('destinos.manage'), async (req, res) => {
  try {
    const doorsConfig = await getDoorsConfig();
    const payload = sanitizeDestinoPayload(req.body || {}, doorsConfig);
    const ref = db.collection(DESTINOS).doc();
    await ref.set({
      ...payload,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    const saved = { id: ref.id, ...payload };
    logAdminAction({
      req,
      action: 'destino.create',
      targetType: 'destino',
      targetId: ref.id,
      after: saved
    });
    res.status(201).json({ message: 'Destino creado', destino: saved });
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al crear destino',
      code: err.code,
      doorId: err.doorId
    });
  }
});

router.put('/api/admin/destinos/:id', auth, requirePermission('destinos.manage'), async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const ref = db.collection(DESTINOS).doc(id);
    const beforeSnap = await ref.get();
    if (!beforeSnap.exists) {
      return res.status(404).json({ message: 'Destino no encontrado' });
    }
    const doorsConfig = await getDoorsConfig();
    const payload = sanitizeDestinoPayload({ ...beforeSnap.data(), ...req.body }, doorsConfig);
    await ref.set({
      ...payload,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    const saved = { id, ...payload };
    logAdminAction({
      req,
      action: 'destino.update',
      targetType: 'destino',
      targetId: id,
      before: { id, ...beforeSnap.data() },
      after: saved
    });
    res.json({ message: 'Destino actualizado', destino: saved });
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al actualizar destino',
      code: err.code,
      doorId: err.doorId
    });
  }
});

router.delete('/api/admin/destinos/:id', auth, requirePermission('destinos.manage'), async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const ref = db.collection(DESTINOS).doc(id);
    const beforeSnap = await ref.get();
    if (!beforeSnap.exists) {
      return res.status(404).json({ message: 'Destino no encontrado' });
    }
    await ref.delete();
    logAdminAction({
      req,
      action: 'destino.delete',
      targetType: 'destino',
      targetId: id,
      before: { id, ...beforeSnap.data() }
    });
    res.json({ message: 'Destino eliminado', id });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Error al eliminar destino' });
  }
});

module.exports = router;
