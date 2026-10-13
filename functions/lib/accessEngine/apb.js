'use strict';

/**
 * Anti-passback puro.
 *
 * presence: { [presenceKey]: { areaId, ts } } (lo mantiene el hub; el controlador
 * recibe una copia). presenceKey = cardholderId, o 'pass:<id>' para visitas sin ficha.
 *
 * Regla: al cruzar door.sides[side] (zoneFrom → zoneTo) la persona debería estar
 * en zoneFrom. Si la presencia registrada es otra área (y no venció por
 * apbResetMin) hay violación:
 *   - 'soft'  → se permite con aviso 'apb_advertencia';
 *   - 'hard'  → se niega con 'apb_violacion';
 *   - 'off'   → no se evalúa (la presencia se sigue actualizando).
 * Sin presencia conocida → se permite (primer paso). Si `presence` es null
 * (hub caído, sin estado) el APB duro baja a blando: se permite con aviso
 * 'apb_sin_presencia'.
 */

const evaluateApb = ({
  mode = 'off',
  resetMin = 0,
  presence,
  presenceKey,
  door,
  side = 'in',
  at
}) => {
  const sideDef = door?.sides?.[side] || null;
  const zoneFrom = sideDef?.zoneFrom || null;
  const zoneTo = sideDef?.zoneTo || null;
  const effect = (presenceKey && zoneTo) ? { [presenceKey]: { areaId: zoneTo, ts: at } } : null;

  if (mode === 'off' || !zoneFrom || !zoneTo || !presenceKey) {
    return { result: 'ok', reason: null, effect };
  }
  if (presence == null) {
    // En modo blando el colado lo detecta el hub después (apbMonitor): avisar acá
    // marcaría todos los pasos. Solo en modo duro importa que no se pudo controlar.
    if (mode !== 'hard') return { result: 'ok', reason: null, effect };
    return { result: 'warn', reason: 'apb_sin_presencia', effect };
  }
  const current = presence[presenceKey];
  if (!current || !current.areaId) return { result: 'ok', reason: null, effect };
  const resetMs = Math.max(0, Number(resetMin) || 0) * 60000;
  if (resetMs > 0 && Number.isFinite(current.ts) && at - current.ts >= resetMs) {
    return { result: 'ok', reason: null, effect, expired: true };
  }
  if (current.areaId === zoneFrom) return { result: 'ok', reason: null, effect };
  if (mode === 'hard') {
    return { result: 'deny', reason: 'apb_violacion', effect: null, currentAreaId: current.areaId };
  }
  return { result: 'warn', reason: 'apb_advertencia', effect, currentAreaId: current.areaId };
};

module.exports = { evaluateApb };
