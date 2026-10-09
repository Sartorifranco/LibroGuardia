import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../services/api';
import { useToast } from '../../../context/ToastContext';
import { useConfirm } from '../../../context/ConfirmContext';
import '../AccessModelAdmin/access-model.css';

/**
 * Grupos y acceso total de una persona, más el resumen de por qué puede entrar.
 */
function PersonAccessPanel({ personId, authToken }) {
  const { showSuccess, showError } = useToast();
  const { confirm } = useConfirm();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selected, setSelected] = useState([]);
  const [accessAll, setAccessAll] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!authToken || !personId) return;
    setLoading(true);
    setError('');
    try {
      const [view, catalog] = await Promise.all([
        apiFetch(`/admin/people/${encodeURIComponent(personId)}/access`, { token: authToken }),
        apiFetch('/admin/access-groups', { token: authToken })
      ]);
      setSummary(Array.isArray(view.summary) ? view.summary : []);
      setSelected(Array.isArray(view.accessLevels) ? view.accessLevels : []);
      setAccessAll(view.accessAll === true);
      setGroups(catalog.groups || []);
    } catch (err) {
      setError(err.message || 'No se pudo cargar el acceso.');
    } finally {
      setLoading(false);
    }
  }, [authToken, personId]);

  useEffect(() => { load(); }, [load]);

  const save = async (body) => {
    setSaving(true);
    try {
      const data = await apiFetch(`/admin/people/${encodeURIComponent(personId)}/access`, {
        method: 'PUT',
        token: authToken,
        body
      });
      setSummary(Array.isArray(data.summary) ? data.summary : []);
      setSelected(Array.isArray(data.accessLevels) ? data.accessLevels : []);
      setAccessAll(data.accessAll === true);
      showSuccess(data.message || 'Accesos actualizados.');
      const catalog = await apiFetch('/admin/access-groups', { token: authToken });
      setGroups(catalog.groups || []);
    } catch (err) {
      showError(err.message || 'No se pudo guardar el acceso.');
    } finally {
      setSaving(false);
    }
  };

  const toggleGroup = (id) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleAll = async () => {
    if (saving) return;
    if (!accessAll) {
      const ok = await confirm({
        title: 'Acceso total',
        message: 'Esta persona va a poder entrar por todas las puertas, también las que se agreguen después.',
        confirmLabel: 'Dar acceso total',
        tone: 'danger'
      });
      if (!ok) return;
      await save({ accessAll: true });
      return;
    }
    const ok = await confirm({
      title: 'Quitar acceso total',
      message: 'Va a dejar de entrar por todas las puertas. Si tiene grupos, esos siguen vigentes.',
      confirmLabel: 'Quitar',
      tone: 'default'
    });
    if (!ok) return;
    await save({ accessAll: false });
  };

  return (
    <section className="person-access-panel" aria-label="Accesos">
      <h4 className="people-access-doors-title">Accesos</h4>
      <p className="historial-meta" style={{ marginTop: 0 }}>
        Los grupos juntan puertas y un horario. El acceso total abre todas, también las nuevas.
      </p>
      {loading ? <p role="status">Cargando accesos…</p> : null}
      {!loading && error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn-secondary" onClick={load}>Reintentar</button>
        </div>
      ) : null}
      {!loading && !error ? (
        <>
          <ul className="access-summary">
            {summary.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <button
            type="button"
            className={`access-switch${accessAll ? ' is-on' : ''}`}
            role="switch"
            aria-checked={accessAll}
            disabled={saving}
            onClick={toggleAll}
          >
            <span>Acceso total (todas las puertas)</span>
            <span className="access-switch__knob" aria-hidden />
          </button>
          {groups.length === 0 ? (
            <p className="historial-meta">Todavía no hay grupos. Creálos en Accesos.</p>
          ) : (
            <div>
              {groups.map((group) => (
                <label key={group.id} className="access-check">
                  <input
                    type="checkbox"
                    checked={selected.includes(group.id)}
                    disabled={saving}
                    onChange={() => toggleGroup(group.id)}
                  />
                  <span>{group.name}</span>
                </label>
              ))}
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving}
                onClick={() => save({ accessLevels: selected })}
              >
                {saving ? 'Guardando…' : 'Guardar grupos'}
              </button>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

export default PersonAccessPanel;
