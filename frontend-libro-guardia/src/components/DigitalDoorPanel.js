import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DoorOpen,
  CircleHelp,
  Loader2,
  Radio,
  KeyRound,
  CreditCard,
  ScanFace,
  Hand
} from 'lucide-react';
import { hasPermission } from '../utils/permissions';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { useToast } from '../context/ToastContext';
import { apiFetch } from '../services/api';
import { openManualDoor } from '../utils/openManualDoor';
import {
  HOTKEY_SLOTS,
  loadDoorHotkeys,
  setDoorHotkeySlot,
  clearDoorHotkeys
} from '../utils/doorHotkeys';
import { handleDoorHotkeyOpen } from '../utils/handleDoorHotkeyOpen';

const AUTH_METHOD_META = {
  dni: { label: 'DNI', icon: KeyRound },
  credential: { label: 'Credencial', icon: CreditCard },
  face: { label: 'Rostro', icon: ScanFace },
  manual: { label: 'Manual', icon: Hand }
};

function formatAgo(iso) {
  if (!iso) return 'Sin disparos registrados';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'Sin disparos registrados';
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 60) return `hace ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `hace ${min} min`;
  const hrs = Math.round(min / 60);
  if (hrs < 48) return `hace ${hrs} h`;
  const days = Math.round(hrs / 24);
  return `hace ${days} d`;
}

function DigitalDoorPanel({
  profile = 'guardia',
  canManualOpen = false,
  compact = false,
  pollSeconds = 20
}) {
  const { authToken, currentUser } = useAuth();
  const { confirm } = useConfirm();
  const { showSuccess, showError } = useToast();
  const [doors, setDoors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [hotkeys, setHotkeys] = useState(() => loadDoorHotkeys());
  const [assignSlot, setAssignSlot] = useState(null);

  const allowed = canManualOpen || hasPermission(currentUser, 'access.manual_open');

  const title = profile === 'guardia'
    ? 'Puertas — puesto Guardia'
    : profile === 'monitoreo'
      ? 'Puertas — puesto Monitoreo'
      : 'Puertas';

  const reload = useCallback(async () => {
    if (!authToken || !allowed) return;
    try {
      const data = await apiFetch('/guard/doors', { token: authToken, allowForbidden: true });
      const list = (data.doors || []).filter((d) => d.manualOpenAllowed !== false && d.active !== false);
      setDoors(list);
      setLoadError(list.length ? '' : 'No hay puertas activas con apertura manual.');
    } catch (err) {
      setLoadError(err.message || 'No se pudieron cargar las puertas');
    } finally {
      setLoading(false);
    }
  }, [authToken, allowed]);

  useEffect(() => {
    reload();
    if (!pollSeconds || pollSeconds < 5) return undefined;
    const id = setInterval(reload, pollSeconds * 1000);
    return () => clearInterval(id);
  }, [reload, pollSeconds]);

  const openDoor = useCallback(async (door, { fromHotkey = false } = {}) => {
    if (!door?.id || openingId) return;
    const label = door.name || door.id;
    const ok = await confirm({
      title: fromHotkey ? 'Apertura por atajo' : 'Apertura manual',
      message: `¿Abrir ${label} manualmente? Se enviará el pulso al relé.`,
      confirmLabel: 'Abrir puerta',
      tone: 'default'
    });
    if (!ok) return;
    setOpeningId(door.id);
    try {
      const data = await openManualDoor({ authToken, doorId: door.id });
      showSuccess(data.message || `${label} abierta`);
      reload();
    } catch (err) {
      showError(err.message || 'Error al abrir la puerta');
    } finally {
      setOpeningId(null);
    }
  }, [authToken, confirm, openingId, reload, showError, showSuccess]);

  useEffect(() => {
    if (!allowed) return undefined;
    const onKey = async (event) => {
      const result = await handleDoorHotkeyOpen({
        event,
        authToken,
        doors,
        hotkeys,
        confirmFn: confirm,
        skipConfirm: false
      });
      if (!result.handled) return;
      if (result.cancelled) return;
      if (result.error) {
        showError(result.error);
        return;
      }
      if (result.result) {
        const door = doors.find((d) => d.id === result.doorId);
        showSuccess(result.result.message || `${door?.name || result.doorId} abierta`);
        reload();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [allowed, authToken, doors, hotkeys, confirm, showError, showSuccess, reload]);

  const slotByDoorId = useMemo(() => {
    const map = {};
    Object.entries(hotkeys).forEach(([slot, id]) => {
      map[id] = Number(slot);
    });
    return map;
  }, [hotkeys]);

  const assignDoorToSlot = (doorId) => {
    if (!assignSlot) return;
    const next = setDoorHotkeySlot(assignSlot, doorId);
    setHotkeys(next);
    setAssignSlot(null);
    showSuccess(`Ctrl+Alt+${assignSlot} → puerta asignada`);
  };

  if (!allowed) {
    return (
      <section className="control-doors">
        <p className="control-doors__hint">Sin permiso de apertura manual (`access.manual_open`).</p>
      </section>
    );
  }

  return (
    <section className={`control-doors${compact ? ' control-doors--compact' : ''}`}>
      <div className="control-doors__header">
        <div>
          <h3>{title}</h3>
          <p>
            Apertura manual y último disparo del relé.
            No hay sensor de posición física de hoja; el estado mostrado es el del último pulso.
          </p>
        </div>
        <button
          type="button"
          className="control-doors__help-btn"
          onClick={() => setHelpOpen(true)}
          title="Atajos de teclado"
          aria-label="Ayuda de atajos de puertas"
        >
          <CircleHelp size={18} />
        </button>
      </div>

      {loading && (
        <div className="control-doors__loading">
          <Loader2 className="animate-spin" size={18} /> Cargando puertas…
        </div>
      )}
      {loadError && !doors.length && <p className="control-doors__error">{loadError}</p>}

      <div className="control-doors__grid">
        {doors.map((door) => {
          const methods = Array.isArray(door.authMethods) && door.authMethods.length
            ? door.authMethods
            : ['dni'];
          const pulse = door.lastPulse;
          const slot = slotByDoorId[door.id];
          return (
            <article key={door.id} className="control-door-card">
              <div className="control-door-card__top">
                <DoorOpen size={20} />
                <div>
                  <h4>{door.name || door.id}</h4>
                  {slot ? (
                    <span className="control-door-card__hotkey">Ctrl+Alt+{slot}</span>
                  ) : null}
                </div>
              </div>
              <div className="control-door-card__methods">
                {methods.map((m) => {
                  const meta = AUTH_METHOD_META[m] || { label: m, icon: Radio };
                  const Icon = meta.icon;
                  return (
                    <span key={m} className="control-door-method">
                      <Icon size={12} /> {meta.label}
                    </span>
                  );
                })}
              </div>
              <p className={`control-door-card__pulse${pulse?.ok === false ? ' is-error' : pulse?.ok ? ' is-ok' : ''}`}>
                {pulse
                  ? (
                    <>
                      Último disparo {formatAgo(pulse.at)}
                      {' · '}
                      {pulse.ok ? 'OK' : 'Con error'}
                    </>
                  )
                  : 'Sin disparos registrados'}
              </p>
              <div className="control-door-card__actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={Boolean(openingId)}
                  onClick={() => openDoor(door)}
                >
                  {openingId === door.id ? 'Abriendo…' : 'Abrir'}
                </button>
                {assignSlot && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => assignDoorToSlot(door.id)}
                  >
                    Asignar a Ctrl+Alt+{assignSlot}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {helpOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="door-hotkeys-title">
          <div className="modal-content control-hotkeys-modal">
            <h2 id="door-hotkeys-title">Atajos de puertas</h2>
            <p>
              Usá <strong>Ctrl+Alt+1</strong> … <strong>Ctrl+Alt+9</strong> para abrir hasta 9 puertas favoritas.
              La preferencia se guarda solo en este navegador.
            </p>
            <ul className="control-hotkeys-list">
              {HOTKEY_SLOTS.map((slot) => {
                const doorId = hotkeys[String(slot)];
                const door = doors.find((d) => d.id === doorId);
                return (
                  <li key={slot}>
                    <span className="control-hotkeys-kbd">Ctrl+Alt+{slot}</span>
                    <span>{door ? (door.name || door.id) : '— sin asignar —'}</span>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        setAssignSlot(slot);
                        setHelpOpen(false);
                        showSuccess(`Elegí una puerta para Ctrl+Alt+${slot}`);
                      }}
                    >
                      {door ? 'Cambiar' : 'Asignar'}
                    </button>
                    {door && (
                      <button
                        type="button"
                        className="btn-logout-link"
                        onClick={() => {
                          const next = setDoorHotkeySlot(slot, null);
                          setHotkeys(next);
                        }}
                      >
                        Quitar
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="control-hotkeys-footer">
              <button
                type="button"
                className="btn-logout-link"
                onClick={() => {
                  clearDoorHotkeys();
                  setHotkeys({});
                }}
              >
                Borrar todos los atajos
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setHelpOpen(false)}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default DigitalDoorPanel;
