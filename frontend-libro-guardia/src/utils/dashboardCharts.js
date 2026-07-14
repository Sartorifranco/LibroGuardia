import { getEffectiveEntryType } from './entryDisplay';
import { getDashboardStats } from './dashboardStats';

const TYPE_META = [
  { key: 'personal', label: 'Personal', color: '#2563eb' },
  { key: 'vehiculo', label: 'Vehículos ext.', color: '#7c3aed' },
  { key: 'flota', label: 'Flota / blindados', color: '#dc2626' },
  { key: 'novedad', label: 'Novedades', color: '#d97706' }
];

function isSameLocalDay(dateA, dateB) {
  return (
    dateA.getFullYear() === dateB.getFullYear()
    && dateA.getMonth() === dateB.getMonth()
    && dateA.getDate() === dateB.getDate()
  );
}

function classifyEntry(entry) {
  if (entry.type === 'personal') return 'personal';
  if (entry.type === 'novedad') return 'novedad';
  return getEffectiveEntryType(entry);
}

export function getExecutiveChartData(entries, referenceDate = new Date()) {
  const stats = getDashboardStats(entries, referenceDate);
  const todayEntries = (entries || []).filter((entry) => {
    const ts = new Date(entry.timestamp);
    return isSameLocalDay(ts, referenceDate);
  });

  const typeCounts = {
    personal: 0,
    vehiculo: 0,
    flota: 0,
    novedad: 0
  };
  todayEntries.forEach((entry) => {
    const key = classifyEntry(entry);
    if (typeCounts[key] !== undefined) typeCounts[key] += 1;
  });

  const byType = TYPE_META.map((meta) => ({
    ...meta,
    value: typeCounts[meta.key] || 0
  }));

  const totalByType = byType.reduce((sum, item) => sum + item.value, 0);

  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  todayEntries.forEach((entry) => {
    const hour = new Date(entry.timestamp).getHours();
    byHour[hour].count += 1;
  });

  const peakHour = byHour.reduce(
    (best, item) => (item.count > best.count ? item : best),
    { hour: 0, count: 0 }
  );

  const maxHourCount = Math.max(...byHour.map((item) => item.count), 1);

  return {
    stats,
    byType,
    totalByType,
    byHour,
    peakHour,
    maxHourCount,
    personalFlow: {
      ingresos: stats.personalIngresos,
      egresos: stats.personalEgresos,
      max: Math.max(stats.personalIngresos, stats.personalEgresos, 1)
    }
  };
}

export function buildDonutGradient(segments) {
  const total = segments.reduce((sum, item) => sum + item.value, 0);
  if (!total) return 'conic-gradient(#e5e7eb 0deg 360deg)';

  let cursor = 0;
  const parts = segments
    .filter((item) => item.value > 0)
    .map((item) => {
      const slice = (item.value / total) * 360;
      const start = cursor;
      cursor += slice;
      return `${item.color} ${start}deg ${cursor}deg`;
    });

  if (parts.length === 0) return 'conic-gradient(#e5e7eb 0deg 360deg)';
  return `conic-gradient(${parts.join(', ')})`;
}
