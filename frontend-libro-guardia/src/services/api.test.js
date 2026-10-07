import {
  apiFetch,
  FORBIDDEN_MESSAGE,
  resetSessionExpiryFlag,
  setSessionExpiredHandler
} from './api';

function jsonResponse(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null)
    },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

describe('apiFetch sesión', () => {
  beforeEach(() => {
    resetSessionExpiryFlag();
    localStorage.clear();
    localStorage.setItem('authToken', 'token-vigente');
    setSessionExpiredHandler(jest.fn());
    global.fetch = jest.fn();
  });

  afterEach(() => {
    setSessionExpiredHandler(null);
  });

  test('403 no cierra la sesión y avisa que no hay permiso', async () => {
    const onExpired = jest.fn();
    setSessionExpiredHandler(onExpired);
    global.fetch.mockResolvedValue(jsonResponse(403, { message: 'forbidden' }));

    await expect(apiFetch('/entries', { token: 'token-vigente' })).rejects.toMatchObject({
      status: 403,
      isForbidden: true,
      message: FORBIDDEN_MESSAGE
    });

    expect(onExpired).not.toHaveBeenCalled();
    expect(localStorage.getItem('authToken')).toBe('token-vigente');
  });

  test('403 con allowForbidden tampoco cierra la sesión', async () => {
    const onExpired = jest.fn();
    setSessionExpiredHandler(onExpired);
    global.fetch.mockResolvedValue(jsonResponse(403, { message: 'Sin permiso para esta puerta' }));

    let caught = null;
    try {
      await apiFetch('/guard/doors', {
        token: 'token-vigente',
        allowForbidden: true
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({
      status: 403,
      isForbidden: true
    });
    expect(caught.isSessionExpired).toBeUndefined();

    expect(onExpired).not.toHaveBeenCalled();
    expect(localStorage.getItem('authToken')).toBe('token-vigente');
  });

  test('401 cierra la sesión', async () => {
    const onExpired = jest.fn();
    setSessionExpiredHandler(onExpired);
    global.fetch.mockResolvedValue(jsonResponse(401, { message: 'unauthorized' }));

    await expect(apiFetch('/entries', { token: 'token-vigente' })).rejects.toMatchObject({
      status: 401,
      isSessionExpired: true
    });

    expect(onExpired).toHaveBeenCalled();
    expect(localStorage.getItem('authToken')).toBeNull();
  });
});
