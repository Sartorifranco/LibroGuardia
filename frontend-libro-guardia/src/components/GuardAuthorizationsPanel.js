import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, UserPlus, ShieldCheck } from 'lucide-react';
import { apiFetch } from '../services/api';

const AUTH_TYPE_LABELS = {
  citacion: 'Citación',
  visita: 'Visita',
  visit: 'Visita',
  temporal: 'Temporal',
  permanent: 'Permanente'
};

const formatAuthSchedule = (item) => {
  const type = item.type === 'visit' ? 'visita' : item.type;
  if (type === 'permanent') {
    const days = item.daysOfWeek?.length ? item.daysOfWeek.join(', ') : 'Todos los días';
    const time = item.timeWindow?.from && item.timeWindow?.to
      ? `${item.timeWindow.from}–${item.timeWindow.to}`
      : 'Sin tope horario';
    return `${days} · ${time}`;
  }
  if (type === 'visita' || type === 'temporal') {
    if (item.endDate && item.endDate !== item.startDate) {
      return `${item.startDate} → ${item.endDate}`;
    }
    return item.startDate || '—';
  }
  return item.startDate || item.appointmentDate || '—';
};

function GuardAuthorizationsPanel({
  authToken,
  canPreRegister,
  onSuccess,
  onError
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [loading, setLoading] = useState(true);
  const [authorizations, setAuthorizations] = useState([]);
  const [plannedDates, setPlannedDates] = useState([]);
  const [filterDate, setFilterDate] = useState('');
  const [search, setSearch] = useState('');
  const [viewDate, setViewDate] = useState(today);
  const [preName, setPreName] = useState('');
  const [preDni, setPreDni] = useState('');
  const [preLegajo, setPreLegajo] = useState('');
  const [preCompany, setPreCompany] = useState('');
  const [preDestination, setPreDestination] = useState('');
  const [preStart, setPreStart] = useState(today);
  const [preEnd, setPreEnd] = useState(today);
  const [preNotes, setPreNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadAuthorizations = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    try {
      const data = await apiFetch(
        `/guard/authorizations?scope=external&date=${viewDate}`,
        { token: authToken }
      );
      setAuthorizations(data.authorizations || []);
      setPlannedDates(data.plannedDates || []);
    } catch (err) {
      onError?.(err.message);
    } finally {
      setLoading(false);
    }
  }, [authToken, viewDate, onError]);

  useEffect(() => {
    loadAuthorizations();
  }, [loadAuthorizations]);

  const filtered = useMemo(() => authorizations.filter((item) => {
    if (filterDate && item.startDate !== filterDate) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return [item.name, item.legajo, item.idNumber, item.company]
      .some((field) => String(field || '').toLowerCase().includes(q));
  }), [authorizations, filterDate, search]);

  const handlePreRegister = async (e) => {
    e.preventDefault();
    if (!preName.trim()) {
      onError?.('Indique nombre de la persona esperada');
      return;
    }
    if (!preDni.trim() && !preLegajo.trim()) {
      onError?.('Indique DNI o legajo');
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch('/guard/pre-register', {
        method: 'POST',
        token: authToken,
        body: {
          type: 'visita',
          name: preName.trim(),
          idNumber: preDni.trim(),
          legajo: preLegajo.trim(),
          company: preCompany.trim(),
          destination: preDestination.trim(),
          startDate: preStart,
          endDate: preEnd,
          notes: preNotes.trim(),
          personTipo: 'visita'
        }
      });
      onSuccess?.('Visita pre-registrada. La persona quedará autorizada en esas fechas.');
      setPreName('');
      setPreDni('');
      setPreLegajo('');
      setPreCompany('');
      setPreDestination('');
      setPreNotes('');
      loadAuthorizations();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="section-heading">
        <h2 className="text-2xl font-semibold text-red-700">Autorizados</h2>
        <p className="attendance-panel__purpose" style={{ marginTop: '0.35rem' }}>
          Permisos de acceso — quién está autorizado a entrar.
        </p>
        <p className="text-sm text-gray-600">
          Visitas, contratistas, temporales y pre-registro. La asistencia de citaciones del día está en Citados.
        </p>
      </div>

      {canPreRegister && (
        <form onSubmit={handlePreRegister} className="theme-callout-warn space-y-3">
          <h3 className="theme-section-title flex items-center gap-2" style={{ fontSize: '1rem', marginBottom: 0 }}>
            <UserPlus size={18} /> Pre-registrar visita esperada
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            <input className="input-field" placeholder="Apellido y nombre" value={preName} onChange={(e) => setPreName(e.target.value)} required />
            <input className="input-field" placeholder="DNI" value={preDni} onChange={(e) => setPreDni(e.target.value)} />
            <input className="input-field" placeholder="Legajo (opcional)" value={preLegajo} onChange={(e) => setPreLegajo(e.target.value)} />
            <input className="input-field" placeholder="Empresa" value={preCompany} onChange={(e) => setPreCompany(e.target.value)} />
            <input className="input-field" placeholder="Destino" value={preDestination} onChange={(e) => setPreDestination(e.target.value)} />
            <input type="date" className="input-field" value={preStart} onChange={(e) => setPreStart(e.target.value)} title="Desde" />
            <input type="date" className="input-field" value={preEnd} onChange={(e) => setPreEnd(e.target.value)} title="Hasta" />
            <input className="input-field md:col-span-2" placeholder="Observaciones" value={preNotes} onChange={(e) => setPreNotes(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-secondary" disabled={submitting}>
            {submitting ? 'Guardando...' : 'Pre-registrar visita'}
          </button>
        </form>
      )}

      <div className="flex flex-wrap gap-2 items-end">
        <input type="date" className="input-field" value={viewDate} onChange={(e) => setViewDate(e.target.value)} title="Desde" />
        <input type="text" className="input-field" placeholder="Buscar nombre, legajo o DNI" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button type="button" className="btn btn-secondary-small" onClick={() => setFilterDate('')}>Todos ({authorizations.length})</button>
        {plannedDates.map(({ date, count }) => (
          <button
            key={date}
            type="button"
            className={`btn btn-secondary-small ${filterDate === date ? 'ring-2 ring-red-500' : ''}`}
            onClick={() => setFilterDate(filterDate === date ? '' : date)}
          >
            {date.split('-').reverse().join('/')} ({count})
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="animate-spin" size={16} /> Cargando...</p>
      ) : (
        <div className="scroll-panel-max overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-100 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left text-xs uppercase">Tipo</th>
                <th className="px-3 py-2 text-left text-xs uppercase">Vigencia</th>
                <th className="px-3 py-2 text-left text-xs uppercase">Nombre</th>
                <th className="px-3 py-2 text-left text-xs uppercase">Legajo</th>
                <th className="px-3 py-2 text-left text-xs uppercase">DNI</th>
                <th className="px-3 py-2 text-left text-xs uppercase">Empresa</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-4 text-sm text-gray-500">Sin autorizaciones para los filtros actuales.</td></tr>
              )}
              {filtered.map((item) => (
                <tr key={item.id} className="border-t">
                  <td className="px-3 py-2 text-sm">{AUTH_TYPE_LABELS[item.type] || item.type}</td>
                  <td className="px-3 py-2 text-sm">{formatAuthSchedule(item)}</td>
                  <td className="px-3 py-2">{item.name}</td>
                  <td className="px-3 py-2">{item.legajo || '—'}</td>
                  <td className="px-3 py-2">{item.idNumber || '—'}</td>
                  <td className="px-3 py-2">{item.company || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-500 flex items-center gap-1">
        <ShieldCheck size={14} /> Solo consulta. Para ingreso excepcional usá la pestaña Personal.
      </p>
    </div>
  );
}

export default GuardAuthorizationsPanel;
