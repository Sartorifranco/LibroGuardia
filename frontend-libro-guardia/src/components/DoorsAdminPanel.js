import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, DoorOpen, Info, PlusCircle, Save, Trash2, X } from 'lucide-react';
import PendingButton from './PendingButton';
import DoorPeoplePanel from './DoorPeoplePanel';
import { apiFetch } from '../services/api';

const createLocalId = (prefix = 'item') =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

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

const slugify = (value = '') =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const nextDoorCode = (doors = []) => {
  const used = new Set();
  doors.forEach((d) => {
    const m = String(d.id || d.doorCode || d.name || '').match(/p(\d+)/i);
    if (m) used.add(Number(m[1]));
  });
  let n = 1;
  while (used.has(n)) n += 1;
  return `P${n}`;
};

const ensureTwoReaders = (door, doorCode) => {
  const code = String(doorCode || 'P1').toUpperCase() || 'P1';
  const readers = Array.isArray(door.readers) ? door.readers : [];
  const ingreso = readers.find((r) => r.direction === 'ingreso');
  const egreso = readers.find((r) => r.direction === 'egreso');
  return [
    { id: ingreso?.id || `INGRESO_${code}`, direction: 'ingreso' },
    { id: egreso?.id || `EGRESO_${code}`, direction: 'egreso' }
  ];
};

const normalizeDoorLocal = (door = {}, fallbackCode = 'P1') => {
  const doorCode = String(door.doorCode || fallbackCode).toUpperCase();
  const readers = ensureTwoReaders(door, doorCode);
  return {
    _localId: door._localId || createLocalId('door'),
    id: door.id || `puerta-${doorCode.toLowerCase()}`,
    doorCode,
    name: door.name || `Puerta ${doorCode}`,
    active: door.active !== false,
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
    pulseMode: door.pulseMode || 'inherit',
    pulseSeconds: Number(door.pulseSeconds) || 3,
    relayMode: door.relayMode === 'local' ? 'local' : 'cloud',
    localStation: door.localStation || null,
    authMethods: door.authMethods?.length ? door.authMethods : ['dni', 'credential', 'manual'],
    readers,
    readerIds: readers.map((r) => r.id),
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
    name: `Puerta ${doorCode}`,
    device: { host: '', channel: 1, port: 6722, driver: 'sr201' }
  }, doorCode);
};

const Toggle = ({ checked, onChange, label, hint }) => (
  <label className="door-toggle">
    <input type="checkbox" checked={Boolean(checked)} onChange={(e) => onChange(e.target.checked)} />
    <span className="door-toggle__text">
      <strong>{label}</strong>
      {hint ? <small>{hint}</small> : null}
    </span>
  </label>
);

function SectionTip({ children }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="door-section-tip">
      <button
        type="button"
        className={`door-section-tip__btn${open ? ' is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Más información"
      >
        <Info size={14} />
      </button>
      {open ? (
        <span className="door-section-tip__panel" role="note">
          {children}
          <button type="button" className="door-section-tip__close" onClick={() => setOpen(false)} aria-label="Cerrar">
            <X size={12} />
          </button>
        </span>
      ) : null}
    </span>
  );
}

/** Explicación en lenguaje simple de “Conexión a planta”. */
function PlantConnectionInfo({ open, onClose }) {
  if (!open) return null;
  return (
    <div className="doors-plant-info" role="dialog" aria-labelledby="doors-plant-info-title">
      <div className="doors-plant-info__head">
        <h4 id="doors-plant-info-title">¿Para qué sirve la conexión a planta?</h4>
        <button type="button" className="doors-plant-info__close" onClick={onClose} aria-label="Cerrar">
          <X size={16} />
        </button>
      </div>
      <div className="doors-plant-info__body">
        <p>
          Cuando una persona pasa el DNI o un guardia abre una puerta desde la pantalla,
          el sistema necesita enviarle la orden a la cerradura que está en la planta.
        </p>
        <p>
          Esta sección es el <strong>enlace a distancia</strong> entre el sistema online
          y las puertas físicas.
        </p>
        <p><strong>La necesitás si:</strong></p>
        <ul>
          <li>Alguna puerta se abre “desde internet” (modo nube).</li>
          <li>Querés abrir o probar puertas desde el panel de administración a distancia.</li>
        </ul>
        <p><strong>No la necesitás si:</strong></p>
        <ul>
          <li>
            Todas las puertas abren desde la mini PC que está junto a la puerta
            (modo local). En ese caso la apertura ocurre en planta y este enlace no hace falta.
          </li>
        </ul>
        <p className="doors-plant-info__fields">
          <strong>Enlace:</strong> dirección para llegar a la planta.
          {' '}
          <strong>Clave:</strong> solo este sistema puede mandar la orden de abrir.
          {' '}
          <strong>Segundos de pulso:</strong> cuánto tiempo queda abierta la puerta.
          {' '}
          <strong>Apertura automática:</strong> si al validar el acceso se abre sola.
        </p>
      </div>
    </div>
  );
}

/**
 * Admin puertas: listado + ficha individual con Guardar por puerta.
 */
function DoorsAdminPanel({ authToken, pendingAction, onPending, onSuccess, onError, onGlobalAccessSaved }) {
  const [doors, setDoors] = useState([]);
  const [airlockGroups, setAirlockGroups] = useState([]);
  const [defaultDoorId, setDefaultDoorId] = useState(null);
  const [globalAccess, setGlobalAccess] = useState(DEFAULT_GLOBAL);
  const [, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [showPlant, setShowPlant] = useState(false);
  const [showPlantInfo, setShowPlantInfo] = useState(false);
  const [physicalById, setPhysicalById] = useState({});
  const [physicalLoading, setPhysicalLoading] = useState(false);
  const [physicalError, setPhysicalError] = useState('');
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const loadConfig = useCallback(async () => {
    const data = await apiFetch('/admin/doors-config', { token: authToken, allowForbidden: true });
    const list = (data.config?.doors || []).map((door, i) =>
      normalizeDoorLocal(door, nextDoorCode(data.config?.doors?.slice(0, i) || []))
    );
    setDoors(list);
    setAirlockGroups(data.config?.airlockGroups || []);
    setDefaultDoorId(data.config?.defaultDoorId || list[0]?.id || null);
    setGlobalAccess({ ...DEFAULT_GLOBAL, ...(data.globalAccess || {}) });
    if (!list.length) {
      setShowPlant(true);
    }
  }, [authToken]);

  useEffect(() => {
    loadConfig().catch((err) => onErrorRef.current?.(err.message));
  }, [loadConfig]);

  const refreshPhysicalStatus = useCallback(async () => {
    if (!authToken) return;
    setPhysicalLoading(true);
    try {
      const data = await apiFetch('/admin/doors/physical-status', {
        token: authToken,
        allowForbidden: true
      });
      const map = {};
      (data.doors || []).forEach((item) => {
        map[item.doorId] = item;
      });
      setPhysicalById(map);
      setPhysicalError(data.ok === false ? (data.message || '') : '');
    } catch (err) {
      setPhysicalError(err.message || 'No se pudo leer el estado físico');
    } finally {
      setPhysicalLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    if (draft) return undefined;
    refreshPhysicalStatus();
    const timer = setInterval(refreshPhysicalStatus, 12000);
    return () => clearInterval(timer);
  }, [draft, refreshPhysicalStatus]);

  const openDoor = (door) => {
    if (dirty && draft && !window.confirm('Hay cambios sin guardar en esta puerta. ¿Descartarlos?')) {
      return;
    }
    setSelectedId(door._localId);
    setDraft(normalizeDoorLocal(door, door.doorCode));
    setDirty(false);
  };

  const backToList = () => {
    if (dirty && !window.confirm('Hay cambios sin guardar. ¿Volver al listado sin guardar?')) return;
    setSelectedId(null);
    setDraft(null);
    setDirty(false);
  };

  const patchDraft = (patch) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = typeof patch === 'function' ? patch(prev) : { ...prev, ...patch };
      return next;
    });
    setDirty(true);
  };

  const patchDevice = (field, value) => {
    patchDraft((prev) => ({
      ...prev,
      device: { ...prev.device, [field]: value }
    }));
  };

  const setReader = (direction, readerId) => {
    patchDraft((prev) => {
      const readers = ensureTwoReaders(prev, prev.doorCode).map((r) =>
        (r.direction === direction ? { ...r, id: readerId } : r)
      );
      return { ...prev, readers, readerIds: readers.map((r) => r.id) };
    });
  };

  const syncDoorCodeReaders = (doorCode) => {
    const code = String(doorCode || 'P1').toUpperCase();
    patchDraft((prev) => {
      const readers = [
        { id: `INGRESO_${code}`, direction: 'ingreso' },
        { id: `EGRESO_${code}`, direction: 'egreso' }
      ];
      return {
        ...prev,
        doorCode: code,
        readers,
        readerIds: readers.map((r) => r.id),
        id: prev.id?.startsWith('puerta-') ? `puerta-${code.toLowerCase()}` : prev.id
      };
    });
  };

  const persistDoors = async (nextDoors, nextDefaultId = defaultDoorId, nextGlobal = globalAccess) => {
    const usedIds = new Set();
    const payloadDoors = nextDoors.map(({ _localId, doorCode, localStation, ...door }) => {
      const code = String(doorCode || 'P1').toUpperCase();
      const readers = ensureTwoReaders({ ...door, doorCode: code }, code);
      const pulseSeconds = Math.max(1, Math.min(99, Number(door.pulseSeconds) || 3));
      // Preferir id estable por código (P1 → puerta-p1) para no chocar al renombrar.
      let id = slugify(door.id || `puerta-${code}`) || createLocalId('puerta');
      if (usedIds.has(id)) {
        id = slugify(`puerta-${code}`) || createLocalId('puerta');
      }
      if (usedIds.has(id)) {
        id = createLocalId(`puerta-${code.toLowerCase()}`);
      }
      usedIds.add(id);
      return {
        ...door,
        id,
        name: String(door.name || `Puerta ${code}`).trim(),
        active: door.active !== false,
        readers,
        readerIds: readers.map((r) => r.id),
        pulseMode: 'timed',
        pulseSeconds,
        relayMode: door.relayMode === 'local' ? 'local' : 'cloud',
        isMainEntryDoor: door.isMainEntryDoor === true,
        airlockGroupId: door.airlockGroupId || null,
        airlockRole: door.airlockRole || null,
        device: {
          driver: door.device?.driver === 'generic_http' ? 'generic_http' : 'sr201',
          ...(door.device || {}),
          host: String(door.device?.host || '').trim(),
          port: Number(door.device?.port) || 6722,
          channel: Number(door.device?.channel) === 2 ? 2 : 1,
          httpUrl: String(door.device?.httpUrl || '').trim(),
          httpMethod: String(door.device?.httpMethod || 'POST').toUpperCase() || 'POST',
          httpAuthToken: String(door.device?.httpAuthToken || '')
        }
      };
    });

    const defaultId = payloadDoors.some((d) => d.id === nextDefaultId)
      ? nextDefaultId
      : payloadDoors[0]?.id || null;

    const data = await apiFetch('/admin/doors-config', {
      method: 'PUT',
      token: authToken,
      body: {
        doors: payloadDoors,
        airlockGroups,
        defaultDoorId: defaultId,
        globalAccess: {
          ...nextGlobal,
          host: payloadDoors[0]?.device?.host || nextGlobal.host || '',
          relayChannel: payloadDoors[0]?.device?.channel || 1
        }
      }
    });

    const list = (data.config?.doors || []).map((door, i) =>
      normalizeDoorLocal(door, nextDoorCode(data.config?.doors?.slice(0, i) || []))
    );
    setDoors(list);
    setAirlockGroups(data.config?.airlockGroups || []);
    setDefaultDoorId(data.config?.defaultDoorId || null);
    setGlobalAccess({ ...DEFAULT_GLOBAL, ...(data.globalAccess || {}) });
    onGlobalAccessSaved?.(data.globalAccess);
    return list;
  };

  const savePlantConnection = async () => {
    await onPending('savePlantConnection', async () => {
      if (!String(globalAccess.bridgeUrl || '').trim()) {
        throw new Error('Completá el enlace a planta');
      }
      await persistDoors(doors, defaultDoorId, globalAccess);
      onSuccess?.('Conexión a planta guardada');
      setShowPlant(false);
    });
  };

  const saveCurrentDoor = async () => {
    if (!draft) return;
    const isLocalRelay = draft.relayMode === 'local';
    await onPending(`save-door-${draft._localId}`, async () => {
      const isHttp = draft.device?.driver === 'generic_http';
      if (isHttp) {
        if (!String(draft.device?.httpUrl || '').trim()) {
          throw new Error('Indicá la URL de apertura (HTTP)');
        }
      } else if (!String(draft.device?.host || '').trim()) {
        throw new Error('Indicá la IP de la placa SR201');
      }
      // En modo local el disparo lo hace la mini PC de la puerta por la LAN:
      // no hace falta túnel/puente para esta puerta.
      // HTTP genérico en modo a distancia tampoco necesita túnel SR201.
      if (!isLocalRelay && !isHttp && !String(globalAccess.bridgeUrl || '').trim()) {
        throw new Error('Primero guardá la conexión a planta, o configurá esta puerta para que abra en modo local');
      }
      const normalized = normalizeDoorLocal(draft, draft.doorCode);
      const exists = doors.some((d) => d._localId === normalized._localId);
      const nextDoors = exists
        ? doors.map((d) => (d._localId === normalized._localId ? normalized : d))
        : [...doors, normalized];
      const list = await persistDoors(nextDoors, defaultDoorId || normalized.id, globalAccess);
      const saved = list.find((d) => d.id === slugify(normalized.id)) || list.find((d) => d.name === normalized.name);
      if (saved) {
        setSelectedId(saved._localId);
        setDraft(saved);
      }
      setDirty(false);
      onSuccess?.(`Puerta “${normalized.name}” guardada`);
    });
  };

  const deleteCurrentDoor = async () => {
    if (!draft) return;
    if (!window.confirm(`¿Eliminar la puerta “${draft.name}”?`)) return;
    await onPending(`delete-door-${draft._localId}`, async () => {
      const nextDoors = doors.filter((d) => d._localId !== draft._localId);
      await persistDoors(nextDoors, defaultDoorId, globalAccess);
      setSelectedId(null);
      setDraft(null);
      setDirty(false);
      onSuccess?.('Puerta eliminada');
    });
  };

  const addNewDoor = () => {
    if (dirty && draft && !window.confirm('Hay cambios sin guardar. ¿Descartarlos y crear otra puerta?')) {
      return;
    }
    const blank = createBlankDoor(doors);
    setSelectedId(blank._localId);
    setDraft(blank);
    setDirty(true);
  };

  const testPulse = async () => {
    const doorId = draft?.id;
    if (!doorId) {
      onError?.('Guardá la puerta antes de probar la apertura (hace falta el ID).');
      return;
    }
    const seconds = Math.max(1, Math.min(99, Number(draft.pulseSeconds) || 3));

    await onPending(`test-door-${draft._localId}`, async () => {
      // Un solo camino: HTTPS → API. Si la puerta es local, la nube encola
      // y el bridge de esta PC abre el relé (sin Mixed Content ni secretos).
      const data = await apiFetch('/access/test-relay', {
        method: 'POST',
        token: authToken,
        body: {
          doorId,
          pulseSeconds: seconds,
          pulseMode: 'timed'
        }
      });
      const via = data?.relay?.via || data?.via;
      if (via === 'local-queue') {
        onSuccess?.(
          data.message
          || `Pedido enviado a la estación. La puerta debería abrir en ~2 s (${seconds}s de pulso).`
        );
        return;
      }
      onSuccess?.(data.message || `Pulso enviado (${seconds}s)`);
    });
  };

  const readers = draft ? ensureTwoReaders(draft, draft.doorCode) : [];
  const ingreso = readers.find((r) => r.direction === 'ingreso');
  const egreso = readers.find((r) => r.direction === 'egreso');

  const bridgeOk = Boolean(String(globalAccess.bridgeUrl || '').trim());
  const cloudDoorsCount = useMemo(
    () => doors.filter((d) => (d.relayMode || 'cloud') !== 'local').length,
    [doors]
  );
  const allDoorsLocal = doors.length > 0 && cloudDoorsCount === 0;
  const plantNeedsAttention = !bridgeOk && !allDoorsLocal;
  const plantStatusLabel = bridgeOk
    ? 'Enlace remoto listo'
    : allDoorsLocal
      ? 'Opcional (todas las puertas abren en planta)'
      : 'Falta configurar el enlace remoto';

  return (
    <div className="admin-sub-section doors-admin-v2">
      <div className="doors-v2-header">
        <div>
          <p className="theme-section-desc" style={{ margin: 0 }}>
            Cada puerta = 1 canal de una placa SR201 + 2 lectores (ingreso/egreso) + autorizados.
            Una placa (1 IP) puede alimentar hasta 2 puertas (canal 1 y 2).
          </p>
        </div>
      </div>

      {/* Conexión planta — sigue vigente para puertas en modo nube / apertura remota */}
      <div className={`doors-plant-bar${plantNeedsAttention ? ' doors-plant-bar--warn' : ''}`}>
        <div className="doors-plant-bar__row">
          <button type="button" className="doors-plant-bar__toggle" onClick={() => setShowPlant((v) => !v)}>
            <span>
              <strong>Conexión a planta</strong>
              {' · '}
              {plantStatusLabel}
            </span>
            <span>{showPlant ? 'Ocultar' : 'Configurar'}</span>
          </button>
          <button
            type="button"
            className={`doors-plant-info-btn${showPlantInfo ? ' is-open' : ''}`}
            onClick={() => setShowPlantInfo((v) => !v)}
            aria-expanded={showPlantInfo}
            aria-controls="doors-plant-info-panel"
            title="¿Para qué sirve esto?"
          >
            <Info size={16} />
            <span className="sr-only">Información sobre conexión a planta</span>
          </button>
        </div>
        <div id="doors-plant-info-panel">
          <PlantConnectionInfo open={showPlantInfo} onClose={() => setShowPlantInfo(false)} />
        </div>
        {showPlant && (
          <div className="doors-plant-bar__body">
            <p className="door-card__hint">
              {allDoorsLocal
                ? 'Hoy todas tus puertas abren en planta (modo local). Podés dejar esto vacío o configurarlo por si más adelante necesitás abrir alguna a distancia.'
                : 'Usá este enlace cuando una puerta deba abrirse a distancia desde el sistema online. Si la puerta abre desde su mini PC (modo local), no hace falta.'}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="door-field md:col-span-2">
                <span>Enlace a planta</span>
                <input
                  className="input-field"
                  value={globalAccess.bridgeUrl || ''}
                  onChange={(e) => setGlobalAccess((prev) => ({ ...prev, bridgeUrl: e.target.value.trim() }))}
                  placeholder="Pegá acá el enlace que te dio el técnico"
                />
              </label>
              <label className="door-field">
                <span>Clave de seguridad</span>
                <input
                  className="input-field"
                  type="password"
                  value={globalAccess.bridgeSecret || ''}
                  onChange={(e) => setGlobalAccess((prev) => ({ ...prev, bridgeSecret: e.target.value }))}
                />
              </label>
              <label className="door-field">
                <span>Segundos que queda abierta</span>
                <input
                  className="input-field"
                  type="number"
                  min="1"
                  max="99"
                  value={globalAccess.pulseSeconds || 3}
                  onChange={(e) => setGlobalAccess((prev) => ({
                    ...prev,
                    pulseMode: 'timed',
                    pulseSeconds: Number(e.target.value)
                  }))}
                />
              </label>
            </div>
            <Toggle
              checked={globalAccess.enabled}
              onChange={(v) => setGlobalAccess((prev) => ({ ...prev, enabled: v }))}
              label="Apertura automática al autorizar"
              hint="Si está activo, un acceso válido abre la puerta solo."
            />
            <Toggle
              checked={globalAccess.identityVerificationAtMainEntry === true}
              onChange={(v) => setGlobalAccess((prev) => ({
                ...prev,
                identityVerificationAtMainEntry: v
              }))}
              label="Verificación con foto en ingreso principal"
              hint="Feature opcional: al pasar el DNI en una puerta marcada como ingreso principal, el guardia ve un popup con datos y foto."
            />
            <PendingButton
              type="button"
              actionId="savePlantConnection"
              pendingAction={pendingAction}
              className="btn btn-secondary mt-3"
              onClick={savePlantConnection}
            >
              <Save size={16} /> Guardar conexión a planta
            </PendingButton>
          </div>
        )}
      </div>

      {/* LISTADO */}
      {!draft && (
        <div className="doors-list-view">
          <div className="doors-list-toolbar">
            <h4>Listado de puertas ({doors.length})</h4>
            <div className="doors-list-toolbar__actions">
              <button
                type="button"
                className="btn btn-secondary-small"
                onClick={refreshPhysicalStatus}
                disabled={physicalLoading}
              >
                {physicalLoading ? 'Leyendo…' : 'Actualizar estado físico'}
              </button>
              <button type="button" className="btn btn-primary" onClick={addNewDoor}>
                <PlusCircle size={16} /> Agregar nueva puerta
              </button>
            </div>
          </div>
          {physicalError && (
            <p className="historial-meta" style={{ marginBottom: '0.5rem', color: '#b45309' }}>
              {physicalError}
            </p>
          )}

          {doors.length === 0 ? (
            <div className="doors-list-empty">
              <DoorOpen size={28} />
              <p>Todavía no hay puertas.</p>
              <p className="historial-meta">Creá la primera: IP de placa + canal + lectores ingreso/egreso.</p>
              <button type="button" className="btn btn-primary" onClick={addNewDoor}>
                <PlusCircle size={16} /> Agregar nueva puerta
              </button>
            </div>
          ) : (
            <div className="doors-list-table wrap">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="px-3 py-2 text-left">Puerta</th>
                    <th className="px-3 py-2 text-left">Cómo abre</th>
                    <th className="px-3 py-2 text-left">Lectores</th>
                    <th className="px-3 py-2 text-left">Config</th>
                    <th className="px-3 py-2 text-left">Estado físico</th>
                    <th className="px-3 py-2 text-left" />
                  </tr>
                </thead>
                <tbody>
                  {doors.map((door) => {
                    const r = ensureTwoReaders(door, door.doorCode);
                    const phys = physicalById[door.id];
                    const isLocal = (door.relayMode || phys?.relayMode) === 'local'
                      || phys?.physicalState === 'local';
                    const physClass = phys?.physicalState === 'open'
                      ? ' is-open'
                      : phys?.physicalState === 'closed'
                        ? ' is-closed'
                        : phys?.physicalState === 'local'
                          ? ' is-local'
                          : phys?.physicalState === 'error'
                            ? ' is-error'
                            : ' is-unknown';
                    return (
                      <tr key={door._localId} className="border-t doors-list-row" onClick={() => openDoor(door)}>
                        <td className="px-3 py-2">
                          <strong>{door.name}</strong>
                          <div className="historial-meta">{door.doorCode} · {door.id}</div>
                        </td>
                        <td className="px-3 py-2">
                          {door.device?.driver === 'generic_http' ? (
                            <>
                              URL HTTP · {door.pulseSeconds || 3}s
                              <div className="historial-meta">{door.device?.httpUrl || '—'}</div>
                            </>
                          ) : (
                            <>
                              {door.device?.host || '—'} · CH{door.device?.channel || 1} · {door.pulseSeconds || 3}s
                              <div className="historial-meta">Placa SR201</div>
                            </>
                          )}
                          <div className="historial-meta">
                            {(door.relayMode || 'cloud') === 'local' ? 'Abre en planta' : 'Abre a distancia'}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <span className="doors-chip doors-chip--in">Entrada</span>
                          {' '}
                          <span className="doors-chip doors-chip--out">Salida</span>
                          <div className="historial-meta">{r[0].id} / {r[1].id}</div>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`doors-status${door.active !== false ? ' is-on' : ''}`}>
                            {door.active !== false ? 'Activa' : 'Inactiva'}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`doors-phys${physClass}`}
                            title={phys?.hint || phys?.error || phys?.queriedAt || ''}
                          >
                            {phys?.physicalLabel || (physicalLoading ? '…' : '—')}
                          </span>
                          {phys?.relayOn != null && (
                            <div className="historial-meta">
                              Ahora: {phys.relayOn ? 'abierta' : 'cerrada'}
                            </div>
                          )}
                          {isLocal && phys?.hint && (
                            <div className="historial-meta">{phys.hint}</div>
                          )}
                          {!isLocal && phys?.error && (
                            <div className="historial-meta doors-phys-error">
                              {phys.error}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button type="button" className="btn btn-secondary-small" onClick={(e) => { e.stopPropagation(); openDoor(door); }}>
                            Configurar
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* FICHA */}
      {draft && (
        <div className="doors-detail-view">
          <div className="doors-detail-top">
            <button type="button" className="btn btn-secondary-small" onClick={backToList}>
              <ChevronLeft size={16} /> Volver al listado
            </button>
            {dirty && <span className="doors-dirty">Cambios sin guardar</span>}
          </div>

          <div className="doors-detail-card">
            <header className="doors-detail-hero">
              <div>
                <p className="doors-detail-eyebrow">Configuración de puerta</p>
                <h4 className="doors-detail-title">
                  {doors.some((d) => d._localId === draft._localId) ? (draft.name || 'Puerta') : 'Nueva puerta'}
                </h4>
              </div>
              <span className={`doors-status${draft.active !== false ? ' is-on' : ''}`}>
                {draft.active !== false ? 'Activa' : 'Inactiva'}
              </span>
            </header>

            <section className="doors-detail-section">
              <div className="doors-detail-section__head">
                <h5>1. Identidad</h5>
                <SectionTip>
                  El nombre es lo que ve el guardia. El código (P1, P2…) identifica la puerta en el sistema.
                </SectionTip>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="door-field">
                  <span>Nombre visible</span>
                  <input
                    className="input-field"
                    value={draft.name || ''}
                    onChange={(e) => patchDraft({ name: e.target.value })}
                    placeholder="Ej. Acceso principal"
                  />
                </label>
                <label className="door-field">
                  <span>Código</span>
                  <input
                    className="input-field"
                    value={draft.doorCode || ''}
                    onChange={(e) => syncDoorCodeReaders(e.target.value)}
                    placeholder="P1"
                  />
                </label>
              </div>
              <div className="doors-option-grid">
                <Toggle
                  checked={draft.active !== false}
                  onChange={(v) => patchDraft({ active: v })}
                  label="Puerta en uso"
                  hint="Si la apagás, no se usa para abrir ni para lecturas."
                />
                <Toggle
                  checked={draft.manualOpenAllowed !== false}
                  onChange={(v) => patchDraft({ manualOpenAllowed: v })}
                  label="Botón “Abrir” para el guardia"
                  hint="Permite abrirla a mano desde la botonera."
                />
                <Toggle
                  checked={draft.autoOpenOnAuth !== false}
                  onChange={(v) => patchDraft({ autoOpenOnAuth: v })}
                  label="Abrir sola al autorizar"
                  hint="Si el DNI es válido, la puerta se abre automáticamente."
                />
                <Toggle
                  checked={draft.isMainEntryDoor === true}
                  onChange={(v) => patchDraft({ isMainEntryDoor: v })}
                  label="Ingreso principal (verificación)"
                  hint="Por acá ingresan las personas. Si el feature de foto está activo, el guardia ve un aviso con foto al escanear el DNI."
                />
                <Toggle
                  checked={defaultDoorId === draft.id}
                  onChange={(v) => {
                    if (v) setDefaultDoorId(draft.id);
                    setDirty(true);
                  }}
                  label="Puerta por defecto"
                  hint="La que se usa por defecto si no se elige otra."
                />
              </div>
            </section>

            <section className="doors-detail-section">
              <div className="doors-detail-section__head">
                <h5>2. Cómo se abre</h5>
                <SectionTip>
                  <p>
                    <strong>En planta:</strong> la mini PC de la puerta manda la orden. Más simple y no depende del enlace remoto.
                  </p>
                  <p>
                    <strong>A distancia:</strong> el sistema online manda la orden. Sirve para abrir desde internet; necesita “Conexión a planta” (salvo apertura por URL).
                  </p>
                  <p>
                    <strong>Placa SR201:</strong> relé por IP y canal (1 o 2).
                  </p>
                  <p>
                    <strong>Apertura por URL:</strong> el sistema llama a una dirección web del equipo (controladora, Shelly, etc.).
                  </p>
                </SectionTip>
              </div>

              <div className="doors-mode-cards" role="radiogroup" aria-label="Modo de apertura">
                <button
                  type="button"
                  className={`doors-mode-card${(draft.relayMode || 'cloud') === 'local' ? ' is-selected' : ''}`}
                  onClick={() => patchDraft({ relayMode: 'local' })}
                >
                  <strong>En planta</strong>
                  <span>La mini PC abre la puerta. Recomendado.</span>
                </button>
                <button
                  type="button"
                  className={`doors-mode-card${(draft.relayMode || 'cloud') === 'cloud' ? ' is-selected' : ''}`}
                  onClick={() => patchDraft({ relayMode: 'cloud' })}
                >
                  <strong>A distancia</strong>
                  <span>Se abre desde internet. Requiere conexión a planta (placa) o URL pública.</span>
                </button>
              </div>

              <div className="doors-mode-cards" role="radiogroup" aria-label="Tipo de equipo que abre">
                <button
                  type="button"
                  className={`doors-mode-card${(draft.device?.driver || 'sr201') !== 'generic_http' ? ' is-selected' : ''}`}
                  onClick={() => patchDevice('driver', 'sr201')}
                >
                  <strong>Placa SR201</strong>
                  <span>Relé por IP y canal. El estándar de planta.</span>
                </button>
                <button
                  type="button"
                  className={`doors-mode-card${draft.device?.driver === 'generic_http' ? ' is-selected' : ''}`}
                  onClick={() => patchDevice('driver', 'generic_http')}
                >
                  <strong>Apertura por URL</strong>
                  <span>El sistema llama a una dirección web del equipo.</span>
                </button>
              </div>

              <div className="doors-hw-grid">
                {(draft.device?.driver || 'sr201') !== 'generic_http' ? (
                  <>
                    <label className="door-field">
                      <span>Dirección de la placa</span>
                      <input
                        className="input-field"
                        value={draft.device?.host || ''}
                        onChange={(e) => patchDevice('host', e.target.value)}
                        placeholder="192.168.0.38"
                      />
                    </label>
                    <label className="door-field">
                      <span>Canal</span>
                      <select
                        className="input-field"
                        value={draft.device?.channel || 1}
                        onChange={(e) => patchDevice('channel', Number(e.target.value))}
                      >
                        <option value={1}>Canal 1</option>
                        <option value={2}>Canal 2</option>
                      </select>
                    </label>
                  </>
                ) : (
                  <>
                    <label className="door-field">
                      <span>URL de apertura</span>
                      <input
                        className="input-field"
                        value={draft.device?.httpUrl || ''}
                        onChange={(e) => patchDevice('httpUrl', e.target.value)}
                        placeholder="https://equipo.local/open"
                      />
                    </label>
                    <label className="door-field">
                      <span>Método</span>
                      <select
                        className="input-field"
                        value={draft.device?.httpMethod || 'POST'}
                        onChange={(e) => patchDevice('httpMethod', e.target.value)}
                      >
                        <option value="POST">POST</option>
                        <option value="PUT">PUT</option>
                        <option value="GET">GET</option>
                      </select>
                    </label>
                    <label className="door-field">
                      <span>Token (opcional)</span>
                      <input
                        className="input-field"
                        value={draft.device?.httpAuthToken || ''}
                        onChange={(e) => patchDevice('httpAuthToken', e.target.value)}
                        placeholder="Si el equipo pide autenticación"
                        autoComplete="off"
                      />
                    </label>
                  </>
                )}
                <label className="door-field">
                  <span>Segundos abierta</span>
                  <input
                    className="input-field"
                    type="number"
                    min="1"
                    max="99"
                    value={draft.pulseSeconds || 3}
                    onChange={(e) => patchDraft({
                      pulseMode: 'timed',
                      pulseSeconds: Math.max(1, Math.min(99, Number(e.target.value) || 3))
                    })}
                  />
                </label>
                <div className="doors-hw-actions">
                  <PendingButton
                    type="button"
                    actionId={`test-door-${draft._localId}`}
                    pendingAction={pendingAction}
                    className="btn btn-secondary"
                    onClick={testPulse}
                  >
                    Probar apertura ({draft.pulseSeconds || 3}s)
                  </PendingButton>
                  <small className="door-card__hint">
                    {draft.device?.driver === 'generic_http'
                      ? 'Apertura por URL: el sistema envía { action, seconds } a esa dirección.'
                      : (draft.relayMode || 'cloud') === 'local'
                        ? 'Modo planta: un clic acá. El pedido va por internet a la estación y abre el relé solo (~2 s). El bridge tiene que estar corriendo en esta PC.'
                        : 'Modo a distancia: usa la Conexión a planta (túnel). Si dice sin conexión, el túnel o el puente no están activos.'}
                  </small>
                </div>
              </div>
            </section>

            <section className="doors-detail-section">
              <div className="doors-detail-section__head">
                <h5>3. Lectores de entrada y salida</h5>
                <SectionTip>
                  Cada puerta tiene un lector de entrada y uno de salida.
                  El identificador debe coincidir con el configurado en el lector físico
                  (por ejemplo {ingreso?.id || 'INGRESO_P1'}).
                </SectionTip>
              </div>
              <div className="doors-readers-grid">
                <div className="doors-reader-box doors-reader-box--in">
                  <strong>Entrada</strong>
                  <label className="door-field">
                    <span>Identificador del lector</span>
                    <input
                      className="input-field"
                      value={ingreso?.id || ''}
                      onChange={(e) => setReader('ingreso', e.target.value.trim())}
                    />
                  </label>
                </div>
                <div className="doors-reader-box doors-reader-box--out">
                  <strong>Salida</strong>
                  <label className="door-field">
                    <span>Identificador del lector</span>
                    <input
                      className="input-field"
                      value={egreso?.id || ''}
                      onChange={(e) => setReader('egreso', e.target.value.trim())}
                    />
                  </label>
                </div>
              </div>
              <div className="doors-option-grid doors-option-grid--compact">
                <Toggle
                  checked={(draft.authMethods || []).includes('dni')}
                  onChange={(v) => patchDraft((prev) => {
                    const set = new Set(prev.authMethods || []);
                    if (v) set.add('dni'); else set.delete('dni');
                    return { ...prev, authMethods: [...set] };
                  })}
                  label="Aceptar DNI / QR"
                  hint="Documento o código QR de ingreso."
                />
                <Toggle
                  checked={(draft.authMethods || []).includes('credential')}
                  onChange={(v) => patchDraft((prev) => {
                    const set = new Set(prev.authMethods || []);
                    if (v) set.add('credential'); else set.delete('credential');
                    return { ...prev, authMethods: [...set] };
                  })}
                  label="Aceptar tarjeta"
                  hint="Credencial física si el lector la soporta."
                />
                <Toggle
                  checked={
                    (draft.authMethods || []).includes('biometric')
                    || (draft.authMethods || []).includes('face')
                  }
                  onChange={(v) => patchDraft((prev) => {
                    const set = new Set(prev.authMethods || []);
                    if (v) {
                      set.add('biometric');
                      set.delete('face');
                    } else {
                      set.delete('biometric');
                      set.delete('face');
                    }
                    return { ...prev, authMethods: [...set] };
                  })}
                  label="Aceptar biométrico"
                  hint="Huella o rostro (ZKTeco, Hikvision, Suprema, etc.)."
                />
              </div>
            </section>

            <section className="doors-detail-section">
              <div className="doors-detail-section__head">
                <h5>4. Quién puede pasar</h5>
                <SectionTip>
                  Acá ves y gestionás las personas habilitadas para esta puerta.
                  Si no están en la lista, no entran por este acceso.
                </SectionTip>
              </div>
              {doors.some((d) => d._localId === draft._localId) ? (
                <DoorPeoplePanel
                  authToken={authToken}
                  doorId={draft.id}
                  doorName={draft.name}
                  onMessage={onSuccess}
                  onError={onError}
                />
              ) : (
                <p className="door-people__empty">
                  Guardá la puerta primero para poder asignar personas.
                </p>
              )}
            </section>

            <div className="doors-detail-actions">
              <PendingButton
                type="button"
                actionId={`save-door-${draft._localId}`}
                pendingAction={pendingAction}
                className="btn btn-primary"
                onClick={saveCurrentDoor}
              >
                <Save size={16} /> Guardar cambios
              </PendingButton>
              {doors.some((d) => d._localId === draft._localId) && (
                <PendingButton
                  type="button"
                  actionId={`delete-door-${draft._localId}`}
                  pendingAction={pendingAction}
                  className="btn btn-danger-small"
                  onClick={deleteCurrentDoor}
                >
                  <Trash2 size={14} /> Eliminar puerta
                </PendingButton>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DoorsAdminPanel;
