import React, { useCallback, useEffect, useMemo, useState } from 'react';

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

import { apiFetch } from '../services/api';

import { openManualDoor } from '../utils/openManualDoor';

import { openBotoneraWindow } from '../utils/openBotoneraWindow';

import {

  HOTKEY_SLOTS,

  loadDoorHotkeys,

  setDoorHotkeySlot,

  clearDoorHotkeys

} from '../utils/doorHotkeys';

import { handleDoorHotkeyOpen } from '../utils/handleDoorHotkeyOpen';

import {

  cacheGuardDoors,

  loadCachedGuardDoors,

  probeLocalStationsForDoors,

  mergeStationStatusIntoDoors

} from '../utils/localStationClient';



const AUTH_METHOD_META = {

  dni: { label: 'DNI', icon: KeyRound },

  credential: { label: 'Credencial', icon: CreditCard },

  face: { label: 'Rostro', icon: ScanFace },

  manual: { label: 'Manual', icon: Hand }

};



function formatAgo(iso) {

  if (!iso) return 'Sin disparos';

  const then = new Date(iso).getTime();

  if (Number.isNaN(then)) return 'Sin disparos';

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

  pollSeconds = 20,

  /** Modo botonera: tarjetas grandes táctiles para el puesto de guardia. */

  botoneraMode = false,

  /** Ventana dedicada (sin chrome del sistema). */

  standaloneWindow = false

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

  /** 'cloud' | 'local-fallback' | 'offline' */

  const [connectivityMode, setConnectivityMode] = useState('cloud');



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

      cacheGuardDoors(list);

      setConnectivityMode('cloud');

      setLoadError(list.length ? '' : 'No hay puertas activas con apertura manual.');

    } catch (err) {

      const cached = loadCachedGuardDoors();

      const cachedDoors = (cached?.doors || []).filter(

        (d) => d.manualOpenAllowed !== false && d.active !== false

      );

      if (cachedDoors.length) {

        try {

          const probes = await probeLocalStationsForDoors(cachedDoors);

          const anyOk = probes.some((p) => p.ok);

          const merged = mergeStationStatusIntoDoors(cachedDoors, probes);

          setDoors(merged);

          setConnectivityMode(anyOk ? 'local-fallback' : 'offline');

          setLoadError(anyOk

            ? ''

            : 'Sin internet y ninguna estación local respondió. Revisá la red de planta.');

        } catch (probeErr) {

          setDoors(cachedDoors);

          setConnectivityMode('offline');

          setLoadError(probeErr.message || 'Sin internet ni estaciones locales');

        }

      } else {

        setDoors([]);

        setConnectivityMode('offline');

        setLoadError(err.message || 'No se pudieron cargar las puertas');

      }

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

      const forceLocal = connectivityMode === 'local-fallback' || connectivityMode === 'offline';

      const data = await openManualDoor({

        authToken,

        doorId: door.id,

        door,

        forceLocal

      });

      const viaNote = data.via === 'local'

        ? ' (red local)'

        : ` (vía nube${data.relay?.via ? `/${data.relay.via}` : ''})`;

      showSuccess((data.message || `${label} abierta`) + viaNote);

      reload();

    } catch (err) {

      showError(err.message || 'Error al abrir la puerta');

    } finally {

      setOpeningId(null);

    }

  }, [authToken, confirm, openingId, reload, showError, showSuccess, connectivityMode]);



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

        const viaNote = result.result.via === 'local' ? ' (red local)' : '';

        showSuccess((result.result.message || `${door?.name || result.doorId} abierta`) + viaNote);

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



  const connectivityLabel = connectivityMode === 'cloud'

    ? 'En línea'

    : connectivityMode === 'local-fallback'

      ? 'Red local'

      : 'Sin conexión';



  return (

    <section className={`control-doors${compact ? ' control-doors--compact' : ''}${connectivityMode !== 'cloud' ? ' control-doors--local' : ''}${botoneraMode ? ' control-doors--botonera' : ''}${standaloneWindow ? ' control-doors--standalone' : ''}`}>

      <div className="control-doors__header">

        <div>

          <h3>{botoneraMode ? 'Botonera' : title}</h3>

          <p>

            {botoneraMode

              ? (standaloneWindow

                ? 'Tocá Abrir · pensada para el puesto / segundo monitor.'

                : 'Tocá Abrir para disparar el relé.')

              : 'Apertura manual y último disparo del relé. No hay sensor de posición física de hoja; el estado mostrado es el del último pulso.'}

          </p>

        </div>

        <div className="control-doors__header-actions">

          {botoneraMode && (

            <span className={`control-doors__link-pill control-doors__link-pill--${connectivityMode}`}>

              {connectivityMode === 'cloud' ? <CheckCircle2 size={14} /> : <WifiOff size={14} />}

              {connectivityLabel}

            </span>

          )}

          {botoneraMode && !standaloneWindow && (

            <button

              type="button"

              className="control-doors__help-btn"

              onClick={() => openBotoneraWindow()}

              title="Abrir en otra ventana"

              aria-label="Abrir botonera en otra ventana"

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



      {!botoneraMode && connectivityMode === 'local-fallback' && (

        <div className="control-doors__banner control-doors__banner--local" role="status">

          <WifiOff size={16} aria-hidden />

          <span>

            Sin internet — operando por red local (estaciones en planta).

            La apertura va directo a la mini PC / Raspberry, no a la nube.

          </span>

        </div>

      )}

      {!botoneraMode && connectivityMode === 'offline' && (

        <div className="control-doors__banner control-doors__banner--offline" role="alert">

          <WifiOff size={16} aria-hidden />

          <span>

            Sin internet y sin respuesta de estaciones locales. Revisá cable/Wi‑Fi de planta.

          </span>

        </div>

      )}

      {botoneraMode && connectivityMode === 'offline' && (

        <div className="control-doors__banner control-doors__banner--offline" role="alert">

          <WifiOff size={16} aria-hidden />

          <span>Sin conexión a planta. Revisá la red antes de abrir.</span>

        </div>

      )}



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

          const pulseOk = pulse?.ok === true;

          const pulseErr = pulse?.ok === false;

          if (botoneraMode) {

            return (

              <article

                key={door.id}

                className={`control-door-card control-door-card--botonera${door.isMainEntryDoor ? ' is-main-entry' : ''}${pulseErr ? ' is-pulse-error' : ''}`}

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

                    {slot ? (

                      <span className="control-door-tag">Ctrl+Alt+{slot}</span>

                    ) : null}

                  </div>

                </div>

                <div className={`control-door-card__bot-status${pulseErr ? ' is-error' : pulseOk ? ' is-ok' : ''}`}>

                  {pulseErr ? <AlertTriangle size={14} /> : pulseOk ? <CheckCircle2 size={14} /> : <Radio size={14} />}

                  <span>

                    {pulse

                      ? `Último disparo ${formatAgo(pulse.at)} · ${pulseOk ? 'OK' : 'Error'}`

                      : 'Sin disparos aún'}

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

                  {slot ? (

                    <span className="control-door-card__hotkey">Ctrl+Alt+{slot}</span>

                  ) : null}

                  {door.relayMode === 'local' && door.localStation ? (

                    <span className="control-door-card__local">

                      LAN ·

                      {' '}

                      {door.localStation.direccionRedLocal}

                    </span>

                  ) : null}

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

              <p className={`control-door-card__pulse${pulseErr ? ' is-error' : pulseOk ? ' is-ok' : ''}`}>

                {pulse

                  ? (

                    <>

                      Último disparo {formatAgo(pulse.at)}

                      {' · '}

                      {pulseOk ? 'OK' : 'Con error'}

                    </>

                  )

                  : 'Sin disparos registrados'}

              </p>

              {door.localReader && (

                <p className="control-door-card__local-status">

                  Lector local:

                  {' '}

                  {door.localReader.connected ? 'conectado' : 'desconectado'}

                  {door.localReader.allowlistFresh === false ? ' · caché vencida' : ''}

                </p>

              )}

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


