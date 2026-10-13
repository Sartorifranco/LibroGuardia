/** Reglas del asistente de equipos, en el mismo texto que usa el servidor. */

export function airlockWarning(selectedIds = [], airlocks = [], doors = []) {
  const nameOf = (id) => (doors.find((door) => door.id === id)?.name) || id;
  for (const group of airlocks) {
    const ids = Array.isArray(group.doorIds) ? group.doorIds : [];
    const selected = ids.filter((id) => selectedIds.includes(id));
    if (!selected.length || selected.length === ids.length) continue;
    const missing = ids.filter((id) => !selectedIds.includes(id)).map(nameOf);
    const noun = ids.length === 2 ? 'Las dos puertas' : 'Todas las puertas';
    const name = group.name || 'Estanco';
    return `${noun} del estanco «${name}» tienen que quedar en el mismo equipo. Sumá también ${missing.join(' y ')}.`;
  }
  return '';
}

export function doorMoveWarnings(selectedIds = [], doors = [], devices = []) {
  const moves = [];
  selectedIds.forEach((id) => {
    const door = doors.find((item) => item.id === id);
    let ownerId = door?.controllerId || null;
    if (!ownerId) {
      const listed = devices.find((device) => (
        device.status !== 'replaced'
        && device.status !== 'revoked'
        && Array.isArray(device.doorIds)
        && device.doorIds.includes(id)
      ));
      ownerId = listed?.id || null;
    }
    if (!ownerId) return;
    const owner = devices.find((device) => device.id === ownerId);
    if (owner && (owner.status === 'replaced' || owner.status === 'revoked')) return;
    const name = owner?.name || ownerId;
    moves.push({
      doorId: id,
      fromDeviceName: name,
      message: `Esta puerta pasa del equipo ${name} al nuevo`
    });
  });
  return moves;
}
