import React from 'react';
import { useEntries } from '../context/EntriesContext';
import { accessReasonText, countsAsPassage, movementVerb, passageDisplayName } from '../utils/accessEventText';
import EntryNotes from './EntryNotes';

function formatHour(entry) {
  const raw = entry.eventTime || entry.timestamp;
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return String(entry.eventTime || '');
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function groupPassages(list) {
  const mains = [];
  const repeatsByParent = new Map();
  const loose = [];
  const ids = new Set(list.filter((entry) => countsAsPassage(entry) && entry.id).map((entry) => entry.id));
  list.forEach((entry) => {
    if (countsAsPassage(entry)) {
      mains.push(entry);
      return;
    }
    const parent = entry.repeatOf || (entry.payload && entry.payload.repeatOf) || null;
    if (parent && ids.has(parent)) {
      const bucket = repeatsByParent.get(parent) || [];
      bucket.push(entry);
      repeatsByParent.set(parent, bucket);
      return;
    }
    loose.push(entry);
  });
  return { mains, repeatsByParent, loose };
}

function PassageArticle({ entry }) {
  const name = passageDisplayName(entry);
  const repeat = !countsAsPassage(entry);
  return (
    <article className="day-passage">
      <div className="day-passage__top">
        <strong>{name}</strong>
        <span>{movementVerb(entry)}</span>
      </div>
      <p>
        {entry.doorName || 'Puerta'}
        {formatHour(entry) ? ` · ${formatHour(entry)}` : ''}
      </p>
      <EntryNotes entry={repeat ? { ...entry, accessReason: '', denialReason: '', reason: '' } : entry} />
    </article>
  );
}

function DayPassages() {
  const { entries, entriesLoading } = useEntries();
  const list = Array.isArray(entries) ? entries : [];
  const grouped = groupPassages(list);

  return (
    <section className="day-passages" aria-label="Novedades y pasos del día">
      <h3>Novedades / pasos del día</h3>
      {entriesLoading && !list.length ? <p>Cargando pasos…</p> : null}
      {!entriesLoading && !list.length ? <p>Todavía no hay pasos hoy.</p> : null}
      <div className="day-passages__list">
        {grouped.mains.map((entry, index) => {
          const name = passageDisplayName(entry);
          const key = entry.id || entry.eventId || `${entry.timestamp}-${name}-${index}`;
          const repeats = grouped.repeatsByParent.get(entry.id) || [];
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
              {repeats.map((repeat) => (
                <p key={repeat.id || repeat.eventId} className="day-passage__repeat">
                  {accessReasonText('lectura_repetida')}
                </p>
              ))}
            </article>
          );
        })}
        {grouped.loose.map((entry, index) => {
          const name = passageDisplayName(entry);
          const key = entry.id || entry.eventId || `rep-${entry.timestamp}-${name}-${index}`;
          return <PassageArticle key={key} entry={entry} />;
        })}
      </div>
    </section>
  );
}

export default DayPassages;
