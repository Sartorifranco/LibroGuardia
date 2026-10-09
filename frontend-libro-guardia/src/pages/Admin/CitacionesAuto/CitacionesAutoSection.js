import React, { useCallback, useEffect, useState } from 'react';
import { AdvancedSection, PageHeader } from '../../../components/admin-ui';
import { apiFetch } from '../../../services/api';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';

function CitacionesAutoSection() {
  const { authToken } = useAuth();
  const { showSuccess, showError } = useToast();
  const [config, setConfig] = useState({ enabled: false, watchFolderHint: '', bridgeSecret: '' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch('/admin/citaciones-bridge', { token: authToken, allowForbidden: true });
      setConfig((prev) => ({ ...prev, ...(data.config || {}) }));
    } catch (err) {
      showError(err.message || 'No se pudo leer la configuración.');
    } finally {
      setLoading(false);
    }
  }, [authToken, showError]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true);
    try {
      const data = await apiFetch('/admin/citaciones-bridge', {
        method: 'PUT',
        token: authToken,
        body: {
          enabled: config.enabled === true,
          watchFolderHint: config.watchFolderHint || '',
          bridgeSecret: config.bridgeSecret || ''
        }
      });
      setConfig((prev) => ({ ...prev, ...(data.config || {}) }));
      showSuccess('Listo. Las citaciones automáticas quedaron guardadas.');
    } catch (err) {
      showError(err.message || 'No se pudo guardar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Citaciones automáticas"
        purpose="Si la empresa deja un archivo con los citados del día, el sistema los carga solo."
        howTo={[
          'Activá la recepción.',
          'El instalador indica la carpeta donde cae el archivo.',
          'Guardá y esperá el próximo archivo.'
        ]}
        action={(
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || loading}>
            Guardar
          </button>
        )}
      />
      {loading ? <p role="status">Cargando…</p> : null}
      <label className="aui-check">
        <input
          type="checkbox"
          checked={config.enabled === true}
          onChange={(event) => setConfig((prev) => ({ ...prev, enabled: event.target.checked }))}
        />
        <span>Recibir citados desde la carpeta de la empresa</span>
      </label>
      <AdvancedSection title="Datos para el instalador">
        <label className="aui-field">
          <span className="aui-field__label">Carpeta donde cae el archivo</span>
          <input
            className="input-field"
            value={config.watchFolderHint || ''}
            onChange={(event) => setConfig((prev) => ({ ...prev, watchFolderHint: event.target.value }))}
          />
        </label>
        <label className="aui-field">
          <span className="aui-field__label">Clave</span>
          <input
            className="input-field"
            type="password"
            value={config.bridgeSecret || ''}
            autoComplete="off"
            onChange={(event) => setConfig((prev) => ({ ...prev, bridgeSecret: event.target.value }))}
          />
        </label>
      </AdvancedSection>
    </div>
  );
}

export default CitacionesAutoSection;
