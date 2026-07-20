/**
 * Re-export del driver SR201 (compatibilidad con require('./sr201') y tests existentes).
 * La implementación vive en lib/doorDrivers/sr201.js.
 */
module.exports = require('./lib/doorDrivers/sr201');
