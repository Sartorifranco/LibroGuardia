'use strict';

/**
 * API LAN del controlador para el hub (requests firmadas Ed25519 con lanSign; ventana 60 s, anti-replay).
 *
 *   GET  /edge/status                    estado completo (puertas, salidas, journal, reloj, config, aprobaciones)
 *   POST /edge/config/notify             {version?}  → 202 y sincroniza con el hub en segundo plano
 *   POST /edge/doors/:id/open            {requestedBy, reason, force, permissions?, mode?, side?, commandId?}
 *   POST /edge/approvals/:id             {approve, requestedBy, permissions?, force?, reason?}
 *   POST /edge/sim/input                 {doorId, input:'dps'|'bond'|'rex'|'emergency', value}  (solo simulation.enabled)
 *
 * Toda respuesta lleva `x-mss-time` (hora del controlador, ms). Errores: {ok:false, code, message}.
 */

const http = require('http');
const lanSign = require('../lib/lanSign');
const { nullLogger } = require('../drivers/logger');

const MAX_BODY = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body demasiado grande'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @param {{controller:object, config:object, logger?:object, now?:()=>number}} opts
 * @returns {http.Server}
 */
function createLanServer({ controller, config, logger = nullLogger, now = () => Date.now() }) {
  const nonces = lanSign.createNonceStore();
  const hubKeys = {};
  if (config.hub.publicKey) hubKeys[config.hub.deviceId] = config.hub.publicKey;

  const send = (res, status, body) => {
    const raw = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(raw),
      [lanSign.TIME_HEADER]: String(now()),
      'cache-control': 'no-store'
    });
    res.end(raw);
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://edge.local');
    const raw = await readBody(req);
    if (!config.lan.allowUnsigned) {
      const v = lanSign.verifyRequest({
        method: req.method, path: req.url, headers: req.headers, body: raw,
        resolveKey: (keyId) => hubKeys[keyId] || null, nonceStore: nonces, now: now()
      });
      if (!v.ok) {
        logger.warn('Request LAN rechazada', { code: v.code, path: url.pathname, from: req.socket.remoteAddress });
        return send(res, 401, { ok: false, code: v.code, message: v.message });
      }
    }
    let body = {};
    if (raw.length) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch (_) {
        return send(res, 400, { ok: false, code: 'BAD_JSON', message: 'JSON inválido' });
      }
    }
    const p = url.pathname.replace(/\/+$/, '');

    if (req.method === 'GET' && p === '/edge/status') return send(res, 200, { ok: true, ...controller.status() });

    if (req.method === 'POST' && p === '/edge/config/notify') {
      controller.configSync.sync('notify').catch(() => {});
      return send(res, 202, { ok: true, accepted: true, configVersion: controller.edge.chunks.configVersion(), notifiedVersion: body.version ?? null });
    }

    let m = p.match(/^\/edge\/doors\/([^/]+)\/open$/);
    if (req.method === 'POST' && m) {
      const r = await controller.openDoor(decodeURIComponent(m[1]), {
        requestedBy: body.requestedBy || null,
        reason: body.reason || '',
        force: body.force === true,
        permissions: Array.isArray(body.permissions) ? body.permissions : null,
        mode: body.mode === 'remote' ? 'remote' : 'manual',
        side: body.side === 'out' ? 'out' : 'in',
        commandId: body.commandId || null
      });
      const { status, ...rest } = r;
      return send(res, status || (r.ok ? 200 : 400), rest);
    }

    m = p.match(/^\/edge\/approvals\/([^/]+)$/);
    if (req.method === 'POST' && m) {
      const r = await controller.resolveApproval(decodeURIComponent(m[1]), {
        approve: body.approve === true,
        requestedBy: body.requestedBy || null,
        permissions: Array.isArray(body.permissions) ? body.permissions : null,
        force: body.force === true,
        reason: body.reason || ''
      });
      const { status, ...rest } = r;
      return send(res, status || (r.ok ? 200 : 400), rest);
    }

    if (req.method === 'POST' && p === '/edge/sim/input') {
      const r = controller.simInput(String(body.doorId || ''), String(body.input || body.name || ''), body.value);
      const { status, ...rest } = r;
      return send(res, status || (r.ok ? 200 : 400), rest);
    }

    return send(res, 404, { ok: false, code: 'NOT_FOUND', message: `${req.method} ${p} no existe` });
  };

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error('Error en la API LAN', { error: err.message });
      if (!res.headersSent) send(res, err.status || 500, { ok: false, code: 'INTERNAL', message: err.message });
    });
  });
}

module.exports = { createLanServer };
