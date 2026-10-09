'use strict';

const express = require('express');
const { db, FieldValue } = require('../firestore');
const { logAdminAction } = require('../lib/auditLog');
const { buildUsageReport } = require('../lib/usage/report');
const { getUsageSettings, saveUsageBudget } = require('../lib/usage/budget');
const {
  auth,
  requireAnyPermission,
  sendServerError
} = require('../middleware/auth');

const router = express.Router();

const canSeeUsage = requireAnyPermission(['consumo.ver', 'settings.permissions']);

router.get('/api/admin/usage', auth, canSeeUsage, async (req, res) => {
  try {
    const report = await buildUsageReport({
      db,
      FieldValue,
      days: req.query.days
    });
    res.json(report);
  } catch (err) {
    sendServerError(res, err, 'No se pudo leer el consumo');
  }
});

router.put('/api/admin/usage/budget', auth, canSeeUsage, async (req, res) => {
  try {
    const before = await getUsageSettings(db);
    const saved = await saveUsageBudget(req.body?.monthlyBudgetUsd, db, FieldValue);
    await logAdminAction({
      action: 'usage.budget.update',
      targetType: 'settings',
      targetId: 'usage',
      before: { monthlyBudgetUsd: before.monthlyBudgetUsd },
      after: { monthlyBudgetUsd: saved.monthlyBudgetUsd },
      req
    });
    res.json(saved);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ message: err.message });
    sendServerError(res, err, 'No se pudo guardar el tope');
  }
});

module.exports = router;
