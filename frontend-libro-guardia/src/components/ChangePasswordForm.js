import React, { useState } from 'react';
import { AlertCircle, KeyRound, Loader2 } from 'lucide-react';

/**
 * Formulario de cambio de contraseña.
 * @param {{ forced?: boolean, onSubmit: (currentPassword: string, newPassword: string) => Promise<void>, onCancel?: () => void }} props
 */
function ChangePasswordForm({ forced = false, onSubmit, onCancel }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError('La confirmación no coincide con la nueva contraseña');
      return;
    }
    setLoading(true);
    try {
      await onSubmit(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err.message || 'No se pudo cambiar la contraseña');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="change-password-form" onSubmit={handleSubmit}>
      {forced && (
        <p className="theme-section-desc">
          Por seguridad debe definir una contraseña nueva antes de continuar.
        </p>
      )}
      {error && (
        <div className="error-message auth-inline-message" role="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}
      <label className="field-label" htmlFor="cp-current">
        Contraseña actual
        <input
          id="cp-current"
          className="input-field"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
        />
      </label>
      <label className="field-label" htmlFor="cp-new">
        Nueva contraseña
        <input
          id="cp-new"
          className="input-field"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          minLength={8}
          required
        />
      </label>
      <label className="field-label" htmlFor="cp-confirm">
        Confirmar nueva contraseña
        <input
          id="cp-confirm"
          className="input-field"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          minLength={8}
          required
        />
      </label>
      <p className="theme-section-desc" style={{ marginTop: 0 }}>
        Mínimo 8 caracteres. No puede ser igual al usuario ni a la contraseña actual.
      </p>
      <div className="flex flex-wrap gap-2 mt-3">
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}
          {forced ? 'Guardar y continuar' : 'Cambiar contraseña'}
        </button>
        {!forced && onCancel && (
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={loading}>
            Cancelar
          </button>
        )}
      </div>
    </form>
  );
}

export default ChangePasswordForm;
