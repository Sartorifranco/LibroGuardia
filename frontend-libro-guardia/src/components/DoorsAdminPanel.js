import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PlusCircle, Save, Trash2 } from 'lucide-react';
import PendingButton from './PendingButton';

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || '/api';

const createLocalId = (prefix = 'item') =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const attachLocalIds = (config = {}) => ({
  ...config,
  doors: (config.doors || []).map((door) => ({
    ...door,
    _localId: door._localId || createLocalId('door')
  })),
  airlockGroups: (config.airlockGroups || []).map((group) => ({
    ...group,
    _localId: group._localId || createLocalId('airlock')
  }))
});

const stripLocalIds = (config = {}) => ({
  ...config,
  doors: (config.doors || []).map(({ _localId, ...door }) => door),
  airlockGroups: (config.airlockGroups || []).map(({ _localId, ...group }) => group)
});

const mergeLocalIds = (previous = {}, incoming = {}) => {
  const prevDoors = previous.doors || [];
  const prevGroups = previous.airlockGroups || [];
  return attachLocalIds({
    ...incoming,
    doors: (incoming.doors || []).map((door, index) => ({
      ...door,
      _localId:
        prevDoors.find((item) => item.id && item.id === door.id)?._localId
        || prevDoors[index]?._localId
        || createLocalId('door')
    })),
    airlockGroups: (incoming.airlockGroups || []).map((group, index) => ({
      ...group,
      _localId:
        prevGroups.find((item) => item.id && item.id === group.id)?._localId
        || prevGroups[index]?._localId
        || createLocalId('airlock')
    }))
  });
};

const AUTH_LABELS = {
  dni: 'DNI / QR',
  face: 'Rostro (próximamente)',
  credential: 'Tarjeta / credencial',
  manual: 'Apertura manual guardia'
};

const DEFAULT_GLOBAL = {
  enabled: false,
  host: '192.168.1.100',
  port: 6722,
  bridgeUrl: '',
  bridgeSecret: '',
  relayChannel: 1,
  pulseMode: 'jog',
  pulseSeconds: 3,
  allowManualOverride: false,
  denyMessage: 'Acceso denegado: no tiene autorización vigente',
  kioskResetSeconds: 4
};

const emptyDoor = () => ({
  _localId: createLocalId('door'),
  id: '',
  name: '',
  active: true,
  device: { bridgeUrl: '', bridgeSecret: '', host: '', port: 6722, channel: 1 },
  pulseMode: 'inherit',
  pulseSeconds: 3,
  authMethods: ['dni', 'credential'],
  readerIds: ['default'],
  kioskEnabled: true,
  manualOpenAllowed: true,
  autoOpenOnAuth: true,
  airlockGroupId: '',
  airlockRole: '',
  sequenceOrder: 0
});

const emptyAirlock = () => ({
  _localId: createLocalId('airlock'),
  id: '',
  name: '',
  doorIds: ['', ''],
  enabled: true,
  outerCloseDelayMs: 5000,
  interDoorDelayMs: 2000,
  transitTimeoutMs: 120000,
  requireInnerAuth: true
});

function DoorsAdminPanel({ authToken, pendingAction, onPending, onSuccess, onError, onGlobalAccessSaved }) {
  const [config, setConfig] = useState({ doors: [], airlockGroups: [], defaultDoorId: null });
  const [globalAccess, setGlobalAccess] = useState(DEFAULT_GLOBAL);
  const [authMethods, setAuthMethods] = useState(['dni', 'credential', 'manual']);
  const [legacyFallback, setLegacyFallback] = useState(false);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const loadConfig = useCallback(async () => {
    const response = await fetch(`${API_BASE_URL}/admin/doors-config`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Error al cargar puertas');
    setConfig((prev) => mergeLocalIds(prev, data.config || { doors: [], airlockGroups: [] }));
    setGlobalAccess({ ...DEFAULT_GLOBAL, ...(data.globalAccess || {}) });
    setAuthMethods(data.authMethods || ['dni', 'credential', 'manual']);
    setLegacyFallback(Boolean(data.meta?.legacyFallback));
  }, [authToken]);

  useEffect(() => {
    loadConfig().catch((err) => onErrorRef.current?.(err.message));
  }, [loadConfig]);

  const updateDoor = (index, field, value) => {
    setConfig((prev) => {
      const doors = [...(prev.doors || [])];
      if (field.includes('.')) {
        const [parent, child] = field.split('.');
        doors[index] = { ...doors[index], [parent]: { ...doors[index][parent], [child]: value } };
      } else {
        doors[index] = { ...doors[index], [field]: value };
      }
      return { ...prev, doors };
    });
  };

  const updateAirlock = (index, field, value) => {
    setConfig((prev) => {
      const airlockGroups = [...(prev.airlockGroups || [])];
      airlockGroups[index] = { ...airlockGroups[index], [field]: value };
      return { ...prev, airlockGroups };
    });
  };

  const saveConfig = async () => {
    await onPending('saveDoorsConfig', async () => {
      const payload = {
        ...stripLocalIds(config),
        doors: (config.doors || []).map(({ _localId, ...door }) => ({
          ...door,
          airlockGroupId: door.airlockGroupId || null,
          airlockRole: door.airlockRole || null,
          readerIds: String(door.readerIdsText || door.readerIds?.join(', ') || 'default')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        })),
        airlockGroups: (config.airlockGroups || []).map(({ _localId, ...group }) => ({
          ...group,
          doorIds: (group.doorIds || []).filter(Boolean)
        })),
        globalAccess
      };
      const response = await fetch(`${API_BASE_URL}/admin/doors-config`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Error al guardar');
      setConfig((prev) => mergeLocalIds(prev, data.config));
      setGlobalAccess({ ...DEFAULT_GLOBAL, ...(data.globalAccess || {}) });
      setLegacyFallback(false);
      onGlobalAccessSaved?.(data.globalAccess);
      onSuccess?.('Configuración de puertas y acceso guardada');
    });
  };

  const testDoor = async (doorId) => {
    await onPending(`test-door-${doorId}`, async () => {
      const response = await fetch(`${API_BASE_URL}/access/test-relay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({ doorId })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Error al probar puerta');
      onSuccess?.(data.message || 'Pulso enviado');
    });
  };

  return (
    <div className="admin-sub-section">
      <h3 className="theme-section-title">Puertas y acceso SR201</h3>
      <p className="theme-section-desc">
        Configure aquí <strong>todas</strong> las puertas, dispositivos SR201, métodos de autenticación
        y estancos. Los valores por defecto del dispositivo se aplican a cada puerta que deje IP o puente vacíos.
      </p>

      {legacyFallback && (
        <div className="theme-callout-info">
          Se importó la configuración anterior de «Control SR201» como puerta principal.
          Revise los datos y pulse <strong>Guardar</strong> para consolidar todo en un solo lugar.
        </div>
      )}

      <div className="theme-panel">
        <h4 className="theme-section-title" style={{ fontSize: '1.05rem' }}>General</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          <label className="flex items-center gap-2 text-sm md:col-span-2 xl:col-span-3">
            <input
              type="checkbox"
              checked={Boolean(globalAccess.enabled)}
              onChange={(e) => setGlobalAccess((prev) => ({ ...prev, enabled: e.target.checked }))}
            />
            Habilitar apertura automática al autorizar acceso (molinete / kiosk)
          </label>
          <label className="flex items-center gap-2 text-sm md:col-span-2 xl:col-span-3">
            <input
              type="checkbox"
              checked={Boolean(globalAccess.allowManualOverride)}
              onChange={(e) => setGlobalAccess((prev) => ({ ...prev, allowManualOverride: e.target.checked }))}
            />
            Permitir override manual desde guardia
          </label>
          <div>
            <label className="theme-field-label">Segundos en pantalla molinete</label>
            <input
              type="number"
              min="2"
              max="15"
              className="input-field"
              value={globalAccess.kioskResetSeconds || 4}
              onChange={(e) => setGlobalAccess((prev) => ({ ...prev, kioskResetSeconds: Number(e.target.value) }))}
            />
          </div>
          <div className="md:col-span-2 xl:col-span-2">
            <label className="theme-field-label">Mensaje de acceso denegado</label>
            <input
              type="text"
              className="input-field"
              value={globalAccess.denyMessage || ''}
              onChange={(e) => setGlobalAccess((prev) => ({ ...prev, denyMessage: e.target.value }))}
            />
          </div>
          <div>
            <label className="theme-field-label">Puerta principal (por defecto)</label>
            <select
              className="input-field"
              value={config.defaultDoorId || ''}
              onChange={(e) => setConfig((prev) => ({ ...prev, defaultDoorId: e.target.value || null }))}
            >
              <option value="">Automática (primera activa)</option>
              {(config.doors || []).map((door) => (
                <option key={door._localId || door.id} value={door.id}>{door.name || door.id || 'Sin nombre'}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="theme-panel-muted">
        <h4 className="theme-section-title" style={{ fontSize: '1.05rem' }}>Dispositivo SR201 por defecto</h4>
        <p className="theme-section-desc" style={{ marginBottom: '0.75rem' }}>
          Valores heredados por las puertas que no tengan IP, puente o pulso propios. Ejecute el puente local
          <code className="mx-1">scripts/sr201-bridge.js</code> en la red de planta.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          <input
            className="input-field"
            placeholder="IP SR201"
            value={globalAccess.host || ''}
            onChange={(e) => setGlobalAccess((prev) => ({ ...prev, host: e.target.value }))}
          />
          <input
            className="input-field"
            type="number"
            placeholder="Puerto TCP"
            value={globalAccess.port || 6722}
            onChange={(e) => setGlobalAccess((prev) => ({ ...prev, port: Number(e.target.value) }))}
          />
          <select
            className="input-field"
            value={globalAccess.pulseMode || 'jog'}
            onChange={(e) => setGlobalAccess((prev) => ({ ...prev, pulseMode: e.target.value }))}
          >
            <option value="jog">Pulso jog (medio segundo)</option>
            <option value="timed">Pulso temporizado</option>
          </select>
          <input
            className="input-field"
            type="number"
            min="1"
            max="99"
            placeholder="Segundos de apertura"
            value={globalAccess.pulseSeconds || 3}
            onChange={(e) => setGlobalAccess((prev) => ({ ...prev, pulseSeconds: Number(e.target.value) }))}
          />
          <input
            className="input-field md:col-span-2"
            placeholder="URL puente local (ej. http://192.168.0.9:5022)"
            value={globalAccess.bridgeUrl || ''}
            onChange={(e) => setGlobalAccess((prev) => ({ ...prev, bridgeUrl: e.target.value }))}
          />
          <input
            className="input-field"
            type="password"
            placeholder="Secreto del puente (opcional)"
            value={globalAccess.bridgeSecret || ''}
            onChange={(e) => setGlobalAccess((prev) => ({ ...prev, bridgeSecret: e.target.value }))}
          />
        </div>
      </div>

      <h4 className="theme-section-title" style={{ fontSize: '1.05rem' }}>Puertas</h4>
      <div className="theme-stack">
        {(config.doors || []).map((door, index) => (
          <div key={door._localId} className="theme-panel-nested">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              <input className="input-field" placeholder="ID (slug)" value={door.id || ''} onChange={(e) => updateDoor(index, 'id', e.target.value)} />
              <input className="input-field" placeholder="Nombre visible" value={door.name || ''} onChange={(e) => updateDoor(index, 'name', e.target.value)} />
              <input className="input-field" type="number" min="1" max="8" placeholder="Canal SR201" value={door.device?.channel || 1} onChange={(e) => updateDoor(index, 'device.channel', Number(e.target.value))} />
              <input className="input-field" placeholder="IP SR201 (vacío = hereda)" value={door.device?.host || ''} onChange={(e) => updateDoor(index, 'device.host', e.target.value)} />
              <input className="input-field" placeholder="URL puente (vacío = hereda)" value={door.device?.bridgeUrl || ''} onChange={(e) => updateDoor(index, 'device.bridgeUrl', e.target.value)} />
              <input className="input-field" placeholder="Lectores (ids separados por coma)" value={door.readerIdsText || (door.readerIds || []).join(', ')} onChange={(e) => updateDoor(index, 'readerIdsText', e.target.value)} />
              <select className="input-field" value={door.pulseMode || 'inherit'} onChange={(e) => updateDoor(index, 'pulseMode', e.target.value)}>
                <option value="inherit">Pulso: heredar global</option>
                <option value="jog">Pulso jog</option>
                <option value="timed">Pulso temporizado</option>
              </select>
              <input className="input-field" type="number" min="1" max="99" placeholder="Segundos pulso" value={door.pulseSeconds || 3} onChange={(e) => updateDoor(index, 'pulseSeconds', Number(e.target.value))} />
              <select className="input-field" value={door.airlockGroupId || ''} onChange={(e) => updateDoor(index, 'airlockGroupId', e.target.value)}>
                <option value="">Sin estanco</option>
                {(config.airlockGroups || []).map((group) => (
                  <option key={group._localId || group.id} value={group.id}>{group.name || group.id}</option>
                ))}
              </select>
              <select className="input-field" value={door.airlockRole || ''} onChange={(e) => updateDoor(index, 'airlockRole', e.target.value)}>
                <option value="">Rol estanco</option>
                <option value="outer">Exterior</option>
                <option value="inner">Interior</option>
              </select>
            </div>
            <div className="flex flex-wrap gap-3 mt-3">
              {authMethods.map((method) => (
                <label key={method} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={(door.authMethods || []).includes(method)}
                    onChange={(e) => {
                      const current = new Set(door.authMethods || []);
                      if (e.target.checked) current.add(method);
                      else current.delete(method);
                      updateDoor(index, 'authMethods', [...current]);
                    }}
                  />
                  {AUTH_LABELS[method] || method}
                </label>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <PendingButton type="button" actionId={`test-door-${door._localId}`} pendingAction={pendingAction} className="btn btn-secondary-small" onClick={() => testDoor(door.id)}>
                Probar pulso
              </PendingButton>
              <button type="button" className="btn btn-danger-small" onClick={() => setConfig((prev) => ({ ...prev, doors: prev.doors.filter((_, i) => i !== index) }))}>
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
        <button type="button" className="btn btn-secondary" onClick={() => setConfig((prev) => ({ ...prev, doors: [...(prev.doors || []), emptyDoor()] }))}>
          <PlusCircle size={16} /> Agregar puerta
        </button>
      </div>

      <h4 className="theme-section-title" style={{ fontSize: '1.05rem' }}>Estancos (secuencia de puertas)</h4>
      <p className="theme-section-desc" style={{ marginBottom: '0.75rem' }}>
        Tras abrir la puerta exterior, el sistema espera el cierre estimado + retardo antes de habilitar la interior.
      </p>
      <div className="theme-stack">
        {(config.airlockGroups || []).map((group, index) => (
          <div key={group._localId} className="theme-callout-warn">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              <input className="input-field" placeholder="ID estanco" value={group.id || ''} onChange={(e) => updateAirlock(index, 'id', e.target.value)} />
              <input className="input-field" placeholder="Nombre" value={group.name || ''} onChange={(e) => updateAirlock(index, 'name', e.target.value)} />
              <input className="input-field" type="number" placeholder="Cierre exterior (ms)" value={group.outerCloseDelayMs || 5000} onChange={(e) => updateAirlock(index, 'outerCloseDelayMs', Number(e.target.value))} />
              <input className="input-field" type="number" placeholder="Retardo entre puertas (ms)" value={group.interDoorDelayMs || 2000} onChange={(e) => updateAirlock(index, 'interDoorDelayMs', Number(e.target.value))} />
              <input className="input-field" type="number" placeholder="Timeout tránsito (ms)" value={group.transitTimeoutMs || 120000} onChange={(e) => updateAirlock(index, 'transitTimeoutMs', Number(e.target.value))} />
              <select className="input-field" value={group.doorIds?.[0] || ''} onChange={(e) => {
                const doorIds = [...(group.doorIds || ['', ''])];
                doorIds[0] = e.target.value;
                updateAirlock(index, 'doorIds', doorIds);
              }}>
                <option value="">Puerta exterior</option>
                {(config.doors || []).map((door) => <option key={door._localId || door.id} value={door.id}>{door.name || door.id || 'Sin nombre'}</option>)}
              </select>
              <select className="input-field" value={group.doorIds?.[1] || ''} onChange={(e) => {
                const doorIds = [...(group.doorIds || ['', ''])];
                doorIds[1] = e.target.value;
                updateAirlock(index, 'doorIds', doorIds);
              }}>
                <option value="">Puerta interior</option>
                {(config.doors || []).map((door) => <option key={`inner-${door._localId || door.id}`} value={door.id}>{door.name || door.id || 'Sin nombre'}</option>)}
              </select>
            </div>
            <button type="button" className="btn btn-danger-small mt-3" onClick={() => setConfig((prev) => ({ ...prev, airlockGroups: prev.airlockGroups.filter((_, i) => i !== index) }))}>
              <Trash2 size={14} /> Eliminar estanco
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-secondary" onClick={() => setConfig((prev) => ({ ...prev, airlockGroups: [...(prev.airlockGroups || []), emptyAirlock()] }))}>
          <PlusCircle size={16} /> Agregar estanco
        </button>
      </div>

      <PendingButton type="button" actionId="saveDoorsConfig" pendingAction={pendingAction} className="btn btn-primary" onClick={saveConfig}>
        <Save size={18} /> Guardar puertas y acceso
      </PendingButton>
    </div>
  );
}

export default DoorsAdminPanel;
