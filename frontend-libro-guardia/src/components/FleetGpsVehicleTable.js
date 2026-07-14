import React from 'react';

const STATUS_LABELS = {
  online: 'En línea',
  offline: 'Fuera de línea',
  unknown: 'Sin señal'
};

export const formatDistance = (meters) => {
  if (meters == null || Number.isNaN(Number(meters))) return '—';
  const value = Number(meters);
  if (value < 1000) return `${value} m`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} km`;
};

export const formatFleetTime = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
};

const distanceClass = (meters, radiusMeters) => {
  if (meters == null) return '';
  if (radiusMeters != null && meters <= radiusMeters) {
    if (meters <= 50) return 'fleet-gps-dist fleet-gps-dist--critical';
    return 'fleet-gps-dist fleet-gps-dist--near';
  }
  return 'fleet-gps-dist';
};

const statusClass = (status) => {
  if (status === 'online') return 'fleet-gps-status fleet-gps-status--online';
  if (status === 'offline') return 'fleet-gps-status fleet-gps-status--offline';
  return 'fleet-gps-status fleet-gps-status--unknown';
};

function FleetGpsVehicleTable({
  vehicles = [],
  radiusMeters = null,
  emptyMessage = 'Sin móviles para mostrar',
  compact = false,
  maxHeightClass = 'scroll-panel-max'
}) {
  if (!vehicles.length) {
    return <p className="text-sm text-gray-500">{emptyMessage}</p>;
  }

  return (
    <div className={`${maxHeightClass} overflow-x-auto theme-panel-nested`}>
      <table className={`fleet-gps-table${compact ? ' fleet-gps-table--compact' : ''}`}>
        <thead>
          <tr>
            <th>#</th>
            <th>Móvil</th>
            <th>Patente</th>
            <th>Distancia</th>
            <th>Estado</th>
            <th>Movimiento</th>
          </tr>
        </thead>
        <tbody>
          {vehicles.map((item, index) => (
            <tr
              key={`${item.deviceId || item.id}-${item.distanceMeters}-${index}`}
              className={radiusMeters != null && item.distanceMeters != null && item.distanceMeters <= radiusMeters
                ? 'fleet-gps-row--alert'
                : ''}
            >
              <td className="fleet-gps-rank">{index + 1}</td>
              <td className="fleet-gps-name">{item.name || item.id || '—'}</td>
              <td className="fleet-gps-plate">{item.plate || '—'}</td>
              <td className={distanceClass(item.distanceMeters, radiusMeters)}>
                {formatDistance(item.distanceMeters)}
              </td>
              <td>
                <span className={statusClass(item.status)}>
                  {STATUS_LABELS[item.status] || item.status || '—'}
                </span>
              </td>
              <td className="fleet-gps-motion">
                {item.motion ? 'En movimiento' : item.ignition ? 'Detenido (contacto)' : 'Detenido'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default FleetGpsVehicleTable;
