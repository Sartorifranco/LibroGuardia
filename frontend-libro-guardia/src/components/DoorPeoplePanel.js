import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, UserPlus, Users, X } from 'lucide-react';
import { apiFetch } from '../services/api';

/**
 * Personas autorizadas en una puerta: búsqueda + lista con scroll.
 */
function DoorPeoplePanel({ authToken, doorId, doorName, onMessage, onError }) {
  const [people, setPeople] = useState([]);
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');
  const [listFilter, setListFilter] = useState('');
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
    if (!q) return people;
    return people.filter((p) => {
      const hay = `${p.name || ''} ${p.idNumber || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [people, listFilter]);

  if (!doorId) {
    return (
      <p className="door-people__empty">
        Guardá la puerta primero para poder asignar personas.
      </p>
    );
  }

  return (
    <div className="door-people">
      <div className="door-people__head">
        <div>
          <p className="door-people__title">
            <Users size={16} aria-hidden />
            {doorName || doorId}
          </p>
          <p className="door-people__desc">
            Solo entran quienes estén en esta lista.
            {note ? ` ${note}` : ''}
          </p>
        </div>
        <span className="door-people__count">{people.length}</span>
      </div>

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

      {people.length > 8 && (
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

      {loading ? (
        <p className="door-people__empty">Cargando…</p>
      ) : people.length === 0 ? (
        <p className="door-people__empty">Todavía no hay nadie autorizado en esta puerta.</p>
      ) : filteredPeople.length === 0 ? (
        <p className="door-people__empty">Sin coincidencias en el filtro.</p>
      ) : (
        <ul className="door-people__list" aria-label="Personas autorizadas">
          {filteredPeople.map((p) => (
            <li key={p.id}>
              <div className="door-people__person">
                <strong>{p.name}</strong>
                {p.idNumber ? <span>{p.idNumber}</span> : null}
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
          ))}
        </ul>
      )}
    </div>
  );
}

export default DoorPeoplePanel;
