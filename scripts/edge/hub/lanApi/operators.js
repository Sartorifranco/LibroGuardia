'use strict';

/**
 * Operadores del chunk `operators` (tabla `operators` + campos extra del cuerpo
 * del chunk: role, name, mustChangePassword, active). La tabla es la fuente del
 * hash, passwordVersion, permisos y puestos.
 */

const bcrypt = require('../../../../functions/node_modules/bcryptjs');

function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    const v = JSON.parse(text);
    return v == null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

function extrasByUsername(db) {
  const map = new Map();
  let body = null;
  try {
    const chunk = db.get("SELECT body FROM chunks WHERE name = 'operators'");
    body = chunk ? JSON.parse(chunk.body) : null;
  } catch (_) {
    body = null;
  }
  const list = body && Array.isArray(body.operators) ? body.operators : [];
  for (const o of list) {
    if (o && o.username) map.set(String(o.username).toLowerCase(), o);
  }
  return map;
}

function loadOperator(db, username) {
  const name = String(username || '').trim();
  if (!name) return null;
  const row = db.get(
    'SELECT username, hash, pwd_version, perms_json, posts_json FROM operators WHERE lower(username) = lower(?)',
    name
  );
  if (!row) return null;
  const extra = extrasByUsername(db).get(String(row.username).toLowerCase()) || {};
  const perms = parseJson(row.perms_json, []);
  const posts = parseJson(row.posts_json, []);
  return {
    id: row.username,
    username: row.username,
    hash: row.hash,
    passwordVersion: Number(row.pwd_version) || 0,
    permissions: Array.isArray(perms) ? perms.map(String) : [],
    posts: Array.isArray(posts) ? posts.map(String) : [],
    role: extra.role ? String(extra.role) : 'guardia',
    nombre: extra.name || extra.nombre || null,
    email: extra.email || null,
    empresaId: extra.empresaId || null,
    mustChangePassword: extra.mustChangePassword === true,
    active: extra.active !== false
  };
}

function publicUser(op) {
  return {
    id: op.id,
    username: op.username,
    role: op.role,
    roleLabel: op.role,
    dashboardProfile: op.role,
    active: op.active !== false,
    mustChangePassword: op.mustChangePassword === true,
    permissions: op.permissions,
    customPermissions: [],
    empresaId: op.empresaId || null,
    nombre: op.nombre || null,
    email: op.email || null
  };
}

function hasPerm(op, permission) {
  if (!op || op.active === false) return false;
  if (op.role === 'admin') return true;
  return op.permissions.includes(permission);
}

function hasAnyPerm(op, permissions) {
  if (!op || op.active === false) return false;
  if (op.role === 'admin') return true;
  return permissions.some((p) => op.permissions.includes(p));
}

async function checkPassword(op, password) {
  if (!op || !op.hash || password == null || password === '') return false;
  try {
    return await bcrypt.compare(String(password), op.hash);
  } catch (_) {
    return false;
  }
}

module.exports = { loadOperator, publicUser, hasPerm, hasAnyPerm, checkPassword };
