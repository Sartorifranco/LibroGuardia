'use strict';

/**
 * Runtime del controlador (`mss-edge --role=controller`, docs/ETAPA2-DISENO.md §1, §4, §5).
 *
 * Autoridad de decisión de SUS puertas, 100 % local:
 *   credencial → motor decide() sobre el snapshot SQLite (at = reloj corregido, clockTrusted)
 *   → acciones → driver de salida → efectos de estanco SOLO si el pulso salió → journal (seq propio).
 * needs_approval → evento + aprobación pendiente que el hub resuelve.
 * Máquina de estados por puerta (doorStateMachine) con alarmas al journal.
 * Config del hub (firmada por la nube) y eventos al hub con ack; API LAN firmada para comandos.
 */

const path = require('path');
const fs = require('fs');
const { decide } = require('../../../functions/lib/accessEngine');
const { reasonMessage } = require('../../../functions/lib/accessEngine/reasons.es');
const { DEFAULT_POLICY } = require('../../../functions/lib/accessEngine/snapshotSchema');
const { FORCE_PERMISSION } = require('../../../functions/lib/accessEngine/interlock');
const { openEdgeDb } = require('../lib/db');
const lanSign = require('../lib/lanSign');
const drivers = require('../drivers');
const { nullLogger, maskIdNumber } = require('../drivers/logger');
const { DoorRunner, doorParams } = require('./doorStateMachine');
const { DoorStateReporter } = require('./doorStateReport');
const { ConfigSync } = require('./configSync');
const { EventPusher } = require('./eventPusher');
const { HubClient, EdgeClock } = require('./hubClient');
const { DegradedCloudFallback } = require('./degraded');

const MANUAL_MODES = new Set(['manual', 'remote']);

class Controller {
  /**
   * @param {object} opts
   * @param {object} opts.config               config normalizada (config.js)
   * @param {object} [opts.edge]               resultado de openEdgeDb (tests); si no, se abre config.dbFile
   * @param {string} [opts.privateKeyPem]      clave del equipo (para firmar hacia el hub)
   * @param {object} [opts.hub]                cliente del hub (tests); si no, HubClient sobre config.hub.url
   * @param {object} [opts.clock]              {now, setTimeout, clearTimeout} para timers (tests)
   * @param {EdgeClock} [opts.edgeClock]
   * @param {object} [opts.logger]
   * @param {object} [opts.driverDeps]         {createReader, createOutput, createInput} o deps por driver
   * @param {(head)=>boolean} [opts.verifyHead]
   */
  constructor({
    config, edge = null, privateKeyPem = null, hub = null, clock = null, edgeClock = null,
    logger = nullLogger, driverDeps = {}, verifyHead = null
  }) {
    this.config = config;
    this.logger = logger;
    this.clock = clock || { now: () => Date.now(), setTimeout, clearTimeout };
    this.edgeClock = edgeClock || new EdgeClock({ ...config.clock, systemNow: () => this.clock.now() });
    this.verifyHead = verifyHead || ((head) => {
      if (config.cloud.headPublicKeys) return lanSign.verifyHead(head, config.cloud.headPublicKeys);
      return config.cloud.allowUnsignedConfig === true;
    });
    const myDoorIds = config.doors.map((d) => d.id);
    if (!edge) {
      fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
      edge = openEdgeDb(config.dbFile, { role: 'controller', deviceId: config.deviceId, myDoorIds, verifyHead: this.verifyHead });
      if (edge.recovered) logger.error('La base local estaba dañada: se apartó y se pide el bundle completo al hub', { movedTo: edge.movedTo });
    }
    this.edge = edge;
    this.privateKeyPem = privateKeyPem;
    this.hub = hub || new HubClient({
      url: config.hub.url, deviceId: config.deviceId, privateKey: privateKeyPem, clock: this.edgeClock, timeoutMs: config.hub.timeoutMs
    });
    this.driverDeps = driverDeps;
    this.doors = new Map(); // id → {cfg, runner, output, input, readers}
    this.interlockState = {}; // groupId → estado 'timed'
    this.lastPulseAt = new Map(); // doorId → ms (cooldown)
    this.lastPassage = new Map(); // `${cardholderId}|${doorId}|${side}` → {at, eventId, decision}
    this.approvals = new Map();
    this.emergencySources = new Set();
    this.started = false;

    this.configSync = new ConfigSync({
      edge: this.edge,
      hub: this.hub,
      verifyHead: this.verifyHead,
      logger: logger.child ? logger.child('config') : logger,
      journal: (evt) => this.record(evt),
      onApplied: () => this.refreshDoorParams()
    });
    this.pusher = new EventPusher({
      journal: this.edge.journal,
      hub: this.hub,
      deviceId: config.deviceId,
      clock: this.clock,
      logger: logger.child ? logger.child('eventos') : logger,
      heartbeatMs: config.hub.heartbeatMs,
      extra: () => ({ configVersionApplied: this.edge.chunks.configVersion(), configVersion: this.edge.chunks.configVersion(), status: this.shortStatus() })
    });
    this.doorStatesReport = new DoorStateReporter({
      clock: this.clock,
      record: (evt) => this.record(evt)
    });
    this.degraded = new DegradedCloudFallback({ controller: this, logger });
    this.buildDoors();
  }

  // ───────────────────────────── armado ─────────────────────────────

  factory(kind) {
    const custom = this.driverDeps[kind];
    if (typeof custom === 'function') return custom;
    return { createReader: drivers.createReader, createOutput: drivers.createOutput, createInput: drivers.createInput }[kind];
  }

  buildDoors() {
    for (const cfg of this.config.doors) {
      const snapDoor = this.edge.snapshot.door(cfg.id) || {};
      const runner = new DoorRunner({
        doorId: cfg.id,
        params: doorParams(snapDoor, cfg),
        clock: this.clock,
        onEffect: (e) => this.onDoorEffect(cfg.id, e),
        onState: (st) => this.persistDoorState(st),
        onEmergencyInput: (active) => this.onEmergencyInput(cfg.id, active)
      });
      const childLog = this.logger.child ? this.logger.child(cfg.id) : this.logger;
      const output = this.factory('createOutput')({ ...cfg.output }, { logger: childLog, ...(this.driverDeps.output || {}) });
      const input = this.factory('createInput')({ ...cfg.inputs }, { logger: childLog });
      const readers = cfg.readers.map((r) => this.factory('createReader')({ ...r }, { logger: childLog, ...(this.driverDeps.reader || {}) }));
      this.doors.set(cfg.id, { cfg, runner, output, input, readers });
    }
  }

  refreshDoorParams() {
    for (const [id, d] of this.doors) d.runner.setParams(doorParams(this.edge.snapshot.door(id) || {}, d.cfg));
  }

  async start({ hub = true, readers = true } = {}) {
    if (this.started) return;
    this.started = true;
    for (const [id, d] of this.doors) {
      await d.input.start((name, value) => d.runner.input(name, value));
      if (readers) {
        for (const r of d.readers) {
          await r.start((cred) => {
            this.handleCredential({ ...cred, doorId: id }).catch((err) => {
              this.logger.error('Error procesando credencial', { error: err.message, stack: err.stack });
            });
          });
        }
      }
    }
    if (hub && this.config.hub.url) {
      this.pusher.start();
      this.configSync.sync('arranque');
      this.pollTimer = setInterval(() => this.configSync.sync('poll'), this.config.hub.configPollMs);
      if (this.pollTimer.unref) this.pollTimer.unref();
      this.degraded.start();
    } else if (hub) {
      this.logger.warn('Sin hub configurado: el controlador decide solo con la config local; los eventos quedan en SQLite');
    }
    this.record({ type: 'controller_started', reason: 'inicio', payload: { configVersion: this.edge.chunks.configVersion(), doors: [...this.doors.keys()] } });
  }

  async stop() {
    this.started = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.doorStatesReport.stop();
    this.pusher.stop();
    this.degraded.stop();
    for (const d of this.doors.values()) {
      d.runner.stop();
      for (const r of d.readers) await r.stop();
      await d.input.stop();
      await d.output.stop();
    }
  }

  close() {
    try { this.edge.db.close(); } catch (_) { /* ignore */ }
  }

  // ───────────────────────────── helpers ─────────────────────────────

  now() {
    return this.edgeClock.now();
  }

  /** snap del motor; con interlock 'off' (banco) se ocultan los grupos de estanco. */
  snap() {
    const s = this.edge.snapshot;
    if (this.config.interlock.mode !== 'off') return s;
    return new Proxy(s, {
      get(target, prop) {
        if (prop === 'interlockGroup') return () => null;
        if (prop === 'interlockGroups') return () => [];
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      }
    });
  }

  doorStates() {
    const out = {};
    for (const [id, d] of this.doors) out[id] = d.runner.view();
    return out;
  }

  engineState() {
    return {
      interlock: this.interlockState,
      presence: null,
      doorStates: this.doorStates(),
      clockTrusted: this.edgeClock.trusted()
    };
  }

  /** Agrega un evento al journal (ts = reloj corregido, clockQ) y despierta el empuje al hub. */
  record(evt) {
    const e = this.edge.journal.append({ ts: this.now(), clockQ: this.edgeClock.quality(), ...evt });
    this.pusher.kick();
    return e;
  }

  persistDoorState(st) {
    try {
      this.edge.db.run(
        'INSERT INTO door_state(door_id, state, since, dps, bond) VALUES (?, ?, ?, ?, ?) ON CONFLICT(door_id) DO UPDATE SET state = excluded.state, since = excluded.since, dps = excluded.dps, bond = excluded.bond',
        st.doorId, st.state, st.since, st.dps, st.bond
      );
    } catch (err) {
      this.logger.warn('No se pudo guardar door_state', { error: err.message });
    }
    this.doorStatesReport.note(st);
  }

  onDoorEffect(doorId, e) {
    const d = this.doors.get(doorId);
    if (e.type === 'output') {
      const run = e.action === 'lock' ? d.output.lock()
        : e.action === 'hold' ? d.output.set(e.on)
          : e.action === 'pulse' ? d.output.pulse(e.ms) : Promise.resolve(null);
      run.then((r) => {
        if (r && r.ok === false) {
          this.record({ type: 'relay_error', doorId, reason: 'relay_error', payload: { action: e.action, error: r.error } });
        }
      }).catch((err) => this.logger.error('Salida falló', { doorId, action: e.action, error: err.message }));
      return;
    }
    if (e.type === 'alarm') {
      this.logger[e.state === 'raised' ? 'warn' : 'info'](`Alarma ${e.code} ${e.state}`, { doorId, detail: e.detail });
      this.record({ type: 'alarm', doorId, reason: e.code, payload: { state: e.state, detail: e.detail || null, doorState: d.runner.state.state } });
      return;
    }
    if (e.type === 'event') {
      this.record({ type: e.code, doorId, reason: e.code, payload: e.detail || null });
    }
  }

  /** Emergencia: mantiene destrabadas la puerta y las de todos sus estancos (las de este equipo). */
  onEmergencyInput(sourceDoorId, active) {
    if (active) this.emergencySources.add(sourceDoorId);
    else this.emergencySources.delete(sourceDoorId);
    const affected = new Set();
    for (const src of this.emergencySources) for (const id of this.emergencyGroup(src)) affected.add(id);
    for (const [id, d] of this.doors) d.runner.dispatch({ type: 'emergency', active: affected.has(id) });
    this.record({
      type: 'emergency_input', doorId: sourceDoorId, reason: active ? 'emergencia_activada' : 'emergencia_liberada',
      payload: { active, doors: [...affected] }
    });
  }

  emergencyGroup(doorId) {
    const ids = new Set([doorId]);
    const snap = this.edge.snapshot;
    const groups = typeof snap.interlockGroups === 'function'
      ? snap.interlockGroups(doorId)
      : [snap.interlockGroup(doorId)].filter(Boolean);
    for (const g of groups) {
      for (const id of g.doorIds || g.doors || []) ids.add(typeof id === 'object' ? id.doorId || id.id : id);
    }
    const extra = this.doors.get(doorId)?.cfg.emergencyDoors;
    if (extra === '*') for (const id of this.doors.keys()) ids.add(id);
    else if (Array.isArray(extra)) extra.forEach((id) => ids.add(id));
    return [...ids].filter((id) => this.doors.has(id));
  }

  /**
   * Ejecuta las acciones de un grant: pulso → efectos de estanco solo si el comando salió → máquina de estados.
   * @returns {{relayOk:boolean, relayConfirmed:boolean, pulseAttempted:boolean, relayError?:string}}
   */
  async executeGrant(decision, { source }) {
    let relayOk = true;
    let relayConfirmed = true;
    let relayError = null;
    let pulseAttempted = false;
    const actions = decision.actions || [];
    for (const a of actions) {
      if (a.type !== 'unlock') continue;
      const d = this.doors.get(a.doorId);
      if (!d) {
        relayOk = false;
        relayConfirmed = false;
        relayError = `Puerta ${a.doorId} no pertenece a este controlador`;
        continue;
      }
      pulseAttempted = true;
      // `output.pulseSeconds` local (si está) manda sobre unlockSec del snapshot: es un dato del hardware.
      const ms = Number(d.cfg.output.pulseSeconds) > 0 ? Math.round(Number(d.cfg.output.pulseSeconds) * 1000) : a.ms;
      let r;
      if (d.runner.state.emergency) r = { ok: true, relayConfirmed: true, detail: { emergencyHold: true } };
      else r = await d.output.pulse(ms);
      relayOk = relayOk && r.ok;
      relayConfirmed = relayConfirmed && Boolean(r.ok && r.relayConfirmed);
      if (!r.ok) {
        relayError = r.error || 'falla de salida';
        continue;
      }
      this.lastPulseAt.set(a.doorId, this.clock.now());
      d.runner.dispatch({ type: 'unlock', ms, source });
    }
    if (!actions.length) {
      relayOk = false;
      relayConfirmed = false;
    }
    // Estanco: el efecto se aplica solo si el pulso realmente salió (confirmado o no).
    if (relayOk) this.applyInterlockEffect(decision);
    return { relayOk, relayConfirmed, pulseAttempted, ...(relayError ? { relayError } : {}) };
  }

  /** Efectos de estanco del motor (uno por grupo de la puerta), si el paso quedó registrado. */
  applyInterlockEffect(decision) {
    const fx = decision.stateEffects || {};
    const list = Array.isArray(fx.interlocks) ? fx.interlocks : (fx.interlock ? [fx.interlock] : []);
    for (const e of list) {
      const { groupId, ...rest } = e || {};
      if (groupId) this.interlockState[groupId] = rest;
    }
  }

  // ───────────────────────────── lectura repetida ─────────────────────────────

  /**
   * Ventana (ms) en la que otra lectura de la misma persona, puerta y lado
   * no es un paso nuevo. La puerta manda; si no trae valor, la política del sitio;
   * si tampoco, 15 s.
   */
  repeatWindowMs(doorId) {
    const snap = this.snap();
    const door = snap && typeof snap.door === 'function' ? snap.door(doorId) : null;
    const policy = snap && typeof snap.policy === 'function' ? snap.policy() : null;
    const raw = door && door.repeatWindowSec != null
      ? door.repeatWindowSec
      : (policy && policy.repeatWindowSec != null ? policy.repeatWindowSec : DEFAULT_POLICY.repeatWindowSec);
    const sec = Number(raw);
    const chosen = Number.isFinite(sec) && sec >= 0 ? sec : DEFAULT_POLICY.repeatWindowSec;
    return Math.round(chosen * 1000);
  }

  /**
   * Último paso real (no lectura_repetida) de esta persona en esta puerta y lado.
   * Memoria del proceso, y si reinició, el journal local.
   */
  anchorPassage(cardholderId, doorId, side) {
    const key = `${cardholderId}|${doorId}|${side}`;
    const mem = this.lastPassage.get(key);
    if (mem) return mem;
    const row = this.edge.db.get(
      `SELECT id, ts, decision FROM events
       WHERE type = 'access' AND cardholder_id = ? AND door_id = ? AND side = ?
         AND ifnull(reason, '') != 'lectura_repetida'
         AND decision IN ('grant', 'deny')
       ORDER BY ts DESC, seq DESC LIMIT 1`,
      cardholderId, doorId, side
    );
    if (!row) return null;
    const found = { at: Number(row.ts), eventId: row.id, decision: row.decision };
    this.lastPassage.set(key, found);
    return found;
  }

  /**
   * Misma persona, misma puerta y lado, mismo resultado (concedido o denegado),
   * dentro de la ventana del último paso real. null si esta lectura es un paso nuevo.
   */
  matchRepeat(decision, doorId, side) {
    const id = decision && decision.cardholderId;
    if (!id || (decision.decision !== 'grant' && decision.decision !== 'deny')) return null;
    const prev = this.anchorPassage(id, doorId, side);
    if (!prev || prev.decision !== decision.decision || !prev.eventId) return null;
    const nowMs = this.now();
    if (!Number.isFinite(prev.at) || nowMs < prev.at) return null;
    if (nowMs - prev.at >= this.repeatWindowMs(doorId)) return null;
    return prev;
  }

  rememberPassage(evt) {
    if (!evt || !evt.cardholderId || !evt.doorId || !evt.side) return;
    if (evt.reason === 'lectura_repetida') return;
    if (evt.decision !== 'grant' && evt.decision !== 'deny') return;
    this.lastPassage.set(`${evt.cardholderId}|${evt.doorId}|${evt.side}`, {
      at: Number(evt.ts),
      eventId: evt.id,
      decision: evt.decision
    });
  }

  // ───────────────────────────── credenciales ─────────────────────────────

  /**
   * Credencial leída en un lector de una puerta de este equipo.
   * @param {{type:string, value:string, doorId:string, readerId?:string, side?:'in'|'out'}} cred
   */
  async handleCredential(cred) {
    const t0 = Date.now();
    const d = this.doors.get(cred.doorId);
    if (!d) return { decision: 'deny', reason: 'puerta_desconocida' };
    const at = this.now();
    const snap = this.snap();
    const snapDoor = snap.door(cred.doorId);
    const readerKnown = Boolean(cred.readerId && snapDoor && (snapDoor.readers || []).some((r) => r.id === cred.readerId));
    const side = cred.side || d.cfg.readers.find((r) => r.id === cred.readerId)?.side || 'in';

    const decideAs = (type, value) => decide({
      snap,
      credential: { type, value },
      ...(this.configSync.credentialKey() ? { credentialKey: this.configSync.credentialKey() } : {}),
      doorId: cred.doorId,
      ...(readerKnown ? { readerId: cred.readerId } : { side }),
      at,
      state: this.engineState(),
      mode: 'scan'
    });

    let decision;
    try {
      // Ficha QR: el DNI embebido se resuelve como la línea suelta. Si ese DNI no está
      // y el texto tampoco es un QR registrado, queda una sola credencial_desconocida.
      if (cred.dniHint) {
        decision = decideAs('dni', cred.dniHint);
        if (decision.reason === 'credencial_desconocida') {
          const byQr = decideAs(cred.type || 'qr', cred.value);
          if (byQr.reason !== 'credencial_desconocida') decision = byQr;
        }
      } else {
        decision = decideAs(cred.type, cred.value);
      }
    } catch (err) {
      this.logger.error('El motor falló', { error: err.message, stack: err.stack });
      decision = { decision: 'deny', reason: 'error_interno', message: reasonMessage('error_interno'), actions: [], stateEffects: {}, warnings: [], side, cardholderId: null, credentialHash: null };
    }

    const passageSide = decision.side || side;
    const repeat = this.matchRepeat(decision, cred.doorId, passageSide);
    const doorOpen = (st) => st === 'DESBLOQUEADA' || st === 'ABIERTA_AUT' || st === 'RETENIDA';

    let relay = { relayOk: false, relayConfirmed: false };
    let approvalId = null;
    if (repeat && decision.decision === 'grant') {
      // Mismo paso: se archiva, no mueve presencia. Pulso solo si la puerta ya se re-trabó.
      decision = {
        ...decision,
        reason: 'lectura_repetida',
        message: reasonMessage('lectura_repetida'),
        repeatOf: repeat.eventId,
        stateEffects: {}
      };
      const st = d.runner.state.state;
      if (doorOpen(st)) {
        relay = { relayOk: true, relayConfirmed: true, alreadyOpen: true, pulseAttempted: false };
      } else {
        relay = await this.executeGrant(decision, { source: 'grant' });
      }
    } else if (repeat && decision.decision === 'deny') {
      decision = {
        ...decision,
        originalReason: decision.reason,
        reason: 'lectura_repetida',
        message: reasonMessage('lectura_repetida'),
        repeatOf: repeat.eventId
      };
    } else if (decision.decision === 'grant') {
      const st = d.runner.state.state;
      // Puerta ya destrabada o abierta: no hay otro pulso. En DESBLOQUEADA se extiende la ventana.
      if (st === 'DESBLOQUEADA' || st === 'ABIERTA_AUT' || st === 'RETENIDA') {
        decision = {
          ...decision,
          reason: 'paso_registrado_puerta_abierta',
          message: reasonMessage('paso_registrado_puerta_abierta')
        };
        if (st === 'DESBLOQUEADA') {
          const ms = (decision.actions && decision.actions[0] && decision.actions[0].ms) || d.runner.params.unlockMs;
          d.runner.dispatch({ type: 'unlock', ms, source: 'grant' });
          relay = { relayOk: true, relayConfirmed: true, extended: true, pulseAttempted: false };
        } else {
          relay = { relayOk: true, relayConfirmed: true, alreadyOpen: true, pulseAttempted: false };
        }
        this.applyInterlockEffect(decision);
      } else {
        relay = await this.executeGrant(decision, { source: 'grant' });
      }
    } else if (decision.decision === 'needs_approval') {
      approvalId = this.addApproval({ cred, decision, side: decision.side || side, at });
    }

    const idNumberMasked = maskIdNumber(cred.type === 'dni' ? cred.value : (cred.dniHint || ''));
    const evt = this.record({
      doorId: cred.doorId,
      side: decision.side || side,
      type: decision.decision === 'needs_approval' ? 'approval_pending' : 'access',
      credType: cred.type,
      credHash: decision.credentialHash || null,
      cardholderId: decision.cardholderId || null,
      decision: decision.decision,
      reason: decision.reason,
      payload: {
        readerId: cred.readerId || null,
        message: decision.message,
        matched: decision.matched || null,
        warnings: decision.warnings || [],
        ...(decision.code ? { code: decision.code } : {}),
        ...(decision.detail ? { detail: decision.detail } : {}),
        ...(decision.passId ? { passId: decision.passId } : {}),
        ...(decision.repeatOf ? { repeatOf: decision.repeatOf } : {}),
        ...(decision.originalReason ? { originalReason: decision.originalReason } : {}),
        stateEffects: decision.stateEffects && Object.keys(decision.stateEffects).length ? decision.stateEffects : null,
        relayOk: relay.relayOk,
        relayConfirmed: relay.relayConfirmed,
        ...(relay.pulseAttempted ? { pulseAttempted: true } : {}),
        ...(relay.extended ? { extended: true } : {}),
        ...(relay.alreadyOpen ? { alreadyOpen: true } : {}),
        ...(relay.relayError ? { relayError: relay.relayError } : {}),
        ...(idNumberMasked ? { idNumberMasked } : {}),
        ...(approvalId ? { approvalId } : {}),
        configVersion: this.edge.chunks.configVersion(),
        latencyMs: Date.now() - t0
      }
    });
    if (approvalId) this.approvals.get(approvalId).eventId = evt.id;
    this.rememberPassage(evt);
    this.logger.info(`Acceso ${decision.decision} (${decision.reason})`, { doorId: cred.doorId, side: decision.side || side, relayConfirmed: relay.relayConfirmed, eventId: evt.id });
    return {
      decision: decision.decision,
      reason: decision.reason,
      message: decision.message,
      relayOk: relay.relayOk,
      relayConfirmed: relay.relayConfirmed,
      eventId: evt.id,
      ...(approvalId ? { approvalId } : {})
    };
  }

  // ───────────────────────────── aprobaciones ─────────────────────────────

  addApproval({ cred, decision, side, at }) {
    this.pruneApprovals();
    const id = `apr-${this.config.deviceId}-${at}-${Math.random().toString(36).slice(2, 7)}`;
    this.approvals.set(id, {
      id,
      doorId: cred.doorId,
      side,
      credType: cred.type,
      credHash: decision.credentialHash || null,
      cardholderId: decision.cardholderId || null,
      requestedAt: at,
      expiresAt: at + this.config.approvalTtlMs,
      eventId: null
    });
    return id;
  }

  pruneApprovals() {
    const now = this.now();
    for (const [id, a] of this.approvals) if (a.expiresAt < now) this.approvals.delete(id);
  }

  listApprovals() {
    this.pruneApprovals();
    return [...this.approvals.values()];
  }

  /**
   * El guardia (vía hub) aprueba o rechaza. Aprobar abre como apertura manual: respeta el estanco.
   */
  async resolveApproval(id, { approve, requestedBy = null, permissions = null, force = false, forceAuthorized = false, reason = '' } = {}) {
    this.pruneApprovals();
    const a = this.approvals.get(id);
    if (!a) return { ok: false, status: 404, code: 'APPROVAL_NOT_FOUND', message: 'La solicitud no existe o venció.' };
    if (!approve) {
      this.approvals.delete(id);
      const evt = this.record({
        type: 'approval_resolved', doorId: a.doorId, side: a.side, credType: a.credType, credHash: a.credHash,
        cardholderId: a.cardholderId, decision: 'deny', reason: 'rechazado_guardia',
        payload: { approvalId: id, requestedBy: actorId(requestedBy), pendingEventId: a.eventId }
      });
      return { ok: true, decision: 'deny', eventId: evt.id };
    }
    const r = await this.openDoor(a.doorId, {
      requestedBy, permissions, force, forceAuthorized, reason: reason || 'Aprobado por guardia', side: a.side, mode: 'manual',
      approval: a
    });
    if (r.ok) this.approvals.delete(id);
    return r;
  }

  // ───────────────────────────── apertura manual / remota ─────────────────────────────

  /**
   * Apertura pedida por el hub (guardia en la LAN o comando de la nube).
   * D4: respeta el estanco; `force` exige permiso puertas.estanco.forzar + motivo (≥ 5 caracteres).
   * @returns {{ok:boolean, status:number, code?:string, decision?:string, reason?:string, message?:string,
   *            forcible?:boolean, forced?:boolean, relayConfirmed?:boolean, eventId?:string}}
   */
  async openDoor(doorId, {
    requestedBy = null, reason = '', force = false, permissions = null, forceAuthorized = false,
    forceReason = null, mode = 'manual', side = 'in', commandId = null, approval = null
  } = {}) {
    const d = this.doors.get(doorId);
    if (!d) return { ok: false, status: 404, code: 'DOOR_NOT_FOUND', message: `La puerta ${doorId} no pertenece a este controlador.` };
    const m = MANUAL_MODES.has(mode) ? mode : 'manual';
    const nowMono = this.clock.now();
    const last = this.lastPulseAt.get(doorId);
    if (last !== undefined && nowMono - last < this.config.cooldownMs) {
      return { ok: false, status: 429, code: 'COOLDOWN', message: 'La puerta se acaba de abrir. Esperá unos segundos.', retryAfterMs: this.config.cooldownMs - (nowMono - last) };
    }
    let perms = Array.isArray(permissions) ? permissions
      : (requestedBy && Array.isArray(requestedBy.permissions) ? requestedBy.permissions : []);
    // El hub (request firmada) puede atestiguar que el permiso ya se validó arriba (guardia en la LAN
    // o comando de la nube): `forceAuthorized:true` equivale a tener puertas.estanco.forzar.
    if (forceAuthorized === true && !perms.includes(FORCE_PERMISSION)) perms = [...perms, FORCE_PERMISSION];
    const actor = { id: actorId(requestedBy), permissions: perms, force: force === true, forceReason: String(forceReason || reason || '') };
    let decision;
    try {
      decision = decide({ snap: this.snap(), doorId, side: side === 'out' ? 'out' : 'in', at: this.now(), state: this.engineState(), mode: m, actor });
    } catch (err) {
      this.logger.error('El motor falló (apertura manual)', { error: err.message });
      return { ok: false, status: 500, code: 'ENGINE_ERROR', message: reasonMessage('error_interno') };
    }
    const type = approval ? 'approval_resolved' : (m === 'remote' ? 'remote_open' : 'manual_open');
    const basePayload = {
      requestedBy: actorId(requestedBy), reasonText: String(reason || ''), force: force === true, commandId,
      ...(force === true && forceReason ? { forceReason: String(forceReason).slice(0, 500) } : {}),
      ...(approval ? { approvalId: approval.id, pendingEventId: approval.eventId } : {}),
      configVersion: this.edge.chunks.configVersion()
    };
    const who = approval ? { credType: approval.credType, credHash: approval.credHash, cardholderId: approval.cardholderId } : {};
    if (decision.decision !== 'grant') {
      const evt = this.record({
        type, doorId, side: decision.side || side, decision: 'deny', reason: decision.reason, ...who,
        payload: { ...basePayload, code: decision.code || null, forcible: decision.forcible === true, message: decision.message, detail: decision.detail || null }
      });
      const status = { estanco_ocupado: 409, motivo_forzado_requerido: 400, puerta_desconocida: 404 }[decision.reason] || 403;
      return {
        ok: false, status, code: decision.code || 'DENIED', decision: 'deny', reason: decision.reason,
        message: decision.detail || decision.message, forcible: decision.forcible === true, eventId: evt.id
      };
    }
    const relay = await this.executeGrant(decision, { source: m });
    const evt = this.record({
      type, doorId, side: decision.side || side, decision: 'grant', reason: decision.reason, ...who,
      payload: { ...basePayload, forced: decision.forced === true, warnings: decision.warnings || [], ...relay }
    });
    if (!relay.relayOk) {
      return { ok: false, status: 502, code: 'RELAY_ERROR', decision: 'grant', reason: decision.reason, message: `No se pudo accionar el relé: ${relay.relayError || 'sin respuesta'}`, relayConfirmed: false, eventId: evt.id };
    }
    return {
      ok: true, status: 200, decision: 'grant', reason: decision.reason, message: decision.message,
      forced: decision.forced === true, relayConfirmed: relay.relayConfirmed, eventId: evt.id
    };
  }

  // ───────────────────────────── simulación / estado ─────────────────────────────

  simInput(doorId, name, value) {
    if (!this.config.simulation.enabled) return { ok: false, status: 403, code: 'SIM_DISABLED', message: 'Simulación deshabilitada en la config.' };
    const d = this.doors.get(doorId);
    if (!d) return { ok: false, status: 404, code: 'DOOR_NOT_FOUND', message: `Puerta ${doorId} desconocida.` };
    if (typeof d.input.set !== 'function') return { ok: false, status: 409, code: 'NOT_SIMULATED', message: 'Las entradas de esta puerta no son simuladas.' };
    const r = d.input.set(name, value);
    if (!r.ok) return { ok: false, status: 400, code: 'BAD_INPUT', message: r.error };
    return { ok: true, status: 200, doorId, input: name, value: r.value };
  }

  shortStatus() {
    const doors = {};
    for (const [id, d] of this.doors) doors[id] = d.runner.view();
    return { doors, clock: this.edgeClock.status(), pendingApprovals: this.approvals.size };
  }

  status() {
    const doors = [];
    for (const [id, d] of this.doors) {
      doors.push({
        id,
        name: (this.edge.snapshot.door(id) || {}).name || d.cfg.name || id,
        ...d.runner.view(),
        output: d.output.health(),
        inputs: d.input.health(),
        readers: d.readers.map((r) => r.health()),
        lastPulseAt: this.lastPulseAt.get(id) ?? null
      });
    }
    return {
      deviceId: this.config.deviceId,
      role: 'controller',
      siteId: this.config.siteId,
      configVersion: this.edge.chunks.configVersion(),
      configVersionApplied: this.edge.chunks.configVersion(),
      config: { ...this.configSync.status, credentialKey: this.configSync.credentialKeyStatus() },
      clock: this.edgeClock.status(),
      interlock: { mode: this.config.interlock.mode, state: this.interlockState },
      doors,
      journal: this.edge.journal.stats(),
      hub: { url: this.config.hub.url, push: this.pusher.status, lastOkAt: this.hub.lastOkAt ?? null, lastError: this.hub.lastError ?? null },
      degraded: this.degraded.status(),
      pendingApprovals: this.listApprovals(),
      simulation: this.config.simulation.enabled
    };
  }
}

function actorId(requestedBy) {
  if (!requestedBy) return null;
  if (typeof requestedBy === 'string') return requestedBy;
  return requestedBy.id || requestedBy.username || requestedBy.uid || null;
}

module.exports = { Controller, actorId };
