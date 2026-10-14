/**
 * Panel empleado: visitas propias + destinos de solo lectura.
 * Invitación pública por token (QR / WhatsApp / mail).
 * create = autorizada al instante; request = pendiente de aprobación admin.
 */

const crypto = require('crypto');
const express = require('express');
const { markDirty } = require('../lib/siteCompiler');
const { db, FieldValue, Timestamp } = require('../firestore');
const {
  auth,
  requirePermission,
  requireAnyPermission,
  sendServerError,
  sendRouteError
} = require('../middleware/auth');
const { normalizeDni } = require('../lib/normalize');
const { validateDestinationDoorIds } = require('../lib/empresasDestinos');
const { getDoorsConfig } = require('../lib/doorsConfig');
const { filterOwnVisitas, toDate } = require('../lib/visitasAccess');
const { generatePassCode } = require('../lib/visitPassCode');
const { logAdminAction } = require('../lib/auditLog');
const { resolveVisitDuration, inviteExpiresAtOf } = require('../lib/visitDuration');
const { checkVisitHost } = require('../lib/visitasSettings');
const { isReservedScheduleId } = require('../lib/accessModel');
const { scheduleResumen } = require('../lib/scheduleResumen');

const router = express.Router();

const newInviteToken = () => crypto.randomBytes(24).toString('hex');

const OPERATIVE_SHARE_ESTADOS = new Set(['pendiente', 'autorizada']);
/** Estados en los que el anfitrión todavía puede cancelar o editar. */
const HOST_EDITABLE_ESTADOS = new Set(['pendiente_aprobacion', 'autorizada', 'pendiente']);
const CLOSED_INVITE_ESTADOS = new Set(['cancelada', 'rechazada', 'revocada']);
const MAX_PREVIOUS_PASS_CODES = 10;

const isoOf = (value) => (value?.toDate ? value.toDate().toISOString() : value);

const serializeVisita = (v) => ({
  ...v,
  createdAt: isoOf(v.createdAt),
  fechaHoraEsperada: isoOf(v.fechaHoraEsperada),
  aprobadoAt: isoOf(v.aprobadoAt),
  inviteExpiresAt: isoOf(v.inviteExpiresAt),
  validoHasta: isoOf(v.validoHasta),
  ingresoAt: isoOf(v.ingresoAt),
  egresoAt: isoOf(v.egresoAt)
});

/** 403 si el usuario no puede invitar (dominio del mail o mail sin confirmar); null si puede. */
const denyIfNotHost = async (req, res, profile) => {
  const denied = await checkVisitHost({ id: req.user.id, ...(profile || {}) }, { role: req.user.role });
  if (!denied) return false;
  res.status(denied.status).json({ error: denied.error, message: denied.error, code: denied.code });
  return true;
};

/**
 * Duración + horario del sitio (si viene) → { error } o la duración resuelta, con
 * scheduleNombre/scheduleResumen para mostrar sin volver a leer el horario.
 */
const resolveDuracion = async (input) => {
  const dur = resolveVisitDuration(input);
  if (dur.error) return dur;
  if (!dur.scheduleId) return { ...dur, scheduleNombre: null, scheduleResumen: null };
  if (isReservedScheduleId(dur.scheduleId)) {
    return { error: 'El horario elegido no existe. Elegí otro o dejalo sin horario.' };
  }
  const sch = await db.collection('schedules').doc(dur.scheduleId).get();
  if (!sch.exists) return { error: 'El horario elegido no existe. Elegí otro o dejalo sin horario.' };
  const data = sch.data() || {};
  return {
    ...dur,
    scheduleNombre: String(data.name || '').trim() || null,
    scheduleResumen: scheduleResumen(data.intervals) || null
  };
};

/** Solo los últimos 3 dígitos del DNI (la página pública no muestra el DNI completo). */
const maskDni = (dni) => {
  const digits = normalizeDni(dni);
  if (!digits) return '';
  return `***${digits.slice(-3)}`;
};

/**
 * Valida fecha y destino igual para alta y edición.
 * @returns {Promise<{ error: string }|{ expected: Date, destino: object, allowedDoorIds: string[] }>}
 */
const resolveFechaYDestino = async ({ fechaHoraEsperadaRaw, destinoId }) => {
  const expected = new Date(fechaHoraEsperadaRaw);
  if (Number.isNaN(expected.getTime())) {
    return { error: 'fechaHoraEsperada inválida' };
  }
  const destSnap = await db.collection('destinos').doc(destinoId).get();
  if (!destSnap.exists || destSnap.data()?.activo === false) {
    return { error: 'Destino inválido o inactivo' };
  }
  const destino = destSnap.data();
  const doorsConfig = await getDoorsConfig();
  const allowedDoorIds = validateDestinationDoorIds(destino.doorIds || [], doorsConfig);
  return { expected, destino, allowedDoorIds };
};

const loadUserProfile = async (userId) => {
  const snap = await db.collection('users').doc(userId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
};

const userDisplayName = (user) => {
  if (!user) return '';
  return String(user.nombre || user.name || user.username || user.email || user.id || '').trim();
};

/** Destinos activos (solo id/nombre) para el formulario de visitas. */
router.get(
  '/api/empleado/destinos',
  auth,
  requireAnyPermission(['visitas.create', 'visitas.request']),
  async (_req, res) => {
    try {
      const snap = await db.collection('destinos').orderBy('nombre').get();
      const destinos = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((d) => d.activo !== false)
        .map((d) => ({ id: d.id, nombre: d.nombre, doorIds: d.doorIds || [] }));
      res.json({ destinos });
    } catch (err) {
      sendServerError(res, err, 'Error al listar destinos');
    }
  }
);

/** Horarios del sitio (id, nombre y resumen) para limitar un pase "Por mes". Solo lectura. */
router.get(
  '/api/empleado/horarios',
  auth,
  requireAnyPermission(['visitas.create', 'visitas.request']),
  async (_req, res) => {
    try {
      const snap = await db.collection('schedules').orderBy('name').limit(50).get();
      const horarios = snap.docs
        .filter((d) => !isReservedScheduleId(d.id))
        .map((d) => {
          const data = d.data() || {};
          return { id: d.id, nombre: String(data.name || d.id), resumen: scheduleResumen(data.intervals) };
        });
      res.json({ horarios });
    } catch (err) {
      sendServerError(res, err, 'Error al listar horarios');
    }
  }
);

router.get('/api/empleado/visitas', auth, requirePermission('visitas.view.own'), async (req, res) => {
  try {
    const userId = req.user.id;
    let snap;
    try {
      snap = await db.collection('visitas')
        .where('createdByUserId', '==', userId)
        .orderBy('createdAt', 'desc')
        .limit(100)
        .get();
    } catch {
      snap = await db.collection('visitas')
        .where('createdByUserId', '==', userId)
        .limit(100)
        .get();
    }

    const visitas = filterOwnVisitas(
      snap.docs.map((d) => ({ id: d.id, ...d.data() })),
      userId
    ).map(serializeVisita);

    res.json({ visitas });
  } catch (err) {
    sendServerError(res, err, 'Error al listar visitas');
  }
});

router.post(
  '/api/empleado/visitas',
  auth,
  requireAnyPermission(['visitas.create', 'visitas.request']),
  async (req, res) => {
    try {
      const userId = req.user.id;
      const permissions = Array.isArray(req.userPermissions) ? req.userPermissions : [];
      const isAdmin = req.user.role === 'admin';
      const canCreate = isAdmin || permissions.includes('visitas.create');
      const canRequest = isAdmin || permissions.includes('visitas.request');
      if (!canCreate && !canRequest) {
        return res.status(403).json({ message: 'Acceso denegado: permiso insuficiente' });
      }

      const user = await loadUserProfile(userId);
      if (await denyIfNotHost(req, res, user)) return undefined;
      const empresaId = user?.empresaId || null;
      if (!empresaId) {
        return res.status(400).json({ message: 'Tu usuario no tiene empresa asignada' });
      }

      let empresaNombre = '';
      try {
        const empSnap = await db.collection('empresas').doc(empresaId).get();
        if (empSnap.exists) {
          empresaNombre = String(empSnap.data()?.nombre || empSnap.data()?.name || '').trim();
        }
      } catch {
        // ignore
      }

      const createdByNombre = userDisplayName({ ...user, id: userId });
      const nombreVisitante = String(req.body?.nombreVisitante || '').trim();
      const dniVisitante = String(req.body?.dniVisitante || '').trim();
      const motivo = String(req.body?.motivo || '').trim();
      const destinoId = String(req.body?.destinoId || '').trim();
      const fechaHoraEsperadaRaw = req.body?.fechaHoraEsperada;

      if (!nombreVisitante || !dniVisitante || !destinoId || !fechaHoraEsperadaRaw) {
        return res.status(400).json({
          message: 'nombreVisitante, dniVisitante, destinoId y fechaHoraEsperada son obligatorios'
        });
      }

      const resolved = await resolveFechaYDestino({ fechaHoraEsperadaRaw, destinoId });
      if (resolved.error) {
        return res.status(400).json({ message: resolved.error });
      }
      const { expected, destino, allowedDoorIds } = resolved;
      const dur = await resolveDuracion({
        duracion: req.body?.duracion,
        expected,
        validoHasta: req.body?.validoHasta,
        scheduleId: req.body?.scheduleId
      });
      if (dur.error) {
        return res.status(400).json({ message: dur.error });
      }

      const dniVisitanteNormalized = normalizeDni(dniVisitante);
      const isApprover = isAdmin || permissions.includes('visitas.approve');
      // Decide el rol: visitas.create autoriza directo; solo visitas.request va a Seguridad
      // (el autoregistro entra con request hasta que un admin le cambie el rol).
      // El pase por mes siempre lo aprueba Seguridad (visitas.approve o admin).
      const autoAuthorize = canCreate && (!dur.requiresApproval || isApprover);
      const estado = autoAuthorize ? 'autorizada' : 'pendiente_aprobacion';
      const inviteToken = autoAuthorize ? newInviteToken() : null;
      const { normalizePhotoDataUrl } = require('../lib/personPhoto');
      let photoDataUrl = null;
      if (req.body?.photoDataUrl) {
        const photo = normalizePhotoDataUrl(req.body.photoDataUrl);
        if (!photo.ok) {
          return res.status(400).json({ message: photo.message });
        }
        photoDataUrl = photo.value;
      }
      const ref = db.collection('visitas').doc();
      const doc = {
        nombreVisitante,
        dniVisitante,
        dniVisitanteNormalized,
        fechaHoraEsperada: Timestamp.fromDate(expected),
        duracion: dur.duracion,
        validoHasta: Timestamp.fromDate(dur.validoHasta),
        scheduleId: dur.scheduleId,
        scheduleNombre: dur.scheduleNombre,
        scheduleResumen: dur.scheduleResumen,
        motivo,
        destinoId,
        destinoNombre: destino.nombre || '',
        allowedDoorIds,
        empresaId,
        empresaNombre,
        createdByUserId: userId,
        createdByNombre,
        inviteToken,
        inviteExpiresAt: Timestamp.fromDate(new Date(dur.validTo)),
        passCode: generatePassCode(),
        estado,
        photoDataUrl,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };
      await ref.set(doc);
      markDirty({ visitas: [ref.id] });

      res.status(201).json({
        message: autoAuthorize
          ? 'Visita registrada y autorizada'
          : 'Solicitud de visita enviada. Queda pendiente de aprobación.',
        visita: {
          id: ref.id,
          ...doc,
          fechaHoraEsperada: expected.toISOString(),
          validoHasta: dur.validoHasta.toISOString(),
          inviteExpiresAt: new Date(dur.validTo).toISOString(),
          createdAt: new Date().toISOString()
        }
      });
    } catch (err) {
      sendRouteError(res, err, 'Error al crear visita');
    }
  }
);

/** Asegura inviteToken en visitas operativas (solo dueño). */
router.post(
  '/api/empleado/visitas/:id/ensure-invite',
  auth,
  requireAnyPermission(['visitas.create', 'visitas.request']),
  async (req, res) => {
    try {
      const userId = req.user.id;
      const ref = db.collection('visitas').doc(req.params.id);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ message: 'Visita no encontrada' });
      }
      const data = snap.data() || {};
      if (data.createdByUserId !== userId) {
        return res.status(403).json({ message: 'No podés compartir esta visita' });
      }
      if (!OPERATIVE_SHARE_ESTADOS.has(data.estado || 'pendiente')) {
        return res.status(400).json({
          message: 'La visita aún no está autorizada. Cuando un admin la apruebe vas a poder compartir el QR.'
        });
      }
      const patch = {};
      if (!data.inviteToken) patch.inviteToken = newInviteToken();
      if (!data.passCode) patch.passCode = generatePassCode();
      const expiresAt = inviteExpiresAtOf(data);
      if (!data.inviteExpiresAt && expiresAt) patch.inviteExpiresAt = Timestamp.fromDate(expiresAt);
      if (Object.keys(patch).length) {
        await ref.set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        if (patch.passCode) markDirty({ visitas: [ref.id] });
      }
      const inviteToken = data.inviteToken || patch.inviteToken;
      res.json({
        inviteToken,
        visita: serializeVisita({ id: snap.id, ...data, ...patch })
      });
    } catch (err) {
      sendServerError(res, err, 'Error al preparar invitación');
    }
  }
);

const HOST_PERMISSIONS = ['visitas.create', 'visitas.request', 'visitas.approve'];

/** Carga la visita si el usuario la puede cancelar/editar; si no, responde y devuelve null. */
const loadHostEditableVisita = async (req, res) => {
  const ref = db.collection('visitas').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).json({ message: 'Visita no encontrada' });
    return null;
  }
  const data = snap.data() || {};
  const permissions = Array.isArray(req.userPermissions) ? req.userPermissions : [];
  const isApprover = req.user.role === 'admin' || permissions.includes('visitas.approve');
  if (data.createdByUserId !== req.user.id && !isApprover) {
    res.status(403).json({ message: 'Solo quien registró la visita puede cambiarla' });
    return null;
  }
  if (!HOST_EDITABLE_ESTADOS.has(data.estado || 'pendiente')) {
    res.status(400).json({ message: 'Esta visita ya no se puede cambiar' });
    return null;
  }
  return { ref, data, permissions, isApprover };
};

router.post(
  '/api/empleado/visitas/:id/cancel',
  auth,
  requireAnyPermission(HOST_PERMISSIONS),
  async (req, res) => {
    try {
      const loaded = await loadHostEditableVisita(req, res);
      if (!loaded) return undefined;
      const { ref, data } = loaded;
      const canceladaPor = userDisplayName(req.user);
      await ref.set({
        estado: 'cancelada',
        canceladaPor,
        canceladaPorUserId: req.user.id,
        canceladaAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      markDirty({ visitas: [ref.id] });
      logAdminAction({
        req,
        action: 'visita.cancel',
        targetType: 'visita',
        targetId: ref.id,
        before: { estado: data.estado },
        after: { estado: 'cancelada', nombreVisitante: data.nombreVisitante }
      }).catch((err) => console.error('auditLog visita.cancel:', err.message));
      const updated = await ref.get();
      return res.json({
        message: 'Visita cancelada. El pase ya no sirve para entrar.',
        visita: serializeVisita({ id: updated.id, ...updated.data() })
      });
    } catch (err) {
      return sendServerError(res, err, 'Error al cancelar visita');
    }
  }
);

router.patch(
  '/api/empleado/visitas/:id',
  auth,
  requireAnyPermission(HOST_PERMISSIONS),
  async (req, res) => {
    try {
      const body = req.body || {};
      const hasFecha = body.fechaHoraEsperada !== undefined;
      const hasMotivo = body.motivo !== undefined;
      const hasDestino = body.destinoId !== undefined;
      const hasDuracion = body.duracion !== undefined || body.validoHasta !== undefined || body.scheduleId !== undefined;
      if (!hasFecha && !hasMotivo && !hasDestino && !hasDuracion) {
        return res.status(400).json({
          message: 'Indicá qué querés cambiar: fechaHoraEsperada, duracion, validoHasta, motivo o destinoId'
        });
      }

      const loaded = await loadHostEditableVisita(req, res);
      if (!loaded) return undefined;
      const { ref, data, permissions, isApprover } = loaded;
      const isAdmin = req.user.role === 'admin';
      const editor = isAdmin ? null : await loadUserProfile(req.user.id);
      if (await denyIfNotHost(req, res, editor)) return undefined;

      const currentExpected = toDate(data.fechaHoraEsperada);
      const fechaHoraEsperadaRaw = hasFecha ? body.fechaHoraEsperada : currentExpected?.toISOString();
      const destinoId = String(hasDestino ? body.destinoId : data.destinoId || '').trim();
      if (!fechaHoraEsperadaRaw || !destinoId) {
        return res.status(400).json({ message: 'destinoId y fechaHoraEsperada son obligatorios' });
      }
      const resolved = await resolveFechaYDestino({ fechaHoraEsperadaRaw, destinoId });
      if (resolved.error) {
        return res.status(400).json({ message: resolved.error });
      }
      const { expected, destino, allowedDoorIds } = resolved;

      const duracion = body.duracion !== undefined ? body.duracion : (data.duracion || 'un_ingreso');
      const fechaCambio = hasFecha && expected.getTime() !== currentExpected?.getTime();
      let validoHasta = body.validoHasta;
      if (validoHasta === undefined) {
        // Un solo ingreso o todo el día: al mover la fecha se recalcula el fin.
        const recalcular = fechaCambio && (duracion === 'un_ingreso' || duracion === 'dia');
        validoHasta = recalcular ? null : toDate(data.validoHasta);
      }
      const dur = await resolveDuracion({
        duracion,
        expected,
        validoHasta,
        scheduleId: body.scheduleId !== undefined ? body.scheduleId : data.scheduleId
      });
      if (dur.error) {
        return res.status(400).json({ message: dur.error });
      }

      // Mismo criterio que el alta: solo con visitas.request vuelve a aprobación;
      // el pase por mes siempre lo aprueba Seguridad.
      const keepEstado = isAdmin || isApprover
        || (permissions.includes('visitas.create') && !dur.requiresApproval);
      const estado = keepEstado ? (data.estado || 'pendiente') : 'pendiente_aprobacion';

      const previousPassCodes = [
        ...(Array.isArray(data.previousPassCodes) ? data.previousPassCodes : []),
        ...(data.passCode ? [data.passCode] : [])
      ].slice(-MAX_PREVIOUS_PASS_CODES);

      const patch = {
        fechaHoraEsperada: Timestamp.fromDate(expected),
        duracion: dur.duracion,
        validoHasta: Timestamp.fromDate(dur.validoHasta),
        scheduleId: dur.scheduleId,
        scheduleNombre: dur.scheduleNombre,
        scheduleResumen: dur.scheduleResumen,
        motivo: hasMotivo ? String(body.motivo || '').trim() : (data.motivo || ''),
        destinoId,
        destinoNombre: destino.nombre || '',
        allowedDoorIds,
        estado,
        passCode: generatePassCode(),
        previousPassCodes,
        inviteToken: OPERATIVE_SHARE_ESTADOS.has(estado) ? newInviteToken() : null,
        inviteExpiresAt: Timestamp.fromDate(new Date(dur.validTo)),
        editadaPorUserId: req.user.id,
        updatedAt: FieldValue.serverTimestamp()
      };
      await ref.set(patch, { merge: true });
      markDirty({ visitas: [ref.id] });
      logAdminAction({
        req,
        action: 'visita.update',
        targetType: 'visita',
        targetId: ref.id,
        before: {
          estado: data.estado,
          fechaHoraEsperada: currentExpected ? currentExpected.toISOString() : null,
          duracion: data.duracion || 'un_ingreso',
          motivo: data.motivo || '',
          destinoId: data.destinoId || null
        },
        after: {
          estado,
          fechaHoraEsperada: expected.toISOString(),
          duracion: dur.duracion,
          validoHasta: dur.validoHasta.toISOString(),
          motivo: patch.motivo,
          destinoId
        }
      }).catch((err) => console.error('auditLog visita.update:', err.message));

      const updated = await ref.get();
      return res.json({
        message: estado === 'pendiente_aprobacion'
          ? 'Visita modificada. Queda pendiente de aprobación; el pase anterior ya no sirve.'
          : 'Visita modificada. Mandale el nuevo pase: el anterior ya no sirve.',
        visita: serializeVisita({ id: updated.id, ...updated.data() })
      });
    } catch (err) {
      return sendRouteError(res, err, 'Error al modificar visita');
    }
  }
);

/**
 * Vista pública de invitación (sin login).
 * El token es el secreto; no listar visitas sin él.
 */
router.get('/api/public/visita-invite/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token || token.length < 16) {
      return res.status(400).json({ message: 'Token inválido' });
    }
    const snap = await db.collection('visitas')
      .where('inviteToken', '==', token)
      .limit(1)
      .get();
    if (snap.empty) {
      return res.status(404).json({ message: 'Invitación no encontrada o vencida' });
    }
    const doc = snap.docs[0];
    const raw = doc.data() || {};
    const estado = raw.estado || 'pendiente';
    if (CLOSED_INVITE_ESTADOS.has(estado)) {
      return res.status(410).json({
        message: 'Esta invitación fue cancelada. Si tenés que venir igual, pedile a quien te invitó que te mande una nueva.'
      });
    }
    const expiresAt = toDate(raw.inviteExpiresAt) || inviteExpiresAtOf(raw);
    if (expiresAt && Date.now() > expiresAt.getTime()) {
      return res.status(410).json({
        message: 'Esta invitación ya venció. Si tenés que venir otro día, pedile a quien te invitó que te mande una nueva.'
      });
    }
    const v = serializeVisita({ id: doc.id, ...raw });
    if (!OPERATIVE_SHARE_ESTADOS.has(estado)) {
      return res.status(404).json({ message: 'Invitación no disponible' });
    }
    res.json({
      invite: {
        id: v.id,
        nombreVisitante: v.nombreVisitante,
        dniMasked: maskDni(v.dniVisitanteNormalized || v.dniVisitante),
        passCode: v.passCode || null,
        destinoNombre: v.destinoNombre || '',
        fechaHoraEsperada: v.fechaHoraEsperada,
        duracion: v.duracion || 'un_ingreso',
        validoHasta: v.validoHasta || null,
        horario: v.scheduleResumen || null,
        inviteExpiresAt: expiresAt ? expiresAt.toISOString() : null,
        motivo: v.motivo || '',
        estado
      }
    });
  } catch (err) {
    sendServerError(res, err, 'Error al cargar invitación');
  }
});

module.exports = router;
