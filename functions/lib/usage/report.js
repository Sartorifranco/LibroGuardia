'use strict';

const { FIRESTORE_PRICING_USD, PRICING_SOURCE, PRICING_VERIFIED_ON } = require('./pricing');
const { estimateDayUsd, estimateFunctionsUsd, budgetStatus, roundUsd } = require('./cost');
const { pacificDateKey } = require('./meter');
const { getRealUsage } = require('./monitoring');

const DEFAULT_BUDGET_USD = 5;
const CATEGORY_INFO = {
  gps: {
    label: 'GPS de la flota',
    note: 'Consultas automáticas de los vehículos cada 5 minutos.'
  },
  guardia: {
    label: 'Guardia',
    note: 'Registros de ingresos y egresos, y lo que mira la pantalla del guardia.'
  },
  edge: {
    label: 'Equipos de planta',
    note: 'Lectores, estaciones y el puente que habla con las puertas.'
  },
  admin: {
    label: 'Administración',
    note: 'Pantallas de configuración, usuarios y este panel.'
  },
  biostar: {
    label: 'BioStar',
    note: 'Sincronización con el control de acceso BioStar.'
  },
  compilador: {
    label: 'Actualización de equipos',
    note: 'Armado de la lista de acceso que baja a los equipos del sitio.'
  },
  auth: {
    label: 'Ingresos al sistema',
    note: 'Cuando alguien entra con usuario y contraseña.'
  },
  notificaciones: {
    label: 'Avisos por mail',
    note: 'Envío de alertas cuando pasa algo importante.'
  },
  otros: {
    label: 'Otros',
    note: 'El resto de las consultas que no entran en los grupos de arriba.'
  }
};

const sumMap = (map = {}) => Object.values(map || {}).reduce((total, value) => total + (Number(value) || 0), 0);

const pacificParts = (now) => {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
  const [year, month, day] = formatted.split('-').map((part) => Number(part));
  return { year, month, day, key: `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}` };
};

const shiftPacificDays = (now, delta) => new Date(now.getTime() + delta * 24 * 60 * 60 * 1000);

const dateKeys = (days, now) => {
  const count = Math.min(31, Math.max(1, Number(days) || 30));
  const keys = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    keys.push(pacificDateKey(shiftPacificDays(now, -i)));
  }
  return keys;
};

const daysInPacificMonth = (now) => {
  const { year, month } = pacificParts(now);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
};

const emptyCounts = () => ({ reads: {}, writes: {}, deletes: {}, invocations: {} });

const readMeasured = async (db, keys) => {
  const byDate = {};
  if (typeof db.getAll === 'function') {
    const refs = keys.map((key) => db.collection('usage').doc(key));
    const snaps = refs.length ? await db.getAll(...refs) : [];
    snaps.forEach((snap, index) => {
      byDate[keys[index]] = snap && snap.exists ? (snap.data() || emptyCounts()) : emptyCounts();
    });
    return byDate;
  }
  await Promise.all(keys.map(async (key) => {
    const snap = await db.collection('usage').doc(key).get();
    byDate[key] = snap.exists ? (snap.data() || emptyCounts()) : emptyCounts();
  }));
  return byDate;
};

const projectMonth = (dailyCosts, now) => {
  const { year, month, day } = pacificParts(now);
  const prefix = `${year}${String(month).padStart(2, '0')}`;
  const soFar = dailyCosts
    .filter((row) => String(row.date).replace(/-/g, '').startsWith(prefix))
    .reduce((total, row) => total + row.estimatedUsd, 0);
  const elapsed = Math.max(1, day);
  const inMonth = daysInPacificMonth(now);
  return {
    estimatedUsd: roundUsd(soFar),
    projectedUsd: roundUsd((soFar / elapsed) * inMonth),
    dayOfMonth: day,
    daysInMonth: inMonth
  };
};

const buildUsageReport = async ({
  db,
  FieldValue,
  days = 30,
  now = new Date(),
  budgetUsd,
  includeMonitoring = true,
  monitoring
} = {}) => {
  const store = db ? { db, FieldValue } : require('../../firestore');
  const keys = dateKeys(days, now);
  const [measuredByDate, settingsSnap] = await Promise.all([
    readMeasured(store.db, keys),
    store.db.collection('settings').doc('usage').get()
  ]);
  const settings = settingsSnap.exists ? (settingsSnap.data() || {}) : {};
  const budget = Number.isFinite(Number(budgetUsd))
    ? Number(budgetUsd)
    : (Number(settings.monthlyBudgetUsd) > 0 ? Number(settings.monthlyBudgetUsd) : DEFAULT_BUDGET_USD);

  let real = { available: false, reason: null, days: {} };
  if (includeMonitoring) {
    real = monitoring || await getRealUsage({
      db: store.db,
      FieldValue: store.FieldValue,
      now
    });
  }

  const totals = emptyCounts();
  const rows = keys.map((key) => {
    const doc = measuredByDate[key] || emptyCounts();
    ['reads', 'writes', 'deletes', 'invocations'].forEach((kind) => {
      Object.entries(doc[kind] || {}).forEach(([cat, n]) => {
        totals[kind][cat] = (totals[kind][cat] || 0) + (Number(n) || 0);
      });
    });
    const measuredReads = sumMap(doc.reads);
    const measuredWrites = sumMap(doc.writes);
    const measuredDeletes = sumMap(doc.deletes);
    const realDay = real.available ? (real.days?.[key] || null) : null;
    const costSource = realDay || {
      reads: measuredReads,
      writes: measuredWrites,
      deletes: measuredDeletes
    };
    return {
      date: `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`,
      dateKey: key,
      measured: {
        reads: doc.reads || {},
        writes: doc.writes || {},
        deletes: doc.deletes || {},
        invocations: doc.invocations || {},
        totals: {
          reads: measuredReads,
          writes: measuredWrites,
          deletes: measuredDeletes,
          invocations: sumMap(doc.invocations)
        }
      },
      real: realDay,
      estimatedUsd: estimateDayUsd(costSource)
    };
  });

  const month = projectMonth(rows, now);
  const invocations = sumMap(totals.invocations);
  month.functionsUsd = estimateFunctionsUsd(invocations);
  month.projectedUsd = roundUsd(month.projectedUsd + month.functionsUsd);
  month.estimatedUsd = roundUsd(month.estimatedUsd + month.functionsUsd);
  month.budgetUsd = budget;
  month.status = budgetStatus(month.projectedUsd, budget);

  const topCategories = Object.entries(CATEGORY_INFO).map(([id, info]) => ({
    id,
    label: info.label,
    note: info.note,
    reads: totals.reads[id] || 0,
    writes: totals.writes[id] || 0,
    deletes: totals.deletes[id] || 0,
    invocations: totals.invocations[id] || 0
  })).filter((row) => row.reads || row.writes || row.deletes || row.invocations)
    .sort((a, b) => (b.reads + b.writes) - (a.reads + a.writes));

  return {
    days: rows,
    month,
    topCategories,
    freeDaily: FIRESTORE_PRICING_USD.freeDaily,
    pricing: {
      verifiedOn: PRICING_VERIFIED_ON,
      source: PRICING_SOURCE,
      readsPer100k: FIRESTORE_PRICING_USD.readsPer100k,
      writesPer100k: FIRESTORE_PRICING_USD.writesPer100k,
      deletesPer100k: FIRESTORE_PRICING_USD.deletesPer100k
    },
    monitoring: {
      available: Boolean(real.available),
      reason: real.available ? null : (real.reason || null),
      fromCache: Boolean(real.fromCache)
    },
    alarm: month.status === 'over',
    budgetUsd: budget
  };
};

module.exports = {
  DEFAULT_BUDGET_USD,
  CATEGORY_INFO,
  buildUsageReport,
  projectMonth,
  dateKeys,
  pacificParts
};
