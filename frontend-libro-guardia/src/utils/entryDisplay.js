export const isGpsFleetEntry = (entry = {}) =>
  Boolean(entry.gpsAuto || entry.entrySource === 'gps_ubika');

/** Registros GPS antiguos quedaron como type vehiculo; se tratan como flota interna. */
export const getEffectiveEntryType = (entry = {}) => {
  if (entry.type === 'vehiculo' && isGpsFleetEntry(entry)) return 'flota';
  return entry.type;
};

export const entryMatchesTypeFilter = (entry, filter) =>
  filter === 'todos' || getEffectiveEntryType(entry) === filter;

const formatTimeField = (value) => {
  if (!value) return 'N/A';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
};

const FLOTA_MOVEMENT_LABELS = {
  ingreso: 'INGRESO Flota Interna',
  egreso: 'EGRESO Flota Interna',
  'ingreso auxilio': 'INGRESO Auxilio Flota Interna',
  'egreso auxilio': 'EGRESO Auxilio Flota Interna'
};

export const formatFlotaTypeDisplay = (entry = {}) => {
  const base = FLOTA_MOVEMENT_LABELS[entry.movementType] || 'Flota Interna';
  return isGpsFleetEntry(entry) ? base.replace('Flota Interna', 'Flota Interna (GPS)') : base;
};

export const formatFlotaEntryDetails = (entry = {}) => {
  if (isGpsFleetEntry(entry)) {
    return [
      entry.mobile || entry.gpsVehicleLabel || entry.gpsName || entry.brand || 'N/A',
      entry.flotaDriver || entry.driver || 'Sin chofer (GPS)',
      entry.plate || 'N/A',
      formatTimeField(entry.actualTime || entry.timestamp)
    ];
  }
  return [
    entry.mobile || 'N/A',
    entry.flotaDriver || 'N/A',
    formatTimeField(entry.scheduledTime),
    formatTimeField(entry.actualTime)
  ];
};

export const formatVehiculoTypeDisplay = (entry = {}) => {
  const prefix = entry.movementType === 'ingreso' ? 'INGRESO' : 'EGRESO';
  return `${prefix} Vehículo Externo`;
};

export const formatVehiculoEntryDetails = (entry = {}) => [
  entry.plate || 'N/A',
  entry.brand || 'N/A',
  entry.company || 'N/A',
  entry.driver || 'N/A'
];

export const getEntryTableDisplay = (entry = {}) => {
  const type = getEffectiveEntryType(entry);

  if (type === 'personal') {
    return {
      typeDisplay: entry.movementType === 'ingreso' ? 'INGRESO Personal' : 'EGRESO Personal',
      specificDetails: [
        entry.name,
        entry.idNumber,
        entry.company || 'N/A',
        entry.destination || 'N/A'
      ]
    };
  }

  if (type === 'vehiculo') {
    return {
      typeDisplay: formatVehiculoTypeDisplay(entry),
      specificDetails: formatVehiculoEntryDetails(entry)
    };
  }

  if (type === 'flota') {
    return {
      typeDisplay: formatFlotaTypeDisplay(entry),
      specificDetails: formatFlotaEntryDetails(entry)
    };
  }

  if (type === 'novedad') {
    return {
      typeDisplay: 'NOVEDAD',
      specificDetails: [entry.description, '', '', '']
    };
  }

  return { typeDisplay: entry.type || '', specificDetails: ['', '', '', ''] };
};
