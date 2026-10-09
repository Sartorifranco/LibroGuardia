import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PlusCircle } from 'lucide-react';
import { AdminBlock, AdminEmpty, AdminLoading } from '../../../components/admin/AdminUi';
import { useAuth } from '../../../context/AuthContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { useToast } from '../../../context/ToastContext';
import { apiFetch } from '../../../services/api';
import { hasPermission } from '../../../utils/permissions';
import { airlockWarning, doorMoveWarnings } from './deviceDoorRules';

const KIND_LABEL = {
  hub: 'Central del sitio',
  controller: 'Controlador de puertas'
};

function leftLabel(expiresAt, now) {
  const left = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(left) || left <= 0) return 'Venció';
  const total = Math.ceil(left / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function doorsOf(device, doors) {
  return doors.filter((door) => (
    door.controllerId === device.id || (device.doorIds || []).includes(door.id)
  ));
}

function EquiposAdminSection() {
  const { authToken, currentUser } = useAuth();
  const { confirm } = useConfirm();
  const { showError, showSuccess } = useToast();
  const canManage = hasPermission(currentUser, 'lectores.manage');
  const [devices, setDevices] = useState([]);
  const [doors, setDoors] = useState([]);
  const [airlocks, setAirlocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [wizard, setWizard] = useState(null);
  const [install, setInstall] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [log, setLog] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch('/admin/devices', { token: authToken });
      setDevices(Array.isArray(data?.devices) ? data.devices : []);
      setDoors(Array.isArray(data?.doors) ? data.doors : []);
      setAirlocks(Array.isArray(data?.airlocks) ? data.airlocks : []);
    } catch (err) {
      setError(err.message || 'No se pudieron cargar los equipos');
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!install?.expiresAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [install?.expiresAt]);

  const visible = useMemo(
    () => devices.filter((device) => device.status !== 'replaced'),
    [devices]
  );

  const openWizard = () => {
    setInstall(null);
    setWizard({ step: 1, kind: 'controller', name: '', doorIds: [], error: '' });
  };

  const createDevice = async (confirmMoves) => {
    const body = {
      kind: wizard.kind,
      name: wizard.name.trim(),
      doorIds: wizard.kind === 'controller' ? wizard.doorIds : [],
      confirmMoves: Boolean(confirmMoves)
    };
    const data = await apiFetch('/admin/devices', { method: 'POST', token: authToken, body });
    setInstall({
      deviceId: data.device.id,
      deviceName: data.device.name,
      code: data.enrollment.code,
      expiresAt: data.enrollment.expiresAt
    });
    setWizard(null);
    showSuccess('Equipo creado. Anotá el código: vence en 10 minutos.');
    await load();
  };

  const goNext = async () => {
    if (!wizard) return;
    if (wizard.step === 1) {
      if (!wizard.name.trim()) {
        setWizard({ ...wizard, error: 'Poné un nombre para reconocerlo.' });
        return;
      }
      if (wizard.kind === 'hub') {
        try {
          await createDevice(false);
        } catch (err) {
          setWizard({ ...wizard, error: err.message || 'No se pudo crear el equipo' });
        }
        return;
      }
      setWizard({ ...wizard, step: 2, error: '' });
      return;
    }
    const warning = airlockWarning(wizard.doorIds, airlocks, doors);
    if (warning) {
      setWizard({ ...wizard, error: '' });
      return;
    }
    const moves = doorMoveWarnings(wizard.doorIds, doors, devices);
    if (moves.length) {
      const ok = await confirm({
        title: 'Esta puerta cambia de equipo',
        message: moves.map((move) => move.message).join(' '),
        confirmLabel: 'Pasar las puertas',
        cancelLabel: 'Cancelar'
      });
      if (!ok) return;
    }
    try {
      await createDevice(moves.length > 0);
    } catch (err) {
      if (err.status === 409 && err.data?.code === 'DOOR_MOVE_CONFIRM') {
        const ok = await confirm({
          title: 'Esta puerta cambia de equipo',
          message: err.data.message || err.message,
          confirmLabel: 'Pasar las puertas',
          cancelLabel: 'Cancelar'
        });
        if (!ok) return;
        try {
          await createDevice(true);
        } catch (retryErr) {
          setWizard({ ...wizard, error: retryErr.message || 'No se pudo crear el equipo' });
        }
        return;
      }
      setWizard({ ...wizard, error: err.message || 'No se pudo crear el equipo' });
    }
  };

  const reissue = async () => {
    if (!install?.deviceId) return;
    try {
      const data = await apiFetch(`/admin/devices/${install.deviceId}/enrollment`, {
        method: 'POST',
        token: authToken,
        body: {}
      });
      setInstall({
        ...install,
        code: data.enrollment.code,
        expiresAt: data.enrollment.expiresAt
      });
      setNow(Date.now());
    } catch (err) {
      showError(err.message || 'No se pudo generar otro código');
    }
  };

  const replaceDevice = async (device) => {
    const ok = await confirm({
      title: 'Reemplazar equipo',
      message: 'Las puertas quedan en el equipo nuevo. Vas a ver un código para instalarlo.',
      confirmLabel: 'Reemplazar',
      cancelLabel: 'Cancelar'
    });
    if (!ok) return;
    try {
      const data = await apiFetch(`/admin/devices/${device.id}/replace`, {
        method: 'POST',
        token: authToken,
        body: {}
      });
      setWizard(null);
      setInstall({
        deviceId: data.device.id,
        deviceName: data.device.name,
        code: data.enrollment.code,
        expiresAt: data.enrollment.expiresAt
      });
      showSuccess('Listo. Instalá el equipo nuevo con este código.');
      await load();
    } catch (err) {
      showError(err.message || 'No se pudo reemplazar el equipo');
    }
  };

  const revokeDevice = async (device) => {
    const ok = await confirm({
      title: 'Dar de baja',
      message: `${device.name} deja de funcionar. Las puertas quedan sin ese equipo.`,
      confirmLabel: 'Dar de baja',
      cancelLabel: 'Cancelar'
    });
    if (!ok) return;
    try {
      await apiFetch(`/admin/devices/${device.id}/revoke`, { method: 'POST', token: authToken, body: {} });
      showSuccess('Equipo dado de baja.');
      await load();
    } catch (err) {
      showError(err.message || 'No se pudo dar de baja el equipo');
    }
  };

  const openLog = async (device) => {
    setLog({ device, events: [], cursor: null, loading: true, error: '' });
    try {
      const data = await apiFetch(`/admin/devices/${device.id}/log?limit=20`, { token: authToken });
      setLog({
        device,
        events: data.events || [],
        cursor: data.nextCursor || null,
        loading: false,
        error: ''
      });
    } catch (err) {
      setLog({ device, events: [], cursor: null, loading: false, error: err.message || 'No se pudo leer la bitácora' });
    }
  };

  const moreLog = async () => {
    if (!log?.cursor || !log.device) return;
    try {
      const data = await apiFetch(
        `/admin/devices/${log.device.id}/log?limit=20&cursor=${encodeURIComponent(log.cursor)}`,
        { token: authToken }
      );
      setLog({
        ...log,
        events: [...log.events, ...(data.events || [])],
        cursor: data.nextCursor || null
      });
    } catch (err) {
      showError(err.message || 'No se pudo leer la bitácora');
    }
  };

  if (!canManage) {
    return <p className="theme-section-desc">No tenés permiso para administrar equipos.</p>;
  }

  const moveHints = wizard?.step === 2 ? doorMoveWarnings(wizard.doorIds, doors, devices) : [];
  const splitHint = wizard?.step === 2 ? airlockWarning(wizard.doorIds, airlocks, doors) : '';

  return (
    <div className="equipos-admin">
      <AdminBlock
        title="Equipos"
        description="La central del sitio y los controladores de puertas."
        action={(
          <button type="button" className="btn btn-primary" onClick={openWizard}>
            <PlusCircle size={16} aria-hidden />
            Agregar equipo
          </button>
        )}
      >
        {loading ? <AdminLoading label="Cargando equipos…" /> : null}
        {!loading && error ? (
          <p className="alarm-panel__error" role="alert">
            {error}
            {' '}
            <button type="button" className="btn btn-secondary" onClick={load}>Reintentar</button>
          </p>
        ) : null}
        {!loading && !error && visible.length === 0 ? (
          <AdminEmpty
            title="Todavía no hay equipos"
            description="Agregá la central del sitio o un controlador de puertas."
          />
        ) : null}
        <div className="equipos-admin__list">
          {visible.map((device) => {
            const health = device.health || { code: 'pending', label: 'Pendiente de instalar', detail: null };
            const ownDoors = doorsOf(device, doors);
            return (
              <article key={device.id} className="equipos-admin__card">
                <header>
                  <h4>{device.name}</h4>
                  <p>{KIND_LABEL[device.kind] || 'Equipo'}</p>
                </header>
                <p className={`equipos-health equipos-health--${health.code}`}>{health.label}</p>
                {health.detail ? <p>{health.detail}</p> : null}
                {health.configLabel ? <p className="equipos-admin__config">{health.configLabel}</p> : null}
                {device.kind === 'controller' ? (
                  <p className="equipos-admin__doors">
                    {ownDoors.length
                      ? `Puertas: ${ownDoors.map((door) => door.name).join(', ')}`
                      : 'Sin puertas asignadas'}
                  </p>
                ) : null}
                <div className="equipos-admin__actions">
                  <button type="button" className="btn btn-secondary" onClick={() => openLog(device)}>
                    Ver bitácora
                  </button>
                  {device.status !== 'revoked' && device.status !== 'replaced' ? (
                    <>
                      <button type="button" className="btn btn-secondary" onClick={() => replaceDevice(device)}>
                        Reemplazar
                      </button>
                      <button type="button" className="btn btn-secondary" onClick={() => revokeDevice(device)}>
                        Dar de baja
                      </button>
                    </>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </AdminBlock>

      {wizard ? (
        <form
          className="equipos-admin__wizard"
          onSubmit={(event) => { event.preventDefault(); goNext(); }}
        >
          <h4>
            {wizard.step === 1 && '1. Qué equipo es'}
            {wizard.step === 2 && '2. Qué puertas maneja'}
          </h4>
          {wizard.step === 1 ? (
            <>
              <fieldset>
                <legend>Tipo</legend>
                <label className="equipos-admin__choice">
                  <input
                    type="radio"
                    name="kind"
                    checked={wizard.kind === 'hub'}
                    onChange={() => setWizard({ ...wizard, kind: 'hub', error: '' })}
                  />
                  Central del sitio
                </label>
                <label className="equipos-admin__choice">
                  <input
                    type="radio"
                    name="kind"
                    checked={wizard.kind === 'controller'}
                    onChange={() => setWizard({ ...wizard, kind: 'controller', error: '' })}
                  />
                  Controlador de puertas
                </label>
              </fieldset>
              <label>
                Nombre
                <input
                  aria-label="Nombre del equipo"
                  value={wizard.name}
                  maxLength={80}
                  onChange={(e) => setWizard({ ...wizard, name: e.target.value, error: '' })}
                />
              </label>
            </>
          ) : null}
          {wizard.step === 2 ? (
            <>
              {doors.length === 0 ? (
                <p>Primero cargá las puertas. Después volvé para asignarlas.</p>
              ) : (
                <fieldset>
                  <legend>Puertas</legend>
                  {doors.map((door) => (
                    <label key={door.id} className="equipos-admin__choice">
                      <input
                        type="checkbox"
                        checked={wizard.doorIds.includes(door.id)}
                        onChange={(e) => {
                          const doorIds = e.target.checked
                            ? [...wizard.doorIds, door.id]
                            : wizard.doorIds.filter((id) => id !== door.id);
                          setWizard({ ...wizard, doorIds, error: '' });
                        }}
                      />
                      {door.name}
                      {door.groupName ? ` · estanco ${door.groupName}` : ''}
                    </label>
                  ))}
                </fieldset>
              )}
              {splitHint ? <p className="alarm-panel__error" role="alert">{splitHint}</p> : null}
              {moveHints.map((move) => (
                <p key={move.doorId} className="equipos-admin__move" role="status">{move.message}</p>
              ))}
            </>
          ) : null}
          {wizard.error ? <p className="alarm-panel__error" role="alert">{wizard.error}</p> : null}
          <div className="equipos-admin__actions">
            <button type="button" className="btn btn-secondary" onClick={() => setWizard(null)}>
              Cancelar
            </button>
            {wizard.step === 2 ? (
              <button type="button" className="btn btn-secondary" onClick={() => setWizard({ ...wizard, step: 1, error: '' })}>
                Atrás
              </button>
            ) : null}
            <button type="submit" className="btn btn-primary">
              {wizard.step === 2 || wizard.kind === 'hub' ? 'Crear código de instalación' : 'Siguiente'}
            </button>
          </div>
        </form>
      ) : null}

      {install ? (
        <section className="equipos-admin__code" aria-label="Código de instalación">
          <h4>{install.deviceName}</h4>
          <p className="equipos-code">{install.code}</p>
          <p>En el equipo ejecutá el instalador y escribí este código. Vence en 10 minutos.</p>
          <p className="equipos-admin__timer" aria-live="polite">
            {leftLabel(install.expiresAt, now) === 'Venció'
              ? 'El código venció. Generá otro.'
              : `Tiempo restante: ${leftLabel(install.expiresAt, now)}`}
          </p>
          <div className="equipos-admin__actions">
            <button type="button" className="btn btn-secondary" onClick={reissue}>
              Generar otro código
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setInstall(null)}>
              Listo
            </button>
          </div>
        </section>
      ) : null}

      {log ? (
        <section className="equipos-admin__log" aria-label="Bitácora del equipo">
          <h4>Bitácora de {log.device.name}</h4>
          {log.loading ? <AdminLoading label="Cargando bitácora…" /> : null}
          {log.error ? <p className="alarm-panel__error" role="alert">{log.error}</p> : null}
          {!log.loading && !log.error && log.events.length === 0 ? (
            <p>Todavía no hay movimientos de este equipo.</p>
          ) : null}
          <ul>
            {log.events.map((event) => (
              <li key={event.id}>{event.message}</li>
            ))}
          </ul>
          <div className="equipos-admin__actions">
            {log.cursor ? (
              <button type="button" className="btn btn-secondary" onClick={moreLog}>Ver más</button>
            ) : null}
            <button type="button" className="btn btn-secondary" onClick={() => setLog(null)}>Cerrar</button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export default EquiposAdminSection;
