/**
 * Panel de personas asignadas a una puerta, con advertencias de por qué
 * alguien no podría pasar ahora (vs lista offline).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Search, UserPlus, Users, X } from 'lucide-react';
import { apiFetch } from '../services/api';

const REASON_LABELS = {
  dni_vacio: 'Sin DNI',
  dni_duplicado: 'DNI duplicado',
  persona_inactiva: 'Inactiva',
  sin_citacion_para_hoy: 'Sin auth. vigente',
  puerta_no_autorizada: 'Puerta no autorizada',
  fuera_de_horario: 'Fuera de horario',
  dia_no_habilitado: 'Día no habilitado',
  no_encontrado: 'No encontrada',
  denegado: 'No autorizado'
};

function DoorPeoplePanel({ authToken, doorId, doorName, doorRelayMode, onMessage, onError }) {
  const [people, setPeople] = useState([]);
  const [summary, setSummary] = useState(null);
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');
  const [listFilter, setListFilter] = useState('');
  const [onlyBlocked, setOnlyBlocked] = useState(false);
  const [searchHits, setSearchHits] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!doorId || !authToken) return;
    setLoading(true);
    try {
      const data = await apiFetch(`/admin/doors/${encodeURIComponent(doorId)}/people`, {
        token: authToken,
        allowForbidden: true
      });
      setPeople(data.people || []);
      setSummary(data.summary || null);
      setNote(data.note || '');
    } catch (err) {
      onError?.(err.message || 'No se pudieron cargar personas de la puerta');
    } finally {
      setLoading(false);
    }
  }, [authToken, doorId, onError]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!query.trim() || query.trim().length < 2) {
      setSearchHits([]);
      return undefined;
    }
    const t = setTimeout(async () => {
      try {
        const data = await apiFetch(`/admin/people?q=${encodeURIComponent(query.trim())}`, {
          token: authToken,
          allowForbidden: true
        });
        setSearchHits(data.people || []);
      } catch {
        setSearchHits([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query, authToken]);

  const addPerson = async (personId) => {
    try {
      const data = await apiFetch(`/admin/doors/${encodeURIComponent(doorId)}/people`, {
        method: 'POST',
        token: authToken,
        body: { personId }
      });
      onMessage?.(data.message || 'Persona vinculada');
      setQuery('');
      setSearchHits([]);
      await load();
    } catch (err) {
      onError?.(err.message || 'No se pudo agregar');
    }
  };

  const removePerson = async (personId) => {
    try {
      await apiFetch(
        `/admin/doors/${encodeURIComponent(doorId)}/people/${encodeURIComponent(personId)}`,
        { method: 'DELETE', token: authToken }
      );
      onMessage?.('Persona quitada de esta puerta');
      await load();
    } catch (err) {
      onError?.(err.message || 'No se pudo quitar');
    }
  };

  const filteredPeople = useMemo(() => {
    const q = listFilter.trim().toLowerCase();
    return people.filter((p) => {
      if (onlyBlocked && p.canPassNow !== false) return false;
      if (!q) return true;
      const hay = `${p.name || ''} ${p.idNumber || ''} ${(p.issueLabels || []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }, [people, listFilter, onlyBlocked]);

  const reasonSummary = useMemo(() => {
    const byReason = summary?.byReason || {};
    return Object.entries(byReason)
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => ({
        code,
        count,
        label: REASON_LABELS[code] || code
      }));
  }, [summary]);

  if (!doorId) {
    return (
      <p className="door-people__empty">
        Guardá la puerta primero para poder asignar personas.
      </p>
    );
  }

  const assigned = summary?.assigned ?? people.length;
  const canPass = summary?.canPassNow;
  const blocked = summary?.blocked;
  const isCloudDoor = (doorRelayMode || 'cloud') !== 'local';

  return (
    <div className="door-people">
      <div className="door-people__head">
        <div>
          <p className="door-people__title">
            <Users size={16} aria-hidden />
            {doorName || doorId}
          </p>
          <p className="door-people__desc">
            Lista explícita: solo quienes tienen <strong>esta</strong> puerta marcada en Personas
            (vacío en la ficha = ninguna puerta; no hay acceso global).
            {typeof canPass === 'number'
              ? ` · ${canPass} pueden pasar ahora · ${blocked} con problema`
              : ` · ${assigned} asignados`}
            .
            {note ? ` ${note}` : ''}
          </p>
        </div>
        <span className="door-people__count" title="Asignados a la puerta">
          {assigned}
        </span>
      </div>

      {isCloudDoor ? (
        <div className="door-people__banner door-people__banner--info" role="status">
          <AlertTriangle size={15} aria-hidden />
          <span>
            Esta puerta está en modo <strong>a distancia</strong>. El modo offline del lector
            autoriza en la mini PC, pero para abrir sin internet conviene
            {' '}<strong>En planta</strong> (la mini PC dispara el relé por red local).
          </span>
        </div>
      ) : null}

      {typeof blocked === 'number' && blocked > 0 ? (
        <div className="door-people__banner door-people__banner--warn" role="status">
          <AlertTriangle size={15} aria-hidden />
          <div>
            <strong>{blocked} no entrarían ahora</strong> (ni en la lista offline).
            {reasonSummary.length > 0 ? (
              <span>
                {' '}Motivos:{' '}
                {reasonSummary.map((r, i) => (
                  <span key={r.code}>
                    {i > 0 ? ' · ' : ''}
                    {r.label} ({r.count})
                  </span>
                ))}
              </span>
            ) : null}
            {' '}Completá DNI, quitá duplicados o cargá autorización vigente.
          </div>
        </div>
      ) : null}

      <label className="door-people__search">
        <UserPlus size={15} aria-hidden />
        <input
          className="input-field"
          placeholder="Agregar persona (nombre o DNI)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Buscar persona para agregar"
        />
      </label>
      {searchHits.length > 0 && (
        <ul className="door-people__hits">
          {searchHits.map((p) => {
            const already = people.some((x) => x.id === p.id);
            return (
              <li key={p.id}>
                <span>
                  {p.name}
                  {p.idNumber ? ` · ${p.idNumber}` : ''}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary-small"
                  disabled={already}
                  onClick={() => addPerson(p.id)}
                >
                  {already ? 'Ya está' : 'Agregar'}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="door-people__toolbar">
        {(people.length > 8 || blocked > 0) && (
          <label className="door-people__search door-people__search--filter">
            <Search size={15} aria-hidden />
            <input
              className="input-field"
              placeholder="Filtrar en la lista…"
              value={listFilter}
              onChange={(e) => setListFilter(e.target.value)}
              aria-label="Filtrar autorizados"
            />
          </label>
        )}
        {typeof blocked === 'number' && blocked > 0 ? (
          <label className="door-people__only-blocked">
            <input
              type="checkbox"
              checked={onlyBlocked}
              onChange={(e) => setOnlyBlocked(e.target.checked)}
            />
            <span>Solo con problema ({blocked})</span>
          </label>
        ) : null}
      </div>

      {loading ? (
        <p className="door-people__empty">Analizando quién puede pasar ahora…</p>
      ) : people.length === 0 ? (
        <p className="door-people__empty">Todavía no hay nadie autorizado en esta puerta.</p>
      ) : filteredPeople.length === 0 ? (
        <p className="door-people__empty">Sin coincidencias en el filtro.</p>
      ) : (
        <ul className="door-people__list" aria-label="Personas autorizadas">
          {filteredPeople.map((p) => {
            const blockedPerson = p.canPassNow === false;
            const labels = Array.isArray(p.issueLabels) && p.issueLabels.length
              ? p.issueLabels
              : (p.issues || []).map((i) => i.label || REASON_LABELS[i.code] || i.code);
            return (
              <li
                key={p.id}
                className={blockedPerson ? 'door-people__row--blocked' : undefined}
              >
                <div className="door-people__person">
                  <strong>{p.name}</strong>
                  {p.idNumber ? <span>{p.idNumber}</span> : <span className="door-people__warn-text">Sin DNI</span>}
                  {blockedPerson && labels.length > 0 ? (
                    <span className="door-people__issue" title={labels.join(' · ')}>
                      <AlertTriangle size={12} aria-hidden />
                      {labels.join(' · ')}
                    </span>
                  ) : p.canPassNow === true ? (
                    <span className="door-people__ok">Puede pasar ahora</span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="door-people__remove"
                  onClick={() => removePerson(p.id)}
                  title="Quitar de esta puerta"
                  aria-label={`Quitar a ${p.name}`}
                >
                  <X size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default DoorPeoplePanel;
