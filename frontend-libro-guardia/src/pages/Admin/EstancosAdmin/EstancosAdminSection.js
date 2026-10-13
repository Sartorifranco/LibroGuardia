import React, { useCallback, useEffect, useState } from 'react';
import { EmptyState, HelpTip, Modal, PageContainer, PageHeader } from '../../../components/admin-ui';
import { apiFetch } from '../../../services/api';
import { useAuth } from '../../../context/AuthContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { useToast } from '../../../context/ToastContext';
import {
  buildAirlockGroup,
  syncAirlockFields,
  upsertAirlockGroup,
  validateAirlockGroup
} from './estancoForm';

const PURPOSE = 'Un estanco es un lugar chico entre puertas. Nunca se abren dos puertas del mismo estanco a la vez.';
const OUTER_HELP = 'La que se usa para entrar al estanco desde la calle o el lado de afuera.';

const snapshot = (draft) => JSON.stringify({
  id: draft.id, name: draft.name, doorIds: draft.doorIds, outerDoorId: draft.outerDoorId
});

function EstancosAdminSection() {
  const { authToken } = useAuth();
  const { confirm } = useConfirm();
  const { showSuccess, showError } = useToast();
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch('/admin/doors-config', { token: authToken });
      setConfig({
        doors: data.meta?.legacyFallback ? [] : (data.config?.doors || []),
        airlockGroups: data.config?.airlockGroups || [],
        defaultDoorId: data.config?.defaultDoorId || null
      });
    } catch (err) {
      setError(err.message || 'No se pudieron leer los estancos.');
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => { load(); }, [load]);

  const doors = config?.doors || [];
  const groups = config?.airlockGroups || [];
  const doorName = (id) => doors.find((door) => door.id === id)?.name || id;

  const persist = async (nextGroups) => {
    const body = { airlockGroups: nextGroups };
    if (doors.length) {
      body.doors = syncAirlockFields(doors, nextGroups);
      body.defaultDoorId = config.defaultDoorId;
    }
    const data = await apiFetch('/admin/doors-config', { method: 'PUT', token: authToken, body });
    setConfig((prev) => ({
      doors: data.config?.doors || prev.doors,
      airlockGroups: data.config?.airlockGroups || nextGroups,
      defaultDoorId: data.config?.defaultDoorId ?? prev.defaultDoorId
    }));
  };

  const openForm = (draft) => {
    setForm({ ...draft, initial: snapshot(draft) });
    setErrors({});
  };

  const openCreate = () => openForm({ id: '', name: '', doorIds: [], outerDoorId: '' });

  const openEdit = (group) => openForm({
    id: group.id,
    name: group.name || '',
    doorIds: [...(group.doorIds || [])],
    outerDoorId: group.outerDoorId || ''
  });

  const dirty = Boolean(form) && snapshot(form) !== form.initial;

  const patchForm = (patch) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const toggleDoor = (id, checked) => {
    const doorIds = checked
      ? [...form.doorIds, id]
      : form.doorIds.filter((item) => item !== id);
    const outerDoorId = doorIds.includes(form.outerDoorId) ? form.outerDoorId : '';
    patchForm({ doorIds, outerDoorId });
  };

  const save = async () => {
    if (!form) return;
    const found = validateAirlockGroup(form, groups);
    setErrors(found);
    if (Object.keys(found).length) return;
    const group = buildAirlockGroup(form, groups, doors);
    setBusy(true);
    try {
      await persist(upsertAirlockGroup(groups, group));
      showSuccess(`Estanco "${group.name}" guardado.`);
      setForm(null);
    } catch (err) {
      showError(err.message || 'No se pudo guardar el estanco.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (group) => {
    const ok = await confirm({
      title: 'Borrar estanco',
      message: `¿Borrar el estanco "${group.name || group.id}"? Las puertas siguen andando, pero ya no se controla que haya una sola abierta.`,
      confirmLabel: 'Borrar',
      tone: 'danger'
    });
    if (!ok) return;
    setBusy(true);
    try {
      await persist(groups.filter((item) => item.id !== group.id));
      showSuccess('Estanco borrado.');
      setForm(null);
    } catch (err) {
      showError(err.message || 'No se pudo borrar el estanco.');
    } finally {
      setBusy(false);
    }
  };

  const canCreate = doors.length >= 2;

  return (
    <PageContainer width="medium">
      <PageHeader
        title="Estancos"
        purpose={PURPOSE}
        howTo={[
          'Creá el estanco y ponéle el nombre que usa el personal.',
          'Marcá las puertas que lo forman: 2 o más.',
          'Elegí cuál es la puerta de afuera.'
        ]}
        action={canCreate && groups.length > 0 ? (
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            Crear estanco
          </button>
        ) : null}
      />

      {loading ? <p role="status">Cargando estancos…</p> : null}
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn-secondary" onClick={load}>Reintentar</button>
        </div>
      ) : null}

      {!loading && !error && groups.length === 0 ? (
        canCreate ? (
          <EmptyState
            title="Todavía no hay estancos."
            text="Si dos o más puertas encierran un lugar chico, armá un estanco para que nunca se abran juntas."
            actionLabel="Crear estanco"
            onAction={openCreate}
          />
        ) : (
          <EmptyState
            title="Primero cargá las puertas."
            text="Un estanco junta 2 puertas o más. Cargalas en Puertas y después volvé acá."
          />
        )
      ) : null}

      {!loading && !error && groups.length > 0 ? (
        <div className="aui-card-grid">
          {groups.map((group) => (
            <article key={group.id} className="aui-card">
              <h4 className="aui-card__title">{group.name || group.id}</h4>
              <p className="aui-card__meta">{(group.doorIds || []).length} puertas</p>
              <ul className="aui-plain-list" aria-label={`Puertas de ${group.name || group.id}`}>
                {(group.doorIds || []).map((id) => (
                  <li key={id}>
                    {doorName(id)}
                    {id === group.outerDoorId ? <strong> (la de afuera)</strong> : null}
                  </li>
                ))}
              </ul>
              {!group.outerDoorId ? (
                <p className="aui-status is-warn" role="status">Falta elegir la puerta de afuera</p>
              ) : null}
              {group.enabled === false ? <p className="aui-status is-warn">Apagado</p> : null}
              <button type="button" className="btn btn-secondary" onClick={() => openEdit(group)}>Editar</button>
              <button type="button" className="btn btn-danger-small" disabled={busy} onClick={() => remove(group)}>Borrar</button>
            </article>
          ))}
        </div>
      ) : null}

      <Modal
        open={Boolean(form)}
        title={form?.id ? 'Editar estanco' : 'Nuevo estanco'}
        description={PURPOSE}
        dirty={dirty}
        onClose={() => setForm(null)}
        footer={(
          <>
            <button type="button" className="btn btn-secondary" data-aui-cancel="true" onClick={() => setForm(null)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
              Guardar
            </button>
          </>
        )}
      >
        {form ? (
          <>
            <label className="aui-field">
              <span className="aui-field__label">Nombre del estanco</span>
              <input
                className="input-field"
                value={form.name}
                onChange={(event) => patchForm({ name: event.target.value })}
                placeholder="Estanco Guardia"
                aria-label="Nombre del estanco"
              />
              {errors.name ? <span className="aui-error" role="alert">{errors.name}</span> : null}
            </label>

            <fieldset className="aui-field">
              <legend className="aui-field__label">Puertas del estanco</legend>
              <p className="aui-card__meta">Marcá 2 o más. Una puerta puede estar en más de un estanco.</p>
              {doors.map((door) => (
                <label key={door.id} className="aui-check">
                  <input
                    type="checkbox"
                    checked={form.doorIds.includes(door.id)}
                    onChange={(event) => toggleDoor(door.id, event.target.checked)}
                  />
                  <span>{door.name || door.id}</span>
                </label>
              ))}
              {errors.doorIds ? <span className="aui-error" role="alert">{errors.doorIds}</span> : null}
            </fieldset>

            <label className="aui-field">
              <span className="aui-field__label">
                ¿Cuál es la puerta de afuera?
                <HelpTip text={OUTER_HELP} />
              </span>
              <select
                className="input-field"
                value={form.outerDoorId}
                onChange={(event) => patchForm({ outerDoorId: event.target.value })}
                aria-label="¿Cuál es la puerta de afuera?"
                disabled={form.doorIds.length === 0}
              >
                <option value="">{form.doorIds.length ? 'Elegir puerta' : 'Primero marcá las puertas'}</option>
                {doors.filter((door) => form.doorIds.includes(door.id)).map((door) => (
                  <option key={door.id} value={door.id}>{door.name || door.id}</option>
                ))}
              </select>
              <span className="aui-card__meta">{OUTER_HELP}</span>
              {errors.outerDoorId ? <span className="aui-error" role="alert">{errors.outerDoorId}</span> : null}
            </label>
          </>
        ) : null}
      </Modal>
    </PageContainer>
  );
}

export default EstancosAdminSection;
