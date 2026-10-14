import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DoorOpen,
  CircleHelp,
  ExternalLink,
  Loader2,
  Radio,
  KeyRound,
  CreditCard,
  ScanFace,
  Hand,
  WifiOff,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';
import { hasPermission } from '../utils/permissions';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { useToast } from '../context/ToastContext';
import { useRuntime } from '../context/RuntimeContext';
import { useHubLive } from '../context/HubLiveContext';
import { apiFetch } from '../services/api';
import usePolling from '../hooks/usePolling';
import { openManualDoorWithAirlock } from '../utils/openManualDoor';
import { openControllerDoor } from '../utils/remoteDoorOpen';
import { doorOpenUserMessage, lastPulseStatusWord } from '../utils/doorOpenStatus';
import { applyDoorLiveEvent, doorLivePresentation } from '../utils/doorLiveState';
import { openBotoneraWindow } from '../utils/openBotoneraWindow';
import GuardSitePlan, { hasMapPos, loadGuardSitePlan } from './GuardSitePlan';
import {
  HOTKEY_SLOTS,
  loadDoorHotkeys,
  setDoorHotkeySlot,
  clearDoorHotkeys,
  hotkeySlotFromEvent
} from '../utils/doorHotkeys';

const AUTH_METHOD_META = {
  dni: { label: 'DNI', icon: KeyRound },
  credential: { label: 'Credencial', icon: CreditCard },
  face: { label: 'Rostro', icon: ScanFace },
  manual: { label: 'Manual', icon: Hand }
};

const CLOUD_MIN_POLL_SECONDS = 120;
const VIEW_KEY = 'mss-guard-doors-view';

function readSavedView() {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'plan' ? 'plan' : 'list';
  } catch {
    return 'list';
  }
}

function saveView(view) {
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Sin localStorage: la elección dura hasta recargar.
  }
}

function formatAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 60) return `hace ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `hace ${min} min`;
  const hrs = Math.round(min / 60);
  if (hrs < 48) return `hace ${hrs} h`;
  const days = Math.round(hrs / 24);
  return `hace ${days} d`;
}

function pulseLine(door) {
  const pulse = door.lastPulse;
  const pulseWord = lastPulseStatusWord(pulse);
  if (!pulse) return { text: 'Todavía no se pidió abrir', tone: 'neutral' };
  const tone = pulseWord === 'Error' ? 'danger' : pulseWord === 'Abierta' ? 'ok' : 'neutral';
  return { text: `Último pedido ${formatAgo(pulse.at)} · ${pulseWord}`, tone };
}

function statusOf(door, phase) {
  if (phase?.text) return phase;
  const live = doorLivePresentation(door);
  if (live.hasLive) {
    return { text: live.label, tone: live.tone, reason: live.reason };
  }
  return pulseLine(door);
}

function DigitalDoorPanel({
  profile = 'guardia',
  canManualOpen = false,
  compact = false,
  pollSeconds = 20,
  botoneraMode = false,
  standaloneWindow = false
}) {
  const { authToken, currentUser } = useAuth();
  const { confirm, confirmWithReason } = useConfirm();
  const { showSuccess, showError } = useToast();
  const { mode, configVersion } = useRuntime();
  const { connected, subscribe } = useHubLive();
  const [doors, setDoors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState(null);
  const openingLockRef = useRef(false);
  const [loadError, setLoadError] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [hotkeys, setHotkeys] = useState(() => loadDoorHotkeys());
  const [assignSlot, setAssignSlot] = useState(null);
  const [connectivityMode, setConnectivityMode] = useState('cloud');
  const [openPhase, setOpenPhase] = useState({});
  const [sitePlan, setSitePlan] = useState(null);
  const [view, setView] = useState(readSavedView);

  const allowed = canManualOpen || hasPermission(currentUser, 'access.manual_open');
  const lan = mode === 'lan';
  const planAvailable = Boolean(sitePlan) && doors.some(hasMapPos);
  const showPlan = planAvailable && view === 'plan';

  const chooseView = (next) => {
    setView(next);
    saveView(next);
  };

  useEffect(() => {
    if (!authToken || !allowed || lan) return undefined;
    let cancelled = false;
    loadGuardSitePlan(authToken)
      .then((plan) => { if (!cancelled) setSitePlan(plan); })
      .catch(() => { if (!cancelled) setSitePlan(null); });
    return () => { cancelled = true; };
  }, [authToken, allowed, lan]);

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
      setConnectivityMode('cloud');
      setLoadError(list.length ? '' : 'No hay puertas activas con apertura manual.');
    } catch (err) {
      setConnectivityMode('offline');
      setLoadError(err.message || 'No se pudieron cargar las puertas');
    } finally {
      setLoading(false);
    }
  }, [authToken, allowed]);

  useEffect(() => {
    if (!lan) return undefined;
    return subscribe((event) => {
      if (event.type !== 'door') return;
      setDoors((prev) => applyDoorLiveEvent(prev, event.data));
    });
  }, [lan, subscribe]);

  useEffect(() => {
    reload();
  }, [reload, configVersion]);

  // LAN con el hub conectado: el estado llega por SSE. LAN sin SSE: el hub local cada 15 s.
  // Nube: no menos de 2 min (las aperturas propias ya actualizan la lista). Pausado con la
  // pestaña oculta y refresca al volver.
  const pollMs = lan
    ? (connected ? 0 : 15000)
    : Math.max(Number(pollSeconds) || 0, CLOUD_MIN_POLL_SECONDS) * 1000;
  usePolling(reload, pollMs, { enabled: pollMs > 0, immediate: false });

  const openDoor = useCallback(async (door) => {
    if (!door?.id || openingLockRef.current) return;
    openingLockRef.current = true;
    const label = door.name || door.id;
    try {
      const ok = await confirm({
        title: 'Abrir puerta',
        message: `¿Abrir la puerta ${label}?`,
        confirmLabel: 'Abrir puerta',
        tone: 'danger'
      });
      if (!ok) return;
      setOpeningId(door.id);
      const remote = mode !== 'lan' && Boolean(door.controllerId);
      try {
        if (remote) {
          setOpenPhase((prev) => ({ ...prev, [door.id]: { text: 'Enviando…', tone: 'pending' } }));
          await openControllerDoor({
            door,
            authToken,
            canForceAirlock: hasPermission(currentUser, 'puertas.estanco.forzar'),
            confirmWithReason
          });
          setOpenPhase((prev) => ({ ...prev, [door.id]: { text: 'Puerta abierta', tone: 'ok' } }));
          showSuccess(`${label}: Puerta abierta`);
        } else {
          const data = await openManualDoorWithAirlock({
            canForceAirlock: hasPermission(currentUser, 'puertas.estanco.forzar'),
            confirmWithReason,
            authToken,
            doorId: door.id,
            door,
            forceCloud: mode === 'lan',
            forceLocal: false
          });
          if (!data?.cancelled) showSuccess(doorOpenUserMessage(data, label));
        }
        reload();
      } catch (err) {
        if (err?.cancelled) return;
        if (remote) {
          const detail = err.message || 'motivo desconocido';
          const text = detail.startsWith('No se pudo abrir') ? detail : `No se pudo abrir: ${detail}`;
          setOpenPhase((prev) => ({ ...prev, [door.id]: { text, tone: 'err' } }));
          showError(text);
        } else {
          showError(err.message || 'Error al abrir la puerta');
        }
      } finally {
        setOpeningId(null);
      }
    } finally {
      openingLockRef.current = false;
    }
  }, [authToken, confirm, confirmWithReason, currentUser, mode, reload, showError, showSuccess]);

  useEffect(() => {
    if (!allowed) return undefined;
    const onKey = (event) => {
      const slot = hotkeySlotFromEvent(event);
      if (!slot) return;
      const tag = event.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return;
      const doorId = hotkeys[String(slot)];
      if (!doorId) return;
      const door = doors.find((item) => item.id === doorId);
      if (!door) return;
      event.preventDefault();
      openDoor(door);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [allowed, doors, hotkeys, openDoor]);

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
        <p className="control-doors__hint">No podés abrir puertas.</p>
      </section>
    );
  }

  const connectivityLabel = connectivityMode === 'offline' ? 'Sin conexión' : 'En línea';

  return (
    <section className={`control-doors${compact ? ' control-doors--compact' : ''}${connectivityMode !== 'cloud' ? ' control-doors--local' : ''}${botoneraMode ? ' control-doors--botonera' : ''}${standaloneWindow ? ' control-doors--standalone' : ''}`}>
      <div className="control-doors__header">
        <div>
          <h3>{botoneraMode ? 'Puertas' : title}</h3>
          <p>
            {botoneraMode
              ? (standaloneWindow
                ? 'Tocá Abrir. Pensada para el puesto o un segundo monitor.'
                : 'Tocá Abrir para abrir la puerta.')
              : (lan
                ? 'El color muestra cómo está la puerta ahora.'
                : 'Abrí la puerta desde acá. El estado es del último pedido, no de un sensor en la hoja.')}
          </p>
        </div>
        <div className="control-doors__header-actions">
          {botoneraMode && lan && (
            <span className={`control-doors__link-pill ${connected ? 'control-doors__link-pill--cloud' : 'control-doors__link-pill--local-fallback'}`}>
              {connected ? <CheckCircle2 size={14} /> : <WifiOff size={14} />}
              {connected ? 'En vivo' : 'Actualizando…'}
            </span>
          )}
          {botoneraMode && !lan && (
            <span className={`control-doors__link-pill control-doors__link-pill--${connectivityMode === 'offline' ? 'offline' : 'cloud'}`}>
              {connectivityMode === 'offline' ? <WifiOff size={14} /> : <CheckCircle2 size={14} />}
              {connectivityLabel}
            </span>
          )}
          {botoneraMode && !standaloneWindow && (
            <button
              type="button"
              className="control-doors__help-btn control-doors__popout"
              onClick={() => openBotoneraWindow()}
              title="Abrir en otra ventana"
              aria-label="Abrir en otra ventana"
            >
              <ExternalLink size={18} />
            </button>
          )}
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
      </div>

      {connectivityMode === 'offline' && (
        <div className="control-doors__banner control-doors__banner--offline" role="alert">
          <WifiOff size={16} aria-hidden />
          <span>No se pudieron actualizar las puertas. Revisá la conexión.</span>
        </div>
      )}

      {loading && (
        <div className="control-doors__loading">
          <Loader2 className="animate-spin" size={18} /> Cargando puertas…
        </div>
      )}
      {loadError && !doors.length && <p className="control-doors__error">{loadError}</p>}

      {planAvailable && (
        <div className="guard-doors-view" role="group" aria-label="Cómo ver las puertas">
          <button type="button" aria-pressed={!showPlan} onClick={() => chooseView('list')}>Lista</button>
          <button type="button" aria-pressed={showPlan} onClick={() => chooseView('plan')}>Plano</button>
        </div>
      )}

      {showPlan && (
        <GuardSitePlan
          plan={sitePlan}
          doors={doors}
          onOpenDoor={openDoor}
          openingId={openingId}
          onShowList={() => chooseView('list')}
        />
      )}

      {!showPlan && (
      <div className="control-doors__grid">
        {doors.map((door) => {
          const methods = Array.isArray(door.authMethods) && door.authMethods.length
            ? door.authMethods
            : ['dni'];
          const slot = slotByDoorId[door.id];
          const status = statusOf(door, openPhase[door.id]);
          const toneClass = status.tone && status.tone !== 'neutral' ? ` door-live--${status.tone}` : '';

          if (botoneraMode) {
            return (
              <article
                key={door.id}
                className={`control-door-card control-door-card--botonera${door.isMainEntryDoor ? ' is-main-entry' : ''}${status.tone === 'danger' || status.tone === 'err' ? ' is-pulse-error' : ''}`}
              >
                <div className="control-door-card__bot-top">
                  <div className="control-door-card__bot-title">
                    <DoorOpen size={22} aria-hidden />
                    <h4>{door.name || door.id}</h4>
                  </div>
                  <div className="control-door-card__bot-tags">
                    {door.isMainEntryDoor ? (
                      <span className="control-door-tag control-door-tag--main">Ingreso principal</span>
                    ) : null}
                    {slot ? <span className="control-door-tag">Ctrl+Alt+{slot}</span> : null}
                  </div>
                </div>
                <div className={`control-door-card__bot-status${toneClass}`} role="status">
                  {status.tone === 'danger' || status.tone === 'err'
                    ? <AlertTriangle size={14} />
                    : status.tone === 'ok'
                      ? <CheckCircle2 size={14} />
                      : <Radio size={14} />}
                  <span>
                    {status.text}
                    {status.reason ? <span className="door-live-reason">{status.reason}</span> : null}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-primary control-door-card__open-btn"
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
              </article>
            );
          }

          return (
            <article key={door.id} className="control-door-card">
              <div className="control-door-card__top">
                <DoorOpen size={20} />
                <div>
                  <h4>{door.name || door.id}</h4>
                  {slot ? <span className="control-door-card__hotkey">Ctrl+Alt+{slot}</span> : null}
                  {door.isMainEntryDoor ? (
                    <span className="control-door-card__hotkey">Ingreso principal</span>
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
              <p className={`control-door-card__pulse${toneClass}`} role="status">
                {status.text}
                {status.reason ? <span className="door-live-reason">{status.reason}</span> : null}
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
      )}

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
                        setView('list');
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
                        onClick={() => setHotkeys(setDoorHotkeySlot(slot, null))}
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
