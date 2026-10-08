#!/usr/bin/env node
'use strict';

/**
 * mss-edge — entrada única del edge (docs/ETAPA2-DISENO.md §1).
 *
 *   node scripts/edge/mss-edge.js --role=controller --config C:\mss-edge\controller.json
 *   node scripts/edge/mss-edge.js --role=hub        --config /etc/mss-edge/hub.json
 *
 * role=controller → ./controller (este repo, T5).
 * role=hub        → ./hub (T6). Contrato: el módulo exporta `main({configPath, args})` (async).
 */

const path = require('path');

const USAGE = 'Uso: mss-edge --role=controller|hub --config <archivo.json> [opciones]';

function parseArgs(argv) {
  const out = { role: null, configPath: null, rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--role=')) out.role = a.slice(7);
    else if (a === '--role') out.role = argv[++i];
    else if (a.startsWith('--config=')) out.configPath = a.slice(9);
    else if (a === '--config') out.configPath = argv[++i];
    else out.rest.push(a);
  }
  return out;
}

function loadRole(role) {
  if (role === 'controller') return require('./controller');
  if (role === 'hub') {
    let resolved;
    try {
      resolved = require.resolve('./hub');
    } catch (err) {
      const e = new Error('El rol "hub" no está instalado en esta copia (falta scripts/edge/hub). Actualizá el repo o usá --role=controller.');
      e.code = 'HUB_MISSING';
      throw e;
    }
    return require(resolved);
  }
  const e = new Error(`Rol desconocido "${role}". ${USAGE}`);
  e.code = 'BAD_ROLE';
  throw e;
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.role || args.rest.includes('--help') || args.rest.includes('-h')) {
    // eslint-disable-next-line no-console
    console.log(USAGE);
    return args.role ? 0 : 2;
  }
  const mod = loadRole(args.role);
  if (typeof mod.main !== 'function') throw new Error(`El módulo del rol "${args.role}" no exporta main()`);
  await mod.main({ configPath: args.configPath ? path.resolve(args.configPath) : null, args: args.rest });
  return 0;
}

if (require.main === module) {
  run().then((code) => {
    if (code) process.exitCode = code;
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[mss-edge] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { run, parseArgs, loadRole };
