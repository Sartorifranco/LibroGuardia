import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PageContainer, PageHeader } from '../../../components/admin-ui';
import { apiFetch } from '../../../services/api';
import { useAuth } from '../../../context/AuthContext';
import { BOX_H, BOX_W, buildSiteMap, buildSiteTree, layoutSiteMap } from './siteMapModel';
import './SiteMap.css';

const MOBILE_QUERY = '(max-width: 699px)';
const TARGET_LABEL = { puertas: 'Puertas', lugares: 'Lugares' };
const KIND_LABEL = { door: 'Puerta', gate: 'Portón', turnstile: 'Molinete' };

const short = (text, max = 22) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const readMobile = () => {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') return window.matchMedia(MOBILE_QUERY).matches;
  return window.innerWidth < 700;
};

function useIsMobile() {
  const [mobile, setMobile] = useState(readMobile);
  useEffect(() => {
    const onResize = () => setMobile(readMobile());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return mobile;
}

const onKeyActivate = (fn) => (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fn();
  }
};

function SiteMapDrawing({ model, onOpen }) {
  const layout = useMemo(() => layoutSiteMap(model), [model]);
  const unreachableLevel = model.hasUnreachable
    ? Math.max(...model.nodes.map((node) => node.level))
    : null;

  return (
    <div className="site-map__scroll">
      <svg
        className="site-map__svg"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label="Dibujo del predio"
      >
        {unreachableLevel != null ? (
          <text className="site-map__col-title" x={layout.columnX(unreachableLevel)} y={30}>
            Sin conexión con Exterior
          </text>
        ) : null}

        {layout.edges.map((edge) => (
          <path
            key={`line-${edge.id}`}
            d={edge.path}
            className={`site-map__line site-map__line--${edge.kind}${edge.active ? '' : ' is-off'}`}
          />
        ))}

        {model.nodes.map((node) => {
          const pos = layout.positions.get(node.id);
          const classes = ['site-map__place'];
          if (node.airlock) classes.push('is-airlock');
          if (node.fixed) classes.push('is-exterior');
          if (!node.reachable) classes.push('is-alone');
          const open = () => onOpen('lugares');
          return (
            <g
              key={`place-${node.id}`}
              className={classes.join(' ')}
              transform={`translate(${pos.x} ${pos.y})`}
              role="button"
              tabIndex={0}
              aria-label={`Lugar ${node.name}${node.airlock ? ' (estanco)' : ''}. Abrir Lugares`}
              onClick={open}
              onKeyDown={onKeyActivate(open)}
            >
              <title>{node.name}</title>
              <rect width={BOX_W} height={BOX_H} rx={10} />
              <text x={BOX_W / 2} y={node.airlock ? BOX_H / 2 - 4 : BOX_H / 2 + 5} textAnchor="middle" className="site-map__place-name">
                {short(node.name)}
              </text>
              {node.airlock ? (
                <text x={BOX_W / 2} y={BOX_H / 2 + 14} textAnchor="middle" className="site-map__place-tag">
                  Estanco
                </text>
              ) : null}
            </g>
          );
        })}

        {layout.edges.map((edge) => {
          const text = short(edge.name, 20);
          const w = text.length * 6.6 + 14;
          const open = () => onOpen('puertas');
          return (
            <g
              key={`label-${edge.id}`}
              className={`site-map__door${edge.active ? '' : ' is-off'}`}
              transform={`translate(${edge.label.x} ${edge.label.y})`}
              role="button"
              tabIndex={0}
              aria-label={`${KIND_LABEL[edge.kind]} ${edge.name}. Abrir Puertas`}
              onClick={open}
              onKeyDown={onKeyActivate(open)}
            >
              <title>{`${KIND_LABEL[edge.kind]}: ${edge.name}${edge.active ? '' : ' (apagada)'}`}</title>
              <rect x={-w / 2} y={-11} width={w} height={22} rx={11} />
              <text textAnchor="middle" y={4}>{text}</text>
            </g>
          );
        })}
      </svg>
      <ul className="site-map__legend" aria-label="Referencias">
        <li><span className="site-map__swatch" /> Lugar</li>
        <li><span className="site-map__swatch is-airlock" /> Estanco</li>
        <li><span className="site-map__stroke" /> Puerta o molinete</li>
        <li><span className="site-map__stroke is-gate" /> Portón</li>
        <li><span className="site-map__stroke is-off" /> Apagada</li>
      </ul>
    </div>
  );
}

function TreePlace({ place, onOpen, depth = 0 }) {
  const { node, children } = place;
  const label = (
    <button type="button" className="site-tree__place" onClick={() => onOpen('lugares')}>
      {node.name}
      {node.airlock ? <span className="site-tree__tag">Estanco</span> : null}
    </button>
  );
  if (!children.length) return <div className="site-tree__leaf">{label}</div>;
  return (
    <details className="site-tree__node" open={depth < 2}>
      <summary>{label}</summary>
      <ul className="site-tree__list">
        {children.map((child) => (
          <li key={`${node.id}-${child.door.id}`}>
            <button type="button" className="site-tree__door" onClick={() => onOpen('puertas')}>
              {KIND_LABEL[child.door.kind]}: {child.door.name}{child.door.active ? '' : ' (apagada)'}
            </button>
            {child.repeat ? (
              <p className="site-tree__repeat">Lleva a {child.place.node.name} (ya está en la lista).</p>
            ) : (
              <TreePlace place={child.place} onOpen={onOpen} depth={depth + 1} />
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function SiteMapTree({ model, onOpen }) {
  const tree = useMemo(() => buildSiteTree(model), [model]);
  return (
    <div className="site-tree">
      <TreePlace place={tree.root} onOpen={onOpen} />
      {tree.unreachable.length ? (
        <div className="site-tree__alone">
          <p className="aui-section-title">Sin conexión con Exterior</p>
          <ul className="site-tree__list">
            {tree.unreachable.map((node) => (
              <li key={node.id}>
                <button type="button" className="site-tree__place" onClick={() => onOpen('lugares')}>{node.name}</button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function SiteMapSection({ onOpen }) {
  const { authToken } = useAuth();
  const mobile = useIsMobile();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
          'El dibujo empieza en Exterior y avanza puerta por puerta hacia adentro.'
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
            {model.problems.length === 0 ? (
              <p>No encontramos problemas.</p>
            ) : (
              <ul className="site-map__problems">
                {model.problems.map((problem) => (
                  <li key={problem.id}>
                    <span>{problem.message}</span>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => open(problem.target)}
                      aria-label={`Arreglar en ${TARGET_LABEL[problem.target]}: ${problem.message}`}
                    >
                      Arreglar
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {mobile
            ? <SiteMapTree model={model} onOpen={open} />
            : <SiteMapDrawing model={model} onOpen={open} />}
        </>
      ) : null}
    </PageContainer>
  );
}

export default SiteMapSection;
