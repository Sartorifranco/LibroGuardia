/**
 * Un movimiento de flota GPS se marca con gpsAuto y/o entrySource `gps_<proveedor>`.
 * UBIKA sigue usando `gps_ubika` (datos ya grabados en producción).
 */
const isGpsFleetEntry = (entry = {}) => {
  if (entry.gpsAuto) return true;
  const source = String(entry.entrySource || '');
  return source === 'gps_ubika' || source.startsWith('gps_');
};

const gpsEntrySourceForProvider = (providerId = 'ubika') => {
  const id = String(providerId || 'ubika').trim().toLowerCase() || 'ubika';
  if (id === 'ubika') return 'gps_ubika';
  return `gps_${id}`;
};

module.exports = {
  isGpsFleetEntry,
  gpsEntrySourceForProvider
};
