import React, { useCallback, useEffect, useState } from 'react';
import { UserPlus, X } from 'lucide-react';
import { apiFetch } from '../services/api';

/**
 * Gestión rápida de personas con lista explícita que incluye esta puerta.
 * Escribe el mismo campo people.allowedDoorIds que DoorAccessEditor.
 */
function DoorPeoplePanel({ authToken, doorId, doorName, onMessage, onError }) {
  const [people, setPeople] = useState([]);
  const [unrestrictedCount, setUnrestrictedCount] = useState(0);
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');
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
      setUnrestrictedCount(data.unrestrictedCount || 0);
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

  if (!doorId) {
    return (
      <p className="historial-meta" style={{ marginTop: '0.75rem' }}>
        Guardá un ID de puerta para gestionar personas autorizadas.
      </p>
    );
  }

  return (
    <div style={{ marginTop: '1rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border, #e5e5e5)' }}>
      <h5 className="theme-section-title" style={{ fontSize: '0.95rem', marginBottom: '0.35rem' }}>
        Personas autorizadas en esta puerta
      </h5>
      <p className="historial-meta" style={{ marginBottom: '0.5rem' }}>
        {doorName || doorId}
        {unrestrictedCount > 0 ? ` · ${unrestrictedCount} con acceso total (todas las puertas)` : ''}
      </p>
      {note && <p className="historial-meta" style={{ marginBottom: '0.5rem' }}>{note}</p>}

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <input
          className="input-field"
          placeholder="Buscar persona (nombre o DNI) para agregar…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {searchHits.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 0.75rem', maxHeight: 140, overflow: 'auto' }}>
          {searchHits.map((p) => (
            <li
              key={p.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.35rem 0',
                borderBottom: '1px solid var(--border, #eee)',
                fontSize: '0.875rem'
              }}
            >
              <span>
                {p.name}
                {p.idNumber ? ` (${p.idNumber})` : ''}
                {!p.allowedDoorIds ? ' · acceso total' : ''}
              </span>
              <button type="button" className="btn btn-secondary-small" onClick={() => addPerson(p.id)}>
                <UserPlus size={14} /> Agregar
              </button>
            </li>
          ))}
        </ul>
      )}

      {loading ? (
        <p className="historial-meta">Cargando…</p>
      ) : people.length === 0 ? (
        <p className="historial-meta">Nadie con lista restringida que incluya esta puerta.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {people.map((p) => (
            <li
              key={p.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '0.35rem 0',
                fontSize: '0.875rem',
                borderBottom: '1px solid var(--border, #eee)'
              }}
            >
              <span>
                {p.name}
                {p.idNumber ? ` (${p.idNumber})` : ''}
              </span>
              <button type="button" className="btn btn-danger-small" onClick={() => removePerson(p.id)} title="Quitar de esta puerta">
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
