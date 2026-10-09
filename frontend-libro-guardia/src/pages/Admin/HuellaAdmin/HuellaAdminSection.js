import React, { useCallback, useEffect, useState } from 'react';
import { AdvancedSection, PageHeader } from '../../../components/admin-ui';
import { apiFetch } from '../../../services/api';
import { useAuth } from '../../../context/AuthContext';

const LABEL = {
  ok: 'Las huellas están llegando.',
  stale: 'Hace un rato que no llega ninguna huella.',
  error: 'Hay un problema con el lector de huella.',
  unknown: 'Todavía no hay datos del lector de huella.'
};

function HuellaAdminSection() {
  const { authToken } = useAuth();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch('/admin/biostar/status', { token: authToken, allowForbidden: true });
      setStatus(data.status || null);
    } catch (err) {
      setError(err.message || 'No se pudo leer el estado de la huella.');
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => { load(); }, [load]);

  const state = status?.state || 'unknown';

  return (
    <div>
      <PageHeader
        title="Huella"
        purpose="Así entran las personas que usan el lector de huella (BioStar)."
        howTo={[
          'El instalador conecta el lector de huella.',
          'Las personas se cargan en Personas.',
          'Acá ves si las huellas están llegando.'
        ]}
        action={(
          <button type="button" className="btn btn-secondary" onClick={load} disabled={loading}>
            {loading ? 'Actualizando…' : 'Actualizar'}
          </button>
        )}
      />
      {error ? <p role="alert">{error}</p> : null}
      {!error ? <p>{LABEL[state] || LABEL.unknown}</p> : null}
      {status?.health?.reason && state !== 'ok' ? <p>{status.health.reason}</p> : null}
      <AdvancedSection title="Datos para el instalador">
        <p className="aui-card__meta">
          {status?.bridge?.hostname
            ? `Equipo ${status.bridge.hostname}.`
            : 'Cuando el instalador deje conectado el lector, el detalle aparece acá.'}
        </p>
        {status?.lastError ? <p className="aui-error">{String(status.lastError)}</p> : null}
      </AdvancedSection>
    </div>
  );
}

export default HuellaAdminSection;
