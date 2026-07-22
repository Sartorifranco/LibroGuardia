import {
  hotkeySlotFromEvent,
  doorIdForHotkeySlot,
  saveDoorHotkeys,
  loadDoorHotkeys,
  setDoorHotkeySlot
} from './doorHotkeys';
import { handleDoorHotkeyOpen } from './handleDoorHotkeyOpen';
import { openManualDoor } from './openManualDoor';

jest.mock('../services/api', () => ({
  apiFetch: jest.fn()
}));

jest.mock('./openManualDoor', () => ({
  openManualDoor: jest.fn()
}));

describe('doorHotkeys', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('guarda y lee slots 1-9', () => {
    saveDoorHotkeys({ 1: 'door-a', 3: 'door-b' });
    expect(loadDoorHotkeys()).toEqual({ 1: 'door-a', 3: 'door-b' });
    expect(doorIdForHotkeySlot(1)).toBe('door-a');
    expect(doorIdForHotkeySlot(2)).toBe(null);
  });

  test('setDoorHotkeySlot asigna y quita', () => {
    setDoorHotkeySlot(2, 'x');
    expect(loadDoorHotkeys()['2']).toBe('x');
    setDoorHotkeySlot(2, null);
    expect(loadDoorHotkeys()['2']).toBeUndefined();
  });

  test('hotkeySlotFromEvent solo con Ctrl+Alt+1-9', () => {
    expect(hotkeySlotFromEvent({ ctrlKey: true, altKey: true, key: '5' })).toBe(5);
    expect(hotkeySlotFromEvent({ ctrlKey: true, altKey: false, key: '5' })).toBe(null);
    expect(hotkeySlotFromEvent({ ctrlKey: true, altKey: true, key: '0' })).toBe(null);
  });
});

describe('handleDoorHotkeyOpen', () => {
  beforeEach(() => {
    localStorage.clear();
    openManualDoor.mockReset();
  });

  test('dispara openManualDoor con el doorId del atajo', async () => {
    saveDoorHotkeys({ 1: 'puerta-1' });
    openManualDoor.mockResolvedValue({ message: 'ok' });
    const event = {
      ctrlKey: true,
      altKey: true,
      key: '1',
      preventDefault: jest.fn(),
      stopPropagation: jest.fn()
    };
    const result = await handleDoorHotkeyOpen({
      event,
      authToken: 'tok',
      doors: [{ id: 'puerta-1', name: 'Molinete' }],
      skipConfirm: true
    });
    expect(result.handled).toBe(true);
    expect(openManualDoor).toHaveBeenCalledWith({ authToken: 'tok', doorId: 'puerta-1' });
  });

  test('no llama openManualDoor si el atajo no está asignado', async () => {
    const event = {
      ctrlKey: true,
      altKey: true,
      key: '2',
      preventDefault: jest.fn(),
      stopPropagation: jest.fn()
    };
    const result = await handleDoorHotkeyOpen({
      event,
      authToken: 'tok',
      doors: [{ id: 'puerta-1', name: 'Molinete' }],
      skipConfirm: true
    });
    expect(result.handled).toBe(true);
    expect(result.error).toMatch(/sin puerta/i);
    expect(openManualDoor).not.toHaveBeenCalled();
  });
});
