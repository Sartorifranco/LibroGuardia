'use strict';

/**
 * Arranque del controlador: `node scripts/edge/mss-edge.js --role=controller --config <archivo>`.
 *
 * Opciones extra:
 *   --print-key              muestra la clave pública del equipo (la crea si no existe) y sale
 *   --import-bundle <json>   aplica un bundle firmado {head, chunks:{name:body}} sin hub (banco) y sale
 *   --stdin-reader <doorId>  agrega un lector por consola en esa puerta (pegar DNI/QR + Enter)
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, loadOrCreateDeviceKey } = require('./config');
const { Controller } = require('./controller');
const { createLanServer } = require('./lanApi');
const { createLogger } = require('../drivers/logger');
const { installFatalHandlers } = require('../../lib/fatalHandlers');

const argValue = (args, name) => {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return null;
  const a = args[i];
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1] || null;
};

async function main({ configPath, args = [] } = {}) {
  if (!configPath) throw new Error('Falta --config <archivo.json>');
  const config = loadConfig(configPath);
  const logger = createLogger({ logFile: config.logFile, level: config.logLevel, tag: config.deviceId });
  installFatalHandlers((level, message, extra) => logger.error(message, extra));
  fs.mkdirSync(config.dataDir, { recursive: true });
  const key = loadOrCreateDeviceKey(config.keys.privateKeyFile);
  if (key.created) logger.warn('Clave del equipo creada. Registrá la pública en el hub/Admin.', { file: config.keys.privateKeyFile });

  if (args.includes('--print-key')) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ deviceId: config.deviceId, publicKey: key.publicKeyB64 }, null, 2));
    return null;
  }

  const stdinDoor = argValue(args, '--stdin-reader');
  if (stdinDoor) {
    const door = config.doors.find((d) => d.id === stdinDoor);
    if (!door) throw new Error(`--stdin-reader: la puerta ${stdinDoor} no está en la config`);
    door.readers.push({ id: `${stdinDoor}-stdin`, driver: 'stdin', side: 'in' });
  }

  const controller = new Controller({ config, privateKeyPem: key.privateKeyPem, logger });

  const bundleFile = argValue(args, '--import-bundle');
  if (bundleFile) {
    const bundle = JSON.parse(fs.readFileSync(path.resolve(bundleFile), 'utf8'));
    const ok = controller.verifyHead(bundle.head);
    if (!ok) throw new Error('Bundle rechazado: firma de la nube inválida');
    const { secrets, ...bodies } = bundle.chunks || {};
    const r = controller.edge.chunks.applyHead(bundle.head, bodies);
    if (r.applied || r.reason === 'up_to_date') controller.configSync.applySecrets(bundle.head, secrets);
    controller.edge.snapshot.refresh();
    if (r.applied) controller.record({ type: 'config_applied', reason: 'config_aplicada', payload: { version: r.version, changed: r.changed, source: 'import-bundle' } });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(r));
    controller.close();
    return null;
  }

  await controller.start();
  const server = createLanServer({ controller, config, logger: logger.child('lan') });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.lan.port, config.lan.bind, resolve);
  });
  logger.info(`Controlador ${config.deviceId} listo`, {
    lan: `${config.lan.bind}:${config.lan.port}`,
    doors: config.doors.map((d) => d.id),
    configVersion: controller.edge.chunks.configVersion(),
    hub: config.hub.url
  });
  if (config.lan.allowUnsigned) logger.warn('API LAN SIN FIRMA (lan.allowUnsigned=true): solo para pruebas');

  const shutdown = async (signal) => {
    logger.info(`Apagando (${signal})`);
    server.close();
    await controller.stop().catch(() => {});
    controller.close();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  return { controller, server };
}

module.exports = { main, Controller, createLanServer };
