import React, { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Settings, X } from 'lucide-react';
import { AdminBlock, AdminEmpty } from '../../../components/admin/AdminUi';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { apiFetch } from '../../../services/api';
import { Modal, PageContainer } from '../../../components/admin-ui';
import { duracionLabel, formatValidezCorta } from '../../../utils/visitaDuracion';

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** "bacarsa.com.ar, @otra.com" → ['bacarsa.com.ar', 'otra.com'] (mismo criterio que el backend). */
function parseDominios(text) {
  return [...new Set(String(text || '')
    .split(/[\s,;]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean))];
}

function VisitasAdminSection() {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const [visitas, setVisitas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [rejectId, setRejectId] = useState(null);
  const [note, setNote] = useState('');
  const [dominios, setDominios] = useState(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [dominiosText, setDominiosText] = useState('');
  const [configError, setConfigError] = useState('');
  const [configSaving, setConfigSaving] = useState(false);

  const canApprove = hasPermission(currentUser, 'visitas.approve');

  useEffect(() => {
    if (!authToken || !canApprove) return undefined;
    let cancelled = false;
    apiFetch('/admin/visitas/settings', { token: authToken, allowForbidden: true })
      .then((data) => {
        if (!cancelled) setDominios(data.settings?.dominiosAnfitrion || []);
      })
      .catch(() => {
        if (!cancelled) setDominios([]);
      });
    return () => { cancelled = true; };
  }, [authToken, canApprove]);

  const openConfig = () => {
    setDominiosText((dominios || []).join(', '));
    setConfigError('');
    setConfigOpen(true);
  };

  const saveConfig = async () => {
    const list = parseDominios(dominiosText);
    const invalid = list.find((d) => !DOMAIN_RE.test(d));
    if (invalid) {
      setConfigError(`"${invalid}" no parece un dominio de mail. Escribilo así: bacarsa.com.ar`);
      return;
    }
    if (!list.length) {
      setConfigError('Indicá al menos un dominio de mail (por ejemplo bacarsa.com.ar).');
      return;
    }
    setConfigSaving(true);
    setConfigError('');
    try {
      const data = await apiFetch('/admin/visitas/settings', {
        method: 'PUT',
        token: authToken,
        allowForbidden: true,
        body: { dominiosAnfitrion: list }
      });
      setDominios(data.settings?.dominiosAnfitrion || list);
      setConfigOpen(false);
      showSuccess(data.message || 'Configuración de visitas guardada');
    } catch (err) {
      setConfigError(err.message || 'No se pudo guardar la configuración');
    } finally {
      setConfigSaving(false);
    }
  };

  const load = useCallback(async () => {
    if (!authToken || !canApprove) return;
    setLoading(true);
    try {
      const data = await apiFetch('/admin/visitas/pending', { token: authToken, allowForbidden: true });
      setVisitas(data.visitas || []);
    } catch (err) {
      showError(err.message || 'No se pudieron cargar las solicitudes');
    } finally {
      setLoading(false);
    }
  }, [authToken, canApprove, showError]);

  useEffect(() => {
    load();
  }, [load]);

  const approve = async (id) => {
    setBusyId(id);
    try {
      await apiFetch(`/admin/visitas/${id}/approve`, { method: 'POST', token: authToken });
      showSuccess('Visita aprobada. El solicitante ya puede compartir el QR.');
      setVisitas((prev) => prev.filter((v) => v.id !== id));
    } catch (err) {
      showError(err.message || 'No se pudo aprobar');
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (id) => {
    if (note.trim().length < 3) {
      showError('Escribí por qué la rechazás.');
      return;
    }
    setBusyId(id);
    try {
      await apiFetch(`/admin/visitas/${id}/reject`, {
        method: 'POST',
        token: authToken,
        body: { motivo: note.trim() }
      });
      showSuccess('Guardado');
      setRejectId(null);
      setNote('');
      setVisitas((prev) => prev.filter((v) => v.id !== id));
    } catch (err) {
      showError(err.message || 'No se pudo rechazar');
    } finally {
      setBusyId(null);
    }
  };

  if (!canApprove) {
    return <p className="theme-section-desc">Sin permiso visitas.approve.</p>;
  }

  const rejecting = visitas.find((item) => item.id === rejectId) || null;

  return (
    <PageContainer width="medium">
    <div className="visitas-admin">
      <aside className="destinos-admin__howto" aria-label="Cómo funciona">
        <h4>Solicitudes de visita</h4>
        <p>
          Quienes tienen permiso de <strong>solicitar</strong> (no de cargar autorizadas)
          envían visitas que aparecen acá. Hasta que apruebes, no habilitan el acceso ni el QR.
        </p>
        <p>
          Quienes tienen <strong>cargar visitas autorizadas</strong> no pasan por esta cola:
          al registrar ya quedan operativas. Los pases <strong>por mes</strong> siempre pasan por acá.
        </p>
      </aside>

      <AdminBlock
        title="Configuración"
        description="Quién puede invitar visitas: solo el personal con mail de estos dominios."
        action={(
          <button type="button" className="btn btn-secondary btn-sm" onClick={openConfig} disabled={dominios === null}>
            <Settings size={14} />
            Cambiar dominios
          </button>
        )}
      >
        <p className="theme-section-desc">
          {dominios === null
            ? 'Cargando…'
            : (dominios.length ? dominios.map((d) => `@${d}`).join(', ') : 'Sin dominios cargados')}
        </p>
      </AdminBlock>

      <AdminBlock title={`Pendientes de aprobación (${visitas.length})`}>
        {loading ? (
          <p className="theme-section-desc flex items-center gap-2">
            <Loader2 className="animate-spin" size={16} />
            Cargando…
          </p>
        ) : visitas.length === 0 ? (
          <AdminEmpty
            title="No hay solicitudes pendientes"
            description="Cuando un empleado con permiso de solicitud cargue una visita, va a aparecer acá."
          />
        ) : (
          <ul className="visitas-admin__list">
            {visitas.map((v) => (
              <li key={v.id} className="visitas-admin__item">
                <div>
                  <strong>{v.nombreVisitante}</strong>
                  <span className="theme-section-desc">
                    {' · DNI '}
                    {v.dniVisitanteNormalized || v.dniVisitante}
                  </span>
                  <div className="theme-section-desc">
                    {v.destinoNombre || 'Sin destino'}
                    {v.empresaNombre ? ` · ${v.empresaNombre}` : ''}
                  </div>
                  <div className="theme-section-desc">
                    <strong>{duracionLabel(v.duracion)}</strong>
                    {' · '}
                    {formatValidezCorta(v)}
                  </div>
                  <div className="theme-section-desc">
                    Solicitó:
                    {' '}
                    {v.createdByNombre || v.createdByUserId || '—'}
                    {v.motivo ? ` · ${v.motivo}` : ''}
                  </div>
                </div>
                <div className="visitas-admin__actions">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busyId === v.id}
                    onClick={() => approve(v.id)}
                  >
                    <Check size={14} />
                    Aprobar
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busyId === v.id}
                    onClick={() => { setRejectId(v.id); setNote(''); }}
                  >
                    <X size={14} />
                    Rechazar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </AdminBlock>
      <Modal
        open={Boolean(rejecting)}
        title="Rechazar visita"
        description="La visita no va a poder entrar."
        onClose={() => setRejectId(null)}
        size="sm"
        dirty={Boolean(note.trim())}
        footer={(
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setRejectId(null)}>Cancelar</button>
            <button type="button" className="btn btn-primary" disabled={note.trim().length < 3 || busyId === rejectId} onClick={() => reject(rejectId)}>
              Rechazar
            </button>
          </>
        )}
      >
        <label>
          Por qué la rechazás
          <textarea className="input-field" aria-label="Por qué la rechazás" value={note} onChange={(event) => setNote(event.target.value)} rows={3} />
        </label>
      </Modal>
      <Modal
        open={configOpen}
        title="Configuración de visitas"
        description="Solo el personal con mail de estos dominios puede invitar visitas. El admin siempre puede."
        onClose={() => setConfigOpen(false)}
        size="sm"
        dirty={dominiosText !== (dominios || []).join(', ')}
        footer={(
          <>
            <button type="button" className="btn btn-secondary" data-aui-cancel="true" disabled={configSaving}>Cancelar</button>
            <button type="button" className="btn btn-primary" disabled={configSaving} onClick={saveConfig}>
              {configSaving ? 'Guardando…' : 'Guardar'}
            </button>
          </>
        )}
      >
        <label>
          Dominios permitidos para invitar
          <textarea
            className="input-field"
            aria-label="Dominios permitidos para invitar"
            value={dominiosText}
            onChange={(event) => setDominiosText(event.target.value)}
            rows={3}
          />
        </label>
        <p className="theme-section-desc">Separalos con comas. Ejemplo: bacarsa.com.ar, otraempresa.com</p>
        {configError ? <p className="theme-section-desc" role="alert">{configError}</p> : null}
      </Modal>
    </div>
    </PageContainer>
  );
}

export default VisitasAdminSection;
