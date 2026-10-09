import React, { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { AdminBlock, AdminEmpty } from '../../../components/admin/AdminUi';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { apiFetch } from '../../../services/api';
import { Modal, PageContainer } from '../../../components/admin-ui';

function VisitasAdminSection() {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const [visitas, setVisitas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [rejectId, setRejectId] = useState(null);
  const [note, setNote] = useState('');

  const canApprove = hasPermission(currentUser, 'visitas.approve');

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
          al registrar ya quedan operativas.
        </p>
      </aside>

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
                    {v.fechaHoraEsperada
                      ? ` · ${new Date(v.fechaHoraEsperada).toLocaleString('es-AR')}`
                      : ''}
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
    </div>
    </PageContainer>
  );
}

export default VisitasAdminSection;
