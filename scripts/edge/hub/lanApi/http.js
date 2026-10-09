'use strict';

/**
 * HTTP chico de la API LAN: JSON, cuerpo y CORS de mismo origen.
 * El navegador de la app (servida por este hub) no necesita CORS; si manda Origin,
 * solo se refleja cuando coincide con Host. Otro origen no recibe Allow-Origin.
 */

const MAX_BODY = 1024 * 1024;

function clientIp(req) {
  const raw = (req.socket && req.socket.remoteAddress) || '';
  return String(raw).replace(/^::ffff:/, '') || 'desconocida';
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  let same = false;
  try {
    same = Boolean(req.headers.host) && new URL(origin).host === req.headers.host;
  } catch (_) {
    same = false;
  }
  if (!same) return { vary: 'Origin' };
  return {
    vary: 'Origin',
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS'
  };
}

function sendJson(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extra
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('El pedido es demasiado grande'), { status: 413, code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    const data = JSON.parse(raw.toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw Object.assign(new Error('El pedido no es un JSON válido'), { status: 400, code: 'BAD_JSON' });
    }
    return data;
  } catch (err) {
    if (err.status) throw err;
    throw Object.assign(new Error('El pedido no es un JSON válido'), { status: 400, code: 'BAD_JSON' });
  }
}

module.exports = { clientIp, corsHeaders, sendJson, readBody, readJson, MAX_BODY };
