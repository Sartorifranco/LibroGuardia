import { act, renderHook } from '@testing-library/react';
import usePolling from './usePolling';

const setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('usePolling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('llama al montar y después cada intervalo', async () => {
    const cb = jest.fn().mockResolvedValue(true);
    renderHook(() => usePolling(cb, 15000));
    await act(() => Promise.resolve());
    expect(cb).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(15000); });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('se pausa con la pestaña oculta y refresca una vez al volver', async () => {
    const cb = jest.fn().mockResolvedValue(true);
    renderHook(() => usePolling(cb, 15000));
    await act(() => Promise.resolve());
    expect(cb).toHaveBeenCalledTimes(1);

    await act(async () => { setVisibility('hidden'); });
    await act(async () => { jest.advanceTimersByTime(60000); });
    expect(cb).toHaveBeenCalledTimes(1);

    await act(async () => { setVisibility('visible'); });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('con pauseWhenHidden: false sigue aunque la pestaña esté oculta', async () => {
    const cb = jest.fn().mockResolvedValue(true);
    renderHook(() => usePolling(cb, 15000, { pauseWhenHidden: false }));
    await act(() => Promise.resolve());
    await act(async () => { setVisibility('hidden'); });
    await act(async () => { jest.advanceTimersByTime(15000); });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('con hiddenIntervalMs espacia las consultas mientras la pestaña está oculta', async () => {
    const cb = jest.fn().mockResolvedValue(true);
    renderHook(() => usePolling(cb, 15000, { pauseWhenHidden: false, hiddenIntervalMs: 60000 }));
    await act(() => Promise.resolve());
    await act(async () => { setVisibility('hidden'); });
    await act(async () => { jest.advanceTimersByTime(15000); });
    expect(cb).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(45000); });
    expect(cb).toHaveBeenCalledTimes(2);
    await act(async () => { setVisibility('visible'); });
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('backoff: duplica la espera si el callback devuelve false', async () => {
    const cb = jest.fn().mockResolvedValue(false);
    renderHook(() => usePolling(cb, 15000, { maxBackoffMs: 60000 }));
    await act(() => Promise.resolve());
    expect(cb).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(15000); });
    expect(cb).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(15000); });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('no llama si está deshabilitado', async () => {
    const cb = jest.fn();
    renderHook(() => usePolling(cb, 15000, { enabled: false }));
    await act(async () => { jest.advanceTimersByTime(60000); });
    expect(cb).not.toHaveBeenCalled();
  });
});
