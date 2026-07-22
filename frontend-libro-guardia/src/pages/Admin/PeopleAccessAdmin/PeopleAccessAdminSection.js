import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { DoorOpen, Search, Save } from 'lucide-react';
import DoorAccessEditor from '../../../components/DoorAccessEditor';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { apiFetch } from '../../../services/api';
import { hasPermission } from '../../../utils/permissions';

const accessLabel = (allowedDoorIds) => {
  if (!Array.isArray(allowedDoorIds) || allowedDoorIds.length === 0) {
    return { text: 'Todas las puertas', kind: 'all' };
  }
  const n = allowedDoorIds.length;
  return {
    text: `Acceso restringido (${n} puerta${n === 1 ? '' : 's'})`,
    kind: 'restricted'
  };
};

/**
 * Admin: listado de personas + ficha de Acceso a puertas.
 */
function PeopleAccessAdminSection() {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [draftDoors, setDraftDoors] = useState(null);
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
      || (digits && String(p.idNumber || '').includes(digits))
    );
  }, [people, filter]);

  const selected = people.find((p) => p.id === selectedId) || null;

  useEffect(() => {
    if (!selected) {
      setDraftDoors(null);
      return;
    }
    setDraftDoors(selected.allowedDoorIds ?? null);
  }, [selected]);

  const selectPerson = (person) => {
    setSelectedId(person.id);
    setDraftDoors(person.allowedDoorIds ?? null);
  };

  const handleSave = async () => {
    if (!selected) return;
    if (Array.isArray(draftDoors) && draftDoors.length === 0) {
      showError('En “Solo estas puertas” elegí al menos una, o marcá “Todas las puertas”.');
      return;
    }
    setSaving(true);
    try {
      const data = await apiFetch(`/admin/people/${encodeURIComponent(selected.id)}/allowed-doors`, {
        method: 'PUT',
        token: authToken,
        body: { allowedDoorIds: draftDoors }
      });
      showSuccess(data.message || 'Acceso a puertas guardado');
      const updated = data.person;
      setPeople((prev) => prev.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)));
      setDraftDoors(updated.allowedDoorIds ?? null);
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
          Definí si cada persona puede ingresar por <strong>todas las puertas</strong> o solo por un
          subconjunto. El egreso no se restringe. También podés asignar desde Admin → Puertas y acceso
          (panel por puerta).
        </p>

        <div className="people-access-layout">
          <div className="people-access-list">
            <div className="people-access-search">
              <Search size={16} />
              <input
                className="input-field"
                placeholder="Buscar por nombre o DNI…"
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
                      <th className="px-3 py-2 text-left text-xs uppercase">DNI</th>
                      <th className="px-3 py-2 text-left text-xs uppercase">Acceso a puertas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="px-3 py-4 text-gray-500">
                          No hay personas para mostrar. Importá nómina o registrá accesos primero.
                        </td>
                      </tr>
                    ) : (
                      filtered.map((p) => {
                        const badge = accessLabel(p.allowedDoorIds);
                        return (
                          <tr
                            key={p.id}
                            className={`border-t people-access-row${selectedId === p.id ? ' is-selected' : ''}`}
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
                            <td className="px-3 py-2 font-medium">{p.name || '—'}</td>
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
                <p>Elegí una persona en la tabla para configurar <strong>Acceso a puertas</strong>.</p>
              </div>
            ) : (
              <>
                <div className="people-access-ficha-header">
                  <h4>Acceso a puertas</h4>
                  <p className="people-access-ficha-name">{selected.name}</p>
                  <p className="historial-meta">
                    DNI {selected.idNumber || '—'}
                    {selected.company ? ` · ${selected.company}` : ''}
                  </p>
                </div>
                <DoorAccessEditor
                  authToken={authToken}
                  allowedDoorIds={draftDoors}
                  onChange={setDraftDoors}
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
                  {saving ? 'Guardando…' : 'Guardar acceso a puertas'}
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
