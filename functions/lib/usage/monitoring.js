'use strict';

const { pacificDateKey } = require('./meter');

const CACHE_DOC = '_monitoring';
const CACHE_OK_MS = 60 * 60 * 1000;
const CACHE_FAIL_MS = 10 * 60 * 1000;

const METRICS = {
  reads: 'firestore.googleapis.com/document/read_ops_count',
  writes: 'firestore.googleapis.com/document/write_ops_count',
  deletes: 'firestore.googleapis.com/document/delete_ops_count'
};

const PERMISSION_REASON = 'La cuenta del servidor no puede consultar el consumo de Google. En IAM, dale el rol Visor de Monitoring (roles/monitoring.viewer). El paso a paso está en docs/CONSUMO.md.';

const pointValue = (point) => Number(point?.value?.int64Value ?? point?.value?.doubleValue ?? 0) || 0;

const addPoints = (days, seriesList, field) => {
  (seriesList || []).forEach((series) => {
    (series.points || []).forEach((point) => {
      const end = point?.interval?.endTime;
      if (!end) return;
      const inside = new Date(new Date(end).getTime() - 60 * 1000);
      if (Number.isNaN(inside.getTime())) return;
      const key = pacificDateKey(inside);
      if (!days[key]) days[key] = { reads: 0, writes: 0, deletes: 0 };
      days[key][field] += pointValue(point);
    });
  });
};

const defaultFetch = (...args) => fetch(...args);

const defaultGetToken = async () => {
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp();
  const cred = admin.app().options.credential || admin.credential.applicationDefault();
  const token = await cred.getAccessToken();
  return token.access_token || token.token || token;
};

const defaultProjectId = () => (
  process.env.GOOGLE_CLOUD_PROJECT
  || process.env.GCLOUD_PROJECT
  || process.env.GCP_PROJECT
  || ''
);

const fetchMetric = async ({ projectId, token, metric, start, end, fetchImpl }) => {
  const params = new URLSearchParams({
    filter: `metric.type="${metric}"`,
    'interval.startTime': start,
    'interval.endTime': end,
    'aggregation.alignmentPeriod': '86400s',
    'aggregation.perSeriesAligner': 'ALIGN_SUM',
    'aggregation.crossSeriesReducer': 'REDUCE_SUM'
  });
  const url = `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(projectId)}/timeSeries?${params}`;
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body.timeSeries || [];
};

const cacheAgeMs = (cached, now) => {
  const at = new Date(cached?.fetchedAt || 0).getTime();
  if (!at) return Infinity;
  return now.getTime() - at;
};

/**
 * Consumo real de Firestore según Cloud Monitoring.
 * El resultado del día se guarda en usage/_monitoring y vale 1 hora.
 * Si faltan permisos, no inventa números: devuelve available:false.
 */
const getRealUsage = async ({
  db,
  FieldValue,
  now = new Date(),
  fetchImpl = defaultFetch,
  getToken = defaultGetToken,
  projectId = defaultProjectId()
} = {}) => {
  if (!db) throw new Error('Falta Firestore para leer el consumo');
  const ref = db.collection('usage').doc(CACHE_DOC);
  const snap = await ref.get();
  const cached = snap.exists ? (snap.data() || {}) : null;
  if (cached?.available && cacheAgeMs(cached, now) < CACHE_OK_MS) {
    return { available: true, days: cached.days || {}, fromCache: true, fetchedAt: cached.fetchedAt };
  }
  if (cached && cached.available === false && cacheAgeMs(cached, now) < CACHE_FAIL_MS) {
    return { available: false, reason: cached.reason || PERMISSION_REASON, fromCache: true };
  }

  try {
    if (!projectId) {
      return { available: false, reason: 'No está definido el proyecto de Google Cloud.' };
    }
    const token = await getToken();
    const start = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const end = now.toISOString();
    const days = {};
    for (const [field, metric] of Object.entries(METRICS)) {
      const series = await fetchMetric({
        projectId, token, metric, start, end, fetchImpl
      });
      addPoints(days, series, field);
    }
    const payload = {
      available: true,
      fetchedAt: now.toISOString(),
      days,
      reason: null
    };
    await ref.set({
      ...payload,
      ...(FieldValue ? { updatedAt: FieldValue.serverTimestamp() } : {})
    }, { merge: true });
    return { available: true, days, fromCache: false, fetchedAt: payload.fetchedAt };
  } catch (err) {
    const denied = err.status === 401 || err.status === 403;
    const reason = denied
      ? PERMISSION_REASON
      : (err.message || 'No se pudo consultar el consumo de Google.');
    try {
      await ref.set({
        available: false,
        reason,
        fetchedAt: now.toISOString(),
        ...(FieldValue ? { updatedAt: FieldValue.serverTimestamp() } : {})
      }, { merge: true });
    } catch (writeErr) {
      console.error('[usage] cache monitoring', writeErr.message);
    }
    return { available: false, reason };
  }
};

module.exports = {
  CACHE_DOC,
  METRICS,
  PERMISSION_REASON,
  getRealUsage,
  addPoints
};
