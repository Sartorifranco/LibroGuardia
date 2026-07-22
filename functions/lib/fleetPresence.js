/**
 * Presencia de flota (adentro/afuera) según último movimiento registrado.
 * Criterio análogo a inferMovementTypeForToday: el último movementType
 * ingreso|egreso define el estado actual del móvil.
 */

const normalizeMobileKey = (value = '') =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');

const isFlotaLikeEntry = (entry = {}) => {
  if (entry.type === 'flota') return true;
  if (entry.type === 'vehiculo' && (entry.gpsAuto || entry.entrySource === 'gps_ubika')) return true;
  return false;
};

const entryMobileKey = (entry = {}) =>
  normalizeMobileKey(entry.mobile || entry.plate || entry.gpsVehicleLabel || entry.gpsName || '');

/**
 * @param {{ mobiles?: Array<{id?:string,name?:string,plate?:string}>, entries?: object[] }} input
 *   entries deben venir ordenados por timestamp desc (más reciente primero).
 */
const computeFleetPresence = ({ mobiles = [], entries = [] } = {}) => {
  const lastByKey = new Map();
  for (const entry of entries) {
    if (!isFlotaLikeEntry(entry)) continue;
    const key = entryMobileKey(entry);
    if (!key || lastByKey.has(key)) continue;
    const mt = String(entry.movementType || entry.tipoMovimiento || '').toLowerCase();
    if (mt !== 'ingreso' && mt !== 'egreso') continue;
    lastByKey.set(key, {
      movementType: mt,
      timestamp: entry.timestamp || entry.actualTime || entry.eventTime || null,
      entryId: entry.id || null,
      mobileLabel: entry.mobile || entry.plate || entry.gpsName || key
    });
  }

  const catalog = Array.isArray(mobiles) && mobiles.length
    ? mobiles
    : [...lastByKey.entries()].map(([key, last]) => ({
      id: key,
      name: last.mobileLabel,
      plate: ''
    }));

  const seen = new Set();
  const details = [];
  let inside = 0;
  let outside = 0;
  let unknown = 0;

  for (const mobile of catalog) {
    const keys = [
      normalizeMobileKey(mobile.name),
      normalizeMobileKey(mobile.plate),
      normalizeMobileKey(mobile.id)
    ].filter(Boolean);
    const uniqueKeys = [...new Set(keys)];
    if (!uniqueKeys.length) continue;

    const primary = uniqueKeys[0];
    if (seen.has(primary)) continue;
    uniqueKeys.forEach((k) => seen.add(k));

    let last = null;
    for (const k of uniqueKeys) {
      if (lastByKey.has(k)) {
        last = lastByKey.get(k);
        break;
      }
    }

    let state = 'outside';
    if (!last) {
      state = 'outside';
      outside += 1;
    } else if (last.movementType === 'ingreso') {
      state = 'inside';
      inside += 1;
    } else if (last.movementType === 'egreso') {
      state = 'outside';
      outside += 1;
    } else {
      state = 'unknown';
      unknown += 1;
    }

    details.push({
      id: mobile.id || primary,
      name: mobile.name || last?.mobileLabel || primary,
      plate: mobile.plate || '',
      state,
      lastMovementType: last?.movementType || null,
      lastAt: last?.timestamp || null
    });
  }

  // Móviles vistos en entries pero no en catálogo
  for (const [key, last] of lastByKey.entries()) {
    if (seen.has(key)) continue;
    seen.add(key);
    const state = last.movementType === 'ingreso' ? 'inside' : 'outside';
    if (state === 'inside') inside += 1;
    else outside += 1;
    details.push({
      id: key,
      name: last.mobileLabel,
      plate: '',
      state,
      lastMovementType: last.movementType,
      lastAt: last.timestamp
    });
  }

  return {
    inside,
    outside,
    unknown,
    total: inside + outside + unknown,
    mobiles: details,
    queriedAt: new Date().toISOString()
  };
};

module.exports = {
  normalizeMobileKey,
  isFlotaLikeEntry,
  entryMobileKey,
  computeFleetPresence
};
