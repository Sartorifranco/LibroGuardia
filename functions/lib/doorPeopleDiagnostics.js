/**
 * Diagnóstico de personas asignadas a una puerta vs quién puede pasar ahora
 * (misma lógica que allowlist offline / decidirAcceso).
 */

const { db } = require('../firestore');
const { normalizeDni, buildFullName } = require('./normalize');
const { personToAdminJSON } = require('./peopleProfileUpdate');

const ACCESS_ISSUE_LABELS = {
  dni_vacio: 'Sin DNI / documento',
  dni_duplicado: 'DNI duplicado en esta puerta (otra ficha ya cubre ese documento)',
  persona_inactiva: 'Persona inactiva',
  no_encontrado: 'No se pudo resolver la persona',
  sin_citacion_para_hoy: 'Sin autorización vigente para hoy',
  puerta_no_autorizada: 'Puerta no autorizada en la autorización vigente',
  fuera_de_horario: 'Fuera de horario / ventana de acceso',
  dia_no_habilitado: 'Día no habilitado en su autorización',
  error_interno: 'Error al evaluar acceso',
  denegado: 'No autorizado ahora'
};

const labelForIssue = (code) => ACCESS_ISSUE_LABELS[code] || String(code || 'denegado');

const mapPool = async (items, concurrency, worker) => {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < items.length) {
      const idx = next;
      next += 1;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
};

const splitName = (fullName = '') => {
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { nombre: '', apellido: '' };
  if (parts.length === 1) return { nombre: parts[0], apellido: '' };
  return { apellido: parts[0], nombre: parts.slice(1).join(' ') };
};

/**
 * @returns {Promise<{
 *   doorId: string,
 *   summary: { assigned: number, canPassNow: number, blocked: number, byReason: Record<string, number> },
 *   people: Array<object>
 * }>}
 */
const diagnoseDoorPeople = async (doorId, options = {}) => {
  const id = String(doorId || '').trim();
  if (!id) {
    const err = new Error('doorId es obligatorio');
    err.status = 400;
    throw err;
  }

  const decidirAccesoFn = options.decidirAccesoFn
    || require('../accessControl').decidirAcceso;
  const concurrency = Math.max(1, Number(options.concurrency) || 12);
  const limit = Math.max(1, Number(options.limit) || 500);

  const snap = await db.collection('people')
    .where('allowedDoorIds', 'array-contains', id)
    .limit(limit)
    .get();

  const basePeople = snap.docs.map((doc) => {
    const json = personToAdminJSON(doc);
    const raw = doc.data() || {};
    const dni = normalizeDni(
      raw.dniNormalized
      || raw.dni
      || raw.idNumberNormalized
      || raw.idNumber
      || json.idNumber
      || ''
    );
    return {
      ...json,
      _raw: raw,
      dniNormalized: dni || ''
    };
  });

  // Primer índice por DNI gana para la allowlist (mismo criterio que doorAllowlist).
  const firstIndexByDni = new Map();
  basePeople.forEach((p, idx) => {
    if (!p.dniNormalized) return;
    if (!firstIndexByDni.has(p.dniNormalized)) firstIndexByDni.set(p.dniNormalized, idx);
  });

  const diagnosed = await mapPool(basePeople, concurrency, async (person, idx) => {
    const issues = [];
    let denialReason = null;
    let canPassNow = false;
    let authorizationType = null;

    if (!person.dniNormalized) {
      issues.push({ code: 'dni_vacio', label: labelForIssue('dni_vacio') });
    } else {
      const firstIdx = firstIndexByDni.get(person.dniNormalized);
      if (firstIdx !== idx) {
        issues.push({
          code: 'dni_duplicado',
          label: labelForIssue('dni_duplicado')
        });
      }
    }

    if (person.active === false) {
      issues.push({ code: 'persona_inactiva', label: labelForIssue('persona_inactiva') });
    }

    // Solo evaluar acceso si no es perdedor de DNI duplicado y hay DNI.
    const isDuplicateLoser = issues.some((i) => i.code === 'dni_duplicado');
    if (!isDuplicateLoser && person.dniNormalized) {
      const display = String(person.name || '').trim();
      const { nombre, apellido } = splitName(display);
      const decision = await decidirAccesoFn({
        dni: person.dniNormalized,
        nombre,
        apellido,
        tipoMovimiento: 'ingreso',
        doorId: id,
        resolvedPerson: {
          personId: person.id,
          person: {
            ...person._raw,
            id: person.id,
            active: person.active,
            allowedDoorIds: person.allowedDoorIds,
            name: person.name,
            idNumber: person.idNumber
          },
          dniNormalized: person.dniNormalized,
          nameSnapshot: display || buildFullName(nombre, apellido),
          resolutionPath: 'door_people_diagnostics'
        }
      });

      canPassNow = Boolean(decision?.authorized);
      denialReason = decision?.denialReason || null;
      authorizationType = decision?.authorizationType || null;

      if (!canPassNow) {
        const code = denialReason || 'denegado';
        if (!issues.some((i) => i.code === code)) {
          issues.push({ code, label: labelForIssue(code) });
        }
      }
    }

    if (isDuplicateLoser) {
      canPassNow = false;
    }

    const { _raw, ...publicPerson } = person;
    return {
      ...publicPerson,
      canPassNow,
      denialReason: canPassNow ? null : (denialReason || issues[0]?.code || null),
      authorizationType,
      issues,
      issueLabels: issues.map((i) => i.label)
    };
  });

  const byReason = {};
  let canPassNowCount = 0;
  for (const p of diagnosed) {
    if (p.canPassNow) {
      canPassNowCount += 1;
      continue;
    }
    const codes = p.issues?.length
      ? p.issues.map((i) => i.code)
      : [p.denialReason || 'denegado'];
    for (const code of codes) {
      byReason[code] = (byReason[code] || 0) + 1;
    }
  }

  return {
    doorId: id,
    summary: {
      assigned: diagnosed.length,
      canPassNow: canPassNowCount,
      blocked: diagnosed.length - canPassNowCount,
      byReason
    },
    people: diagnosed,
    note: 'Solo ingresan quienes tengan esta puerta marcada explícitamente y autorización vigente ahora.'
  };
};

module.exports = {
  diagnoseDoorPeople,
  labelForIssue,
  ACCESS_ISSUE_LABELS
};
