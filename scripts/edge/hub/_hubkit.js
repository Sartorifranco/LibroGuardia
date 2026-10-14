'use strict';

/**
 * Utilidades de los tests del hub (no es un test): nube falsa (HTTP real en un puerto efímero),
 * controlador falso, armado de un hub con base temporal.
 */

const http = require('http');
const path = require('path');
const { SKIP, tmpDir, rmDir, makeHead, doorsBody } = require('../lib/db/_testkit');
const { generateKeyPair, sign, verify } = require('./keys');
const { signedPayload } = require('./headSignature');
const { tokenSigningPayload } = require('./cloudClient');
const { LanVerifier, signRequest } = require('./lanSignCompat');
const { Hub, normalizeConfig } = require('./index');

const quietLog = { info() {}, warn() {}, error() {} };

function fakeJwt(expMs) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none' })}.${b({ exp: Math.floor(expMs / 1000), sub: 'hub' })}.x`;
}

function readJson(req) {
  return new Promise((resolve) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      const t = Buffer.concat(parts).toString('utf8');
      resolve(t ? JSON.parse(t) : null);
    });
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

/** Head firmado con la clave de la nube. */
function signHead(head, cloudKeys, keyId = 'k1') {
  const h = { ...head, keyId };
  h.sig = sign(cloudKeys.privateKey, signedPayload(h));
  return h;
}

/**
 * Nube falsa con el contrato de T4. Estado inspeccionable en `cloud.*`.
 */
async function startFakeCloud({ hubPublicKey, refreshToken = 'rt-0', deviceId = 'hub-1' }) {
  const cloud = {
    deviceId,
    hubPublicKey,
    refreshToken,
    usedRefreshTokens: [],
    token: null,
    tokenCalls: 0,
    offline: false,
    head: null,
    pendingCommands: undefined,
    bodies: {},
    chunkRequests: [],
    eventPosts: [],
    eventFail: 0, // cantidad de próximos POST /events que responden 500 (después de recibirlos)
    ackMode: 'to',
    heartbeats: [],
    lives: [],
    commands: [],
    commandsStatus: 200,
    commandResults: [],
    commandPolls: 0,
    requests: []
  };
  const server = http.createServer(async (req, res) => {
    if (cloud.offline) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url, 'http://cloud');
    const p = url.pathname;
    cloud.requests.push(`${req.method} ${p}`);
    const body = req.method === 'POST' ? await readJson(req) : null;
    if (p === '/api/edge/v1/token') {
      cloud.tokenCalls += 1;
      const okSig = body && body.deviceId === cloud.deviceId && Math.abs(Date.now() - body.ts) < 120000
        && verify(cloud.hubPublicKey, tokenSigningPayload(body.deviceId, body.ts), body.signature);
      if (!okSig) return send(res, 401, { code: 'BAD_DEVICE_SIGNATURE' });
      if (body.refreshToken !== cloud.refreshToken) return send(res, 401, { code: 'BAD_REFRESH_TOKEN' });
      cloud.usedRefreshTokens.push(cloud.refreshToken);
      cloud.refreshToken = `rt-${cloud.tokenCalls}`;
      cloud.token = `${fakeJwt(Date.now() + 3600 * 1000)}${cloud.tokenCalls}`;
      return send(res, 200, { token: cloud.token, refreshToken: cloud.refreshToken, firebaseToken: 'fb-custom' });
    }
    if (req.headers.authorization !== `Bearer ${cloud.token}`) return send(res, 401, { code: 'UNAUTHENTICATED' });
    if (p === '/api/edge/v1/head') {
      if (!cloud.head) return send(res, 404, { code: 'NO_HEAD' });
      return send(res, 200, cloud.pendingCommands === undefined ? { head: cloud.head } : { head: cloud.head, pendingCommands: cloud.pendingCommands });
    }
    if (p === '/api/edge/v1/chunks') {
      const names = (url.searchParams.get('names') || '').split(',').filter(Boolean);
      cloud.chunkRequests.push(names);
      const chunks = {};
      for (const n of names) if (cloud.bodies[n] !== undefined) chunks[n] = { v: cloud.head.chunks[n].v, hash: cloud.head.chunks[n].hash, body: cloud.bodies[n] };
      return send(res, 200, { chunks });
    }
    if (p === '/api/edge/v1/events') {
      cloud.eventPosts.push(body);
      if (cloud.eventFail > 0) {
        cloud.eventFail -= 1;
        return send(res, 500, { code: 'INTERNAL' });
      }
      return send(res, 200, { ackHubSeq: cloud.ackMode === 'to' ? body.hubSeqTo : cloud.ackMode(body) });
    }
    if (p === '/api/edge/v1/heartbeat') {
      cloud.heartbeats.push(body);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/edge/v1/live') {
      cloud.lives.push(body);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/edge/v1/commands' && req.method === 'GET') {
      cloud.commandPolls += 1;
      if (cloud.commandsStatus !== 200) return send(res, cloud.commandsStatus, { code: 'NOPE' });
      return send(res, 200, { commands: cloud.commands });
    }
    const m = p.match(/^\/api\/edge\/v1\/commands\/([^/]+)\/result$/);
    if (m) {
      cloud.commandResults.push({ id: decodeURIComponent(m[1]), ...body });
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { code: 'NOT_FOUND' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cloud.url = `http://127.0.0.1:${server.address().port}`;
  cloud.close = () => new Promise((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
  /** Publica un head nuevo con estos cuerpos (firmado). */
  cloud.publish = (version, bodies, cloudKeys, extra = {}) => {
    cloud.bodies = { ...bodies };
    cloud.head = signHead({ ...makeHead(version, bodies), ...extra }, cloudKeys);
    return cloud.head;
  };
  return cloud;
}

/** Controlador falso: verifica la firma del hub y registra lo que recibe. */
async function startFakeController({ deviceId, hubDeviceId, hubPublicKey, configVersionApplied = 0 }) {
  const ctl = { deviceId, notifies: [], opens: [], approvals: [], statusCalls: 0, rejected: 0, configVersionApplied, openResponse: null, approvalResponse: null };
  const verifier = new LanVerifier({ publicKeyFor: (id) => (id === hubDeviceId ? hubPublicKey : null) });
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const c of req) parts.push(c);
    const raw = Buffer.concat(parts);
    const v = verifier.verify({ method: req.method, url: req.url, headers: req.headers, body: raw });
    if (!v.ok) {
      ctl.rejected += 1;
      return send(res, 401, { code: v.code });
    }
    const body = raw.length ? JSON.parse(raw.toString('utf8')) : null;
    if (req.url === '/edge/config/notify') {
      ctl.notifies.push(body);
      return send(res, 200, { ok: true });
    }
    if (req.url === '/edge/status') {
      ctl.statusCalls += 1;
      return send(res, 200, { deviceId, configVersionApplied: ctl.configVersionApplied });
    }
    const m = req.url.match(/^\/edge\/doors\/([^/]+)\/open$/);
    if (m) {
      ctl.opens.push({ doorId: decodeURIComponent(m[1]), ...body });
      return send(res, 200, ctl.openResponse || { ok: true, relayConfirmed: true, doorOpened: true });
    }
    const a = req.url.match(/^\/edge\/approvals\/([^/]+)$/);
    if (a) {
      ctl.approvals.push({ approvalId: decodeURIComponent(a[1]), ...body });
      const r = ctl.approvalResponse || { ok: true, relayConfirmed: true, eventId: `${deviceId}:apr` };
      const { status, ...rest } = r;
      return send(res, status || 200, rest);
    }
    return send(res, 404, { code: 'NOT_FOUND' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  ctl.url = `http://127.0.0.1:${server.address().port}`;
  ctl.close = () => new Promise((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
  return ctl;
}

/** Request firmada controlador → hub. */
async function ctlRequest(hubUrl, { method = 'GET', path: p, body, deviceId, privateKey, headers = {}, now }) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const sig = privateKey ? signRequest({ method, path: p, body: text, deviceId, privateKey, now }) : {};
  const res = await fetch(`${hubUrl}${p}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...sig, ...headers },
    body: body === undefined ? undefined : text
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null, headers: sig };
}

/** Eventos de controlador sintéticos. */
function mkEvents(deviceId, fromSeq, count, extra = {}) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const seq = fromSeq + i;
    out.push({ id: `${deviceId}:${seq}`, seq, ts: 1_700_000_000_000 + seq * 1000, doorId: 'p1', side: 'in', type: 'access', decision: 'deny', reason: 'credencial_desconocida', ...extra });
  }
  return out;
}

/**
 * Arma un hub de test con base temporal. Devuelve { hub, url, dir, file, keys... }.
 */
async function buildHub({ dir, cloud, cloudKeys, hubKeys, controllers = [], extraConfig = {}, now, lan = true }) {
  const cfg = normalizeConfig({
    deviceId: 'hub-1',
    siteId: 'principal',
    privateKey: hubKeys.privateKeyPem,
    dataDir: dir,
    lan: { host: '127.0.0.1', port: 0, ...(extraConfig.lan || {}) },
    cloud: {
      baseUrl: cloud ? cloud.url : null,
      refreshToken: 'rt-0',
      headPublicKeys: { k1: cloudKeys ? cloudKeys.publicKeyPem : undefined },
      timeoutMs: 3000,
      ...(extraConfig.cloud || {})
    },
    controllers
  });
  const hub = new Hub(cfg, { log: quietLog, ...(now ? { now } : {}) });
  let url = null;
  if (lan) {
    const addr = await hub.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${addr.port}`;
  }
  return { hub, url, file: cfg.dbFile };
}

module.exports = {
  SKIP, tmpDir, rmDir, makeHead, doorsBody, path,
  generateKeyPair, quietLog, signHead, startFakeCloud, startFakeController, ctlRequest, mkEvents, buildHub
};
