const net = require('net');

const DEFAULT_PORT = 6722;
const DEFAULT_TIMEOUT_MS = 4000;

const clampChannel = (channel = 1) => Math.max(1, Math.min(8, Number(channel) || 1));
const clampSeconds = (seconds = 3) => Math.max(1, Math.min(99, Number(seconds) || 3));

/**
 * Comandos SR-201 (ASCII, sin CR/LF):
 *  1R*     → jog ~0.5s
 *  1R      → ON (cerrar/activar)
 *  2R      → OFF (abrir/desactivar)
 *  1R:n    → ON y OFF automático a los n segundos (firmware; n SIN zero-pad)
 *
 * Para temporizado confiable usamos ON → wait → OFF en el bridge (LAN),
 * porque algunos firmwares ignoran o malparsean "1R:0n".
 */
const buildPulseCommand = (channel = 1, mode = 'jog', seconds = 3) => {
  const relay = String(clampChannel(channel));
  if (mode === 'timed') {
    return `1${relay}:${clampSeconds(seconds)}`;
  }
  return `1${relay}*`;
};

const buildOnCommand = (channel = 1) => `1${clampChannel(channel)}`;
const buildOffCommand = (channel = 1) => `2${clampChannel(channel)}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sendTcpCommand = (host, port, command, timeoutMs = DEFAULT_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish(new Error(`Timeout al conectar con SR201 (${host}:${port})`)));
    socket.on('error', (err) => finish(err));
    socket.connect(port, host, () => {
      socket.write(command, 'ascii', (writeErr) => {
        if (writeErr) {
          finish(writeErr);
          return;
        }

        socket.once('data', (data) => {
          finish(null, {
            command,
            response: data.toString('ascii').trim()
          });
        });

        setTimeout(() => {
          finish(null, { command, response: null });
        }, 350);
      });
    });
  });

/**
 * Temporizado fiable: ON → espera N s → OFF (en la PC de planta).
 *
 * @param {object} [options]
 * @param {boolean} [options.waitForComplete=true]
 *   Si false, resuelve apenas el ON TCP confirma (el OFF sigue en background).
 *   Usado por el bridge HTTP para no bloquear /api/access/kiosk-scan durante N s.
 */
const sendTimedPulseTcp = async (
  host,
  port,
  channel,
  seconds,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options = {}
) => {
  const waitForComplete = options.waitForComplete !== false;
  const n = clampSeconds(seconds);
  const onCmd = buildOnCommand(channel);
  const offCmd = buildOffCommand(channel);
  const onResult = await sendTcpCommand(host, port, onCmd, timeoutMs);

  const runOff = async () => {
    await sleep(n * 1000);
    return sendTcpCommand(host, port, offCmd, timeoutMs);
  };

  if (!waitForComplete) {
    runOff().catch((err) => {
      console.error(
        `[sr201] OFF async falló (${host}:${port} ch=${channel}):`,
        err.message || err
      );
    });
    return {
      command: `${onCmd} / wait ${n}s / ${offCmd}`,
      mode: 'timed',
      seconds: n,
      async: true,
      response: onResult.response
    };
  }

  const off = await runOff();
  return {
    command: `${onCmd} / wait ${n}s / ${offCmd}`,
    mode: 'timed',
    seconds: n,
    async: false,
    response: off.response
  };
};

/**
 * Consulta estado de relés. Comando "01" (noop canal 1) → respuesta 8 chars 0/1.
 * '1' = relé activado (puerta abierta/desbloqueada en cableado típico), '0' = inactivo (cerrada).
 */
const parseRelayStatusBits = (raw = '') => {
  const bits = String(raw || '').replace(/\s/g, '');
  const channels = {};
  for (let i = 1; i <= 8; i += 1) {
    const ch = bits[i - 1];
    if (ch === '0' || ch === '1') {
      channels[i] = ch === '1';
    }
  }
  return { raw: bits.slice(0, 8), channels };
};

const queryRelayStatusTcp = async (host, port, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const result = await sendTcpCommand(host, port, '01', timeoutMs);
  const parsed = parseRelayStatusBits(result.response);
  return {
    ...parsed,
    host,
    port,
    queriedAt: new Date().toISOString()
  };
};

const queryRelayStatusViaBridge = async (bridgeUrl, { host, port, bridgeSecret = '' } = {}) => {
  const url = String(bridgeUrl || '').replace(/\/$/, '');
  if (!url) {
    throw new Error('Falta la URL del puente SR201');
  }
  const headers = {
    'Content-Type': 'application/json',
    ...(bridgeSecret ? { Authorization: `Bearer ${bridgeSecret}` } : {})
  };

  // Preferir POST /status (más fiable a través de túneles); fallback GET.
  let response;
  try {
    response = await fetch(`${url}/status`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ host, port: Number(port) || 6722 })
    });
  } catch (err) {
    throw new Error(`No se pudo consultar estado vía puente: ${err.message || 'error de red'}`);
  }

  if (response.status === 404) {
    const qs = new URLSearchParams();
    if (host) qs.set('host', host);
    if (port) qs.set('port', String(port));
    try {
      response = await fetch(`${url}/status?${qs}`, { method: 'GET', headers });
    } catch (err) {
      throw new Error(`Puente sin /status (reiniciá sr201-bridge). Detalle: ${err.message}`);
    }
  }

  const data = await response.json().catch(() => ({}));
  if (response.status === 404) {
    throw new Error('El puente local no tiene /status. Reiniciá BacarGuard-SR201-Bridge con el script actualizado.');
  }
  if (!response.ok) {
    throw new Error(data.message || `Puente respondió ${response.status}`);
  }
  return data;
};

const sendViaBridge = async (bridgeUrl, payload, bridgeSecret = '') => {
  const url = String(bridgeUrl || '').replace(/\/$/, '');
  if (!url) {
    throw new Error('Falta la URL del puente SR201 (bridgeUrl). Configurala en Admin → Puertas.');
  }

  // Timed: el bridge responde tras confirmar ON (OFF async). No hace falta
  // presupuestar pulseSeconds en el AbortController de Cloud Functions.
  const waitBudgetSec = 20;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), waitBudgetSec * 1000)
    : null;

  let response;
  try {
    response = await fetch(`${url}/pulse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bridgeSecret ? { Authorization: `Bearer ${bridgeSecret}` } : {})
      },
      body: JSON.stringify(payload),
      signal: controller?.signal
    });
  } catch (err) {
    const hint = /cloudflare|trycloud|\.cfargotunnel\.|https:\/\//i.test(url)
      ? 'Revisá que el túnel (Cloudflare) y el puente local estén activos.'
      : 'Revisá que el puente local esté encendido y alcanzable.';
    throw new Error(
      `No se pudo contactar el puente SR201 (${url}). ${hint} Detalle: ${err.message || 'error de red'}`
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Puente SR201 rechazó el secreto (BRIDGE_SECRET). Verificá el valor en Admin y en el PC de planta.');
    }
    throw new Error(data.message || `Puente SR201 respondió ${response.status}`);
  }
  return data;
};

/**
 * Driver SR201 — misma interfaz que el resto de doorDrivers.
 * @param {object} config  deviceConfig ya aplanado (host, port, bridgeUrl, relayChannel, …)
 * @param {{ force?: boolean }} options
 */
const triggerRelay = async (config = {}, { force = false } = {}) => {
  if (config.enabled === false && !force) {
    return { triggered: false, skipped: true, message: 'Control de acceso deshabilitado' };
  }

  const channel = clampChannel(config.relayChannel);
  const mode = config.pulseMode === 'timed' ? 'timed' : (config.pulseMode || 'jog');
  const seconds = clampSeconds(config.pulseSeconds);
  const command = buildPulseCommand(channel, mode, seconds);
  const payload = {
    channel,
    mode,
    seconds,
    command,
    host: config.host || undefined,
    port: Number(config.port) || undefined,
    // El bridge debe temporizar en software (ON/wait/OFF) para respetar los segundos.
    softwareTimed: mode === 'timed'
  };

  if (config.bridgeUrl) {
    const bridgeResult = await sendViaBridge(config.bridgeUrl, payload, config.bridgeSecret || '');
    return {
      triggered: true,
      via: 'bridge',
      command: bridgeResult.command || command,
      seconds,
      mode,
      ...bridgeResult
    };
  }

  const host = config.host || '192.168.1.100';
  const port = Number(config.port) || DEFAULT_PORT;

  const isPrivateLan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost)/i.test(host);
  if (isPrivateLan) {
    throw new Error(
      'Falta la URL pública del puente SR201. La placa responde en la LAN (ej. Device Controller), '
      + 'pero Firebase no puede llegar a esa IP. En una PC de planta corré scripts/sr201-bridge.js, '
      + 'exponelo con un túnel Cloudflare y pegá esa URL HTTPS en Admin → Puertas → “URL pública del túnel”.'
    );
  }

  if (mode === 'timed') {
    // Igual criterio que el bridge: no bloquear la API HTTP durante N segundos.
    const timed = await sendTimedPulseTcp(
      host,
      port,
      channel,
      seconds,
      Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS,
      { waitForComplete: false }
    );
    return { triggered: true, via: 'tcp', host, port, ...timed };
  }

  const tcpResult = await sendTcpCommand(host, port, command, Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS);
  return {
    triggered: true,
    via: 'tcp',
    host,
    port,
    ...tcpResult
  };
};

module.exports = {
  id: 'sr201',
  buildPulseCommand,
  buildOnCommand,
  buildOffCommand,
  sendTcpCommand,
  sendTimedPulseTcp,
  parseRelayStatusBits,
  queryRelayStatusTcp,
  queryRelayStatusViaBridge,
  triggerRelay
};
