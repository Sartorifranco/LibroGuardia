/**
 * API para gestionar people: datos básicos + allowedDoorIds (fuente de verdad única).
 * Credenciales sin persona: allowedDoorIds vive en authorizations (mismo helper).
 */

const express = require('express');
const { db, FieldValue } = require('../firestore');
const {
  normalizeAllowedDoorIds,
  addDoorToAllowedList,
  removeDoorFromAllowedList
} = require('../lib/doorAccess');
const {
  personToAdminJSON,
  buildPersonProfilePatch,
  hasForeignConflict
} = require('../lib/peopleProfileUpdate');
const { loadAllPeople, analyzePeopleAlerts } = require('../lib/peopleAlerts');
const { mergePeople } = require('../lib/peopleMerge');
const {
  repairBiostarOrphanDoors,
  repairAllDoorsAccess,
  clearSuspiciousSharedDnis
} = require('../lib/peopleRepair');
const {
  buildCleanupPlan,
  applyCleanupPlan,
  applyCleanupActions
} = require('../lib/peopleCleanup');
const {
  buildRetainSourcesPlan,
  applyRetainSourcesStep
} = require('../lib/peopleRetainSources');
const {
  matchesAccessFilter,
  backfillPeopleLastAccess
} = require('../lib/peopleLastAccess');
const { bumpPeopleVersion } = require('../lib/dataVersions');
const {
  resolvePeopleListVersion,
  writePeopleListMeta
} = require('../lib/peopleListCache');
const { getDoorsConfig } = require('../lib/doorsConfig');
const { auth, requireAnyPermission } = require('../middleware/auth');

const router = express.Router();

const personToJSON = personToAdminJSON;

const bumpPeopleQuiet = () => bumpPeopleVersion().catch((err) => {
  console.warn('[peopleDoors] bumpPeopleVersion', err.message);
});

const canPeopleManage = requireAnyPermission([
  'access.doors.manage',
  'access.control',
  'master.nomina.write'
]);

const findPeopleByField = async (field, value) => {
  if (!value) return [];
  const snap = await db.collection('people').where(field, '==', value).limit(5).get();
  return snap.docs;
};

/** Buscar personas. Por defecto solo activas sin merge (ocultá basura desactivada).
 *  Query clientVersion: si el padrón no cambió, responde { unchanged: true } sin
 *  releer la colección (ahorro principal del listado Admin).
 */
router.get(
  '/api/admin/people',
  auth,
  requireAnyPermission(['access.doors.manage', 'access.control', 'master.personal.read', 'master.nomina.read', 'master.nomina.write']),
  async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
      const accessFilter = String(req.query.accessFilter || req.query.lastAccess || '').trim();
      const clientVersion = req.query.clientVersion;

      // Búsqueda puntual (q) siempre va a Firestore: no usa la caché de listado.
      if (!q && !includeInactive && !accessFilter) {
        const versionInfo = await resolvePeopleListVersion(clientVersion);
        if (versionInfo.unchanged) {
          return res.json({
            unchanged: true,
            version: versionInfo.version,
            people: [],
            includeInactive,
            accessFilter: null,
            truncated: false
          });
        }

        const snap = await db.collection('people').limit(1500).get();
        let people = snap.docs.map(personToJSON);
        people = people.filter((p) => p.active !== false && !p.mergedIntoId);
        people.sort((a, b) => a.name.localeCompare(b.name, 'es'));

        await writePeopleListMeta({
          version: versionInfo.version,
          count: people.length,
          peopleVer: versionInfo.peopleVer
        });

        return res.json({
          people,
          version: versionInfo.version,
          unchanged: false,
          includeInactive,
          accessFilter: null,
          truncated: snap.size >= 1500
        });
      }

      const snap = await db.collection('people').limit(1500).get();
      let people = snap.docs.map(personToJSON);
      if (!includeInactive) {
        people = people.filter((p) => p.active !== false && !p.mergedIntoId);
      }
      if (accessFilter) {
        people = people.filter((p) => matchesAccessFilter(p, accessFilter));
      }
      if (q) {
        const digits = q.replace(/\D/g, '');
        people = people.filter((p) =>
          p.name.toLowerCase().includes(q)
          || String(p.legajo || '').toLowerCase().includes(q)
          || (digits && String(p.idNumber).includes(digits))
          || (digits && String(p.legajo || '').includes(digits))
          || String(p.biometricExternalId || '').toLowerCase().includes(q)
          || p.id.toLowerCase().includes(q)
        );
      }
      people.sort((a, b) => a.name.localeCompare(b.name, 'es'));
      res.json({
        people: q ? people.slice(0, 80) : people,
        includeInactive,
        accessFilter: accessFilter || null,
        truncated: snap.size >= 1500
      });
    } catch (err) {
      res.status(500).json({ message: 'Error al buscar personas', error: err.message });
    }
  }
);

/**
 * Recalcula lastAccessAt desde el historial de entradas autorizadas.
 * Body: { limit?: number, cursorMillis?: number }
 */
router.post(
  '/api/admin/people/backfill-last-access',
  auth,
  canPeopleManage,
  async (req, res) => {
    try {
      const result = await backfillPeopleLastAccess({
        limit: req.body?.limit,
        cursorMillis: req.body?.cursorMillis ?? null
      });
      res.json({
        ok: true,
        message: result.done
          ? `Recálculo terminado: ${result.updated} personas actualizadas.`
          : `Lote procesado: ${result.updated} personas. Podés seguir con el cursor.`,
        ...result
      });
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message || 'No se pudo recalcular últimos accesos',
        error: err.message
      });
    }
  }
);

/** Duplicados, incompletos y sugerencias BioStar. */
router.get(
  '/api/admin/people/alerts',
  auth,
  canPeopleManage,
  async (_req, res) => {
    try {
      const people = await loadAllPeople(2000);
      const doorsCfg = await getDoorsConfig().catch(() => ({ doors: [] }));
      const activeDoorCount = (doorsCfg.doors || []).filter((d) => d.active !== false).length;
      const alerts = analyzePeopleAlerts(people, { activeDoorCount });
      res.json({
        ok: true,
        ...alerts,
        defaultDoorId: doorsCfg.defaultDoorId || null,
        activeDoorCount
      });
    } catch (err) {
      res.status(500).json({ message: err.message || 'Error al analizar personas' });
    }
  }
);

/** Alias del plan: duplicados. */
router.get(
  '/api/admin/people/duplicates',
  auth,
  canPeopleManage,
  async (_req, res) => {
    try {
      const people = await loadAllPeople(2000);
      const alerts = analyzePeopleAlerts(people);
      res.json({
        ok: true,
        duplicates: alerts.duplicates,
        incomplete: alerts.incomplete,
        counts: alerts.counts
      });
    } catch (err) {
      res.status(500).json({ message: err.message || 'Error al listar duplicados' });
    }
  }
);

/** Sugerencias BioStar ↔ empleado. */
router.get(
  '/api/admin/people/biostar-suggestions',
  auth,
  canPeopleManage,
  async (_req, res) => {
    try {
      const people = await loadAllPeople(2000);
      const alerts = analyzePeopleAlerts(people);
      res.json({
        ok: true,
        suggestions: alerts.biostarSuggestions,
        count: alerts.counts.biostarSuggestions
      });
    } catch (err) {
      res.status(500).json({ message: err.message || 'Error al listar sugerencias' });
    }
  }
);

/**
 * Une dos fichas. Body: { keepId, mergeId }
 * Conserva keepId; desactiva mergeId.
 */
router.post(
  '/api/admin/people/merge',
  auth,
  canPeopleManage,
  async (req, res) => {
    try {
      const keepId = String(req.body?.keepId || '').trim();
      const mergeId = String(req.body?.mergeId || '').trim();
      const result = await mergePeople(keepId, mergeId, {
        ignoredSuggestion: req.body?.ignored === true
      });
      res.json({ ok: true, message: 'Personas unificadas', ...result });
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message || 'Error al unificar personas',
        code: err.code
      });
    }
  }
);

/**
 * Corrige puertas de huérfanos BioStar (sin DNI/legajo).
 * Body: { mode: 'single'|'clear', doorId?: string }
 * single = solo esa puerta (defaultDoorId si no mandan); clear = ninguna.
 */
router.post(
  '/api/admin/people/repair-biostar-doors',
  auth,
  canPeopleManage,
  async (req, res) => {
    try {
      const result = await repairBiostarOrphanDoors({
        mode: req.body?.mode === 'clear' ? 'clear' : 'single',
        doorId: req.body?.doorId || null
      });
      res.json({
        ok: true,
        message: result.mode === 'clear'
          ? `Puertas quitadas a ${result.updated} fichas BioStar sin nómina`
          : `Dejadas en una sola puerta (${result.doorId}) para ${result.updated} fichas BioStar sin nómina`,
        ...result
      });
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message || 'Error al reparar puertas BioStar',
        code: err.code
      });
    }
  }
);

/**
 * Limpia DNI sospechosos (fechas / compartidos por 3+).
 * Deja el campo vacío para corregir a mano o re-importar.
 */
router.post(
  '/api/admin/people/clear-suspicious-dnis',
  auth,
  canPeopleManage,
  async (_req, res) => {
    try {
      const result = await clearSuspiciousSharedDnis();
      res.json({
        ok: true,
        message: `Se limpiaron ${result.updated} DNI sospechosos o masivamente compartidos`,
        ...result
      });
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message || 'Error al limpiar DNI',
        code: err.code
      });
    }
  }
);

/** Vista previa del asistente de limpieza (no escribe). */
router.get(
  '/api/admin/people/cleanup-plan',
  auth,
  canPeopleManage,
  async (_req, res) => {
    try {
      const plan = await buildCleanupPlan();
      res.json({ ok: true, plan });
    } catch (err) {
      res.status(500).json({ message: err.message || 'Error al armar plan de limpieza' });
    }
  }
);

/** Preview: conservar solo nómina + BioStar (no escribe). */
router.get(
  '/api/admin/people/retain-sources-plan',
  auth,
  canPeopleManage,
  async (_req, res) => {
    try {
      const plan = await buildRetainSourcesPlan();
      res.json({ ok: true, plan });
    } catch (err) {
      res.status(500).json({ message: err.message || 'Error al armar plan de retención' });
    }
  }
);

/**
 * Desactiva un lote de fichas que no son nómina ni BioStar.
 * Body: { cursor?, batchSize? }
 */
router.post(
  '/api/admin/people/retain-sources-step',
  auth,
  canPeopleManage,
  async (req, res) => {
    try {
      const cursor = req.body?.cursor ? String(req.body.cursor) : null;
      const batchSize = Number(req.body?.batchSize) || 40;
      const result = await applyRetainSourcesStep({ cursor, batchSize });
      const message = result.done
        ? `Listo: se dieron de baja ${result.deactivated} en este paso (recorrido terminado)`
        : `Baja parcial: ${result.deactivated} fichas (continúa…)`;
      res.json({ ok: true, message, ...result });
    } catch (err) {
      res.status(500).json({ message: err.message || 'Error al aplicar retención de fuentes' });
    }
  }
);

/**
 * Aplica UNA o varias sugerencias explícitas del asistente.
 * Body: { action } | { actions: [...] }
 */
router.post(
  '/api/admin/people/cleanup-action',
  auth,
  canPeopleManage,
  async (req, res) => {
    try {
      const body = req.body || {};
      const actions = Array.isArray(body.actions)
        ? body.actions
        : (body.action ? [body.action] : []);
      const result = await applyCleanupActions(actions);
      res.json({
        ok: true,
        message: result.report.errors.length
          ? `Aplicadas ${result.report.applied}; ${result.report.errors.length} con error`
          : `Aplicada${result.report.applied === 1 ? '' : 's'} ${result.report.applied} sugerencia${result.report.applied === 1 ? '' : 's'}`,
        ...result
      });
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message || 'Error al aplicar sugerencia',
        code: err.code
      });
    }
  }
);

/**
 * Aplica limpieza en lote (compat). Preferí cleanup-action por sugerencia.
 * Body: { clearSuspiciousDnis?, repairBiostarDoors?, applyAutoMerges?, extraMerges?, biostarDoorMode?, repairAllDoors? }
 */
router.post(
  '/api/admin/people/cleanup-apply',
  auth,
  canPeopleManage,
  async (req, res) => {
    try {
      const body = req.body || {};
      const result = await applyCleanupPlan({
        clearSuspiciousDnis: body.clearSuspiciousDnis === true,
        repairBiostarDoors: body.repairBiostarDoors === true,
        applyAutoMerges: body.applyAutoMerges === true,
        extraMerges: Array.isArray(body.extraMerges) ? body.extraMerges : [],
        biostarDoorMode: body.biostarDoorMode === 'clear' ? 'clear' : 'single',
        repairAllDoors: body.repairAllDoors === true
      });
      res.json({
        ok: true,
        message: `Limpieza aplicada: ${result.report.merged} uniones, ${result.report.repairedDoors} puertas, ${result.report.clearedDnis} DNI`,
        ...result
      });
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message || 'Error al aplicar limpieza',
        code: err.code
      });
    }
  }
);

/**
 * Corrige personas con acceso a TODAS las puertas activas.
 * Body: { mode?: 'biostar_default_others_clear'|'clear'|'default', doorId?, personIds? }
 */
router.post(
  '/api/admin/people/repair-all-doors',
  auth,
  canPeopleManage,
  async (req, res) => {
    try {
      const mode = ['clear', 'default', 'biostar_default_others_clear'].includes(req.body?.mode)
        ? req.body.mode
        : 'biostar_default_others_clear';
      const result = await repairAllDoorsAccess({
        mode,
        doorId: req.body?.doorId || null,
        personIds: Array.isArray(req.body?.personIds) ? req.body.personIds : null
      });
      res.json({
        ok: true,
        message: `Corregidas ${result.updated} fichas con acceso a todas las puertas`,
        ...result
      });
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message || 'Error al reparar acceso total',
        code: err.code
      });
    }
  }
);

/**
 * Actualiza datos básicos + puertas en un solo PUT.
 * Body opcional: name, legajo, idNumber, active, notas, allowedDoorIds
 */
router.put(
  '/api/admin/people/:id/allowed-doors',
  auth,
  requireAnyPermission(['access.doors.manage', 'access.control', 'master.nomina.write']),
  async (req, res) => {
    try {
      const personId = String(req.params.id || '').trim();
      const ref = db.collection('people').doc(personId);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ message: 'Persona no encontrada' });
      }

      const existing = snap.data() || {};
      const built = buildPersonProfilePatch(existing, req.body || {});
      if (!built.ok) {
        return res.status(built.status).json({ message: built.message });
      }

      const { patch } = built;

      if (Object.prototype.hasOwnProperty.call(patch, 'legajoNormalized') && patch.legajoNormalized) {
        const conflicts = await findPeopleByField('legajoNormalized', patch.legajoNormalized);
        if (hasForeignConflict(conflicts, personId)) {
          return res.status(409).json({
            message: `Ya existe otra persona con el legajo ${patch.legajoNormalized}`
          });
        }
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'dniNormalized') && patch.dniNormalized) {
        const conflicts = await findPeopleByField('dniNormalized', patch.dniNormalized);
        if (hasForeignConflict(conflicts, personId)) {
          return res.status(409).json({
            message: `Ya existe otra persona con el DNI ${patch.dniNormalized}`
          });
        }
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'accessCard') && patch.accessCard) {
        const conflicts = await findPeopleByField('accessCard', patch.accessCard);
        if (hasForeignConflict(conflicts, personId)) {
          return res.status(409).json({
            message: `Ya existe otra persona con la tarjeta ${patch.accessCard}`
          });
        }
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'biometricExternalId') && patch.biometricExternalId) {
        const conflicts = await findPeopleByField('biometricExternalId', patch.biometricExternalId);
        if (hasForeignConflict(conflicts, personId)) {
          return res.status(409).json({
            message: `Ya existe otra persona con el ID biométrico ${patch.biometricExternalId}`
          });
        }
      }

      // Compat: si no mandan allowedDoorIds, conservar el actual (comportamiento previo).
      if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'allowedDoorIds')
        && !Object.prototype.hasOwnProperty.call(patch, 'allowedDoorIds')) {
        // no-op on doors
      }

      if (Object.keys(patch).length === 0) {
        return res.json({ message: 'Sin cambios', person: personToJSON(snap) });
      }

      await ref.update({
        ...patch,
        updatedAt: FieldValue.serverTimestamp()
      });
      bumpPeopleQuiet();
      const updated = await ref.get();
      res.json({ message: 'Persona actualizada', person: personToJSON(updated) });
    } catch (err) {
      res.status(500).json({ message: 'Error al actualizar persona', error: err.message });
    }
  }
);

/** Personas con esta puerta + diagnóstico de quién puede pasar ahora. */
router.get(
  '/api/admin/doors/:doorId/people',
  auth,
  requireAnyPermission(['access.doors.manage', 'access.control']),
  async (req, res) => {
    try {
      const doorId = String(req.params.doorId || '').trim();
      if (!doorId) {
        return res.status(400).json({ message: 'doorId inválido' });
      }

      const diagnose = String(req.query.diagnose || '0') === '1';
      if (diagnose) {
        const { diagnoseDoorPeople } = require('../lib/doorPeopleDiagnostics');
        const result = await diagnoseDoorPeople(doorId);
        return res.json(result);
      }

      const explicitSnap = await db.collection('people')
        .where('allowedDoorIds', 'array-contains', doorId)
        .limit(500)
        .get();

      res.json({
        doorId,
        people: explicitSnap.docs.map(personToJSON),
        summary: {
          assigned: explicitSnap.size,
          canPassNow: null,
          blocked: null
        },
        note: 'Lista rápida. Usá “Calcular quién puede pasar ahora” para el diagnóstico completo.'
      });
    } catch (err) {
      res.status(err.status || 500).json({
        message: err.message || 'Error al listar personas de la puerta',
        code: err.code
      });
    }
  }
);

/** Agrega la puerta a allowedDoorIds de la persona. */
router.post(
  '/api/admin/doors/:doorId/people',
  auth,
  requireAnyPermission(['access.doors.manage', 'access.control']),
  async (req, res) => {
    try {
      const doorId = String(req.params.doorId || '').trim();
      const personId = String(req.body?.personId || '').trim();
      if (!doorId || !personId) {
        return res.status(400).json({ message: 'doorId y personId son obligatorios' });
      }
      const ref = db.collection('people').doc(personId);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ message: 'Persona no encontrada' });
      }
      const prev = snap.data().allowedDoorIds;
      const hadNoDoors = normalizeAllowedDoorIds(prev).length === 0;
      const allowedDoorIds = addDoorToAllowedList(prev, doorId);
      await ref.update({ allowedDoorIds, updatedAt: FieldValue.serverTimestamp() });
      bumpPeopleQuiet();
      const updated = await ref.get();
      res.json({
        message: hadNoDoors
          ? 'Puerta agregada (antes no tenía ninguna)'
          : 'Puerta agregada a la persona',
        person: personToJSON(updated),
        hadNoDoors
      });
    } catch (err) {
      res.status(500).json({ message: 'Error al vincular persona', error: err.message });
    }
  }
);

/** Quita la puerta de la lista; si queda vacía → ninguna puerta ([]). */
router.delete(
  '/api/admin/doors/:doorId/people/:personId',
  auth,
  requireAnyPermission(['access.doors.manage', 'access.control']),
  async (req, res) => {
    try {
      const doorId = String(req.params.doorId || '').trim();
      const personId = String(req.params.personId || '').trim();
      const ref = db.collection('people').doc(personId);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ message: 'Persona no encontrada' });
      }
      const allowedDoorIds = removeDoorFromAllowedList(snap.data().allowedDoorIds, doorId);
      await ref.update({ allowedDoorIds, updatedAt: FieldValue.serverTimestamp() });
      bumpPeopleQuiet();
      const updated = await ref.get();
      res.json({ message: 'Puerta quitada de la persona', person: personToJSON(updated) });
    } catch (err) {
      res.status(500).json({ message: 'Error al desvincular persona', error: err.message });
    }
  }
);

/**
 * Sincroniza allowedDoorIds en people a partir de DNI (usado desde master-data / Personal).
 * Cuerpo: { idNumber, name?, allowedDoorIds }
 */
router.put(
  '/api/admin/people/by-dni/allowed-doors',
  auth,
  requireAnyPermission(['access.doors.manage', 'access.control', 'master.nomina.write', 'entries.create']),
  async (req, res) => {
    try {
      const idNumber = String(req.body?.idNumber || '').replace(/\D/g, '');
      if (idNumber.length < 7) {
        return res.status(400).json({ message: 'DNI inválido' });
      }
      const snap = await db.collection('people')
        .where('dniNormalized', '==', idNumber)
        .limit(1)
        .get();
      if (snap.empty) {
        return res.status(404).json({
          message: 'No hay registro en people con ese DNI. Importá nómina o registrá un acceso primero.'
        });
      }
      const ref = snap.docs[0].ref;
      const allowedDoorIds = normalizeAllowedDoorIds(req.body?.allowedDoorIds);
      await ref.update({ allowedDoorIds, updatedAt: FieldValue.serverTimestamp() });
      bumpPeopleQuiet();
      const updated = await ref.get();
      res.json({ message: 'Puertas actualizadas', person: personToJSON(updated) });
    } catch (err) {
      res.status(500).json({ message: 'Error al actualizar por DNI', error: err.message });
    }
  }
);

module.exports = router;
module.exports.personToJSON = personToJSON;
module.exports.buildPersonProfilePatch = buildPersonProfilePatch;
module.exports.hasForeignConflict = hasForeignConflict;
