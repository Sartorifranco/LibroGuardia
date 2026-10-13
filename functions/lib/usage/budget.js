'use strict';

const { DEFAULT_BUDGET_USD, buildUsageReport } = require('./report');
const { pacificDateKey } = require('./meter');

const SETTINGS_DOC = 'usage';

let memoryCheckedOn = '';

const getUsageSettings = async (db) => {
  const store = db || require('../../firestore').db;
  const snap = await store.collection('settings').doc(SETTINGS_DOC).get();
  const data = snap.exists ? (snap.data() || {}) : {};
  const budget = Number(data.monthlyBudgetUsd);
  return {
    monthlyBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET_USD,
    lastBudgetAlertOn: data.lastBudgetAlertOn || null,
    lastBudgetCheckOn: data.lastBudgetCheckOn || null,
    budgetExceeded: data.budgetExceeded === true
  };
};

const saveUsageBudget = async (monthlyBudgetUsd, db, FieldValue) => {
  const amount = Number(monthlyBudgetUsd);
  if (!Number.isFinite(amount) || amount < 1 || amount > 1000) {
    const error = new Error('El tope tiene que ser un número entre 1 y 1000 dólares.');
    error.status = 400;
    throw error;
  }
  const store = db ? { db, FieldValue } : require('../../firestore');
  const rounded = Math.round(amount * 100) / 100;
  await store.db.collection('settings').doc(SETTINGS_DOC).set({
    monthlyBudgetUsd: rounded,
    updatedAt: store.FieldValue ? store.FieldValue.serverTimestamp() : new Date().toISOString()
  }, { merge: true });
  return { monthlyBudgetUsd: rounded };
};

/**
 * Una vez por día (la primera pasada del job de salud de equipos):
 * si la proyección del mes supera el tope, manda el mail usage_budget.
 */
const evaluateUsageBudget = async ({
  db,
  FieldValue,
  notify,
  now = new Date(),
  buildReport
} = {}) => {
  const today = pacificDateKey(now);
  if (memoryCheckedOn === today) return { skipped: true, reason: 'ya_evaluado' };

  const store = db ? { db, FieldValue } : require('../../firestore');
  const settings = await getUsageSettings(store.db);
  if (settings.lastBudgetCheckOn === today) {
    memoryCheckedOn = today;
    return { skipped: true, reason: 'ya_evaluado' };
  }

  const report = await (buildReport || buildUsageReport)({
    db: store.db,
    FieldValue: store.FieldValue,
    days: 31,
    now,
    includeMonitoring: false
  });
  const over = report.month.projectedUsd > settings.monthlyBudgetUsd;
  const shouldMail = over && settings.lastBudgetAlertOn !== today;

  await store.db.collection('settings').doc(SETTINGS_DOC).set({
    lastBudgetCheckOn: today,
    budgetExceeded: over,
    projectedUsd: report.month.projectedUsd,
    monthlyBudgetUsd: settings.monthlyBudgetUsd,
    ...(shouldMail ? { lastBudgetAlertOn: today } : {}),
    updatedAt: store.FieldValue ? store.FieldValue.serverTimestamp() : new Date().toISOString()
  }, { merge: true });
  memoryCheckedOn = today;

  let mailed = null;
  if (shouldMail) {
    const send = notify || require('../notifications').notify;
    mailed = await send('usage_budget', {
      projectedUsd: report.month.projectedUsd,
      budgetUsd: settings.monthlyBudgetUsd,
      estimatedUsd: report.month.estimatedUsd
    });
  }

  return {
    skipped: false,
    over,
    mailed: Boolean(shouldMail),
    notify: mailed,
    projectedUsd: report.month.projectedUsd,
    budgetUsd: settings.monthlyBudgetUsd
  };
};

const resetBudgetCheckMemoryForTests = () => {
  memoryCheckedOn = '';
};

module.exports = {
  SETTINGS_DOC,
  getUsageSettings,
  saveUsageBudget,
  evaluateUsageBudget,
  resetBudgetCheckMemoryForTests
};
