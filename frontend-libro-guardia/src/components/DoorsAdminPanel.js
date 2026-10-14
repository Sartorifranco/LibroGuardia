import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Save, Trash2 } from 'lucide-react';
import PendingButton from './PendingButton';
import DoorPeoplePanel from './DoorPeoplePanel';
import { AdvancedSection, EmptyState, HelpTip, Modal, PageContainer, PageHeader } from './admin-ui';
import { apiFetch } from '../services/api';
import { useConfirm } from '../context/ConfirmContext';
import { adminPath } from '../utils/navigation';
import {
  offlineNeedsLocalRelayMessage,
  OFFLINE_NEEDS_LOCAL_RELAY_TITLE
} from '../utils/accessHardwareCoherence';
import {
  DOOR_KINDS,
  kindLabel,
  placesFromDoor,
  readersForDraft,
  placesNeedChoice,
  readersModeOf,
  sidesFromPlaces,
  swapPlaces,
  validateSimpleDoor
} from '../pages/Admin/DoorsAdmin/doorForm';
import {
  airlockGroupsOfDoor,
  describeDoorAirlocks,
  joinNames,
  removeDoorFromGroups,
  syncAirlockFields
} from '../pages/Admin/EstancosAdmin/estancoForm';

const SIDES_HELP = 'Esto le dice al sistema si la persona ENTRÓ o SALIÓ, y quién está dentro de cada lugar (sirve para saber quién está en la planta en una evacuación).';
const NEW_PLACE = '__crear_lugar__';
const PLACE_HELP = 'Un lugar es una zona del predio separada por puertas.';

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

const ensureTwoReaders = (door, doorCode) => readersForDraft({
  ...door,
  doorCode: doorCode || door.doorCode,
  readersMode: readersModeOf(door)
});

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
    readersMode: readersModeOf(door),
    controllerId: door.controllerId || null,
    sensorsRequired: door.sensorsRequired === true,
    heldOpenSec: Number(door.heldOpenSec) > 0 ? Number(door.heldOpenSec) : 60,
    requireGuardApproval: door.requireGuardApproval === true,
    notifyGuardOnVisitor: door.notifyGuardOnVisitor === true,
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
  const navigate = useNavigate();
  const placeSelectRef = useRef(null);
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
  const [deviceNames, setDeviceNames] = useState({});
  const [placeModal, setPlaceModal] = useState(null);
  const [newPlaceName, setNewPlaceName] = useState('');
  const [placeError, setPlaceError] = useState('');
  const [placeBusy, setPlaceBusy] = useState(false);
  const [leaveTo, setLeaveTo] = useState(null);

  const loadConfig = useCallback(async () => {
    const data = await apiFetch('/admin/doors-config', { token: authToken, allowForbidden: true });
    const stored = data.meta?.legacyFallback ? [] : (data.config?.doors || []);
    const list = stored.map((door, index) => (
      normalizeDoorLocal(door, nextDoorCode(stored.slice(0, index) || []))
    ));
    setDoors(list);
    setAirlockGroups(data.config?.airlockGroups || []);
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

  const loadDeviceNames = useCallback(async () => {
    if (!authToken) return;
    try {
      const data = await apiFetch('/admin/devices', { token: authToken, allowForbidden: true });
      const map = {};
      (data.devices || []).forEach((device) => { map[device.id] = device.name || device.id; });
      setDeviceNames(map);
    } catch {
      // Sin permiso de equipos, la tarjeta muestra la placa o "Sin equipo".
    }
  }, [authToken]);

  useEffect(() => {
    if (!draft) loadDeviceNames();
  }, [draft, loadDeviceNames]);

  const patchDraft = (patch) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  };

  const openDoor = (door) => {
    setDraft(normalizeDoorLocal(door));
    setFieldErrors({});
    setDirty(false);
  };

  const closeDoor = () => {
    setDraft(null);
    setDirty(false);
    setFieldErrors({});
    setPlaceModal(null);
    setLeaveTo(null);
  };

  const persistDoors = async (nextDoors, nextDefaultId = defaultDoorId, nextGlobal = globalAccess, nextGroups = airlockGroups) => {
    const usedIds = new Set();
    const payloadDoors = syncAirlockFields(nextDoors, nextGroups).map(({
      _localId,
      doorCode,
      localStation,
      placeA,
      placeB,
      readersMode,
      ...door
    }) => {
      const code = String(doorCode || 'P1').toUpperCase();
      const readers = readersForDraft({ ...door, doorCode: code, readersMode, readers: door.readers });
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
        notifyGuardOnVisitor: door.notifyGuardOnVisitor === true,
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
    const list = (data.config?.doors || []).map((door, index) => (
      normalizeDoorLocal(door, nextDoorCode(data.config?.doors?.slice(0, index) || []))
    ));
    setDoors(list);
    setAirlockGroups(data.config?.airlockGroups || []);
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
      try {
        await persistDoors(withDraft, defaultDoorId || normalized.id, globalAccess, airlockGroups);
        setDraft(null);
        setDirty(false);
        setFieldErrors({});
        onSuccess?.(`Puerta "${normalized.name}" guardada`);
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
    const cleanup = removeDoorFromGroups(draft.id, airlockGroups);
    const notes = [];
    if (cleanup.removed.length) {
      const names = joinNames(cleanup.removed.map((group) => group.name || group.id));
      notes.push(cleanup.removed.length === 1
        ? `El estanco ${names} se borra, porque le queda una sola puerta.`
        : `Los estancos ${names} se borran, porque les queda una sola puerta.`);
    }
    const wasIn = new Set(airlockGroupsOfDoor(draft.id, airlockGroups).map((group) => group.id));
    const kept = cleanup.airlockGroups.filter((group) => wasIn.has(group.id));
    if (kept.length) {
      notes.push(`Sale ${kept.length === 1 ? 'del estanco' : 'de los estancos'} ${joinNames(kept.map((group) => group.name || group.id))}.`);
    }
    if (cleanup.changedOuter.length) {
      notes.push('Era la puerta de afuera: revisá en Estancos cuál pasa a ser la de afuera.');
    }
    const ok = await confirm({
      title: 'Eliminar puerta',
      message: [`¿Eliminar la puerta "${draft.name}"? Las personas dejan de poder usarla.`, ...notes].join(' '),
      confirmLabel: 'Eliminar',
      tone: 'danger'
    });
    if (!ok) return;
    await onPending(`delete-door-${draft._localId}`, async () => {
      const nextDoors = doors.filter((door) => door._localId !== draft._localId);
      await persistDoors(nextDoors, defaultDoorId, globalAccess, cleanup.airlockGroups);
      setDraft(null);
      setDirty(false);
      onSuccess?.('Puerta eliminada');
    });
  };

  const addNewDoor = () => {
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

  const readers = draft ? ensureTwoReaders(draft, draft.doorCode) : [];
  const isNew = draft ? !doors.some((door) => door._localId === draft._localId) : true;
  const draftAirlocks = draft && !isNew ? describeDoorAirlocks(draft.id, airlockGroups, doors) : [];

  const managedBy = (door) => {
    if (door.controllerId && deviceNames[door.controllerId]) return deviceNames[door.controllerId];
    if (door.controllerId) return 'Equipo asignado';
    if (door.device?.host) return `Placa en ${door.device.host}`;
    return 'Sin equipo';
  };

  const setReaderId = (side, value) => {
    const next = ensureTwoReaders(draft, draft.doorCode).map((reader) => (
      reader.side === side ? { ...reader, id: value.trim() } : reader
    ));
    patchDraft({ readers: next, readerIds: next.map((reader) => reader.id) });
  };

  const setReadersMode = (readersMode) => {
    const next = readersForDraft({ ...draft, readersMode });
    patchDraft({ readersMode, readers: next, readerIds: next.map((reader) => reader.id) });
  };

  const focusPlaceSelect = () => {
    const node = placeSelectRef.current;
    setTimeout(() => node?.focus(), 0);
  };

  const onPlaceSelect = (side) => (event) => {
    const value = event.target.value;
    if (value === NEW_PLACE) {
      placeSelectRef.current = event.target;
      setNewPlaceName('');
      setPlaceError('');
      setPlaceModal({ side, previous: draft?.[side] || '' });
      return;
    }
    patchDraft({ [side]: value });
  };

  const cancelPlace = () => {
    const modal = placeModal;
    if (modal) {
      setDraft((prev) => (prev ? { ...prev, [modal.side]: modal.previous } : prev));
    }
    setPlaceModal(null);
    setNewPlaceName('');
    setPlaceError('');
    focusPlaceSelect();
  };

  const createPlace = async () => {
    const clean = String(newPlaceName || '').trim().replace(/\s+/g, ' ');
    if (clean.length < 2) {
      setPlaceError('Escribí un nombre de al menos 2 letras. Por ejemplo, Oficinas.');
      return;
    }
    if (clean.length > 60) {
      setPlaceError('El nombre es muy largo. Usá hasta 60 letras.');
      return;
    }
    const id = slugify(clean);
    if (!id) {
      setPlaceError('Usá letras o números en el nombre del lugar.');
      return;
    }
    if (areas.some((area) => area.id === id || slugify(area.name) === id)) {
      setPlaceError('Ya existe un lugar con ese nombre.');
      return;
    }
    const side = placeModal?.side;
    setPlaceBusy(true);
    setPlaceError('');
    try {
      const data = await apiFetch('/admin/areas', {
        method: 'POST',
        token: authToken,
        body: { name: clean }
      });
      const created = data.area;
      if (!created?.id) throw new Error('No se pudo crear el lugar.');
      let list = null;
      try {
        const fresh = await apiFetch('/admin/areas', { token: authToken, allowForbidden: true });
        if (Array.isArray(fresh.areas) && fresh.areas.length) list = fresh.areas;
      } catch {
        // Queda el lugar recién creado aunque no se pueda releer la lista.
      }
      setAreas((current) => {
        const base = list || current;
        return base.some((area) => area.id === created.id) ? base : [...base, created];
      });
      if (side) patchDraft({ [side]: created.id });
      setPlaceModal(null);
      setNewPlaceName('');
      setPlaceError('');
      focusPlaceSelect();
      onSuccess?.(`Lugar “${created.name || clean}” creado.`);
    } catch (err) {
      setPlaceError(err.message || 'No se pudo crear el lugar.');
    } finally {
      setPlaceBusy(false);
    }
  };

  const confirmLeave = (section, label) => (event) => {
    if (!dirty) return;
    event.preventDefault();
    setLeaveTo({ section, label });
  };

  const placeOptions = (prefix) => (
    <>
      {areas.map((area) => <option key={`${prefix}-${area.id}`} value={area.id}>{area.name}</option>)}
      <option value={NEW_PLACE}>+ Crear un lugar nuevo…</option>
    </>
  );

  return (
    <PageContainer width="medium">
      <div className="doors-admin-simple">
        <PageHeader
          title="Puertas"
          purpose="Cada puerta conecta el lugar de afuera con el de adentro. Así el sistema sabe si la persona entró o salió."
          howTo={[
            'Creá la puerta y ponéle el nombre que ve el guardia.',
            'Elegí desde dónde se llega y a qué lugar se entra.',
            'Indicá si el lector está solo afuera o también adentro.'
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
            text="Una puerta separa dos lugares, por ejemplo el estacionamiento y la planta. Sin puertas el sistema no puede dejar pasar a nadie."
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
              <div className="aui-card-grid">
                {filtered.map((door) => {
                  const phys = physicalById[door.id];
                  const inAirlock = airlockGroupsOfDoor(door.id, airlockGroups).length > 0;
                  const status = inAirlock ? 'Estanco' : (door.active !== false ? 'En uso' : 'Pausada');
                  return (
                    <article key={door._localId} className="aui-card">
                      <h4 className="aui-card__title">{door.name || 'Sin nombre'}</h4>
                      <p className="aui-card__meta">{kindLabel(door.kind)}</p>
                      <div className="door-flow" aria-label={`Afuera ${placeName(areas, door.placeA) || 'sin elegir'}, adentro ${placeName(areas, door.placeB) || 'sin elegir'}`}>
                        <div className="door-flow__place">
                          <span className="door-flow__tag">Afuera</span>
                          <strong>{door.placeA ? placeName(areas, door.placeA) : '—'}</strong>
                        </div>
                        <div className="door-flow__arrow" aria-hidden>→</div>
                        <div className="door-flow__place">
                          <span className="door-flow__tag">Adentro</span>
                          <strong>{door.placeB ? placeName(areas, door.placeB) : '—'}</strong>
                        </div>
                      </div>
                      {placesNeedChoice(door.placeA, door.placeB) ? (
                        <p className="aui-status is-warn" role="status">Falta indicar qué lugares conecta</p>
                      ) : null}
                      <p className="aui-card__meta">La maneja: {managedBy(door)}</p>
                      <p>
                        <span className={`aui-status${inAirlock ? ' is-warn' : ' is-ok'}`}>{status}</span>
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

      <Modal
        open={Boolean(draft)}
        size="lg"
        title={isNew ? 'Nueva puerta' : (draft?.name || 'Puerta')}
        description="Marcá el lugar de afuera y el de adentro. El sistema usa eso para saber si la persona entró o salió."
        dirty={dirty}
        onClose={closeDoor}
        footer={draft ? (
          <>
            <div className="aui-modal__footer-left">
              <button type="button" className="btn btn-secondary" data-aui-cancel="true" onClick={closeDoor}>
                Cancelar
              </button>
              {!isNew ? (
                <PendingButton
                  type="button"
                  actionId={`delete-door-${draft._localId}`}
                  pendingAction={pendingAction}
                  className="btn btn-danger-small"
                  onClick={deleteCurrentDoor}
                >
                  <Trash2 size={14} aria-hidden /> Eliminar puerta
                </PendingButton>
              ) : null}
            </div>
            <PendingButton
              type="button"
              actionId={`save-door-${draft._localId}`}
              pendingAction={pendingAction}
              className="btn btn-primary"
              onClick={saveCurrentDoor}
            >
              <Save size={16} aria-hidden /> Guardar
            </PendingButton>
          </>
        ) : null}
      >
        {draft ? (
          <>
            <h3 className="aui-section-title">Qué lugares conecta</h3>
            <div className="door-flow" aria-label="Esquema de la puerta, de afuera hacia adentro">
              <div className="door-flow__place">
                <span className="door-flow__tag">Lugar de afuera</span>
                <strong>{draft.placeA ? placeName(areas, draft.placeA) : 'Elegí el lugar'}</strong>
              </div>
              <div className="door-flow__arrow" aria-hidden>🚪→</div>
              <div className="door-flow__place">
                <span className="door-flow__tag">Lugar de adentro</span>
                <strong>{draft.placeB ? placeName(areas, draft.placeB) : 'Elegí el lugar'}</strong>
              </div>
            </div>
            <p className="aui-card__meta">
              ¿No está el lugar que buscás? Elegí «+ Crear un lugar nuevo…» en la lista, o administrá todos en{' '}
              <Link to={adminPath('lugares')} onClick={confirmLeave('lugares', 'Lugares')}>Puertas y equipos → Lugares</Link>.
            </p>
            <Field label="¿Desde dónde se llega a esta puerta?" error={fieldErrors.placeA}>
              <select
                className="input-field aui-select-lg"
                value={draft.placeA || ''}
                onChange={onPlaceSelect('placeA')}
              >
                <option value="">Elegir lugar de afuera</option>
                {placeOptions('a')}
              </select>
            </Field>
            <Field label="¿A qué lugar se entra al pasarla?" error={fieldErrors.placeB}>
              <select
                className="input-field aui-select-lg"
                value={draft.placeB || ''}
                onChange={onPlaceSelect('placeB')}
              >
                <option value="">Elegir lugar de adentro</option>
                {placeOptions('b')}
              </select>
            </Field>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => patchDraft(swapPlaces(draft.placeA, draft.placeB))}
            >
              ⇄ Invertir
            </button>
            <p className="aui-card__meta">Ej.: del Estacionamiento a la Planta.</p>
            {draft.placeA && draft.placeB ? (
              <p className="aui-card__meta">
                Así queda: desde «{placeName(areas, draft.placeA)}» hacia «{placeName(areas, draft.placeB)}».
              </p>
            ) : null}
            <p className="aui-card__meta">{SIDES_HELP}</p>

            <h3 className="aui-section-title">¿Dónde hay lectores?</h3>
            <div className="aui-picks" role="radiogroup" aria-label="¿Dónde hay lectores?">
              <button
                type="button"
                role="radio"
                aria-checked={draft.readersMode === 'outside'}
                className={`aui-pick${draft.readersMode === 'outside' ? ' is-selected' : ''}`}
                onClick={() => setReadersMode('outside')}
              >
                <strong>Solo afuera</strong>
                <span>Registra entradas.</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={draft.readersMode !== 'outside'}
                className={`aui-pick${draft.readersMode !== 'outside' ? ' is-selected' : ''}`}
                onClick={() => setReadersMode('both')}
              >
                <strong>Afuera y adentro</strong>
                <span>Registra entradas y salidas. Recomendado.</span>
              </button>
            </div>

            <h3 className="aui-section-title">Cómo se usa</h3>
            <Field label="Nombre" error={fieldErrors.name} help="Es el nombre que ve el guardia en su pantalla.">
              <input className="input-field" value={draft.name || ''} onChange={(event) => patchDraft({ name: event.target.value })} placeholder="Portón de clientes" />
            </Field>
            <Field label="Tipo" error={fieldErrors.kind} help="Puerta es una hoja. Portón es vehicular. Molinete deja pasar de a una persona.">
              <select className="input-field" value={draft.kind || 'door'} onChange={(event) => patchDraft({ kind: event.target.value })}>
                {DOOR_KINDS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </Field>
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
            <section className="aui-field" aria-label="Estancos de esta puerta">
              <span className="aui-field__label">
                Estancos
                <HelpTip text="En un estanco nunca se abren dos puertas a la vez. Los estancos se arman en su propia pantalla." />
              </span>
              {draftAirlocks.length ? (
                <>
                  <p className="aui-card__meta">Forma parte de:</p>
                  <ul className="aui-plain-list">
                    {draftAirlocks.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                </>
              ) : (
                <p className="aui-card__meta">No forma parte de ningún estanco.</p>
              )}
              <Link to={adminPath('estancos')} onClick={confirmLeave('estancos', 'Estancos')}>Editar estancos</Link>
            </section>
            <label className="aui-check">
              <input type="checkbox" checked={draft.requireGuardApproval === true} onChange={(event) => patchDraft({ requireGuardApproval: event.target.checked })} />
              <span>
                ¿El guardia tiene que aprobar cada ingreso?
                <HelpTip text="Sirve en el portón de clientes: la persona llega y el guardia confirma antes de abrir." />
              </span>
            </label>
            <label className="aui-check">
              <input type="checkbox" checked={draft.notifyGuardOnVisitor === true} onChange={(event) => patchDraft({ notifyGuardOnVisitor: event.target.checked })} />
              <span>
                ¿Avisar al guardia cuando pasa una visita o un externo?
                <HelpTip text="Al guardia le aparece un cartel con sonido para que confirme que es la persona. Los empleados no avisan." />
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
                <h3 className="aui-section-title">Personas de esta puerta</h3>
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
              <p className="aui-card__meta">Esto lo completa quien instala. La puerta se puede guardar sin estos datos.</p>
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
                  <option value="sr201">Placa de relé</option>
                  <option value="generic_http">Dirección web</option>
                </select>
              </Field>
              {draft.device?.driver === 'generic_http' ? (
                <>
                  <Field label="Dirección web de apertura">
                    <input className="input-field" value={draft.device?.httpUrl || ''} onChange={(event) => patchDraft({ device: { ...draft.device, httpUrl: event.target.value } })} />
                  </Field>
                  <Field label="Clave de esa dirección">
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
              <Field label="Lector de afuera">
                <input className="input-field" value={readers.find((reader) => reader.side === 'in')?.id || ''} onChange={(event) => setReaderId('in', event.target.value)} />
              </Field>
              {draft.readersMode !== 'outside' ? (
                <Field label="Lector de adentro">
                  <input className="input-field" value={readers.find((reader) => reader.side === 'out')?.id || ''} onChange={(event) => setReaderId('out', event.target.value)} />
                </Field>
              ) : null}
              <Field label="Enlace para abrir desde internet" help="Lo deja el instalador si alguna puerta se abre a distancia.">
                <input className="input-field" value={globalAccess.bridgeUrl || ''} onChange={(event) => { setGlobalAccess((prev) => ({ ...prev, bridgeUrl: event.target.value.trim() })); setDirty(true); }} />
              </Field>
              <Field label="Clave de ese enlace">
                <input className="input-field" type="password" value={globalAccess.bridgeSecret || ''} onChange={(event) => { setGlobalAccess((prev) => ({ ...prev, bridgeSecret: event.target.value })); setDirty(true); }} autoComplete="off" />
              </Field>
              <button type="button" className="btn btn-secondary" onClick={testPulse}>Probar apertura</button>
            </AdvancedSection>
          </>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(placeModal)}
        size="sm"
        title="Crear un lugar nuevo"
        description={PLACE_HELP}
        onClose={cancelPlace}
        footer={(
          <>
            <button type="button" className="btn btn-secondary" data-aui-cancel="true" onClick={cancelPlace}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" disabled={placeBusy} onClick={createPlace}>
              Crear
            </button>
          </>
        )}
      >
        <Field label="Nombre del lugar" error={placeError}>
          <input
            className="input-field"
            value={newPlaceName}
            onChange={(event) => { setNewPlaceName(event.target.value); setPlaceError(''); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                createPlace();
              }
            }}
            placeholder="Tesorería, Playa de camiones, Oficinas"
            aria-label="Nombre del lugar"
          />
        </Field>
      </Modal>

      <Modal
        open={Boolean(leaveTo)}
        size="sm"
        title="Cambios sin guardar"
        description="Si salís ahora, se pierde lo que cargaste en esta puerta."
        onClose={() => setLeaveTo(null)}
        footer={(
          <>
            <button type="button" className="btn btn-secondary" data-aui-cancel="true">
              Seguir acá
            </button>
            <button type="button" className="btn btn-primary" onClick={() => navigate(adminPath(leaveTo?.section || 'lugares'))}>
              Salir sin guardar
            </button>
          </>
        )}
      >
        <p>¿Querés ir a {leaveTo?.label || 'Lugares'} igual?</p>
      </Modal>
    </PageContainer>
  );
}

export default DoorsAdminPanel;

