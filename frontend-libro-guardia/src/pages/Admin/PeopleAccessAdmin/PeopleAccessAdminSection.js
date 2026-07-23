import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { DoorOpen, Search, Save } from 'lucide-react';
import DoorAccessEditor from '../../../components/DoorAccessEditor';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { apiFetch } from '../../../services/api';
import { hasPermission } from '../../../utils/permissions';

const accessLabel = (allowedDoorIds) => {
  if (!Array.isArray(allowedDoorIds) || allowedDoorIds.length === 0) {
    return { text: 'Ninguna puerta', kind: 'none' };
  }
  const n = allowedDoorIds.length;
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
  allowedDoorIds: []
});

/**
 * Admin: listado de personas + ficha de datos básicos y Acceso a puertas.
 */
function PeopleAccessAdminSection() {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [saving, setSaving] = useState(false);

  const canManage = hasPermission(currentUser, 'access.doors.manage')
    || hasPermission(currentUser, 'access.control')
    || hasPermission(currentUser, 'master.nomina.write');

  const loadPeople = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    try {
      const data = await apiFetch('/admin/people', { token: authToken, allowForbidden: true });
      setPeople(data.people || []);
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
    const q = filter.trim().toLowerCase();
    if (!q) return people;
    const digits = q.replace(/\D/g, '');
    return people.filter((p) =>
      (p.name || '').toLowerCase().includes(q)
      || String(p.legajo || '').toLowerCase().includes(q)
      || (digits && String(p.idNumber || '').includes(digits))
      || (digits && String(p.legajo || '').includes(digits))
    );
  }, [people, filter]);

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
      allowedDoorIds: Array.isArray(person.allowedDoorIds) ? person.allowedDoorIds : []
    });
  }, []);

  useEffect(() => {
    syncDraftFromPerson(selected);
  }, [selected, syncDraftFromPerson]);

  const selectPerson = (person) => {
    setSelectedId(person.id);
    syncDraftFromPerson(person);
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

  if (!canManage) {
    return <p className="text-sm text-gray-500">No tenés permiso para gestionar acceso a puertas.</p>;
  }

  return (
    <div className="people-access-admin">
      <div className="admin-sub-section">
        <p className="admin-block__desc" style={{ marginBottom: '1rem' }}>
          Editá los datos básicos de cada persona y marcá <strong>explícitamente</strong> por qué
          puertas puede ingresar. Sin puertas marcadas = no ingresa por ninguna.
          Una persona inactiva no puede ingresar aunque tenga puertas asignadas.
        </p>

        <div className="people-access-layout">
          <div className="people-access-list">
            <div className="people-access-search">
              <Search size={16} />
              <input
                className="input-field"
                placeholder="Buscar por nombre, legajo o DNI…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="Buscar persona"
              />
            </div>
            {loading ? (
              <div className="admin-empty admin-empty--loading" role="status">
                <span>Cargando personal…</span>
              </div>
            ) : (
              <div className="scroll-panel-max overflow-x-auto border border-gray-200 rounded-md">
                <table className="min-w-full text-sm people-access-table">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs uppercase">Nombre</th>
                      <th className="px-3 py-2 text-left text-xs uppercase">Legajo</th>
                      <th className="px-3 py-2 text-left text-xs uppercase">DNI</th>
                      <th className="px-3 py-2 text-left text-xs uppercase">Acceso a puertas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-3 py-4 text-gray-500">
                          No hay personas para mostrar. Importá nómina o registrá accesos primero.
                        </td>
                      </tr>
                    ) : (
                      filtered.map((p) => {
                        const badge = accessLabel(p.allowedDoorIds);
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
                <p>Elegí una persona en la tabla para editar sus datos y el <strong>acceso a puertas</strong>.</p>
              </div>
            ) : (
              <>
                <div className="people-access-ficha-header">
                  <h4>Ficha de persona</h4>
                  <p className="historial-meta">
                    {selected.company ? selected.company : 'Sin empresa'} · id {selected.id}
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
                  <label className="people-access-field people-access-field--checkbox">
                    <input
                      type="checkbox"
                      checked={draft.active !== false}
                      onChange={(e) => updateDraftField('active', e.target.checked)}
                      disabled={saving}
                    />
                    <span>Activa (puede ingresar si tiene puertas y citación/autorización vigente)</span>
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
                </div>

                <h4 className="people-access-doors-title">Acceso a puertas</h4>
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
      </div>
    </div>
  );
}

export default PeopleAccessAdminSection;
