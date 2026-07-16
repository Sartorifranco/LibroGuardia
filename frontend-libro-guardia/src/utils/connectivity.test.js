import { checkBackendConnectivity } from './connectivity';

describe('checkBackendConnectivity', () => {
  const originalFetch = global.fetch;
  const originalNavigator = global.navigator;

  afterEach(() => {
    global.fetch = originalFetch;
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: originalNavigator
    });
  });

  it('marca offline si navigator.onLine es false (sin llamar al backend)', async () => {
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: { onLine: false }
    });
    global.fetch = jest.fn();

    const result = await checkBackendConnectivity({ timeoutMs: 500 });
    expect(result.online).toBe(false);
    expect(result.reason).toBe('navigator_offline');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('marca online si /health responde ok', async () => {
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: { onLine: true }
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await checkBackendConnectivity({ timeoutMs: 500 });
    expect(result.online).toBe(true);
    expect(global.fetch).toHaveBeenCalled();
  });

  it('marca offline si navigator dice online pero /health falla', async () => {
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: { onLine: true }
    });
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await checkBackendConnectivity({ timeoutMs: 500 });
    expect(result.online).toBe(false);
    expect(result.reason).toBe('fetch_failed');
  });
});
