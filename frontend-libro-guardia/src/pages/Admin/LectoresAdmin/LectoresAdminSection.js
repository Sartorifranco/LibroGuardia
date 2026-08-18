import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Download,
  Hash,
  KeyRound,
  Pencil,
  PlusCircle,
  RefreshCw,
  ScanLine,
  Trash2,
  Unlock,
  X
} from 'lucide-react';
import { checkOfflineWithDoorRelay } from '../../../utils/accessHardwareCoherence';
import PendingButton from '../../../components/PendingButton';
import {
  AdminBlock,
  AdminEmpty,
  AdminFormCard,
  AdminLoading,
  AdminTable
} from '../../../components/admin/AdminUi';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { apiFetch } from '../../../services/api';

/** Umbrales alineados con heartbeat 5 min del bridge (lib/lectores.js). */
export const CONNECTION_STATUS_META = {
  online: {
    label: 'En línea',
    className: 'lector-status lector-status--online',
    hint: 'Heartbeat en los últimos 10 minutos'
  },
  stale: {
    label: 'Sin señal reciente',
    className: 'lector-status lector-status--stale',
    hint: 'Último heartbeat entre 10 y 30 minutos'
  },
  offline: {
    label: 'Desconectado',
    className: 'lector-status lector-status--offline',
    hint: 'Nunca conectó o hace más de 30 minutos'
  }
};

const DIRECTION_LABELS = {
  ingreso: 'Ingreso',
  egreso: 'Egreso',
  ambos: 'Ambos'
};

const emptyCreateForm = () => ({
  nombre: '',
  doorId: '',
  readerId: '',
  direction: 'ingreso',
  estacionId: '',
  brandId: '',
  plugin: '',
  deviceHost: '',
  devicePort: '',
  detectUsername: 'admin',
  detectPassword: '',
  detectMeta: null,
  offlineCache: true,
  localFirstMode: false,
  offlineCacheRefreshMinutes: 15,
  offlineCacheMaxAgeHours: 24
});

const BRAND_OPTIONS = [
  { id: '', label: 'Sin marca / elegir luego' },
  { id: 'zkteco', label: 'ZKTeco', plugin: 'zkteco' },
  { id: 'hikvision', label: 'Hikvision', plugin: 'hikvision' },
  { id: 'suprema', label: 'Suprema (BioStar)', plugin: 'suprema' },
  { id: 'hid', label: 'HID', plugin: 'hid' },
  { id: 'dni_generic', label: 'Lector de DNI', plugin: 'serial_dni' }
];

/** Panel de auto-detección por IP (estación LAN). */
function DetectBrandPanel({
  form,
  onChange,
  estaciones = [],
  authToken,
  disabled
}) {
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [candidates, setCandidates] = useState([]);

  const runDetect = async () => {
    if (!form.estacionId) {
      setStatusMsg('Elegí una estación (tiene que estar en línea en planta).');
      return;
    }
    if (!String(form.deviceHost || '').trim()) {
      setStatusMsg('Ingresá la IP del equipo.');
      return;
    }
    setBusy(true);
    setStatusMsg('Enviando pedido a la estación…');
    setCandidates([]);
    try {
      const created = await apiFetch('/admin/hardware/detect', {
        method: 'POST',
        token: authToken,
        body: {
          estacionId: form.estacionId,
          host: String(form.deviceHost || '').trim(),
          port: form.devicePort ? Number(form.devicePort) : null,
          username: form.detectUsername || 'admin',
          password: form.detectPassword || ''
        }
      });
      const jobId = created.jobId;
      setStatusMsg('Esperando resultado de la estación…');
      const deadline = Date.now() + 22000;
      let job = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const poll = await apiFetch(`/admin/hardware/detect/${encodeURIComponent(jobId)}`, {
          token: authToken
        });
        job = poll.job;
        if (job && !['pending', 'running'].includes(job.status)) break;
      }
      if (!job || ['pending', 'running', 'expired'].includes(job.status)) {
        setStatusMsg('No hubo respuesta a tiempo (estación offline o IP inalcanzable). Elegí la marca a mano.');
        setBusy(false);
        return;
      }
      const list = Array.isArray(job.candidates) ? job.candidates : [];
      setCandidates(list);
      if (!list.length) {
        setStatusMsg(
          job.error === 'auth_failed_hint'
            ? 'No detectamos marca (¿usuario/contraseña incorrectos?). Elegí manualmente.'
            : 'No detectamos marca conocida. Elegí manualmente.'
        );
      } else {
        setStatusMsg('Revisá el resultado y confirmá.');
      }
    } catch (err) {
      setStatusMsg(err.message || 'Error al detectar');
    } finally {
      setBusy(false);
    }
  };

  const confirmCandidate = (c) => {
    onChange({
      brandId: c.brandId || '',
      plugin: c.stationPlugin || c.brandId || '',
      detectMeta: {
        model: c.model || null,
        firmware: c.firmware || null,
        via: c.via || null,
        confidence: c.confidence || null,
        detectedAt: new Date().toISOString(),
        bestEffort: Boolean(c.bestEffort)
      }
    });
    setStatusMsg(`Marca confirmada: ${c.brandId}${c.model ? ` (${c.model})` : ''}. Guardá el lector para aplicar.`);
    setCandidates([]);
  };

  return (
    <div className="admin-block" style={{ marginTop: '0.75rem', padding: '0.75rem', border: '1px solid var(--border, #d5dde8)', borderRadius: 8 }}>
      <p className="historial-meta" style={{ marginBottom: '0.5rem' }}>
        Auto-detectar marca por IP (la estación en LAN hace el probe; no se expone el equipo a internet).
      </p>
      <div className="admin-form-grid">
        <label>
          <span className="historial-meta">Estación (obligatoria para detectar)</span>
          <select
            className="input-field"
            value={form.estacionId || ''}
            onChange={(e) => onChange({ estacionId: e.target.value })}
            disabled={disabled || busy}
          >
            <option value="">— Elegir estación —</option>
            {estaciones.map((e) => (
              <option key={e.id} value={e.id}>{e.nombre || e.id}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="historial-meta">IP del equipo</span>
          <input
            className="input-field"
            value={form.deviceHost || ''}
            onChange={(e) => onChange({ deviceHost: e.target.value })}
            placeholder="192.168.0.55"
            disabled={disabled || busy}
          />
        </label>
        <label>
          <span className="historial-meta">Puerto (opcional)</span>
          <input
            className="input-field"
            value={form.devicePort || ''}
            onChange={(e) => onChange({ devicePort: e.target.value })}
            placeholder="auto"
            disabled={disabled || busy}
          />
        </label>
        <label>
          <span className="historial-meta">Usuario equipo</span>
          <input
            className="input-field"
            value={form.detectUsername || ''}
            onChange={(e) => onChange({ detectUsername: e.target.value })}
            disabled={disabled || busy}
            autoComplete="off"
          />
        </label>
        <label>
          <span className="historial-meta">Contraseña equipo</span>
          <input
            className="input-field"
            type="password"
            value={form.detectPassword || ''}
            onChange={(e) => onChange({ detectPassword: e.target.value })}
            disabled={disabled || busy}
            autoComplete="new-password"
          />
        </label>
      </div>
      <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn-secondary" onClick={runDetect} disabled={disabled || busy}>
          {busy ? 'Detectando…' : 'Detectar marca'}
        </button>
        <label style={{ minWidth: 180 }}>
          <span className="historial-meta">Marca / plugin</span>
          <select
            className="input-field"
            value={form.brandId || ''}
            onChange={(e) => {
              const opt = BRAND_OPTIONS.find((b) => b.id === e.target.value);
              onChange({
                brandId: e.target.value,
                plugin: opt?.plugin || '',
                detectMeta: null
              });
            }}
            disabled={disabled || busy}
          >
            {BRAND_OPTIONS.map((b) => (
              <option key={b.id || 'none'} value={b.id}>{b.label}</option>
            ))}
          </select>
        </label>
      </div>
      {statusMsg ? <p className="historial-meta" style={{ marginTop: '0.5rem' }}>{statusMsg}</p> : null}
      {candidates.map((c) => (
        <div key={`${c.brandId}-${c.via}`} style={{ marginTop: '0.5rem' }}>
          <p>
            Detectamos: <strong>{c.brandId}</strong>
            {c.model ? ` · ${c.model}` : ''}
            {c.bestEffort || c.confidence === 'low' ? ' (best-effort / poco confiable)' : ''}
            {c.via === 'biostar2_server' ? ' — servidor BioStar 2' : ''}
            {' — ¿confirmás?'}
          </p>
          <button type="button" className="btn-primary" onClick={() => confirmCandidate(c)}>
            Confirmar {c.brandId}
          </button>
        </div>
      ))}
    </div>
  );
}



const offlineFieldsFromRow = (row = {}) => ({
  offlineCache: Boolean(row.offlineCache),
  localFirstMode: Boolean(row.localFirstMode) && Boolean(row.offlineCache),
  offlineCacheRefreshMinutes: Math.max(
    1,
    Math.round((Number(row.offlineCacheRefreshMs) || 900000) / 60000)
  ),
  offlineCacheMaxAgeHours: Math.max(1, Number(row.offlineCacheMaxAgeHours) || 24)
});

const bodyFromOfflineForm = (form) => {
  const offlineCache = Boolean(form.offlineCache);
  return {
    offlineCache,
    localFirstMode: offlineCache && Boolean(form.localFirstMode),
    offlineCacheRefreshMs: Math.max(1, Number(form.offlineCacheRefreshMinutes) || 15) * 60_000,
    offlineCacheMaxAgeHours: Math.max(1, Number(form.offlineCacheMaxAgeHours) || 24)
  };
};

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatUltimaConexion(value) {
  if (!value) return 'Nunca';
  let ms = null;
  if (typeof value?.toMillis === 'function') ms = value.toMillis();
  else if (value?._seconds != null) ms = value._seconds * 1000;
  else if (value?.seconds != null) ms = value.seconds * 1000;
  else ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  try {
    return new Date(ms).toLocaleString('es-AR');
  } catch {
    return '—';
  }
}

/**
 * Estado legible de la lista de autorizados en la mini PC (reportado por heartbeat).
 */
function describeAllowlistStatus(row, nowMs = Date.now()) {
  if (!row?.offlineCache) {
    return {
      short: 'Offline apagado',
      detail: 'Sin caché local: si se corta internet, esta estación no podrá autorizar por sí sola.',
      tone: 'off'
    };
  }
  const generatedAt = row.allowlistGeneratedAt;
  if (!generatedAt) {
    return {
      short: 'Sin lista aún',
      detail: 'Modo offline activo en Admin, pero la mini PC todavía no reportó una lista. Pedí “Sincronizar ahora”: la PC lo toma en unos segundos y actualiza la fecha acá. Si acabás de tildar offline, reiniciá la estación (02-reiniciar-estacion.cmd como Administrador). La lista es por puerta (quién puede pasar ahora), no una copia 1:1 de “Quién puede pasar”.',
      tone: 'warn'
    };
  }
  let ms = null;
  if (typeof generatedAt?.toMillis === 'function') ms = generatedAt.toMillis();
  else if (generatedAt?._seconds != null) ms = generatedAt._seconds * 1000;
  else if (generatedAt?.seconds != null) ms = generatedAt.seconds * 1000;
  else ms = Date.parse(generatedAt);
  if (!Number.isFinite(ms)) {
    return {
      short: 'Lista desconocida',
      detail: 'La estación reportó un valor de lista inválido.',
      tone: 'warn'
    };
  }
  const maxHours = Math.max(1, Number(row.offlineCacheMaxAgeHours) || 24);
  const ageMs = Math.max(0, nowMs - ms);
  const ageHours = ageMs / (60 * 60 * 1000);
  const when = formatUltimaConexion(generatedAt);
  const count = Number.isFinite(Number(row.allowlistEntryCount))
    ? Number(row.allowlistEntryCount)
    : null;
  const countTxt = count != null ? ` · ${count} autorizados` : '';
  if (ageHours > maxHours) {
    return {
      short: `Vencida · ${when}`,
      detail: `Última lista: ${when}${countTxt}. Tiene más de ${maxHours} h — en un corte de internet la estación denegará hasta poder refrescar.`,
      tone: 'stale'
    };
  }
  return {
    short: when + countTxt,
    detail: `Última lista de autorizados en la mini PC: ${when}${countTxt}. Vigente hasta ~${maxHours} h desde esa fecha (si hay corte de internet).`,
    tone: 'ok'
  };
}

function readersForDoorId(doors, doorId) {
  const door = doors.find((d) => d.id === doorId);
  return Array.isArray(door?.readers) ? door.readers : [];
}

function CredentialsOnceModal({ title, password, config, onClose }) {
  if (!password && !config) return null;
  return (
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true">
      <div className="admin-modal">
        <div className="admin-modal__head">
          <h4>{title}</h4>
          <button type="button" className="admin-icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>
        <p className="theme-section-desc">
          Esta contraseña se muestra <strong>una sola vez</strong>. Preferí el flujo de código de instalación
          en la mini PC (<code>01-instalar-estacion.cmd</code>). Si necesitás el JSON a mano, descargalo abajo.
        </p>
        <label className="historial-meta">Contraseña generada</label>
        <input className="input-field" readOnly value={password || ''} onFocus={(e) => e.target.select()} />
        <div className="flex flex-wrap gap-2" style={{ marginTop: '1rem' }}>
          <PendingButton
            type="button"
            className="btn btn-primary"
            actionId="downloadOnceConfig"
            pendingAction={null}
            onClick={() => {
              downloadJson(`door-reader-${config?.doorId || 'lector'}.config.json`, config);
            }}
          >
            <Download size={16} /> Descargar JSON completo
          </PendingButton>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Listo
          </button>
        </div>
      </div>
    </div>
  );
}

/** Modal con código de 6 dígitos para emparejar la mini PC. */
function PairingCodeModal({ pairing, onClose }) {
  if (!pairing?.code) return null;
  const digits = String(pairing.code);
  return (
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="pairing-code-title">
      <div className="admin-modal">
        <div className="admin-modal__head">
          <h4 id="pairing-code-title">Código de instalación</h4>
          <button type="button" className="admin-icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>
        <p className="theme-section-desc">
          En la mini PC / Raspberry corré
          {' '}
          <code>scripts\\01-instalar-estacion.cmd</code>
          {' '}
          y pegá este código.
          {' '}
          <strong>Expira en 10 minutos</strong>
          {' '}
          y es de un solo uso.
        </p>
        {pairing.lectorNombre ? (
          <p className="historial-meta" style={{ marginBottom: '0.75rem' }}>
            {pairing.lectorNombre}
            {pairing.doorId ? ` · ${pairing.doorId}` : ''}
            {pairing.readerId ? ` / ${pairing.readerId}` : ''}
          </p>
        ) : null}
        <div className="lector-pairing-code" aria-label={`Código ${digits}`}>
          {digits.split('').map((d, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <span key={`${d}-${i}`} className="lector-pairing-code__digit">{d}</span>
          ))}
        </div>
        <p className="theme-section-desc" style={{ marginTop: '1rem' }}>
          Válido hasta
          {' '}
          {pairing.expiresAt
            ? new Date(pairing.expiresAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
            : '10 minutos'}
          .
        </p>
        <div className="flex flex-wrap gap-2" style={{ marginTop: '1rem' }}>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Listo
          </button>
        </div>
      </div>
    </div>
  );
}

/** Modal de edición (position: fixed, centrado — mismo patrón que CredentialsOnceModal). */
function EditLectorModal({
  draft,
  doors,
  estaciones = [],
  pendingAction,
  authToken,
  onChange,
  onDoorChange,
  onReaderChange,
  onSave,
  onForceResync,
  onIncoherence,
  onClose
}) {
  if (!draft) return null;
  const readers = readersForDoorId(doors, draft.doorId);
  const offlineOn = Boolean(draft.offlineCache);
  const allowlistStatus = describeAllowlistStatus(draft);
  const selectedDoor = doors.find((d) => d.id === draft.doorId);

  const trySetOffline = (nextOffline) => {
    const issue = checkOfflineWithDoorRelay({
      offlineCache: nextOffline,
      doorRelayMode: selectedDoor?.relayMode,
      doorName: selectedDoor?.name || selectedDoor?.id || draft.doorId,
      context: 'lector'
    });
    if (issue) {
      onIncoherence?.(issue);
      return;
    }
    onChange({
      offlineCache: nextOffline,
      localFirstMode: nextOffline ? draft.localFirstMode : false
    });
  };

  return (
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="edit-lector-title">
      <div className="admin-modal admin-modal--wide">
        <div className="admin-modal__head">
          <h4 id="edit-lector-title">Editar lector</h4>
          <button type="button" className="admin-icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>
        <p className="historial-meta" style={{ marginBottom: '0.75rem' }}>
          Si cambiás puerta, readerId o modos offline/instantáneo, descargá de nuevo la
          {' '}<code>configuracion-estacion.json</code> y copiala a la mini PC (o regenerá credenciales / usá el código de instalación).
        </p>
        <DetectBrandPanel
          form={draft}
          onChange={onChange}
          estaciones={estaciones}
          authToken={authToken}
          disabled={Boolean(pendingAction)}
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
        >
          <div className="admin-form-grid">
            <label>
              <span className="historial-meta">Nombre</span>
              <input
                className="input-field"
                value={draft.nombre}
                onChange={(e) => onChange({ nombre: e.target.value })}
                placeholder="Ej. Ingreso Puerta 1"
                required
                autoFocus
              />
            </label>
            <label>
              <span className="historial-meta">Puerta</span>
              <select
                className="input-field"
                value={draft.doorId}
                onChange={(e) => onDoorChange(e.target.value)}
                required
              >
                <option value="">Elegir puerta…</option>
                {doors.map((d) => (
                  <option key={d.id} value={d.id}>{d.name || d.id}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="historial-meta">Reader ID</span>
              <select
                className="input-field"
                value={draft.readerId}
                onChange={(e) => onReaderChange(e.target.value)}
                required
                disabled={!draft.doorId}
              >
                <option value="">Elegir lector de la puerta…</option>
                {readers.map((r) => (
                  <option key={r.id} value={r.id}>{r.id} ({r.direction || 'ambos'})</option>
                ))}
              </select>
            </label>
            <label>
              <span className="historial-meta">Sentido</span>
              <select
                className="input-field"
                value={draft.direction}
                onChange={(e) => onChange({ direction: e.target.value })}
              >
                <option value="ingreso">Ingreso</option>
                <option value="egreso">Egreso</option>
                <option value="ambos">Ambos</option>
              </select>
            </label>
          </div>

          <div className="lector-offline-opts" style={{ marginTop: '1rem' }}>
            <p className="historial-meta" style={{ marginBottom: '0.35rem' }}>
              Respaldo ante cortes de internet
            </p>
            <p className="theme-section-desc" style={{ marginBottom: '0.65rem' }}>
              Configuración correcta: puerta en <strong>En planta</strong> + este
              <strong> Modo offline</strong> tildado. Así funciona con internet y, si se corta,
              la mini PC autoriza y abre por la red local. No combina con puerta “A distancia”.
            </p>
            <label className="lector-check">
              <input
                type="checkbox"
                checked={offlineOn}
                onChange={(e) => trySetOffline(e.target.checked)}
              />
              <span>Modo offline (caché local) — recomendado para cortes de red</span>
            </label>
            <label className={`lector-check${offlineOn ? '' : ' lector-check--dim'}`}>
              <input
                type="checkbox"
                checked={Boolean(draft.localFirstMode) && offlineOn}
                disabled={!offlineOn}
                onChange={(e) => onChange({ localFirstMode: e.target.checked })}
              />
              <span>Modo instantáneo (decide siempre con caché local, más rápido)</span>
            </label>
            <div
              className={`lector-allowlist-status lector-allowlist-status--${allowlistStatus.tone}`}
              role="status"
              title={allowlistStatus.detail}
            >
              <strong>Lista de autorizados en la mini PC:</strong>{' '}
              {allowlistStatus.short}
              <div className="theme-section-desc" style={{ marginTop: '0.25rem' }}>
                {allowlistStatus.detail}
              </div>
              {offlineOn && draft.id ? (
                <div style={{ marginTop: '0.65rem' }}>
                  <PendingButton
                    type="button"
                    className="btn btn-secondary"
                    actionId={`resync-${draft.id}`}
                    pendingAction={pendingAction}
                    onClick={() => onForceResync?.(draft)}
                  >
                    <RefreshCw size={16} /> Sincronizar ahora
                  </PendingButton>
                </div>
              ) : null}
            </div>
            <div className="admin-form-grid" style={{ marginTop: '0.5rem' }}>
              <label>
                <span className="historial-meta">Refresco de lista (min)</span>
                <input
                  className="input-field"
                  type="number"
                  min={1}
                  max={1440}
                  disabled={!offlineOn}
                  value={draft.offlineCacheRefreshMinutes}
                  onChange={(e) => onChange({ offlineCacheRefreshMinutes: e.target.value })}
                />
              </label>
              <label>
                <span className="historial-meta">Antigüedad máx. caché (horas)</span>
                <input
                  className="input-field"
                  type="number"
                  min={1}
                  max={168}
                  disabled={!offlineOn}
                  value={draft.offlineCacheMaxAgeHours}
                  onChange={(e) => onChange({ offlineCacheMaxAgeHours: e.target.value })}
                />
              </label>
            </div>
          </div>

          <div className="flex flex-wrap gap-2" style={{ marginTop: '1rem' }}>
            <PendingButton
              type="submit"
              className="btn btn-primary"
              actionId="updateLector"
              pendingAction={pendingAction}
            >
              <Pencil size={16} /> Guardar cambios
            </PendingButton>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancelar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function LectoresAdminSection({ pendingAction, runAction }) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const { confirm, alert } = useConfirm();

  const run = async (actionId, fn) => {
    if (typeof runAction === 'function') {
      await runAction(actionId, fn);
      return;
    }
    await fn();
  };

  const [lectores, setLectores] = useState([]);
  const [estaciones, setEstaciones] = useState([]);
  const [doors, setDoors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [createForm, setCreateForm] = useState(emptyCreateForm);
  const [editDraft, setEditDraft] = useState(null);
  const [onceModal, setOnceModal] = useState(null);
  const [pairingModal, setPairingModal] = useState(null);

  const canManage = hasPermission(currentUser, 'lectores.manage');

  const createReaders = useMemo(
    () => readersForDoorId(doors, createForm.doorId),
    [doors, createForm.doorId]
  );

  const load = useCallback(async () => {
    if (!canManage) return;
    setLoading(true);
    try {
      const [lectoresData, doorsData, estData] = await Promise.all([
        apiFetch('/admin/lectores', { token: authToken, allowForbidden: true }),
        apiFetch('/admin/doors-config', { token: authToken, allowForbidden: true }),
        apiFetch('/admin/estaciones', { token: authToken, allowForbidden: true }).catch(() => ({ estaciones: [] }))
      ]);
      setLectores(lectoresData.lectores || []);
      setDoors(doorsData?.config?.doors || []);
      setEstaciones(Array.isArray(estData?.estaciones) ? estData.estaciones : []);
    } catch (err) {
      showError(err.message || 'No se pudieron cargar los lectores');
    } finally {
      setLoading(false);
    }
  }, [authToken, canManage, showError]);

  useEffect(() => {
    load();
  }, [load]);

  const applyDoorToForm = (prev, nextDoorId) => {
    const door = doors.find((d) => d.id === nextDoorId);
    const first = door?.readers?.[0];
    const dir = first?.direction;
    return {
      ...prev,
      doorId: nextDoorId,
      readerId: first?.id || '',
      direction: (dir === 'ingreso' || dir === 'egreso' || dir === 'ambos') ? dir : prev.direction
    };
  };

  const applyReaderToForm = (prev, nextReaderId, doorId) => {
    const reader = readersForDoorId(doors, doorId).find((r) => r.id === nextReaderId);
    const dir = reader?.direction;
    return {
      ...prev,
      readerId: nextReaderId,
      direction: (dir === 'ingreso' || dir === 'egreso' || dir === 'ambos') ? dir : prev.direction
    };
  };

  const startEdit = (row) => {
    setEditDraft({
      id: row.id,
      nombre: row.nombre || '',
      doorId: row.doorId || '',
      readerId: row.readerId || '',
      direction: row.direction || 'ingreso',
      estacionId: row.estacionId || '',
      brandId: row.brandId || '',
      plugin: row.plugin || '',
      deviceHost: row.deviceHost || '',
      devicePort: row.devicePort == null ? '' : String(row.devicePort),
      detectUsername: 'admin',
      detectPassword: '',
      detectMeta: row.detectMeta || null,
      allowlistGeneratedAt: row.allowlistGeneratedAt || null,
      allowlistEntryCount: row.allowlistEntryCount ?? null,
      allowlistReportedAt: row.allowlistReportedAt || null,
      ...offlineFieldsFromRow(row)
    });
  };

  const closeEdit = () => setEditDraft(null);

  const handleCreateSubmit = async (e) => {
    e.preventDefault();
    if (!canManage) return;
    const door = doors.find((d) => d.id === createForm.doorId);
    const issue = checkOfflineWithDoorRelay({
      offlineCache: createForm.offlineCache,
      doorRelayMode: door?.relayMode,
      doorName: door?.name || door?.id || createForm.doorId,
      context: 'lector'
    });
    if (issue) {
      await alert(issue);
      return;
    }
    const { nombre, doorId, readerId, direction } = createForm;
    await run('createLector', async () => {
      try {
        const data = await apiFetch('/admin/lectores', {
          method: 'POST',
          token: authToken,
          body: {
            nombre,
            doorId,
            readerId,
            direction,
            estacionId: String(createForm.estacionId || '').trim() || undefined,
            brandId: createForm.brandId || undefined,
            plugin: createForm.plugin || undefined,
            deviceHost: String(createForm.deviceHost || '').trim() || undefined,
            devicePort: createForm.devicePort ? Number(createForm.devicePort) : undefined,
            detectMeta: createForm.detectMeta || undefined,
            ...bodyFromOfflineForm(createForm)
          }
        });
        setLectores((prev) => [...prev, data.lector].sort((a, b) =>
          String(a.nombre).localeCompare(String(b.nombre))));
        setOnceModal({
          title: 'Lector creado — guardá la contraseña',
          password: data.password,
          config: data.config
        });
        showSuccess('Lector creado');
        setCreateForm(emptyCreateForm());
      } catch (err) {
        showError(err.message || 'Error al guardar lector');
      }
    });
  };

  const handleEditSave = async () => {
    if (!canManage || !editDraft?.id) return;
    const door = doors.find((d) => d.id === editDraft.doorId);
    const issue = checkOfflineWithDoorRelay({
      offlineCache: editDraft.offlineCache,
      doorRelayMode: door?.relayMode,
      doorName: door?.name || door?.id || editDraft.doorId,
      context: 'lector'
    });
    if (issue) {
      await alert(issue);
      return;
    }
    const { id, nombre, doorId, readerId, direction } = editDraft;
    await run('updateLector', async () => {
      try {
        const data = await apiFetch(`/admin/lectores/${id}`, {
          method: 'PUT',
          token: authToken,
          body: {
            nombre,
            doorId,
            readerId,
            direction,
            estacionId: String(editDraft.estacionId || '').trim(),
            brandId: editDraft.brandId || '',
            plugin: editDraft.plugin || '',
            deviceHost: String(editDraft.deviceHost || '').trim(),
            devicePort: editDraft.devicePort ? Number(editDraft.devicePort) : null,
            detectMeta: editDraft.detectMeta || null,
            ...bodyFromOfflineForm(editDraft)
          }
        });
        setLectores((prev) => prev.map((x) => (x.id === id ? data.lector : x)));
        showSuccess(data.message || 'Lector actualizado. Descargá el JSON si cambiaste modos offline.');
        closeEdit();
      } catch (err) {
        if (err?.data?.code === 'offline_requires_local_relay'
          || /En planta|A distancia|Modo offline/i.test(err.message || '')) {
          await alert({
            title: 'Configuración incompatible',
            message: err.message
          });
          return;
        }
        showError(err.message || 'Error al actualizar lector');
      }
    });
  };

  const handleDelete = async (row) => {
    const ok = await confirm({
      title: 'Eliminar lector',
      message: `¿Eliminar “${row.nombre}”? También se borra el usuario de sistema ${row.usuarioSistemaId}. La mini PC dejará de autenticarse.`,
      confirmLabel: 'Eliminar',
      tone: 'danger'
    });
    if (!ok) return;
    await run(`deleteLector-${row.id}`, async () => {
      try {
        await apiFetch(`/admin/lectores/${row.id}`, { method: 'DELETE', token: authToken });
        setLectores((prev) => prev.filter((x) => x.id !== row.id));
        if (editDraft?.id === row.id) closeEdit();
        showSuccess('Lector eliminado');
      } catch (err) {
        showError(err.message || 'Error al eliminar');
      }
    });
  };

  const handleRegenerate = async (row) => {
    const ok = await confirm({
      title: 'Regenerar credenciales',
      message: `Se invalida la contraseña actual de ${row.usuarioSistemaId}. Tendrás que actualizar el JSON en la mini PC.`,
      confirmLabel: 'Regenerar',
      tone: 'danger'
    });
    if (!ok) return;
    await run(`regen-${row.id}`, async () => {
      try {
        const data = await apiFetch(`/admin/lectores/${row.id}/regenerate-credentials`, {
          method: 'POST',
          token: authToken
        });
        setOnceModal({
          title: 'Credenciales regeneradas',
          password: data.password,
          config: data.config
        });
        showSuccess('Credenciales regeneradas');
      } catch (err) {
        showError(err.message || 'Error al regenerar');
      }
    });
  };

  const handleDownloadConfig = async (row) => {
    await run(`config-${row.id}`, async () => {
      try {
        const data = await apiFetch(`/admin/lectores/${row.id}/config`, { token: authToken });
        downloadJson(`door-reader-${row.doorId || row.id}.config.json`, data.config);
        showSuccess('JSON descargado (sin contraseña). Si la perdiste, regenerá credenciales.');
      } catch (err) {
        showError(err.message || 'Error al descargar config');
      }
    });
  };

  const handleGeneratePairingCode = async (row) => {
    await run(`pairing-${row.id}`, async () => {
      try {
        const data = await apiFetch(`/admin/lectores/${row.id}/pairing-code`, {
          method: 'POST',
          token: authToken
        });
        setPairingModal({
          code: data.code,
          expiresAt: data.expiresAt,
          lectorNombre: data.lectorNombre || row.nombre,
          doorId: data.doorId || row.doorId,
          readerId: data.readerId || row.readerId
        });
        showSuccess('Código de instalación generado (válido 10 minutos)');
      } catch (err) {
        showError(err.message || 'Error al generar código');
      }
    });
  };

  const handleClearLoginFailures = async (row) => {
    const username = row.usuarioSistemaId || 'este lector';
    const ok = await confirm({
      title: 'Destrabar intentos de login',
      message: `¿Limpiar el bloqueo por intentos fallidos de “${username}”? Podrá volver a autenticarse de inmediato.`,
      confirmLabel: 'Destrabar',
      tone: 'default'
    });
    if (!ok) return;
    await run(`unlock-${row.id}`, async () => {
      try {
        const data = await apiFetch(`/admin/lectores/${row.id}/clear-login-failures`, {
          method: 'POST',
          token: authToken
        });
        showSuccess(data.message || `Login destrabado para ${username}`);
      } catch (err) {
        showError(err.message || 'Error al destrabar login');
      }
    });
  };

  const handleForceResync = async (row) => {
    if (!row?.id) return;
    await run(`resync-${row.id}`, async () => {
      try {
        await apiFetch(`/admin/lectores/${row.id}/force-resync`, {
          method: 'POST',
          token: authToken
        });
        setLectores((prev) => prev.map((x) => (
          x.id === row.id ? { ...x, forceResync: true } : x
        )));
        setEditDraft((prev) => (prev && prev.id === row.id
          ? { ...prev, forceResync: true }
          : prev));
        showSuccess('Pedido enviado. La mini PC actualiza la lista en unos segundos.');
      } catch (err) {
        showError(err.message || 'Error al pedir sincronización');
      }
    });
  };

  if (!canManage) {
    return <p className="theme-section-desc">Sin permiso lectores.manage.</p>;
  }

  const doorName = (id) => doors.find((d) => d.id === id)?.name || id || '—';

  return (
    <div className="lectores-admin">
      <CredentialsOnceModal
        title={onceModal?.title}
        password={onceModal?.password}
        config={onceModal?.config}
        onClose={() => setOnceModal(null)}
      />

      <PairingCodeModal
        pairing={pairingModal}
        onClose={() => setPairingModal(null)}
      />

      <EditLectorModal
        draft={editDraft}
        doors={doors}
        estaciones={estaciones}
        pendingAction={pendingAction}
        authToken={authToken}
        onChange={(patch) => setEditDraft((prev) => (prev ? { ...prev, ...patch } : prev))}
        onDoorChange={(nextDoorId) => setEditDraft((prev) => (prev ? applyDoorToForm(prev, nextDoorId) : prev))}
        onReaderChange={(nextReaderId) => setEditDraft((prev) => (
          prev ? applyReaderToForm(prev, nextReaderId, prev.doorId) : prev
        ))}
        onSave={handleEditSave}
        onForceResync={handleForceResync}
        onIncoherence={(issue) => { alert(issue); }}
        onClose={closeEdit}
      />

      <AdminBlock
        title="Nuevo lector"
        description="Al crear se genera la cuenta de estación de acceso. Después usá “Generar código de instalación” en la fila y corré 01-instalar-estacion.cmd en la mini PC."
      >
        <AdminFormCard onSubmit={handleCreateSubmit}>
          <DetectBrandPanel
            form={createForm}
            onChange={(patch) => setCreateForm((prev) => ({ ...prev, ...patch }))}
            estaciones={estaciones}
            authToken={authToken}
            disabled={Boolean(pendingAction)}
          />
          <div className="admin-form-grid">
            <label>
              <span className="historial-meta">Nombre</span>
              <input
                className="input-field"
                value={createForm.nombre}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, nombre: e.target.value }))}
                placeholder="Ej. Ingreso Puerta 1"
                required
              />
            </label>
            <label>
              <span className="historial-meta">Puerta</span>
              <select
                className="input-field"
                value={createForm.doorId}
                onChange={(e) => setCreateForm((prev) => applyDoorToForm(prev, e.target.value))}
                required
              >
                <option value="">Elegir puerta…</option>
                {doors.map((d) => (
                  <option key={d.id} value={d.id}>{d.name || d.id}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="historial-meta">Reader ID</span>
              <select
                className="input-field"
                value={createForm.readerId}
                onChange={(e) => setCreateForm((prev) => applyReaderToForm(prev, e.target.value, prev.doorId))}
                required
                disabled={!createForm.doorId}
              >
                <option value="">Elegir lector de la puerta…</option>
                {createReaders.map((r) => (
                  <option key={r.id} value={r.id}>{r.id} ({r.direction || 'ambos'})</option>
                ))}
              </select>
            </label>
            <label>
              <span className="historial-meta">Sentido</span>
              <select
                className="input-field"
                value={createForm.direction}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, direction: e.target.value }))}
              >
                <option value="ingreso">Ingreso</option>
                <option value="egreso">Egreso</option>
                <option value="ambos">Ambos</option>
              </select>
            </label>
          </div>
          <div className="lector-offline-opts" style={{ marginTop: '0.85rem' }}>
            <p className="theme-section-desc" style={{ marginBottom: '0.5rem' }}>
              Para online + cortes de red: puerta en <strong>En planta</strong> y
              {' '}<strong>Modo offline</strong> tildado acá.
            </p>
            <label className="lector-check">
              <input
                type="checkbox"
                checked={Boolean(createForm.offlineCache)}
                onChange={(e) => {
                  const next = e.target.checked;
                  const door = doors.find((d) => d.id === createForm.doorId);
                  const issue = checkOfflineWithDoorRelay({
                    offlineCache: next,
                    doorRelayMode: door?.relayMode,
                    doorName: door?.name || door?.id || createForm.doorId,
                    context: 'lector'
                  });
                  if (issue) {
                    alert(issue);
                    return;
                  }
                  setCreateForm((prev) => ({
                    ...prev,
                    offlineCache: next,
                    localFirstMode: next ? prev.localFirstMode : false
                  }));
                }}
              />
              <span>Modo offline (caché local) — recomendado</span>
            </label>
            <label className={`lector-check${createForm.offlineCache ? '' : ' lector-check--dim'}`}>
              <input
                type="checkbox"
                checked={Boolean(createForm.localFirstMode) && Boolean(createForm.offlineCache)}
                disabled={!createForm.offlineCache}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, localFirstMode: e.target.checked }))}
              />
              <span>Modo instantáneo (decide con caché local)</span>
            </label>
            <div className="admin-form-grid" style={{ marginTop: '0.5rem' }}>
              <label>
                <span className="historial-meta">Refresco lista (min)</span>
                <input
                  className="input-field"
                  type="number"
                  min={1}
                  max={1440}
                  disabled={!createForm.offlineCache}
                  value={createForm.offlineCacheRefreshMinutes}
                  onChange={(e) => setCreateForm((prev) => ({
                    ...prev,
                    offlineCacheRefreshMinutes: e.target.value
                  }))}
                />
              </label>
              <label>
                <span className="historial-meta">Antigüedad máx. (horas)</span>
                <input
                  className="input-field"
                  type="number"
                  min={1}
                  max={168}
                  disabled={!createForm.offlineCache}
                  value={createForm.offlineCacheMaxAgeHours}
                  onChange={(e) => setCreateForm((prev) => ({
                    ...prev,
                    offlineCacheMaxAgeHours: e.target.value
                  }))}
                />
              </label>
            </div>
          </div>
          <div className="flex flex-wrap gap-2" style={{ marginTop: '0.75rem' }}>
            <PendingButton
              type="submit"
              className="btn btn-primary"
              actionId="createLector"
              pendingAction={pendingAction}
            >
              <PlusCircle size={16} /> Crear lector
            </PendingButton>
          </div>
        </AdminFormCard>
      </AdminBlock>

      <AdminBlock
        title={`Lectores (${lectores.length})`}
        description="Con modo offline, la mini PC descarga quién puede pasar ahora por esa puerta (DNI únicos con autorización vigente). “Sincronizar ahora” lo refresca en unos segundos. La columna “Lista offline” muestra la última actualización reportada por la estación."
      >
        {loading ? (
          <AdminLoading label="Cargando lectores…" />
        ) : lectores.length === 0 ? (
          <AdminEmpty
            icon={ScanLine}
            title="Todavía no hay lectores"
            description="Creá uno para generar la estación de acceso y el JSON de la mini PC."
          />
        ) : (
          <AdminTable>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Puerta</th>
                <th>Reader</th>
                <th>Puerto</th>
                <th>Sentido</th>
                <th>Conexión</th>
                <th>Última conexión</th>
                <th>Lista offline</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {lectores.map((row) => {
                const status = CONNECTION_STATUS_META[row.connectionStatus] || CONNECTION_STATUS_META.offline;
                const allowlist = describeAllowlistStatus(row);
                return (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.nombre}</strong>
                      <div className="theme-section-desc">{row.usuarioSistemaId}</div>
                    </td>
                    <td>{doorName(row.doorId)}</td>
                    <td><code>{row.readerId}</code></td>
                    <td>
                      <code>{row.puertoDetectado || '—'}</code>
                      {row.inputModeDetectado ? (
                        <div className="theme-section-desc">{row.inputModeDetectado}</div>
                      ) : null}
                    </td>
                    <td>{DIRECTION_LABELS[row.direction] || row.direction}</td>
                    <td>
                      <span className={status.className} title={status.hint}>
                        <span className="lector-status__dot" aria-hidden />
                        {status.label}
                      </span>
                    </td>
                    <td>{formatUltimaConexion(row.ultimaConexion)}</td>
                    <td>
                      <span
                        className={`lector-allowlist-pill lector-allowlist-pill--${allowlist.tone}`}
                        title={allowlist.detail}
                      >
                        {allowlist.short}
                      </span>
                      {row.offlineCache ? (
                        <div className="theme-section-desc">Offline activo{row.localFirstMode ? ' · instantáneo' : ''}</div>
                      ) : null}
                    </td>
                    <td>
                      <div className="admin-row-actions">
                        <button type="button" className="admin-icon-btn" title="Editar" onClick={() => startEdit(row)}>
                          <Pencil size={16} />
                        </button>
                        <button
                          type="button"
                          className="admin-icon-btn"
                          title="Sincronizar ahora (unos segundos)"
                          onClick={() => handleForceResync(row)}
                        >
                          <RefreshCw size={16} />
                        </button>
                        <button
                          type="button"
                          className="admin-icon-btn"
                          title="Generar código de instalación"
                          onClick={() => handleGeneratePairingCode(row)}
                        >
                          <Hash size={16} />
                        </button>
                        <button
                          type="button"
                          className="admin-icon-btn"
                          title="Destrabar intentos de login"
                          onClick={() => handleClearLoginFailures(row)}
                        >
                          <Unlock size={16} />
                        </button>
                        <button type="button" className="admin-icon-btn" title="Descargar config" onClick={() => handleDownloadConfig(row)}>
                          <Download size={16} />
                        </button>
                        <button type="button" className="admin-icon-btn" title="Regenerar credenciales" onClick={() => handleRegenerate(row)}>
                          <KeyRound size={16} />
                        </button>
                        <button type="button" className="admin-icon-btn admin-icon-btn--danger" title="Eliminar" onClick={() => handleDelete(row)}>
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </AdminTable>
        )}
      </AdminBlock>

      <style>{`
        .lector-status {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.85rem;
          font-weight: 600;
        }
        .lector-status__dot {
          width: 0.55rem;
          height: 0.55rem;
          border-radius: 50%;
          background: currentColor;
        }
        .lector-status--online { color: #16a34a; }
        .lector-status--stale { color: #ca8a04; }
        .lector-status--offline { color: #dc2626; }
        .lector-pairing-code {
          display: flex;
          justify-content: center;
          gap: 0.45rem;
          margin: 0.5rem 0 0;
          font-variant-numeric: tabular-nums;
        }
        .lector-pairing-code__digit {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 2.4rem;
          height: 3.1rem;
          padding: 0 0.35rem;
          border-radius: 0.5rem;
          border: 1px solid var(--border, #2a2a2a);
          background: var(--panel-muted, #111);
          font-size: 1.85rem;
          font-weight: 700;
          letter-spacing: 0.02em;
        }
        .admin-row-actions { display: flex; gap: 0.25rem; flex-wrap: wrap; }
        .admin-form-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
          gap: 0.75rem;
        }
        .admin-form-grid label { display: flex; flex-direction: column; gap: 0.35rem; }
        .lector-check {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin: 0.35rem 0;
          font-size: 0.9rem;
        }
        .lector-check--dim { opacity: 0.55; }
        .lector-allowlist-status {
          margin: 0.65rem 0 0.35rem;
          padding: 0.65rem 0.75rem;
          border-radius: 0.5rem;
          border: 1px solid var(--border, #2a2a2a);
          background: var(--panel-muted, #111);
          font-size: 0.9rem;
        }
        .lector-allowlist-status--ok { border-color: #166534; }
        .lector-allowlist-status--warn { border-color: #a16207; }
        .lector-allowlist-status--stale { border-color: #b91c1c; }
        .lector-allowlist-status--off { opacity: 0.85; }
        .lector-allowlist-pill {
          display: inline-block;
          max-width: 14rem;
          font-size: 0.82rem;
          font-weight: 600;
          line-height: 1.25;
        }
        .lector-allowlist-pill--ok { color: #16a34a; }
        .lector-allowlist-pill--warn { color: #ca8a04; }
        .lector-allowlist-pill--stale { color: #dc2626; }
        .lector-allowlist-pill--off { color: #9ca3af; font-weight: 500; }
      `}</style>
    </div>
  );
}

export default LectoresAdminSection;
