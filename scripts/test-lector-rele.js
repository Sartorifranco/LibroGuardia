/**
 * Prueba aislada de hardware: lector GADNIC CODBAR14 (RS-232) → relé SR201.
 *
 * NO usa Firebase, login, Firestore ni la API. Solo serie + TCP (o puente local).
 *
 * Instalación (una vez, desde la carpeta scripts):
 *   cd scripts
 *   npm install
 *
 * Uso típico (Windows, PC en la misma LAN que el SR201):
 *   node scripts/test-lector-rele.js --port COM3 --baud 9600 --host 192.168.0.38 --channel 1
 *
 * Solo diagnóstico de bytes (no dispara el relé):
 *   node scripts/test-lector-rele.js --port COM3 --baud 9600 --diag-only
 *
 * Variables de entorno equivalentes:
 *   SERIAL_PORT, SERIAL_BAUD, SR201_HOST, SR201_PORT, SR201_CHANNEL,
 *   SR201_PULSE_MODE (jog|timed), SR201_PULSE_SECONDS, SR201_BRIDGE_URL
 *
 * Nota sobre triggerRelay: el export triggerRelay() rechaza IPs privadas sin
 * bridgeUrl (pensado para Cloud Functions). En LAN local este script reutiliza
 * sendTcpCommand / sendTimedPulseTcp del mismo driver (el camino TCP interno).
 * Si pasás --bridge-url http://127.0.0.1:5022 usa triggerRelay completo vía puente.
 */

const path = require('path');

const {
  triggerRelay,
  sendTcpCommand,
  sendTimedPulseTcp,
  buildPulseCommand
} = require('../functions/lib/doorDrivers/sr201');

const DEFAULTS = {
  port: 'COM3',
  baud: 9600,
  host: '192.168.0.38',
  sr201Port: 6722,
  channel: 1,
  pulseMode: 'jog',
  pulseSeconds: 1,
  bridgeUrl: '',
  bridgeSecret: '',
  idleMs: 120,
  diagOnly: false
};

const CONTROL_NAMES = {
  0: 'NUL', 7: 'BEL', 8: 'BS', 9: 'TAB', 10: 'LF', 11: 'VT', 12: 'FF',
  13: 'CR', 27: 'ESC', 32: 'SPC'
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  const env = process.env;
  if (env.SERIAL_PORT) out.port = env.SERIAL_PORT;
  if (env.SERIAL_BAUD) out.baud = Number(env.SERIAL_BAUD) || out.baud;
  if (env.SR201_HOST) out.host = env.SR201_HOST;
  if (env.SR201_PORT) out.sr201Port = Number(env.SR201_PORT) || out.sr201Port;
  if (env.SR201_CHANNEL) out.channel = Number(env.SR201_CHANNEL) || out.channel;
  if (env.SR201_PULSE_MODE) out.pulseMode = env.SR201_PULSE_MODE;
  if (env.SR201_PULSE_SECONDS) out.pulseSeconds = Number(env.SR201_PULSE_SECONDS) || out.pulseSeconds;
  if (env.SR201_BRIDGE_URL) out.bridgeUrl = env.SR201_BRIDGE_URL;
  if (env.SR201_BRIDGE_SECRET) out.bridgeSecret = env.SR201_BRIDGE_SECRET;

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--port': out.port = next(); break;
      case '--baud': out.baud = Number(next()) || out.baud; break;
      case '--host': out.host = next(); break;
      case '--sr201-port': out.sr201Port = Number(next()) || out.sr201Port; break;
      case '--channel': out.channel = Number(next()) || out.channel; break;
      case '--pulse-mode': out.pulseMode = next(); break;
      case '--pulse-seconds': out.pulseSeconds = Number(next()) || out.pulseSeconds; break;
      case '--bridge-url': out.bridgeUrl = next(); break;
      case '--bridge-secret': out.bridgeSecret = next(); break;
      case '--idle-ms': out.idleMs = Number(next()) || out.idleMs; break;
      case '--diag-only': out.diagOnly = true; break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        if (a.startsWith('-')) {
          console.error(`Argumento desconocido: ${a}`);
          out.help = true;
        }
    }
  }
  return out;
}

function formatByte(byte) {
  const name = CONTROL_NAMES[byte];
  if (name) return `[${name}]`;
  if (byte >= 33 && byte <= 126) return String.fromCharCode(byte);
  return `[0x${byte.toString(16).padStart(2, '0')}]`;
}

function formatChunk(buf) {
  const bytes = [...buf];
  const pretty = bytes.map(formatByte).join('');
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
  return { pretty, hex, bytes };
}

function ts() {
  return new Date().toISOString().slice(11, 23);
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

/**
 * Disparo del relé reusando el driver SR201.
 * Con bridgeUrl → triggerRelay (camino producción).
 * Sin bridgeUrl → TCP directo con sendTcpCommand/sendTimedPulseTcp (mismo driver).
 */
async function fireRelay(cfg) {
  const relayConfig = {
    enabled: true,
    host: cfg.host,
    port: cfg.sr201Port,
    relayChannel: cfg.channel,
    pulseMode: cfg.pulseMode === 'timed' ? 'timed' : 'jog',
    pulseSeconds: cfg.pulseSeconds,
    bridgeUrl: cfg.bridgeUrl || undefined,
    bridgeSecret: cfg.bridgeSecret || undefined
  };

  if (relayConfig.bridgeUrl) {
    log(`Disparando relé vía triggerRelay + bridge (${relayConfig.bridgeUrl})…`);
    return triggerRelay(relayConfig, { force: true });
  }

  const channel = relayConfig.relayChannel;
  const mode = relayConfig.pulseMode;
  const seconds = relayConfig.pulseSeconds;
  const host = relayConfig.host;
  const port = relayConfig.port;

  log(`Disparando relé vía TCP directo del driver (${host}:${port} ch=${channel} mode=${mode})…`);
  if (mode === 'timed') {
    const timed = await sendTimedPulseTcp(host, port, channel, seconds);
    return { triggered: true, via: 'tcp-direct', host, port, ...timed };
  }
  const command = buildPulseCommand(channel, 'jog', seconds);
  const tcpResult = await sendTcpCommand(host, port, command);
  return { triggered: true, via: 'tcp-direct', host, port, command, ...tcpResult };
}

async function loadSerialPort() {
  try {
    // Preferir serialport instalado en scripts/
    // eslint-disable-next-line import/no-extraneous-dependencies, global-require
    return require('serialport');
  } catch {
    try {
      // eslint-disable-next-line import/no-extraneous-dependencies, global-require
      return require(path.join(__dirname, 'node_modules', 'serialport'));
    } catch (err) {
      throw new Error(
        'No se encontró el paquete "serialport". Ejecutá:\n'
        + '  cd scripts\n'
        + '  npm install\n'
        + `Detalle: ${err.message}`
      );
    }
  }
}

async function main() {
  const cfg = parseArgs(process.argv);
  if (cfg.help) {
    console.log(`
Uso:
  node scripts/test-lector-rele.js [opciones]

Opciones:
  --port COM3              Puerto serie (default: COM3)
  --baud 9600              Baud rate (default: 9600)
  --host 192.168.0.38      IP del SR201
  --sr201-port 6722        Puerto TCP del SR201
  --channel 1              Canal del relé (1-8)
  --pulse-mode jog|timed   Modo de pulso (default: jog)
  --pulse-seconds 1        Segundos si mode=timed
  --bridge-url URL         Si se setea, usa triggerRelay vía puente local
  --idle-ms 120            Fin de lectura por silencio (ms) si no hay CR/LF
  --diag-only              Solo loguear bytes, no disparar relé
`);
    process.exit(0);
  }

  log('=== test-lector-rele — diagnóstico hardware (sin Firebase) ===');
  log(`Serie: ${cfg.port} @ ${cfg.baud} baud`);
  log(`SR201: ${cfg.host}:${cfg.sr201Port} canal ${cfg.channel} (${cfg.pulseMode})`);
  log(`Modo: ${cfg.diagOnly ? 'SOLO DIAGNÓSTICO (no abre relé)' : 'lectura → abre relé'}`);
  log('Escaneá un código. Se muestran TODOS los bytes crudos al llegar.');
  log('Ctrl+C para salir.\n');

  const serialportMod = await loadSerialPort();
  const { SerialPort } = serialportMod;

  let port;
  try {
    port = new SerialPort({
      path: cfg.port,
      baudRate: cfg.baud,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      autoOpen: false
    });
  } catch (err) {
    console.error(`\nNo se pudo crear el puerto ${cfg.port}: ${err.message}`);
    process.exit(1);
  }

  await new Promise((resolve, reject) => {
    port.open((err) => {
      if (err) {
        const msg = err.message || String(err);
        console.error(`\nNo se pudo abrir ${cfg.port}.`);
        console.error(`Detalle: ${msg}`);
        if (/access denied|busy|in use|EACCES|EBUSY/i.test(msg)) {
          console.error('El puerto suele estar en uso por otro programa (Terminal, Arduino IDE, otro bridge). Cerralo e intentá de nuevo.');
        }
        if (/cannot find|ENOENT|file not found|unknown/i.test(msg)) {
          console.error('Revisá el nombre del puerto (Administrador de dispositivos → Puertos COM).');
        }
        reject(err);
        return;
      }
      resolve();
    });
  }).catch(() => process.exit(1));

  log(`Puerto ${cfg.port} abierto OK. Esperando datos…\n`);

  let buffer = Buffer.alloc(0);
  let idleTimer = null;
  let firing = false;

  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const completeScan = async (rawBuf, reason) => {
    clearIdle();
    if (!rawBuf || rawBuf.length === 0) return;

    const { pretty, hex } = formatChunk(rawBuf);
    const text = rawBuf.toString('utf8').replace(/[\r\n\0]+/g, '').trim();

    log(`── Lectura completa (fin: ${reason}) ──`);
    log(`  Crudo: ${pretty}`);
    log(`  Hex:   ${hex}`);
    log(`  Texto: ${text || '(vacío tras limpiar CR/LF)'}`);

    if (cfg.diagOnly) {
      log('  (--diag-only: no se dispara el relé)\n');
      return;
    }
    if (!text) {
      log('  Sin payload útil → no se dispara el relé\n');
      return;
    }
    if (firing) {
      log('  Relé ocupado, lectura ignorada\n');
      return;
    }

    firing = true;
    try {
      const result = await fireRelay(cfg);
      log(`  Relé OK: ${JSON.stringify(result)}`);
    } catch (err) {
      log(`  Relé ERROR: ${err.message || err}`);
      if (err.stack) console.error(err.stack);
    } finally {
      firing = false;
      console.log('');
    }
  };

  const scheduleIdleFlush = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      if (buffer.length === 0) return;
      const snapshot = buffer;
      buffer = Buffer.alloc(0);
      completeScan(snapshot, `silencio ${cfg.idleMs}ms`);
    }, cfg.idleMs);
  };

  port.on('data', (chunk) => {
    const { pretty, hex } = formatChunk(chunk);
    log(`RX chunk (${chunk.length} byte/s): ${pretty}`);
    log(`         hex: ${hex}`);

    buffer = Buffer.concat([buffer, chunk]);

    // Extraer lecturas terminadas en CR y/o LF (CRLF → una sola lectura)
    while (buffer.length > 0) {
      const cr = buffer.indexOf(0x0d);
      const lf = buffer.indexOf(0x0a);
      let cut = -1;
      if (cr >= 0 && lf >= 0) cut = Math.min(cr, lf);
      else if (cr >= 0) cut = cr;
      else if (lf >= 0) cut = lf;

      if (cut < 0) break;

      let end = cut + 1;
      // Consumir CRLF completo
      if (buffer[cut] === 0x0d && buffer[end] === 0x0a) end += 1;
      else if (buffer[cut] === 0x0a && cut > 0 && buffer[cut - 1] === 0x0d) {
        // ya incluido
      }

      const frame = buffer.subarray(0, end);
      buffer = buffer.subarray(end);
      let termLabel = 'terminador';
      const hasCr = frame.includes(0x0d);
      const hasLf = frame.includes(0x0a);
      if (hasCr && hasLf) termLabel = 'CRLF';
      else if (hasCr) termLabel = 'CR';
      else if (hasLf) termLabel = 'LF';

      completeScan(Buffer.from(frame), termLabel);
    }

    if (buffer.length > 0) scheduleIdleFlush();
  });

  port.on('error', (err) => {
    console.error(`[${ts()}] Error de puerto serie: ${err.message || err}`);
  });

  port.on('close', () => {
    log('Puerto serie cerrado.');
  });

  const shutdown = () => {
    log('Cerrando…');
    clearIdle();
    try {
      if (port.isOpen) port.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
