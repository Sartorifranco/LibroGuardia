import React, { useCallback, useEffect, useState } from 'react';
import { LogOut, QrCode } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { apiFetch } from '../../services/api';
import brand from '../../config/brand';
import ToastStack from '../../components/ToastStack';
import VisitaInviteQrModal from '../../components/VisitaInviteQrModal';
import PersonPhotoField from '../../components/PersonPhotoField';
import { getVisitaWindow } from '../../utils/visitaInvite';
import { hasPermission } from '../../utils/permissions';

const ESTADO_LABEL = {
  pendiente: 'Esperando ingreso',
  autorizada: 'Esperando ingreso',
  pendiente_aprobacion: 'Pendiente de aprobación',
  rechazada: 'Rechazada',
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

  const canCreate = hasPermission(currentUser, 'visitas.create');
  const canRequest = hasPermission(currentUser, 'visitas.request');
  const canSubmit = canCreate || canRequest;

  const [destinos, setDestinos] = useState([]);
  const [visitas, setVisitas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [qrVisita, setQrVisita] = useState(null);

  const [nombreVisitante, setNombreVisitante] = useState('');
  const [dniVisitante, setDniVisitante] = useState('');
  const [fechaHoraEsperada, setFechaHoraEsperada] = useState(() => toLocalInputValue());
  const [motivo, setMotivo] = useState('');
  const [destinoId, setDestinoId] = useState('');
  const [photoDataUrl, setPhotoDataUrl] = useState('');

  const load = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    try {
      const tasks = [apiFetch('/empleado/visitas', { token: authToken })];
      if (canSubmit) {
        tasks.unshift(apiFetch('/empleado/destinos', { token: authToken }));
      }
      const results = await Promise.all(tasks);
      if (canSubmit) {
        setDestinos(results[0].destinos || []);
        setVisitas(results[1].visitas || []);
      } else {
        setDestinos([]);
        setVisitas(results[0].visitas || []);
      }
    } catch (err) {
      showError(err.message || 'No se pudieron cargar los datos');
    } finally {
      setLoading(false);
    }
  }, [authToken, canSubmit, showError]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) {
      showError('No tenés permiso para cargar ni solicitar visitas.');
      return;
    }
    if (!destinoId) {
      showError('Elegí un destino. Si no hay opciones, un admin debe crearlas en Admin → Destinos.');
      return;
    }
    setSaving(true);
    try {
      const expected = new Date(fechaHoraEsperada);
      const result = await apiFetch('/empleado/visitas', {
        method: 'POST',
        token: authToken,
        body: {
          nombreVisitante: nombreVisitante.trim(),
          dniVisitante: dniVisitante.trim(),
          fechaHoraEsperada: expected.toISOString(),
          motivo: motivo.trim(),
          destinoId,
          photoDataUrl: photoDataUrl || null
        }
      });
      const created = result.visita || {
        id: result.id,
        nombreVisitante: nombreVisitante.trim(),
        dniVisitante: dniVisitante.trim(),
        fechaHoraEsperada: expected.toISOString(),
        destinoId,
        destinoNombre: destinos.find((d) => d.id === destinoId)?.nombre || '',
        estado: canCreate ? 'autorizada' : 'pendiente_aprobacion',
        createdByNombre: currentUser?.nombre || currentUser?.username || ''
      };
      showSuccess(result.message || (canCreate
        ? 'Visita cargada. Compartí el QR con el visitante.'
        : 'Solicitud enviada. Queda pendiente de aprobación.'));
      setNombreVisitante('');
      setDniVisitante('');
      setMotivo('');
      setDestinoId('');
      setPhotoDataUrl('');
      setFechaHoraEsperada(toLocalInputValue());
      await load();
      if (created.estado === 'autorizada' || created.estado === 'pendiente') {
        setQrVisita(created);
      }
    } catch (err) {
      showError(err.message || 'No se pudo guardar la visita');
    } finally {
      setSaving(false);
    }
  };

  const displayName = currentUser?.nombre || currentUser?.username || 'Empleado';
  const canShowQr = (v) => v?.estado === 'pendiente' || v?.estado === 'autorizada';

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
        {canSubmit && (
          <section className="empleado-section">
            <h2>{canCreate ? 'Cargar visita' : 'Solicitar visita'}</h2>
            <p className="empleado-hint">
              {canCreate ? (
                <>
                  Al registrar la visita, <strong>ya queda autorizada por vos</strong>.
                  Después compartila por WhatsApp o mail (QR). El visitante también puede
                  ingresar con su DNI físico en el lector, dentro de la ventana de vigencia.
                </>
              ) : (
                <>
                  Tu usuario solo puede <strong>solicitar</strong> visitas. Un administrador o
                  supervisor debe aprobarlas en Admin → Aprobar visitas antes de que el visitante
                  pueda ingresar o recibir el QR.
                </>
              )}
            </p>
            {!loading && destinos.length === 0 && (
              <div className="empleado-callout" role="status">
                <strong>No hay destinos disponibles</strong>
                <p>
                  Un administrador debe crearlos en
                  {' '}
                  <strong>Admin → Destinos</strong>
                  .
                </p>
              </div>
            )}
            <form onSubmit={handleSubmit} className="empleado-form">
              <label>
                Nombre del visitante
                <input
                  className="input-field"
                  value={nombreVisitante}
                  onChange={(e) => setNombreVisitante(e.target.value)}
                  required
                  disabled={!destinos.length}
                />
              </label>
              <label>
                DNI
                <input
                  className="input-field"
                  value={dniVisitante}
                  onChange={(e) => setDniVisitante(e.target.value)}
                  required
                  disabled={!destinos.length}
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
                  disabled={!destinos.length}
                />
              </label>
              <label>
                Destino
                <select
                  className="input-field"
                  value={destinoId}
                  onChange={(e) => setDestinoId(e.target.value)}
                  required
                  disabled={!destinos.length}
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
                  disabled={!destinos.length}
                />
              </label>
              <div className="empleado-form-full">
                <PersonPhotoField
                  value={photoDataUrl}
                  onChange={setPhotoDataUrl}
                  disabled={!destinos.length || saving}
                  label="Foto del visitante (opcional)"
                  hint="Si el cliente tiene verificación en ingreso principal, el guardia verá esta foto."
                />
              </div>
              <div className="empleado-form-full">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving || loading || !destinos.length}
                >
                  {saving
                    ? 'Guardando…'
                    : (canCreate ? 'Registrar visita' : 'Solicitar visita')}
                </button>
              </div>
            </form>
          </section>
        )}

        <section className="empleado-section">
          <h2>Mis visitas cargadas</h2>
          <p className="empleado-hint">
            “Esperando ingreso” = visitante aún no pasó. “Pendiente de aprobación” = espera a un admin.
          </p>
          {loading ? (
            <p className="empleado-hint">Cargando…</p>
          ) : visitas.length === 0 ? (
            <p className="empleado-hint">Todavía no cargaste visitas.</p>
          ) : (
            <ul className="empleado-visita-list">
              {visitas.map((v) => {
                const windowInfo = getVisitaWindow(v.fechaHoraEsperada);
                return (
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
                    <div className="empleado-meta">{windowInfo.label}</div>
                    {v.motivo ? <div className="empleado-meta">{v.motivo}</div> : null}
                    <div className="empleado-visita-actions">
                      <span className={`empleado-estado empleado-estado-${v.estado}`}>
                        {ESTADO_LABEL[v.estado] || v.estado}
                      </span>
                      {canShowQr(v) && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => setQrVisita(v)}
                        >
                          <QrCode size={14} />
                          Compartir / QR
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>

      {qrVisita && (
        <VisitaInviteQrModal
          visita={qrVisita}
          authToken={authToken}
          onClose={() => setQrVisita(null)}
          onReady={(updated) => {
            if (!updated?.id) return;
            setQrVisita((prev) => (prev?.id === updated.id ? { ...prev, ...updated } : prev));
            setVisitas((prev) => prev.map((v) => (v.id === updated.id ? { ...v, ...updated } : v)));
          }}
        />
      )}
    </div>
  );
}

export default EmpleadoVisitasPage;
