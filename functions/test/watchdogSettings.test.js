const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertWatchdogSettings
} = require('../../scripts/lib/watchdogSettings');

describe('watchdog de tareas programadas', () => {
  const valid = {
    RestartCount: 3,
    RestartInterval: 'PT1M',
    ExecutionTimeLimit: 'PT0S'
  };

  it('acepta restart 3 x 1 minuto y ejecución ilimitada', () => {
    assert.equal(assertWatchdogSettings(valid), valid);
    assert.deepEqual(assertWatchdogSettings(JSON.stringify(valid)), valid);
  });

  it('falla si falta o cambia RestartCount', () => {
    assert.throws(
      () => assertWatchdogSettings({ ...valid, RestartCount: undefined }),
      /RestartCount must be 3/
    );
  });

  it('falla si falta o cambia RestartInterval', () => {
    assert.throws(
      () => assertWatchdogSettings({ ...valid, RestartInterval: undefined }),
      /RestartInterval must be 1 minute/
    );
  });

  it('falla si ExecutionTimeLimit no es ilimitado', () => {
    assert.throws(
      () => assertWatchdogSettings({ ...valid, ExecutionTimeLimit: 'PT72H' }),
      /ExecutionTimeLimit must be 0/
    );
  });
});
