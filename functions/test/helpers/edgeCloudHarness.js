'use strict';

/**
 * Nube "de verdad" para tests del edge: app Express (functions/app.js o los routers pedidos)
 * sobre el Firestore en memoria con contadores de facturación (countingFirestore), con
 * firebase-admin auth stub (createCustomToken) y notificaciones stub.
 *
 *   const cloud = await startEdgeCloud({ initial, routers: null });   // null = app.js completa
 *   cloud.baseUrl, cloud.request(method, path, {token, body}), cloud.fs.stats, cloud.stop(), cloud.restart()
 *
 * `stop()` cierra el puerto (simula "sin internet") sin perder los datos; `restart()` vuelve a
 * escuchar en el MISMO puerto.
 */

const path = require('path');
const http = require('http');
const { createCountingFirestore } = require('./countingFirestore');
const { purgeFunctionsModules, stubModule } = require('./routeHarness');

const firestorePath = require.resolve('../../firestore');
const FUNCTIONS_DIR = path.resolve(__dirname, '..', '..');

function installCountingFirestore({ initial = {}, notifySafe = () => {}, customTokens = [] } = {}) {
  purgeFunctionsModules();
  const fs = createCountingFirestore(initial);
  const admin = {
    auth: () => ({
      createCustomToken: async (uid, claims) => {
        customTokens.push({ uid, claims });
        return `fb-custom-${uid}`;
      }
    })
  };
  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: { admin, db: fs.db, FieldValue: fs.FieldValue, Timestamp: fs.Timestamp }
  };
  stubModule('lib/notifications/index.js', { notifySafe, onAdminAuditLogged: async () => {} });
  return fs;
}

async function startEdgeCloud({ initial = {}, routers = null, notifySafe, port = 0 } = {}) {
  const customTokens = [];
  const fs = installCountingFirestore({ initial, notifySafe, customTokens });
  let app;
  if (routers) {
    const express = require('express');
    app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '5mb' }));
    routers.forEach((rel) => app.use(require(path.join(FUNCTIONS_DIR, rel))));
  } else {
    app = require(path.join(FUNCTIONS_DIR, 'app.js'));
  }
  let server = null;
  const sockets = new Set();
  const listen = (p) => new Promise((resolve, reject) => {
    server = http.createServer(app);
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.once('error', reject);
    server.listen(p, '127.0.0.1', () => resolve(server.address().port));
  });
  const boundPort = await listen(port);
  const baseUrl = `http://127.0.0.1:${boundPort}`;

  const request = async (method, urlPath, { token, body, headers = {} } = {}) => {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, text };
  };

  const stop = () => new Promise((resolve) => {
    if (!server) return resolve();
    const s = server;
    server = null;
    for (const sock of sockets) sock.destroy();
    s.close(() => resolve());
  });

  return {
    app,
    fs,
    baseUrl,
    port: boundPort,
    customTokens,
    request,
    stop,
    restart: () => listen(boundPort),
    isUp: () => Boolean(server)
  };
}

module.exports = { startEdgeCloud, installCountingFirestore };
