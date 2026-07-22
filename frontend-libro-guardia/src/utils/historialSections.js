/**
 * Clasificación de entradas del historial y resolución doorId → nombre.
 */

/** Acceso automático por kiosko/lector (o cualquier personal con puerta asociada). */
export const isDoorAccessEntry = (entry = {}) => {
  if (entry.type !== 'personal') return false;
  if (entry.doorId) return true;
  const source = String(entry.entrySource || '').toLowerCase();
  return source === 'kiosk' || source === 'molinete' || source === 'reader';
};

/** Carga manual de personal sin puerta (formulario / excepcional sin doorId). */
export const isManualPersonalEntry = (entry = {}) => {
  if (entry.type !== 'personal') return false;
  return !isDoorAccessEntry(entry);
};

export const HISTORIAL_SECTIONS = [
  {
    id: 'accesos',
    label: 'Accesos por puerta',
    apiType: 'personal',
    match: isDoorAccessEntry,
    exportName: 'accesos_puerta'
  },
  {
    id: 'personal_manual',
    label: 'Personal (manual)',
    apiType: 'personal',
    match: isManualPersonalEntry,
    exportName: 'personal_manual'
  },
  {
    id: 'vehiculo',
    label: 'Vehículos',
    apiType: 'vehiculo',
    match: (e) => e.type === 'vehiculo' && !(e.gpsAuto || e.entrySource === 'gps_ubika'),
    exportName: 'vehiculos'
  },
  {
    id: 'flota',
    label: 'Flota',
    apiType: 'flota',
    match: (e) => e.type === 'flota' || (e.type === 'vehiculo' && (e.gpsAuto || e.entrySource === 'gps_ubika')),
    exportName: 'flota'
  },
  {
    id: 'novedad',
    label: 'Novedades',
    apiType: 'novedad',
    match: (e) => e.type === 'novedad',
    exportName: 'novedades'
  }
];

export const getHistorialSection = (sectionId) =>
  HISTORIAL_SECTIONS.find((s) => s.id === sectionId) || HISTORIAL_SECTIONS[0];

/**
 * @param {object} entry
 * @param {Record<string, string>} [doorNamesById] mapa id → name
 */
export const resolveDoorName = (entry = {}, doorNamesById = {}) => {
  const fromEntry = String(entry.doorName || '').trim();
  if (fromEntry) return fromEntry;
  const id = String(entry.doorId || '').trim();
  if (!id) return 'Sin puerta';
  if (doorNamesById[id]) return doorNamesById[id];
  return id;
};

export const formatDoorAccessPhrase = (entry = {}, doorNamesById = {}) => {
  const name = entry.name || entry.nameSnapshot || 'Persona';
  const verb = entry.movementType === 'egreso' ? 'egresó' : 'ingresó';
  const door = resolveDoorName(entry, doorNamesById);
  return { name, verb, door, phrase: `${name} ${verb} por ${door}` };
};
