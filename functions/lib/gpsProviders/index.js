/**
 * Registry de proveedores GPS de flota.
 * Para cotizar un conector nuevo: implementar este contrato y registrar acá.
 * Ver docs/GPS-PROVEEDOR.md.
 *
 * Contrato:
 *   id, displayName
 *   resolveCredentials(config) → { apiUrl, apiKey, ... }
 *   isConfigured(config) → boolean
 *   missingConfigMessage → string
 *   fetchDevices(config) → Promise<any[]>
 *   fetchPositions(config) → Promise<any[]>
 *   fetchFleet(config) → Promise<NormalizedVehicle[]>
 */

const ubika = require('./ubika');
const { extractPlate, extractVehicleLabel } = require('./vehicleLabel');
const { isGpsFleetEntry, gpsEntrySourceForProvider } = require('./entrySource');
const { joinDevicesAndPositions } = require('./traccarLike');

const DEFAULT_PROVIDER = 'ubika';

const PROVIDERS = {
  ubika
};

const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

const resolveProviderId = (provider) => {
  const id = String(provider || '').trim().toLowerCase();
  if (id && PROVIDERS[id]) return id;
  return DEFAULT_PROVIDER;
};

const getGpsProvider = (provider) => PROVIDERS[resolveProviderId(provider)];

const withDefaultFetchFleet = (provider) => {
  if (!provider) {
    throw new Error('El proveedor GPS es obligatorio');
  }
  if (!provider.fetchFleet && !(provider.fetchDevices && provider.fetchPositions)) {
    throw new Error('El proveedor GPS debe implementar fetchFleet() o fetchDevices()+fetchPositions()');
  }
  if (provider.fetchFleet) return provider;
  return {
    ...provider,
    fetchFleet: async (config) => {
      const [devices, positions] = await Promise.all([
        provider.fetchDevices(config),
        provider.fetchPositions(config)
      ]);
      return joinDevicesAndPositions(devices, positions);
    }
  };
};

const fetchFleetFromProvider = async (config = {}) => {
  const provider = getGpsProvider(config.provider);
  return provider.fetchFleet(config);
};

module.exports = {
  DEFAULT_PROVIDER,
  PROVIDER_IDS,
  PROVIDERS,
  resolveProviderId,
  getGpsProvider,
  withDefaultFetchFleet,
  fetchFleetFromProvider,
  extractPlate,
  extractVehicleLabel,
  isGpsFleetEntry,
  gpsEntrySourceForProvider,
  joinDevicesAndPositions
};
