'use strict';

/**
 * Motor de acceso (Etapa 2). CommonJS puro, sin dependencias, Node 20+.
 * Lo usan la nube (vista previa, adaptadores) y el edge (decisión autoritativa).
 */

const schema = require('./snapshotSchema');
const { createMemorySnapshot, mergeChunks } = require('./memorySnapshot');
const schedule = require('./schedule');
const interlock = require('./interlock');
const { evaluateApb } = require('./apb');
const reasons = require('./reasons.es');
const { decide } = require('./decide');

module.exports = {
  decide,
  createMemorySnapshot,
  mergeChunks,
  hashCredential: schema.hashCredential,
  credentialKeyId: schema.credentialKeyId,
  normalizeCredentialValue: schema.normalizeCredentialValue,
  validateSnapshotChunk: schema.validateSnapshotChunk,
  localParts: schedule.localParts,
  isWithinSchedule: schedule.isWithinSchedule,
  evaluateSchedule: schedule.evaluateSchedule,
  evaluateInterlock: interlock.evaluateInterlock,
  deriveAirlockPhase: interlock.deriveAirlockPhase,
  evaluateAirlockPhase: interlock.evaluateAirlockPhase,
  evaluateManualAirlockPhase: interlock.evaluateManualAirlockPhase,
  canForce: interlock.canForce,
  evaluateApb,
  REASONS: reasons.REASONS,
  reasonMessage: reasons.reasonMessage,
  schema,
  schedule,
  interlock,
  reasons
};
