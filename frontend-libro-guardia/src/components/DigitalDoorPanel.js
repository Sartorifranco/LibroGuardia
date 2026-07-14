import React from 'react';
import { DoorOpen, Construction } from 'lucide-react';

function DigitalDoorPanel({ profile = 'monitoreo', canManualOpen = false, onManualOpen }) {
  const title = profile === 'guardia'
    ? 'Botonera digital — Portón Guardia'
    : 'Botonera digital — Portón Monitoreo';

  const description = profile === 'guardia'
    ? 'Unidades blindadas, acceso principal a planta y vehículos livianos asignados a este puesto.'
    : 'Vehículos livianos, directivos, clientes y grúas asignados a Monitoreo.';

  return (
    <section className="door-panel-placeholder">
      <div className="door-panel-placeholder__header">
        <DoorOpen size={28} />
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </div>
      <div className="door-panel-placeholder__body">
        <Construction size={22} />
        <p>
          La botonera analógica se migrará a control digital desde aquí.
          Por ahora use el registro de movimientos y, si corresponde, la apertura manual SR201.
        </p>
        {canManualOpen && (
          <button type="button" className="btn btn-secondary" onClick={onManualOpen}>
            Abrir puerta manual (SR201)
          </button>
        )}
      </div>
    </section>
  );
}

export default DigitalDoorPanel;
