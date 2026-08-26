/**
 * Join devices + positions al estilo Traccar (UBIKA y clones).
 * Un proveedor nuevo que no sea Traccar no usa esto: implementa fetchFleet() a mano.
 */

const { extractPlate } = require('./vehicleLabel');

const isValidPosition = (position) => (
  position
  && position.valid !== false
  && position.latitude != null
  && position.longitude != null
  && !Number.isNaN(Number(position.latitude))
  && !Number.isNaN(Number(position.longitude))
);

/**
 * @returns {Array<{
 *   id: string,
 *   deviceId: *,
 *   name: string,
 *   plate: string|null,
 *   status: string,
 *   lat: number,
 *   lng: number,
 *   speed: number,
 *   fixTime: * ,
 *   ignition: boolean,
 *   motion: boolean
 * }>}
 */
const joinDevicesAndPositions = (devices = [], positions = []) => {
  const deviceList = Array.isArray(devices) ? devices : [];
  const positionList = Array.isArray(positions) ? positions : [];
  const deviceById = new Map(deviceList.map((device) => [device.id, device]));

  return positionList
    .filter(isValidPosition)
    .map((position) => {
      const device = deviceById.get(position.deviceId);
      const name = device?.name || `Dispositivo ${position.deviceId}`;
      return {
        id: String(device?.uniqueId || position.deviceId),
        deviceId: position.deviceId,
        name,
        plate: extractPlate(name),
        status: device?.status || 'unknown',
        lat: Number(position.latitude),
        lng: Number(position.longitude),
        speed: Number(position.speed) || 0,
        fixTime: position.fixTime || position.deviceTime || null,
        ignition: Boolean(position.attributes?.ignition),
        motion: Boolean(position.attributes?.motion)
      };
    });
};

module.exports = {
  isValidPosition,
  joinDevicesAndPositions
};
