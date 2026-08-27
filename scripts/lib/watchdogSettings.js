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
  parseDurationMs
};
