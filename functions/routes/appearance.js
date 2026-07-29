/**
 * Apariencia / marca editable en runtime (tema completo).
 * Defaults vienen de brand.js del frontend; este override vive en Firestore.
 */

const express = require('express');
const { db, FieldValue } = require('../firestore');
const { auth, requirePermission } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');
const { logAdminAction } = require('../lib/auditLog');

const router = express.Router();
const DOC_PATH = ['systemConfig', 'appearance'];

const HEX_RE = /^#([0-9a-fA-F]{6})$/;

const COLOR_KEYS = [
  'primaryColor',
  'primaryColorHover',
  'backgroundColor',
  'darkBg',
  'darkSurface',
  'darkCard',
  'darkText',
  'darkMuted',
  'darkBorder',
  'darkSidebar',
  'lightBg',
  'lightSurface',
  'lightCard',
  'lightText',
  'lightMuted',
  'lightBorder',
  'lightSidebar'
];

const TEXT_KEYS = ['appTitle', 'companyName', 'presetId'];

const sanitizeAppearance = (body = {}) => {
  const out = {};
  COLOR_KEYS.forEach((key) => {
    const raw = String(body[key] || '').trim();
    if (!raw) return;
    if (!HEX_RE.test(raw)) {
      const err = new Error(`Color inválido en ${key}. Usá formato #RRGGBB.`);
      err.status = 400;
      throw err;
    }
    out[key] = raw.toLowerCase();
  });

  TEXT_KEYS.forEach((key) => {
    const raw = String(body[key] || '').trim();
    if (!raw) return;
    out[key] = raw.slice(0, key === 'presetId' ? 40 : 120);
  });

  return out;
};

const readAppearance = async () => {
  const snap = await db.collection(DOC_PATH[0]).doc(DOC_PATH[1]).get();
  if (!snap.exists) return {};
  const data = snap.data() || {};
  const appearance = {};
  [...COLOR_KEYS, ...TEXT_KEYS].forEach((key) => {
    appearance[key] = data[key] || null;
  });
  // Compat: backgroundColor histórico = darkBg
  if (!appearance.darkBg && appearance.backgroundColor) {
    appearance.darkBg = appearance.backgroundColor;
  }
  appearance.updatedAt = data.updatedAt?.toDate
    ? data.updatedAt.toDate().toISOString()
    : data.updatedAt || null;
  appearance.updatedBy = data.updatedBy || null;
  return appearance;
};

/** Público: para aplicar marca antes del login. */
router.get('/api/public/appearance', async (_req, res) => {
  try {
    const appearance = await readAppearance();
    res.json({ appearance });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Error al leer apariencia' });
  }
});

router.get('/api/admin/appearance', auth, requirePermission('settings.permissions'), async (_req, res) => {
  try {
    const appearance = await readAppearance();
    res.json({ appearance });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Error al leer apariencia' });
  }
});

router.put('/api/admin/appearance', auth, requirePermission('settings.permissions'), async (req, res) => {
  try {
    const before = await readAppearance();
    const patch = sanitizeAppearance(req.body || {});
    if (!Object.keys(patch).length) {
      return res.status(400).json({ message: 'No hay cambios de apariencia para guardar' });
    }
    // Si mandan darkBg, sincronizar backgroundColor legacy
    if (patch.darkBg && !patch.backgroundColor) {
      patch.backgroundColor = patch.darkBg;
    }
    const actor = req.user?.username || req.user?.id || 'admin';
    await db.collection(DOC_PATH[0]).doc(DOC_PATH[1]).set({
      ...patch,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actor
    }, { merge: true });

    const appearance = await readAppearance();
    logActivity(db, FieldValue, {
      actorUsername: actor,
      actorId: req.user?.id || '',
      action: 'appearance.update',
      summary: `${actor} actualizó la apariencia del sistema`
    }).catch((err) => console.error('activityLog appearance.update:', err.message));
    logAdminAction({
      req,
      action: 'appearance.update',
      targetType: 'appearance',
      targetId: 'system',
      before,
      after: appearance
    }).catch((err) => console.error('auditLog appearance.update:', err.message));

    res.json({ message: 'Apariencia guardada', appearance });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'Error al guardar apariencia' });
  }
});

module.exports = router;
