import React from 'react';
import { useEntries } from '../context/EntriesContext';

function formatHm(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** Aviso cuando el refresco de registros falló y se siguen mostrando los últimos datos. */
function EntriesRefreshNotice() {
  const { entriesRefreshFailed, entriesUpdatedAt } = useEntries();
  if (!entriesRefreshFailed) return null;
  const hm = formatHm(entriesUpdatedAt);
  return (
    <p className="entries-refresh-notice" role="status">
      {hm
        ? `No se pudo actualizar. Mostrando datos de las ${hm}.`
        : 'No se pudo actualizar.'}
    </p>
  );
}

export default EntriesRefreshNotice;
