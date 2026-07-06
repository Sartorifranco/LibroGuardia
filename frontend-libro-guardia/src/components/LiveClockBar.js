import React from 'react';
import { Clock, Copy } from 'lucide-react';
import { useLiveClock } from '../hooks/useLiveClock';

const TAB_TIME_LABELS = {
  personal: 'personal',
  vehiculo: 'vehículo',
  flota: 'flota',
  novedad: 'novedad',
};

function LiveClockBar({ activeTab, onApplyTime, onCopyTime }) {
  const { timeDisplay, timeInputValue, dateDisplay, shortDateDisplay } = useLiveClock();
  const formTab = TAB_TIME_LABELS[activeTab];

  return (
    <div className="live-clock-bar">
      <div className="live-clock-main">
        <Clock size={22} className="live-clock-icon" aria-hidden />
        <div>
          <div className="live-clock-time" aria-live="polite">{timeDisplay}</div>
          <div className="live-clock-date">{dateDisplay}</div>
        </div>
      </div>
      <div className="live-clock-actions">
        {formTab ? (
          <button
            type="button"
            className="live-clock-btn live-clock-btn-primary"
            onClick={() => onApplyTime(timeInputValue)}
          >
            Usar {timeInputValue} en registro de {formTab}
          </button>
        ) : (
          <span className="live-clock-hint">Seleccione un formulario de registro para cargar la hora automáticamente.</span>
        )}
        <button
          type="button"
          className="live-clock-btn"
          onClick={() => onCopyTime(timeInputValue, shortDateDisplay)}
          title="Copiar hora al portapapeles"
        >
          <Copy size={16} /> Copiar hora
        </button>
      </div>
    </div>
  );
}

export default LiveClockBar;
