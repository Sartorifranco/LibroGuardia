/**
 * Match de persona para alta/reimport (nómina, citaciones).
 * No filtra active. Ambigüedad → no escribir. El kiosko no usa esto.
 */

const rowFromDoc = (doc) => {
  if (!doc) return null;
  const data = typeof doc.data === 'function' ? (doc.data() || {}) : (doc.data || {});
  return {
    id: doc.id,
    ref: doc.ref || null,
    data
  };
};

const isActive = (data) => data && data.active !== false;

const pickUpsertCandidate = (docs = [], { legajoNormalized, dniNormalized } = {}) => {
  const rows = docs.map(rowFromDoc).filter((row) => row && row.id && !row.data.mergedIntoId);
  if (!rows.length) return { status: 'none' };

  const active = rows.filter((row) => isActive(row.data));
  const inactive = rows.filter((row) => !isActive(row.data));

  if (active.length > 1) {
    return { status: 'ambiguous', reason: 'multiple_active' };
  }
  if (active.length === 1) {
    return { status: 'hit', candidate: active[0] };
  }
  if (inactive.length > 1) {
    return { status: 'ambiguous', reason: 'multiple_inactive' };
  }

  const candidate = inactive[0];
  const cLeg = String(candidate.data.legajoNormalized || candidate.data.legajo || '').trim();
  const cDni = String(
    candidate.data.dniNormalized || candidate.data.idNumberNormalized || ''
  ).trim();
  const wantLeg = String(legajoNormalized || '').trim();
  const wantDni = String(dniNormalized || '').trim();

  if (wantLeg && cLeg && cLeg !== wantLeg) {
    return { status: 'ambiguous', reason: 'legajo_conflict' };
  }
  if (wantDni && cDni && cDni !== wantDni) {
    return { status: 'ambiguous', reason: 'dni_conflict' };
  }

  return { status: 'hit', candidate };
};

const buildReactivationFields = (existing = {}, { wantActive = true, via = 'import', timestamp } = {}) => {
  if (wantActive === false) {
    return { active: false };
  }
  if (existing.active === false) {
    return {
      active: true,
      reactivatedAt: timestamp,
      reactivatedVia: via
    };
  }
  return {};
};

const ambiguousPersonError = (reason) => {
  const err = new Error(
    `Persona ambigua (${reason || 'conflict'}): no se reactiva ni se duplica`
  );
  err.code = 'ambiguous_person';
  err.reason = reason;
  return err;
};

module.exports = {
  rowFromDoc,
  pickUpsertCandidate,
  buildReactivationFields,
  ambiguousPersonError
};
