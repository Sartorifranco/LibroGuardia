'use strict';

/**
 * CRUD de horarios, feriados y grupos de acceso, asignación a personas
 * y simulación «¿Puede pasar?».
 */

const express = require('express');
const crypto = require('node:crypto');
const { db, FieldValue } = require('../firestore');
const { markDirty, getCloudSnapshot } = require('../lib/siteCompiler');
const { getDoorsConfig } = require('../lib/doorsConfig');
const { auth, requirePermission, requireAnyPermission } = require('../middleware/auth');
const { logAdminAction } = require('../lib/auditLog');
const { bumpPeopleVersion } = require('../lib/dataVersions');
const { nominaRequiresGrant } = require('../lib/siteCompiler/build');
const { resolveShiftSchedule } = require('../lib/shiftParser');
const {
  ALWAYS_SCHEDULE_ID,
  ALWAYS_SCHEDULE_PUBLIC,
  sanitizeScheduleInput,
  sanitizeGroupInput,
  sanitizeHolidayList,
  mergeHolidayLists,
  nationalHolidays,
  explainAccess,
  toSnapshotSchedule,
  publicDoors,
  isReservedScheduleId
} = require('../lib/accessModel');
const { simulateAccess } = require('../lib/accessSimulate');

const router = express.Router();

const SCHEDULES = 'schedules';
const HOLIDAYS = 'holidays';
const GROUPS = 'accessGroups';
const LIST_LIMIT = 50;

const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

const audit = (req, action, targetType, targetId, before, after) => {
  logAdminAction({ req, action, targetType, targetId, before, after })
    .catch((err) => console.error('[accessModel] audit', err.message));
};

const canManage = requirePermission('access.groups.manage');
const canAssign = requirePermission('personas.puertas.asignar');
const canRead = requireAnyPermission(['access.groups.manage', 'personas.puertas.asignar']);

const levelIds = (raw) => [...new Set((Array.isArray(raw) ? raw : [])
  .map((x) => String(x || '').trim())
  .filter(Boolean))];

const peopleInGroups = async (groupIds) => {
  const ids = new Set();
  let overflow = false;
  for (const gid of groupIds) {
    if (!gid) continue;
    const snap = await db.collection('people').where('accessLevels', 'array-contains', gid).limit(301).get();
    if (snap.size > 300) overflow = true;
    snap.docs.forEach((d) => ids.add(d.id));
    if (ids.size > 300) overflow = true;
  }
  return { ids: [...ids], overflow };
};

const groupIdsForSchedules = async (scheduleIds) => {
  const ids = [];
  for (const sid of scheduleIds) {
    if (!sid || sid === ALWAYS_SCHEDULE_ID) continue;
    const snap = await db.collection(GROUPS).where('scheduleId', '==', sid).limit(50).get();
    snap.docs.forEach((d) => ids.push(d.id));
  }
  return ids;
};

/** Cambio de grupo, horario o feriado: recompila puertas y los buckets de las personas afectadas. */
const markModelDirty = async ({ groupIds = [], scheduleIds = [] } = {}) => {
  const extra = await groupIdsForSchedules(scheduleIds);
  const { ids, overflow } = await peopleInGroups([...new Set([...groupIds, ...extra])]);
  if (overflow) {
    markDirty({ doors: true, full: true });
    return;
  }
  markDirty({ doors: true, ...(ids.length ? { people: ids } : {}) });
};

const scheduleIdsKnown = async () => {
  const snap = await db.collection(SCHEDULES).limit(200).get();
  return new Set(snap.docs.map((d) => d.id));
};

const loadDoorContext = async () => {
  const cfg = await getDoorsConfig().catch(() => ({ doors: [] }));
  const doors = publicDoors(cfg);
  return { doors, ids: new Set(doors.map((d) => d.id)) };
};

const scheduleJson = (id, data = {}) => ({ id, ...data, builtin: false, always: false });

// ── Horarios ────────────────────────────────────────────────────────────

router.get('/api/admin/schedules', auth, canManage, async (_req, res) => {
  try {
    const snap = await db.collection(SCHEDULES).orderBy('name').limit(LIST_LIMIT).get();
    const schedules = [
      { ...ALWAYS_SCHEDULE_PUBLIC },
      ...snap.docs.map((d) => scheduleJson(d.id, d.data()))
    ];
    res.json({ schedules, truncated: snap.size >= LIST_LIMIT });
  } catch (err) {
    res.status(500).json({ message: 'No se pudieron cargar los horarios.' });
  }
});

router.post('/api/admin/schedules', auth, canManage, async (req, res) => {
  try {
    const parsed = sanitizeScheduleInput(req.body || {});
    if (!parsed.ok) return res.status(400).json({ message: parsed.message });
    const id = newId('sch');
    const doc = { ...parsed.value, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    await db.collection(SCHEDULES).doc(id).set(doc);
    audit(req, 'schedule.create', 'schedule', id, null, parsed.value);
    await markModelDirty({ scheduleIds: [id] });
    res.status(201).json({ schedule: scheduleJson(id, parsed.value) });
  } catch (err) {
    res.status(500).json({ message: 'No se pudo crear el horario.' });
  }
});

router.put('/api/admin/schedules/:id', auth, canManage, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (isReservedScheduleId(id)) {
      return res.status(400).json({ message: 'El horario Siempre no se puede modificar.' });
    }
    const ref = db.collection(SCHEDULES).doc(id);
    const prev = await ref.get();
    if (!prev.exists) return res.status(404).json({ message: 'No encontramos ese horario.' });
    const parsed = sanitizeScheduleInput(req.body || {});
    if (!parsed.ok) return res.status(400).json({ message: parsed.message });
    await ref.set({ ...parsed.value, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    audit(req, 'schedule.update', 'schedule', id, prev.data(), parsed.value);
    await markModelDirty({ scheduleIds: [id] });
    res.json({ schedule: scheduleJson(id, parsed.value) });
  } catch (err) {
    res.status(500).json({ message: 'No se pudo guardar el horario.' });
  }
});

router.delete('/api/admin/schedules/:id', auth, canManage, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (isReservedScheduleId(id)) {
      return res.status(400).json({ message: 'El horario Siempre no se puede borrar.' });
    }
    const ref = db.collection(SCHEDULES).doc(id);
    const prev = await ref.get();
    if (!prev.exists) return res.status(404).json({ message: 'No encontramos ese horario.' });
    const used = await db.collection(GROUPS).where('scheduleId', '==', id).limit(1).get();
    if (!used.empty) {
      return res.status(409).json({ message: 'Hay un grupo que usa este horario. Cambiá el grupo antes de borrarlo.' });
    }
    await ref.delete();
    audit(req, 'schedule.delete', 'schedule', id, prev.data(), null);
    await markModelDirty({ scheduleIds: [id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: 'No se pudo borrar el horario.' });
  }
});

// ── Feriados ────────────────────────────────────────────────────────────

router.get('/api/admin/holidays/:year', auth, canManage, async (req, res) => {
  try {
    const parsed = sanitizeHolidayList(req.params.year, []);
    if (!parsed.ok) return res.status(400).json({ message: parsed.message });
    const snap = await db.collection(HOLIDAYS).doc(String(parsed.year)).get();
    const dates = snap.exists && Array.isArray(snap.data().dates) ? snap.data().dates : [];
    res.json({ year: parsed.year, dates, truncated: false });
  } catch (err) {
    res.status(500).json({ message: 'No se pudieron cargar los feriados.' });
  }
});

router.put('/api/admin/holidays/:year', auth, canManage, async (req, res) => {
  try {
    const parsed = sanitizeHolidayList(req.params.year, (req.body && req.body.dates) || []);
    if (!parsed.ok) return res.status(400).json({ message: parsed.message });
    const ref = db.collection(HOLIDAYS).doc(String(parsed.year));
    const prev = await ref.get();
    const before = prev.exists ? (prev.data().dates || []) : [];
    await ref.set({
      year: parsed.year,
      dates: parsed.dates,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    audit(req, 'holiday.update', 'holidays', String(parsed.year), { dates: before }, { dates: parsed.dates });
    const holidaySchedules = await db.collection(SCHEDULES).where('holidayBehavior', 'in', ['deny', 'allow']).limit(50).get();
    await markModelDirty({ scheduleIds: holidaySchedules.docs.map((d) => d.id) });
    res.json({ year: parsed.year, dates: parsed.dates });
  } catch (err) {
    res.status(500).json({ message: 'No se pudieron guardar los feriados.' });
  }
});

router.post('/api/admin/holidays/:year/national', auth, canManage, async (req, res) => {
  try {
    const yearCheck = sanitizeHolidayList(req.params.year, []);
    if (!yearCheck.ok) return res.status(400).json({ message: yearCheck.message });
    const ref = db.collection(HOLIDAYS).doc(String(yearCheck.year));
    const prev = await ref.get();
    const before = prev.exists && Array.isArray(prev.data().dates) ? prev.data().dates : [];
    const dates = mergeHolidayLists(before, nationalHolidays(yearCheck.year));
    await ref.set({
      year: yearCheck.year,
      dates,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    audit(req, 'holiday.load_national', 'holidays', String(yearCheck.year), { dates: before }, { dates });
    const holidaySchedules = await db.collection(SCHEDULES).where('holidayBehavior', 'in', ['deny', 'allow']).limit(50).get();
    await markModelDirty({ scheduleIds: holidaySchedules.docs.map((d) => d.id) });
    res.json({ year: yearCheck.year, dates });
  } catch (err) {
    res.status(500).json({ message: 'No se pudieron cargar los feriados nacionales.' });
  }
});

// ── Grupos ──────────────────────────────────────────────────────────────

router.get('/api/admin/access-groups', auth, canRead, async (_req, res) => {
  try {
    const [snap, doorCtx] = await Promise.all([
      db.collection(GROUPS).orderBy('name').limit(LIST_LIMIT).get(),
      loadDoorContext()
    ]);
    const groups = snap.docs.map((d) => {
      const data = d.data() || {};
      return {
        id: d.id,
        name: data.name || '',
        doors: data.doors === '*' ? '*' : (Array.isArray(data.doors) ? data.doors : []),
        allDoors: data.allDoors === true || data.doors === '*',
        scheduleId: data.scheduleId || ALWAYS_SCHEDULE_ID,
        memberCount: Number(data.memberCount) || 0
      };
    });
    res.json({ groups, doors: doorCtx.doors, truncated: snap.size >= LIST_LIMIT });
  } catch (err) {
    res.status(500).json({ message: 'No se pudieron cargar los grupos.' });
  }
});

router.post('/api/admin/access-groups', auth, canManage, async (req, res) => {
  try {
    const [doorCtx, known] = await Promise.all([loadDoorContext(), scheduleIdsKnown()]);
    const parsed = sanitizeGroupInput(req.body || {}, { doorIds: doorCtx.ids, scheduleIds: known });
    if (!parsed.ok) return res.status(400).json({ message: parsed.message });
    const id = newId('grp');
    const doc = {
      ...parsed.value,
      memberCount: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    await db.collection(GROUPS).doc(id).set(doc);
    audit(req, 'accessGroup.create', 'accessGroup', id, null, parsed.value);
    await markModelDirty({ groupIds: [id] });
    res.status(201).json({ group: { id, ...parsed.value, memberCount: 0 } });
  } catch (err) {
    res.status(500).json({ message: 'No se pudo crear el grupo.' });
  }
});

router.put('/api/admin/access-groups/:id', auth, canManage, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const ref = db.collection(GROUPS).doc(id);
    const prev = await ref.get();
    if (!prev.exists) return res.status(404).json({ message: 'No encontramos ese grupo.' });
    const [doorCtx, known] = await Promise.all([loadDoorContext(), scheduleIdsKnown()]);
    const parsed = sanitizeGroupInput(req.body || {}, { doorIds: doorCtx.ids, scheduleIds: known });
    if (!parsed.ok) return res.status(400).json({ message: parsed.message });
    await ref.set({ ...parsed.value, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    audit(req, 'accessGroup.update', 'accessGroup', id, prev.data(), parsed.value);
    await markModelDirty({ groupIds: [id] });
    const memberCount = Number(prev.data().memberCount) || 0;
    res.json({ group: { id, ...parsed.value, memberCount } });
  } catch (err) {
    res.status(500).json({ message: 'No se pudo guardar el grupo.' });
  }
});

router.delete('/api/admin/access-groups/:id', auth, canManage, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const ref = db.collection(GROUPS).doc(id);
    const prev = await ref.get();
    if (!prev.exists) return res.status(404).json({ message: 'No encontramos ese grupo.' });
    if ((Number(prev.data().memberCount) || 0) > 0) {
      return res.status(409).json({ message: 'Hay personas en este grupo. Sacalas de la ficha antes de borrarlo.' });
    }
    await ref.delete();
    audit(req, 'accessGroup.delete', 'accessGroup', id, prev.data(), null);
    await markModelDirty({ groupIds: [id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: 'No se pudo borrar el grupo.' });
  }
});

// ── Asignación y resumen ────────────────────────────────────────────────

const getDocs = async (refs) => {
  if (!refs.length) return [];
  if (typeof db.getAll === 'function') return db.getAll(...refs);
  return Promise.all(refs.map((r) => r.get()));
};

const todayYmd = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Argentina/Buenos_Aires',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(new Date());

const loadAccessView = async (personId) => {
  const personSnap = await db.collection('people').doc(personId).get();
  if (!personSnap.exists) return null;
  const person = personSnap.data() || {};
  const accessLevels = levelIds(person.accessLevels);
  const accessAll = person.accessAll === true;
  const allowedDoorIds = Array.isArray(person.allowedDoorIds) ? person.allowedDoorIds.map(String) : [];

  const [groupSnaps, authSnap, nominaSnap, doorCtx] = await Promise.all([
    getDocs(accessLevels.map((id) => db.collection(GROUPS).doc(id))),
    db.collection('authorizations').where('personId', '==', personId).limit(40).get(),
    db.collection('personalMaster').where('personId', '==', personId).limit(5).get(),
    loadDoorContext()
  ]);

  const groups = [];
  const scheduleIds = new Set();
  groupSnaps.forEach((snap) => {
    if (!snap.exists) return;
    const data = snap.data() || {};
    const group = {
      id: snap.id,
      name: data.name || snap.id,
      doors: data.doors === '*' ? '*' : (Array.isArray(data.doors) ? data.doors : []),
      scheduleId: data.scheduleId || ALWAYS_SCHEDULE_ID
    };
    groups.push(group);
    if (group.scheduleId && group.scheduleId !== ALWAYS_SCHEDULE_ID) scheduleIds.add(group.scheduleId);
  });
  const schedSnaps = await getDocs([...scheduleIds].map((id) => db.collection(SCHEDULES).doc(id)));
  const schedulesById = new Map();
  schedSnaps.forEach((snap) => {
    if (!snap.exists) return;
    const shaped = toSnapshotSchedule({ id: snap.id, ...snap.data() });
    if (shaped) schedulesById.set(snap.id, { ...shaped, name: (snap.data() || {}).name });
  });
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const doorNamesById = new Map(doorCtx.doors.map((d) => [d.id, d.name]));
  const auths = authSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const today = todayYmd();
  const citedToday = auths.some((a) => a && a.active !== false
    && String(a.type || '').toLowerCase() === 'citacion'
    && String(a.appointmentDate || '').slice(0, 10) === today);
  const employee = nominaSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .find((e) => e.source === 'nomina' && e.active !== false) || null;
  const shift = employee ? resolveShiftSchedule(employee) : null;
  const summary = explainAccess({
    accessLevels,
    accessAll,
    allowedDoorIds,
    groupsById,
    schedulesById,
    doorNamesById,
    auths,
    citedToday,
    needsCitation: employee ? nominaRequiresGrant(employee) : false,
    shift: shift && shift.daysOfWeek ? shift : null
  });
  return {
    id: personId,
    name: person.nombre || person.name || '',
    accessLevels,
    accessAll,
    allowedDoorIds,
    summary
  };
};

router.get('/api/admin/people/:id/access', auth, canAssign, async (req, res) => {
  try {
    const view = await loadAccessView(String(req.params.id));
    if (!view) return res.status(404).json({ message: 'No encontramos a esa persona.' });
    res.json(view);
  } catch (err) {
    res.status(500).json({ message: 'No se pudo cargar el acceso de la persona.' });
  }
});

router.put('/api/admin/people/:id/access', auth, canAssign, async (req, res) => {
  try {
    const personId = String(req.params.id || '');
    const personRef = db.collection('people').doc(personId);
    const body = req.body || {};
    const hasLevels = Object.prototype.hasOwnProperty.call(body, 'accessLevels');
    const hasAll = Object.prototype.hasOwnProperty.call(body, 'accessAll');
    if (!hasLevels && !hasAll) {
      return res.status(400).json({ message: 'No hay cambios para guardar.' });
    }
    if (hasLevels && !Array.isArray(body.accessLevels)) {
      return res.status(400).json({ message: 'Los grupos tienen que ser una lista.' });
    }
    const requested = hasLevels ? levelIds(body.accessLevels) : null;
    if (requested && requested.length > 20) {
      return res.status(400).json({ message: 'Hay demasiados grupos para una persona.' });
    }

    const result = await db.runTransaction(async (tx) => {
      const personSnap = await tx.get(personRef);
      if (!personSnap.exists) {
        const err = new Error('No encontramos a esa persona.');
        err.status = 404;
        throw err;
      }
      const prev = personSnap.data() || {};
      const prevLevels = levelIds(prev.accessLevels);
      const nextLevels = requested || prevLevels;
      const nextAll = hasAll ? body.accessAll === true : prev.accessAll === true;
      const touched = [...new Set([...prevLevels, ...nextLevels])];
      const groupRefs = touched.map((id) => db.collection(GROUPS).doc(id));
      const groupSnaps = [];
      for (const ref of groupRefs) groupSnaps.push(await tx.get(ref));
      const byId = new Map(touched.map((id, i) => [id, { ref: groupRefs[i], snap: groupSnaps[i] }]));
      for (const id of nextLevels) {
        if (!byId.get(id).snap.exists) {
          const err = new Error('Hay un grupo que no existe.');
          err.status = 400;
          throw err;
        }
      }
      const prevSet = new Set(prevLevels);
      const nextSet = new Set(nextLevels);
      for (const id of nextLevels) {
        if (prevSet.has(id)) continue;
        const { ref, snap } = byId.get(id);
        tx.update(ref, { memberCount: (Number(snap.data().memberCount) || 0) + 1 });
      }
      for (const id of prevLevels) {
        if (nextSet.has(id) || !byId.get(id).snap.exists) continue;
        const { ref, snap } = byId.get(id);
        tx.update(ref, { memberCount: Math.max(0, (Number(snap.data().memberCount) || 0) - 1) });
      }
      tx.update(personRef, {
        accessLevels: nextLevels,
        accessAll: nextAll,
        updatedAt: FieldValue.serverTimestamp()
      });
      return {
        before: { accessLevels: prevLevels, accessAll: prev.accessAll === true },
        after: { accessLevels: nextLevels, accessAll: nextAll }
      };
    });

    audit(req, 'person.access.assign', 'person', personId, result.before, result.after);
    await markDirty({ people: [personId] });
    bumpPeopleVersion().catch((err) => console.warn('[accessModel] bumpPeopleVersion', err.message));
    const view = await loadAccessView(personId);
    res.json({
      message: 'Accesos actualizados.',
      ...view
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: status === 500 ? 'No se pudo guardar el acceso.' : err.message });
  }
});

// ── ¿Puede pasar? ───────────────────────────────────────────────────────

router.post('/api/admin/access/simulate', auth, canRead, async (req, res) => {
  try {
    const personId = String((req.body && req.body.personId) || '').trim();
    const doorId = String((req.body && req.body.doorId) || '').trim();
    const at = req.body && (req.body.at != null ? req.body.at : req.body.when);
    if (!personId) return res.status(400).json({ message: 'Elegí una persona.' });
    const personSnap = await db.collection('people').doc(personId).get();
    if (!personSnap.exists) return res.status(404).json({ message: 'No encontramos a esa persona.' });
    const person = personSnap.data() || {};
    if (person.active === false || !String(person.dniNormalized || person.dni || person.idNumber || person.accessCard || '').trim()) {
      const early = simulateAccess({ snap: null, person, personId, doorId, at });
      if (early.status === 200) {
        db.collection('settings').doc('setupProgress').set({
          lastSimulateAt: Date.now()
        }, { merge: true }).catch(() => {});
      }
      return res.status(early.status).json(early.body);
    }
    let snap;
    try {
      snap = await getCloudSnapshot();
    } catch (err) {
      console.error('[accessModel] simulate', err.message);
      return res.status(503).json({ message: 'No se pudo revisar el acceso en este momento.' });
    }
    const result = simulateAccess({ snap, person, personId, doorId, at });
    if (result.status === 200) {
      db.collection('settings').doc('setupProgress').set({
        lastSimulateAt: Date.now()
      }, { merge: true }).catch((err) => console.warn('[accessModel] setupProgress', err.message));
    }
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ message: 'No se pudo simular el ingreso.' });
  }
});

module.exports = router;
