/** Lectura simple de los checks del equipo para la prueba de instalación. */

export function leftLabel(expiresAt, now) {
  const left = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(left) || left <= 0) return 'Venció';
  const total = Math.ceil(left / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export const INSTALL_POLL_MS = 5000;

const READER_KEYS = ['serialconnected', 'reader', 'readerconnected', 'lector', 'readeronline'];
const RELAY_KEYS = ['relayreachable', 'relay', 'rele', 'relayok', 'lock'];
const ONLINE_KEYS = ['online', 'connected', 'heartbeat'];

const normKey = (key) => String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const flagFromValue = (value) => {
  if (value === true) return true;
  if (value === false || value == null) return false;
  if (typeof value === 'string') return /^(ok|true|connected|online|up)$/i.test(value.trim());
  if (typeof value === 'object') {
    if ('value' in value) return flagFromValue(value.value);
    if (value.ok === true || value.connected === true || value.online === true) return true;
  }
  return false;
};

const readAny = (checks, keys) => {
  if (!checks || typeof checks !== 'object') return false;
  return Object.entries(checks).some(([key, value]) => {
    if (keys.includes(normKey(key))) return flagFromValue(value);
    if (value && typeof value === 'object' && !Array.isArray(value) && !('value' in value)) {
      return readAny(value, keys);
    }
    return false;
  });
};

/** @returns {{ connected: boolean, reader: boolean, relay: boolean }} */
export function installProbe(device = {}) {
  const checks = device.checks || {};
  const health = device.health || {};
  return {
    connected: health.code === 'online' || device.online === true || readAny(checks, ONLINE_KEYS),
    reader: readAny(checks, READER_KEYS),
    relay: readAny(checks, RELAY_KEYS)
  };
}

const TIPS = [
  [/lector desconectado/i, 'Lector desconectado: revisá el cable USB.'],
  [/rel[eé] no responde/i, 'Relé no responde: revisá el cable de red de la placa de relé.'],
  [/credenciales/i, 'Credenciales inválidas: revisá el usuario y la clave del lector de huella.'],
  [/reloj/i, 'Reloj desfasado: la hora del equipo no coincide. Revisá que esté en hora.']
];

/** Una frase de qué hacer, en lenguaje simple. */
export function statusAdvice(health = {}) {
  if (health.code === 'pending') return 'Falta escribir el código de instalación en el equipo.';
  if (health.code === 'offline') {
    const when = health.detail ? `${health.detail}. ` : '';
    return `${when}Revisá que esté enchufado y conectado al mismo router.`;
  }
  if (health.code === 'revoked') return 'Este equipo está dado de baja.';
  if (health.code === 'replaced') return 'Este equipo fue reemplazado.';
  const text = [health.detail, ...(health.problems || [])].filter(Boolean).join('. ');
  if (!text) return health.code === 'online' ? 'Está en línea y puede abrir sus puertas.' : '';
  const tip = TIPS.find(([pattern]) => pattern.test(text));
  return tip ? tip[1] : text;
}
