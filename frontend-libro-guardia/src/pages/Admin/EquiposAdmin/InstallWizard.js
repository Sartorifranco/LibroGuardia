import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AdvancedSection, WizardModal } from '../../../components/admin-ui';
import { apiFetch } from '../../../services/api';
import { openDoorRemote } from '../../../utils/remoteDoorOpen';
import { airlockWarning, doorMoveWarnings } from './deviceDoorRules';
import { INSTALL_POLL_MS, installProbe, leftLabel } from './installChecks';

const PARTS = new Set(['reader', 'relay', 'sensor', 'fingerprint']);

const PICKS = [
  {
    id: 'controller',
    group: 'equipo',
    title: 'Controlador de puertas (Raspberry o PC)',
    text: 'La cajita que decide y abre 1 o 2 puertas.'
  },
  {
    id: 'hub',
    group: 'equipo',
    title: 'Central del sitio',
    text: 'La PC que junta todo y muestra la pantalla del guardia (una por predio).'
  },
  {
    id: 'reader',
    group: 'parte',
    title: 'Lector de DNI/QR',
    text: 'Se enchufa al controlador. Lee el documento o el código.'
  },
  {
    id: 'relay',
    group: 'parte',
    title: 'Placa de relé',
    text: 'La que abre la cerradura.'
  },
  {
    id: 'sensor',
    group: 'parte',
    title: 'Sensor de puerta / pulsador de salida',
    text: 'Avisa si la hoja quedó abierta, o abre desde adentro.'
  },
  {
    id: 'fingerprint',
    group: 'parte',
    title: 'Lector de huella (BioStar)',
    text: 'Lee la huella y se la pasa al controlador.'
  }
];

const NEED = {
  controller: [
    'La Raspberry o la PC',
    'La fuente',
    'Un cable de red',
    'El lector de DNI (dos, si hay uno afuera y otro adentro)',
    'La placa de relé, la que abre la cerradura',
    'La cerradura'
  ],
  hub: ['La PC de la guardia', 'El monitor', 'Un cable de red', 'Teclado y mouse']
};

const CONNECT = {
  controller: [
    'Enchufá la Raspberry o la PC a la corriente.',
    'Conectala al mismo router con un cable de red.',
    'Enchufá el lector de DNI en un puerto USB de la Raspberry.',
    'Conectá la placa de relé al mismo router con un cable de red.',
    'La cerradura la conecta el electricista. Mostrale el bloque de abajo.'
  ],
  hub: [
    'Conectá la PC al mismo router con un cable de red.',
    'Enchufá el monitor.',
    'Esta PC muestra la pantalla del guardia. Hay una sola por predio.'
  ],
  reader: [
    'Enchufá el lector de DNI en un puerto USB de la Raspberry del controlador que elegiste.',
    'Si es el de adentro, enchufalo en otro puerto USB de la misma Raspberry.'
  ],
  relay: [
    'Conectá la placa de relé al mismo router con un cable de red.',
    'La cerradura la conecta el electricista. Mostrale el bloque de abajo.'
  ],
  sensor: [
    'El sensor y el pulsador los conecta el electricista.',
    'Mostrale el bloque de abajo: el sensor va a una entrada del controlador.'
  ],
  fingerprint: [
    'Conectá el lector de huella a la red, en el mismo router que el controlador.',
    'En el programa del lector, dejá el usuario y la clave que te pasó quien administra el sistema.'
  ]
};

const ELECTRICIAN = [
  'Relé: usá el común (COM) y el normalmente abierto (NO). Van en serie con la orden de apertura. El normalmente cerrado (NC) no abre la puerta.',
  'La cerradura magnética va con 12 V. El relé no corta esa alimentación: corta la orden.',
  'El sensor de puerta es normalmente cerrado y va a una entrada del controlador.',
  'Si hay dos puertas en estanco, el enclavamiento va en serie con la orden de apertura, nunca con la alimentación del imán.',
  'El botón de emergencia corta la alimentación de los imanes, para poder abrir a mano.'
];

function PickGrid({ kind, onPick }) {
  const equipos = PICKS.filter((item) => item.group === 'equipo');
  const partes = PICKS.filter((item) => item.group === 'parte');
  const render = (item) => (
    <button
      key={item.id}
      type="button"
      className={`aui-pick${kind === item.id ? ' is-selected' : ''}`}
      aria-pressed={kind === item.id}
      onClick={() => onPick(item.id)}
    >
      <strong>{item.title}</strong>
      <span>{item.text}</span>
    </button>
  );
  return (
    <>
      <h3 className="aui-section-title">¿Qué vas a instalar?</h3>
      <div className="aui-picks">{equipos.map(render)}</div>
      <h3 className="aui-section-title">O una parte de un controlador que ya está</h3>
      <div className="aui-picks">{partes.map(render)}</div>
    </>
  );
}

function NeedList({ items }) {
  return (
    <>
      <p>Juntá esto antes de conectar. Si te falta algo, no sigas todavía.</p>
      <ul className="aui-ticks">
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </>
  );
}

function ConnectList({ items, showElectrician }) {
  return (
    <>
      <ol className="aui-ol">
        {items.map((item) => <li key={item}>{item}</li>)}
      </ol>
      {showElectrician ? (
        <AdvancedSection title="Para el electricista">
          <ul className="aui-ol">
            {ELECTRICIAN.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </AdvancedSection>
      ) : null}
    </>
  );
}

function Kickoff({ onKick }) {
  useEffect(() => { onKick(); }, [onKick]);
  return null;
}

function CodeBlock({ install, now, onReissue }) {
  const left = leftLabel(install.expiresAt, now);
  return (
    <>
      <p className="equipos-code" aria-label="Código de instalación">{install.code}</p>
      <p>En la Raspberry/PC abrí el instalador y escribí este código.</p>
      <p className="equipos-admin__timer" aria-live="polite">
        {left === 'Venció' ? 'El código venció. Generá otro.' : `Tiempo restante: ${left}`}
      </p>
      <button type="button" className="btn btn-secondary" onClick={onReissue}>Generar otro</button>
    </>
  );
}

function ProbeStep({ authToken, deviceId, doorIds, kind }) {
  const [probe, setProbe] = useState({ connected: false, reader: false, relay: false });
  const [scans, setScans] = useState([]);
  const [doorId, setDoorId] = useState(doorIds[0] || '');
  const [openState, setOpenState] = useState(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const tick = async () => {
      try {
        const data = await apiFetch('/admin/devices', { token: authToken, dedupe: false });
        if (!alive.current) return;
        const device = (data.devices || []).find((item) => item.id === deviceId);
        setProbe(installProbe(device || {}));
        if (doorId && kind === 'controller') {
          const page = await apiFetch(
            `/admin/doors/${encodeURIComponent(doorId)}/last-scans?limit=5`,
            { token: authToken, dedupe: false }
          );
          if (!alive.current) return;
          setScans(page.scans || []);
        }
      } catch {
        // El próximo ciclo vuelve a intentar. No insistir si el modal ya se cerró.
      }
    };
    tick();
    const timer = setInterval(tick, INSTALL_POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [authToken, deviceId, doorId, kind]);

  const tryOpen = async () => {
    if (!doorId) return;
    setOpenState({ status: 'pending' });
    try {
      await openDoorRemote({
        doorId,
        token: authToken,
        body: { reason: 'prueba de instalación' }
      });
      if (!alive.current) return;
      setOpenState({ status: 'ok' });
    } catch {
      if (!alive.current) return;
      setOpenState({
        status: 'fail',
        detail: 'No respondió: revisá el cable de red de la placa de relé.'
      });
    }
  };

  const mark = (ok) => (ok ? '✓' : '○');

  return (
    <div aria-live="polite">
      <p>Esto se va tildando solo, mirando el equipo. Dejá esta ventana abierta.</p>
      <ul className="aui-ticks">
        <li>{mark(probe.connected)} Equipo conectado</li>
        {kind === 'controller' ? (
          <>
            <li>
              {mark(probe.reader)} Lector detectado
              {probe.reader ? '' : ' (pasá un DNI ahora)'}
            </li>
            <li>{mark(probe.relay)} Placa de relé responde</li>
          </>
        ) : null}
      </ul>
      {kind === 'controller' ? (
        <>
          {doorIds.length > 1 ? (
            <label className="aui-field">
              <span className="aui-field__label">¿Qué puerta probamos?</span>
              <select className="input-field" value={doorId} onChange={(event) => setDoorId(event.target.value)} aria-label="Puerta a probar">
                {doorIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </label>
          ) : null}
          {scans[0] ? (
            <p>Último escaneo: {scans[0].summary}</p>
          ) : (
            <p>Todavía no hubo un escaneo en esta puerta.</p>
          )}
          <button type="button" className="btn btn-secondary" onClick={tryOpen} disabled={!doorId || openState?.status === 'pending'}>
            Probar apertura
          </button>
          {openState?.status === 'ok' ? <p>La puerta se abrió ✓</p> : null}
          {openState?.status === 'fail' ? <p role="alert">{openState.detail}</p> : null}
          {openState?.status === 'pending' ? <p role="status">Probando…</p> : null}
        </>
      ) : null}
      <p>Cuando esté conectado, tocá Listo: el equipo quedó instalado.</p>
    </div>
  );
}

function InstallWizard({
  open,
  onClose,
  doors,
  airlocks,
  devices,
  authToken,
  confirm,
  showError,
  showSuccess,
  onCreated
}) {
  const [kind, setKind] = useState('');
  const [name, setName] = useState('');
  const [doorIds, setDoorIds] = useState([]);
  const [movesOk, setMovesOk] = useState(false);
  const [controllerId, setControllerId] = useState('');
  const [partDoorId, setPartDoorId] = useState('');
  const [error, setError] = useState('');
  const [install, setInstall] = useState(null);
  const [now, setNow] = useState(Date.now());
  const createdRef = useRef(null);
  const creatingRef = useRef(false);

  useEffect(() => {
    setKind('');
    setName('');
    setDoorIds([]);
    setMovesOk(false);
    setControllerId('');
    setPartDoorId('');
    setError('');
    setInstall(null);
    createdRef.current = null;
    creatingRef.current = false;
  }, [open]);

  useEffect(() => {
    if (!install?.expiresAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [install?.expiresAt]);

  const controllers = (devices || []).filter((device) => (
    device.kind === 'controller' && device.status !== 'replaced' && device.status !== 'revoked'
  ));
  const warning = kind === 'controller' ? airlockWarning(doorIds, airlocks, doors) : '';
  const moves = kind === 'controller' ? doorMoveWarnings(doorIds, doors, devices) : [];
  const doorsOk = !warning && (moves.length === 0 || movesOk);
  const nameOk = name.trim().length > 0;
  const whatOk = Boolean(kind) && ((kind === 'controller' || kind === 'hub') ? nameOk : true);

  const ensure = useCallback(async () => {
    if (createdRef.current || creatingRef.current) return;
    if (kind !== 'controller' && kind !== 'hub') return;
    creatingRef.current = true;
    setError('');
    const post = (flag) => apiFetch('/admin/devices', {
      method: 'POST',
      token: authToken,
      body: {
        kind: kind === 'hub' ? 'hub' : 'controller',
        name: name.trim(),
        doorIds: kind === 'controller' ? doorIds : [],
        confirmMoves: Boolean(flag)
      }
    });
    try {
      let data;
      try {
        data = await post(movesOk);
      } catch (err) {
        if (err.status === 409 && err.data?.code === 'DOOR_MOVE_CONFIRM') {
          const ok = await confirm({
            title: 'Esta puerta cambia de equipo',
            message: err.data.message || err.message,
            confirmLabel: 'Pasar las puertas',
            cancelLabel: 'Cancelar'
          });
          if (!ok) throw err;
          data = await post(true);
        } else {
          throw err;
        }
      }
      createdRef.current = data;
      setInstall({
        deviceId: data.device.id,
        deviceName: data.device.name,
        code: data.enrollment.code,
        expiresAt: data.enrollment.expiresAt
      });
      setNow(Date.now());
      onCreated?.();
    } catch (err) {
      setError(err.message || 'No se pudo crear el equipo');
      showError?.(err.message || 'No se pudo crear el equipo');
    } finally {
      creatingRef.current = false;
    }
  }, [authToken, confirm, doorIds, kind, movesOk, name, onCreated, showError]);

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
      showError?.(err.message || 'No se pudo generar otro código');
    }
  };

  const acceptMoves = async () => {
    const ok = await confirm({
      title: 'Esta puerta cambia de equipo',
      message: moves.map((move) => move.message).join(' '),
      confirmLabel: 'Pasar las puertas',
      cancelLabel: 'Cancelar'
    });
    if (ok) setMovesOk(true);
  };

  const toggleDoor = (id, checked) => {
    setMovesOk(false);
    setError('');
    if (checked && doorIds.length >= 2 && !doorIds.includes(id)) {
      setError('Un controlador abre 1 o 2 puertas. Si hay más, instalá otro.');
      return;
    }
    setDoorIds((prev) => (checked ? [...prev, id] : prev.filter((item) => item !== id)));
  };

  const partDoors = (doors || []).filter((door) => !controllerId || door.controllerId === controllerId || !(door.controllerId));

  const steps = [
    {
      id: 'what',
      title: 'Qué vas a instalar',
      canContinue: whatOk,
      content: (
        <>
          <PickGrid kind={kind} onPick={(id) => { setKind(id); setError(''); }} />
          {kind === 'controller' || kind === 'hub' ? (
            <label className="aui-field">
              <span className="aui-field__label">Nombre</span>
              <input
                className="input-field"
                aria-label="Nombre del equipo"
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          ) : null}
          {error && !kind ? <p className="aui-error" role="alert">{error}</p> : null}
        </>
      )
    }
  ];

  if (kind === 'controller') {
    steps.push({
      id: 'doors',
      title: 'Puertas',
      canContinue: doorsOk,
      content: (
        <>
          <h3 className="aui-section-title">Elegí las puertas que va a manejar</h3>
          <p>Una o dos. Si es un estanco, elegí las dos puertas.</p>
          {doors.length === 0 ? (
            <p>Primero cargá las puertas. Después volvé para asignarlas.</p>
          ) : (
            <fieldset>
              <legend>Puertas</legend>
              {doors.map((door) => (
                <label key={door.id} className="equipos-admin__choice">
                  <input
                    type="checkbox"
                    checked={doorIds.includes(door.id)}
                    onChange={(event) => toggleDoor(door.id, event.target.checked)}
                  />
                  {door.name}
                  {door.groupName ? ` · estanco ${door.groupName}` : ''}
                </label>
              ))}
            </fieldset>
          )}
          {warning ? <p className="alarm-panel__error" role="alert">{warning}</p> : null}
          {moves.map((move) => (
            <p key={move.doorId} className="equipos-admin__move" role="status">{move.message}</p>
          ))}
          {moves.length > 0 && !movesOk ? (
            <button type="button" className="btn btn-secondary" onClick={acceptMoves}>
              Confirmar el cambio de equipo
            </button>
          ) : null}
          {error ? <p className="aui-error" role="alert">{error}</p> : null}
        </>
      )
    });
  }

  if (PARTS.has(kind)) {
    steps.push({
      id: 'where',
      title: 'En qué controlador',
      canContinue: Boolean(controllerId && partDoorId),
      content: (
        <>
          <p>Esta parte no es un equipo nuevo: va en un controlador que ya instalaste, y en una puerta.</p>
          {controllers.length === 0 ? (
            <p role="status">Primero instalá el controlador de puertas. Es la cajita que abre.</p>
          ) : (
            <>
              <label className="aui-field">
                <span className="aui-field__label">¿En qué controlador?</span>
                <select className="input-field" aria-label="Controlador" value={controllerId} onChange={(event) => { setControllerId(event.target.value); setPartDoorId(''); }}>
                  <option value="">Elegir</option>
                  {controllers.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
                </select>
              </label>
              <label className="aui-field">
                <span className="aui-field__label">¿En qué puerta?</span>
                <select className="input-field" aria-label="Puerta" value={partDoorId} onChange={(event) => setPartDoorId(event.target.value)}>
                  <option value="">Elegir</option>
                  {partDoors.map((door) => <option key={door.id} value={door.id}>{door.name}</option>)}
                </select>
              </label>
            </>
          )}
        </>
      )
    });
  }

  if (kind === 'controller' || kind === 'hub') {
    steps.push({
      id: 'need',
      title: 'Lo que necesitás',
      content: <NeedList items={NEED[kind]} />
    });
    steps.push({
      id: 'wire',
      title: 'Conectá',
      content: <ConnectList items={CONNECT[kind]} showElectrician={kind === 'controller'} />
    });
    steps.push({
      id: 'code',
      title: 'Instalá el programa',
      canContinue: Boolean(install),
      content: (
        <>
          <Kickoff onKick={ensure} />
          {install ? <CodeBlock install={install} now={now} onReissue={reissue} /> : <p role="status">Generando el código…</p>}
          {error ? (
            <>
              <p className="alarm-panel__error" role="alert">{error}</p>
              <button type="button" className="btn btn-secondary" onClick={ensure}>Reintentar</button>
            </>
          ) : null}
        </>
      )
    });
    steps.push({
      id: 'test',
      title: 'Probá',
      content: install ? (
        <ProbeStep authToken={authToken} deviceId={install.deviceId} doorIds={doorIds} kind={kind} />
      ) : (
        <p>Primero tiene que aparecer el código de instalación.</p>
      )
    });
  } else if (PARTS.has(kind)) {
    steps.push({
      id: 'wire',
      title: 'Conectá',
      content: (
        <ConnectList
          items={CONNECT[kind] || []}
          showElectrician={kind === 'relay' || kind === 'sensor'}
        />
      )
    });
  }

  return (
    <WizardModal
      open={open}
      title="Instalar un equipo"
      steps={steps}
      finishLabel="Listo"
      onClose={onClose}
      onFinish={() => {
        if (kind === 'controller' || kind === 'hub') showSuccess?.('Listo: el equipo quedó instalado.');
        else showSuccess?.('Listo. Conectalo en el controlador y la puerta que elegiste.');
        onClose?.();
      }}
    />
  );
}

export default InstallWizard;
