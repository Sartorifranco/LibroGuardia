/**
 * Helpers de presentación para último acceso (admin Personas).
 */

export const ACCESS_FILTER_OPTIONS = [
  { value: 'all', label: 'Cualquier uso' },
  { value: 'never', label: 'Nunca usó / sin dato' },
  { value: 'unused:90', label: 'Sin uso ≥ 90 días' },
  { value: 'unused:180', label: 'Sin uso ≥ 180 días' },
  { value: 'unused:365', label: 'Sin uso ≥ 1 año' },
  { value: 'stale:90', label: 'Candidatos limpieza (≥90 o sin dato)' },
  { value: 'known', label: 'Con último acceso conocido' }
];

export const formatLastAccessLabel = (person, { now = new Date() } = {}) => {
  if (!person?.lastAccessAt) {
    return { text: 'Sin dato', kind: 'unknown', title: 'Todavía no hay pases sincronizados para esta ficha' };
  }
  const days = person.daysSinceAccess != null
    ? Number(person.daysSinceAccess)
    : Math.floor(Math.max(0, now.getTime() - new Date(person.lastAccessAt).getTime()) / 86400000);

  let text;
  if (days === 0) text = 'Hoy';
  else if (days === 1) text = 'Ayer';
  else if (days < 30) text = `Hace ${days} días`;
  else if (days < 365) {
    const months = Math.floor(days / 30);
    text = months === 1 ? 'Hace 1 mes' : `Hace ${months} meses`;
  } else {
    const years = Math.floor(days / 365);
    text = years === 1 ? 'Hace 1 año' : `Hace ${years} años`;
  }

  const kind = days >= 180 ? 'stale' : days >= 90 ? 'warn' : 'ok';
  const when = new Date(person.lastAccessAt).toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  const source = person.lastAccessSource ? ` · ${person.lastAccessSource}` : '';
  return {
    text,
    kind,
    title: `${when}${source}`
  };
};

export const matchesClientAccessFilter = (person, accessFilter, now = new Date()) => {
  const raw = String(accessFilter || '').trim().toLowerCase();
  if (!raw || raw === 'all') return true;
  const days = person?.daysSinceAccess != null
    ? Number(person.daysSinceAccess)
    : (person?.lastAccessAt
      ? Math.floor(Math.max(0, now.getTime() - new Date(person.lastAccessAt).getTime()) / 86400000)
      : null);
  const has = person?.lastAccessAt != null || days != null;

  if (raw === 'never') return !has;
  if (raw === 'known') return has;
  if (raw.startsWith('stale:')) {
    const n = Number(raw.slice(6));
    if (!Number.isFinite(n)) return true;
    if (!has) return true;
    return days >= n;
  }
  if (raw.startsWith('unused:')) {
    const n = Number(raw.slice(7));
    if (!Number.isFinite(n)) return true;
    if (!has) return false;
    return days >= n;
  }
  return true;
};
