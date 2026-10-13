#!/usr/bin/env node
'use strict';

/**
 * Enrolamiento del banco (Etapa 2, Hito 1) contra la API local o la nube. Ver docs/ETAPA2-BANCO.md.
 *
 *   1) Clave de firma de la nube (una sola vez; la API local debe arrancar con ella):
 *        node scripts/edge/tools/enroll-local.js clave-nube [--dir C:/mss-edge]
 *
 *   2) Alta + enrolamiento de hub y controlador, asignación de la puerta y archivos de config:
 *        $env:MSS_ADMIN_PASSWORD = '...'      (o se pregunta por consola)
 *        node scripts/edge/tools/enroll-local.js enrolar --api http://127.0.0.1:5057/api --user admin \
 *             --door puerta-p1 [--dir C:/mss-edge] [--site principal] [--hub-port 8080] [--ctl-port 8790] \
 *             [--sr201 192.168.0.38:6722:1] [--pulse 3]
 *
 * Genera (sin pisar si ya existen):
 *   <dir>/nube/firma-ed25519.pem         privada de la "nube" local (NO copiar a otros equipos)
 *   <dir>/hub/keys/hub.key.pem           clave del hub        <dir>/hub/config.json
 *   <dir>/controller/claves/*.pem|pub    claves del controlador, pública del hub y de la nube
 *   <dir>/controller/config.json
 * Los refresh tokens van solo a los config (el hub lo rota y lo guarda cifrado en su SQLite).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { generateKeyPair } = require('../hub/keys');

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.includes('=') ? [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a.slice(2), argv[i + 1]];
      if (!a.includes('=')) i += 1;
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

const keyIdOf = (publicKey) => crypto.createHash('sha256')
  .update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);

function writeIfMissing(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
  return true;
}

function signingKey(dir, { create = false } = {}) {
  const file = path.join(dir, 'nube', 'firma-ed25519.pem');
  if (!fs.existsSync(file)) {
    if (!create) throw new Error(`No existe ${file}. Primero: node scripts/edge/tools/enroll-local.js clave-nube --dir ${dir}`);
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    writeIfMissing(file, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 0o600);
  }
  const priv = crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));
  const pub = crypto.createPublicKey(priv);
  return { file, keyId: keyIdOf(pub), publicKeyPem: pub.export({ type: 'spki', format: 'pem' }).toString() };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function api(base, method, p, { token, body } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`${method} ${p} → ${res.status} ${(data && (data.message || data.code)) || text}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

async function claveNube(o) {
  const dir = path.resolve(o.dir || 'C:/mss-edge');
  const k = signingKey(dir, { create: true });
  console.log(`Clave de firma de la nube: ${k.file}\nkeyId: ${k.keyId}\n`);
  console.log('Antes de arrancar la API local, en la MISMA ventana de PowerShell:');
  console.log(`  $env:EDGE_SIGNING_PRIVATE_KEY = Get-Content -Raw "${k.file}"`);
  console.log('  node <scratch>/local-api.js C:/Users/Admin/Desktop/LG/functions 5057');
}

async function enrolar(o) {
  const dir = path.resolve(o.dir || 'C:/mss-edge');
  const base = String(o.api || 'http://127.0.0.1:5057/api').replace(/\/+$/, '');
  const site = o.site || 'principal';
  const doorId = o.door;
  if (!doorId) throw new Error('Falta --door <id de la puerta> (ver Admin → Puertas)');
  const hubPort = Number(o['hub-port'] || 8080);
  const ctlPort = Number(o['ctl-port'] || 8790);
  const [srHost, srPort, srCh] = String(o.sr201 || '192.168.0.38:6722:1').split(':');
  const nube = signingKey(dir);

  const user = o.user || 'admin';
  const password = process.env.MSS_ADMIN_PASSWORD || await ask(`Contraseña de ${user}: `);
  const { token } = await api(base, 'POST', '/auth/login', { body: { username: user, password } });
  console.log(`✔ sesión de ${user}`);

  // Puerta: debe existir; se le asigna el controlador después del alta.
  const doorsCfg = await api(base, 'GET', '/admin/doors-config', { token });
  const doors = (doorsCfg.config && doorsCfg.config.doors) || [];
  if (!doors.some((d) => d.id === doorId)) {
    throw new Error(`La puerta "${doorId}" no existe. Puertas: ${doors.map((d) => d.id).join(', ') || '(ninguna)'}`);
  }

  const hubKeys = generateKeyPair();
  const ctlKeys = generateKeyPair();
  const mk = (body) => api(base, 'POST', '/admin/devices', { token, body: { siteId: site, ...body } });
  const hubDev = await mk({ kind: 'hub', name: 'Hub banco' });
  const ctlDev = await mk({ kind: 'controller', name: `Controlador banco (${doorId})`, doorIds: [doorId] });
  const enroll = (code, keys, kind) => api(base, 'POST', '/edge/v1/enroll', {
    body: { code, publicKey: keys.publicKeyRaw, kind, hostname: require('os').hostname() }
  });
  const hub = await enroll(hubDev.enrollment.code, hubKeys, 'hub');
  const ctl = await enroll(ctlDev.enrollment.code, ctlKeys, 'controller');
  console.log(`✔ hub ${hub.deviceId} y controlador ${ctl.deviceId} enrolados`);

  const updatedDoors = doors.map((d) => (d.id === doorId ? { ...d, controllerId: ctl.deviceId } : d));
  await api(base, 'PUT', '/admin/doors-config', { token, body: { doors: updatedDoors, airlockGroups: doorsCfg.config.airlockGroups || [] } });
  console.log(`✔ puerta ${doorId} → controllerId ${ctl.deviceId} (la nube recompila el bundle)`);

  // Verificación de la clave de firma con un token del controlador (no usa la nube en el Hito 1).
  const ts = Date.now();
  const sig = crypto.sign(null, Buffer.from(`mss-edge-token\n${ctl.deviceId}\n${ts}`), crypto.createPrivateKey(ctlKeys.privateKeyPem)).toString('base64');
  const tok = await api(base, 'POST', '/edge/v1/token', { body: { deviceId: ctl.deviceId, ts, signature: sig, refreshToken: ctl.refreshToken } });
  const head = await api(base, 'GET', '/edge/v1/head', { token: tok.token });
  const headKeyId = (head.head && head.head.keyId) || head.keyId;
  if (headKeyId !== nube.keyId) {
    console.warn(`⚠ La API firma con keyId ${headKeyId} pero ${nube.file} es ${nube.keyId}.`);
    console.warn('  Reiniciá la API local con $env:EDGE_SIGNING_PRIVATE_KEY (ver "clave-nube") o el hub rechazará la config.');
  } else {
    console.log(`✔ la API firma con la clave del banco (keyId ${headKeyId}), config v${head.head && head.head.version}`);
  }

  // ── archivos del hub ──
  const hubDir = path.join(dir, 'hub');
  fs.mkdirSync(path.join(hubDir, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(hubDir, 'keys', 'hub.key.pem'), hubKeys.privateKeyPem, { mode: 0o600 });
  writeJson(path.join(hubDir, 'config.json'), {
    deviceId: hub.deviceId,
    siteId: site,
    privateKeyFile: './keys/hub.key.pem',
    dataDir: './data',
    retentionDays: 90,
    lan: { host: '0.0.0.0', port: hubPort, staticDir: null, publicUrl: null },
    cloud: {
      baseUrl: base,
      refreshToken: hub.refreshToken,
      headPublicKeys: { [nube.keyId]: nube.publicKeyPem },
      allowUnsignedHeads: false,
      headPollMs: 15000,
      eventsIntervalMs: 30000,
      commandsPollMs: 10000,
      liveMinIntervalMs: 60000,
      heartbeatMs: 60000,
      timeoutMs: 10000
    },
    controllers: [{ deviceId: ctl.deviceId, publicKey: ctlKeys.publicKeyRaw, url: `http://127.0.0.1:${ctlPort}`, doorIds: [doorId] }]
  });

  // ── archivos del controlador ──
  const ctlDir = path.join(dir, 'controller');
  fs.mkdirSync(path.join(ctlDir, 'claves'), { recursive: true });
  fs.writeFileSync(path.join(ctlDir, 'claves', 'device-key.pem'), ctlKeys.privateKeyPem, { mode: 0o600 });
  fs.writeFileSync(path.join(ctlDir, 'claves', 'hub.pub'), hubKeys.publicKeyPem);
  fs.writeFileSync(path.join(ctlDir, 'claves', 'nube-head.pub'), nube.publicKeyPem);
  fs.writeFileSync(path.join(ctlDir, 'claves', 'cloud-refresh.txt'), `${tok.refreshToken}\n`, { mode: 0o600 });
  writeJson(path.join(ctlDir, 'config.json'), {
    deviceId: ctl.deviceId,
    siteId: site,
    dataDir: './data',
    logFile: './data/mss-edge-controller.log',
    logLevel: 'info',
    keys: { privateKeyFile: './claves/device-key.pem' },
    hub: { url: `http://127.0.0.1:${hubPort}`, deviceId: hub.deviceId, publicKey: './claves/hub.pub', configPollMs: 300000, heartbeatMs: 5000 },
    cloud: { headPublicKeys: { [nube.keyId]: './claves/nube-head.pub' }, allowUnsignedConfig: false },
    lan: { port: ctlPort, bind: '127.0.0.1', allowUnsigned: false },
    clock: { trusted: 'auto', maxDriftMs: 120000 },
    interlock: { enabled: false },
    simulation: { enabled: true },
    cooldownMs: 3000,
    doors: [{
      id: doorId,
      readers: [],
      output: { driver: 'sr201', host: srHost, port: Number(srPort) || 6722, channel: Number(srCh) || 1, pulseSeconds: Number(o.pulse || 3), offRetryDelaysMs: [300, 1000, 3000] },
      inputs: { driver: 'none' }
    }]
  });

  console.log(`\nListo. Archivos en ${dir}`);
  console.log(`  Hub:          node scripts/edge/mss-edge.js --role=hub --config "${path.join(hubDir, 'config.json')}"`);
  console.log(`  Controlador:  node scripts/edge/mss-edge.js --role=controller --config "${path.join(ctlDir, 'config.json')}" --stdin-reader ${doorId}`);
}

async function main() {
  const o = args(process.argv.slice(2));
  const cmd = o._[0];
  if (cmd === 'clave-nube') return claveNube(o);
  if (cmd === 'enrolar') return enrolar(o);
  console.log('Uso:\n  enroll-local.js clave-nube [--dir C:/mss-edge]\n  enroll-local.js enrolar --api http://127.0.0.1:5057/api --user admin --door puerta-p1 [--dir C:/mss-edge]');
  return null;
}

main().catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
