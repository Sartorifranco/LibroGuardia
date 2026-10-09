/** Qué hacer ante cada alarma, en una línea, sin jerga. */
const GUIDES = {
  door_forced: {
    label: 'Puerta forzada',
    action: 'Andá a esa puerta y fijate que nadie esté pasando.',
    critical: true
  },
  held_open: {
    label: 'Abierta demasiado tiempo',
    action: 'Cerrá la puerta. Si tiene que quedar abierta, avisá a supervisión.',
    critical: true
  },
  emergency: {
    label: 'Emergencia',
    action: 'Seguí el plan de emergencia y avisá a supervisión.',
    critical: true
  },
  duress: {
    label: 'Coacción',
    action: 'No confrontes a la persona. Avisá en silencio a supervisión.',
    critical: true
  },
  tailgate: {
    label: 'Posible colado',
    action: 'Mirá quién pasó detrás y anotalo si no corresponde.',
    critical: false
  },
  device_offline: {
    label: 'Equipo sin conexión',
    action: 'Revisá si el equipo tiene luz. Si sigue igual, avisá a sistemas.',
    critical: true
  },
  lock_fault: {
    label: 'Falla de cerradura',
    action: 'No fuerces la puerta. Avisá a sistemas.',
    critical: true
  }
};

const ALIASES = {
  forced: 'door_forced',
  forzada: 'door_forced',
  door_forced: 'door_forced',
  held_open: 'held_open',
  abierta_aut: 'held_open',
  retenida: 'held_open',
  emergency: 'emergency',
  emergencia: 'emergency',
  duress: 'duress',
  coaccion: 'duress',
  coacción: 'duress',
  tailgate: 'tailgate',
  tailgating: 'tailgate',
  colado: 'tailgate',
  posible_colado: 'tailgate',
  device_offline: 'device_offline',
  sin_conexion: 'device_offline',
  offline: 'device_offline',
  lock_fault: 'lock_fault',
  falla: 'lock_fault',
  falla_cerradura: 'lock_fault'
};

export const ALARM_TYPE_KEYS = new Set(Object.keys(ALIASES));

export function alarmTypeKey(alert = {}) {
  const raw = String(alert.type || alert.code || alert.alarmType || '').trim().toLowerCase();
  return ALIASES[raw] || '';
}

export function isOpenAlarm(alert) {
  if (!alert || typeof alert !== 'object') return false;
  const status = String(alert.status || alert.action || '').toLowerCase();
  if (alert.acked === true || status === 'acked' || status === 'closed' || status === 'cerrada' || status === 'reconocida') {
    return false;
  }
  if (alert.kind === 'alarm') return true;
  return Boolean(alarmTypeKey(alert));
}

export function guideFor(alert = {}) {
  const key = alarmTypeKey(alert);
  if (GUIDES[key]) return GUIDES[key];
  const severity = String(alert.severity || '').toLowerCase();
  const critical = severity === 'critical' || severity === 'critica' || severity === 'crítica' || severity === 'error';
  return {
    label: alert.title || 'Alarma',
    action: alert.message || 'Revisá la situación y anotá lo que ves.',
    critical
  };
}

export function isAlarmClosed(payload = {}) {
  const status = String(payload.status || payload.action || '').toLowerCase();
  return payload.acked === true
    || status === 'acked'
    || status === 'closed'
    || status === 'cerrada'
    || status === 'reconocida'
    || status === 'close'
    || status === 'ack';
}

export function applyAlarmEvent(list = [], payload) {
  if (!payload || typeof payload !== 'object') return list;
  const data = payload.alarm && typeof payload.alarm === 'object'
    ? { ...payload.alarm, ...payload }
    : payload;
  const id = data.id;
  if (!id) return list;
  if (isAlarmClosed(data)) return list.filter((item) => item.id !== id);
  if (!isOpenAlarm(data)) return list;
  const idx = list.findIndex((item) => item.id === id);
  if (idx < 0) return [data, ...list];
  const next = list.slice();
  next[idx] = { ...list[idx], ...data };
  return next;
}

const NATIVE_ALERTS_PREF_KEY = 'mss.guard.nativeNotifications';

export function nativeAlertsEnabled() {
  try {
    return localStorage.getItem(NATIVE_ALERTS_PREF_KEY) === '1';
  } catch {
    return false;
  }
}

export function playCriticalCue() {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate([180, 80, 180]);
    }
  } catch {
    // sin vibración
  }
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
    setTimeout(() => {
      try { ctx.close(); } catch { /* ignore */ }
    }, 500);
  } catch {
    // el navegador bloqueó el sonido
  }
}
