/** Fallback idéntico a `displayName` de functions/lib/gpsProviders/ubika.js. */
export const DEFAULT_GPS_PROVIDER_DISPLAY_NAME = 'UBIKA';

export const gpsProviderDisplayName = (config) =>
  config?.providerDisplayName || DEFAULT_GPS_PROVIDER_DISPLAY_NAME;
