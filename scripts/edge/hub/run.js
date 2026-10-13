#!/usr/bin/env node
'use strict';

/**
 * Arranque directo del hub para el banco (hasta que `mss-edge.js --role=hub` lo reemplace).
 *
 *   node edge/hub/run.js <config.json>
 *   node edge/hub/run.js --keygen <archivo-clave.pem>   genera el par Ed25519 del equipo
 *                                                       e imprime la clave pública (para la nube/controladores)
 */

const fs = require('fs');
const path = require('path');
const { startHub } = require('./index');
const { generateKeyPair, privateKeyFrom } = require('./keys');

async function main(argv) {
  if (argv[0] === '--keygen') {
    const out = argv[1];
    if (!out) throw new Error('uso: --keygen <archivo-clave.pem>');
    if (fs.existsSync(out)) {
      const pub = require('crypto').createPublicKey(privateKeyFrom(fs.readFileSync(out, 'utf8')));
      console.log(`Ya existe ${out}. Clave pública:\n${pub.export({ format: 'pem', type: 'spki' })}`);
      return;
    }
    const kp = generateKeyPair();
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, kp.privateKeyPem, { mode: 0o600 });
    console.log(`Clave privada: ${out}\nClave pública (base64): ${kp.publicKeyRaw}\n${kp.publicKeyPem}`);
    return;
  }
  const file = argv[0];
  if (!file) throw new Error('uso: node edge/hub/run.js <config.json>');
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const cfg = JSON.parse(text);
  delete cfg._comentarios;
  const hub = await startHub(cfg, { baseDir: path.dirname(path.resolve(file)) });
  const shutdown = async (sig) => {
    console.log(`[hub] ${sig}: cerrando`);
    try { await hub.stop(); } finally { process.exit(0); }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`[hub] ${err.stack || err.message}`);
  process.exit(1);
});
