import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { DoorOpen, RefreshCw, Search, Save } from 'lucide-react';
import DoorAccessEditor from '../../../components/DoorAccessEditor';
import PersonPhotoField from '../../../components/PersonPhotoField';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { apiFetch } from '../../../services/api';
import { hasPermission } from '../../../utils/permissions';
import { PageHeader, EmptyState, AdvancedSection } from '../../../components/admin-ui';
import {
  ACCESS_FILTER_OPTIONS,
  formatLastAccessLabel,
  matchesClientAccessFilter
} from '../../../utils/peopleLastAccess';

import BiostarSyncStatus from './BiostarSyncStatus';
import PeopleCleanupWizard from './PeopleCleanupWizard';
import PersonAccessPanel from './PersonAccessPanel';

const CATEGORY_FILTERS = [
  { id: 'todos', label: 'Todas las categorías' },
  { id: 'empleado', label: 'Empleados' },
  { id: 'tercero', label: 'Terceros' },
  { id: 'cliente', label: 'Clientes' },
  { id: 'sin_clasificar', label: 'Sin clasificar' }
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
  const [accessFilter, setAccessFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('todos');
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [merging, setMerging] = useState(false);
  const [fichaTab, setFichaTab] = useState('datos');
  const [passages, setPassages] = useState([]);
  const [passagesError, setPassagesError] = useState('');

  const canManage = hasPermission(currentUser, 'access.doors.manage')
    || hasPermission(currentUser, 'access.control')
    || hasPermission(currentUser, 'master.nomina.write');

  const peopleCacheKey = authToken ? `mss.peopleList.v1.${String(authToken).slice(-12)}` : null;

  const readPeopleCache = () => {
    if (!peopleCacheKey || typeof sessionStorage === 'undefined') return null;
    try {
      const raw = sessionStorage.getItem(peopleCacheKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.people) || parsed.version == null) return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const writePeopleCache = (payload) => {
    if (!peopleCacheKey || typeof sessionStorage === 'undefined') return;
    try {
      sessionStorage.setItem(peopleCacheKey, JSON.stringify({
        version: payload.version,
        people: payload.people || [],
        savedAt: Date.now()
      }));
    } catch {
      // sessionStorage lleno o bloqueado: el listado sigue funcionando sin caché.
    }
  };

  const loadPeople = useCallback(async ({ force = false } = {}) => {
    if (!authToken) return;
    setLoading(true);
    try {
      const cached = force ? null : readPeopleCache();
      const versionQs = cached?.version != null
        ? `?clientVersion=${encodeURIComponent(cached.version)}`
        : '';
      const [data, doorsData] = await Promise.all([
        apiFetch(`/admin/people${versionQs}`, { token: authToken, allowForbidden: true }),
        apiFetch('/admin/doors-config', { token: authToken, allowForbidden: true }).catch(() => ({}))
      ]);

      if (data?.unchanged && cached) {
        setPeople(cached.people);
      } else {
        const list = data.people || [];
        setPeople(list);
        if (data?.version != null) {
          writePeopleCache({ version: data.version, people: list });
        }
      }

      const doors = (doorsData.config?.doors || []).filter((d) => d.active !== false);
      setActiveDoorCount(doors.length);
    } catch (err) {
      showError(err.message || 'No se pudo cargar el personal');
    } finally {
      setLoading(false);
    }
  }, [authToken, showError]);

  useEffect(() => {
    loadPeople();
  }, [loadPeople]);

  const filtered = useMemo(() => {
    let list = people;
    if (categoryFilter !== 'todos') {
      list = list.filter((p) => (p.category || 'sin_clasificar') === categoryFilter);
    }
    list = list.filter((p) => matchesClientAccessFilter(p, accessFilter));
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
  }, [people, filter, categoryFilter, accessFilter]);

  const handleBackfillLastAccess = async () => {
    if (!authToken || backfilling) return;
    const ok = await confirm({
      title: 'Recalcular últimos accesos',
      message: 'Va a leer el historial de pases autorizados y completar “último acceso” en cada ficha. Puede tardar varios lotes si hay mucho historial.',
      confirmLabel: 'Recalcular',
      tone: 'default'
    });
    if (!ok) return;
    setBackfilling(true);
    try {
      let cursor = null;
      let totalUpdated = 0;
      let rounds = 0;
      do {
        const data = await apiFetch('/admin/people/backfill-last-access', {
          method: 'POST',
          token: authToken,
          body: { limit: 800, cursorMillis: cursor }
        });
        totalUpdated += Number(data.updated) || 0;
        cursor = data.nextCursorMillis ?? null;
        rounds += 1;
        if (data.done || !cursor || rounds >= 25) break;
      } while (true);
      showSuccess(`Últimos accesos recalculados (${totalUpdated} fichas tocadas).`);
      await loadPeople({ force: true });
    } catch (err) {
      showError(err.message || 'No se pudo recalcular');
    } finally {
      setBackfilling(false);
    }
  };

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
    setFichaTab('datos');
    setPassages([]);
    setPassagesError('');
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
      setPeople((prev) => {
        const next = prev.map((p) => (p.id === updated.id ? { ...p, ...updated } : p));
        // Invalidar versión de caché: el server ya bumpeó peopleVer.
        if (peopleCacheKey && typeof sessionStorage !== 'undefined') {
          try { sessionStorage.removeItem(peopleCacheKey); } catch { /* ignore */ }
        }
        return next;
      });
      syncDraftFromPerson(updated);
    } catch (err) {
      showError(err.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (fichaTab !== 'historial' || !selected?.id || !authToken) return undefined;
    let cancelled = false;
    setPassagesError('');
    apiFetch(`/admin/people/${encodeURIComponent(selected.id)}/passages`, {
      token: authToken,
      allowForbidden: true
    }).then((data) => {
      if (!cancelled) setPassages(Array.isArray(data.passages) ? data.passages : []);
    }).catch((err) => {
      if (!cancelled) setPassagesError(err.message || 'No se pudo cargar el historial');
    });
    return () => { cancelled = true; };
  }, [fichaTab, selected, authToken]);

  const clearCredential = async (field, label) => {
    const ok = await confirm({
      title: `Dar de baja ${label}`,
      message: `¿Dar de baja ${label} de “${draft.name || 'esta persona'}”? Después hay que guardar la ficha.`,
      confirmLabel: 'Dar de baja',
      tone: 'danger'
    });
    if (!ok) return;
    updateDraftField(field, '');
  };

  const runRepair = async (path, body, confirmMsg) => {
    if (!window.confirm(confirmMsg)) return;
    setMerging(true);
    try {
      const data = await apiFetch(path, { method: 'POST', token: authToken, body });
      showSuccess(data.message || 'Listo');
      await loadPeople({ force: true });
    } catch (err) {
      showError(err.message || 'No se pudo aplicar la corrección');
    } finally {
      setMerging(false);
    }
  };

  if (!canManage) {
    return <p className="text-sm text-gray-500">No tenés permiso para gestionar Personas.</p>;
  }

  return (
    <div className="people-access-admin admin-simple">
      <div className="admin-sub-section">
        <PageHeader
          title="Personas"
          purpose="La ficha de cada persona: sus datos, cómo entra y por dónde puede pasar."
          howTo={[
            'Buscá por nombre, DNI o legajo.',
            'Abrí la ficha y revisá Datos, Credenciales, Accesos o el historial.',
            'Guardá si cambiaste algo.'
          ]}
        />

        <div className="admin-simple-search">
          <Search size={18} />
          <input
            className="input-field"
            placeholder="Buscar por nombre, legajo o DNI"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Buscar persona"
          />
        </div>

        <div className="people-access-layout">
            <div className="people-access-list">
              <div className="people-access-filters">
                <label className="historial-meta people-access-filter-label">
                  Categoría
                  <select
                    className="input-field"
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                    aria-label="Filtrar por categoría"
                  >
                    {CATEGORY_FILTERS.map((opt) => (
                      <option key={opt.id} value={opt.id}>{opt.label}</option>
                    ))}
                  </select>
                </label>
                <label className="historial-meta people-access-filter-label">
                  Último acceso
                  <select
                    className="input-field"
                    value={accessFilter}
                    onChange={(e) => setAccessFilter(e.target.value)}
                    aria-label="Filtrar por último acceso"
                  >
                    {ACCESS_FILTER_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn btn-secondary-small"
                  onClick={handleBackfillLastAccess}
                  disabled={backfilling}
                  title="Completa último acceso desde el historial de pases"
                >
                  {backfilling ? <RefreshCw size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  {backfilling ? ' Recalculando…' : ' Recalcular últimos accesos'}
                </button>
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
                        <th className="px-3 py-2 text-left text-xs uppercase">Último acceso</th>
                        <th className="px-3 py-2 text-left text-xs uppercase">Puertas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-3 py-4 text-gray-500">
                            No hay personas con estos filtros.
                          </td>
                        </tr>
                      ) : (
                        filtered.map((p) => {
                          const badge = accessLabel(p.allowedDoorIds, activeDoorCount);
                          const last = formatLastAccessLabel(p);
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
                                <span
                                  className={`people-access-last people-access-last--${last.kind}`}
                                  title={last.title}
                                >
                                  {last.text}
                                </span>
                              </td>
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
                    <h4>{selected.name || 'Ficha de persona'}</h4>
                    <p className="historial-meta">
                      {selected.company ? selected.company : 'Sin empresa'}
                    </p>
                  </div>
                  <div className="admin-simple-tabs" role="tablist" aria-label="Ficha de persona">
                    {[
                      ['datos', 'Datos'],
                      ['credenciales', 'Credenciales'],
                      ['accesos', 'Accesos'],
                      ['historial', 'Historial de pasos']
                    ].map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={fichaTab === id}
                        className={fichaTab === id ? 'is-active' : ''}
                        onClick={() => setFichaTab(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {fichaTab === 'datos' ? (
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
                          inputMode="numeric"
                          autoComplete="off"
                          pattern="[0-9]*"
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
                  </div>
                  ) : null}

                  {fichaTab === 'credenciales' ? (
                    <div className="people-access-credentials">
                      <label className="people-access-field">
                        <span>DNI</span>
                        <input
                          className="input-field"
                          aria-label="DNI"
                          value={draft.idNumber}
                          onChange={(e) => updateDraftField('idNumber', e.target.value)}
                          disabled={saving}
                          inputMode="numeric"
                        />
                      </label>
                      <label className="people-access-field">
                        <span>Tarjeta</span>
                        <input
                          className="input-field"
                          aria-label="Tarjeta"
                          value={draft.accessCard}
                          onChange={(e) => updateDraftField('accessCard', e.target.value)}
                          disabled={saving}
                        />
                        {draft.accessCard ? (
                          <button type="button" className="btn btn-secondary" onClick={() => clearCredential('accessCard', 'la tarjeta')}>
                            Dar de baja la tarjeta
                          </button>
                        ) : <p className="historial-meta">Sin tarjeta</p>}
                      </label>
                      <p className="historial-meta">QR: se usa cuando entra como visita. No hace falta cargarlo acá.</p>
                      <div className="people-access-field">
                        <span>Huella BioStar</span>
                        <p>{draft.biometricExternalId ? 'Cargada' : 'Sin huella'}</p>
                      </div>
                      {draft.biometricExternalId ? (
                        <button type="button" className="btn btn-secondary" onClick={() => clearCredential('biometricExternalId', 'la huella')}>
                          Dar de baja la huella
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  {fichaTab === 'accesos' ? (
                    <>
                      <h4 className="people-access-doors-title">Por dónde puede pasar</h4>
                      {hasPermission(currentUser, 'personas.puertas.asignar') ? (
                        <PersonAccessPanel
                          key={selected.id}
                          personId={selected.id}
                          authToken={authToken}
                        />
                      ) : null}
                      <DoorAccessEditor
                        authToken={authToken}
                        allowedDoorIds={draft.allowedDoorIds}
                        onChange={(doors) => updateDraftField('allowedDoorIds', doors)}
                        disabled={saving}
                        highlight
                      />
                    </>
                  ) : null}

                  {fichaTab === 'historial' ? (
                    <div>
                      {passagesError ? <p>{passagesError}</p> : null}
                      {passages.length === 0 ? (
                        <EmptyState
                          title="Todavía no hay pasos"
                          text="Acá van a aparecer los últimos pasos de esta persona."
                        />
                      ) : (
                        <ul>
                          {passages.map((step) => (
                            <li key={step.id}>
                              {step.whenLabel || step.when || '—'} · {step.movement || 'Paso'}
                              {step.place ? ` · ${step.place}` : ''}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}

                  {fichaTab !== 'historial' ? (
                  <button
                    type="button"
                    className="btn btn-primary mt-3"
                    disabled={saving}
                    onClick={handleSave}
                  >
                    <Save size={16} />
                    {saving ? 'Guardando…' : 'Guardar persona'}
                  </button>
                  ) : null}
                </>
              )}
            </div>
          </div>

        <AdvancedSection title="Opciones avanzadas">
          <BiostarSyncStatus authToken={authToken} />
          <PeopleCleanupWizard
            authToken={authToken}
            onDone={() => loadPeople({ force: true })}
            onError={showError}
            onSuccess={showSuccess}
            confirm={confirm}
            onOpenDirectory={({ accessFilter: nextAccess, category } = {}) => {
              if (nextAccess) setAccessFilter(nextAccess);
              if (category) setCategoryFilter(category);
            }}
            onBackfillLastAccess={handleBackfillLastAccess}
            backfilling={backfilling}
            onBulkRepair={runRepair}
            bulkBusy={merging}
          />
          <button type="button" className="btn btn-secondary" onClick={handleBackfillLastAccess} disabled={backfilling}>
            {backfilling ? 'Recalculando…' : 'Recalcular últimos accesos'}
          </button>
        </AdvancedSection>
      </div>
    </div>
  );
}

export default PeopleAccessAdminSection;
