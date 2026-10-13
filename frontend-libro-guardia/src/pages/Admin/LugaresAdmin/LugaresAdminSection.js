import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState, Modal, PageContainer, PageHeader } from '../../../components/admin-ui';
import { apiFetch } from '../../../services/api';
import { useAuth } from '../../../context/AuthContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { useToast } from '../../../context/ToastContext';

const SUGGESTED = ['Planta', 'Oficinas', 'Tesorería'];
const PLACE_HELP = 'Un lugar es una zona del predio separada por puertas (Planta, Oficinas, Tesorería). \'Exterior\' es todo lo que queda afuera del predio.';

function LugaresAdminSection() {
  const { authToken } = useAuth();
  const { confirm } = useConfirm();
  const { showSuccess, showError } = useToast();
  const [areas, setAreas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [form, setForm] = useState(null);
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

  const openCreate = (name = '') => {
    setForm({ mode: 'create', id: '', name, initial: name });
  };

  const openEdit = (area) => {
    setForm({ mode: 'edit', id: area.id, name: area.name, initial: area.name });
  };

  const save = async () => {
    if (!form) return;
    const clean = String(form.name || '').trim();
    if (clean.length < 2) {
      showError('Escribí un nombre de al menos 2 letras. Por ejemplo, Oficinas.');
      return;
    }
    setBusy(true);
    try {
      if (form.mode === 'edit') {
        await apiFetch(`/admin/areas/${form.id}`, {
          method: 'PUT',
          token: authToken,
          body: { name: clean }
        });
        showSuccess('Lugar actualizado.');
      } else {
        await apiFetch('/admin/areas', { method: 'POST', token: authToken, body: { name: clean } });
        showSuccess(`Lugar “${clean}” creado.`);
      }
      setForm(null);
      await load();
    } catch (err) {
      showError(err.message || 'No se pudo guardar el lugar.');
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
    <PageContainer width="medium">
      <PageHeader
        title="Lugares"
        purpose={PLACE_HELP}
        howTo={[
          'El exterior ya está: es todo lo que queda afuera del predio.',
          'Agregá las zonas de adentro, como Planta u Oficinas.',
          'Después, en Puertas, elegís desde dónde se llega y a dónde se entra.'
        ]}
        action={custom.length > 0 ? (
          <button type="button" className="btn btn-primary" onClick={() => openCreate('')}>
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
          text={PLACE_HELP}
          actionLabel="Crear el primero"
          onAction={() => openCreate('Planta')}
        />
      ) : null}

      {!loading && !error ? (
        <>
          {custom.length > 0 ? (
            <div className="aui-toolbar">
              <input
                className="input-field"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar"
                aria-label="Buscar lugares"
              />
            </div>
          ) : (
            <div className="aui-toolbar">
              {SUGGESTED.map((name) => (
                <button key={name} type="button" className="btn btn-secondary" disabled={busy} onClick={() => openCreate(name)}>
                  {name}
                </button>
              ))}
            </div>
          )}
          <div className="aui-card-grid">
            <article className="aui-card">
              <h4 className="aui-card__title">Exterior</h4>
              <p className="aui-card__meta">Siempre está. Es todo lo que queda afuera del predio y no se borra.</p>
            </article>
            {filtered.map((area) => (
              <article key={area.id} className="aui-card">
                <h4 className="aui-card__title">{area.name}</h4>
                <button type="button" className="btn btn-secondary" onClick={() => openEdit(area)}>Cambiar nombre</button>
                <button type="button" className="btn btn-danger-small" disabled={busy} onClick={() => remove(area)}>Borrar</button>
              </article>
            ))}
          </div>
        </>
      ) : null}

      <Modal
        open={Boolean(form)}
        size="sm"
        title={form?.mode === 'edit' ? 'Cambiar nombre del lugar' : 'Nuevo lugar'}
        description={PLACE_HELP}
        dirty={Boolean(form) && form.name !== form.initial}
        onClose={() => setForm(null)}
        footer={(
          <>
            <button type="button" className="btn btn-secondary" data-aui-cancel="true" onClick={() => setForm(null)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
              {form?.mode === 'edit' ? 'Guardar' : 'Crear lugar'}
            </button>
          </>
        )}
      >
        {form ? (
          <label className="aui-field">
            <span className="aui-field__label">Nombre del lugar</span>
            <input
              className="input-field"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Oficinas"
              aria-label="Nombre del lugar"
            />
          </label>
        ) : null}
      </Modal>
    </PageContainer>
  );
}

export default LugaresAdminSection;
