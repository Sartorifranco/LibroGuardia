/**
 * Plan de limpieza de people: preview + apply en lote (lo seguro).
 */

const { mergePeople } = require('./peopleMerge');
const {
  loadAllPeople,
  analyzePeopleAlerts,
  isBiostarOrphanRow
} = require('./peopleAlerts');
const {
  repairBiostarOrphanDoors,
  clearSuspiciousSharedDnis
} = require('./peopleRepair');
const { getDoorsConfig } = require('./doorsConfig');
const { scorePersonNameMatch } = require('./personIdentity');

const AUTO_MERGE_MIN = 0.78;
const REVIEW_MERGE_MIN = 0.62;

const pickCanonical = (a, b) => {
  const score = (p) => {
    let s = 0;
    if (String(p.idNumber || '').trim() && !/^(19|20)\d{6}$/.test(String(p.idNumber))) s += 5;
    if (String(p.legajo || '').trim()) s += 4;
    if (p.source !== 'biostar') s += 2;
    if (String(p.biometricExternalId || '').trim()) s += 1;
    if (String(p.name || '').split(/\s+/).filter((t) => t.length > 1).length >= 2) s += 1;
    return s;
  };
  return score(a) >= score(b) ? { keep: a, merge: b } : { keep: b, merge: a };
};

/**
 * Arma un plan completo sin escribir.
 */
const buildCleanupPlan = async () => {
  const people = await loadAllPeople(2500);
  const doorsCfg = await getDoorsConfig().catch(() => ({ doors: [], defaultDoorId: null }));
  const activeDoors = (doorsCfg.doors || []).filter((d) => d.active !== false);
  const activeDoorCount = activeDoors.length;
  const defaultDoorId = doorsCfg.defaultDoorId || activeDoors[0]?.id || null;
  const alerts = analyzePeopleAlerts(people, { activeDoorCount });

  const autoMerges = [];
  const reviewMerges = [];
  const used = new Set();

  (alerts.biostarSuggestions || []).forEach((s) => {
    if (!s.orphan || !s.candidate) return;
    if (used.has(s.orphan.id) || used.has(s.candidate.id)) return;
    const { keep, merge } = pickCanonical(s.candidate, s.orphan);
    const row = {
      keepId: keep.id,
      mergeId: merge.id,
      keepName: keep.name,
      mergeName: merge.name,
      keepDni: keep.idNumber || '',
      mergeBio: merge.biometricExternalId || s.orphan.biometricExternalId || '',
      score: s.score,
      message: s.message || `Unir “${merge.name}” → “${keep.name}”`,
      doorsPolicy: 'prefer_keep'
    };
    used.add(keep.id);
    used.add(merge.id);
    if (s.score >= AUTO_MERGE_MIN) autoMerges.push(row);
    else if (s.score >= REVIEW_MERGE_MIN) reviewMerges.push(row);
  });

  // Duplicados biométricos: unir en la ficha más completa
  (alerts.duplicates || [])
    .filter((d) => d.reason === 'biometric' && (d.people || []).length >= 2)
    .forEach((d) => {
      const [a, b] = d.people;
      if (!a || !b || used.has(a.id) || used.has(b.id)) return;
      const { keep, merge } = pickCanonical(a, b);
      used.add(keep.id);
      used.add(merge.id);
      autoMerges.push({
        keepId: keep.id,
        mergeId: merge.id,
        keepName: keep.name,
        mergeName: merge.name,
        keepDni: keep.idNumber || '',
        mergeBio: merge.biometricExternalId || '',
        score: 1,
        message: `Mismo ID biométrico ${d.key}: conservar “${keep.name}”`,
        doorsPolicy: 'prefer_keep'
      });
    });

  const biostarOrphans = people.filter((p) => p.active !== false && isBiostarOrphanRow(p));
  const orphansNeedingDoorFix = biostarOrphans.filter((p) => {
    const doors = p.allowedDoorIds || [];
    if (doors.length === 0) return false;
    if (defaultDoorId && doors.length === 1 && doors[0] === defaultDoorId) return false;
    return doors.length >= 1;
  });

  const remainingOrphans = biostarOrphans.filter((p) => !used.has(p.id));

  return {
    defaultDoorId,
    activeDoorCount,
    safe: {
      clearSuspiciousDnis: {
        count: (alerts.suspiciousDnis || []).reduce((n, g) => n + (g.people || []).length, 0),
        groups: (alerts.suspiciousDnis || []).map((g) => ({
          dni: g.key,
          message: g.message,
          count: (g.people || []).length,
          names: (g.people || []).slice(0, 8).map((p) => p.name)
        }))
      },
      repairBiostarDoors: {
        doorId: defaultDoorId,
        count: orphansNeedingDoorFix.length,
        sample: orphansNeedingDoorFix.slice(0, 15).map((p) => ({
          id: p.id,
          name: p.name,
          doors: p.allowedDoorIds || []
        }))
      },
      autoMerges
    },
    review: {
      merges: reviewMerges,
      remainingBiostarOrphans: remainingOrphans.slice(0, 80).map((p) => ({
        id: p.id,
        name: p.name,
        biometricExternalId: p.biometricExternalId || '',
        doors: p.allowedDoorIds || []
      })),
      peopleWithAllDoors: (alerts.allDoorsPeople || []).slice(0, 80).map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        source: p.source,
        idNumber: p.idNumber || '',
        doors: p.allowedDoorIds || []
      }))
    },
    summary: {
      people: people.length,
      safeActions:
        (orphansNeedingDoorFix.length > 0 ? 1 : 0)
        + ((alerts.suspiciousDnis || []).length > 0 ? 1 : 0)
        + autoMerges.length,
      autoMerges: autoMerges.length,
      reviewMerges: reviewMerges.length,
      suspiciousDniRows: (alerts.suspiciousDnis || []).reduce((n, g) => n + (g.people || []).length, 0),
      biostarDoorFixes: orphansNeedingDoorFix.length,
      remainingOrphans: remainingOrphans.length
    }
  };
};

/**
 * Aplica el paquete "seguro" (y merges opcionales de review que mande el cliente).
 */
const applyCleanupPlan = async ({
  clearSuspiciousDnis = true,
  repairBiostarDoors = true,
  applyAutoMerges = true,
  extraMerges = [],
  biostarDoorMode = 'single'
} = {}) => {
  const plan = await buildCleanupPlan();
  const report = {
    clearedDnis: 0,
    repairedDoors: 0,
    merged: 0,
    mergeErrors: [],
    doorId: plan.defaultDoorId
  };

  if (clearSuspiciousDnis && plan.safe.clearSuspiciousDnis.count > 0) {
    const r = await clearSuspiciousSharedDnis();
    report.clearedDnis = r.updated;
  }

  if (repairBiostarDoors && plan.safe.repairBiostarDoors.count > 0) {
    const r = await repairBiostarOrphanDoors({
      mode: biostarDoorMode === 'clear' ? 'clear' : 'single',
      doorId: plan.defaultDoorId
    });
    report.repairedDoors = r.updated;
  }

  const merges = [];
  if (applyAutoMerges) merges.push(...plan.safe.autoMerges);
  (extraMerges || []).forEach((m) => {
    if (m?.keepId && m?.mergeId) merges.push({ ...m, doorsPolicy: 'prefer_keep' });
  });

  const seen = new Set();
  for (const m of merges) {
    const key = `${m.keepId}->${m.mergeId}`;
    if (seen.has(key) || seen.has(`${m.mergeId}->${m.keepId}`)) continue;
    seen.add(key);
    try {
      await mergePeople(m.keepId, m.mergeId, {
        doorsPolicy: m.doorsPolicy || 'prefer_keep'
      });
      report.merged += 1;
    } catch (err) {
      report.mergeErrors.push({
        keepId: m.keepId,
        mergeId: m.mergeId,
        message: err.message
      });
    }
  }

  const after = await buildCleanupPlan();
  return { report, planBefore: plan.summary, planAfter: after.summary, review: after.review };
};

module.exports = {
  buildCleanupPlan,
  applyCleanupPlan,
  AUTO_MERGE_MIN,
  REVIEW_MERGE_MIN,
  scorePersonNameMatch
};
