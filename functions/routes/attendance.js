const express = require('express');
const { db, FieldValue, Timestamp } = require('../firestore');
const {
  createNominaImportJob,
  processNominaImportStep,
  listNominaPersonal,
  listNominaBirthdays,
  saveNominaEmployee,
  deactivateNominaEmployee
} = require('../nominaImport');
const {
  getMissingAttendanceAlerts,
  dismissAttendanceAlert,
  bulkDismissAttendance
} = require('../attendanceAlerts');
const { getCitadosToday } = require('../citadosToday');
const { resolveOrCreatePerson } = require('../people');
const { triggerAccessIfAuthorized } = require('../accessControl');
const {
  auth,
  requirePermission
} = require('../middleware/auth');

const router = express.Router();

const nominaReasonMessage = (reason) => {
  switch (reason) {
    case 'nombre_vacio':
      return 'El nombre es obligatorio';
    case 'sin_dni_ni_legajo':
      return 'Indicá DNI o legajo';
    case 'tipo_autorizacion_invalido':
      return 'Tipo de autorización inválido';
    default:
      return 'Datos de nómina inválidos';
  }
};

router.get('/api/admin/nomina', auth, requirePermission('master.nomina.read'), async (_req, res) => {
  try {
    const personal = await listNominaPersonal();
    res.json({ personal, count: personal.length });
  } catch (err) {
    res.status(500).json({ message: 'Error al listar nómina', error: err.message });
  }
});

router.post('/api/admin/nomina', auth, requirePermission('master.nomina.write'), async (req, res) => {
  try {
    const employee = await saveNominaEmployee(req.body || {});
    res.status(employee.created ? 201 : 200).json({
      message: employee.created ? 'Empleado agregado a la nómina' : 'Empleado actualizado en la nómina',
      employee
    });
  } catch (err) {
    if (err.code === 'invalid_nomina') {
      return res.status(400).json({ message: nominaReasonMessage(err.reason), reason: err.reason });
    }
    res.status(500).json({ message: 'Error al guardar empleado', error: err.message });
  }
});

router.put('/api/admin/nomina/:id', auth, requirePermission('master.nomina.write'), async (req, res) => {
  try {
    const employee = await saveNominaEmployee(req.body || {}, { id: req.params.id });
    res.json({ message: 'Empleado actualizado', employee });
  } catch (err) {
    if (err.code === 'not_found') {
      return res.status(404).json({ message: err.message });
    }
    if (err.code === 'invalid_nomina') {
      return res.status(400).json({ message: nominaReasonMessage(err.reason), reason: err.reason });
    }
    res.status(500).json({ message: 'Error al actualizar empleado', error: err.message });
  }
});

router.delete('/api/admin/nomina/:id', auth, requirePermission('master.nomina.write'), async (req, res) => {
  try {
    const employee = await deactivateNominaEmployee(req.params.id);
    res.json({ message: 'Empleado dado de baja en nómina', employee });
  } catch (err) {
    if (err.code === 'not_found') {
      return res.status(404).json({ message: err.message });
    }
    res.status(500).json({ message: 'Error al dar de baja', error: err.message });
  }
});

/** Cumpleaños de hoy (home guardia — sutil). */
router.get('/api/nomina/birthdays-today', auth, async (_req, res) => {
  try {
    const birthdays = await listNominaBirthdays({ withinDays: 0 });
    res.json({
      ok: true,
      birthdays,
      count: birthdays.length,
      date: new Date().toISOString().slice(0, 10)
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al listar cumpleaños', error: err.message });
  }
});

router.post('/api/admin/nomina/upload', auth, requirePermission('master.nomina.write'), async (req, res) => {
  try {
    const { data, replace } = req.body || {};
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ message: 'Se espera un array no vacío de filas de nómina' });
    }
    // Job + pasos: Hosting corta ~60s; un solo POST con 155 filas daba 502/503.
    const job = await createNominaImportJob(data, {
      importedBy: req.user.id,
      replace: replace === true,
      keepLegajos: Array.isArray(req.body?.keepLegajos) ? req.body.keepLegajos : [],
      keepDnis: Array.isArray(req.body?.keepDnis) ? req.body.keepDnis : []
    });
    res.status(200).json({
      ok: true,
      jobId: job.jobId,
      rowCount: job.rowCount,
      status: 'queued',
      message: `Importación encolada (${job.rowCount} filas)`
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al encolar importación de nómina', error: err.message });
  }
});

router.post('/api/admin/nomina/upload/:jobId/step', auth, requirePermission('master.nomina.write'), async (req, res) => {
  try {
    const batchSize = Number(req.body?.batchSize) || 15;
    const result = await processNominaImportStep(req.params.jobId, { batchSize, concurrency: 4 });
    let message = result.done
      ? `Nómina importada: ${result.imported} empleados (${result.created} nuevos, ${result.updated} actualizados)`
      : `Procesando nómina… ${result.processed}/${result.total}`;
    if (result.done && result.deactivated > 0) {
      message += `. ${result.deactivated} de la nómina anterior dados de baja`;
    }
    if (result.done && result.skipped > 0) {
      message += `. ${result.skipped} filas omitidas`;
    }
    res.status(200).json({ message, ...result });
  } catch (err) {
    const status = err.code === 'not_found' ? 404 : 500;
    res.status(status).json({ message: 'Error al procesar nómina', error: err.message });
  }
});

router.get('/api/guard/attendance/missing', auth, requirePermission('attendance.alerts.read'), async (_req, res) => {
  try {
    const result = await getMissingAttendanceAlerts();
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error al consultar faltantes de ingreso', error: err.message });
  }
});

router.get('/api/guard/citados/today', auth, requirePermission('attendance.alerts.read'), async (_req, res) => {
  try {
    const result = await getCitadosToday();
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error al consultar citados del día', error: err.message });
  }
});

router.post('/api/guard/attendance/dismiss', auth, requirePermission('attendance.alerts.read'), async (req, res) => {
  try {
    const { personId, legajoNormalized, idNumberNormalized, name, reason } = req.body || {};
    const result = await dismissAttendanceAlert({
      personId,
      legajoNormalized,
      idNumberNormalized,
      name,
      reason,
      guardId: req.user.id
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error al omitir alerta', error: err.message });
  }
});

router.post('/api/guard/attendance/register-entry', auth, requirePermission('entries.create'), async (req, res) => {
  try {
    const {
      name,
      idNumber,
      legajo,
      company,
      destination,
      eventTime,
      movementType = 'ingreso'
    } = req.body || {};

    if (!name?.trim()) {
      return res.status(400).json({ message: 'El nombre es obligatorio' });
    }

    const entryData = {
      type: 'personal',
      movementType,
      name: name.trim(),
      idNumber: idNumber || legajo || '',
      company: company || '',
      destination: destination || '',
      entrySource: 'attendance_alert',
      eventTime: eventTime || null,
      registeredBy: req.user.id,
      timestamp: Timestamp.now(),
      attendanceAlert: true
    };

    const ref = await db.collection('entries').add(entryData);

    if (movementType === 'ingreso') {
      const accessResult = await triggerAccessIfAuthorized({
        movementType,
        idNumber: idNumber || legajo,
        name,
        entrySource: 'attendance_alert',
        entryId: ref.id,
        username: req.user.id,
        allowManualOverride: true
      });
      await ref.update({
        accessAuthorized: accessResult.authorized,
        accessReason: accessResult.reason,
        authorizationType: accessResult.authorizationType,
        relayTriggered: Boolean(accessResult.relay?.triggered),
        relayError: accessResult.relay?.error || null
      });
    }

    res.status(201).json({
      message: 'Ingreso registrado desde alerta de asistencia',
      entryId: ref.id
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al registrar ingreso', error: err.message });
  }
});

router.post('/api/guard/attendance/bulk-present', auth, requirePermission('entries.create'), async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(400).json({ message: 'Se requiere al menos un colaborador' });
    }
    if (items.length > 100) {
      return res.status(400).json({ message: 'Máximo 100 colaboradores por operación' });
    }

    let registered = 0;
    const errors = [];

    for (const item of items) {
      if (!item?.name?.trim()) {
        errors.push({ name: item?.name || '—', reason: 'nombre_vacio' });
        continue;
      }
      try {
        const entryData = {
          type: 'personal',
          movementType: 'ingreso',
          name: item.name.trim(),
          idNumber: item.idNumber || item.legajo || '',
          company: item.centroCosto || item.company || '',
          destination: item.centroCosto || item.destination || '',
          entrySource: 'attendance_alert',
          registeredBy: req.user.id,
          timestamp: Timestamp.now(),
          attendanceAlert: true,
          bulkAttendance: true
        };
        await db.collection('entries').add(entryData);
        registered += 1;
      } catch (err) {
        errors.push({ name: item.name, reason: err.message });
      }
    }

    res.status(200).json({
      message: `${registered} ingreso(s) registrado(s)`,
      registered,
      errors
    });
  } catch (err) {
    res.status(500).json({ message: 'Error en registro masivo', error: err.message });
  }
});

router.post('/api/guard/attendance/bulk-absent', auth, requirePermission('attendance.alerts.read'), async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(400).json({ message: 'Se requiere al menos un colaborador' });
    }
    if (items.length > 100) {
      return res.status(400).json({ message: 'Máximo 100 colaboradores por operación' });
    }
    const result = await bulkDismissAttendance(items, {
      guardId: req.user.id,
      reason: req.body?.reason || 'ausente_guardia'
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error al marcar ausentes', error: err.message });
  }
});

module.exports = router;
