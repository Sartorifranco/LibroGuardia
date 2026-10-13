/**
 * Semáforo de un equipo para la pantalla de Sistemas.
 * Los motivos salen de `checks` del heartbeat (y de lastError si repite lo mismo).
 */

const OFFLINE_AFTER_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 2 * 60 * 1000;

const RULES = [
  {
    label: 'Lector desconectado',
    keys: ['reader', 'readers', 'lector', 'readerdisconnected', 'reader_disconnected', 'readeronline', 'reader_online']
  },
  {
    label: 'Relé no responde',
    keys: ['relay', 'rele', 'relayok', 'relay_ok', 'relaynoresponse', 'relay_no_response', 'lock']
  },
  {
    label: 'Credenciales inválidas',
    keys: ['credentials', 'credential', 'creds', 'credentialsok', 'credentials_ok', 'credentialsinvalid', 'credentials_invalid']
  },
  {
    label: 'Reloj desfasado',
    keys: ['clock', 'reloj', 'clockok', 'clockskew', 'clock_skew', 'clockoffsetms', 'clock_offset_ms', 'clockms']
  }
];

const FAIL_TEXT = /^(fail|error|down|offline|disconnected|invalid|skew|bad|false|no)$/i;
const OK_TEXT = /^(ok|up|true|connected|valid|online)$/i;

const ruleForKey = (key) => {
  const k = String(key || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  return RULES.find((rule) => rule.keys.includes(k)) || null;
};

const valueIsProblem = (key, value, now) => {
  if (value == null) return false;
  if (typeof value === 'boolean') {
    if (/ok$|online$/i.test(key)) return value === false;
    if (/skew|invalid|disconnected|fault|error/i.test(key)) return value === true;
    return value === false;
  }
  if (typeof value === 'number') {
    if (/offset|skew/i.test(key)) return Math.abs(value) > CLOCK_SKEW_MS;
    if (/clockms|^clock$|reloj/i.test(key)) {
      if (value > 1e12) return Math.abs(now - value) > CLOCK_SKEW_MS;
      return Math.abs(value) > CLOCK_SKEW_MS;
    }
    return false;
  }
  if (typeof value === 'string') {
    if (OK_TEXT.test(value.trim())) return false;
    return FAIL_TEXT.test(value.trim());
  }
  if (Array.isArray(value)) {
    return value.some((item, index) => valueIsProblem(`${key}_${index}`, item, now));
  }
  if (typeof value === 'object') {
    if (value.ok === false || value.connected === false || value.online === false) return true;
    const status = String(value.status || value.state || '');
    return FAIL_TEXT.test(status);
  }
  return false;
};

const walkChecks = (checks, now, found) => {
  if (!checks || typeof checks !== 'object') return;
  Object.entries(checks).forEach(([key, value]) => {
    const rule = ruleForKey(key);
    if (rule && valueIsProblem(key, value, now)) found.add(rule.label);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      walkChecks(value, now, found);
    }
  });
};

const labelsFromLastError = (lastError) => {
  const text = String(lastError || '').toLowerCase();
  if (!text) return [];
  const out = [];
  if (/lector|reader/.test(text)) out.push('Lector desconectado');
  if (/rele|relé|relay/.test(text)) out.push('Relé no responde');
  if (/credencial|credential/.test(text)) out.push('Credenciales inválidas');
  if (/reloj|clock|skew/.test(text)) out.push('Reloj desfasado');
  return out;
};

/** Motivos en español, sin repetir. */
const problemLabels = (checks, now = Date.now(), lastError = null) => {
  const found = new Set();
  walkChecks(checks, now, found);
  labelsFromLastError(lastError).forEach((label) => found.add(label));
  return RULES.map((rule) => rule.label).filter((label) => found.has(label));
};

const problemSignature = (checks, now = Date.now(), lastError = null) => (
  problemLabels(checks, now, lastError).join('|')
);

const hace = (ms, now) => {
  const delta = Math.max(0, now - ms);
  const min = Math.round(delta / 60000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return min === 1 ? 'hace 1 min' : `hace ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 48) return hours === 1 ? 'hace 1 h' : `hace ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'hace 1 día' : `hace ${days} días`;
};

const configLabelFor = (device, configVersion) => {
  if (!device || device.status === 'pending' || device.status === 'revoked' || device.status === 'replaced') {
    return null;
  }
  if (configVersion == null || configVersion === '') return null;
  const applied = device.configVersionApplied;
  if (applied == null || Number(applied) < Number(configVersion)) return 'Actualizando…';
  return 'Actualizado';
};

/**
 * @returns {{code:string, label:string, detail:string|null, problems:string[], configLabel:string|null}}
 */
const deviceHealth = (device = {}, { configVersion = null, now = Date.now() } = {}) => {
  const configLabel = configLabelFor(device, configVersion);
  const problems = problemLabels(device.checks, now, device.lastError);
  const base = { problems, configLabel };

  if (device.status === 'pending') {
    return { ...base, code: 'pending', label: 'Pendiente de instalar', detail: 'Falta escribir el código en el equipo', configLabel: null };
  }
  if (device.status === 'revoked') {
    return { ...base, code: 'revoked', label: 'Dado de baja', detail: null, configLabel: null, problems: [] };
  }
  if (device.status === 'replaced') {
    return { ...base, code: 'replaced', label: 'Reemplazado', detail: null, configLabel: null, problems: [] };
  }

  const seen = Number(device.lastSeenAt);
  const seenOk = Number.isFinite(seen) && seen > 0 && (now - seen) <= OFFLINE_AFTER_MS;
  const reportedDown = device.online === false;
  if (!seenOk || reportedDown) {
    const detail = Number.isFinite(seen) && seen > 0
      ? `Último contacto ${hace(seen, now)}`
      : 'Todavía no se conectó';
    return { ...base, code: 'offline', label: 'Sin conexión', detail, problems: [] };
  }
  if (problems.length) {
    return { ...base, code: 'problem', label: 'Con problemas', detail: problems.join('. ') };
  }
  return { ...base, code: 'online', label: 'En línea', detail: null };
};

module.exports = {
  OFFLINE_AFTER_MS,
  CLOCK_SKEW_MS,
  problemLabels,
  problemSignature,
  deviceHealth,
  hace
};
