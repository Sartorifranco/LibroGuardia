'use strict';

/**
 * Modo degradado (docs/ETAPA2-DISENO.md §1 "Hub caído"): si el hub no responde por más de 2 min
 * y hay internet, el controlador debería traer comandos de la nube una vez por minuto.
 *
 * TODO(hito 2): implementar contra la API edge de la nube (T4):
 *   - JWT de equipo con refresh token (enroll), GET /api/edge/v1/commands?deviceId=… cada 60 s,
 *   - ejecutar con controller.openDoor(doorId, {mode:'remote', commandId, requestedBy, reason, force}),
 *   - reportar el resultado real (relayConfirmed, doorOpened por DPS) a la nube.
 * Hito 1: solo detecta la condición y la informa en /edge/status.
 */

const HUB_DOWN_MS = 2 * 60 * 1000;

class DegradedCloudFallback {
  constructor({ controller, logger }) {
    this.controller = controller;
    this.logger = logger;
    this.timer = null;
    this.active = false;
  }

  start() {
    this.timer = setInterval(() => this.check(), 60 * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  check() {
    const lastOk = this.controller.hub.lastOkAt;
    const down = lastOk === null || lastOk === undefined ? false : Date.now() - lastOk > HUB_DOWN_MS;
    if (down && !this.active) {
      this.active = true;
      this.logger.warn('Hub sin respuesta hace más de 2 min. Modo degradado (comandos desde la nube) pendiente para el hito 2.');
    } else if (!down && this.active) {
      this.active = false;
    }
  }

  status() {
    return { implemented: false, hubDown: this.active };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { DegradedCloudFallback, HUB_DOWN_MS };
