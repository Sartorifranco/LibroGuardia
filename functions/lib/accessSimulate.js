'use strict';

/**
 * ¿Puede pasar?: corre el motor sobre el snapshot compilado.
 * La hora sin zona se interpreta como Argentina (UTC−3, sin horario de verano).
 */

const { decide } = require('./accessEngine/decide');
const { reasonMessage } = require('./accessEngine/reasons.es');

const parseAt = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const s = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) {
    const ms = Date.parse(`${s}:00.000-03:00`);
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
};

const headlineOf = (decision) => {
  if (decision === 'grant') return 'Sí, puede pasar.';
  if (decision === 'needs_approval') return 'Puede pasar, pero el guardia tiene que autorizarlo.';
  return 'No puede pasar.';
};

const personDni = (person = {}) => String(
  person.dniNormalized || person.idNumberNormalized || person.dni || person.idNumber || ''
).replace(/\D/g, '');

const personCard = (person = {}) => String(person.accessCard || '').trim();

/**
 * @returns {{ status: number, body: object }}
 */
const simulateAccess = ({ snap, person, personId, doorId, at }) => {
  if (!person) return { status: 404, body: { message: 'No encontramos a esa persona.' } };
  const name = person.nombre || person.name || '';
  const door = String(doorId || '').trim();
  if (!door) return { status: 400, body: { message: 'Elegí una puerta.' } };
  const when = parseAt(at);
  if (when == null) return { status: 400, body: { message: 'Elegí fecha y hora.' } };

  const base = {
    person: { id: personId, name },
    door: { id: door, name: door },
    at: new Date(when).toISOString()
  };

  if (person.active === false) {
    return {
      status: 200,
      body: {
        ...base,
        decision: 'deny',
        reason: 'persona_inactiva',
        message: reasonMessage('persona_inactiva'),
        headline: headlineOf('deny'),
        allows: false,
        warnings: []
      }
    };
  }

  const dni = personDni(person);
  const card = personCard(person);
  const credential = dni
    ? { type: 'dni', value: dni }
    : (card ? { type: 'card', value: card } : null);
  if (!credential) {
    return {
      status: 200,
      body: {
        ...base,
        decision: 'deny',
        reason: 'credencial_desconocida',
        message: 'Esta persona no tiene DNI ni tarjeta cargados, así que no se puede simular el ingreso.',
        headline: headlineOf('deny'),
        allows: false,
        warnings: []
      }
    };
  }

  if (!snap || typeof snap.door !== 'function') {
    return { status: 503, body: { message: 'No se pudo revisar el acceso en este momento.' } };
  }

  let groups = [];
  if (typeof snap.interlockGroups === 'function') groups = snap.interlockGroups(door) || [];
  else if (typeof snap.interlockGroup === 'function') groups = [snap.interlockGroup(door)].filter(Boolean);
  const doorStates = {};
  const ids = new Set([door]);
  for (const g of groups) if (Array.isArray(g.doorIds)) g.doorIds.forEach((id) => ids.add(id));
  for (const id of ids) doorStates[id] = { state: 'SEGURA', dps: 'closed', bond: 'engaged' };

  let result;
  try {
    result = decide({
      snap,
      credential,
      doorId: door,
      side: 'in',
      at: when,
      mode: 'scan',
      state: { clockTrusted: true, doorStates, interlock: {} }
    });
  } catch (err) {
    return { status: 400, body: { message: 'No se pudo simular ese ingreso.' } };
  }

  const doorDoc = snap.door(door);
  if (doorDoc && doorDoc.name) base.door.name = doorDoc.name;
  const warnings = (result.warnings || []).map((reason) => ({ reason, message: reasonMessage(reason) }));
  return {
    status: 200,
    body: {
      ...base,
      decision: result.decision,
      reason: result.reason,
      message: result.message || reasonMessage(result.reason),
      headline: headlineOf(result.decision),
      allows: result.decision === 'grant',
      warnings
    }
  };
};

module.exports = { parseAt, simulateAccess, headlineOf };
