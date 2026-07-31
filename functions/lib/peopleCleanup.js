/**
 * Plan de limpieza de people: lista de sugerencias individuales (preview + apply one-by-one).
 */

const {
  loadAllPeople,
  analyzePeopleAlerts,
  isBiostarOrphanRow
} = require('./peopleAlerts');
const {
  findRealDniSuggestions,
  applyCleanupAction
} = require('./peopleRepair');
const { getDoorsConfig } = require('./doorsConfig');
const { normalizeAllowedDoorIds } = require('./doorAccess');
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
 * Arma un plan completo sin escribir. Cada ítem es una sugerencia con botón Aceptar.
 */
const buildCleanupPlan = async () => {
  const people = await loadAllPeople(2500);
  const doorsCfg = await getDoorsConfig().catch(() => ({ doors: [], defaultDoorId: null }));
  const activeDoors = (doorsCfg.doors || []).filter((d) => d.active !== false);
  const activeDoorIds = activeDoors.map((d) => String(d.id).trim()).filter(Boolean);
  const activeDoorCount = activeDoorIds.length;
  const defaultDoorId = doorsCfg.defaultDoorId || activeDoorIds[0] || null;
  const alerts = analyzePeopleAlerts(people, { activeDoorCount });
  const dniSuggestions = await findRealDniSuggestions();

  const merges = [];
  const used = new Set();

  (alerts.biostarSuggestions || []).forEach((s) => {
    if (!s.orphan || !s.candidate) return;
    if (used.has(s.orphan.id) || used.has(s.candidate.id)) return;
    const { keep, merge } = pickCanonical(s.candidate, s.orphan);
    const confidence = s.score >= AUTO_MERGE_MIN ? 'high' : (s.score >= REVIEW_MERGE_MIN ? 'review' : null);
    if (!confidence) return;
    used.add(keep.id);
    used.add(merge.id);
    merges.push({
      id: `merge:${keep.id}:${merge.id}`,
      type: 'merge',
      group: confidence === 'high' ? 'uniones' : 'revisar',
      confidence,
      title: `Unir “${merge.name}” → “${keep.name}”`,
      detail: `Confianza ${Math.round((s.score || 0) * 100)}%. Se conserva la ficha con DNI/legajo; las puertas del huérfano BioStar no se copian.`,
      keepId: keep.id,
      mergeId: merge.id,
      keepName: keep.name,
      mergeName: merge.name,
      keepDni: keep.idNumber || '',
      mergeBio: merge.biometricExternalId || s.orphan.biometricExternalId || '',
      score: s.score,
      doorsPolicy: 'prefer_keep',
      action: {
        type: 'merge',
        keepId: keep.id,
        mergeId: merge.id,
        doorsPolicy: 'prefer_keep'
      }
    });
  });

  (alerts.duplicates || [])
    .filter((d) => d.reason === 'biometric' && (d.people || []).length >= 2)
    .forEach((d) => {
      const [a, b] = d.people;
      if (!a || !b || used.has(a.id) || used.has(b.id)) return;
      const { keep, merge } = pickCanonical(a, b);
      used.add(keep.id);
      used.add(merge.id);
      merges.push({
        id: `merge-bio:${keep.id}:${merge.id}`,
        type: 'merge',
        group: 'uniones',
        confidence: 'high',
        title: `Mismo ID biométrico ${d.key}: conservar “${keep.name}”`,
        detail: `Se fusiona “${merge.name}” en “${keep.name}”.`,
        keepId: keep.id,
        mergeId: merge.id,
        keepName: keep.name,
        mergeName: merge.name,
        keepDni: keep.idNumber || '',
        mergeBio: merge.biometricExternalId || '',
        score: 1,
        doorsPolicy: 'prefer_keep',
        action: {
          type: 'merge',
          keepId: keep.id,
          mergeId: merge.id,
          doorsPolicy: 'prefer_keep'
        }
      });
    });

  // DNI: sugerir DNI real encontrado, o limpiar si no hay
  const dniActions = [];
  const dniHandled = new Set();
  dniSuggestions.forEach((s) => {
    dniHandled.add(s.personId);
    if (s.best) {
      dniActions.push({
        id: `set-dni:${s.personId}:${s.best.dni}`,
        type: 'set_dni',
        group: 'dni',
        confidence: s.best.score >= 0.85 ? 'high' : 'review',
        title: `“${s.personName}”: DNI ${s.badDni} → ${s.best.dni}`,
        detail: `El valor actual parece ${s.looksLikeDate ? 'una fecha' : 'basura'}. Encontré DNI real en ${s.best.sourceLabel}: “${s.best.name}”${s.best.legajo ? ` · legajo ${s.best.legajo}` : ''} (${Math.round(s.best.score * 100)}%).`,
        personId: s.personId,
        personName: s.personName,
        badDni: s.badDni,
        dni: s.best.dni,
        source: s.best.source,
        score: s.best.score,
        alternatives: s.alternatives,
        action: {
          type: 'clear_dni_and_set',
          personId: s.personId,
          dni: s.best.dni,
          source: s.best.source,
          reason: `from_${s.best.source}`
        }
      });
    } else {
      dniActions.push({
        id: `clear-dni:${s.personId}`,
        type: 'clear_dni',
        group: 'dni',
        confidence: 'review',
        title: `“${s.personName}”: limpiar DNI ${s.badDni}`,
        detail: `Parece ${s.looksLikeDate ? 'una fecha' : 'basura'} y no encontré DNI real en nómina/carga inicial con ese nombre. Se vacía el campo para corregirlo a mano.`,
        personId: s.personId,
        personName: s.personName,
        badDni: s.badDni,
        action: {
          type: 'clear_dni',
          personId: s.personId
        }
      });
    }
  });

  // Sospechosos sin pasar por findRealDni (compartidos 3+) ya cubiertos arriba si son suspicious
  (alerts.suspiciousDnis || []).forEach((g) => {
    (g.people || []).forEach((p) => {
      if (dniHandled.has(p.id)) return;
      dniActions.push({
        id: `clear-dni:${p.id}`,
        type: 'clear_dni',
        group: 'dni',
        confidence: 'review',
        title: `“${p.name}”: limpiar DNI ${g.key}`,
        detail: g.message || 'DNI sospechoso o compartido.',
        personId: p.id,
        personName: p.name,
        badDni: g.key,
        action: { type: 'clear_dni', personId: p.id }
      });
    });
  });

  // Puertas: acceso a TODAS las puertas activas
  const doorActions = [];
  if (activeDoorCount >= 2) {
    people.forEach((p) => {
      if (p.active === false) return;
      const doors = normalizeAllowedDoorIds(p.allowedDoorIds);
      if (doors.length < activeDoorCount) return;
      if (!activeDoorIds.every((id) => doors.includes(id))) return;

      const isOrphan = isBiostarOrphanRow(p);
      if (isOrphan && defaultDoorId) {
        doorActions.push({
          id: `doors-orphan:${p.id}`,
          type: 'set_doors',
          group: 'puertas',
          confidence: 'high',
          title: `“${p.name}” (BioStar sin nómina): solo ${defaultDoorId}`,
          detail: `Hoy tiene todas las puertas (${doors.join(', ')}). Personal solo en huella no debería figurar en todas. Se deja solo la puerta del lector BioStar.`,
          personId: p.id,
          personName: p.name,
          before: doors,
          after: [defaultDoorId],
          action: {
            type: 'set_doors',
            personId: p.id,
            doors: [defaultDoorId],
            reason: 'biostar_orphan_all_doors',
            note: `biostar_orphan_single:${defaultDoorId}`
          }
        });
      } else {
        doorActions.push({
          id: `doors-clear:${p.id}`,
          type: 'set_doors',
          group: 'puertas',
          confidence: 'review',
          title: `“${p.name}”: quitar acceso a todas las puertas`,
          detail: `Hoy tiene las ${doors.length} puertas activas (${doors.join(', ')}). Eso viene de una migración vieja (vacío = todas). Ahora vacío = ninguna. Se dejan sin puertas hasta asignarlas a propósito.`,
          personId: p.id,
          personName: p.name,
          before: doors,
          after: [],
          altDoors: defaultDoorId ? [defaultDoorId] : [],
          action: {
            type: 'set_doors',
            personId: p.id,
            doors: [],
            reason: 'had_all_doors_clear',
            note: 'all_doors_clear'
          }
        });
      }
    });
  }

  // Huérfanos BioStar con >1 puerta pero no "todas" (por si hay 3+ puertas)
  people.forEach((p) => {
    if (p.active === false || !isBiostarOrphanRow(p) || !defaultDoorId) return;
    const doors = normalizeAllowedDoorIds(p.allowedDoorIds);
    if (doors.length <= 1 && doors[0] === defaultDoorId) return;
    if (doors.length >= activeDoorCount && activeDoorCount >= 2) return; // ya cubierto
    if (doors.length === 0) return;
    if (doors.length === 1 && doors[0] !== defaultDoorId) {
      doorActions.push({
        id: `doors-orphan-wrong:${p.id}`,
        type: 'set_doors',
        group: 'puertas',
        confidence: 'review',
        title: `“${p.name}” (BioStar): cambiar a ${defaultDoorId}`,
        detail: `Tiene ${doors.join(', ')}. Sugerido: solo la puerta del lector.`,
        personId: p.id,
        personName: p.name,
        before: doors,
        after: [defaultDoorId],
        action: {
          type: 'set_doors',
          personId: p.id,
          doors: [defaultDoorId],
          reason: 'biostar_orphan_wrong_door',
          note: `biostar_orphan_single:${defaultDoorId}`
        }
      });
    } else if (doors.length > 1) {
      doorActions.push({
        id: `doors-orphan-multi:${p.id}`,
        type: 'set_doors',
        group: 'puertas',
        confidence: 'high',
        title: `“${p.name}” (BioStar sin nómina): solo ${defaultDoorId}`,
        detail: `Tiene varias puertas (${doors.join(', ')}). Se deja solo el lector BioStar.`,
        personId: p.id,
        personName: p.name,
        before: doors,
        after: [defaultDoorId],
        action: {
          type: 'set_doors',
          personId: p.id,
          doors: [defaultDoorId],
          reason: 'biostar_orphan_multi',
          note: `biostar_orphan_single:${defaultDoorId}`
        }
      });
    }
  });

  const remainingOrphans = people.filter((p) =>
    p.active !== false && isBiostarOrphanRow(p) && !used.has(p.id)
  );

  const suggestions = [...merges, ...dniActions, ...doorActions];

  return {
    defaultDoorId,
    activeDoorCount,
    activeDoorIds,
    suggestions,
    groups: {
      uniones: suggestions.filter((s) => s.group === 'uniones'),
      revisar: suggestions.filter((s) => s.group === 'revisar'),
      dni: suggestions.filter((s) => s.group === 'dni'),
      puertas: suggestions.filter((s) => s.group === 'puertas')
    },
    remainingBiostarOrphans: remainingOrphans.slice(0, 80).map((p) => ({
      id: p.id,
      name: p.name,
      biometricExternalId: p.biometricExternalId || '',
      doors: p.allowedDoorIds || []
    })),
    // Compat con UI vieja (bulk)
    safe: {
      autoMerges: merges.filter((m) => m.confidence === 'high'),
      clearSuspiciousDnis: {
        count: dniActions.filter((d) => d.type === 'clear_dni').length,
        groups: (alerts.suspiciousDnis || []).map((g) => ({
          dni: g.key,
          message: g.message,
          count: (g.people || []).length,
          names: (g.people || []).slice(0, 8).map((p) => p.name)
        }))
      },
      repairBiostarDoors: {
        doorId: defaultDoorId,
        count: doorActions.filter((d) => String(d.id).startsWith('doors-orphan')).length,
        sample: doorActions.filter((d) => String(d.id).startsWith('doors-orphan')).slice(0, 15)
      }
    },
    review: {
      merges: merges.filter((m) => m.confidence === 'review'),
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
      })),
      dniSuggestions
    },
    summary: {
      people: people.length,
      suggestions: suggestions.length,
      uniones: merges.filter((m) => m.confidence === 'high').length,
      revisar: merges.filter((m) => m.confidence === 'review').length,
      dni: dniActions.length,
      puertas: doorActions.length,
      remainingOrphans: remainingOrphans.length,
      allDoorsPeople: (alerts.allDoorsPeople || []).length
    }
  };
};

/**
 * Aplica una sola sugerencia (o varias explícitas).
 */
const applyCleanupActions = async (actions = []) => {
  const list = Array.isArray(actions) ? actions : [];
  if (!list.length) {
    const err = new Error('Indicá al menos una acción');
    err.status = 400;
    throw err;
  }
  const report = {
    applied: 0,
    errors: [],
    results: []
  };
  for (const action of list) {
    try {
      const result = await applyCleanupAction(action);
      report.applied += 1;
      report.results.push(result);
    } catch (err) {
      report.errors.push({
        action,
        message: err.message
      });
    }
  }
  const after = await buildCleanupPlan();
  return { report, planAfter: after };
};

/**
 * Compat: applyCleanupPlan antiguo (bulk). Preferir applyCleanupActions.
 */
const applyCleanupPlan = async ({
  clearSuspiciousDnis = true,
  repairBiostarDoors = true,
  applyAutoMerges = true,
  extraMerges = [],
  biostarDoorMode = 'single',
  repairAllDoors = false
} = {}) => {
  const plan = await buildCleanupPlan();
  const actions = [];

  if (applyAutoMerges) {
    plan.groups.uniones
      .filter((s) => s.type === 'merge')
      .forEach((s) => actions.push(s.action));
  }
  (extraMerges || []).forEach((m) => {
    if (m?.keepId && m?.mergeId) {
      actions.push({ type: 'merge', keepId: m.keepId, mergeId: m.mergeId, doorsPolicy: 'prefer_keep' });
    }
  });
  if (clearSuspiciousDnis) {
    plan.groups.dni.forEach((s) => actions.push(s.action));
  }
  if (repairBiostarDoors) {
    plan.groups.puertas
      .filter((s) => String(s.id).startsWith('doors-orphan'))
      .forEach((s) => {
        if (biostarDoorMode === 'clear') {
          actions.push({ type: 'set_doors', personId: s.personId, doors: [], note: 'clear_biostar_orphan_doors' });
        } else {
          actions.push(s.action);
        }
      });
  }
  if (repairAllDoors) {
    plan.groups.puertas
      .filter((s) => String(s.id).startsWith('doors-clear'))
      .forEach((s) => actions.push(s.action));
  }

  const { report, planAfter } = await applyCleanupActions(actions);
  return {
    report: {
      clearedDnis: report.results.filter((r) => r.type === 'clear_dni' || r.type === 'clear_dni_and_set' || r.type === 'set_dni').length,
      repairedDoors: report.results.filter((r) => r.type === 'set_doors').length,
      merged: report.results.filter((r) => r.type === 'merge').length,
      mergeErrors: report.errors,
      applied: report.applied,
      doorId: plan.defaultDoorId
    },
    planBefore: plan.summary,
    planAfter: planAfter.summary,
    review: planAfter.review
  };
};

module.exports = {
  buildCleanupPlan,
  applyCleanupPlan,
  applyCleanupActions,
  AUTO_MERGE_MIN,
  REVIEW_MERGE_MIN,
  scorePersonNameMatch
};
