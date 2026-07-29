import React, { useRef, useState } from 'react';
import { Camera, Trash2 } from 'lucide-react';
import { compressImageToDataUrl } from '../utils/personPhoto';

/**
 * Campo opcional para cargar/quitar foto de una persona o visitante.
 */
function PersonPhotoField({
  value = '',
  onChange,
  disabled = false,
  label = 'Foto (opcional)',
  hint = 'Ayuda al guardia a verificar identidad en el ingreso principal.'
}) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');

  const handlePick = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    setLocalError('');
    try {
      const dataUrl = await compressImageToDataUrl(file);
      onChange?.(dataUrl);
    } catch (err) {
      setLocalError(err.message || 'No se pudo cargar la foto');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="person-photo-field">
      <div className="person-photo-field__label-row">
        <span className="person-photo-field__label">{label}</span>
        {hint ? <small className="person-photo-field__hint">{hint}</small> : null}
      </div>
      <div className="person-photo-field__body">
        <div className={`person-photo-field__preview${value ? '' : ' is-empty'}`}>
          {value ? (
            <img src={value} alt="Vista previa de la persona" />
          ) : (
            <Camera size={28} aria-hidden />
          )}
        </div>
        <div className="person-photo-field__actions">
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            disabled={disabled || busy}
            onChange={handlePick}
          />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={disabled || busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? 'Procesando…' : (value ? 'Cambiar foto' : 'Cargar foto')}
          </button>
          {value ? (
            <button
              type="button"
              className="btn-logout-link"
              disabled={disabled || busy}
              onClick={() => onChange?.('')}
            >
              <Trash2 size={14} aria-hidden /> Quitar
            </button>
          ) : null}
        </div>
      </div>
      {localError ? <p className="person-photo-field__error">{localError}</p> : null}
    </div>
  );
}

export default PersonPhotoField;
