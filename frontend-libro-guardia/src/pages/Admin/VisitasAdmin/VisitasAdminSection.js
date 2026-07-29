import React, { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { AdminBlock, AdminEmpty } from '../../../components/admin/AdminUi';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { apiFetch } from '../../../services/api';

function VisitasAdminSection() {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const [visitas, setVisitas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

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
    setBusyId(id);
    try {
      await apiFetch(`/admin/visitas/${id}/reject`, {
        method: 'POST',
        token: authToken,
        body: { motivo: '' }
      });
      showSuccess('Solicitud rechazada');
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

  return (
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
                    onClick={() => reject(v.id)}
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
    </div>
  );
}

export default VisitasAdminSection;
