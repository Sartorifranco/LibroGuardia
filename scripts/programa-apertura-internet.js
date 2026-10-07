/**
 * Puente local SR201 — HTTP /pulse → TCP a la(s) placa(s) en LAN.
 *
 * Temporizado (software): ON → responde HTTP al caller → espera N s → OFF.
 * Así /api/access/kiosk-scan no queda bloqueado los N segundos del pulso
 * (la persona en la puerta recibe "autorizado" apenas se inicia la apertura).
 * La duración mecánica del pulso no cambia. Si el OFF falla se reintenta
 * (300 ms / 1 s / 3 s) y se loguea fuerte.
 *
 * Seguridad (fail-closed):
 * - Sin "bridgeSecret" (o con uno de menos de 16 caracteres) el puente NO arranca.
 * - /pulse exige Bearer + HMAC; /status exige Bearer.
 * - El comando TCP se arma SOLO con canal + duración: se ignora `command` del body.
 * - host/puerto del body solo si están en la lista "sr201Permitidos" de la config
 *   (por defecto únicamente sr201Host:sr201Port).
 * - GET /health no expone IP/puerto de la placa.
 *
 * Config: scripts/configuracion-apertura-internet.json (o el nombre viejo
 * scripts/sr201-bridge.config.json) o variables de entorno.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const {
  sendTcpCommand,
  sendTimedPulseTcp,
  buildPulseCommand,
  queryRelayStatusTcp,
  clampChannel,
  clampSeconds
} = require('../functions/sr201');
const {
  authorizePulseRequest,
  createNonceStore,
  checkBridgeSecretStrength,
  isBearerAuthorized,
  MIN_SECRET_LENGTH
} = require('../functions/lib/relayHmac');

const BRIDGE_VERSION = 4;
const CONFIG_FILE_NAMES = [
  'configuracion-apertura-internet.json',
  'sr201-bridge.config.json' // nombre viejo (compat)
];
const MAX_BODY_BYTES = 16 * 1024;

const loadFileConfig = (dir = __dirname) => {
  for (const name of CONFIG_FILE_NAMES) {
    const configPath = path.join(dir, name);
    try {
      if (!fs.existsSync(configPath)) continue;
      const raw = fs.readFileSync(configPath, 'utf8').replace(/^﻿/, '');
      return { cfg: JSON.parse(raw) || {}, configPath };
    } catch (err) {
      console.warn(`No se pudo leer ${name}:`, err.message);
    }
  }
  return { cfg: {}, configPath: null };
};

const targetKey = (host, port) => `${String(host || '').trim().toLowerCase()}:${Number(port) || 0}`;

/** "192.168.0.38:6722" | "192.168.0.38" | { host, port } → clave normalizada. */
const parseTargetEntry = (entry, defaultPort) => {
  if (!entry) return null;
  if (typeof entry === 'object') {
    const host = String(entry.host || '').trim();
    if (!host) return null;
    return targetKey(host, Number(entry.port) || defaultPort);
  }
  const raw = String(entry).trim();
  if (!raw) return null;
  const idx = raw.lastIndexOf(':');
  if (idx > 0) {
    const port = Number(raw.slice(idx + 1));
    if (Number.isFinite(port) && port > 0) return targetKey(raw.slice(0, idx), port);
  }
  return targetKey(raw, defaultPort);
};

/**
 * Normaliza la config del puente (archivo + entorno). Función pura.
 */
const resolveBridgeSettings = ({ fileCfg = {}, configPath = null, env = process.env } = {}) => {
  const sr201Host = String(env.SR201_HOST || fileCfg.sr201Host || '192.168.1.100').trim();
  const sr201Port = Number(env.SR201_PORT || fileCfg.sr201Port) || 6722;
  const secretFromEnv = Boolean(env.BRIDGE_SECRET);
  const secret = String(env.BRIDGE_SECRET || fileCfg.bridgeSecret || '').trim();

  const extra = env.SR201_ALLOWED
    ? String(env.SR201_ALLOWED).split(',')
    : (Array.isArray(fileCfg.sr201Permitidos) ? fileCfg.sr201Permitidos : []);
  const allowedTargets = new Set([targetKey(sr201Host, sr201Port)]);
  extra.forEach((entry) => {
    const key = parseTargetEntry(entry, sr201Port);
    if (key) allowedTargets.add(key);
  });

  return {
    port: Number(env.BRIDGE_PORT || fileCfg.bridgePort) || 5022,
    host: env.BRIDGE_HOST || fileCfg.bridgeHost || '0.0.0.0',
    sr201Host,
    sr201Port,
    secret,
    secretSource: secretFromEnv ? 'env' : 'file',
    configPath,
    allowedTargets,
    nativeTimer: env.SR201_NATIVE_TIMER === '1' || fileCfg.sr201TemporizadorNativo === true
  };
};

/**
 * Errores que impiden arrancar (mensajes para el técnico, en castellano).
 * Nunca incluye el valor del secreto.
 */
const validateBridgeSettings = (settings) => {
  const errors = [];
  const check = checkBridgeSecretStrength(settings.secret);
  if (check.ok) return errors;

  const where = settings.secretSource === 'env'
    ? 'la variable de entorno BRIDGE_SECRET'
    : `"bridgeSecret" en ${settings.configPath || path.join(__dirname, CONFIG_FILE_NAMES[0])}`;
  const suggestion = crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
  const howTo = `Abrí ${settings.secretSource === 'env' ? 'la configuración del servicio' : 'ese archivo con el Bloc de notas'}, `
    + `poné en ${where} una clave de al menos ${MIN_SECRET_LENGTH} caracteres `
    + `(por ejemplo, esta generada al azar ahora: ${suggestion}), guardá, y cargá EXACTAMENTE `
    + 'la misma clave en la web: Admin → Puertas → "Clave de seguridad". '
    + 'Después volvé a iniciar este programa.';

  if (check.code === 'missing_secret') {
    errors.push(`Falta la clave del puente (${where}). Sin clave cualquiera en la red podría abrir la puerta, `
      + `así que el puente no arranca. ${howTo}`);
  } else if (check.code === 'placeholder_secret') {
    errors.push(`La clave del puente (${where}) sigue con el valor de ejemplo. ${howTo}`);
  } else {
    errors.push(`La clave del puente (${where}) es demasiado corta: tiene ${check.length} caracteres `
      + `y el mínimo es ${MIN_SECRET_LENGTH}. ${howTo}`);
  }
  return errors;
};

/**
 * Destino TCP permitido. Sin host/puerto en el pedido → el configurado.
 * @returns {{ ok: true, host: string, port: number } | { ok: false, status: number, message: string }}
 */
const resolveTarget = (settings, { host, port } = {}) => {
  const targetHost = String(host || '').trim() || settings.sr201Host;
  const targetPort = Number(port) || settings.sr201Port;
  if (!settings.allowedTargets.has(targetKey(targetHost, targetPort))) {
    console.warn(`[puente] Destino rechazado (no está en sr201Permitidos): ${targetHost}:${targetPort}`);
    return {
      ok: false,
      status: 403,
      message: `Destino ${targetHost}:${targetPort} no permitido. Si es una placa legítima, `
        + 'agregala a "sr201Permitidos" en configuracion-apertura-internet.json y reiniciá el puente.'
    };
  }
  return { ok: true, host: targetHost, port: targetPort };
};

/**
 * Pulso a partir del body: SOLO canal + modo + segundos. `command` se ignora.
 */
const buildPulsePlan = (payload = {}) => {
  const channel = clampChannel(payload.channel);
  const mode = payload.mode === 'timed' || payload.softwareTimed ? 'timed' : 'jog';
  const seconds = clampSeconds(payload.seconds);
  return { channel, mode, seconds };
};

const defaultDeps = () => ({ sendTcpCommand, sendTimedPulseTcp, queryRelayStatusTcp });

const executePulse = async (plan, target, settings, deps = defaultDeps()) => {
  if (plan.mode === 'timed') {
    // Responder tras ON; OFF (con reintentos) en background, misma duración N s.
    return deps.sendTimedPulseTcp(
      target.host,
      target.port,
      plan.channel,
      plan.seconds,
      undefined,
      { waitForComplete: false, nativeTimer: settings.nativeTimer }
    );
  }
  const command = buildPulseCommand(plan.channel, 'jog', plan.seconds);
  const result = await deps.sendTcpCommand(target.host, target.port, command);
  return { ...result, mode: 'jog', seconds: 0.5 };
};

const parseJsonBody = (rawBody) => {
  if (!rawBody) return {};
  const parsed = JSON.parse(rawBody);
  return parsed && typeof parsed === 'object' ? parsed : {};
};

/** POST /pulse ya leído. @returns {Promise<{ status: number, body: object }>} */
const handlePulse = async ({ settings, headers = {}, rawBody = '', nonces, deps = defaultDeps(), nowMs } = {}) => {
  let auth;
  try {
    auth = authorizePulseRequest({
      secret: settings.secret,
      headers,
      rawBody,
      seenNonces: nonces,
      ...(nowMs != null ? { nowMs } : {})
    });
  } catch (_err) {
    return { status: 401, body: { message: 'No autorizado' } };
  }
  if (!auth.ok) {
    return { status: auth.status || 401, body: { message: 'No autorizado' } };
  }

  let payload;
  try {
    payload = parseJsonBody(rawBody);
  } catch (_err) {
    return { status: 400, body: { message: 'JSON inválido' } };
  }

  const target = resolveTarget(settings, payload);
  if (!target.ok) return { status: target.status, body: { message: target.message } };

  const plan = buildPulsePlan(payload);
  try {
    const result = await executePulse(plan, target, settings, deps);
    const confirmed = result?.confirmed !== false;
    return {
      status: 200,
      body: {
        message: plan.mode === 'timed'
          ? `Pulso temporizado ${plan.seconds}s iniciado (OFF async)${confirmed ? '' : ' — sin confirmación de la placa'}`
          : `Pulso jog enviado${confirmed ? '' : ' — sin confirmación de la placa'}`,
        host: target.host,
        port: target.port,
        channel: plan.channel,
        ...result,
        confirmed
      }
    };
  } catch (err) {
    return { status: 500, body: { message: err.message || 'Error al activar SR201' } };
  }
};

/** GET|POST /status. */
const handleStatus = async ({ settings, headers = {}, params = {}, deps = defaultDeps() } = {}) => {
  if (!settings.secret || !isBearerAuthorized(settings.secret, headers)) {
    return { status: 401, body: { message: 'No autorizado' } };
  }
  const target = resolveTarget(settings, params);
  if (!target.ok) return { status: target.status, body: { message: target.message } };
  try {
    const status = await deps.queryRelayStatusTcp(target.host, target.port);
    return { status: 200, body: { message: 'Estado de relés', ...status } };
  } catch (err) {
    return { status: 500, body: { message: err.message || 'Error al leer estado SR201' } };
  }
};

/** Sin auth: solo "vivo" + versión (no expone IP/puerto de la placa). */
const handleHealth = () => ({
  status: 200,
  body: { status: 'ok', service: 'sr201-bridge', version: BRIDGE_VERSION }
});

const sendJson = (res, statusCode, payload) => {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      reject(Object.assign(new Error('Body demasiado grande'), { status: 413 }));
      req.destroy();
      return;
    }
    body += chunk;
  });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const createBridgeServer = (settings, { deps = defaultDeps(), nonces = createNonceStore() } = {}) => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        const out = handleHealth();
        return sendJson(res, out.status, out.body);
      }
      if (url.pathname === '/status' && (req.method === 'GET' || req.method === 'POST')) {
        let params = { host: url.searchParams.get('host'), port: url.searchParams.get('port') };
        if (req.method === 'POST') {
          try {
            params = parseJsonBody(await readBody(req));
          } catch (err) {
            return sendJson(res, err.status || 400, { message: err.status ? err.message : 'JSON inválido' });
          }
        }
        const out = await handleStatus({ settings, headers: req.headers, params, deps });
        return sendJson(res, out.status, out.body);
      }
      if (req.method === 'POST' && url.pathname === '/pulse') {
        let rawBody;
        try {
          rawBody = await readBody(req);
        } catch (err) {
          return sendJson(res, err.status || 400, { message: err.message });
        }
        const out = await handlePulse({ settings, headers: req.headers, rawBody, nonces, deps });
        return sendJson(res, out.status, out.body);
      }
      return sendJson(res, 404, { message: 'Ruta no encontrada' });
    } catch (err) {
      return sendJson(res, 500, { message: err.message || 'Error interno del puente' });
    }
  });

  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  return server;
};

const main = () => {
  const { cfg, configPath } = loadFileConfig();
  const settings = resolveBridgeSettings({ fileCfg: cfg, configPath });
  const errors = validateBridgeSettings(settings);
  if (errors.length) {
    errors.forEach((msg) => console.error(`ERROR: ${msg}`));
    console.error('El puente de apertura NO se inició (protección: sin clave válida no se abren puertas).');
    process.exit(1);
    return;
  }

  const server = createBridgeServer(settings);
  server.listen(settings.port, settings.host, () => {
    console.log(`SR201 bridge v${BRIDGE_VERSION} escuchando en http://${settings.host}:${settings.port}`);
    console.log(`Destino por defecto: ${settings.sr201Host}:${settings.sr201Port}`);
    console.log(`Destinos permitidos: ${[...settings.allowedTargets].join(', ')}`);
    console.log(settings.nativeTimer
      ? 'Temporizado: ON nativo "1R:n" de la placa + OFF por software (red de seguridad)'
      : 'Temporizado: ON → HTTP 200 → espera Ns → OFF (async, con reintentos)');
  });
};

if (require.main === module) {
  main();
}

module.exports = {
  BRIDGE_VERSION,
  CONFIG_FILE_NAMES,
  loadFileConfig,
  parseTargetEntry,
  resolveBridgeSettings,
  validateBridgeSettings,
  resolveTarget,
  buildPulsePlan,
  executePulse,
  handlePulse,
  handleStatus,
  handleHealth,
  createBridgeServer
};
