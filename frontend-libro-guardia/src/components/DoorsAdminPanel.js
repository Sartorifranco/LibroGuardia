import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Save, Trash2 } from 'lucide-react';
import PendingButton from './PendingButton';
import DoorPeoplePanel from './DoorPeoplePanel';
import { AdvancedSection, EmptyState, HelpTip, PageHeader } from './admin-ui';
import { apiFetch } from '../services/api';
import { useConfirm } from '../context/ConfirmContext';
import {
  offlineNeedsLocalRelayMessage,
  OFFLINE_NEEDS_LOCAL_RELAY_TITLE
} from '../utils/accessHardwareCoherence';
import {
  DOOR_KINDS,
  airlockPartnerId,
  applyAirlockChoice,
  kindLabel,
  placesFromDoor,
  sidesFromPlaces,
  validateSimpleDoor
} from '../pages/Admin/DoorsAdmin/doorForm';

const createLocalId = (prefix = 'item') =>
  (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);

const DEFAULT_GLOBAL = {
  enabled: true,
  host: '',
  port: 6722,
  bridgeUrl: '',
  bridgeSecret: '',
  relayChannel: 1,
  pulseMode: 'timed',
  pulseSeconds: 3,
  allowManualOverride: true,
  denyMessage: 'Acceso denegado: no tiene autorización vigente',
  kioskResetSeconds: 4,
  identityVerificationAtMainEntry: false
};

const slugify = (value = '') => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40);

const nextDoorCode = (doors = []) => {
  const used = new Set();
  doors.forEach((door) => {
    const match = String(door.id || door.doorCode || door.name || '').match(/p(\d+)/i);
    if (match) used.add(Number(match[1]));
  });
  let n = 1;
  while (used.has(n)) n += 1;
  return `P${n}`;
};

const ensureTwoReaders = (door, doorCode) => {
  const code = String(doorCode || 'P1').toUpperCase() || 'P1';
  const readers = Array.isArray(door.readers) ? door.readers : [];
  const ingreso = readers.find((reader) => reader.direction === 'ingreso');
  const egreso = readers.find((reader) => reader.direction === 'egreso');
  return [
    { id: ingreso?.id || `INGRESO_${code}`, direction: 'ingreso' },
    { id: egreso?.id || `EGRESO_${code}`, direction: 'egreso' }
  ];
};

const normalizeDoorLocal = (door = {}, fallbackCode = 'P1') => {
  const doorCode = String(door.doorCode || fallbackCode).toUpperCase();
  const readers = ensureTwoReaders(door, doorCode);
  const places = placesFromDoor(door);
  return {
    _localId: door._localId || createLocalId('door'),
    id: door.id || `puerta-${doorCode.toLowerCase()}`,
    doorCode,
    name: door.name || `Puerta ${doorCode}`,
    active: door.active !== false,
    kind: DOOR_KINDS.some((item) => item.id === door.kind) ? door.kind : 'door',
    placeA: door.placeA ?? places.placeA,
    placeB: door.placeB ?? places.placeB,
    sensorsRequired: door.sensorsRequired === true,
    heldOpenSec: Number(door.heldOpenSec) > 0 ? Number(door.heldOpenSec) : 60,
    requireGuardApproval: door.requireGuardApproval === true,
    airlockEnabled: door.airlockEnabled === true,
    airlockPartnerId: door.airlockPartnerId || '',
    device: {
      driver: door.device?.driver === 'generic_http' ? 'generic_http' : 'sr201',
      bridgeUrl: '',
      bridgeSecret: '',
      port: 6722,
      ...(door.device || {}),
      host: String(door.device?.host || '').trim(),
      channel: Number(door.device?.channel) === 2 ? 2 : 1,
      httpUrl: String(door.device?.httpUrl || '').trim(),
      httpMethod: String(door.device?.httpMethod || 'POST').toUpperCase() || 'POST',
      httpAuthToken: String(door.device?.httpAuthToken || '')
    },
    pulseMode: 'timed',
    pulseSeconds: Number(door.pulseSeconds) || 3,
    relayMode: door.relayMode === 'local' ? 'local' : 'cloud',
    localStation: door.localStation || null,
    authMethods: door.authMethods?.length ? door.authMethods : ['dni', 'credential', 'manual'],
    readers,
    readerIds: readers.map((reader) => reader.id),
    kioskEnabled: door.kioskEnabled !== false,
    manualOpenAllowed: door.manualOpenAllowed !== false,
    autoOpenOnAuth: door.autoOpenOnAuth !== false,
    isMainEntryDoor: door.isMainEntryDoor === true,
    airlockGroupId: door.airlockGroupId || null,
    airlockRole: door.airlockRole || null,
    sequenceOrder: Number(door.sequenceOrder) || 0
  };
};

const createBlankDoor = (doors = []) => {
  const doorCode = nextDoorCode(doors);
  return normalizeDoorLocal({
    doorCode,
    name: '',
    kind: 'door',
    placeA: 'exterior',
    placeB: '',
    relayMode: 'local',
    manualOpenAllowed: true,
    sensorsRequired: false,
    pulseSeconds: 3,
    device: { host: '', channel: 1, port: 6722, driver: 'sr201' }
  }, doorCode);
};

const placeName = (areas, id) => areas.find((area) => area.id === id)?.name || id;

function Field({ label, help, error, children }) {
  return (
    <label className="aui-field">
      <span className="aui-field__label">
        {label}
        {help ? <HelpTip text={help} /> : null}
      </span>
      {children}
      {error ? <span className="aui-error" role="alert">{error}</span> : null}
    </label>
  );
}

function DoorsAdminPanel({ authToken, pendingAction, onPending, onSuccess, onError, onGlobalAccessSaved }) {
  const { alert, confirm } = useConfirm();
  const [doors, setDoors] = useState([]);
  const [areas, setAreas] = useState([{ id: 'exterior', name: 'Exterior', fixed: true }]);
  const [airlockGroups, setAirlockGroups] = useState([]);
  const [defaultDoorId, setDefaultDoorId] = useState(null);
  const [globalAccess, setGlobalAccess] = useState(DEFAULT_GLOBAL);
  const [draft, setDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [query, setQuery] = useState('');
  const [physicalById, setPhysicalById] = useState({});

  const loadConfig = useCallback(async () => {
    const data = await apiFetch('/admin/doors-config', { token: authToken, allowForbidden: true });
    const stored = data.meta?.legacyFallback ? [] : (data.config?.doors || []);
    const list = stored.map((door, index) => (
      normalizeDoorLocal(door, nextDoorCode(stored.slice(0, index) || []))
    ));
    const groups = data.config?.airlockGroups || [];
    setDoors(list.map((door) => {
      const partner = airlockPartnerId(door.id, groups);
      return { ...door, airlockEnabled: Boolean(partner), airlockPartnerId: partner };
    }));
    setAirlockGroups(groups);
    setDefaultDoorId(data.config?.defaultDoorId || list[0]?.id || null);
    setGlobalAccess({ ...DEFAULT_GLOBAL, ...(data.globalAccess || {}) });
  }, [authToken]);

  const loadAreas = useCallback(async () => {
    try {
      const data = await apiFetch('/admin/areas', { token: authToken, allowForbidden: true });
      if (Array.isArray(data.areas) && data.areas.length) setAreas(data.areas);
    } catch {
      // El exterior sigue disponible para no trabar el alta.
    }
  }, [authToken]);

  useEffect(() => {
    loadConfig().catch((err) => onError?.(err.message));
    loadAreas();
  }, [loadConfig, loadAreas, onError]);

  const refreshPhysicalStatus = useCallback(async () => {
    if (!authToken) return;
    try {
      const data = await apiFetch('/admin/doors/physical-status', { token: authToken, allowForbidden: true });
      const map = {};
      (data.doors || []).forEach((item) => { map[item.doorId] = item; });
      setPhysicalById(map);
    } catch {
      // El listado igual se puede usar sin el estado del equipo.
    }
  }, [authToken]);

  useEffect(() => {
    if (!draft) refreshPhysicalStatus();
  }, [draft, refreshPhysicalStatus]);

  const patchDraft = (patch) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  };

  const openDoor = async (door) => {
    if (dirty && draft) {
      const ok = await confirm({
        title: 'Cambios sin guardar',
        message: 'Hay cambios sin guardar en esta puerta. ¿Los descartás?',
        confirmLabel: 'Descartar',
        tone: 'danger'
      });
      if (!ok) return;
    }
    const partner = airlockPartnerId(door.id, airlockGroups);
    setDraft(normalizeDoorLocal({ ...door, airlockEnabled: Boolean(partner), airlockPartnerId: partner }));
    setFieldErrors({});
    setDirty(false);
  };

  const backToList = async () => {
    if (dirty) {
      const ok = await confirm({
        title: 'Cambios sin guardar',
        message: 'Hay cambios sin guardar. ¿Volvés al listado sin guardar?',
        confirmLabel: 'Volver sin guardar',
        tone: 'danger'
      });
      if (!ok) return;
    }
    setDraft(null);
    setDirty(false);
    setFieldErrors({});
  };

  const persistDoors = async (nextDoors, nextDefaultId = defaultDoorId, nextGlobal = globalAccess, nextGroups = airlockGroups) => {
    const usedIds = new Set();
    const payloadDoors = nextDoors.map(({ _localId, doorCode, localStation, placeA, placeB, airlockEnabled, airlockPartnerId: partnerIgnored, ...door }) => {
      const code = String(doorCode || 'P1').toUpperCase();
      const readers = ensureTwoReaders({ ...door, doorCode: code }, code);
      const pulseSeconds = Math.max(1, Math.min(60, Number(door.pulseSeconds) || 3));
      let id = slugify(door.id || `puerta-${code}`) || createLocalId('puerta');
      if (usedIds.has(id)) id = slugify(`puerta-${code}-${usedIds.size}`) || createLocalId('puerta');
      usedIds.add(id);
      const sensorsRequired = door.sensorsRequired === true;
      return {
        ...door,
        id,
        name: String(door.name || `Puerta ${code}`).trim(),
        active: door.active !== false,
        kind: door.kind || 'door',
        sides: sidesFromPlaces(placeA, placeB),
        sensorsRequired,
        heldOpenSec: sensorsRequired ? Math.round(Number(door.heldOpenSec) || 60) : null,
        requireGuardApproval: door.requireGuardApproval === true,
        readers,
        readerIds: readers.map((reader) => reader.id),
        pulseMode: 'timed',
        pulseSeconds,
        unlockSec: pulseSeconds,
        relayMode: door.relayMode === 'local' ? 'local' : 'cloud',
        manualOpenAllowed: door.manualOpenAllowed !== false,
        device: {
          driver: door.device?.driver === 'generic_http' ? 'generic_http' : 'sr201',
          ...(door.device || {}),
          host: String(door.device?.host || '').trim(),
          port: Number(door.device?.port) || 6722,
          channel: Number(door.device?.channel) === 2 ? 2 : 1
        }
      };
    });
    const defaultId = payloadDoors.some((door) => door.id === nextDefaultId)
      ? nextDefaultId
      : payloadDoors[0]?.id || null;
    const data = await apiFetch('/admin/doors-config', {
      method: 'PUT',
      token: authToken,
      body: {
        doors: payloadDoors,
        airlockGroups: nextGroups,
        defaultDoorId: defaultId,
        globalAccess: nextGlobal
      }
    });
    const groups = data.config?.airlockGroups || [];
    const list = (data.config?.doors || []).map((door, index) => {
      const local = normalizeDoorLocal(door, nextDoorCode(data.config?.doors?.slice(0, index) || []));
      const partner = airlockPartnerId(local.id, groups);
      return { ...local, airlockEnabled: Boolean(partner), airlockPartnerId: partner };
    });
    setDoors(list);
    setAirlockGroups(groups);
    setDefaultDoorId(data.config?.defaultDoorId || null);
    setGlobalAccess({ ...DEFAULT_GLOBAL, ...(data.globalAccess || {}) });
    onGlobalAccessSaved?.(data.globalAccess);
    return list;
  };

  const saveCurrentDoor = async () => {
    if (!draft) return;
    const errors = validateSimpleDoor(draft);
    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      onError?.('Revisá los campos marcados.');
      return;
    }
    const isLocalRelay = draft.relayMode === 'local';
    if (!isLocalRelay && draft.id) {
      try {
        const data = await apiFetch('/admin/lectores', { token: authToken, allowForbidden: true });
        const blockers = (data.lectores || []).filter((item) => item.doorId === draft.id && item.offlineCache);
        if (blockers.length) {
          await alert({
            title: OFFLINE_NEEDS_LOCAL_RELAY_TITLE,
            message: offlineNeedsLocalRelayMessage({ doorName: draft.name || draft.id, context: 'door' })
          });
          return;
        }
      } catch {
        // El guardado del servidor también lo controla.
      }
    }
    await onPending(`save-door-${draft._localId}`, async () => {
      const normalized = normalizeDoorLocal(draft, draft.doorCode);
      const exists = doors.some((door) => door._localId === normalized._localId);
      const withDraft = exists
        ? doors.map((door) => (door._localId === normalized._localId ? normalized : door))
        : [...doors, normalized];
      const paired = applyAirlockChoice(withDraft, airlockGroups, normalized);
      try {
        const list = await persistDoors(paired.doors, defaultDoorId || normalized.id, globalAccess, paired.airlockGroups);
        const saved = list.find((door) => door.name === normalized.name) || list.find((door) => door.id === slugify(normalized.id));
        if (saved) setDraft(saved);
        setDirty(false);
        onSuccess?.(`Puerta “${normalized.name}” guardada`);
      } catch (err) {
        if (err?.data?.code === 'cloud_relay_blocks_offline_lectores' || /En planta|A distancia|Modo offline/i.test(err.message || '')) {
          await alert({ title: OFFLINE_NEEDS_LOCAL_RELAY_TITLE, message: err.message });
          return;
        }
        throw err;
      }
    });
  };

  const deleteCurrentDoor = async () => {
    if (!draft) return;
    const ok = await confirm({
      title: 'Eliminar puerta',
      message: `¿Eliminar la puerta “${draft.name}”? Las personas dejan de poder usarla.`,
      confirmLabel: 'Eliminar',
      tone: 'danger'
    });
    if (!ok) return;
    await onPending(`delete-door-${draft._localId}`, async () => {
      const nextDoors = doors.filter((door) => door._localId !== draft._localId);
      const paired = applyAirlockChoice(nextDoors, airlockGroups, { ...draft, airlockEnabled: false, id: draft.id });
      await persistDoors(paired.doors, defaultDoorId, globalAccess, paired.airlockGroups);
      setDraft(null);
      setDirty(false);
      onSuccess?.('Puerta eliminada');
    });
  };

  const addNewDoor = async () => {
    if (dirty && draft) {
      const ok = await confirm({
        title: 'Cambios sin guardar',
        message: 'Hay cambios sin guardar. ¿Los descartás y creás otra puerta?',
        confirmLabel: 'Descartar',
        tone: 'danger'
      });
      if (!ok) return;
    }
    const blank = createBlankDoor(doors);
    const planta = areas.find((area) => area.id === 'planta');
    if (planta) blank.placeB = 'planta';
    setDraft(blank);
    setFieldErrors({});
    setDirty(true);
  };

  const testPulse = async () => {
    if (!draft?.id || !doors.some((door) => door.id === draft.id)) {
      onError?.('Guardá la puerta antes de probar la apertura.');
      return;
    }
    const seconds = Math.max(1, Math.min(60, Number(draft.pulseSeconds) || 3));
    await onPending(`test-door-${draft._localId}`, async () => {
      const data = await apiFetch('/access/test-relay', {
        method: 'POST',
        token: authToken,
        body: { doorId: draft.id, pulseSeconds: seconds, pulseMode: 'timed' }
      });
      onSuccess?.(data.message || `Pedido enviado (${seconds} segundos).`);
    });
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return doors;
    return doors.filter((door) => `${door.name} ${kindLabel(door.kind)} ${door.placeA} ${door.placeB}`.toLowerCase().includes(q));
  }, [doors, query]);

  const otherDoors = doors.filter((door) => door._localId !== draft?._localId);
  const readers = draft ? ensureTwoReaders(draft, draft.doorCode) : [];

  if (!draft) {
    return (
      <div className="doors-admin-simple">
        <PageHeader
          title="Puertas"
          purpose="Cada puerta conecta dos lugares y se destraba unos segundos para dejar pasar."
          howTo={[
            'Creá la puerta y ponéle el nombre que ve el guardia.',
            'Elegí qué lugar hay de cada lado.',
            'Si forma un estanco, elegí la otra puerta: nunca se abren las dos a la vez.'
          ]}
          action={(
            <button type="button" className="btn btn-primary" onClick={addNewDoor}>
              Crear puerta
            </button>
          )}
        />
        {doors.length === 0 ? (
          <EmptyState
            title="Todavía no cargaste puertas."
            text="Una puerta conecta dos lugares, por ejemplo Exterior y Planta. Sin puertas el sistema no puede dejar pasar a nadie."
            actionLabel="Crear la primera"
            onAction={addNewDoor}
          />
        ) : (
          <>
            <div className="aui-toolbar">
              <input
                className="input-field"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar por nombre"
                aria-label="Buscar puertas"
              />
            </div>
            {filtered.length === 0 ? (
              <EmptyState title="Ninguna puerta coincide." text="Probá con otra palabra." />
            ) : (
              <div className="aui-cards">
                {filtered.map((door) => {
                  const places = door.placeA && door.placeB
                    ? `${placeName(areas, door.placeA)} ⇄ ${placeName(areas, door.placeB)}`
                    : 'Falta indicar los lugares';
                  const phys = physicalById[door.id];
                  return (
                    <article key={door._localId} className="aui-card">
                      <h4 className="aui-card__title">{door.name || 'Sin nombre'}</h4>
                      <p className="aui-card__meta">{kindLabel(door.kind)} · {places}</p>
                      <p className="aui-card__meta">Queda destrabada {door.pulseSeconds || 3} segundos</p>
                      <p>
                        <span className={`aui-status${door.airlockEnabled ? ' is-warn' : ' is-ok'}`}>
                          {door.airlockEnabled ? 'Estanco' : (door.active !== false ? 'En uso' : 'Pausada')}
                        </span>
                        {phys?.physicalLabel ? (
                          <span className="aui-status" style={{ marginLeft: '0.35rem' }}>{phys.physicalLabel}</span>
                        ) : null}
                      </p>
                      <button type="button" className="btn btn-secondary" onClick={() => openDoor(door)}>
                        Configurar
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  const isNew = !doors.some((door) => door._localId === draft._localId);

  return (
    <div className="doors-admin-simple">
      <button type="button" className="btn btn-secondary" onClick={backToList}>
        <ChevronLeft size={16} aria-hidden /> Volver al listado
      </button>
      <PageHeader
        title={isNew ? 'Nueva puerta' : (draft.name || 'Puerta')}
        purpose="Contá cómo se usa. Los datos de la placa van más abajo, para el instalador."
        howTo={[
          'Poné el nombre y el tipo.',
          'Elegí el lugar de cada lado.',
          'Guardá. Si falta la placa, la puerta queda cargada igual.'
        ]}
        action={(
          <PendingButton
            type="button"
            actionId={`save-door-${draft._localId}`}
            pendingAction={pendingAction}
            className="btn btn-primary"
            onClick={saveCurrentDoor}
          >
            <Save size={16} aria-hidden /> Guardar
          </PendingButton>
        )}
      />

      <Field label="Nombre" error={fieldErrors.name} help="Es el nombre que ve el guardia en su pantalla.">
        <input className="input-field" value={draft.name || ''} onChange={(event) => patchDraft({ name: event.target.value })} placeholder="Portón de clientes" />
      </Field>

      <Field label="Tipo" error={fieldErrors.kind} help="Puerta es una hoja. Portón es vehicular. Molinete deja pasar de a una persona.">
        <select className="input-field" value={draft.kind || 'door'} onChange={(event) => patchDraft({ kind: event.target.value })}>
          {DOOR_KINDS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </Field>

      <div className="aui-places">
        <Field label="De este lado" error={fieldErrors.placeA} help="El lugar que queda de un lado de la puerta.">
          <select className="input-field" value={draft.placeA || ''} onChange={(event) => patchDraft({ placeA: event.target.value })}>
            <option value="">Elegir lugar</option>
            {areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}
          </select>
        </Field>
        <div className="aui-places__arrow" aria-hidden>⇄</div>
        <Field label="Del otro lado" error={fieldErrors.placeB} help="El lugar que queda del otro lado. Tiene que ser distinto.">
          <select className="input-field" value={draft.placeB || ''} onChange={(event) => patchDraft({ placeB: event.target.value })}>
            <option value="">Elegir lugar</option>
            {areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}
          </select>
        </Field>
      </div>

      <Field
        label="Tiempo que queda destrabada (segundos)"
        error={fieldErrors.pulseSeconds}
        help="Cuántos segundos queda libre la cerradura para que la persona pase. 3 alcanza para una puerta."
      >
        <input
          className="input-field"
          type="number"
          min="1"
          max="60"
          value={draft.pulseSeconds || 3}
          onChange={(event) => patchDraft({ pulseSeconds: Number(event.target.value) })}
        />
      </Field>

      <label className="aui-check">
        <input type="checkbox" checked={draft.sensorsRequired === true} onChange={(event) => patchDraft({ sensorsRequired: event.target.checked })} />
        <span>
          ¿Tiene sensor de puerta abierta?
          <HelpTip text="El sensor avisa si la hoja quedó abierta después de pasar." />
        </span>
      </label>
      {draft.sensorsRequired ? (
        <Field
          label="Avisar si queda abierta más de (segundos)"
          error={fieldErrors.heldOpenSec}
          help="Si sigue abierta más de este tiempo, se avisa. 60 segundos es un buen punto de partida."
        >
          <input
            className="input-field"
            type="number"
            min="10"
            max="600"
            value={draft.heldOpenSec || 60}
            onChange={(event) => patchDraft({ heldOpenSec: Number(event.target.value) })}
          />
        </Field>
      ) : null}

      <label className="aui-check">
        <input
          type="checkbox"
          checked={draft.airlockEnabled === true}
          onChange={(event) => patchDraft({ airlockEnabled: event.target.checked, airlockPartnerId: event.target.checked ? draft.airlockPartnerId : '' })}
        />
        <span>
          ¿Forma un estanco con otra puerta?
          <HelpTip text="En un estanco nunca se abren las dos a la vez. Primero se cierra una y después se abre la otra." />
        </span>
      </label>
      {draft.airlockEnabled ? (
        <Field label="La otra puerta del estanco" error={fieldErrors.airlockPartnerId}>
          <select className="input-field" value={draft.airlockPartnerId || ''} onChange={(event) => patchDraft({ airlockPartnerId: event.target.value })}>
            <option value="">Elegir puerta</option>
            {otherDoors.map((door) => <option key={door.id} value={door.id}>{door.name || door.id}</option>)}
          </select>
        </Field>
      ) : null}
      {draft.airlockEnabled ? (
        <p className="aui-card__meta">Nunca se abren las dos a la vez.</p>
      ) : null}

      <label className="aui-check">
        <input type="checkbox" checked={draft.requireGuardApproval === true} onChange={(event) => patchDraft({ requireGuardApproval: event.target.checked })} />
        <span>
          ¿El guardia tiene que aprobar cada ingreso?
          <HelpTip text="Sirve en el portón de clientes: la persona llega y el guardia confirma antes de abrir." />
        </span>
      </label>

      <label className="aui-check">
        <input type="checkbox" checked={draft.manualOpenAllowed !== false} onChange={(event) => patchDraft({ manualOpenAllowed: event.target.checked })} />
        <span>
          ¿Se puede abrir desde la pantalla del guardia?
          <HelpTip text="Si está activo, el guardia ve un botón para abrirla a mano." />
        </span>
      </label>

      {!isNew ? (
        <section>
          <h4>Personas de esta puerta</h4>
          <DoorPeoplePanel
            authToken={authToken}
            doorId={draft.id}
            doorName={draft.name}
            doorRelayMode={draft.relayMode}
            onMessage={onSuccess}
            onError={onError}
          />
        </section>
      ) : (
        <p className="aui-card__meta">Guardá la puerta para poder ver quién pasa por acá.</p>
      )}

      <AdvancedSection title="Datos para el instalador">
        <p className="aui-card__meta">Esto lo completa quien instala la placa. La puerta se puede guardar sin estos datos.</p>
        <Field label="Cómo abre">
          <select className="input-field" value={draft.relayMode || 'local'} onChange={(event) => patchDraft({ relayMode: event.target.value })}>
            <option value="local">En el lugar</option>
            <option value="cloud">Desde internet</option>
          </select>
        </Field>
        <Field label="Equipo que la maneja">
          <select
            className="input-field"
            value={draft.device?.driver === 'generic_http' ? 'generic_http' : 'sr201'}
            onChange={(event) => patchDraft({ device: { ...draft.device, driver: event.target.value } })}
          >
            <option value="sr201">Placa SR201</option>
            <option value="generic_http">Dirección web</option>
          </select>
        </Field>
        {draft.device?.driver === 'generic_http' ? (
          <>
            <Field label="Dirección web de apertura">
              <input className="input-field" value={draft.device?.httpUrl || ''} onChange={(event) => patchDraft({ device: { ...draft.device, httpUrl: event.target.value } })} />
            </Field>
            <Field label="Token">
              <input className="input-field" value={draft.device?.httpAuthToken || ''} onChange={(event) => patchDraft({ device: { ...draft.device, httpAuthToken: event.target.value } })} autoComplete="off" />
            </Field>
          </>
        ) : (
          <>
            <Field label="Dirección de la placa">
              <input className="input-field" value={draft.device?.host || ''} onChange={(event) => patchDraft({ device: { ...draft.device, host: event.target.value } })} placeholder="192.168.0.38" />
            </Field>
            <Field label="Puerto">
              <input className="input-field" type="number" value={draft.device?.port || 6722} onChange={(event) => patchDraft({ device: { ...draft.device, port: Number(event.target.value) } })} />
            </Field>
            <Field label="Canal">
              <select className="input-field" value={draft.device?.channel || 1} onChange={(event) => patchDraft({ device: { ...draft.device, channel: Number(event.target.value) } })}>
                <option value={1}>Canal 1</option>
                <option value={2}>Canal 2</option>
              </select>
            </Field>
          </>
        )}
        <Field label="Lector de entrada">
          <input className="input-field" value={readers[0]?.id || ''} onChange={(event) => {
            const next = ensureTwoReaders(draft, draft.doorCode).map((reader) => (
              reader.direction === 'ingreso' ? { ...reader, id: event.target.value.trim() } : reader
            ));
            patchDraft({ readers: next, readerIds: next.map((reader) => reader.id) });
          }}
          />
        </Field>
        <Field label="Lector de salida">
          <input className="input-field" value={readers[1]?.id || ''} onChange={(event) => {
            const next = ensureTwoReaders(draft, draft.doorCode).map((reader) => (
              reader.direction === 'egreso' ? { ...reader, id: event.target.value.trim() } : reader
            ));
            patchDraft({ readers: next, readerIds: next.map((reader) => reader.id) });
          }}
          />
        </Field>
        <Field label="Enlace para abrir desde internet" help="Lo deja el instalador si alguna puerta se abre a distancia.">
          <input className="input-field" value={globalAccess.bridgeUrl || ''} onChange={(event) => { setGlobalAccess((prev) => ({ ...prev, bridgeUrl: event.target.value.trim() })); setDirty(true); }} />
        </Field>
        <Field label="Clave de ese enlace">
          <input className="input-field" type="password" value={globalAccess.bridgeSecret || ''} onChange={(event) => { setGlobalAccess((prev) => ({ ...prev, bridgeSecret: event.target.value })); setDirty(true); }} autoComplete="off" />
        </Field>
        <button type="button" className="btn btn-secondary" onClick={testPulse}>Probar apertura</button>
      </AdvancedSection>

      {!isNew ? (
        <div style={{ marginTop: '1rem' }}>
          <PendingButton
            type="button"
            actionId={`delete-door-${draft._localId}`}
            pendingAction={pendingAction}
            className="btn btn-danger-small"
            onClick={deleteCurrentDoor}
          >
            <Trash2 size={14} aria-hidden /> Eliminar puerta
          </PendingButton>
        </div>
      ) : null}
    </div>
  );
}

export default DoorsAdminPanel;
