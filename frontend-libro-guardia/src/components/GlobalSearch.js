import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Loader2, User, Car, History } from 'lucide-react';
import { apiFetch } from '../services/api';
import { useAuth } from '../context/AuthContext';

const KIND_ICONS = {
  personal: User,
  vehicle: Car,
  vehiculo: Car,
  entry: History,
  historial: History
};

function GlobalSearch({ onNavigate }) {
  const { authToken } = useAuth();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const wrapRef = useRef(null);
  const debounceRef = useRef(null);

  const runSearch = useCallback(async (q) => {
    const needle = String(q || '').trim();
    if (!authToken || needle.length < 2) {
      setResults([]);
      setLoading(false);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch(`/search?q=${encodeURIComponent(needle)}`, {
        token: authToken,
        allowForbidden: true
      });
      setResults(Array.isArray(data.results) ? data.results : []);
      setOpen(true);
    } catch (err) {
      setResults([]);
      setError(err.message || 'No se pudo buscar');
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const needle = query.trim();
    if (needle.length < 2) {
      setResults([]);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    debounceRef.current = setTimeout(() => runSearch(needle), 320);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, runSearch]);

  useEffect(() => {
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const handleSelect = (item) => {
    setOpen(false);
    setQuery('');
    setResults([]);
    if (typeof onNavigate === 'function' && item?.tab) {
      onNavigate(item.tab);
    }
  };

  return (
    <div className="global-search" ref={wrapRef}>
      <div className="global-search__field">
        <Search size={16} aria-hidden className="global-search__icon" />
        <input
          type="search"
          className="global-search__input"
          placeholder="Buscar personal, patente, historial…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (results.length || error) setOpen(true);
          }}
          aria-label="Búsqueda global"
          autoComplete="off"
        />
        {loading && <Loader2 size={16} className="animate-spin global-search__spinner" aria-hidden />}
      </div>
      {open && (results.length > 0 || error || (query.trim().length >= 2 && !loading)) && (
        <div className="global-search__dropdown" role="listbox">
          {error && <div className="global-search__empty">{error}</div>}
          {!error && !loading && results.length === 0 && query.trim().length >= 2 && (
            <div className="global-search__empty">Sin resultados para “{query.trim()}”</div>
          )}
          {results.map((item) => {
            const Icon = KIND_ICONS[item.kind] || Search;
            return (
              <button
                key={`${item.kind}-${item.id}`}
                type="button"
                className="global-search__item"
                role="option"
                aria-selected="false"
                onClick={() => handleSelect(item)}
              >
                <Icon size={16} aria-hidden />
                <span className="global-search__item-text">
                  <strong>{item.title}</strong>
                  {item.subtitle && <small>{item.subtitle}</small>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default GlobalSearch;
