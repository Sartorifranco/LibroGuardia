/**
 * Proveedor GPS UBIKA (API estilo Traccar: /api/devices + /api/positions).
 * Auth: Bearer token. Env: UBIKA_API_URL, UBIKA_API_TOKEN.
 */

const { joinDevicesAndPositions } = require('./traccarLike');

const DEFAULT_UBIKA_URL = 'https://ubika.rastreo.com.ar';
const API_KEY_MASK = '********';

const resolveCredentials = (config = {}) => {
  const key = config.apiKey;
  const apiKey = (key && key !== API_KEY_MASK)
    ? key
    : (process.env.UBIKA_API_TOKEN || '');
  const apiUrl = String(config.apiUrl || process.env.UBIKA_API_URL || DEFAULT_UBIKA_URL)
    .replace(/\/$/, '');
  return { apiUrl, apiKey };
};

const isConfigured = (config = {}) => Boolean(resolveCredentials(config).apiKey);

const missingConfigMessage = 'Configure el token de API UBIKA';

const ubikaFetchJson = async (url, apiKey) => {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.message || payload.error || `HTTP ${response.status}`;
    throw new Error(`UBIKA ${message}`);
  }
  return payload;
};

const requireApiKey = (config) => {
  const { apiUrl, apiKey } = resolveCredentials(config);
  if (!apiKey) {
    throw new Error('Falta token de API UBIKA');
  }
  return { apiUrl, apiKey };
};

const fetchDevices = async (config = {}) => {
  const { apiUrl, apiKey } = requireApiKey(config);
  const payload = await ubikaFetchJson(`${apiUrl}/api/devices`, apiKey);
  return Array.isArray(payload) ? payload : [];
};

const fetchPositions = async (config = {}) => {
  const { apiUrl, apiKey } = requireApiKey(config);
  const payload = await ubikaFetchJson(`${apiUrl}/api/positions`, apiKey);
  return Array.isArray(payload) ? payload : [];
};

const fetchFleet = async (config = {}) => {
  const [devices, positions] = await Promise.all([
    fetchDevices(config),
    fetchPositions(config)
  ]);
  return joinDevicesAndPositions(devices, positions);
};

module.exports = {
  id: 'ubika',
  displayName: 'UBIKA',
  DEFAULT_UBIKA_URL,
  resolveCredentials,
  isConfigured,
  missingConfigMessage,
  fetchDevices,
  fetchPositions,
  fetchFleet
};
