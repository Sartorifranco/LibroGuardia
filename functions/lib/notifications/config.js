const { db, FieldValue } = require('../../firestore');

const SETTINGS_DOC = 'notificationsConfig';

const EVENT_TYPES = [
  'exceptional_entry',
  'repeated_denials',
  'door_relay_failure',
  'admin_sensitive'
];

const DEFAULT_EVENT = () => ({
  enabled: false,
  recipients: []
});

const DEFAULT_CONFIG = {
  enabled: false,
  smtp: {
    host: '',
    port: 587,
    secure: false,
    user: '',
    password: '',
    from: ''
  },
  events: {
    exceptional_entry: { ...DEFAULT_EVENT(), enabled: true, recipients: [] },
    repeated_denials: {
      ...DEFAULT_EVENT(),
      enabled: true,
      recipients: [],
      threshold: 3,
      windowMinutes: 10
    },
    door_relay_failure: { ...DEFAULT_EVENT(), enabled: true, recipients: [] },
    admin_sensitive: { ...DEFAULT_EVENT(), enabled: true, recipients: [] }
  }
};

const normalizeRecipients = (list = []) => {
  if (!Array.isArray(list)) return [];
  return [...new Set(
    list
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  )];
};

const normalizeEvent = (key, raw = {}) => {
  const base = DEFAULT_CONFIG.events[key] || DEFAULT_EVENT();
  const merged = { ...base, ...(raw || {}) };
  const event = {
    enabled: merged.enabled !== false,
    recipients: normalizeRecipients(merged.recipients)
  };
  if (key === 'repeated_denials') {
    event.threshold = Math.max(2, Math.min(20, Number(merged.threshold) || base.threshold || 3));
    event.windowMinutes = Math.max(1, Math.min(120, Number(merged.windowMinutes) || base.windowMinutes || 10));
  }
  return event;
};

const normalizeConfig = (raw = {}) => {
  const smtpRaw = raw.smtp || {};
  const events = {};
  EVENT_TYPES.forEach((key) => {
    events[key] = normalizeEvent(key, raw.events?.[key]);
  });
  return {
    enabled: raw.enabled === true,
    smtp: {
      host: String(smtpRaw.host || '').trim(),
      port: Number(smtpRaw.port) || 587,
      secure: smtpRaw.secure === true,
      user: String(smtpRaw.user || '').trim(),
      password: String(smtpRaw.password || ''),
      from: String(smtpRaw.from || '').trim()
    },
    events,
    updatedAt: raw.updatedAt || null
  };
};

const getNotificationsConfig = async () => {
  const snap = await db.collection('settings').doc(SETTINGS_DOC).get();
  if (!snap.exists) return normalizeConfig(DEFAULT_CONFIG);
  return normalizeConfig({ ...DEFAULT_CONFIG, ...snap.data() });
};

/** Vista pública: nunca expone el password SMTP en claro. */
const publicNotificationsConfig = (config) => {
  const normalized = normalizeConfig(config);
  return {
    ...normalized,
    smtp: {
      ...normalized.smtp,
      password: '',
      hasPassword: Boolean(String(config?.smtp?.password || '').trim())
    }
  };
};

const saveNotificationsConfig = async (updates = {}) => {
  const current = await getNotificationsConfig();
  const nextSmtp = {
    ...current.smtp,
    ...(updates.smtp || {})
  };
  // Si el cliente manda password vacío, conservar el existente (mismo criterio que API keys).
  if (!String(updates.smtp?.password || '').trim()) {
    nextSmtp.password = current.smtp.password || '';
  }

  const nextEvents = { ...current.events };
  EVENT_TYPES.forEach((key) => {
    if (updates.events?.[key]) {
      nextEvents[key] = normalizeEvent(key, {
        ...current.events[key],
        ...updates.events[key]
      });
    }
  });

  const payload = normalizeConfig({
    enabled: updates.enabled !== undefined ? updates.enabled === true : current.enabled,
    smtp: nextSmtp,
    events: nextEvents
  });

  await db.collection('settings').doc(SETTINGS_DOC).set({
    ...payload,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  return getNotificationsConfig();
};

module.exports = {
  SETTINGS_DOC,
  EVENT_TYPES,
  DEFAULT_CONFIG,
  normalizeConfig,
  getNotificationsConfig,
  publicNotificationsConfig,
  saveNotificationsConfig
};
