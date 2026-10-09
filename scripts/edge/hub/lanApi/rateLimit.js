'use strict';

/**
 * Bloqueo de login en memoria: 5 fallos por usuario+IP, 15 minutos.
 * El reloj es el del hub (`now`) para que un test pueda avanzar el tiempo.
 */

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const LOCK_MESSAGE = 'Demasiados intentos fallidos. Probá de nuevo en unos minutos.';

class LoginRateLimit {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.rows = new Map();
  }

  key(username, ip) {
    return `${String(username || '').toLowerCase()}\n${ip || ''}`;
  }

  row(username, ip) {
    const k = this.key(username, ip);
    const cur = this.rows.get(k);
    if (!cur) return { key: k, count: 0, lockedUntil: 0 };
    if (cur.lockedUntil && this.now() >= cur.lockedUntil) {
      this.rows.delete(k);
      return { key: k, count: 0, lockedUntil: 0 };
    }
    return { key: k, ...cur };
  }

  /** @returns {{blocked:boolean, retryAfterSeconds?:number, message?:string}} */
  check(username, ip) {
    const cur = this.row(username, ip);
    if (cur.lockedUntil && this.now() < cur.lockedUntil) {
      return {
        blocked: true,
        retryAfterSeconds: Math.max(1, Math.ceil((cur.lockedUntil - this.now()) / 1000)),
        message: LOCK_MESSAGE
      };
    }
    return { blocked: false };
  }

  fail(username, ip) {
    const cur = this.row(username, ip);
    cur.count += 1;
    if (cur.count >= MAX_FAILS) cur.lockedUntil = this.now() + LOCK_MS;
    this.rows.set(cur.key, { count: cur.count, lockedUntil: cur.lockedUntil });
    return this.check(username, ip);
  }

  clear(username, ip) {
    this.rows.delete(this.key(username, ip));
  }
}

module.exports = { LoginRateLimit, MAX_FAILS, LOCK_MS, LOCK_MESSAGE };
