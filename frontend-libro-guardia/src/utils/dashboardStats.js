function isSameLocalDay(dateA, dateB) {
  return (
    dateA.getFullYear() === dateB.getFullYear()
    && dateA.getMonth() === dateB.getMonth()
    && dateA.getDate() === dateB.getDate()
  );
}

export function getDashboardStats(entries, referenceDate = new Date()) {
  const todayEntries = (entries || []).filter((entry) => {
    const ts = new Date(entry.timestamp);
    return isSameLocalDay(ts, referenceDate);
  });

  const countBy = (predicate) => todayEntries.filter(predicate).length;

  return {
    totalToday: todayEntries.length,
    personalIngresos: countBy((e) => e.type === 'personal' && e.movementType === 'ingreso'),
    personalEgresos: countBy((e) => e.type === 'personal' && e.movementType === 'egreso'),
    vehiculos: countBy((e) => e.type === 'vehiculo'),
    flota: countBy((e) => e.type === 'flota'),
    novedades: countBy((e) => e.type === 'novedad'),
    recentEntries: (entries || []).slice(0, 8),
  };
}

export function formatEntryRow(entry) {
  const date = new Date(entry.timestamp);
  let typeDisplay = '';
  let mainDetail = '';

  if (entry.type === 'personal') {
    typeDisplay = entry.movementType === 'ingreso' ? 'Ingreso personal' : 'Egreso personal';
    mainDetail = entry.name;
  } else if (entry.type === 'vehiculo') {
    const gpsTag = entry.gpsAuto || entry.entrySource === 'gps_ubika' ? ' GPS' : '';
    typeDisplay = entry.movementType === 'ingreso'
      ? `Ingreso vehículo${gpsTag}`
      : `Egreso vehículo${gpsTag}`;
    mainDetail = entry.gpsName || entry.plate;
  } else if (entry.type === 'flota') {
    typeDisplay = entry.movementType || 'Movimiento flota';
    mainDetail = `${entry.mobile || '—'} / ${entry.flotaDriver || '—'}`;
  } else if (entry.type === 'novedad') {
    typeDisplay = 'Novedad';
    const desc = entry.description || '';
    mainDetail = desc.length > 60 ? `${desc.slice(0, 60)}…` : desc;
  } else {
    typeDisplay = entry.type || 'Registro';
    mainDetail = '—';
  }

  return {
    id: entry._id,
    typeDisplay,
    mainDetail,
    eventTime: entry.eventTime || '—',
    dateLabel: date.toLocaleDateString('es-AR'),
    registeredBy: entry.registeredByUsername || '—',
  };
}
