import React, { useCallback, useEffect, useState } from 'react';
import { LogOut } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { apiFetch } from '../../services/api';
import brand from '../../config/brand';
import ToastStack from '../../components/ToastStack';

const ESTADO_LABEL = {
  pendiente: 'Pendiente',
  autorizada: 'Autorizada',
  ingreso_registrado: 'Ingreso registrado',
  egreso_registrado: 'Egreso registrado'
};

function toLocalInputValue(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function EmpleadoVisitasPage() {
  const { authToken, currentUser, logout } = useAuth();
  const { error, successMessage, showError, showSuccess, setError, setSuccessMessage } = useToast();

  const [destinos, setDestinos] = useState([]);
  const [visitas, setVisitas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [nombreVisitante, setNombreVisitante] = useState('');
  const [dniVisitante, setDniVisitante] = useState('');
  const [fechaHoraEsperada, setFechaHoraEsperada] = useState(() => toLocalInputValue());
  const [motivo, setMotivo] = useState('');
  const [destinoId, setDestinoId] = useState('');

  const load = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    try {
      const [destData, visData] = await Promise.all([
        apiFetch('/empleado/destinos', { token: authToken }),
        apiFetch('/empleado/visitas', { token: authToken })
      ]);
      setDestinos(destData.destinos || []);
      setVisitas(visData.visitas || []);
    } catch (err) {
      showError(err.message || 'No se pudieron cargar los datos');
    } finally {
      setLoading(false);
    }
  }, [authToken, showError]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const expected = new Date(fechaHoraEsperada);
      await apiFetch('/empleado/visitas', {
        method: 'POST',
        token: authToken,
        body: {
          nombreVisitante: nombreVisitante.trim(),
          dniVisitante: dniVisitante.trim(),
          fechaHoraEsperada: expected.toISOString(),
          motivo: motivo.trim(),
          destinoId
        }
      });
      showSuccess('Visita cargada');
      setNombreVisitante('');
      setDniVisitante('');
      setMotivo('');
      setDestinoId('');
      setFechaHoraEsperada(toLocalInputValue());
      await load();
    } catch (err) {
      showError(err.message || 'No se pudo guardar la visita');
    } finally {
      setSaving(false);
    }
  };

  const displayName = currentUser?.nombre || currentUser?.username || 'Empleado';

  return (
    <div className="empleado-shell">
      <ToastStack
        error={error}
        successMessage={successMessage}
        onDismissError={() => setError(null)}
        onDismissSuccess={() => setSuccessMessage(null)}
      />
      <header className="empleado-topbar">
        <div className="empleado-brand">
          <img src={brand.logoPath} alt={brand.logoAlt} className="empleado-logo" />
          <div>
            <p className="empleado-kicker">Panel de empleado</p>
            <h1 className="empleado-title">Mis visitas</h1>
          </div>
        </div>
        <div className="empleado-user">
          <span>{displayName}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={logout}>
            <LogOut size={16} /> Salir
          </button>
        </div>
      </header>

      <main className="empleado-main">
        <section className="empleado-section">
          <h2>Cargar visita</h2>
          <p className="empleado-hint">
            Registrá un visitante esperado. Solo vos vas a ver las visitas que cargues.
          </p>
          <form onSubmit={handleSubmit} className="empleado-form">
            <label>
              Nombre del visitante
              <input
                className="input-field"
                value={nombreVisitante}
                onChange={(e) => setNombreVisitante(e.target.value)}
                required
              />
            </label>
            <label>
              DNI
              <input
                className="input-field"
                value={dniVisitante}
                onChange={(e) => setDniVisitante(e.target.value)}
                required
              />
            </label>
            <label>
              Fecha y hora esperada
              <input
                type="datetime-local"
                className="input-field"
                value={fechaHoraEsperada}
                onChange={(e) => setFechaHoraEsperada(e.target.value)}
                required
              />
            </label>
            <label>
              Destino
              <select
                className="input-field"
                value={destinoId}
                onChange={(e) => setDestinoId(e.target.value)}
                required
              >
                <option value="">Seleccionar…</option>
                {destinos.map((d) => (
                  <option key={d.id} value={d.id}>{d.nombre}</option>
                ))}
              </select>
            </label>
            <label className="empleado-form-full">
              Motivo
              <input
                className="input-field"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
              />
            </label>
            <div className="empleado-form-full">
              <button type="submit" className="btn btn-primary" disabled={saving || loading}>
                {saving ? 'Guardando…' : 'Registrar visita'}
              </button>
            </div>
          </form>
        </section>

        <section className="empleado-section">
          <h2>Mis visitas cargadas</h2>
          {loading ? (
            <p className="empleado-hint">Cargando…</p>
          ) : visitas.length === 0 ? (
            <p className="empleado-hint">Todavía no cargaste visitas.</p>
          ) : (
            <ul className="empleado-visita-list">
              {visitas.map((v) => (
                <li key={v.id}>
                  <div>
                    <strong>{v.nombreVisitante}</strong>
                    <span className="empleado-meta"> · DNI {v.dniVisitante}</span>
                  </div>
                  <div className="empleado-meta">
                    {v.destinoNombre || v.destinoId}
                    {v.fechaHoraEsperada
                      ? ` · ${new Date(v.fechaHoraEsperada).toLocaleString('es-AR')}`
                      : ''}
                  </div>
                  {v.motivo ? <div className="empleado-meta">{v.motivo}</div> : null}
                  <span className={`empleado-estado empleado-estado-${v.estado}`}>
                    {ESTADO_LABEL[v.estado] || v.estado}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

export default EmpleadoVisitasPage;
