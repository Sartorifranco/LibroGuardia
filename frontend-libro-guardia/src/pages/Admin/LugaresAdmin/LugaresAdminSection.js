import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState, PageHeader } from '../../../components/admin-ui';
import { apiFetch } from '../../../services/api';
import { useAuth } from '../../../context/AuthContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { useToast } from '../../../context/ToastContext';

const SUGGESTED = ['Planta', 'Oficinas', 'Tesorería'];

function LugaresAdminSection() {
  const { authToken } = useAuth();
  const { confirm } = useConfirm();
  const { showSuccess, showError } = useToast();
  const [areas, setAreas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [draftName, setDraftName] = useState('');
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch('/admin/areas', { token: authToken });
      setAreas(data.areas || []);
    } catch (err) {
      setError(err.message || 'No se pudieron leer los lugares.');
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => { load(); }, [load]);

  const custom = areas.filter((area) => !area.fixed);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = areas.filter((area) => !area.fixed);
    if (!q) return list;
    return list.filter((area) => area.name.toLowerCase().includes(q));
  }, [areas, query]);

  const create = async (name) => {
    const clean = String(name || '').trim();
    if (clean.length < 2) {
      showError('Escribí un nombre de al menos 2 letras. Por ejemplo, Oficinas.');
      return;
    }
    setBusy(true);
    try {
      await apiFetch('/admin/areas', { method: 'POST', token: authToken, body: { name: clean } });
      setDraftName('');
      showSuccess(`Lugar “${clean}” creado.`);
      await load();
    } catch (err) {
      showError(err.message || 'No se pudo crear el lugar.');
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await apiFetch(`/admin/areas/${editing.id}`, {
        method: 'PUT',
        token: authToken,
        body: { name: editing.name }
      });
      setEditing(null);
      showSuccess('Lugar actualizado.');
      await load();
    } catch (err) {
      showError(err.message || 'No se pudo guardar.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (area) => {
    const ok = await confirm({
      title: 'Borrar lugar',
      message: `¿Borrar “${area.name}”? Si una puerta lo usa, primero cambiala.`,
      confirmLabel: 'Borrar',
      tone: 'danger'
    });
    if (!ok) return;
    setBusy(true);
    try {
      await apiFetch(`/admin/areas/${area.id}`, { method: 'DELETE', token: authToken });
      showSuccess('Lugar borrado.');
      await load();
    } catch (err) {
      showError(err.message || 'No se pudo borrar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Lugares"
        purpose="Un lugar es una zona del predio. Cada puerta conecta dos lugares."
        howTo={[
          'El exterior ya está: es el afuera.',
          'Agregá las zonas de adentro, como Planta u Oficinas.',
          'Después, en Puertas, elegís qué lugares conecta cada una.'
        ]}
        action={custom.length > 0 ? (
          <button type="button" className="btn btn-primary" onClick={() => create(draftName)} disabled={busy}>
            Crear lugar
          </button>
        ) : null}
      />

      {loading ? <p role="status">Cargando lugares…</p> : null}
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn-secondary" onClick={load}>Reintentar</button>
        </div>
      ) : null}

      {!loading && !error && custom.length === 0 ? (
        <EmptyState
          title="Todavía no cargaste lugares."
          text="Un lugar es una zona del predio, como Oficinas o Tesorería. El exterior ya está."
          actionLabel="Crear el primero"
          onAction={() => create('Planta')}
        />
      ) : null}

      {!loading && !error ? (
        <>
          <div className="aui-toolbar">
            <input
              className="input-field"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder="Nombre del lugar"
              aria-label="Nombre del lugar"
            />
            {query || custom.length > 0 ? (
              <input
                className="input-field"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar"
                aria-label="Buscar lugares"
              />
            ) : null}
          </div>
          {custom.length === 0 ? (
            <div className="aui-toolbar">
              {SUGGESTED.map((name) => (
                <button key={name} type="button" className="btn btn-secondary" disabled={busy} onClick={() => create(name)}>
                  {name}
                </button>
              ))}
            </div>
          ) : null}
          <article className="aui-card" style={{ marginBottom: '0.75rem' }}>
            <h4 className="aui-card__title">Exterior</h4>
            <p className="aui-card__meta">Siempre está. Es el afuera del predio y no se borra.</p>
          </article>
          <div className="aui-cards">
            {filtered.map((area) => (
              <article key={area.id} className="aui-card">
                {editing?.id === area.id ? (
                  <>
                    <input
                      className="input-field"
                      value={editing.name}
                      onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                      aria-label="Nuevo nombre"
                    />
                    <button type="button" className="btn btn-secondary" disabled={busy} onClick={saveEdit}>Guardar nombre</button>
                    <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>Cancelar</button>
                  </>
                ) : (
                  <>
                    <h4 className="aui-card__title">{area.name}</h4>
                    <button type="button" className="btn btn-secondary" onClick={() => setEditing({ id: area.id, name: area.name })}>Renombrar</button>
                    <button type="button" className="btn btn-danger-small" disabled={busy} onClick={() => remove(area)}>Borrar</button>
                  </>
                )}
              </article>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export default LugaresAdminSection;
