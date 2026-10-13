import React from 'react';
import { DURACION_OPCIONES, MAX_MES_DAYS } from '../utils/visitaDuracion';

/**
 * ¿Cuánto dura el pase? Cuatro tarjetas grandes y los campos de fecha/hora que pide cada una.
 * `value` tiene la forma de duracionFormFrom (utils/visitaDuracion.js).
 */
function VisitaDuracionPicker({ value, onChange, disabled = false, idPrefix = 'dur' }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const { duracion } = value;
  const isMes = duracion === 'mes';
  const conHora = duracion === 'un_ingreso' || duracion === 'horas';

  return (
    <div className="visita-duracion empleado-form-full">
      <fieldset className="visita-duracion__fieldset" disabled={disabled}>
        <legend className="visita-duracion__legend">¿Cuánto dura el pase?</legend>
        <div className="visita-duracion__options" role="radiogroup" aria-label="¿Cuánto dura el pase?">
          {DURACION_OPCIONES.map((opt) => {
            const selected = duracion === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`visita-duracion__option${selected ? ' is-selected' : ''}`}
                onClick={() => set({ duracion: opt.id })}
              >
                <span className="visita-duracion__option-title">{opt.label}</span>
                <span className="visita-duracion__option-help">{opt.help}</span>
              </button>
            );
          })}
        </div>

        <div className="visita-duracion__fields">
          <label htmlFor={`${idPrefix}-fecha`}>
            {isMes ? 'Desde el día' : 'Día'}
            <input
              id={`${idPrefix}-fecha`}
              type="date"
              className="input-field"
              value={value.fecha}
              onChange={(e) => set({ fecha: e.target.value })}
              required
            />
          </label>
          {conHora && (
            <label htmlFor={`${idPrefix}-desde`}>
              {duracion === 'horas' ? 'Desde la hora' : 'Hora de llegada'}
              <input
                id={`${idPrefix}-desde`}
                type="time"
                className="input-field"
                value={value.horaDesde}
                onChange={(e) => set({ horaDesde: e.target.value })}
                required
              />
            </label>
          )}
          {duracion === 'horas' && (
            <label htmlFor={`${idPrefix}-hasta`}>
              Hasta la hora
              <input
                id={`${idPrefix}-hasta`}
                type="time"
                className="input-field"
                value={value.horaHasta}
                onChange={(e) => set({ horaHasta: e.target.value })}
                required
              />
            </label>
          )}
          {isMes && (
            <label htmlFor={`${idPrefix}-fecha-hasta`}>
              Hasta el día
              <input
                id={`${idPrefix}-fecha-hasta`}
                type="date"
                className="input-field"
                value={value.fechaHasta}
                min={value.fecha}
                onChange={(e) => set({ fechaHasta: e.target.value })}
                required
              />
            </label>
          )}
        </div>
        {isMes && (
          <p className="empleado-hint">
            Como máximo {MAX_MES_DAYS} días. Seguridad lo tiene que aprobar antes de que sirva.
          </p>
        )}
      </fieldset>
    </div>
  );
}

export default VisitaDuracionPicker;
