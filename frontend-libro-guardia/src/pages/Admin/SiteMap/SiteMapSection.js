import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, DoorOpen, Warehouse } from 'lucide-react';
import { PageContainer, PageHeader } from '../../../components/admin-ui';
import { apiFetch } from '../../../services/api';
import { useAuth } from '../../../context/AuthContext';
import { buildSiteMap, buildSiteTree } from './siteMapModel';
import './SiteMap.css';

const TARGET_LABEL = { puertas: 'Puertas', lugares: 'Lugares', estancos: 'Estancos' };
const KIND_LABEL = { door: 'Puerta', gate: 'Portón', turnstile: 'Molinete' };

const nestedOf = (place) => place.children.filter((child) => !child.repeat);

function branchIds(place, list = []) {
  const nested = nestedOf(place);
  if (nested.length) list.push(place.node.id);
  nested.forEach((child) => branchIds(child.place, list));
  return list;
}

function DoorRow({ child, onOpen }) {
  const { door, place, repeat } = child;
  const Icon = door.kind === 'gate' ? Warehouse : DoorOpen;
  return (
    <li className={`site-route__door${door.active ? '' : ' is-off'}`}>
      <Icon className="site-route__icon" size={18} aria-hidden="true" />
      <span className="site-route__door-main">
        <span className="site-route__door-line">
          <button
            type="button"
            className="site-route__link site-route__door-name"
            onClick={() => onOpen('puertas')}
            aria-label={`${KIND_LABEL[door.kind]} ${door.name}${door.active ? '' : ' (apagada)'}. Abrir Puertas`}
          >
            {door.name}
          </button>
          {door.active ? null : <span className="site-route__off">(apagada)</span>}
          <ArrowRight className="site-route__arrow" size={16} aria-hidden="true" />
          <button
            type="button"
            className="site-route__link"
            onClick={() => onOpen('lugares')}
            aria-label={`Lugar ${place.node.name}. Abrir Lugares`}
          >
            {place.node.name}
          </button>
        </span>
        {repeat ? <small className="site-route__repeat">Ese lugar ya figura más arriba</small> : null}
      </span>
    </li>
  );
}

function PlaceCard({ place, collapsed, onToggle, onOpen }) {
  const { node, children } = place;
  const nested = nestedOf(place);
  const expanded = !collapsed.has(node.id);
  const doorCount = node.airlockDoorIds?.length || 0;
  const classes = ['site-route__card'];
  if (node.airlock) classes.push('is-airlock');
  if (node.fixed) classes.push('is-exterior');
  if (!node.reachable) classes.push('is-alone');
  return (
    <li className="site-route__branch">
      <article className={classes.join(' ')} aria-label={`Lugar ${node.name}`}>
        <header className="site-route__head">
          <button
            type="button"
            className="site-route__link site-route__place"
            onClick={() => onOpen('lugares')}
            aria-label={`Lugar ${node.name}${node.airlock ? ' (estanco)' : ''}. Abrir Lugares`}
          >
            {node.name}
          </button>
          {node.airlock ? (
            <span className="site-route__tag">
              Estanco · {doorCount} {doorCount === 1 ? 'puerta' : 'puertas'} · se abre una por vez
            </span>
          ) : null}
          {nested.length ? (
            <button
              type="button"
              className="site-route__toggle"
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Contraer' : 'Expandir'} ${node.name}`}
              onClick={() => onToggle(node.id)}
            >
              {expanded ? <ChevronDown size={18} aria-hidden="true" /> : <ChevronRight size={18} aria-hidden="true" />}
              {expanded ? 'Contraer' : 'Expandir'}
            </button>
          ) : null}
        </header>
        {children.length ? (
          <ul className="site-route__doors">
            {children.map((child) => (
              <DoorRow key={child.door.id} child={child} onOpen={onOpen} />
            ))}
          </ul>
        ) : null}
      </article>
      {expanded && nested.length ? (
        <ul className="site-route__children">
          {nested.map((child) => (
            <PlaceCard key={child.place.node.id} place={child.place} collapsed={collapsed} onToggle={onToggle} onOpen={onOpen} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function SiteMapRoute({ model, onOpen }) {
  const tree = useMemo(() => buildSiteTree(model), [model]);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const allIds = useMemo(() => [tree.root, ...tree.unreachable].flatMap((place) => branchIds(place)), [tree]);
  const toggle = useCallback((id) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="site-route-view">
      <div className="site-route__tools">
        <button type="button" className="btn btn-secondary" onClick={() => setCollapsed(new Set())}>Expandir todo</button>
        <button type="button" className="btn btn-secondary" onClick={() => setCollapsed(new Set(allIds))} disabled={!allIds.length}>
          Contraer todo
        </button>
      </div>
      <ul className="site-route" aria-label="Recorrido del predio">
        <PlaceCard place={tree.root} collapsed={collapsed} onToggle={toggle} onOpen={onOpen} />
      </ul>
      {tree.unreachable.length ? (
        <section className="site-route__alone" aria-label="Lugares sin conexión con el Exterior">
          <h4 className="aui-section-title">Lugares sin conexión con el Exterior</h4>
          <ul className="site-route">
            {tree.unreachable.map((place) => (
              <PlaceCard key={place.node.id} place={place} collapsed={collapsed} onToggle={toggle} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function SiteMapSection({ onOpen }) {
  const { authToken } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState('');
  const [actionError, setActionError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [config, areas] = await Promise.all([
        apiFetch('/admin/doors-config', { token: authToken, allowForbidden: true }),
        apiFetch('/admin/areas', { token: authToken, allowForbidden: true })
      ]);
      setData({
        areas: areas?.areas || [],
        doors: config?.meta?.legacyFallback ? [] : (config?.config?.doors || []),
        airlockGroups: config?.config?.airlockGroups || []
      });
    } catch (err) {
      setError(err.message || 'No se pudo leer el predio.');
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => { load(); }, [load]);

  const acceptSingleSide = useCallback(async (doorId) => {
    setSavingId(doorId);
    setActionError('');
    try {
      const current = await apiFetch('/admin/doors-config', { token: authToken });
      const doors = current?.meta?.legacyFallback ? [] : (current?.config?.doors || []);
      if (!doors.some((door) => door.id === doorId)) throw new Error('No encontramos esa puerta. Recargá la página.');
      await apiFetch('/admin/doors-config', {
        method: 'PUT',
        token: authToken,
        body: {
          doors: doors.map((door) => (door.id === doorId ? { ...door, singleSideReaderOk: true } : door)),
          defaultDoorId: current?.config?.defaultDoorId
        }
      });
      await load();
    } catch (err) {
      setActionError(err.message || 'No se pudo guardar.');
    } finally {
      setSavingId('');
    }
  }, [authToken, load]);

  const model = useMemo(() => (data ? buildSiteMap(data) : null), [data]);
  const open = useCallback((section) => onOpen?.(section), [onOpen]);

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Mapa del predio"
        purpose="Muestra cómo se conectan los lugares y las puertas del predio, para ver si falta algo."
        howTo={[
          'Mirá la Revisión automática: ahí aparece lo que conviene corregir.',
          'Tocá Arreglar, un lugar o una puerta para ir a cambiarlo.',
          'Empieza en el Exterior. Cada tarjeta es un lugar y adentro están sus puertas; lo que se pasa después aparece más adentro.'
        ]}
      />

      {loading ? <p role="status">Cargando el mapa…</p> : null}
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn-secondary" onClick={load}>Reintentar</button>
        </div>
      ) : null}

      {!loading && !error && model ? (
        <>
          <section className={`site-map__review${model.problems.length ? ' has-problems' : ''}`} aria-label="Revisión automática">
            <h4 className="aui-section-title">Revisión automática</h4>
            {actionError ? <p role="alert">{actionError}</p> : null}
            {model.problems.length === 0 ? (
              <p>No encontramos problemas.</p>
            ) : (
              <ul className="site-map__problems">
                {model.problems.map((problem) => (
                  <li key={problem.id}>
                    <span>
                      {problem.message}
                      {problem.type === 'reader_one_side' ? (
                        <small className="site-map__hint">Por ejemplo, si se entra por esta puerta pero se sale por otra.</small>
                      ) : null}
                    </span>
                    <span className="site-map__actions">
                      {problem.type === 'reader_one_side' ? (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={Boolean(savingId)}
                          onClick={() => acceptSingleSide(problem.refId)}
                          aria-label={`Está bien así: ${problem.message}`}
                        >
                          {savingId === problem.refId ? 'Guardando…' : 'Está bien así'}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => open(problem.target)}
                        aria-label={`Arreglar en ${TARGET_LABEL[problem.target]}: ${problem.message}`}
                      >
                        Arreglar
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <SiteMapRoute model={model} onOpen={open} />
        </>
      ) : null}
    </PageContainer>
  );
}

export default SiteMapSection;
