const net = require('net');

const DEFAULT_PORT = 6722;
const DEFAULT_TIMEOUT_MS = 4000;

const buildPulseCommand = (channel = 1, mode = 'jog', seconds = 3) => {
  const relay = String(channel);
  if (mode === 'timed') {
    const padded = String(Math.max(1, Math.min(99, Number(seconds) || 3))).padStart(2, '0');
    return `1${relay}:${padded}`;
  }
  return `1${relay}*`;
};

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

const sendViaBridge = async (bridgeUrl, payload, bridgeSecret = '') => {
  const response = await fetch(String(bridgeUrl).replace(/\/$/, '') + '/pulse', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bridgeSecret ? { Authorization: `Bearer ${bridgeSecret}` } : {})
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `Puente SR201 respondió ${response.status}`);
  }
  return data;
};

const triggerRelay = async (config = {}, { force = false } = {}) => {
  if (config.enabled === false && !force) {
    return { triggered: false, skipped: true, message: 'Control de acceso deshabilitado' };
  }

  const channel = Number(config.relayChannel) || 1;
  const mode = config.pulseMode || 'jog';
  const seconds = Number(config.pulseSeconds) || 3;
  const command = buildPulseCommand(channel, mode, seconds);
  const payload = { channel, mode, seconds, command };

  if (config.bridgeUrl) {
    const bridgeResult = await sendViaBridge(config.bridgeUrl, payload, config.bridgeSecret || '');
    return {
      triggered: true,
      via: 'bridge',
      command,
      ...bridgeResult
    };
  }

  const host = config.host || '192.168.1.100';
  const port = Number(config.port) || DEFAULT_PORT;
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
  buildPulseCommand,
  sendTcpCommand,
  triggerRelay
};
