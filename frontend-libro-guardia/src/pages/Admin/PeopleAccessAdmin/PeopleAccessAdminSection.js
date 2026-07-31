import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, DoorOpen, Search, Save } from 'lucide-react';
import DoorAccessEditor from '../../../components/DoorAccessEditor';
import PersonPhotoField from '../../../components/PersonPhotoField';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { apiFetch } from '../../../services/api';
import { hasPermission } from '../../../utils/permissions';

import PeopleCleanupWizard from './PeopleCleanupWizard';

const CATEGORY_TABS = [
  { id: 'limpieza', label: 'Limpieza' },
  { id: 'todos', label: 'Todas' },
  { id: 'empleado', label: 'Empleados' },
  { id: 'tercero', label: 'Terceros' },
  { id: 'cliente', label: 'Clientes' },
  { id: 'sin_clasificar', label: 'Sin clasificar' },
  { id: 'alertas', label: 'Alertas' }
];

const accessLabel = (allowedDoorIds, activeDoorCount = 0) => {
  if (!Array.isArray(allowedDoorIds) || allowedDoorIds.length === 0) {
    return { text: 'Ninguna puerta', kind: 'none' };
  }
  const n = allowedDoorIds.length;
  if (activeDoorCount > 0 && n >= activeDoorCount) {
    return { text: 'Todas', kind: 'all' };
  }
  return {
    text: `${n} puerta${n === 1 ? '' : 's'}`,
    kind: 'restricted'
  };
};

const emptyDraft = () => ({
  name: '',
  legajo: '',
  idNumber: '',
  active: true,
  notas: '',
  photoDataUrl: '',
  accessCard: '',
  biometricExternalId: '',
  biometricBrand: '',
  category: 'sin_clasificar',
  allowedDoorIds: []
});

/**
 * Admin Personas: directorio único + alertas de duplicados/incompletos + puertas.
 */
function PeopleAccessAdminSection() {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const { confirm } = useConfirm();
  const [people, setPeople] = useState([]);
  const [activeDoorCount, setActiveDoorCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [hubTab, setHubTab] = useState('limpieza');
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [alerts, setAlerts] = useState(null);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [merging, setMerging] = useState(false);

  const canManage = hasPermission(currentUser, 'access.doors.manage')
    || hasPermission(currentUser, 'access.control')
    || hasPermission(currentUser, 'master.nomina.write');

  const loadPeople = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    try {
      const [data, doorsData] = await Promise.all([
        apiFetch('/admin/people', { token: authToken, allowForbidden: true }),
        apiFetch('/admin/doors-config', { token: authToken, allowForbidden: true }).catch(() => ({}))
      ]);
      setPeople(data.people || []);
      const doors = (doorsData.config?.doors || []).filter((d) => d.active !== false);
      setActiveDoorCount(doors.length);
    } catch (err) {
      showError(err.message || 'No se pudo cargar el personal');
    } finally {
      setLoading(false);
    }
  }, [authToken, showError]);

  const loadAlerts = useCallback(async () => {
    if (!authToken) return;
    setAlertsLoading(true);
    try {
      const data = await apiFetch('/admin/people/alerts', { token: authToken, allowForbidden: true });
      setAlerts(data);
    } catch (err) {
      showError(err.message || 'No se pudieron cargar alertas');
    } finally {
      setAlertsLoading(false);
    }
  }, [authToken, showError]);

  useEffect(() => {
    loadPeople();
  }, [loadPeople]);

  useEffect(() => {
    if (hubTab === 'alertas') loadAlerts();
  }, [hubTab, loadAlerts]);

  const filtered = useMemo(() => {
    let list = people;
    if (hubTab !== 'todos' && hubTab !== 'alertas' && hubTab !== 'limpieza') {
      list = list.filter((p) => (p.category || 'sin_clasificar') === hubTab);
    }
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    const digits = q.replace(/\D/g, '');
    return list.filter((p) =>
      (p.name || '').toLowerCase().includes(q)
      || String(p.legajo || '').toLowerCase().includes(q)
      || (digits && String(p.idNumber || '').includes(digits))
      || (digits && String(p.legajo || '').includes(digits))
      || String(p.biometricExternalId || '').toLowerCase().includes(q)
    );
  }, [people, filter, hubTab]);

  const selected = people.find((p) => p.id === selectedId) || null;

  const syncDraftFromPerson = useCallback((person) => {
    if (!person) {
      setDraft(emptyDraft());
      return;
    }
    setDraft({
      name: person.name || '',
      legajo: person.legajo || '',
      idNumber: person.idNumber || '',
      active: person.active !== false,
      notas: person.notas || '',
      photoDataUrl: person.photoDataUrl || '',
      accessCard: person.accessCard || '',
      biometricExternalId: person.biometricExternalId || '',
      biometricBrand: person.biometricBrand || '',
      category: person.category || 'sin_clasificar',
      allowedDoorIds: Array.isArray(person.allowedDoorIds) ? person.allowedDoorIds : []
    });
  }, []);

  useEffect(() => {
    syncDraftFromPerson(selected);
  }, [selected, syncDraftFromPerson]);

  const selectPerson = (person) => {
    setSelectedId(person.id);
    syncDraftFromPerson(person);
    if (hubTab === 'alertas') setHubTab(person.category || 'todos');
  };

  const updateDraftField = (field, value) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    if (!selected) return;
    const name = String(draft.name || '').trim();
    if (!name) {
      showError('El nombre no puede quedar vacío');
      return;
    }
    setSaving(true);
    try {
      const data = await apiFetch(`/admin/people/${encodeURIComponent(selected.id)}/allowed-doors`, {
        method: 'PUT',
        token: authToken,
        body: {
          name,
          legajo: String(draft.legajo || '').trim(),
          idNumber: String(draft.idNumber || '').trim(),
          active: draft.active !== false,
          notas: String(draft.notas || '').trim(),
          photoDataUrl: draft.photoDataUrl || null,
          accessCard: String(draft.accessCard || '').trim(),
          biometricExternalId: String(draft.biometricExternalId || '').trim(),
          biometricBrand: String(draft.biometricBrand || '').trim(),
          category: draft.category || 'sin_clasificar',
          allowedDoorIds: Array.isArray(draft.allowedDoorIds) ? draft.allowedDoorIds : []
        }
      });
      showSuccess(data.message || 'Persona actualizada');
      const updated = data.person;
      setPeople((prev) => prev.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)));
      syncDraftFromPerson(updated);
    } catch (err) {
      showError(err.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const handleMerge = async (keepId, mergeId) => {
    if (!keepId || !mergeId) return;
    if (!window.confirm('¿Unificar estas fichas? Se conserva la primera y se desactiva la segunda.')) {
      return;
    }
    setMerging(true);
    try {
      const data = await apiFetch('/admin/people/merge', {
        method: 'POST',
        token: authToken,
        body: { keepId, mergeId }
      });
      showSuccess(data.message || 'Personas unificadas');
      await loadPeople();
      await loadAlerts();
      if (data.person?.id) selectPerson(data.person);
    } catch (err) {
      showError(err.message || 'No se pudo unificar');
    } finally {
      setMerging(false);
    }
  };

  const runRepair = async (path, body, confirmMsg) => {
    if (!window.confirm(confirmMsg)) return;
    setMerging(true);
    try {
      const data = await apiFetch(path, { method: 'POST', token: authToken, body });
      showSuccess(data.message || 'Listo');
      await loadPeople();
      await loadAlerts();
    } catch (err) {
      showError(err.message || 'No se pudo aplicar la corrección');
    } finally {
      setMerging(false);
    }
  };

  if (!canManage) {
    return <p className="text-sm text-gray-500">No tenés permiso para gestionar Personas.</p>;
  }

  const alertCount = alerts?.counts
    ? (alerts.counts.duplicates || 0)
      + (alerts.counts.incomplete || 0)
      + (alerts.counts.biostarSuggestions || 0)
      + (alerts.counts.biostarDoorIssues || 0)
      + (alerts.counts.suspiciousDnis || 0)
    : null;

  return (
    <div className="people-access-admin">
      <div className="admin-sub-section">
        <p className="admin-block__desc" style={{ marginBottom: '1rem' }}>
          Directorio único de personas. Las <strong>puertas permitidas</strong> son una lista
          explícita (vacío = ninguna; no hay acceso global). Nómina y autorizaciones siguen
          editando lo propio de cada caso; la identidad vive acá.
        </p>

        <div className="people-hub-tabs" role="tablist" aria-label="Categorías de personas">
          {CATEGORY_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={hubTab === tab.id}
              className={`people-hub-tab${hubTab === tab.id ? ' is-active' : ''}`}
              onClick={() => setHubTab(tab.id)}
            >
              {tab.label}
              {tab.id === 'alertas' && alertCount != null ? ` (${alertCount})` : ''}
            </button>
          ))}
        </div>

        {hubTab === 'limpieza' ? (
          <PeopleCleanupWizard
            authToken={authToken}
            onDone={loadPeople}
            onError={showError}
            onSuccess={showSuccess}
            confirm={confirm}
          />
        ) : hubTab === 'alertas' ? (
          <div className="people-hub-alerts">
            {alertsLoading || !alerts ? (
              <div className="admin-empty admin-empty--loading" role="status">
                <span>Analizando duplicados e incompletos…</span>
              </div>
            ) : (
              <>
                <div className="people-hub-alert-card people-hub-alert-card--actions">
                  <h5>Acciones rápidas</h5>
                  <p className="historial-meta">
                    Para aceptar sugerencia por sugerencia usá la pestaña <strong>Limpieza</strong>.
                    Acá quedan atajos masivos solo si ya revisaste el listado.
                  </p>
                  <div className="people-hub-alert-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={merging || !(alerts.counts?.biostarDoorIssues > 0)}
                      onClick={() => runRepair(
                        '/admin/people/repair-biostar-doors',
                        { mode: 'single', doorId: alerts.defaultDoorId || undefined },
                        `¿Dejar a los huérfanos BioStar (sin DNI/legajo) SOLO con la puerta ${alerts.defaultDoorId || 'por defecto'}?\n\nPersonal de limpieza u otros solo en huella dejarán de figurar en todas las puertas.`
                      )}
                    >
                      BioStar sin nómina → 1 sola puerta
                      {alerts.counts?.biostarDoorIssues ? ` (${alerts.counts.biostarDoorIssues})` : ''}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={merging || !(alerts.counts?.allDoorsPeople > 0)}
                      onClick={() => runRepair(
                        '/admin/people/repair-all-doors',
                        { mode: 'biostar_default_others_clear' },
                        `¿Corregir a TODOS los que tienen las ${alerts.activeDoorCount || 2} puertas?\n\n• BioStar sin nómina → 1 puerta\n• Resto → sin puertas (hay que asignarlas a propósito)\n\nEsto revierte la migración vieja que puso “todas” a todos.`
                      )}
                    >
                      Quitar “todas las puertas”
                      {alerts.counts?.allDoorsPeople ? ` (${alerts.counts.allDoorsPeople})` : ''}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={merging || !(alerts.counts?.suspiciousDnis > 0)}
                      onClick={() => runRepair(
                        '/admin/people/clear-suspicious-dnis',
                        {},
                        '¿Limpiar DNI que parecen fechas o están compartidos por 3+ personas?\nNo borra las fichas: deja el DNI vacío para corregirlo.'
                      )}
                    >
                      Limpiar DNI basura / compartidos
                      {alerts.counts?.suspiciousDnis ? ` (${alerts.counts.suspiciousDnis})` : ''}
                    </button>
                  </div>
                </div>

                <p className="historial-meta">
                  {alerts.counts.duplicates} grupos duplicados · {alerts.counts.suspiciousDnis || 0} DNI sospechosos ·{' '}
                  {alerts.counts.incomplete} incompletos · {alerts.counts.biostarSuggestions} sugerencias BioStar ·{' '}
                  {alerts.counts.biostarDoorIssues || 0} BioStar con demasiadas puertas
                </p>

                <section>
                  <h4>DNI sospechosos o compartidos</h4>
                  <p className="historial-meta">
                    Muchos “mismo DNI” vienen de cargas malas (ej. fecha <code>20260716</code> usada como documento).
                    No son personas distintas con el mismo DNI real.
                  </p>
                  {(alerts.suspiciousDnis || []).length === 0 ? (
                    <p className="historial-meta">No hay DNI marcados como sospechosos.</p>
                  ) : (
                    (alerts.suspiciousDnis || []).map((group) => (
                      <div key={`susp-${group.key}`} className="people-hub-alert-card">
                        <h5>
                          <AlertTriangle size={14} aria-hidden /> {group.message || group.key}
                        </h5>
                        <ul>
                          {(group.people || []).map((p) => (
                            <li key={p.id}>
                              <button type="button" className="btn btn-secondary-small" onClick={() => selectPerson(p)}>
                                {p.name || '—'} · DNI {p.idNumber || '—'}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))
                  )}
                </section>

                <section>
                  <h4>Unir BioStar ↔ empleado (recomendado)</h4>
                  <p className="historial-meta">
                    Ej.: “Franco S” (huella) con “SARTORI Franco” (nómina). Conservá la ficha con DNI/legajo.
                  </p>
                  {(alerts.biostarSuggestions || []).length === 0 ? (
                    <p className="historial-meta">Sin sugerencias fuertes por nombre.</p>
                  ) : (
                    (alerts.biostarSuggestions || []).map((s) => (
                      <div key={`${s.orphan.id}-${s.candidate.id}`} className="people-hub-alert-card">
                        <h5>Coincidencia {Math.round((s.score || 0) * 100)}%</h5>
                        <p>{s.message || `${s.orphan.name} → ${s.candidate.name}`}</p>
                        <div className="people-hub-alert-actions">
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={merging}
                            onClick={() => handleMerge(s.candidate.id, s.orphan.id)}
                          >
                            Unir en empleado (con DNI)
                          </button>
                          <button type="button" className="btn btn-secondary-small" onClick={() => selectPerson(s.orphan)}>
                            Ver BioStar
                          </button>
                          <button type="button" className="btn btn-secondary-small" onClick={() => selectPerson(s.candidate)}>
                            Ver empleado
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </section>

                <section>
                  <h4>Otros duplicados</h4>
                  {(alerts.duplicates || []).filter((g) => !(g.suspicious || g.looksLikeDate)).length === 0 ? (
                    <p className="historial-meta">No hay otros grupos.</p>
                  ) : (
                    (alerts.duplicates || []).filter((g) => !(g.suspicious || g.looksLikeDate)).map((group) => (
                      <div key={`${group.reason}-${group.key}`} className="people-hub-alert-card">
                        <h5>
                          <AlertTriangle size={14} aria-hidden />{' '}
                          {group.message
                            || (group.reason === 'dni' ? 'Mismo DNI' : group.reason === 'biometric' ? 'Mismo ID biométrico' : 'Mismo nombre sin DNI')}
                          {group.strength === 'weak' ? ' (revisar: puede ser falso positivo)' : ''}
                        </h5>
                        <ul>
                          {(group.people || []).map((p) => (
                            <li key={p.id}>
                              <button type="button" className="btn btn-secondary-small" onClick={() => selectPerson(p)}>
                                {p.name || '—'} · DNI {p.idNumber || '—'} · bio {p.biometricExternalId || '—'}
                              </button>
                            </li>
                          ))}
                        </ul>
                        {(group.people || []).length >= 2 && group.strength === 'high' ? (
                          <div className="people-hub-alert-actions">
                            <button
                              type="button"
                              className="btn btn-primary"
                              disabled={merging}
                              onClick={() => handleMerge(group.people[0].id, group.people[1].id)}
                            >
                              Unificar (conservar 1.ª)
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ))
                  )}
                </section>

                <section>
                  <h4>Datos incompletos</h4>
                  {(alerts.incomplete || []).slice(0, 40).map((p) => (
                    <div key={p.id} className="people-hub-alert-card">
                      <button type="button" className="btn btn-secondary-small" onClick={() => selectPerson(p)}>
                        {p.name || '—'} · {(p.issues || []).join(', ')}
                      </button>
                    </div>
                  ))}
                </section>
              </>
            )}
          </div>
        ) : (
          <div className="people-access-layout">
            <div className="people-access-list">
              <div className="people-access-search">
                <Search size={16} />
                <input
                  className="input-field"
                  placeholder="Buscar por nombre, legajo, DNI o ID biométrico…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  aria-label="Buscar persona"
                />
              </div>
              {loading ? (
                <div className="admin-empty admin-empty--loading" role="status">
                  <span>Cargando personas…</span>
                </div>
              ) : (
                <div className="scroll-panel-max overflow-x-auto border border-gray-200 rounded-md">
                  <table className="min-w-full text-sm people-access-table">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs uppercase">Nombre</th>
                        <th className="px-3 py-2 text-left text-xs uppercase">Legajo</th>
                        <th className="px-3 py-2 text-left text-xs uppercase">DNI</th>
                        <th className="px-3 py-2 text-left text-xs uppercase">Puertas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-3 py-4 text-gray-500">
                            No hay personas en esta categoría.
                          </td>
                        </tr>
                      ) : (
                        filtered.map((p) => {
                          const badge = accessLabel(p.allowedDoorIds, activeDoorCount);
                          return (
                            <tr
                              key={p.id}
                              className={`border-t people-access-row${selectedId === p.id ? ' is-selected' : ''}${p.active === false ? ' is-inactive' : ''}`}
                              onClick={() => selectPerson(p)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  selectPerson(p);
                                }
                              }}
                              tabIndex={0}
                              role="button"
                            >
                              <td className="px-3 py-2 font-medium">
                                {p.name || '—'}
                                {p.active === false ? (
                                  <span className="people-access-inactive-tag"> Inactiva</span>
                                ) : null}
                                {p.source === 'biostar' ? (
                                  <span className="people-access-inactive-tag"> BioStar</span>
                                ) : null}
                              </td>
                              <td className="px-3 py-2">{p.legajo || '—'}</td>
                              <td className="px-3 py-2">{p.idNumber || '—'}</td>
                              <td className="px-3 py-2">
                                <span className={`people-access-badge people-access-badge--${badge.kind}`}>
                                  {badge.text}
                                </span>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="historial-meta" style={{ marginTop: '0.5rem' }}>
                {filtered.length} de {people.length} personas · clic en una fila para editar
              </p>
            </div>

            <div className="people-access-ficha">
              {!selected ? (
                <div className="people-access-ficha-empty">
                  <DoorOpen size={28} />
                  <p>Elegí una persona para editar identidad, credenciales y <strong>puertas permitidas</strong>.</p>
                </div>
              ) : (
                <>
                  <div className="people-access-ficha-header">
                    <h4>Ficha de persona</h4>
                    <p className="historial-meta">
                      {selected.company ? selected.company : 'Sin empresa'} · id {selected.id}
                      {selected.biometricExternalId ? ` · bio ${selected.biometricExternalId}` : ''}
                    </p>
                  </div>

                  <div className="people-access-basic-form">
                    <label className="people-access-field">
                      <span>Nombre</span>
                      <input
                        className="input-field"
                        value={draft.name}
                        onChange={(e) => updateDraftField('name', e.target.value)}
                        disabled={saving}
                        required
                      />
                    </label>
                    <div className="people-access-field-row">
                      <label className="people-access-field">
                        <span>Legajo</span>
                        <input
                          className="input-field"
                          value={draft.legajo}
                          onChange={(e) => updateDraftField('legajo', e.target.value)}
                          disabled={saving}
                        />
                      </label>
                      <label className="people-access-field">
                        <span>DNI</span>
                        <input
                          className="input-field"
                          value={draft.idNumber}
                          onChange={(e) => updateDraftField('idNumber', e.target.value)}
                          disabled={saving}
                        />
                      </label>
                    </div>
                    <label className="people-access-field">
                      <span>Categoría</span>
                      <select
                        className="input-field"
                        value={draft.category}
                        onChange={(e) => updateDraftField('category', e.target.value)}
                        disabled={saving}
                      >
                        <option value="empleado">Empleado</option>
                        <option value="tercero">Tercero</option>
                        <option value="cliente">Cliente</option>
                        <option value="sin_clasificar">Sin clasificar</option>
                      </select>
                    </label>
                    <label className="people-access-field people-access-field--checkbox">
                      <input
                        type="checkbox"
                        checked={draft.active !== false}
                        onChange={(e) => updateDraftField('active', e.target.checked)}
                        disabled={saving}
                      />
                      <span>Activa (puede ingresar si tiene puertas y autorización vigente)</span>
                    </label>
                    <label className="people-access-field">
                      <span>Notas</span>
                      <textarea
                        className="input-field"
                        rows={2}
                        maxLength={500}
                        value={draft.notas}
                        onChange={(e) => updateDraftField('notas', e.target.value)}
                        disabled={saving}
                        placeholder="Observaciones internas (opcional)"
                      />
                    </label>
                    <PersonPhotoField
                      value={draft.photoDataUrl || ''}
                      onChange={(next) => updateDraftField('photoDataUrl', next || '')}
                      disabled={saving}
                    />

                    <div className="people-access-credentials">
                      <h5>Identificación en lectores</h5>
                      <p className="historial-meta">
                        Tarjeta o ID biométrico (ej. user_id de BioStar / Suprema).
                      </p>
                      <label className="people-access-field">
                        <span>Número de tarjeta</span>
                        <input
                          className="input-field"
                          value={draft.accessCard}
                          onChange={(e) => updateDraftField('accessCard', e.target.value)}
                          disabled={saving}
                        />
                      </label>
                      <label className="people-access-field">
                        <span>ID en el lector biométrico</span>
                        <input
                          className="input-field"
                          value={draft.biometricExternalId}
                          onChange={(e) => updateDraftField('biometricExternalId', e.target.value)}
                          disabled={saving}
                          placeholder="user_id BioStar / equipo"
                        />
                      </label>
                      <label className="people-access-field">
                        <span>Marca del biométrico (opcional)</span>
                        <select
                          className="input-field"
                          value={draft.biometricBrand}
                          onChange={(e) => updateDraftField('biometricBrand', e.target.value)}
                          disabled={saving}
                        >
                          <option value="">Sin especificar</option>
                          <option value="zkteco">ZKTeco</option>
                          <option value="hikvision">Hikvision</option>
                          <option value="suprema">Suprema</option>
                          <option value="hid">HID</option>
                          <option value="other">Otra</option>
                        </select>
                      </label>
                    </div>
                  </div>

                  <h4 className="people-access-doors-title">Puertas permitidas</h4>
                  <DoorAccessEditor
                    authToken={authToken}
                    allowedDoorIds={draft.allowedDoorIds}
                    onChange={(doors) => updateDraftField('allowedDoorIds', doors)}
                    disabled={saving}
                    highlight
                  />
                  <button
                    type="button"
                    className="btn btn-primary mt-3"
                    disabled={saving}
                    onClick={handleSave}
                  >
                    <Save size={16} />
                    {saving ? 'Guardando…' : 'Guardar persona'}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default PeopleAccessAdminSection;
