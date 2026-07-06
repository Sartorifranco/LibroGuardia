/**
 * Puente local SR201 para Bacar Guardia.
 * Ejecutar en el servidor/red de planta (ej. 192.168.0.9) donde el SR201 es alcanzable.
 *
 * Uso:
 *   set SR201_HOST=192.168.1.100
 *   set SR201_PORT=6722
 *   set BRIDGE_PORT=5022
 *   set BRIDGE_SECRET=clave-secreta
 *   node scripts/sr201-bridge.js
 */

const http = require('http');
const { sendTcpCommand, buildPulseCommand } = require('../functions/sr201');

const PORT = Number(process.env.BRIDGE_PORT) || 5022;
const HOST = process.env.BRIDGE_HOST || '0.0.0.0';
const SR201_HOST = process.env.SR201_HOST || '192.168.1.100';
const SR201_PORT = Number(process.env.SR201_PORT) || 6722;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';

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
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'sr201-bridge',
      sr201Host: SR201_HOST,
      sr201Port: SR201_PORT
    });
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
      const mode = payload.mode || 'jog';
      const seconds = Number(payload.seconds) || 3;
      const command = payload.command || buildPulseCommand(channel, mode, seconds);
      const targetHost = payload.host || SR201_HOST;
      const targetPort = Number(payload.port) || SR201_PORT;

      const result = await sendTcpCommand(targetHost, targetPort, command);
      sendJson(res, 200, {
        message: 'Pulso SR201 enviado',
        command,
        host: targetHost,
        port: targetPort,
        response: result.response
      });
    } catch (err) {
      sendJson(res, 500, { message: err.message || 'Error al activar SR201' });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`SR201 bridge escuchando en http://${HOST}:${PORT}`);
  console.log(`Destino SR201: ${SR201_HOST}:${SR201_PORT}`);
});
