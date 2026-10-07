/**
 * Enmascarado de secretos de hardware (bridgeSecret / httpAuthToken) en respuestas
 * de la API y restauración al guardar.
 *
 * Contrato con el frontend (compatible hacia atrás):
 * - GET devuelve el secreto como "••••" + últimos 2 caracteres y un boolean hasX.
 * - PUT: si el valor recibido es la máscara o vacío, se conserva el secreto guardado.
 *   Cualquier otro valor reemplaza el secreto.
 */

const { slugifyDoorId } = require('./doorsConfig');

const SECRET_MASK_PREFIX = '••••';
const DOOR_DEVICE_SECRET_KEYS = [
  ['bridgeSecret', 'hasBridgeSecret'],
  ['httpAuthToken', 'hasHttpAuthToken']
];

const maskSecret = (value) => {
  const raw = value == null ? '' : String(value);
  if (!raw) return '';
  // Secretos cortos: no revelar caracteres.
  if (raw.length < 8) return SECRET_MASK_PREFIX;
  return `${SECRET_MASK_PREFIX}${raw.slice(-2)}`;
};

const isMaskedSecret = (value) => typeof value === 'string' && value.startsWith(SECRET_MASK_PREFIX);

/**
 * Valor a persistir: vacío o máscara → el existente; otro valor → el nuevo.
 * undefined → undefined (el campo no viene; el caller decide).
 */
const resolveIncomingSecret = (incoming, existing) => {
  if (incoming === undefined) return undefined;
  const value = incoming == null ? '' : String(incoming);
  if (!value || isMaskedSecret(value)) return existing == null ? '' : String(existing);
  return value;
};

const maskDevice = (device) => {
  if (!device || typeof device !== 'object') return device;
  const out = { ...device };
  DOOR_DEVICE_SECRET_KEYS.forEach(([key, flag]) => {
    out[flag] = Boolean(device[key]);
    out[key] = maskSecret(device[key]);
  });
  return out;
};

const maskDoor = (door) => {
  if (!door || typeof door !== 'object') return door;
  return door.device ? { ...door, device: maskDevice(door.device) } : { ...door };
};

const maskDoors = (doors) => (Array.isArray(doors) ? doors.map(maskDoor) : doors);

const maskDoorsConfig = (config) => {
  if (!config || typeof config !== 'object') return config;
  return { ...config, doors: maskDoors(config.doors) };
};

const maskAccessControlConfig = (config) => {
  if (!config || typeof config !== 'object') return config;
  return {
    ...config,
    hasBridgeSecret: Boolean(config.bridgeSecret),
    bridgeSecret: maskSecret(config.bridgeSecret)
  };
};

const doorKey = (door, index) => slugifyDoorId(door?.id || door?.name) || `puerta-${index + 1}`;

/**
 * Restaura secretos enmascarados/vacíos de las puertas entrantes con los guardados.
 * Empareja por id normalizado (mismo criterio que normalizeDoor).
 */
const restoreDoorSecrets = (incomingDoors, previousDoors = []) => {
  if (!Array.isArray(incomingDoors)) return incomingDoors;
  const prevById = new Map();
  (previousDoors || []).forEach((door, index) => prevById.set(doorKey(door, index), door));

  return incomingDoors.map((door, index) => {
    if (!door || typeof door !== 'object') return door;
    const prev = prevById.get(doorKey(door, index));
    const device = { ...(door.device || {}) };
    DOOR_DEVICE_SECRET_KEYS.forEach(([key, flag]) => {
      delete device[flag];
      const resolved = resolveIncomingSecret(device[key], prev?.device?.[key]);
      if (resolved !== undefined) device[key] = resolved;
      else if (prev?.device?.[key]) device[key] = prev.device[key];
    });
    return { ...door, device };
  });
};

/** Global access (settings/accessControl): restaura bridgeSecret si viene enmascarado/vacío. */
const restoreAccessControlSecret = (incoming, previous = {}) => {
  if (!incoming || typeof incoming !== 'object') return incoming;
  const out = { ...incoming };
  delete out.hasBridgeSecret;
  if (out.bridgeSecret !== undefined) {
    out.bridgeSecret = resolveIncomingSecret(out.bridgeSecret, previous?.bridgeSecret);
  }
  return out;
};

module.exports = {
  SECRET_MASK_PREFIX,
  maskSecret,
  isMaskedSecret,
  resolveIncomingSecret,
  maskDoor,
  maskDoors,
  maskDoorsConfig,
  maskAccessControlConfig,
  restoreDoorSecrets,
  restoreAccessControlSecret
};
