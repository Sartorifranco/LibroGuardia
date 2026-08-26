import { gpsProviderDisplayName, DEFAULT_GPS_PROVIDER_DISPLAY_NAME } from './gpsProviderLabel';

describe('gpsProviderLabel', () => {
  test('fallback es UBIKA y prioriza providerDisplayName del backend', () => {
    expect(DEFAULT_GPS_PROVIDER_DISPLAY_NAME).toBe('UBIKA');
    expect(gpsProviderDisplayName(null)).toBe('UBIKA');
    expect(gpsProviderDisplayName({ providerDisplayName: 'UBIKA' })).toBe('UBIKA');
  });
});
