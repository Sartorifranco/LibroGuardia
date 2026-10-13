import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PlusCircle } from 'lucide-react';
import { AdminLoading } from '../../../components/admin/AdminUi';
import { EmptyState, Modal, PageContainer, PageHeader } from '../../../components/admin-ui';
import { useAuth } from '../../../context/AuthContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { useToast } from '../../../context/ToastContext';
import { apiFetch } from '../../../services/api';
import { hasPermission } from '../../../utils/permissions';
import InstallWizard from './InstallWizard';
import { leftLabel, statusAdvice } from './installChecks';

const KIND_LABEL = {
  hub: 'Central del sitio',
  controller: 'Controlador de puertas'
};

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
  const [wizardOpen, setWizardOpen] = useState(false);
  const [install, setInstall] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState(null);
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
      setSelected(null);
      setLog(null);
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
      setSelected(null);
      setLog(null);
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

  const selectedDevice = selected
    ? (visible.find((device) => device.id === selected.id) || selected)
    : null;
  const selectedDoors = selectedDevice ? doorsOf(selectedDevice, doors) : [];
  const advice = selectedDevice ? statusAdvice(selectedDevice.health || {}) : '';

  return (
    <PageContainer width="medium">
      <div className="equipos-admin">
        <PageHeader
          title="Equipos"
          purpose="Un equipo es la cajita que abre las puertas, o la PC donde el guardia mira la pantalla."
          howTo={[
            'Tocá Instalar un equipo y seguí los pasos.',
            'El instalador escribe el código en la Raspberry o en la PC.',
            'La prueba se tilda sola cuando el equipo responde.'
          ]}
          action={(
            <button type="button" className="btn btn-primary" onClick={() => { setInstall(null); setWizardOpen(true); }}>
              <PlusCircle size={16} aria-hidden />
              Instalar un equipo
            </button>
          )}
        />
        <div>
          {loading ? <AdminLoading label="Cargando equipos…" /> : null}
          {!loading && error ? (
            <p className="alarm-panel__error" role="alert">
              {error}
              {' '}
              <button type="button" className="btn btn-secondary" onClick={load}>Reintentar</button>
            </p>
          ) : null}
          {!loading && !error && visible.length === 0 ? (
            <EmptyState
              title="Todavía no instalaste ningún equipo."
              text="Un equipo es la cajita que abre las puertas. El asistente te dice qué enchufar, aunque nunca hayas instalado uno."
              actionLabel="Instalar el primero"
              onAction={() => setWizardOpen(true)}
            />
          ) : null}
          <div className="aui-card-grid">
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
                    <button type="button" className="btn btn-secondary" onClick={() => { setLog(null); setSelected(device); }}>
                      {`Ver ${device.name}`}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <InstallWizard
          open={wizardOpen}
          onClose={() => setWizardOpen(false)}
          doors={doors}
          airlocks={airlocks}
          devices={devices}
          authToken={authToken}
          confirm={confirm}
          showError={showError}
          showSuccess={showSuccess}
          onCreated={load}
        />

        <Modal
          open={Boolean(selectedDevice)}
          size="lg"
          title={selectedDevice?.name || 'Equipo'}
          description={selectedDevice ? (KIND_LABEL[selectedDevice.kind] || 'Equipo') : ''}
          onClose={() => { setSelected(null); setLog(null); }}
          footer={(
            <button type="button" className="btn btn-secondary" data-aui-cancel="true" onClick={() => { setSelected(null); setLog(null); }}>
              Cancelar
            </button>
          )}
        >
          {selectedDevice ? (
            <>
              <p className={`equipos-health equipos-health--${selectedDevice.health?.code || 'pending'}`}>
                {selectedDevice.health?.label || 'Sin estado'}
              </p>
              {advice ? <p>{advice}</p> : null}
              {selectedDevice.kind === 'controller' ? (
                <p>
                  {selectedDoors.length
                    ? `Puertas: ${selectedDoors.map((door) => door.name).join(', ')}`
                    : 'Sin puertas asignadas'}
                </p>
              ) : null}
              <div className="equipos-admin__actions">
                <button type="button" className="btn btn-secondary" onClick={() => openLog(selectedDevice)}>
                  Ver bitácora
                </button>
                {selectedDevice.status !== 'revoked' && selectedDevice.status !== 'replaced' ? (
                  <>
                    <button type="button" className="btn btn-secondary" onClick={() => replaceDevice(selectedDevice)}>
                      Reemplazar
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={() => revokeDevice(selectedDevice)}>
                      Dar de baja
                    </button>
                  </>
                ) : null}
              </div>
              {log ? (
                <section aria-label="Bitácora del equipo">
                  <h3 className="aui-section-title">Bitácora de {log.device.name}</h3>
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
                  {log.cursor ? (
                    <button type="button" className="btn btn-secondary" onClick={moreLog}>Ver más</button>
                  ) : null}
                </section>
              ) : null}
            </>
          ) : null}
        </Modal>

        <Modal
          open={Boolean(install)}
          size="md"
          title={install?.deviceName || 'Código de instalación'}
          description="En la Raspberry/PC abrí el instalador y escribí este código."
          onClose={() => setInstall(null)}
          footer={(
            <>
              <button type="button" className="btn btn-secondary" data-aui-cancel="true" onClick={() => setInstall(null)}>
                Cancelar
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setInstall(null)}>Listo</button>
            </>
          )}
        >
          {install ? (
            <>
              <p className="equipos-code">{install.code}</p>
              <p className="equipos-admin__timer" aria-live="polite">
                {leftLabel(install.expiresAt, now) === 'Venció'
                  ? 'El código venció. Generá otro.'
                  : `Tiempo restante: ${leftLabel(install.expiresAt, now)}`}
              </p>
              <button type="button" className="btn btn-secondary" onClick={reissue}>Generar otro</button>
            </>
          ) : null}
        </Modal>
      </div>
    </PageContainer>
  );
}

export default EquiposAdminSection;
