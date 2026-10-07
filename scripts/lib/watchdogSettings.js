const parseDurationMs = (value) => {
  if (value === 0 || value === '0') return 0;
  if (typeof value === 'number') return value;
  const text = String(value || '').trim().toUpperCase();
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(text);
  if (!match) return Number.NaN;
  return (
    Number(match[1] || 0) * 60 * 60 * 1000
    + Number(match[2] || 0) * 60 * 1000
    + Number(match[3] || 0) * 1000
  );
};

const STATION_HEALTH_DEFAULTS = {
  failureThreshold: 3,
  intervalMs: 60_000,
  timeoutMs: 5_000
};

/**
 * Estado del control de cuelgue de la estación (NSSM no reinicia si el proceso sigue vivo).
 * `responded` = el HTTP contestó (aunque sea 401). Sin respuesta se acumulan fallos;
 * al llegar al tope hay que reiniciar y volver el contador a cero.
 */
const nextStationHealthState = ({
  consecutiveFailures = 0,
  responded = false,
  failureThreshold = STATION_HEALTH_DEFAULTS.failureThreshold
} = {}) => {
  const threshold = Number(failureThreshold);
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error('failureThreshold must be a positive integer');
  }
  if (responded) {
    return { consecutiveFailures: 0, shouldRestart: false };
  }
  const next = (Number(consecutiveFailures) || 0) + 1;
  if (next >= threshold) {
    return { consecutiveFailures: 0, shouldRestart: true };
  }
  return { consecutiveFailures: next, shouldRestart: false };
};

const assertWatchdogSettings = (input) => {
  const settings = typeof input === 'string' ? JSON.parse(input) : input;
  if (!settings || typeof settings !== 'object') {
    throw new TypeError('Watchdog settings must be an object or JSON object');
  }
  if (Number(settings.RestartCount) !== 3) {
    throw new Error('RestartCount must be 3');
  }
  if (parseDurationMs(settings.RestartInterval) !== 60_000) {
    throw new Error('RestartInterval must be 1 minute');
  }
  if (parseDurationMs(settings.ExecutionTimeLimit) !== 0) {
    throw new Error('ExecutionTimeLimit must be 0 (unlimited)');
  }
  return settings;
};

module.exports = {
  assertWatchdogSettings,
  parseDurationMs,
  nextStationHealthState,
  STATION_HEALTH_DEFAULTS
};

if (require.main === module && process.argv[2] === 'next-station-health') {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw || '{}');
      process.stdout.write(JSON.stringify(nextStationHealthState(input)));
    } catch (err) {
      console.error(err.message || err);
      process.exit(1);
    }
  });
}
