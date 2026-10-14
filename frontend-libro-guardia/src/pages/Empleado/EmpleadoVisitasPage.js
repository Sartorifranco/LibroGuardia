import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, LogOut, Mail, Pencil, QrCode } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { apiFetch } from '../../services/api';
import brand from '../../config/brand';
import ConnectivityChrome from '../../components/ConnectivityChrome';
import ToastStack from '../../components/ToastStack';
import VisitaInviteQrModal from '../../components/VisitaInviteQrModal';
import PersonPhotoField from '../../components/PersonPhotoField';
import Modal from '../../components/admin-ui/Modal';
import VisitaDuracionPicker from '../../components/VisitaDuracionPicker';
import { buildDuracionPayload, duracionFormFrom, formatValidezCorta } from '../../utils/visitaDuracion';
import { hasPermission } from '../../utils/permissions';

const ESTADO_LABEL = {
  pendiente: 'Esperando ingreso',
  autorizada: 'Esperando ingreso',
  pendiente_aprobacion: 'Pendiente de aprobación',
  rechazada: 'Rechazada',
  cancelada: 'Cancelada',
  revocada: 'Cancelada',
  ingreso_registrado: 'Ingreso registrado',
  egreso_registrado: 'Egreso registrado'
};

const HOST_EDITABLE_ESTADOS = new Set(['pendiente_aprobacion', 'autorizada', 'pendiente']);

const HOST_DENIED_CODES = new Set(['dominio_no_permitido', 'email_no_verificado']);
const RESEND_WAIT_MESSAGE = 'Ya te mandamos un mail hace un momento. Esperá 2 minutos y probá de nuevo.';

function editFormFrom(visita) {
  return {
    dur: duracionFormFrom(visita),
    motivo: visita?.motivo || '',
    destinoId: visita?.destinoId || ''
  };
}

/** 403 por dominio o mail sin confirmar → { code, message }; si no, null. */
function hostDeniedFrom(err) {
  const code = err?.data?.code;
  if (err?.status !== 403 || !HOST_DENIED_CODES.has(code)) return null;
  return { code, message: err.data?.message || err.data?.error || err.message };
}

function EmpleadoVisitasPage() {
  const { authToken, currentUser, logout } = useAuth();
  const { error, successMessage, showError, showSuccess, setError, setSuccessMessage } = useToast();

  const canCreate = hasPermission(currentUser, 'visitas.create');
  const canRequest = hasPermission(currentUser, 'visitas.request');
  const canSubmit = canCreate || canRequest;

  const [destinos, setDestinos] = useState([]);
  const [horarios, setHorarios] = useState([]);
  const [visitas, setVisitas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [qrVisita, setQrVisita] = useState(null);

  const [nombreVisitante, setNombreVisitante] = useState('');
  const [dniVisitante, setDniVisitante] = useState('');
  const [durForm, setDurForm] = useState(() => duracionFormFrom());
  const [motivo, setMotivo] = useState('');
  const [hostDenied, setHostDenied] = useState(null);
  const [emailConfirmed, setEmailConfirmed] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendNote, setResendNote] = useState('');
  const [destinoId, setDestinoId] = useState('');
  const [photoDataUrl, setPhotoDataUrl] = useState('');

  const [editVisita, setEditVisita] = useState(null);
  const [editForm, setEditForm] = useState(() => editFormFrom(null));
  const [editError, setEditError] = useState('');
  const [cancelVisita, setCancelVisita] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [reshareVisita, setReshareVisita] = useState(null);

  const load = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    try {
      const tasks = [apiFetch('/empleado/visitas', { token: authToken })];
      if (canSubmit) {
        tasks.unshift(apiFetch('/empleado/destinos', { token: authToken }));
      }
      if (canSubmit) {
        // Sin horarios el formulario sigue andando ("a cualquier hora").
        tasks.push(apiFetch('/empleado/horarios', { token: authToken }).catch(() => ({ horarios: [] })));
      }
      const results = await Promise.all(tasks);
      if (canSubmit) {
        setDestinos(results[0].destinos || []);
        setVisitas(results[1].visitas || []);
        setHorarios(results[2]?.horarios || []);
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
    const dur = buildDuracionPayload(durForm);
    if (dur.error) {
      showError(dur.error);
      return;
    }
    setSaving(true);
    try {
      const result = await apiFetch('/empleado/visitas', {
        method: 'POST',
        token: authToken,
        allowForbidden: true,
        body: {
          nombreVisitante: nombreVisitante.trim(),
          dniVisitante: dniVisitante.trim(),
          ...dur.payload,
          motivo: motivo.trim(),
          destinoId,
          photoDataUrl: photoDataUrl || null
        }
      });
      setHostDenied(null);
      const needsApproval = !canCreate || dur.payload.duracion === 'mes';
      const created = result.visita || {
        id: result.id,
        nombreVisitante: nombreVisitante.trim(),
        dniVisitante: dniVisitante.trim(),
        ...dur.payload,
        destinoId,
        destinoNombre: destinos.find((d) => d.id === destinoId)?.nombre || '',
        estado: needsApproval ? 'pendiente_aprobacion' : 'autorizada',
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
      setDurForm(duracionFormFrom());
      await load();
      if (created.estado === 'autorizada' || created.estado === 'pendiente') {
        setQrVisita(created);
      }
    } catch (err) {
      const denied = hostDeniedFrom(err);
      if (denied) {
        setHostDenied(denied);
        return;
      }
      showError(err.message || 'No se pudo guardar la visita');
    } finally {
      setSaving(false);
    }
  };

  const replaceVisita = (updated) => {
    if (!updated?.id) return;
    setVisitas((prev) => prev.map((v) => (v.id === updated.id ? { ...v, ...updated } : v)));
  };

  const openEdit = (visita) => {
    setEditVisita(visita);
    setEditForm(editFormFrom(visita));
    setEditError('');
  };

  const editDirty = Boolean(editVisita) && JSON.stringify(editForm) !== JSON.stringify(editFormFrom(editVisita));

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    if (!editVisita) return;
    if (!editForm.destinoId) {
      setEditError('Elegí un destino.');
      return;
    }
    const dur = buildDuracionPayload(editForm.dur);
    if (dur.error) {
      setEditError(dur.error);
      return;
    }
    setActionBusy(true);
    setEditError('');
    try {
      const result = await apiFetch(`/empleado/visitas/${editVisita.id}`, {
        method: 'PATCH',
        token: authToken,
        allowForbidden: true,
        body: {
          ...dur.payload,
          motivo: editForm.motivo.trim(),
          destinoId: editForm.destinoId
        }
      });
      const updated = result.visita || { ...editVisita };
      replaceVisita(updated);
      setEditVisita(null);
      if (canShowQr(updated)) {
        setReshareVisita(updated);
      } else {
        showSuccess(result.message || 'Visita modificada. Queda pendiente de aprobación.');
      }
    } catch (err) {
      const denied = hostDeniedFrom(err);
      if (denied) setHostDenied(denied);
      setEditError((denied && denied.message) || err.message || 'No se pudo guardar el cambio');
    } finally {
      setActionBusy(false);
    }
  };

  const handleResend = async () => {
    setResendBusy(true);
    setResendNote('');
    try {
      const result = await apiFetch('/auth/resend-verification', { method: 'POST', token: authToken });
      setResendNote(result.message || 'Te mandamos un mail nuevo. Revisá tu correo (y la carpeta de spam).');
    } catch (err) {
      if (err.status === 429) {
        setResendNote(err.message || RESEND_WAIT_MESSAGE);
      } else if (err.data?.code === 'ya_verificado') {
        setEmailConfirmed(true);
        setHostDenied(null);
        showSuccess('Tu mail ya está confirmado. Ya podés invitar visitas.');
      } else {
        setResendNote(err.message || 'No se pudo mandar el mail. Probá de nuevo en un rato.');
      }
    } finally {
      setResendBusy(false);
    }
  };

  const handleCancelConfirm = async () => {
    if (!cancelVisita) return;
    setActionBusy(true);
    try {
      const result = await apiFetch(`/empleado/visitas/${cancelVisita.id}/cancel`, {
        method: 'POST',
        token: authToken
      });
      replaceVisita(result.visita || { ...cancelVisita, estado: 'cancelada' });
      setCancelVisita(null);
      showSuccess(result.message || 'Visita cancelada. El QR ya no sirve para entrar.');
    } catch (err) {
      showError(err.message || 'No se pudo cancelar la visita');
    } finally {
      setActionBusy(false);
    }
  };

  const displayName = currentUser?.nombre || currentUser?.username || 'Empleado';
  function canShowQr(v) {
    return v?.estado === 'pendiente' || v?.estado === 'autorizada';
  }
  const canChange = (v) => canSubmit && HOST_EDITABLE_ESTADOS.has(v?.estado || 'pendiente');
  const needsEmailConfirm = !emailConfirmed
    && (currentUser?.emailVerified === false || hostDenied?.code === 'email_no_verificado');
  const domainDenied = hostDenied?.code === 'dominio_no_permitido' ? hostDenied : null;

  return (
    <div className="empleado-shell">
      <ConnectivityChrome />
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
          {hasPermission(currentUser, 'autorizaciones.solicitar') && (
            <Link to="/empleado/autorizaciones" className="btn btn-secondary btn-sm">
              Autorizaciones
            </Link>
          )}
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
            {needsEmailConfirm && (
              <div className="empleado-callout" role="alert">
                <strong>Confirmá tu mail para poder invitar visitas</strong>
                <p>
                  Te mandamos un link a
                  {' '}
                  {currentUser?.email || currentUser?.username || 'tu correo'}
                  . Abrilo para confirmar tu cuenta. Si no lo encontrás, revisá la carpeta de spam.
                </p>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleResend}
                  disabled={resendBusy}
                >
                  <Mail size={14} />
                  {resendBusy ? 'Enviando…' : 'Reenviar mail'}
                </button>
                {resendNote ? <p role="status">{resendNote}</p> : null}
              </div>
            )}
            {domainDenied && (
              <div className="empleado-callout empleado-callout--error" role="alert">
                <strong>No podés invitar visitas con este usuario</strong>
                <p>{domainDenied.message}</p>
              </div>
            )}
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
                  inputMode="numeric"
                  autoComplete="off"
                  pattern="[0-9]*"
                />
              </label>
              <label className="empleado-form-full">
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
              <VisitaDuracionPicker
                value={durForm}
                onChange={setDurForm}
                disabled={!destinos.length || saving}
                idPrefix="alta-dur"
                horarios={horarios}
              />
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
                return (
                  <li key={v.id}>
                    <div>
                      <strong>{v.nombreVisitante}</strong>
                      <span className="empleado-meta"> · DNI {v.dniVisitante}</span>
                    </div>
                    <div className="empleado-meta">{v.destinoNombre || v.destinoId}</div>
                    <div className="empleado-meta">{formatValidezCorta(v)}</div>
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
                      {canChange(v) && (
                        <>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => openEdit(v)}
                            aria-label={`Editar visita de ${v.nombreVisitante}`}
                          >
                            <Pencil size={14} />
                            Editar
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => setCancelVisita(v)}
                            aria-label={`Cancelar visita de ${v.nombreVisitante}`}
                          >
                            <Ban size={14} />
                            Cancelar visita
                          </button>
                        </>
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

      <Modal
        open={Boolean(editVisita)}
        title="Editar visita"
        description={editVisita ? `${editVisita.nombreVisitante}. Al guardar se genera una invitación nueva y la anterior deja de servir.` : ''}
        onClose={() => setEditVisita(null)}
        dirty={editDirty && !actionBusy}
        size="md"
        footer={(
          <>
            <button type="button" className="btn btn-secondary" disabled={actionBusy}>
              Cancelar
            </button>
            <button type="submit" form="editar-visita-form" className="btn btn-primary" disabled={actionBusy}>
              {actionBusy ? 'Guardando…' : 'Guardar cambios'}
            </button>
          </>
        )}
      >
        <form id="editar-visita-form" onSubmit={handleEditSubmit} className="empleado-form">
          {editError ? (
            <div className="empleado-callout empleado-callout--error empleado-form-full" role="alert">
              <p>{editError}</p>
            </div>
          ) : null}
          <VisitaDuracionPicker
            value={editForm.dur}
            onChange={(dur) => setEditForm((f) => ({ ...f, dur }))}
            disabled={actionBusy}
            idPrefix="editar-dur"
            horarios={horarios}
          />
          <label className="empleado-form-full">
            Destino
            <select
              className="input-field"
              value={editForm.destinoId}
              onChange={(e) => setEditForm((f) => ({ ...f, destinoId: e.target.value }))}
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
              value={editForm.motivo}
              onChange={(e) => setEditForm((f) => ({ ...f, motivo: e.target.value }))}
            />
          </label>
          {(!canCreate || editForm.dur.duracion === 'mes') && (
            <p className="empleado-hint empleado-form-full">
              Al cambiarla, la visita vuelve a quedar pendiente de aprobación.
            </p>
          )}
        </form>
      </Modal>

      <Modal
        open={Boolean(cancelVisita)}
        title="¿Cancelar esta visita?"
        onClose={() => setCancelVisita(null)}
        size="sm"
        footer={(
          <>
            <button type="button" className="btn btn-secondary" data-aui-cancel="true" disabled={actionBusy}>
              No, volver
            </button>
            <button type="button" className="btn btn-primary" onClick={handleCancelConfirm} disabled={actionBusy}>
              {actionBusy ? 'Cancelando…' : 'Sí, cancelar visita'}
            </button>
          </>
        )}
      >
        {cancelVisita ? (
          <p>
            La visita de <strong>{cancelVisita.nombreVisitante}</strong> se cancela y
            {' '}
            <strong>el QR que le mandaste deja de servir</strong>
            . Tampoco va a poder entrar con el DNI por esta visita.
          </p>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(reshareVisita)}
        title="Se generó una invitación nueva"
        onClose={() => setReshareVisita(null)}
        size="sm"
        footer={(
          <>
            <button type="button" className="btn btn-secondary" data-aui-cancel="true">
              Después
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setQrVisita(reshareVisita);
                setReshareVisita(null);
              }}
            >
              <QrCode size={16} />
              Compartir / QR
            </button>
          </>
        )}
      >
        <p>
          Volvé a compartirla con
          {' '}
          <strong>{reshareVisita?.nombreVisitante || 'el visitante'}</strong>
          : el QR y el link anteriores ya no sirven.
        </p>
      </Modal>
    </div>
  );
}

export default EmpleadoVisitasPage;
