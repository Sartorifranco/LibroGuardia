const express = require('express');
const { db, FieldValue } = require('../firestore');
const { normalizePlate } = require('../permissions');
const {
  getFleetGpsConfig,
  publicFleetGpsConfig,
  saveFleetGpsConfig,
  saveFleetGpsGeofence,
  fetchNearbyFleetAlerts,
  fetchFleetLiveSnapshot
} = require('../fleetGps');
const {
  auth,
  authorize,
  requirePermission
} = require('../middleware/auth');

const router = express.Router();

const deleteCollection = async (collectionName, batchSize = 100) => {
  const collectionRef = db.collection(collectionName);
  const snapshot = await collectionRef.limit(batchSize).get();
  if (snapshot.empty) return;

  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();

  if (snapshot.size >= batchSize) {
    await deleteCollection(collectionName, batchSize);
  }
};

router.post('/api/admin/fleet/mobiles/upload', auth, authorize(['admin', 'supervisor']), async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data) || data.length === 0 || data.some((item) => typeof item.name !== 'string' || !item.name.trim())) {
      return res.status(400).json({ message: 'Formato de datos inválido. Se espera un array no vacío con objetos { name }.' });
    }

    await deleteCollection('mobiles');
    const batch = db.batch();
    data.forEach((item) => {
      const ref = db.collection('mobiles').doc();
      batch.set(ref, { name: item.name.trim() });
    });
    await batch.commit();

    res.status(200).json({ message: 'Lista de móviles actualizada exitosamente.' });
  } catch (err) {
    res.status(500).json({ message: 'Error al subir la lista de móviles', error: err.message });
  }
});

router.post('/api/admin/fleet/drivers/upload', auth, authorize(['admin', 'supervisor']), async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data) || data.length === 0 || data.some((item) => typeof item.name !== 'string' || !item.name.trim())) {
      return res.status(400).json({ message: 'Formato de datos inválido. Se espera un array no vacío con objetos { name }.' });
    }

    await deleteCollection('drivers');
    const batch = db.batch();
    data.forEach((item) => {
      const ref = db.collection('drivers').doc();
      batch.set(ref, { name: item.name.trim() });
    });
    await batch.commit();

    res.status(200).json({ message: 'Lista de choferes actualizada exitosamente.' });
  } catch (err) {
    res.status(500).json({ message: 'Error al subir la lista de choferes', error: err.message });
  }
});

router.get('/api/fleet/mobiles', auth, async (_req, res) => {
  try {
    const snap = await db.collection('mobiles').orderBy('name').get();
    res.json({ mobiles: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener móviles', error: err.message });
  }
});

router.get('/api/fleet/drivers', auth, async (_req, res) => {
  try {
    const snap = await db.collection('drivers').orderBy('name').get();
    res.json({ drivers: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener choferes', error: err.message });
  }
});

router.get('/api/guard/fleet-gps/alerts', auth, requirePermission('fleet.gps.read'), async (req, res) => {
  try {
    const result = await fetchNearbyFleetAlerts(db, FieldValue, {
      userId: req.user.id,
      username: req.user.username
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error al consultar GPS de flota', error: err.message });
  }
});

router.get('/api/admin/fleet-gps', auth, requirePermission('access.control'), async (_req, res) => {
  try {
    const config = await getFleetGpsConfig(db);
    res.json({ config: publicFleetGpsConfig(config) });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener config GPS', error: err.message });
  }
});

router.put('/api/admin/fleet-gps', auth, requirePermission('access.control'), async (req, res) => {
  try {
    const config = await saveFleetGpsConfig(db, FieldValue, req.body || {});
    res.json({ message: 'Configuración GPS UBIKA guardada', config: publicFleetGpsConfig(config) });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar config GPS', error: err.message });
  }
});

router.put('/api/admin/fleet-gps/geofence', auth, requirePermission('access.control'), async (req, res) => {
  try {
    const config = await saveFleetGpsGeofence(db, FieldValue, req.body || {});
    res.json({ message: 'Geocercas del mapa guardadas', config: publicFleetGpsConfig(config) });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar geocercas', error: err.message });
  }
});

router.post('/api/admin/fleet-gps/test', auth, requirePermission('access.control'), async (req, res) => {
  try {
    const result = await fetchNearbyFleetAlerts(db, FieldValue, {
      force: true,
      includeNearest: true,
      userId: req.user.id,
      username: req.user.username,
      skipAutoRegister: req.body?.skipAutoRegister !== false
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error al probar GPS UBIKA', error: err.message });
  }
});

router.get('/api/admin/fleet-gps/live', auth, requirePermission('access.control'), async (req, res) => {
  try {
    const parseQueryNumber = (value) => {
      if (value === undefined || value === null || value === '') return undefined;
      const num = Number(value);
      return Number.isNaN(num) ? undefined : num;
    };
    const parseQueryJson = (value) => {
      if (!value) return undefined;
      try {
        return JSON.parse(value);
      } catch (_err) {
        return undefined;
      }
    };
    const result = await fetchFleetLiveSnapshot(db, {
      guardiaLat: parseQueryNumber(req.query.guardiaLat),
      guardiaLng: parseQueryNumber(req.query.guardiaLng),
      geofenceMode: req.query.geofenceMode,
      gatePolygons: parseQueryJson(req.query.gatePolygons),
      plantPolygon: parseQueryJson(req.query.plantPolygon),
      gateRadiusMeters: parseQueryNumber(req.query.gateRadiusMeters),
      plantRadiusMeters: parseQueryNumber(req.query.plantRadiusMeters),
      minSpeedKnots: parseQueryNumber(req.query.minSpeedKnots),
      requireMotion: req.query.requireMotion === 'false'
        ? false
        : req.query.requireMotion === 'true'
          ? true
          : undefined
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener mapa GPS', error: err.message });
  }
});

router.post('/api/admin/fleet/vehicles/upload', auth, requirePermission('master.vehicles.write'), async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ message: 'Se espera un array no vacío de vehículos' });
    }

    const batch = db.batch();
    data.forEach((item) => {
      const plateNormalized = normalizePlate(item.plate || item.patente || '');
      if (!plateNormalized) return;
      const ref = db.collection('vehiclesMaster').doc();
      batch.set(ref, {
        plate: (item.plate || item.patente || '').trim(),
        plateNormalized,
        brand: (item.brand || item.marca || '').trim(),
        company: (item.company || item.empresa || '').trim(),
        driver: (item.driver || item.conductor || '').trim(),
        authorized: item.authorized !== false,
        notes: (item.notes || item.observaciones || '').trim(),
        createdAt: FieldValue.serverTimestamp()
      });
    });
    await batch.commit();
    res.status(200).json({ message: 'Vehículos autorizados cargados exitosamente.' });
  } catch (err) {
    res.status(500).json({ message: 'Error al cargar vehículos autorizados', error: err.message });
  }
});

module.exports = router;
