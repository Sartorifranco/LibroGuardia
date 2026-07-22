/**
 * Preferencias locales de atajos Ctrl+Alt+1..9 → doorId (por terminal).
 */

const STORAGE_KEY = 'lg.doorHotkeys.v1';

export const HOTKEY_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export function loadDoorHotkeys() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const clean = {};
    HOTKEY_SLOTS.forEach((slot) => {
      const id = parsed[String(slot)] || parsed[slot];
      if (id) clean[String(slot)] = String(id);
    });
    return clean;
  } catch {
    return {};
  }
}

export function saveDoorHotkeys(map = {}) {
  const clean = {};
  HOTKEY_SLOTS.forEach((slot) => {
    const id = map[String(slot)] || map[slot];
    if (id) clean[String(slot)] = String(id);
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  return clean;
}

export function setDoorHotkeySlot(slot, doorId) {
  const n = Number(slot);
  if (!HOTKEY_SLOTS.includes(n)) return loadDoorHotkeys();
  const next = { ...loadDoorHotkeys() };
  if (!doorId) delete next[String(n)];
  else next[String(n)] = String(doorId);
  return saveDoorHotkeys(next);
}

export function clearDoorHotkeys() {
  localStorage.removeItem(STORAGE_KEY);
  return {};
}

/** Resuelve slot 1-9 desde un KeyboardEvent (Ctrl+Alt+digit). */
export function hotkeySlotFromEvent(event) {
  if (!event || !event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey) {
    return null;
  }
  const key = String(event.key || '');
  if (!/^[1-9]$/.test(key)) return null;
  return Number(key);
}

export function doorIdForHotkeySlot(slot, map = loadDoorHotkeys()) {
  return map[String(slot)] || null;
}
