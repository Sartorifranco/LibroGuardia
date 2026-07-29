/**
 * Puente local SR201 — HTTP /pulse → TCP a la(s) placa(s) en LAN.
 *
 * Temporizado (software): ON → responde HTTP al caller → espera N s → OFF.
 * Así /api/access/kiosk-scan no queda bloqueado los N segundos del pulso
 * (la persona en la puerta recibe "autorizado" apenas se inicia la apertura).
 * La duración mecánica del pulso no cambia.
 *
 * Config: scripts/sr201-bridge.config.json o variables de entorno.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  sendTcpCommand,
  sendTimedPulseTcp,
  buildPulseCommand,
  queryRelayStatusTcp
} = require('../functions/sr201');

const loadFileConfig = () => {
  const configPath = path.join(__dirname, 'sr201-bridge.config.json');
  try {
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
  } catch (err) {
    console.warn('No se pudo leer sr201-bridge.config.json:', err.message);
    return {};
  }
};

const fileCfg = loadFileConfig();
const PORT = Number(process.env.BRIDGE_PORT || fileCfg.bridgePort) || 5022;
const HOST = process.env.BRIDGE_HOST || fileCfg.bridgeHost || '0.0.0.0';
const SR201_HOST = process.env.SR201_HOST || fileCfg.sr201Host || '192.168.1.100';
const SR201_PORT = Number(process.env.SR201_PORT || fileCfg.sr201Port) || 6722;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || fileCfg.bridgeSecret || '';

const sendJson = (res, statusCode, payload) => {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

const isAuthorized = (req) => {
  if (!BRIDGE_SECRET) return true;
  const header = req.headers.authorization || '';
  return header === `Bearer ${BRIDGE_SECRET}`;
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url.startsWith('/health?'))) {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'sr201-bridge',
      sr201Host: SR201_HOST,
      sr201Port: SR201_PORT,
      multiHost: true,
      timed: 'software-on-async-off',
      statusApi: true,
      version: 3
    });
  }

  const handleStatus = async (targetHost, targetPort) => {
    const status = await queryRelayStatusTcp(targetHost, targetPort);
    return {
      message: 'Estado de relés',
      ...status
    };
  };

  if (req.method === 'GET' && (req.url === '/status' || req.url.startsWith('/status?'))) {
    if (!isAuthorized(req)) {
      return sendJson(res, 401, { message: 'No autorizado' });
    }
    try {
      const u = new URL(req.url, 'http://localhost');
      const targetHost = u.searchParams.get('host') || SR201_HOST;
      const targetPort = Number(u.searchParams.get('port') || SR201_PORT) || SR201_PORT;
      return sendJson(res, 200, await handleStatus(targetHost, targetPort));
    } catch (err) {
      return sendJson(res, 500, { message: err.message || 'Error al leer estado SR201' });
    }
  }

  if (req.method === 'POST' && req.url === '/status') {
    if (!isAuthorized(req)) {
      return sendJson(res, 401, { message: 'No autorizado' });
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        const targetHost = payload.host || SR201_HOST;
        const targetPort = Number(payload.port) || SR201_PORT;
        return sendJson(res, 200, await handleStatus(targetHost, targetPort));
      } catch (err) {
        return sendJson(res, 500, { message: err.message || 'Error al leer estado SR201' });
      }
    });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/pulse') {
    return sendJson(res, 404, { message: 'Ruta no encontrada' });
  }

  if (!isAuthorized(req)) {
    return sendJson(res, 401, { message: 'No autorizado' });
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });

  req.on('end', async () => {
    try {
      const payload = body ? JSON.parse(body) : {};
      const channel = Number(payload.channel) || 1;
      const mode = payload.mode === 'timed' || payload.softwareTimed ? 'timed' : (payload.mode || 'jog');
      const seconds = Math.max(1, Math.min(99, Number(payload.seconds) || 3));
      const targetHost = payload.host || SR201_HOST;
      const targetPort = Number(payload.port) || SR201_PORT;

      let result;
      if (mode === 'timed') {
        // Responder tras ON; OFF en background (misma duración N s).
        result = await sendTimedPulseTcp(
          targetHost,
          targetPort,
          channel,
          seconds,
          undefined,
          { waitForComplete: false }
        );
      } else {
        const command = payload.command || buildPulseCommand(channel, 'jog', seconds);
        result = await sendTcpCommand(targetHost, targetPort, command);
        result = { ...result, mode: 'jog', seconds: 0.5 };
      }

      sendJson(res, 200, {
        message: mode === 'timed'
          ? `Pulso temporizado ${seconds}s iniciado (OFF async)`
          : 'Pulso jog enviado',
        host: targetHost,
        port: targetPort,
        channel,
        ...result
      });
    } catch (err) {
      sendJson(res, 500, { message: err.message || 'Error al activar SR201' });
    }
  });
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

server.listen(PORT, HOST, () => {
  console.log(`SR201 bridge escuchando en http://${HOST}:${PORT}`);
  console.log(`Destino por defecto: ${SR201_HOST}:${SR201_PORT}`);
  console.log('Temporizado: ON → HTTP 200 → espera Ns → OFF (async)');
  if (!BRIDGE_SECRET) console.warn('AVISO: BRIDGE_SECRET vacío — /pulse sin autenticación');
});
