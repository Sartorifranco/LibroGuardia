'use strict';

/**
 * Antipassback blando del hub (no bloquea: el paso ya fue concedido en el controlador).
 *
 * Al ingerir un paso concedido, antes de actualizar la presencia:
 *  - egreso hacia el exterior sin ingreso registrado → warning `egreso_sin_ingreso`
 *    y alerta `posible_colado` (severidad media);
 *  - ingreso de alguien que ya figura en un área interior → warning `ingreso_duplicado`
 *    (solo queda en el evento, sin alerta).
 *
 * Un movimiento entre dos áreas interiores (estanco → planta) no es ingreso duplicado.
 * `apbMode: 'off'` no evalúa. Sin áreas en la puerta, no hay nada que comparar.
 */

const EMPTY = Object.freeze({ warnings: [], alert: null });

function exteriorArea(areaId, isExterior) {
  if (!areaId || areaId === 'exterior') return true;
  return typeof isExterior === 'function' && isExterior(areaId) === true;
}

/** Clave de presencia del evento (persona o pase). */
function passageKey(event) {
  if (!event) return null;
  if (event.cardholderId) return String(event.cardholderId);
  const pass = event.payload && event.payload.stateEffects && event.payload.stateEffects.pass;
  if (pass && pass.id) return `pass:${pass.id}`;
  if (event.payload && event.payload.passId) return `pass:${event.payload.passId}`;
  const presence = event.payload && event.payload.stateEffects && event.payload.stateEffects.presence;
  if (presence && typeof presence === 'object') {
    const keys = Object.keys(presence);
    if (keys.length === 1) return keys[0];
  }
  return null;
}

/**
 * @param {object} p
 * @param {'off'|'soft'|'hard'} [p.mode='soft']
 * @param {object} p.event
 * @param {object|null} [p.door]
 * @param {string|null} [p.currentAreaId]  área donde figura ahora (null = sin ingreso)
 * @param {(areaId:string)=>boolean} [p.isExterior]
 * @param {string|null} [p.personName]
 * @param {string|null} [p.doorName]
 * @returns {{warnings:string[], alert:object|null}}
 */
function evaluateSoftApb({
  mode = 'soft',
  event,
  door = null,
  currentAreaId = null,
  isExterior = null,
  personName = null,
  doorName = null
}) {
  if (mode === 'off') return EMPTY;
  if (!event || (event.type !== 'access' && event.type !== 'passage') || event.decision !== 'grant') return EMPTY;

  const key = passageKey(event);
  if (!key) return EMPTY;

  let zoneFrom;
  let zoneTo;
  let zoned = false;
  const sides = door && door.sides;
  const sideDef = sides && !Array.isArray(sides) ? sides[event.side] : null;
  if (sideDef && ('zoneTo' in sideDef || 'zoneFrom' in sideDef)) {
    zoned = true;
    zoneFrom = sideDef.zoneFrom || null;
    zoneTo = sideDef.zoneTo || null;
  }
  const fx = event.payload && event.payload.stateEffects && event.payload.stateEffects.presence;
  if (fx && fx[key] && Object.prototype.hasOwnProperty.call(fx[key], 'areaId')) {
    zoneTo = fx[key].areaId || null;
    zoned = true;
  }
  if (!zoned) return EMPTY;

  const warnings = [];
  let alert = null;
  const ts = Number(event.ts) || null;
  if (exteriorArea(zoneTo, isExterior)) {
    if (!currentAreaId) {
      warnings.push('egreso_sin_ingreso');
      alert = {
        type: 'posible_colado',
        severity: 'media',
        name: personName || null,
        doorId: event.doorId || null,
        doorName: doorName || event.doorId || null,
        ts,
        cardholderId: key
      };
    }
  } else if (currentAreaId && !exteriorArea(currentAreaId, isExterior)) {
    const fromOutside = exteriorArea(zoneFrom, isExterior);
    if (fromOutside || currentAreaId === zoneTo) warnings.push('ingreso_duplicado');
  }
  if (!warnings.length && !alert) return EMPTY;
  return { warnings, alert };
}

module.exports = { evaluateSoftApb, passageKey, exteriorArea };
