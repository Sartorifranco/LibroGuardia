const express = require('express');
const { db, FieldValue } = require('../firestore');
const { normalizeIdNumber } = require('../permissions');
const {
  buildAuthorizationRecord,
  listAuthorizationsByDate,
  listAuthorizationsInRange,
  listPlannedCitacionDates,
  listExternalAuthorizations,
  AUTHORIZATION_TYPES
} = require('../authorizations');
const { parseImportRows } = require('../citacionesImport');
const {
  getCitacionesBridgeConfig,
  saveCitacionesBridgeConfig,
  verifyCitacionesBridgeRequest,
  syncAuthorizationsFromBridge,
  relinkCitacionesWithNomina,
  reprocessImportBatch,
  listCitacionesImports,
  getCitacionesImportById
} = require('../citacionesBridge');
const {
  auth,
  requirePermission
} = require('../middleware/auth');

const router = express.Router();

const todayDateString = () => new Date().toISOString().slice(0, 10);

const listAuthorizationsHandler = async (req, res) => {
  try {
    const type = req.query.type || null;
    const { from, to, date, planned } = req.query;

    if (from && to) {
      const authorizations = await listAuthorizationsInRange(from, to, type || null);
      const plannedDates = await listPlannedCitacionDates(from, to);
      return res.json({ authorizations, from, to, plannedDates, mode: 'range' });
    }

    if (planned === 'true') {
      const start = date || todayDateString();
      const endDate = new Date(`${start}T12:00:00`);
      endDate.setDate(endDate.getDate() + 14);
      const end = endDate.toISOString().slice(0, 10);
      const authorizations = await listAuthorizationsInRange(start, end, type || 'citacion');
      const plannedDates = await listPlannedCitacionDates(start, end);
      return res.json({ authorizations, from: start, to: end, plannedDates, mode: 'planned' });
    }

    const targetDate = date || todayDateString();

    if (req.query.scope === 'external') {
      const authorizations = await listExternalAuthorizations(targetDate);
      return res.json({ authorizations, date: targetDate, mode: 'external' });
    }

    const authorizations = await listAuthorizationsByDate(targetDate, type || null);
    res.json({ authorizations, date: targetDate, mode: 'day' });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener autorizaciones', error: err.message });
  }
};

router.get('/api/admin/authorizations', auth, requirePermission('master.citaciones.read'), listAuthorizationsHandler);

router.get('/api/guard/authorizations', auth, requirePermission('master.citaciones.read'), listAuthorizationsHandler);

router.get('/api/admin/citaciones-imports', auth, requirePermission('master.citaciones.read'), async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const imports = await listCitacionesImports({ limit });
    res.json({ imports });
  } catch (err) {
    res.status(500).json({ message: 'Error al listar importaciones', error: err.message });
  }
});

router.get('/api/admin/citaciones-imports/:id', auth, requirePermission('master.citaciones.read'), async (req, res) => {
  try {
    const batch = await getCitacionesImportById(req.params.id);
    if (!batch) {
      return res.status(404).json({ message: 'Importación no encontrada' });
    }
    res.json({ import: batch });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener importación', error: err.message });
  }
});

router.post('/api/admin/citaciones/relink-nomina', auth, requirePermission('master.citaciones.write'), async (req, res) => {
  try {
    const dateString = req.body?.date || req.query?.date || undefined;
    const result = await relinkCitacionesWithNomina({ dateString });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al vincular citaciones con nómina',
      error: err.message
    });
  }
});

router.post('/api/admin/citaciones/sync-upload', auth, requirePermission('master.citaciones.write'), async (req, res) => {
  try {
    const { data, sourceFile, force } = req.body || {};
    const result = await syncAuthorizationsFromBridge({
      data,
      sourceFile: sourceFile || 'manual-upload.xlsx',
      force: force !== false,
      defaults: { importedBy: 'admin-upload' }
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al importar citaciones',
      details: err.details || undefined
    });
  }
});

router.post('/api/admin/citaciones-imports/:id/reprocess', auth, requirePermission('master.citaciones.write'), async (req, res) => {
  try {
    const result = await reprocessImportBatch(req.params.id, { force: req.body?.force !== false });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al reprocesar importación',
      error: err.message
    });
  }
});

router.post('/api/admin/authorizations', auth, requirePermission('master.citaciones.write'), async (req, res) => {
  try {
    const data = buildAuthorizationRecord({ ...req.body, source: 'manual' });
    const person = await resolveOrCreatePerson(data, {
      origen: 'manual',
      tipo: req.body.personTipo || 'empleado'
    });

    const ref = await db.collection('authorizations').add({
      ...data,
      personId: person.id,
      source: 'manual',
      createdAt: FieldValue.serverTimestamp(),
      createdBy: req.user?.username || req.user?.id || 'admin'
    });

    if (data.type === 'citacion') {
      await db.collection('citaciones').add({
        name: data.name,
        idNumber: data.idNumber,
        idNumberNormalized: data.idNumberNormalized,
        legajo: data.legajo,
        legajoNormalized: data.legajoNormalized,
        company: data.company,
        destination: data.destination,
        appointmentDate: data.startDate,
        notes: data.notes,
        createdAt: FieldValue.serverTimestamp()
      });
    }

    res.status(201).json({
      message: 'Autorización registrada',
      authorization: { id: ref.id, ...data, personId: person.id }
    });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Error al guardar autorización' });
  }
});

router.delete('/api/admin/authorizations/:id', auth, requirePermission('master.citaciones.write'), async (req, res) => {
  try {
    const ref = db.collection('authorizations').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ message: 'Autorización no encontrada' });
    }
    const data = snap.data() || {};
    await ref.update({ active: false, updatedAt: FieldValue.serverTimestamp() });
    logActivity(db, FieldValue, {
      actorUsername: req.user.username || req.user.id,
      actorId: req.user.id,
      action: 'authorization.delete',
      summary: `Desactivó la autorización de “${data.name || data.idNumber || req.params.id}”`,
      meta: { authorizationId: req.params.id, type: data.type }
    }).catch((err) => console.error('activityLog authorization.delete:', err.message));
    res.json({ message: 'Autorización desactivada' });
  } catch (err) {
    res.status(500).json({ message: 'Error al desactivar autorización', error: err.message });
  }
});

router.post('/api/admin/authorizations/upload', auth, requirePermission('master.citaciones.write'), async (req, res) => {
  try {
    const { data, defaults } = req.body;
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ message: 'Se espera un array no vacío de autorizaciones' });
    }

    const { parsed, errors } = parseImportRows(data, defaults || {});
    if (!parsed.length) {
      return res.status(400).json({
        message: errors[0]?.message || 'No se encontraron filas válidas. Columnas: tipo, nombre, dni, empresa, destino, fecha_inicio, fecha_fin',
        errors
      });
    }

    const batch = db.batch();
    parsed.forEach((record) => {
      const ref = db.collection('authorizations').doc();
      batch.set(ref, { ...record, createdAt: FieldValue.serverTimestamp() });
    });

    await batch.commit();
    res.status(200).json({
      message: `${parsed.length} autorizaciones cargadas exitosamente`,
      count: parsed.length,
      skippedInvalid: errors.length
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al cargar autorizaciones', error: err.message });
  }
});

router.get('/api/admin/citaciones-bridge', auth, requirePermission('master.citaciones.write'), async (_req, res) => {
  try {
    const config = await getCitacionesBridgeConfig();
    res.json({ config });
  } catch (err) {
    res.status(500).json({ message: 'Error al leer configuración del puente', error: err.message });
  }
});

router.put('/api/admin/citaciones-bridge', auth, requirePermission('master.citaciones.write'), async (req, res) => {
  try {
    const allowed = ['enabled', 'bridgeSecret', 'watchFolderHint'];
    const updates = {};
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    });
    const config = await saveCitacionesBridgeConfig(updates);
    res.json({ message: 'Configuración del puente guardada', config });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar configuración del puente', error: err.message });
  }
});

router.get('/api/bridge/citaciones/health', async (_req, res) => {
  try {
    const config = await getCitacionesBridgeConfig();
    res.json({
      status: 'ok',
      service: 'citaciones-folder-bridge',
      enabled: config.enabled,
      lastSyncAt: config.lastSyncAt,
      lastSyncFile: config.lastSyncFile,
      lastSyncCount: config.lastSyncCount,
      lastSyncError: config.lastSyncError
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/api/bridge/citaciones/sync', async (req, res) => {
  try {
    await verifyCitacionesBridgeRequest(req);
    const result = await syncAuthorizationsFromBridge(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({
      message: err.message || 'Error al sincronizar citaciones',
      details: err.details || undefined
    });
  }
});

router.post('/api/admin/citaciones/upload', auth, requirePermission('master.citaciones.write'), async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ message: 'Se espera un array no vacío de citaciones' });
    }

    const batch = db.batch();
    let count = 0;

    data.forEach((item) => {
      const name = (item.name || item.nombre || '').trim();
      const idNumberNormalized = normalizeIdNumber(item.idNumber || item.dni || item.documento || '');
      if (!name || !idNumberNormalized) return;

      const ref = db.collection('authorizations').doc();
      batch.set(ref, buildAuthorizationRecord({
        type: 'citacion',
        name,
        idNumber: idNumberNormalized,
        company: (item.company || item.empresa || '').trim(),
        destination: (item.destination || item.destino || item.area || '').trim(),
        startDate: item.appointmentDate || item.fecha || todayDateString(),
        endDate: item.appointmentDate || item.fecha || todayDateString(),
        notes: (item.notes || item.observaciones || '').trim()
      }));
      count += 1;
    });

    if (!count) {
      return res.status(400).json({ message: 'No se encontraron filas válidas. Use columnas: nombre, dni, empresa, destino, fecha' });
    }

    await batch.commit();
    res.status(200).json({ message: `${count} citaciones cargadas exitosamente`, count });
  } catch (err) {
    res.status(500).json({ message: 'Error al cargar citaciones', error: err.message });
  }
});

module.exports = router;
