const express = require('express');
const { db, FieldValue } = require('../firestore');
const { normalizeIdNumber, normalizePlate } = require('../permissions');
const { normalizeExpiryYmd } = require('../lib/documentExpiry');
const {
  buildAuthorizationRecord,
  listAuthorizationsByDate
} = require('../authorizations');
const { checkAccessStatus } = require('../guard');
const { logActivity } = require('../lib/activityLog');
const {
  auth,
  requirePermission,
  requireAnyPermission
} = require('../middleware/auth');

const router = express.Router();

const todayDateString = () => new Date().toISOString().slice(0, 10);

const mergeOptionalExpiry = (target, body, key) => {
  if (!Object.prototype.hasOwnProperty.call(body || {}, key)) return;
  const raw = body[key];
  if (raw === null || raw === '') {
    target[key] = null;
    return;
  }
  const ymd = normalizeExpiryYmd(raw);
  if (ymd) target[key] = ymd;
};

router.get('/api/master-data/personal', auth, async (_req, res) => {
  try {
    const snap = await db.collection('personalMaster').orderBy('name').get();
    res.json({ personal: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener datos maestros de personal', error: err.message });
  }
});

router.post('/api/master-data/personal', auth, async (req, res) => {
  try {
    const { name, idNumber, company, destination } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ message: 'El nombre es obligatorio' });
    }

    const normalizedName = name.trim();
    const nameLower = normalizedName.toLowerCase();
    const existing = await db.collection('personalMaster').where('nameLower', '==', nameLower).limit(1).get();

    let personRef;
    let personData;

    if (!existing.empty) {
      const prev = existing.docs[0].data() || {};
      personRef = existing.docs[0].ref;
      personData = {
        name: normalizedName,
        nameLower,
        idNumber: idNumber || prev.idNumber || '',
        idNumberNormalized: normalizeIdNumber(idNumber || prev.idNumber || ''),
        company: company || prev.company || '',
        destination: destination || prev.destination || '',
        artExpiryDate: prev.artExpiryDate || null,
        licenseExpiryDate: prev.licenseExpiryDate || null
      };
      mergeOptionalExpiry(personData, req.body, 'artExpiryDate');
      mergeOptionalExpiry(personData, req.body, 'licenseExpiryDate');
      await personRef.update(personData);
    } else {
      personRef = db.collection('personalMaster').doc();
      personData = {
        name: normalizedName,
        nameLower,
        idNumber: idNumber || '',
        idNumberNormalized: normalizeIdNumber(idNumber || ''),
        company: company || '',
        destination: destination || '',
        artExpiryDate: null,
        licenseExpiryDate: null
      };
      mergeOptionalExpiry(personData, req.body, 'artExpiryDate');
      mergeOptionalExpiry(personData, req.body, 'licenseExpiryDate');
      await personRef.set(personData);
    }

    res.status(201).json({
      message: 'Persona guardada en la base maestra',
      personal: { id: personRef.id, ...personData }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar persona en la base maestra', error: err.message });
  }
});

router.get('/api/master-data/personal/by-dni/:dni', auth, requirePermission('master.personal.read'), async (req, res) => {
  try {
    const idNumber = normalizeIdNumber(req.params.dni);
    if (!idNumber) {
      return res.status(400).json({ message: 'DNI inválido' });
    }

    const snap = await db.collection('personalMaster')
      .where('idNumberNormalized', '==', idNumber)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ message: 'Persona no encontrada en la base precargada', idNumber });
    }

    const doc = snap.docs[0];
    res.json({ personal: { id: doc.id, ...doc.data() } });
  } catch (err) {
    res.status(500).json({ message: 'Error al buscar persona por DNI', error: err.message });
  }
});

router.get('/api/master-data/citaciones', auth, requirePermission('master.citaciones.read'), async (req, res) => {
  try {
    const date = req.query.date || todayDateString();
    const authorizations = await listAuthorizationsByDate(date);
    res.json({
      citaciones: authorizations,
      authorizations,
      date
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener citaciones', error: err.message });
  }
});

router.post('/api/master-data/citaciones', auth, requirePermission('master.citaciones.write'), async (req, res) => {
  try {
    const { name, idNumber, company, destination, appointmentDate, notes } = req.body;
    if (!name?.trim() || !normalizeIdNumber(idNumber)) {
      return res.status(400).json({ message: 'Nombre y DNI son obligatorios' });
    }

    const idNumberNormalized = normalizeIdNumber(idNumber);
    const data = buildAuthorizationRecord({
      type: 'citacion',
      name,
      idNumber,
      company,
      destination,
      startDate: appointmentDate || todayDateString(),
      endDate: appointmentDate || todayDateString(),
      notes
    });

    const ref = await db.collection('authorizations').add({
      ...data,
      createdAt: FieldValue.serverTimestamp()
    });

    await db.collection('citaciones').add({
      name: data.name,
      idNumber: data.idNumber,
      idNumberNormalized: data.idNumberNormalized,
      company: data.company,
      destination: data.destination,
      appointmentDate: data.startDate,
      notes: data.notes,
      createdAt: FieldValue.serverTimestamp()
    });

    res.status(201).json({ message: 'Citación registrada', citacion: { id: ref.id, ...data } });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar citación', error: err.message });
  }
});

router.delete('/api/master-data/citaciones/:id', auth, requirePermission('master.citaciones.write'), async (req, res) => {
  try {
    const ref = db.collection('citaciones').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ message: 'Citación no encontrada' });
    }
    await ref.delete();
    res.json({ message: 'Citación eliminada' });
  } catch (err) {
    res.status(500).json({ message: 'Error al eliminar citación', error: err.message });
  }
});

router.get('/api/master-data/vehicles', auth, requirePermission('master.vehicles.read'), async (_req, res) => {
  try {
    const snap = await db.collection('vehiclesMaster').orderBy('plate').get();
    res.json({ vehicles: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener vehículos autorizados', error: err.message });
  }
});

router.get('/api/master-data/vehicles/lookup', auth, requirePermission('master.vehicles.read'), async (req, res) => {
  try {
    const plateNormalized = normalizePlate(req.query.plate || '');
    if (!plateNormalized) {
      return res.status(400).json({ message: 'Patente inválida' });
    }

    const snap = await db.collection('vehiclesMaster')
      .where('plateNormalized', '==', plateNormalized)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.json({
        authorized: false,
        plate: req.query.plate,
        message: 'Vehículo no precargado',
        vehicle: null,
        driverAccess: null
      });
    }

    const vehicle = { id: snap.docs[0].id, ...snap.docs[0].data() };
    let driverAccess = null;
    if (vehicle.driver?.trim()) {
      driverAccess = await checkAccessStatus({
        dni: vehicle.driverDni || vehicle.driverIdNumber || '',
        name: vehicle.driver
      });
    }

    res.json({
      authorized: vehicle.authorized !== false,
      vehicle,
      driverAccess,
      message: vehicle.authorized !== false ? 'Vehículo autorizado' : 'Vehículo registrado pero no autorizado',
      driverMessage: driverAccess
        ? (driverAccess.authorized
          ? `Conductor habilitado (${driverAccess.authorizationType || 'ok'})`
          : 'Conductor sin autorización vigente')
        : null
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al consultar patente', error: err.message });
  }
});

router.post('/api/master-data/vehicles', auth, requirePermission('master.vehicles.write'), async (req, res) => {
  try {
    const { plate, brand, company, driver, authorized = true, notes } = req.body;
    const plateNormalized = normalizePlate(plate);
    if (!plateNormalized) {
      return res.status(400).json({ message: 'La patente es obligatoria' });
    }

    const existing = await db.collection('vehiclesMaster')
      .where('plateNormalized', '==', plateNormalized)
      .limit(1)
      .get();

    const prev = existing.empty ? {} : (existing.docs[0].data() || {});
    const vehicleData = {
      plate: plate.trim(),
      plateNormalized,
      brand: brand?.trim() || '',
      company: company?.trim() || '',
      driver: driver?.trim() || '',
      authorized: authorized !== false,
      notes: notes?.trim() || '',
      insuranceExpiryDate: prev.insuranceExpiryDate || null,
      vtvExpiryDate: prev.vtvExpiryDate || null,
      updatedAt: FieldValue.serverTimestamp()
    };
    mergeOptionalExpiry(vehicleData, req.body, 'insuranceExpiryDate');
    mergeOptionalExpiry(vehicleData, req.body, 'vtvExpiryDate');

    let vehicleRef;
    if (!existing.empty) {
      vehicleRef = existing.docs[0].ref;
      await vehicleRef.update(vehicleData);
    } else {
      vehicleRef = db.collection('vehiclesMaster').doc();
      await vehicleRef.set({ ...vehicleData, createdAt: FieldValue.serverTimestamp() });
    }

    res.status(201).json({
      message: 'Vehículo guardado en la base autorizada',
      vehicle: { id: vehicleRef.id, ...vehicleData }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar vehículo autorizado', error: err.message });
  }
});

router.post('/api/master-data/vehicles/quick-authorize', auth, requireAnyPermission(['master.vehicles.quick_authorize', 'monitoring.vehicles.manage']), async (req, res) => {
  try {
    const { plate, brand, company, driver, driverDni, companions, notes, gateProfile } = req.body;
    const plateNormalized = normalizePlate(plate);
    if (!plateNormalized) {
      return res.status(400).json({ message: 'La patente es obligatoria' });
    }

    const existing = await db.collection('vehiclesMaster')
      .where('plateNormalized', '==', plateNormalized)
      .limit(1)
      .get();

    const normalizedCompanions = Array.isArray(companions)
      ? companions
        .map((item) => ({
          name: String(item?.name || item || '').trim(),
          dni: String(item?.dni || '').trim()
        }))
        .filter((item) => item.name)
      : [];

    const prev = existing.empty ? {} : (existing.docs[0].data() || {});
    const vehicleData = {
      plate: plate.trim(),
      plateNormalized,
      brand: brand?.trim() || '',
      company: company?.trim() || '',
      driver: driver?.trim() || '',
      driverDni: driverDni?.trim() || '',
      companions: normalizedCompanions,
      gateProfile: gateProfile?.trim() || 'monitoreo',
      authorized: true,
      authorizedBy: req.user.id,
      authorizedAt: FieldValue.serverTimestamp(),
      notes: notes?.trim() || 'Autorización rápida en puesto',
      insuranceExpiryDate: prev.insuranceExpiryDate || null,
      vtvExpiryDate: prev.vtvExpiryDate || null
    };
    mergeOptionalExpiry(vehicleData, req.body, 'insuranceExpiryDate');
    mergeOptionalExpiry(vehicleData, req.body, 'vtvExpiryDate');

    let vehicleRef;
    if (!existing.empty) {
      vehicleRef = existing.docs[0].ref;
      await vehicleRef.update(vehicleData);
    } else {
      vehicleRef = db.collection('vehiclesMaster').doc();
      await vehicleRef.set({ ...vehicleData, createdAt: FieldValue.serverTimestamp() });
    }

    res.status(201).json({
      message: 'Vehículo autorizado correctamente',
      vehicle: { id: vehicleRef.id, ...vehicleData }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error en autorización rápida', error: err.message });
  }
});

router.delete('/api/master-data/vehicles/:id', auth, requirePermission('master.vehicles.write'), async (req, res) => {
  try {
    const ref = db.collection('vehiclesMaster').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ message: 'Vehículo no encontrado' });
    }
    const data = snap.data() || {};
    await ref.delete();
    logActivity(db, FieldValue, {
      actorUsername: req.user.username || req.user.id,
      actorId: req.user.id,
      action: 'vehicle.delete',
      summary: `Eliminó el vehículo autorizado “${data.plate || req.params.id}”`,
      meta: { vehicleId: req.params.id, plate: data.plate }
    }).catch((err) => console.error('activityLog vehicle.delete:', err.message));
    res.json({ message: 'Vehículo eliminado de la base autorizada' });
  } catch (err) {
    res.status(500).json({ message: 'Error al eliminar vehículo', error: err.message });
  }
});

module.exports = router;
