import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, DoorOpen, PlusCircle, Save, Trash2 } from 'lucide-react';
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
  kioskResetSeconds: 4
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
      driver: 'sr201',
      bridgeUrl: '',
      bridgeSecret: '',
      port: 6722,
      ...(door.device || {}),
      host: String(door.device?.host || '').trim(),
      channel: Number(door.device?.channel) === 2 ? 2 : 1
    },
    pulseMode: door.pulseMode || 'inherit',
    pulseSeconds: Number(door.pulseSeconds) || 3,
    authMethods: door.authMethods?.length ? door.authMethods : ['dni', 'credential', 'manual'],
    readers,
    readerIds: readers.map((r) => r.id),
    kioskEnabled: door.kioskEnabled !== false,
    manualOpenAllowed: door.manualOpenAllowed !== false,
    autoOpenOnAuth: door.autoOpenOnAuth !== false,
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

/**
 * Admin puertas: listado + ficha individual con Guardar por puerta.
 */
function DoorsAdminPanel({ authToken, pendingAction, onPending, onSuccess, onError, onGlobalAccessSaved }) {
  const [doors, setDoors] = useState([]);
  const [airlockGroups, setAirlockGroups] = useState([]);
  const [defaultDoorId, setDefaultDoorId] = useState(null);
  const [globalAccess, setGlobalAccess] = useState(DEFAULT_GLOBAL);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [showPlant, setShowPlant] = useState(false);
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
    const timer = setInterval(refreshPhysicalStatus, 1500);
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
    const payloadDoors = nextDoors.map(({ _localId, doorCode, ...door }) => {
      const code = String(doorCode || 'P1').toUpperCase();
      const readers = ensureTwoReaders({ ...door, doorCode: code }, code);
      const pulseSeconds = Math.max(1, Math.min(99, Number(door.pulseSeconds) || 3));
      return {
        ...door,
        id: slugify(door.id || `puerta-${code}`) || createLocalId('puerta'),
        name: String(door.name || `Puerta ${code}`).trim(),
        active: door.active !== false,
        readers,
        readerIds: readers.map((r) => r.id),
        pulseMode: 'timed',
        pulseSeconds,
        airlockGroupId: door.airlockGroupId || null,
        airlockRole: door.airlockRole || null,
        device: {
          driver: 'sr201',
          ...(door.device || {}),
          host: String(door.device?.host || '').trim(),
          port: Number(door.device?.port) || 6722,
          channel: Number(door.device?.channel) === 2 ? 2 : 1
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
        throw new Error('Completá la URL del túnel');
      }
      await persistDoors(doors, defaultDoorId, globalAccess);
      onSuccess?.('Conexión a planta guardada');
      setShowPlant(false);
    });
  };

  const saveCurrentDoor = async () => {
    if (!draft) return;
    await onPending(`save-door-${draft._localId}`, async () => {
      if (!String(draft.device?.host || '').trim()) {
        throw new Error('Indicá la IP de la placa SR201');
      }
      if (!String(globalAccess.bridgeUrl || '').trim()) {
        throw new Error('Primero guardá la conexión a planta (URL del túnel)');
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
    if (!draft?.id && !doors.some((d) => d._localId === draft?._localId)) {
      onError?.('Guardá la puerta al menos una vez (con ID) antes de probar, o completá IP y Guardar.');
    }
    const doorId = draft?.id;
    if (!doorId) {
      onError?.('Guardá la puerta antes de probar el pulso (hace falta el ID).');
      return;
    }
    const seconds = Math.max(1, Math.min(99, Number(draft.pulseSeconds) || 3));
    await onPending(`test-door-${draft._localId}`, async () => {
      const data = await apiFetch('/access/test-relay', {
        method: 'POST',
        token: authToken,
        body: {
          doorId,
          pulseSeconds: seconds,
          pulseMode: 'timed'
        }
      });
      onSuccess?.(data.message || `Pulso enviado (${seconds}s)`);
    });
  };

  const bridgeOk = Boolean(String(globalAccess.bridgeUrl || '').trim());
  const readers = draft ? ensureTwoReaders(draft, draft.doorCode) : [];
  const ingreso = readers.find((r) => r.direction === 'ingreso');
  const egreso = readers.find((r) => r.direction === 'egreso');

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

      {/* Conexión planta */}
      <div className={`doors-plant-bar${bridgeOk ? '' : ' doors-plant-bar--warn'}`}>
        <button type="button" className="doors-plant-bar__toggle" onClick={() => setShowPlant((v) => !v)}>
          <span>
            <strong>Conexión a planta</strong>
            {bridgeOk
              ? ' · Túnel configurado'
              : ' · Falta URL del túnel (obligatorio para abrir relés)'}
          </span>
          <span>{showPlant ? 'Ocultar' : 'Configurar'}</span>
        </button>
        {showPlant && (
          <div className="doors-plant-bar__body">
            <p className="door-card__hint">
              Esto no es la IP de la placa. Es la URL del puente/túnel para que Firebase llegue a la LAN.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="door-field md:col-span-2">
                <span>URL pública del túnel</span>
                <input
                  className="input-field"
                  value={globalAccess.bridgeUrl || ''}
                  onChange={(e) => setGlobalAccess((prev) => ({ ...prev, bridgeUrl: e.target.value.trim() }))}
                  placeholder="https://xxxx.trycloudflare.com"
                />
              </label>
              <label className="door-field">
                <span>Secreto del puente</span>
                <input
                  className="input-field"
                  type="password"
                  value={globalAccess.bridgeSecret || ''}
                  onChange={(e) => setGlobalAccess((prev) => ({ ...prev, bridgeSecret: e.target.value }))}
                />
              </label>
              <label className="door-field">
                <span>Segundos de pulso</span>
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
              hint="Si está activo, un acceso válido dispara el relé solo."
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
                    <th className="px-3 py-2 text-left">Placa / canal</th>
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
                    const physClass = phys?.physicalState === 'open'
                      ? ' is-open'
                      : phys?.physicalState === 'closed'
                        ? ' is-closed'
                        : ' is-unknown';
                    return (
                      <tr key={door._localId} className="border-t doors-list-row" onClick={() => openDoor(door)}>
                        <td className="px-3 py-2">
                          <strong>{door.name}</strong>
                          <div className="historial-meta">{door.doorCode} · {door.id}</div>
                        </td>
                        <td className="px-3 py-2">
                          {door.device?.host || '—'} · CH{door.device?.channel || 1} · {door.pulseSeconds || 3}s
                        </td>
                        <td className="px-3 py-2">
                          <span className="doors-chip doors-chip--in">{r[0].id}</span>
                          {' '}
                          <span className="doors-chip doors-chip--out">{r[1].id}</span>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`doors-status${door.active !== false ? ' is-on' : ''}`}>
                            {door.active !== false ? 'Activa' : 'Inactiva'}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`doors-phys${physClass}`} title={phys?.error || phys?.queriedAt || ''}>
                            {phys?.physicalLabel || (physicalLoading ? '…' : '—')}
                          </span>
                          {phys?.relayOn != null && (
                            <div className="historial-meta">
                              Relé CH{phys.channel}: {phys.relayOn ? 'ON' : 'OFF'}
                            </div>
                          )}
                          {phys?.error && (
                            <div className="historial-meta" style={{ color: '#b45309', maxWidth: 220 }}>
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
            <h4 className="doors-detail-title">
              {doors.some((d) => d._localId === draft._localId) ? 'Configurar puerta' : 'Nueva puerta'}
            </h4>

            <section className="doors-detail-section">
              <h5>1. Datos de la puerta</h5>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="door-field">
                  <span>Nombre visible</span>
                  <input
                    className="input-field"
                    value={draft.name || ''}
                    onChange={(e) => patchDraft({ name: e.target.value })}
                    placeholder="Ej. Guardia principal"
                  />
                </label>
                <label className="door-field">
                  <span>Código (P1, P2…)</span>
                  <input
                    className="input-field"
                    value={draft.doorCode || ''}
                    onChange={(e) => syncDoorCodeReaders(e.target.value)}
                  />
                </label>
              </div>
              <div className="doors-toggles">
                <Toggle
                  checked={draft.active !== false}
                  onChange={(v) => patchDraft({ active: v })}
                  label="Puerta activa"
                  hint="Si está apagada, no se usa en aperturas ni lecturas."
                />
                <Toggle
                  checked={draft.manualOpenAllowed !== false}
                  onChange={(v) => patchDraft({ manualOpenAllowed: v })}
                  label="Permitir “Abrir puerta” desde el menú"
                  hint="Botón manual de guardia."
                />
                <Toggle
                  checked={draft.autoOpenOnAuth !== false}
                  onChange={(v) => patchDraft({ autoOpenOnAuth: v })}
                  label="Abrir relé al autorizar lectura"
                  hint="Cuando el DNI/credencial es válido, pulsa el canal."
                />
                <Toggle
                  checked={defaultDoorId === draft.id}
                  onChange={(v) => {
                    if (v) setDefaultDoorId(draft.id);
                    setDirty(true);
                  }}
                  label="Usar como puerta por defecto"
                  hint="La que usa el botón Abrir puerta si no hay selector."
                />
              </div>
            </section>

            <section className="doors-detail-section">
              <h5>2. Placa SR201 (relé)</h5>
              <p className="door-card__hint">
                Misma IP en dos puertas = una placa con canal 1 y canal 2. Una puerta usa un solo canal.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                <label className="door-field">
                  <span>IP de la placa</span>
                  <input
                    className="input-field"
                    value={draft.device?.host || ''}
                    onChange={(e) => patchDevice('host', e.target.value)}
                    placeholder="192.168.0.38"
                  />
                </label>
                <label className="door-field">
                  <span>Canal del relé</span>
                  <select
                    className="input-field"
                    value={draft.device?.channel || 1}
                    onChange={(e) => patchDevice('channel', Number(e.target.value))}
                  >
                    <option value={1}>Canal 1</option>
                    <option value={2}>Canal 2</option>
                  </select>
                </label>
                <label className="door-field">
                  <span>Temporizador (segundos)</span>
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
                <div className="flex items-end">
                  <PendingButton
                    type="button"
                    actionId={`test-door-${draft._localId}`}
                    pendingAction={pendingAction}
                    className="btn btn-secondary"
                    onClick={testPulse}
                  >
                    Probar pulso ({draft.pulseSeconds || 3}s)
                  </PendingButton>
                </div>
              </div>
              <p className="historial-meta" style={{ marginTop: '0.5rem' }}>
                Tiempo que el relé permanece activo al abrir esta puerta (1–99 s). Independiente por puerta.
              </p>
            </section>

            <section className="doors-detail-section">
              <h5>3. Lectores (ingreso y egreso)</h5>
              <p className="door-card__hint">
                El USB debe enviar <code>{ingreso?.id}#DNI</code> o <code>{egreso?.id}#DNI</code>.
              </p>
              <div className="doors-readers-grid">
                <div className="doors-reader-box doors-reader-box--in">
                  <strong>Lector de INGRESO</strong>
                  <label className="door-field">
                    <span>ID / prefijo</span>
                    <input
                      className="input-field"
                      value={ingreso?.id || ''}
                      onChange={(e) => setReader('ingreso', e.target.value.trim())}
                    />
                  </label>
                </div>
                <div className="doors-reader-box doors-reader-box--out">
                  <strong>Lector de EGRESO</strong>
                  <label className="door-field">
                    <span>ID / prefijo</span>
                    <input
                      className="input-field"
                      value={egreso?.id || ''}
                      onChange={(e) => setReader('egreso', e.target.value.trim())}
                    />
                  </label>
                </div>
              </div>
              <div className="doors-toggles" style={{ marginTop: '0.75rem' }}>
                <Toggle
                  checked={(draft.authMethods || []).includes('dni')}
                  onChange={(v) => patchDraft((prev) => {
                    const set = new Set(prev.authMethods || []);
                    if (v) set.add('dni'); else set.delete('dni');
                    return { ...prev, authMethods: [...set] };
                  })}
                  label="Aceptar DNI / QR"
                />
                <Toggle
                  checked={(draft.authMethods || []).includes('credential')}
                  onChange={(v) => patchDraft((prev) => {
                    const set = new Set(prev.authMethods || []);
                    if (v) set.add('credential'); else set.delete('credential');
                    return { ...prev, authMethods: [...set] };
                  })}
                  label="Aceptar tarjeta / credencial"
                />
              </div>
            </section>

            <section className="doors-detail-section">
              <h5>4. Autorizados en esta puerta</h5>
              {doors.some((d) => d._localId === draft._localId) ? (
                <DoorPeoplePanel
                  authToken={authToken}
                  doorId={draft.id}
                  doorName={draft.name}
                  onMessage={onSuccess}
                  onError={onError}
                />
              ) : (
                <p className="historial-meta">
                  Guardá la puerta primero para poder asignar personas autorizadas.
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
                <Save size={16} /> Guardar cambios de esta puerta
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
