'use strict';

/**
 * Config local del controlador (archivo JSON, ver config.ejemplo.json).
 *
 * La config local define SOLO el hardware y la conexión: qué puertas maneja este equipo y con
 * qué drivers. Derechos, horarios, estancos, unlockSec, etc. vienen del bundle firmado por la nube.
 */

const fs = require('fs');
const path = require('path');
const lanSign = require('../lib/lanSign');

const DEFAULTS = Object.freeze({
  lanPort: 8790,
  lanBind: '0.0.0.0',
  configPollMs: 5 * 60 * 1000,
  heartbeatMs: 5000,
  cooldownMs: 3000,
  approvalTtlMs: 60 * 1000,
  maxDriftMs: 2 * 60 * 1000,
  clockSampleMaxAgeMs: 6 * 60 * 60 * 1000
});

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.code = 'CONFIG_INVALID';
  }
}

const readKey = (value, baseDir) => {
  if (!value) return null;
  const s = String(value).trim();
  if (s.startsWith('-----BEGIN') || /^[A-Za-z0-9+/=]{40,}$/.test(s)) return s;
  const file = path.resolve(baseDir, s);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  throw new ConfigError(`No se encontró la clave "${s}"`);
};

/** Normaliza y valida. `baseDir` = carpeta del archivo (las rutas relativas se resuelven contra ella). */
function normalizeConfig(raw = {}, baseDir = process.cwd()) {
  const errors = [];
  const deviceId = String(raw.deviceId || '').trim();
  if (!deviceId) errors.push('falta deviceId');
  const doors = Array.isArray(raw.doors) ? raw.doors : [];
  if (!doors.length) errors.push('doors: el controlador necesita al menos una puerta');
  const ids = new Set();
  const readerIds = new Set();
  const outDoors = doors.map((d, i) => {
    const id = String(d && d.id || '').trim();
    if (!id) errors.push(`doors[${i}]: falta id`);
    if (ids.has(id)) errors.push(`doors[${i}]: id repetido "${id}"`);
    ids.add(id);
    const readers = (Array.isArray(d.readers) ? d.readers : []).map((r, j) => {
      const rid = String(r.id || `${id}-lector-${j + 1}`);
      if (readerIds.has(rid)) errors.push(`lector repetido "${rid}"`);
      readerIds.add(rid);
      const side = r.side === 'out' ? 'out' : 'in';
      if (r.side && r.side !== 'in' && r.side !== 'out') errors.push(`lector ${rid}: side debe ser 'in' u 'out'`);
      return { driver: 'serial', ...r, id: rid, side };
    });
    const output = d.output || { driver: 'mock' };
    if (output.driver === 'sr201' && !output.host) errors.push(`puerta ${id}: salida sr201 sin host`);
    return {
      ...d,
      id,
      readers,
      output,
      inputs: d.inputs || { driver: 'none' }
    };
  });

  const hub = raw.hub || {};
  const cloud = raw.cloud || {};
  const lan = raw.lan || {};
  const clock = raw.clock || {};
  const dataDir = path.resolve(baseDir, raw.dataDir || './data');
  const cfg = {
    deviceId,
    siteId: raw.siteId || 'principal',
    dataDir,
    dbFile: path.resolve(dataDir, raw.dbFile || 'edge-controller.db'),
    logFile: raw.logFile ? path.resolve(baseDir, raw.logFile) : null,
    logLevel: raw.logLevel || 'info',
    keys: {
      privateKeyFile: path.resolve(baseDir, (raw.keys && raw.keys.privateKeyFile) || path.join(dataDir, 'device-key.pem'))
    },
    hub: {
      url: hub.url ? String(hub.url).replace(/\/+$/, '') : null,
      deviceId: hub.deviceId || 'hub',
      publicKey: readKey(hub.publicKey, baseDir),
      configPollMs: Number(hub.configPollMs) > 0 ? Number(hub.configPollMs) : DEFAULTS.configPollMs,
      heartbeatMs: Number(hub.heartbeatMs) > 0 ? Number(hub.heartbeatMs) : DEFAULTS.heartbeatMs,
      timeoutMs: Number(hub.timeoutMs) > 0 ? Number(hub.timeoutMs) : 8000
    },
    cloud: {
      url: cloud.url || null,
      // Clave pública de la nube (fijada): un hub comprometido no puede inventar derechos.
      headPublicKeys: (() => {
        if (cloud.headPublicKeys && typeof cloud.headPublicKeys === 'object') {
          return Object.fromEntries(Object.entries(cloud.headPublicKeys).map(([k, v]) => [k, readKey(v, baseDir)]));
        }
        const k = readKey(cloud.headPublicKey, baseDir);
        return k ? k : null;
      })(),
      allowUnsignedConfig: cloud.allowUnsignedConfig === true
    },
    lan: {
      port: Number.isInteger(Number(lan.port)) ? Number(lan.port) : DEFAULTS.lanPort,
      bind: lan.bind || DEFAULTS.lanBind,
      allowUnsigned: lan.allowUnsigned === true
    },
    clock: {
      trusted: clock.trusted === true ? true : clock.trusted === false ? false : 'auto',
      maxDriftMs: Number(clock.maxDriftMs) > 0 ? Number(clock.maxDriftMs) : DEFAULTS.maxDriftMs,
      sampleMaxAgeMs: Number(clock.sampleMaxAgeMs) > 0 ? Number(clock.sampleMaxAgeMs) : DEFAULTS.clockSampleMaxAgeMs
    },
    interlock: { mode: raw.interlock && raw.interlock.enabled === false ? 'off' : 'snapshot' },
    simulation: { enabled: Boolean(raw.simulation && raw.simulation.enabled) },
    cooldownMs: Number(raw.cooldownMs) >= 0 && raw.cooldownMs !== undefined ? Number(raw.cooldownMs) : DEFAULTS.cooldownMs,
    approvalTtlMs: Number(raw.approvalTtlMs) > 0 ? Number(raw.approvalTtlMs) : DEFAULTS.approvalTtlMs,
    doors: outDoors
  };
  if (cfg.hub.url && !cfg.hub.publicKey && !cfg.lan.allowUnsigned) {
    errors.push('hub.publicKey es obligatoria (o lan.allowUnsigned=true solo para pruebas)');
  }
  if (!cfg.cloud.headPublicKeys && !cfg.cloud.allowUnsignedConfig) {
    errors.push('cloud.headPublicKey es obligatoria (o cloud.allowUnsignedConfig=true solo para pruebas)');
  }
  if (errors.length) throw new ConfigError(`Config inválida: ${errors.join('; ')}`);
  return cfg;
}

function loadConfig(file) {
  const abs = path.resolve(file);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw new ConfigError(`No se pudo leer la config ${abs}: ${err.message}`);
  }
  return normalizeConfig(raw, path.dirname(abs));
}

/** Clave Ed25519 del equipo: la lee o la crea (0600) la primera vez. */
function loadOrCreateDeviceKey(file) {
  if (fs.existsSync(file)) {
    const pem = fs.readFileSync(file, 'utf8');
    return { privateKeyPem: pem, publicKeyB64: lanSign.publicKeyRawB64(pem), created: false };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const kp = lanSign.generateKeyPair();
  fs.writeFileSync(file, kp.privateKeyPem, { encoding: 'utf8', mode: 0o600 });
  return { privateKeyPem: kp.privateKeyPem, publicKeyB64: kp.publicKeyB64, created: true };
}

module.exports = { normalizeConfig, loadConfig, loadOrCreateDeviceKey, ConfigError, DEFAULTS };
