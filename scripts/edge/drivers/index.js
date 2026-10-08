'use strict';

/** Drivers del edge: lectores, salidas (relé) y entradas (sensores). Ver cada archivo. */

const readers = require('./readers');
const outputs = require('./outputs');
const inputs = require('./inputs');
const serialFramer = require('./serialFramer');
const logger = require('./logger');

module.exports = {
  createReader: readers.createReader,
  createOutput: outputs.createOutput,
  createInput: inputs.createInput,
  frameToCredential: readers.frameToCredential,
  normalizeInputValue: inputs.normalizeInputValue,
  INPUT_NAMES: inputs.INPUT_NAMES,
  readers,
  outputs,
  inputs,
  serialFramer,
  logger
};
