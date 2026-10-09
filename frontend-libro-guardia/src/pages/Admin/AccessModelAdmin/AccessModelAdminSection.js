import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../../services/api';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { AdminEmpty } from '../../../components/admin/AdminUi';
import './access-model.css';

const TABS = [
  { id: 'grupos', label: 'Grupos' },
  { id: 'horarios', label: 'Horarios' },
  { id: 'feriados', label: 'Feriados' },
  { id: 'simular', label: '¿Puede pasar?' }
];

const DAY_CHIPS = [
  { day: 1, label: 'L', name: 'Lunes' },
  { day: 2, label: 'M', name: 'Martes' },
  { day: 3, label: 'X', name: 'Miércoles' },
  { day: 4, label: 'J', name: 'Jueves' },
  { day: 5, label: 'V', name: 'Viernes' },
  { day: 6, label: 'S', name: 'Sábado' },
  { day: 0, label: 'D', name: 'Domingo' }
];

const blankInterval = () => ({ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' });
const blankSchedule = () => ({
  name: '',
  intervals: [blankInterval()],
  toleranceBeforeMin: 0,
  toleranceAfterMin: 0,
  holidayBehavior: 'deny'
});
const blankGroup = () => ({ name: '', scheduleId: '24x7', allDoors: false, doors: [] });

const thisYear = () => new Date().getFullYear();

const scheduleLabel = (schedule) => {
  if (!schedule || schedule.always || schedule.id === '24x7') return 'Siempre';
  return schedule.name || 'Horario';
};

function DayChips({ days, onToggle }) {
  return (
    <div className="day-chips" role="group" aria-label="Días">
      {DAY_CHIPS.map((chip) => {
        const on = days.includes(chip.day);
        return (
          <button
            key={chip.day}
            type="button"
            className={`day-chip${on ? ' is-on' : ''}`}
            aria-pressed={on}
            aria-label={chip.name}
            onClick={() => onToggle(chip.day)}
          >
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}

function AccessModelAdminSection({ initialTab = 'grupos', lockTab = false } = {}) {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const { confirm } = useConfirm();
  const canManage = hasPermission(currentUser, 'access.groups.manage');
  const [tab, setTab] = useState(initialTab || 'grupos');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [schedules, setSchedules] = useState([]);
  const [groups, setGroups] = useState([]);
  const [doors, setDoors] = useState([]);
  const [scheduleEdit, setScheduleEdit] = useState(null);
  const [scheduleDraft, setScheduleDraft] = useState(blankSchedule);
  const [groupEdit, setGroupEdit] = useState(null);
  const [groupDraft, setGroupDraft] = useState(blankGroup);
  const [year, setYear] = useState(thisYear);
  const [dates, setDates] = useState([]);
  const [holidayBusy, setHolidayBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState([]);
  const [person, setPerson] = useState(null);
  const [doorId, setDoorId] = useState('');
  const [at, setAt] = useState('');
  const [simResult, setSimResult] = useState(null);
  const [simBusy, setSimBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const visibleTabs = canManage ? TABS : TABS.filter((t) => t.id === 'grupos' || t.id === 'simular');

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  const loadSchedules = useCallback(async () => {
    const data = await apiFetch('/admin/schedules', { token: authToken });
    setSchedules(data.schedules || []);
  }, [authToken]);

  const loadGroups = useCallback(async () => {
    const data = await apiFetch('/admin/access-groups', { token: authToken });
    setGroups(data.groups || []);
    setDoors(data.doors || []);
    setDoorId((current) => current || (data.doors && data.doors[0] ? data.doors[0].id : ''));
  }, [authToken]);

  const loadHolidays = useCallback(async (y) => {
    const data = await apiFetch(`/admin/holidays/${y}`, { token: authToken });
    setDates(Array.isArray(data.dates) ? data.dates : []);
  }, [authToken]);

  useEffect(() => {
    let cancel = false;
    const run = async () => {
      setLoading(true);
      setError('');
      try {
        if (tab === 'horarios') await loadSchedules();
        else if (tab === 'grupos' || tab === 'simular') {
          await loadGroups();
          if (canManage) await loadSchedules();
        } else if (tab === 'feriados') await loadHolidays(year);
      } catch (err) {
        if (!cancel) setError(err.message || 'No se pudo cargar.');
      } finally {
        if (!cancel) setLoading(false);
      }
    };
    run();
    return () => { cancel = true; };
  }, [tab, year, canManage, loadSchedules, loadGroups, loadHolidays, reloadKey]);

  const scheduleName = (id) => scheduleLabel(schedules.find((s) => s.id === id) || { id });

  const startSchedule = (item) => {
    if (!item) {
      setScheduleEdit('new');
      setScheduleDraft(blankSchedule());
      return;
    }
    setScheduleEdit(item.id);
    setScheduleDraft({
      name: item.name || '',
      intervals: item.intervals && item.intervals.length ? item.intervals : [blankInterval()],
      toleranceBeforeMin: item.toleranceBeforeMin || 0,
      toleranceAfterMin: item.toleranceAfterMin || 0,
      holidayBehavior: item.holidayBehavior === 'allow' ? 'allow' : 'deny'
    });
  };

  const saveSchedule = async (event) => {
    event.preventDefault();
    try {
      const path = scheduleEdit === 'new' ? '/admin/schedules' : `/admin/schedules/${scheduleEdit}`;
      await apiFetch(path, {
        method: scheduleEdit === 'new' ? 'POST' : 'PUT',
        token: authToken,
        body: scheduleDraft
      });
      showSuccess(scheduleEdit === 'new' ? 'Horario creado.' : 'Horario guardado.');
      setScheduleEdit(null);
      await loadSchedules();
    } catch (err) {
      showError(err.message || 'No se pudo guardar el horario.');
    }
  };

  const deleteSchedule = async (item) => {
    const ok = await confirm({
      title: 'Borrar horario',
      message: `¿Borrar “${item.name}”? Si un grupo lo usa, no se va a poder.`,
      confirmLabel: 'Borrar',
      tone: 'danger'
    });
    if (!ok) return;
    try {
      await apiFetch(`/admin/schedules/${item.id}`, { method: 'DELETE', token: authToken });
      showSuccess('Horario borrado.');
      if (scheduleEdit === item.id) setScheduleEdit(null);
      await loadSchedules();
    } catch (err) {
      showError(err.message || 'No se pudo borrar el horario.');
    }
  };

  const startGroup = (item) => {
    if (!item) {
      setGroupEdit('new');
      setGroupDraft(blankGroup());
      return;
    }
    setGroupEdit(item.id);
    setGroupDraft({
      name: item.name || '',
      scheduleId: item.scheduleId || '24x7',
      allDoors: item.allDoors === true || item.doors === '*',
      doors: Array.isArray(item.doors) ? item.doors : []
    });
  };

  const saveGroup = async (event) => {
    event.preventDefault();
    const body = {
      name: groupDraft.name,
      scheduleId: groupDraft.scheduleId,
      allDoors: groupDraft.allDoors,
      doors: groupDraft.allDoors ? '*' : groupDraft.doors
    };
    try {
      const path = groupEdit === 'new' ? '/admin/access-groups' : `/admin/access-groups/${groupEdit}`;
      await apiFetch(path, {
        method: groupEdit === 'new' ? 'POST' : 'PUT',
        token: authToken,
        body
      });
      showSuccess(groupEdit === 'new' ? 'Grupo creado.' : 'Grupo guardado.');
      setGroupEdit(null);
      await loadGroups();
    } catch (err) {
      showError(err.message || 'No se pudo guardar el grupo.');
    }
  };

  const deleteGroup = async (item) => {
    const ok = await confirm({
      title: 'Borrar grupo',
      message: item.memberCount
        ? `“${item.name}” tiene ${item.memberCount} personas. Sacalas de la ficha antes de borrarlo.`
        : `¿Borrar “${item.name}”?`,
      confirmLabel: 'Borrar',
      tone: 'danger'
    });
    if (!ok) return;
    try {
      await apiFetch(`/admin/access-groups/${item.id}`, { method: 'DELETE', token: authToken });
      showSuccess('Grupo borrado.');
      if (groupEdit === item.id) setGroupEdit(null);
      await loadGroups();
    } catch (err) {
      showError(err.message || 'No se pudo borrar el grupo.');
    }
  };

  const loadNational = async () => {
    if (dates.length) {
      const ok = await confirm({
        title: 'Cargar feriados nacionales',
        message: 'Se agregan los feriados de Argentina de este año. Los que ya cargaste se mantienen. Si una fecha coincide, se actualiza el nombre.',
        confirmLabel: 'Cargar',
        tone: 'default'
      });
      if (!ok) return;
    }
    setHolidayBusy(true);
    try {
      const data = await apiFetch(`/admin/holidays/${year}/national`, { method: 'POST', token: authToken });
      setDates(data.dates || []);
      showSuccess('Feriados nacionales cargados. Podés editarlos y guardar.');
    } catch (err) {
      showError(err.message || 'No se pudieron cargar los feriados.');
    } finally {
      setHolidayBusy(false);
    }
  };

  const saveHolidays = async () => {
    setHolidayBusy(true);
    try {
      const data = await apiFetch(`/admin/holidays/${year}`, {
        method: 'PUT',
        token: authToken,
        body: { dates }
      });
      setDates(data.dates || []);
      showSuccess('Feriados guardados.');
    } catch (err) {
      showError(err.message || 'No se pudieron guardar los feriados.');
    } finally {
      setHolidayBusy(false);
    }
  };

  const searchPeople = async (event) => {
    event.preventDefault();
    const q = query.trim();
    if (q.length < 2) {
      showError('Escribí al menos 2 letras o el DNI.');
      return;
    }
    setSimBusy(true);
    setSimResult(null);
    try {
      const data = await apiFetch(`/admin/people?q=${encodeURIComponent(q)}`, { token: authToken });
      setPeople(data.people || []);
      if (!(data.people || []).length) showError('No hay personas con esa búsqueda.');
    } catch (err) {
      showError(err.message || 'No se pudo buscar.');
    } finally {
      setSimBusy(false);
    }
  };

  const simulate = async (event) => {
    event.preventDefault();
    if (!person) {
      showError('Elegí una persona.');
      return;
    }
    setSimBusy(true);
    try {
      const data = await apiFetch('/admin/access/simulate', {
        method: 'POST',
        token: authToken,
        body: { personId: person.id, doorId, at }
      });
      setSimResult(data);
    } catch (err) {
      showError(err.message || 'No se pudo consultar.');
      setSimResult(null);
    } finally {
      setSimBusy(false);
    }
  };

  const zones = useMemo(() => {
    const active = doors.filter((d) => d.active !== false);
    const anyZone = active.some((d) => d.zone);
    const map = new Map();
    for (const door of active) {
      const key = anyZone ? (door.zone || 'Sin zona') : 'Puertas';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(door);
    }
    return { anyZone, entries: [...map.entries()] };
  }, [doors]);

  const updateInterval = (index, patch) => {
    setScheduleDraft((prev) => ({
      ...prev,
      intervals: prev.intervals.map((iv, i) => (i === index ? { ...iv, ...patch } : iv))
    }));
  };

  return (
    <div className="access-model">
      {!lockTab && (
      <div className="access-model__tabs" role="tablist" aria-label="Accesos">
        {visibleTabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`access-model__tab${tab === item.id ? ' is-active' : ''}`}
            onClick={() => { setTab(item.id); setError(''); }}
          >
            {item.label}
          </button>
        ))}
      </div>
      )}

      {loading ? <p role="status">Cargando…</p> : null}
      {!loading && error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn-secondary" onClick={() => setReloadKey((n) => n + 1)}>Reintentar</button>
        </div>
      ) : null}

      {!loading && !error && tab === 'horarios' ? (
        <div className="access-model__layout">
          <div className="access-list">
            {schedules.map((item) => (
              <div key={item.id} className="access-card" style={{ cursor: 'default' }}>
                <strong>{item.name || 'Siempre'}</strong>
                <span className="access-card__meta">
                  {item.builtin || item.always
                    ? 'Las 24 horas, todos los días. No se puede modificar.'
                    : 'Horario editable'}
                </span>
                {canManage && !item.builtin && !item.always ? (
                  <div className="access-actions" style={{ marginTop: '0.45rem' }}>
                    <button type="button" className="btn btn-secondary" onClick={() => startSchedule(item)}>Editar</button>
                    <button type="button" className="btn btn-secondary" onClick={() => deleteSchedule(item)}>Borrar</button>
                  </div>
                ) : null}
              </div>
            ))}
            {canManage ? (
              <button type="button" className="btn btn-primary" onClick={() => startSchedule(null)}>Nuevo horario</button>
            ) : null}
          </div>
          {scheduleEdit ? (
            <form onSubmit={saveSchedule}>
              <label className="people-access-field">
                <span>Nombre</span>
                <input className="input-field" value={scheduleDraft.name} onChange={(e) => setScheduleDraft((p) => ({ ...p, name: e.target.value }))} required />
              </label>
              {scheduleDraft.intervals.map((iv, index) => (
                <div className="access-franja" key={`franja-${index}`}>
                  <DayChips
                    days={iv.days || []}
                    onToggle={(day) => {
                      const has = (iv.days || []).includes(day);
                      const days = has ? iv.days.filter((d) => d !== day) : [...(iv.days || []), day];
                      updateInterval(index, { days });
                    }}
                  />
                  <div className="access-times">
                    <label>
                      Desde
                      <input className="input-field" aria-label="Desde" type="time" value={iv.from} onChange={(e) => updateInterval(index, { from: e.target.value })} required />
                    </label>
                    <label>
                      Hasta
                      <input className="input-field" aria-label="Hasta" type="time" value={iv.to} onChange={(e) => updateInterval(index, { to: e.target.value })} required />
                    </label>
                  </div>
                  {scheduleDraft.intervals.length > 1 ? (
                    <button type="button" className="btn btn-secondary" onClick={() => setScheduleDraft((p) => ({ ...p, intervals: p.intervals.filter((_, i) => i !== index) }))}>
                      Quitar franja
                    </button>
                  ) : null}
                </div>
              ))}
              <button type="button" className="btn btn-secondary" onClick={() => setScheduleDraft((p) => ({ ...p, intervals: [...p.intervals, blankInterval()] }))}>
                Agregar franja
              </button>
              <div className="access-times" style={{ marginTop: '0.6rem' }}>
                <label>
                  Minutos antes
                  <input className="input-field" type="number" min="0" max="240" value={scheduleDraft.toleranceBeforeMin} onChange={(e) => setScheduleDraft((p) => ({ ...p, toleranceBeforeMin: Number(e.target.value) }))} />
                </label>
                <label>
                  Minutos después
                  <input className="input-field" type="number" min="0" max="240" value={scheduleDraft.toleranceAfterMin} onChange={(e) => setScheduleDraft((p) => ({ ...p, toleranceAfterMin: Number(e.target.value) }))} />
                </label>
              </div>
              <fieldset style={{ border: 0, padding: 0, margin: '0.6rem 0' }}>
                <legend>En feriado</legend>
                <label className="access-check">
                  <input type="radio" name="feriado" checked={scheduleDraft.holidayBehavior !== 'allow'} onChange={() => setScheduleDraft((p) => ({ ...p, holidayBehavior: 'deny' }))} />
                  No permite
                </label>
                <label className="access-check">
                  <input type="radio" name="feriado" checked={scheduleDraft.holidayBehavior === 'allow'} onChange={() => setScheduleDraft((p) => ({ ...p, holidayBehavior: 'allow' }))} />
                  Permite
                </label>
              </fieldset>
              <div className="access-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setScheduleEdit(null)}>Cancelar</button>
                <button type="submit" className="btn btn-primary">Guardar horario</button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}

      {!loading && !error && tab === 'feriados' ? (
        <div>
          <label className="people-access-field">
            Año
            <select className="input-field" aria-label="Año" value={year} onChange={(e) => setYear(Number(e.target.value))}>
              <option value={thisYear()}>{thisYear()}</option>
              <option value={thisYear() + 1}>{thisYear() + 1}</option>
            </select>
          </label>
          <div className="access-actions" style={{ margin: '0.6rem 0' }}>
            <button type="button" className="btn btn-secondary" disabled={holidayBusy} onClick={loadNational}>
              Cargar feriados nacionales
            </button>
            <button type="button" className="btn btn-primary" disabled={holidayBusy} onClick={saveHolidays}>
              Guardar feriados
            </button>
          </div>
          {dates.length === 0 ? (
            <AdminEmpty title="Este año no tiene feriados" description="Cargá los nacionales o agregá una fecha a mano." />
          ) : null}
          {dates.map((item, index) => (
            <div className="access-times" key={`${item.date}-${index}`} style={{ marginBottom: '0.45rem' }}>
              <input className="input-field" aria-label={`Fecha ${index + 1}`} type="date" value={item.date} onChange={(e) => setDates((prev) => prev.map((row, i) => (i === index ? { ...row, date: e.target.value } : row)))} />
              <input className="input-field" aria-label={`Nombre ${index + 1}`} value={item.name} onChange={(e) => setDates((prev) => prev.map((row, i) => (i === index ? { ...row, name: e.target.value } : row)))} />
              <button type="button" className="btn btn-secondary" onClick={() => setDates((prev) => prev.filter((_, i) => i !== index))}>Quitar</button>
            </div>
          ))}
          <button type="button" className="btn btn-secondary" onClick={() => setDates((prev) => [...prev, { date: `${year}-01-01`, name: '' }])}>
            Agregar feriado
          </button>
        </div>
      ) : null}

      {!loading && !error && tab === 'grupos' ? (
        <div className="access-model__layout">
          <div className="access-list">
            {groups.length === 0 ? (
              <AdminEmpty title="Todavía no hay grupos" description="Un grupo junta puertas y un horario. Después se lo asignás a cada persona." />
            ) : groups.map((item) => (
              <button key={item.id} type="button" className={`access-card${groupEdit === item.id ? ' is-on' : ''}`} onClick={() => canManage && startGroup(item)}>
                <strong>{item.name}</strong>
                <span className="access-card__meta">
                  {scheduleName(item.scheduleId)}
                  {' · '}
                  {item.allDoors || item.doors === '*' ? 'Todas las puertas' : `${(item.doors || []).length} puertas`}
                  {' · '}
                  {item.memberCount || 0} {item.memberCount === 1 ? 'persona' : 'personas'}
                </span>
              </button>
            ))}
            {canManage ? (
              <button type="button" className="btn btn-primary" onClick={() => startGroup(null)}>Nuevo grupo</button>
            ) : null}
          </div>
          {groupEdit ? (
            <form onSubmit={saveGroup}>
              <label className="people-access-field">
                <span>Nombre</span>
                <input className="input-field" value={groupDraft.name} onChange={(e) => setGroupDraft((p) => ({ ...p, name: e.target.value }))} required />
              </label>
              <label className="people-access-field">
                <span>Horario</span>
                <select className="input-field" aria-label="Horario del grupo" value={groupDraft.scheduleId} onChange={(e) => setGroupDraft((p) => ({ ...p, scheduleId: e.target.value }))}>
                  {schedules.map((s) => <option key={s.id} value={s.id}>{scheduleLabel(s)}</option>)}
                  {schedules.some((s) => s.id === '24x7') ? null : <option value="24x7">Siempre</option>}
                </select>
              </label>
              <label className="access-check">
                <input type="checkbox" checked={groupDraft.allDoors} onChange={(e) => setGroupDraft((p) => ({ ...p, allDoors: e.target.checked }))} />
                Todas las puertas, también las que se agreguen después
              </label>
              {!groupDraft.allDoors ? zones.entries.map(([zone, list]) => (
                <div key={zone}>
                  {zones.anyZone ? <p className="access-zone">{zone}</p> : null}
                  {list.map((door) => (
                    <label key={door.id} className="access-check">
                      <input
                        type="checkbox"
                        checked={groupDraft.doors.includes(door.id)}
                        onChange={() => setGroupDraft((p) => ({
                          ...p,
                          doors: p.doors.includes(door.id) ? p.doors.filter((id) => id !== door.id) : [...p.doors, door.id]
                        }))}
                      />
                      {door.name}
                    </label>
                  ))}
                </div>
              )) : null}
              <div className="access-actions">
                {groupEdit !== 'new' ? (
                  <button type="button" className="btn btn-secondary" onClick={() => deleteGroup(groups.find((g) => g.id === groupEdit) || { id: groupEdit, name: groupDraft.name, memberCount: 0 })}>
                    Borrar
                  </button>
                ) : null}
                <button type="button" className="btn btn-secondary" onClick={() => setGroupEdit(null)}>Cancelar</button>
                <button type="submit" className="btn btn-primary">Guardar grupo</button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}

      {!loading && !error && tab === 'simular' ? (
        <form onSubmit={simulate}>
          <div className="access-times">
            <label>
              Persona
              <input className="input-field" aria-label="Buscar persona" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nombre o DNI" />
            </label>
            <button type="button" className="btn btn-secondary" disabled={simBusy} onClick={searchPeople} style={{ alignSelf: 'end' }}>
              Buscar
            </button>
          </div>
          {person ? <p>Elegida: <strong>{person.name}</strong></p> : null}
          <div className="access-list" style={{ margin: '0.4rem 0' }}>
            {people.map((item) => (
              <button key={item.id} type="button" className={`access-card${person && person.id === item.id ? ' is-on' : ''}`} onClick={() => setPerson(item)}>
                {item.name} {item.idNumber ? `· ${item.idNumber}` : ''}
              </button>
            ))}
          </div>
          <label className="people-access-field">
            Puerta
            <select className="input-field" aria-label="Puerta" value={doorId} onChange={(e) => setDoorId(e.target.value)}>
              {doors.filter((d) => d.active !== false).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <label className="people-access-field">
            Fecha y hora (Argentina)
            <input className="input-field" aria-label="Fecha y hora" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required />
          </label>
          <button type="submit" className="btn btn-primary" disabled={simBusy}>Consultar</button>
          {simResult ? (
            <div className={`access-model__result${simResult.allows ? ' is-yes' : simResult.decision === 'needs_approval' ? ' is-wait' : ' is-no'}`} role="status" style={{ marginTop: '0.8rem' }}>
              <strong>{simResult.headline}</strong>
              <p style={{ margin: '0.35rem 0 0' }}>{simResult.message}</p>
              {(simResult.warnings || []).map((w) => <p key={w.reason} style={{ margin: '0.35rem 0 0' }}>{w.message}</p>)}
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}

export default AccessModelAdminSection;
