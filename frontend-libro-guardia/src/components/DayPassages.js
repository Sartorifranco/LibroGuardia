import React from 'react';
import { useEntries } from '../context/EntriesContext';
import { movementVerb, passageDisplayName } from '../utils/accessEventText';
import EntryNotes from './EntryNotes';

function formatHour(entry) {
  const raw = entry.eventTime || entry.timestamp;
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return String(entry.eventTime || '');
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function DayPassages() {
  const { entries, entriesLoading } = useEntries();
  const list = Array.isArray(entries) ? entries : [];

  return (
    <section className="day-passages" aria-label="Novedades y pasos del día">
      <h3>Novedades / pasos del día</h3>
      {entriesLoading && !list.length ? <p>Cargando pasos…</p> : null}
      {!entriesLoading && !list.length ? <p>Todavía no hay pasos hoy.</p> : null}
      <div className="day-passages__list">
        {list.map((entry, index) => {
          const name = passageDisplayName(entry);
          const key = entry.id || entry.eventId || `${entry.timestamp}-${name}-${index}`;
          return (
            <article key={key} className="day-passage">
              <div className="day-passage__top">
                <strong>{name}</strong>
                <span>{movementVerb(entry)}</span>
              </div>
              <p>
                {entry.doorName || 'Puerta'}
                {formatHour(entry) ? ` · ${formatHour(entry)}` : ''}
              </p>
              <EntryNotes entry={entry} />
            </article>
          );
        })}
      </div>
    </section>
  );
}

export default DayPassages;
