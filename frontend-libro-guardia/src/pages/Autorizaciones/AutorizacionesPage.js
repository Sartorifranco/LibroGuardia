import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../context/ConfirmContext';
import { apiFetch } from '../../services/api';
import { hasPermission } from '../../utils/permissions';
import { Modal, PageContainer } from '../../components/admin-ui';
import './autorizaciones.css';

const TABS = [
  { id: 'abiertas', label: 'Pendientes' },
  { id: 'vigentes', label: 'Aprobadas' },
  { id: 'historial', label: 'Historial' }
];

const TIPO_LABEL = {
  visita: 'Visita',
  citacion: 'Citación',
  temporal: 'Temporal',
  excepcion: 'Excepción'
};

const ESTADO_LABEL = {
  pendiente: 'Pendiente',
  revision: 'Para revisar',
  aprobada: 'Aprobada',
  rechazada: 'Rechazada',
  vencida: 'Vencida',
  cancelada: 'Cancelada'
};

const formatCuando = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  return date.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
};

function AutorizacionesPage() {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const { confirm } = useConfirm();
  const canAsk = hasPermission(currentUser, 'autorizaciones.solicitar')
    || hasPermission(currentUser, 'master.citaciones.preregister')
    || hasPermission(currentUser, 'access.exceptional_entry')
    || currentUser?.role === 'admin';
  const [tab, setTab] = useState('abiertas');
  const [requests, setRequests] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [options, setOptions] = useState({ empresas: [], destinos: [] });
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rejectId, setRejectId] = useState(null);
  const [rejectNote, setRejectNote] = useState('');
  const [approveId, setApproveId] = useState(null);
  const [approveNote, setApproveNote] = useState('');
  const [form, setForm] = useState({
    dni: '',
    name: '',
    empresaId: '',
    destinoId: '',
    desde: '',
    hasta: '',
    motivo: '',
    tipo: 'visita'
  });

  const load = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch(`/requests?estado=${tab}&limit=50`, { token: authToken });
      setRequests(data.requests || []);
      setPendingCount(Number(data.pendingCount) || 0);
    } catch (err) {
      setError(err.message || 'No se pudo cargar la bandeja.');
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }, [authToken, tab]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!authToken || !canAsk) return;
    apiFetch('/requests/options', { token: authToken, allowForbidden: true })
      .then((data) => setOptions({
        empresas: data.empresas || [],
        destinos: data.destinos || []
      }))
      .catch(() => {});
  }, [authToken, canAsk]);

  const setField = (key) => (event) => {
    setForm((prev) => ({ ...prev, [key]: event.target.value }));
  };

  const submitRequest = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const data = await apiFetch('/requests', {
        method: 'POST',
        token: authToken,
        body: {
          tipo: form.tipo,
          persona: { name: form.name.trim(), dni: form.dni.trim() },
          empresaId: form.empresaId,
          destinoId: form.destinoId,
          desde: form.desde,
          hasta: form.hasta || form.desde,
          motivo: form.motivo.trim()
        }
      });
      showSuccess(data.message || 'Solicitud enviada.');
      setShowForm(false);
      setForm({
        dni: '', name: '', empresaId: '', destinoId: '', desde: '', hasta: '', motivo: '', tipo: 'visita'
      });
      setTab('abiertas');
      await load();
    } catch (err) {
      showError(err.message || 'No se pudo enviar la solicitud.');
    } finally {
      setSaving(false);
    }
  };

  const approve = async () => {
    const row = requests.find((item) => item.id === approveId);
    if (!row) return;
    try {
      const nota = approveNote.trim();
      await apiFetch(`/requests/${row.id}/approve`, {
        method: 'POST',
        token: authToken,
        body: nota ? { nota } : {}
      });
      showSuccess('Guardado');
      setApproveId(null);
      setApproveNote('');
      await load();
    } catch (err) {
      showError(err.message || 'No se pudo aprobar.');
    }
  };

  const reject = async (row) => {
    if (rejectNote.trim().length < 3) {
      showError('Escribí por qué la rechazás.');
      return;
    }
    try {
      await apiFetch(`/requests/${row.id}/reject`, {
        method: 'POST',
        token: authToken,
        body: { nota: rejectNote.trim() }
      });
      showSuccess('Guardado');
      setRejectId(null);
      setRejectNote('');
      await load();
    } catch (err) {
      showError(err.message || 'No se pudo rechazar.');
    }
  };

  const cancel = async (row) => {
    const ok = await confirm({
      title: 'Cancelar solicitud',
      message: 'La persona no va a quedar autorizada.',
      confirmLabel: 'Cancelar solicitud',
      tone: 'danger'
    });
    if (!ok) return;
    try {
      const data = await apiFetch(`/requests/${row.id}/cancel`, { method: 'POST', token: authToken });
      showSuccess(data.message || 'Solicitud cancelada.');
      await load();
    } catch (err) {
      showError(err.message || 'No se pudo cancelar.');
    }
  };

  const emptyLabel = useMemo(() => {
    if (tab === 'abiertas') return 'No hay solicitudes pendientes.';
    if (tab === 'vigentes') return 'No hay autorizaciones vigentes.';
    return 'No hay historial para mostrar.';
  }, [tab]);

  const approveRow = requests.find((item) => item.id === approveId) || null;
  const rejectRow = requests.find((item) => item.id === rejectId) || null;

  return (
    <PageContainer width="medium">
    <div className="form-section auth-requests">
      <div className="section-heading">
        <h2 className="text-2xl font-semibold text-red-700">Autorizaciones</h2>
        <p className="text-sm text-gray-600">
          Pedí un ingreso y esperá a que lo apruebe el responsable de la empresa.
          Quien lo pide no puede aprobarlo.
        </p>
      </div>

      <div className="auth-requests__tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`auth-requests__tab${tab === item.id ? ' is-active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.id === 'abiertas' ? ` (${pendingCount})` : ''}
          </button>
        ))}
      </div>

      {canAsk && (
        <button type="button" className="btn btn-primary auth-requests__new" onClick={() => setShowForm(true)}>
          <Plus size={18} />
          Nueva solicitud
        </button>
      )}

      <Modal
        open={showForm}
        title="Nueva solicitud"
        description="Pedí un ingreso. Lo aprueba el responsable de la empresa."
        onClose={() => setShowForm(false)}
        dirty={Boolean(form.dni || form.name || form.motivo)}
        footer={(
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancelar</button>
            <button type="submit" form="auth-request-form" className="btn btn-primary" disabled={saving}>
              {saving ? 'Enviando…' : 'Enviar solicitud'}
            </button>
          </>
        )}
      >
        <form id="auth-request-form" className="auth-requests__form" onSubmit={submitRequest}>
          <label>
            DNI
            <input className="input-field" inputMode="numeric" required value={form.dni} onChange={setField('dni')} />
          </label>
          <label>
            Nombre
            <input className="input-field" required value={form.name} onChange={setField('name')} />
          </label>
          <label>
            Empresa
            <select className="input-field" required value={form.empresaId} onChange={setField('empresaId')}>
              <option value="">Elegí la empresa</option>
              {options.empresas.map((empresa) => (
                <option key={empresa.id} value={empresa.id}>{empresa.nombre}</option>
              ))}
            </select>
          </label>
          <label>
            Destino
            <select className="input-field" required value={form.destinoId} onChange={setField('destinoId')}>
              <option value="">Elegí a dónde va</option>
              {options.destinos.map((destino) => (
                <option key={destino.id} value={destino.id}>{destino.nombre}</option>
              ))}
            </select>
          </label>
          <label>
            Tipo
            <select className="input-field" value={form.tipo} onChange={setField('tipo')}>
              <option value="visita">Visita</option>
              <option value="citacion">Citación</option>
              <option value="temporal">Por unos días</option>
            </select>
          </label>
          <label>
            Desde
            <input className="input-field" type="datetime-local" required value={form.desde} onChange={setField('desde')} />
          </label>
          <label>
            Hasta
            <input className="input-field" type="datetime-local" required value={form.hasta} onChange={setField('hasta')} />
          </label>
          <label className="auth-requests__full">
            Motivo
            <input className="input-field" required minLength={3} value={form.motivo} onChange={setField('motivo')} />
          </label>
        </form>
      </Modal>

      {loading && <p className="auth-requests__status">Cargando…</p>}
      {!loading && error && (
        <div className="auth-requests__status auth-requests__status--error">
          <p>{error}</p>
          <button type="button" className="btn btn-secondary" onClick={load}>Reintentar</button>
        </div>
      )}
      {!loading && !error && requests.length === 0 && (
        <p className="auth-requests__status">{emptyLabel}</p>
      )}

      <ul className="auth-requests__list">
        {!loading && !error && requests.map((row) => (
          <li key={row.id} className="auth-requests__card">
            <div className="auth-requests__card-top">
              <strong>{row.persona?.name || 'Sin nombre'}</strong>
              <span className={`auth-requests__estado auth-requests__estado--${row.estado}`}>
                {ESTADO_LABEL[row.estado] || row.estado}
              </span>
            </div>
            <p>DNI {row.persona?.dni || '—'}</p>
            <p>{row.empresaNombre || 'Sin empresa'} · {TIPO_LABEL[row.tipo] || row.tipo}</p>
            <p>{row.destinoNombre || 'Sin destino'}{row.puertas?.length ? ` · ${row.puertas.length} puerta${row.puertas.length === 1 ? '' : 's'}` : ''}</p>
            <p>{formatCuando(row.desde)} — {formatCuando(row.hasta)}</p>
            <p>Lo pidió {row.solicitadoPorNombre || '—'}</p>
            {row.motivo ? <p>{row.motivo}</p> : null}
            {row.notaDecision ? <p>Nota: {row.notaDecision}</p> : null}
            {(row.puedeDecidir || row.puedeCancelar) && (
              <div className="auth-requests__actions">
                {row.puedeDecidir && (
                  <button type="button" className="btn btn-primary" onClick={() => { setApproveId(row.id); setApproveNote(''); }}>
                    <Check size={18} /> Aprobar
                  </button>
                )}
                {row.puedeDecidir && (
                  <button type="button" className="btn btn-secondary" onClick={() => {
                    setRejectId(row.id);
                    setRejectNote('');
                  }}
                  >
                    Rechazar
                  </button>
                )}
                {row.puedeCancelar && (
                  <button type="button" className="btn btn-secondary" onClick={() => cancel(row)}>
                    Cancelar solicitud
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      <Modal
        open={Boolean(approveRow)}
        title="Aprobar ingreso"
        description={approveRow ? `¿Aprobás el ingreso de ${approveRow.persona?.name || 'esta persona'}?` : ''}
        onClose={() => setApproveId(null)}
        size="sm"
        dirty={Boolean(approveNote.trim())}
        footer={(
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setApproveId(null)}>Cancelar</button>
            <button type="button" className="btn btn-primary" onClick={approve}>Aprobar</button>
          </>
        )}
      >
        <label>
          Nota (opcional)
          <textarea className="input-field" aria-label="Nota de aprobación" value={approveNote} onChange={(event) => setApproveNote(event.target.value)} rows={3} />
        </label>
      </Modal>

      <Modal
        open={Boolean(rejectRow)}
        title="Rechazar solicitud"
        description="Contá por qué, para que quien la pidió lo entienda."
        onClose={() => setRejectId(null)}
        size="sm"
        dirty={Boolean(rejectNote.trim())}
        footer={(
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setRejectId(null)}>Cancelar</button>
            <button type="button" className="btn btn-primary" disabled={rejectNote.trim().length < 3} onClick={() => rejectRow && reject(rejectRow)}>
              Confirmar rechazo
            </button>
          </>
        )}
      >
        <label>
          Por qué la rechazás
          <textarea
            className="input-field"
            aria-label="Por qué la rechazás"
            required
            minLength={3}
            value={rejectNote}
            onChange={(event) => setRejectNote(event.target.value)}
          />
        </label>
      </Modal>
    </div>
    </PageContainer>
  );
}

export default AutorizacionesPage;
