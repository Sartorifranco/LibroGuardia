/**
 * Registry de drivers de puerta.
 * device.driver ausente o desconocido → 'sr201' (retrocompatibilidad).
 */

const sr201 = require('./sr201');
const genericHttp = require('./genericHttp');

const DEFAULT_DRIVER = 'sr201';

const DRIVERS = {
  sr201,
  generic_http: genericHttp
};

const DRIVER_IDS = Object.freeze(Object.keys(DRIVERS));

const resolveDriverId = (driver) => {
  const id = String(driver || '').trim();
  if (id && DRIVERS[id]) return id;
  return DEFAULT_DRIVER;
};

const getDoorDriver = (driver) => DRIVERS[resolveDriverId(driver)];

/**
 * Dispara el relé usando el driver indicado en deviceConfig.driver.
 * Misma forma de resultado que sr201.triggerRelay.
 */
const triggerRelay = async (deviceConfig = {}, options = {}) => {
  const driver = getDoorDriver(deviceConfig.driver);
  return driver.triggerRelay(deviceConfig, options);
};

module.exports = {
  DEFAULT_DRIVER,
  DRIVER_IDS,
  DRIVERS,
  resolveDriverId,
  getDoorDriver,
  triggerRelay
};
