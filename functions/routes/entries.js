const express = require('express');
const { db, FieldValue, Timestamp } = require('../firestore');
const { resolveOrCreatePerson } = require('../people');
const { logActivity } = require('../lib/activityLog');
const { queryEntriesPage } = require('../lib/entriesQuery');
const { triggerAccessIfAuthorized } = require('../accessControl');
const {
  auth,
  requirePermission,
  requireAnyPermission,
  userHasAnyPermission,
  sendServerError,
  sendRouteError
} = require('../middleware/auth');

const router = express.Router();

const entryToJSON = (doc, registeredByUsername) => {
  const data = doc.data();
  const timestamp = data.timestamp?.toDate ? data.timestamp.toDate().toISOString() : data.timestamp;
  return {
    id: doc.id,
    _id: doc.id,
    ...data,
    timestamp,
    registeredByUsername
  };
};

const validateEntryPayload = (type, body) => {
  switch (type) {
    case 'personal':
      if (!body.name?.trim()) return 'El nombre es obligatorio para registros de personal';
      if (!body.movementType) return 'El tipo de movimiento es obligatorio';
      break;
    case 'vehiculo':
      if (!body.plate?.trim()) return 'La patente es obligatoria para vehículos';
      if (!body.movementType) return 'El tipo de movimiento es obligatorio';
      break;
    case 'flota':
      if (!body.mobile?.trim() || !body.flotaDriver?.trim()) {
        return 'El móvil y el chofer son obligatorios para flota';
      }
      if (!body.movementType) return 'El tipo de movimiento es obligatorio';
      break;
    case 'novedad':
      if (!body.description?.trim()) return 'La descripción es obligatoria para novedades';
      break;
    default:
      return 'Tipo de entrada inválido';
  }
  return null;
};

router.post('/api/entries', auth, requirePermission('entries.create'), async (req, res) => {
  try {
    const {
      type, movementType, eventTime, name, idNumber, company, destination,
      plate, brand, driver, description, mobile, flotaDriver, scheduledTime, actualTime,
      entrySource, authorized, authorizedStatus, allowAccessOverride, exceptionalReason
    } = req.body;

    const validationError = validateEntryPayload(type, req.body);
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    const entryData = {
      type,
      registeredBy: req.user.id,
      timestamp: Timestamp.now(),
      eventTime: eventTime || null
    };

    if (type === 'personal') {
      Object.assign(entryData, {
        movementType,
        name,
        idNumber,
        company,
        destination,
        entrySource: entrySource || 'manual'
      });
    } else if (type === 'vehiculo') {
      Object.assign(entryData, {
        movementType,
        plate,
        brand,
        company,
        driver,
        authorized: authorized === true,
        authorizedStatus: authorizedStatus || (authorized ? 'authorized' : 'not_authorized')
      });
    } else if (type === 'flota') {
      Object.assign(entryData, { movementType, mobile, flotaDriver, scheduledTime, actualTime });
    } else if (type === 'novedad') {
      Object.assign(entryData, { description });
    }

    const ref = await db.collection('entries').add(entryData);
    const saved = await ref.get();

    let accessResult = null;
    if (type === 'personal') {
      // Permisos resueltos desde Firestore (admin: todos). Nunca confiar en flags del body.
      const manualOverrideAllowed = await userHasAnyPermission(req, ['access.manual_override']);
      const exceptionalAllowed = await userHasAnyPermission(req, ['access.exceptional_entry']);
      const reasonCode = String(req.body?.reasonCode || req.body?.emergencyReason || '').trim();
      const reasonText = String(req.body?.reasonText || exceptionalReason || '').trim();
      const {
        EMERGENCY_REASONS,
        recordEmergencyReview,
        createPendingFromEntry,
        actorFromUser
      } = require('../lib/accessRequests');
      const emergencyIds = new Set(EMERGENCY_REASONS.map((item) => item.id));
      const useEmergency = exceptionalAllowed && emergencyIds.has(reasonCode) && reasonText.length >= 5;
      // La casilla "autorizar aunque no haya citación" ya no abre: deja una solicitud.
      const askedOverride = allowAccessOverride === true
        && (manualOverrideAllowed || exceptionalAllowed)
        && !useEmergency;

      if (useEmergency) {
        const actor = await actorFromUser(req);
        accessResult = await triggerAccessIfAuthorized({
          movementType,
          idNumber,
          name,
          entrySource: entrySource || 'manual',
          entryId: ref.id,
          username: req.user.id,
          allowManualOverride: true,
          doorId: req.body?.doorId || null
        });
        const emergency = await recordEmergencyReview({
          entryId: ref.id,
          name,
          dni: idNumber,
          reasonCode,
          reasonText,
          company,
          destination,
          empresaId: req.body?.empresaId || null,
          doorId: req.body?.doorId || null,
          actor,
          req
        });
        await ref.update({
          accessAuthorized: true,
          accessReason: 'ingreso_excepcional',
          authorizationType: 'ingreso_excepcional',
          exceptionalEntry: true,
          emergency: true,
          alarmType: 'ingreso_emergencia',
          exceptionalReason: reasonText,
          relayTriggered: Boolean(accessResult?.relay?.triggered),
          relayError: accessResult?.relay?.error || null,
          accessRequestId: emergency.requestId,
          notes: emergency.message
        });
        res.status(201).json({
          message: emergency.message,
          entry: { id: ref.id, ...saved.data(), accessAuthorized: true },
          access: accessResult,
          accessRequestId: emergency.requestId,
          alarmType: 'ingreso_emergencia'
        });
        return;
      }

      accessResult = await triggerAccessIfAuthorized({
        movementType,
        idNumber,
        name,
        entrySource: entrySource || 'manual',
        entryId: ref.id,
        username: req.user.id,
        allowManualOverride: entrySource === 'manual' ? manualOverrideAllowed : null
      });

      const accessPatch = {
        accessAuthorized: accessResult.authorized,
        accessReason: accessResult.reason,
        authorizationType: accessResult.authorizationType,
        relayTriggered: Boolean(accessResult.relay?.triggered),
        relayError: accessResult.relay?.error || null
      };
      let pendingRequest = null;
      if (askedOverride || (exceptionalAllowed && reasonText && !useEmergency)) {
        try {
          const actor = await actorFromUser(req);
          pendingRequest = await createPendingFromEntry({
            name,
            idNumber,
            company,
            destination,
            empresaId: req.body?.empresaId,
            destinoId: req.body?.destinoId,
            motivo: reasonText || 'Pedido de autorización desde guardia'
          }, actor, { req });
          accessPatch.accessRequestId = pendingRequest.id;
          accessPatch.notes = pendingRequest.message;
        } catch (pendingErr) {
          console.error('accessRequest desde entrada:', pendingErr.message);
          accessPatch.notes = pendingErr.message;
        }
      }

      await ref.update(accessPatch);
      if (pendingRequest) {
        res.status(201).json({
          message: pendingRequest.message,
          entry: { id: ref.id, ...saved.data(), accessAuthorized: accessResult?.authorized },
          access: accessResult,
          accessRequest: { id: pendingRequest.id, message: pendingRequest.message }
        });
        return;
      }
    }

    res.status(201).json({
      message: 'Entrada creada exitosamente',
      entry: { id: ref.id, ...saved.data(), ...(type === 'personal' ? {
        accessAuthorized: accessResult?.authorized,
        accessReason: accessResult?.reason,
        relayTriggered: accessResult?.relay?.triggered
      } : {}) },
      ...(accessResult ? { access: accessResult } : {})
    });
  } catch (err) {
    sendServerError(res, err, 'Error al crear entrada', 'POST /api/entries');
  }
});

// Libro de guardia: solo roles operativos (no empleados autoregistrados).
router.get('/api/entries', auth, requireAnyPermission(['entries.view', 'reports.export']), async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      limit,
      cursor,
      type,
      q,
      search
    } = req.query || {};

    const page = await queryEntriesPage(db, {
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      limit,
      cursor: cursor || null,
      type: type || 'todos',
      q: q || search || ''
    });

    const userIds = [...new Set(
      page.docs.map((doc) => doc.data().registeredBy).filter(Boolean)
    )];

    const usernames = {};
    await Promise.all(userIds.map(async (userId) => {
      const userSnap = await db.collection('users').doc(userId).get();
      usernames[userId] = userSnap.exists ? userSnap.data().username : 'Desconocido';
    }));

    const entries = page.docs.map((doc) =>
      entryToJSON(doc, usernames[doc.data().registeredBy] || 'Desconocido')
    );

    res.json({
      entries,
      page: {
        limit: page.limit,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor
      },
      meta: {
        startDate: page.startDate,
        endDate: page.endDate,
        type: type || 'todos',
        q: q || search || ''
      }
    });
  } catch (err) {
    sendRouteError(res, err, 'Error al obtener entradas');
  }
});

module.exports = router;
