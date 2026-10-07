const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonFileAtomic } = require('./atomicJson');

describe('writeJsonFileAtomic', () => {
  const dirs = [];
  after(() => {
    dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  });

  it('deja el JSON completo y no el archivo temporal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-atomic-'));
    dirs.push(dir);
    const file = path.join(dir, 'biostar-state.json');
    writeJsonFileAtomic(file, { lastEventDatetime: null });
    writeJsonFileAtomic(file, { lastEventDatetime: '2026-10-07T12:00:00.000Z' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      lastEventDatetime: '2026-10-07T12:00:00.000Z'
    });
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  });
});
