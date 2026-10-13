const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateBiostarHealth,
  toBridgeRow,
  decideBridgeNotification,
  PROBLEM_GRACE_MS
} = require('../lib/bridgeHealthEvaluate');
const {
  mergeChecks,
  sanitizeHeartbeatChecks,
  resolveLectorHealth,
  resolveEstacionHealth,
  buildDoorHealthMap
} = require('../lib/stationHealth');

const NOW = Date.parse('2026-10-08T15:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60 * 1000;

describe('evaluateBiostarHealth', () => {
  it('degradado si el último éxito tiene más de 15 min aunque lleguen heartbeats', () => {
    const health = evaluateBiostarHealth({
      lastHeartbeatAt: ago(1 * MIN),
      lastSuccessAt: ago(20 * MIN),
      cursor: '2026-08-15T03:54:14.000Z'
    }, NOW);
    assert.equal(health.status, 'degraded');
    assert.match(health.reason, /Sin importar huellas desde el 15\/08 00:54/);
  });

  it('degradado con el error si es posterior al último éxito', () => {
    const health = evaluateBiostarHealth({
      lastHeartbeatAt: ago(1 * MIN),
      lastSuccessAt: ago(5 * MIN),
      lastError: 'MSS POST /admin/biostar/import-events → 502',
      lastErrorAt: ago(2 * MIN)
    }, NOW);
    assert.equal(health.status, 'degraded');
    assert.match(health.reason, /error: MSS POST/);
    assert.equal(health.problemCode, 'biostar_error');
  });

  it('en línea con éxito reciente; error viejo no cuenta', () => {
    const health = evaluateBiostarHealth({
      lastHeartbeatAt: ago(1 * MIN),
      lastSuccessAt: ago(1 * MIN),
      lastError: 'viejo',
      lastErrorAt: ago(30 * MIN)
    }, NOW);
    assert.equal(health.status, 'online');
    assert.equal(health.reason, null);
  });

  it('sin heartbeat reciente → offline', () => {
    const health = evaluateBiostarHealth({ lastHeartbeatAt: ago(45 * MIN) }, NOW);
    assert.equal(health.status, 'offline');
  });
});

describe('chequeos de estación', () => {
  it('mergeChecks solo mueve lastChangeAt cuando cambia el valor y registra transiciones', () => {
    const first = mergeChecks({}, { serialConnected: true, relayReachable: false }, 'T1');
    assert.equal(first.checks.serialConnected.lastChangeAt, 'T1');
    // Primera vez: solo se registra lo que ya viene mal.
    assert.deepEqual(first.transitions, [{ check: 'relayReachable', from: null, to: false }]);
    const second = mergeChecks(first.checks, { serialConnected: false, relayReachable: false }, 'T2');
    assert.equal(second.checks.serialConnected.lastChangeAt, 'T2');
    assert.equal(second.checks.relayReachable.lastChangeAt, 'T1');
    assert.deepEqual(second.transitions, [{ check: 'serialConnected', from: true, to: false }]);
  });

  it('sanitizeHeartbeatChecks calcula el desfase de reloj del lado servidor', () => {
    const checks = sanitizeHeartbeatChecks({
      serialConnected: true,
      offlineQueueLength: '3',
      clientTime: new Date(NOW - 90000).toISOString(),
      loginError: ''
    }, NOW);
    assert.equal(checks.serialConnected, true);
    assert.equal(checks.offlineQueueLength, 3);
    assert.equal(checks.clockSkewMs, -90000);
    assert.equal(checks.loginError, null);
    assert.equal('relayReachable' in checks, false);
  });

  it('“en línea” solo con heartbeat fresco y lector + relé OK', () => {
    const base = { ultimaConexion: ago(1 * MIN), puertoDetectado: 'COM3' };
    assert.equal(resolveLectorHealth(base, NOW).connectionStatus, 'online');
    const sinLector = resolveLectorHealth({
      ...base,
      checks: { serialConnected: { value: false, lastChangeAt: ago(5 * MIN) } }
    }, NOW);
    assert.equal(sinLector.connectionStatus, 'problem');
    assert.equal(sinLector.reason, 'Lector no conectado (COM3)');
    const sinRele = resolveLectorHealth({
      ...base,
      checks: { relayReachable: { value: false, lastChangeAt: ago(5 * MIN) } }
    }, NOW);
    assert.equal(sinRele.reason, 'Placa de relé no responde');
    assert.equal(resolveLectorHealth({ ultimaConexion: ago(60 * MIN) }, NOW).connectionStatus, 'offline');
  });

  it('estación y puertas toman el peor estado de sus lectores', () => {
    const lectores = [
      { id: 'a', nombre: 'Ingreso P1', doorId: 'puerta-p1', ultimaConexion: ago(MIN) },
      {
        id: 'b',
        nombre: 'Egreso P1',
        doorId: 'puerta-p1',
        ultimaConexion: ago(MIN),
        puertoDetectado: 'COM4',
        checks: { serialConnected: { value: false, lastChangeAt: ago(MIN) } }
      }
    ];
    const est = resolveEstacionHealth({ ultimaConexion: ago(MIN) }, lectores, NOW);
    assert.equal(est.connectionStatus, 'problem');
    assert.equal(est.reason, 'Egreso P1: Lector no conectado (COM4)');
    const doors = buildDoorHealthMap(lectores, NOW);
    assert.deepEqual(doors.get('puerta-p1'), { status: 'problem', reason: 'Lector no conectado (COM4)' });
  });
});

describe('decideBridgeNotification', () => {
  const problemRow = (sinceMs) => toBridgeRow({
    kind: 'lector',
    id: 'l1',
    name: 'Ingreso',
    lastAt: ago(MIN),
    problem: { code: 'lector_desconectado', reason: 'Lector no conectado (COM3)', since: sinceMs },
    nowMs: NOW
  });

  it('espera 2 min antes de avisar “lector desconectado”', () => {
    assert.equal(problemRow(NOW - 30 * 1000).status, 'degraded');
    assert.equal(decideBridgeNotification(problemRow(NOW - 30 * 1000), {}, NOW), null);
    assert.equal(decideBridgeNotification(problemRow(NOW - PROBLEM_GRACE_MS - 1), {}, NOW), 'problem');
  });

  it('no repite el mismo problema antes de 6 h y avisa “recuperado” al resolverse', () => {
    const row = problemRow(NOW - 10 * MIN);
    const prev = {
      alerted: true,
      lastStatus: 'degraded',
      problemCode: 'lector_desconectado',
      lastNotifiedAt: NOW - 10 * MIN
    };
    assert.equal(decideBridgeNotification(row, prev, NOW), null);
    const healthy = toBridgeRow({ kind: 'lector', id: 'l1', name: 'Ingreso', lastAt: ago(MIN), nowMs: NOW });
    assert.equal(decideBridgeNotification(healthy, prev, NOW), 'recovered');
    assert.equal(decideBridgeNotification(healthy, { lastStatus: 'online' }, NOW), null);
  });

  it('BioStar degradado con heartbeat vivo genera aviso de problema', () => {
    const health = evaluateBiostarHealth({
      lastHeartbeatAt: ago(MIN),
      lastSuccessAt: ago(30 * MIN)
    }, NOW);
    const row = toBridgeRow({
      kind: 'biostar',
      id: 'biostar-bridge',
      name: 'Puente BioStar 2',
      lastAt: ago(MIN),
      problem: { code: health.problemCode, reason: health.reason, since: health.problemSince },
      nowMs: NOW
    });
    assert.equal(row.status, 'degraded');
    assert.equal(decideBridgeNotification(row, {}, NOW), 'problem');
  });
});

describe('estado BioStar para la UI', () => {
  const { buildBiostarStatus, resolveReportedAt } = require('../lib/biostarBridgeStatus');

  it('usa "hace X ms" del puente para no depender de su reloj', () => {
    assert.equal(resolveReportedAt(60000, '1999-01-01T00:00:00.000Z', NOW), ago(MIN));
    assert.equal(resolveReportedAt(undefined, ago(5 * MIN), NOW), ago(5 * MIN));
  });

  it('heartbeat vivo pero importación trabada → estado de error con motivo en español', () => {
    const status = buildBiostarStatus({
      lastHeartbeatAt: ago(MIN),
      lastSuccessAt: null,
      lastError: 'MSS POST /admin/biostar/import-events → 502',
      lastErrorAt: ago(MIN),
      cursor: '2026-08-15T03:54:14.000Z',
      events: { at: ago(MIN), ok: false, error: '502' }
    }, NOW);
    assert.equal(status.state, 'error');
    assert.equal(status.health.status, 'degraded');
    assert.equal(status.events.state, 'error');
    assert.equal(status.events.cursorDatetime, '2026-08-15T03:54:14.000Z');
    assert.match(status.health.reason, /^Sin importar huellas desde el 15\/08 00:54 — error: /);
  });

  it('la importación registrada por el servidor cuenta como éxito', () => {
    const status = buildBiostarStatus({
      lastHeartbeatAt: ago(MIN),
      lastSuccessAt: ago(40 * MIN),
      lastImportAt: { toDate: () => new Date(NOW - MIN), toMillis: () => NOW - MIN }
    }, NOW);
    assert.equal(status.health.status, 'online');
    assert.equal(status.state, 'ok');
  });
});
