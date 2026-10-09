'use strict';

/**
 * Servidor HTTP LAN del hub (hito 1).
 *
 * Para controladores (requests firmadas Ed25519, solo equipos de la allowlist):
 *   POST /edge/events           { deviceId, events:[{id, seq, ...}], configVersionApplied? } → { ackSeq }
 *   GET  /edge/config/head      → head firmado por la nube (el último aplicado)
 *   GET  /edge/config/chunks?names=a,b → { chunks:{ name:{v, hash, body} } }
 * Público en la LAN:
 *   GET  /edge/status           estado resumido del hub (sin secretos)
 *   GET  /api/runtime           { mode:'lan', capabilities:[] }   (API de guardia completa = T7)
 *   /api/*                      501 EDGE_UNSUPPORTED
 *   resto                       archivos estáticos de `staticDir` (build del frontend, fallback SPA)
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const MAX_BODY = 8 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json'
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body demasiado grande'), { status: 413, code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function serveStatic(staticDir, urlPath, res) {
  if (!staticDir) return sendJson(res, 404, { code: 'NOT_FOUND' });
  const root = path.resolve(staticDir);
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (_) { return sendJson(res, 400, { code: 'BAD_PATH' }); }
  let file = path.resolve(root, `.${rel}`);
  if (file !== root && !file.startsWith(root + path.sep)) return sendJson(res, 403, { code: 'FORBIDDEN' });
  let stat = null;
  try { stat = fs.statSync(file); } catch (_) { stat = null; }
  if (stat && stat.isDirectory()) {
    file = path.join(file, 'index.html');
    try { stat = fs.statSync(file); } catch (_) { stat = null; }
  }
  if (!stat) {
    // Fallback SPA: rutas del router del frontend → index.html (no para archivos con extensión).
    if (path.extname(rel)) return sendJson(res, 404, { code: 'NOT_FOUND' });
    file = path.join(root, 'index.html');
    try { stat = fs.statSync(file); } catch (_) { return sendJson(res, 404, { code: 'NOT_FOUND' }); }
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
  });
  fs.createReadStream(file).pipe(res);
  return undefined;
}

/**
 * @param {{ hub:object, verifier:import('./lanSignCompat').LanVerifier, staticDir?:string|null, log?:object }} opts
 *   hub expone: ingestFromController(deviceId, body) → {ackSeq}, configSync, status()
 */
function createLanServer({ hub, verifier, staticDir = null, log = console }) {
  async function handle(req, res) {
    const url = req.url || '/';
    const pathname = url.split('?')[0];
    const method = req.method || 'GET';

    if (pathname.startsWith('/edge/')) {
      if (method === 'GET' && pathname === '/edge/status') return sendJson(res, 200, hub.status());
      const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      const v = verifier.verify({ method, url, headers: req.headers, body });
      if (!v.ok) return sendJson(res, v.code === 'DEVICE_NOT_ENROLLED' ? 403 : 401, { code: v.code });

      if (method === 'POST' && pathname === '/edge/events') {
        let data;
        try { data = JSON.parse(body.toString('utf8') || '{}'); } catch (_) { return sendJson(res, 400, { code: 'BAD_JSON' }); }
        if (data.deviceId && String(data.deviceId) !== v.deviceId) return sendJson(res, 403, { code: 'DEVICE_MISMATCH' });
        try {
          return sendJson(res, 200, hub.ingestFromController(v.deviceId, data));
        } catch (err) {
          if (err.code === 'EVENT_INVALID' || err.code === 'DEVICE_MISMATCH') return sendJson(res, 400, { code: err.code, message: err.message });
          throw err;
        }
      }
      if (method === 'GET' && pathname === '/edge/config/head') {
        hub.controllers.markSeen(v.deviceId);
        const head = hub.configSync.servedHead();
        return head ? sendJson(res, 200, head) : sendJson(res, 404, { code: 'NO_CONFIG' });
      }
      if (method === 'GET' && pathname === '/edge/config/chunks') {
        const q = new URL(url, 'http://hub').searchParams.get('names') || '';
        const names = q.split(',').map((s) => s.trim()).filter(Boolean);
        return sendJson(res, 200, { chunks: hub.configSync.chunksForController(names) });
      }
      return sendJson(res, 404, { code: 'NOT_FOUND' });
    }

    if (pathname === '/api/runtime') return sendJson(res, 200, { mode: 'lan', capabilities: [], hubId: hub.deviceId });
    if (pathname === '/api' || pathname.startsWith('/api/')) return sendJson(res, 501, { code: 'EDGE_UNSUPPORTED' });
    if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED' });
    return serveStatic(staticDir, pathname, res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err.status) return sendJson(res, err.status, { code: err.code });
      log.error(`[hub] LAN ${req.method} ${req.url}: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, 500, { code: 'INTERNAL' });
      return undefined;
    });
  });
  // Los equipos reusan conexiones cada ~5 s: con el default de Node (5 s) se cortan en carrera.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  return server;
}

module.exports = { createLanServer };
