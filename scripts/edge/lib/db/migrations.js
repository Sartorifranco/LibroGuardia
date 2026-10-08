'use strict';

/**
 * Migraciones versionadas del SQLite del edge. La versión vive en meta('schema_version')
 * y el rol con el que se creó en meta('schema_role'). Cada migración tiene una parte común
 * (hub y controlador) y una parte solo-hub. Todo usa IF NOT EXISTS: correr `migrate`
 * dos veces no hace nada, y pasar un equipo de controller a hub agrega las tablas que faltan.
 *
 * Diferencias deliberadas con el esquema de ETAPA2-DISENO §3 (ver README):
 * - credentials PK(type, value_hash, cardholder_id) + índice (type, value_hash): así un DNI
 *   repetido entre dos personas queda visible (dni_duplicado) en vez de pisarse.
 * - events UNIQUE(device_id, seq) en vez de seq UNIQUE: en el hub conviven eventos de varios
 *   controladores, cada uno con su propio seq. hub_seq UNIQUE (NULL en el controlador).
 * - holidays PK(date, set_id) para soportar varios calendarios.
 * - columna `chunk` en cardholders/credentials/rights/passes para reemplazar por chunk.
 * - tabla access_groups(id, json) (grupos del chunk `doors`, necesarios para rematerializar rights).
 * - passes.dni para buscar pases por DNI.
 * - chunks.applied_hash: hash del chunk materializado (puede diferir del guardado si se
 *   bajó un chunk nuevo y todavía no se aplicó el head completo).
 */

const MIGRATIONS = [
  {
    version: 1,
    common: `
      CREATE TABLE IF NOT EXISTS chunks (
        name TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        hash TEXT NOT NULL,
        body TEXT NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0,
        applied_hash TEXT,
        stored_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS cardholders (
        id TEXT PRIMARY KEY,
        status TEXT,
        name TEXT,
        valid_from INTEGER,
        valid_to INTEGER,
        flags_json TEXT,
        chunk TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cardholders_chunk ON cardholders(chunk);
      CREATE TABLE IF NOT EXISTS credentials (
        type TEXT NOT NULL,
        value_hash TEXT NOT NULL,
        cardholder_id TEXT NOT NULL,
        status TEXT,
        valid_from INTEGER,
        valid_to INTEGER,
        chunk TEXT,
        PRIMARY KEY (type, value_hash, cardholder_id)
      );
      CREATE INDEX IF NOT EXISTS idx_credentials_type_hash ON credentials(type, value_hash);
      CREATE INDEX IF NOT EXISTS idx_credentials_chunk ON credentials(chunk);
      CREATE TABLE IF NOT EXISTS rights (
        cardholder_id TEXT NOT NULL,
        door_id TEXT NOT NULL,
        schedule_id TEXT,
        source TEXT NOT NULL,
        ref_id TEXT,
        valid_from INTEGER,
        valid_to INTEGER,
        chunk TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rights_cardholder_door ON rights(cardholder_id, door_id);
      CREATE INDEX IF NOT EXISTS idx_rights_chunk ON rights(chunk);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS holidays (
        date TEXT NOT NULL,
        set_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (date, set_id)
      );
      CREATE TABLE IF NOT EXISTS doors (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS interlocks (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS access_groups (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS passes (id TEXT PRIMARY KEY, dni TEXT, json TEXT NOT NULL, chunk TEXT);
      CREATE INDEX IF NOT EXISTS idx_passes_dni ON passes(dni);
      CREATE TABLE IF NOT EXISTS revocations (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        clock_q TEXT,
        device_id TEXT NOT NULL,
        door_id TEXT,
        side TEXT,
        type TEXT,
        cred_type TEXT,
        cred_hash TEXT,
        cardholder_id TEXT,
        decision TEXT,
        reason TEXT,
        payload_json TEXT,
        acked INTEGER NOT NULL DEFAULT 0,
        hub_seq INTEGER,
        UNIQUE (device_id, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_hub_seq ON events(hub_seq);
      CREATE INDEX IF NOT EXISTS idx_events_acked_seq ON events(acked, seq);
      CREATE INDEX IF NOT EXISTS idx_events_door_ts ON events(door_id, ts);
      CREATE TABLE IF NOT EXISTS door_state (
        door_id TEXT PRIMARY KEY,
        state TEXT,
        since INTEGER,
        dps TEXT,
        bond TEXT
      );
    `,
    hub: `
      CREATE INDEX IF NOT EXISTS idx_events_acked_hub_seq ON events(acked, hub_seq);
      CREATE TABLE IF NOT EXISTS presence (
        cardholder_id TEXT PRIMARY KEY,
        area_id TEXT,
        ts INTEGER,
        event_id TEXT
      );
      CREATE TABLE IF NOT EXISTS alarms (
        id TEXT PRIMARY KEY,
        type TEXT,
        door_id TEXT,
        state TEXT,
        first_ts INTEGER,
        last_ts INTEGER,
        count INTEGER NOT NULL DEFAULT 1,
        ack_by TEXT,
        ack_note TEXT
      );
      CREATE TABLE IF NOT EXISTS operators (
        username TEXT PRIMARY KEY,
        hash TEXT,
        pwd_version INTEGER,
        perms_json TEXT,
        posts_json TEXT
      );
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        source TEXT,
        door_id TEXT,
        action TEXT,
        status TEXT,
        requested_by TEXT,
        reason TEXT,
        result_json TEXT,
        ts INTEGER
      );
    `
  }
];

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
const ROLES = new Set(['hub', 'controller']);

function readMeta(db, key) {
  const row = db.get('SELECT value FROM meta WHERE key = ?', key);
  return row ? row.value : null;
}

function writeMeta(db, key, value) {
  db.run(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value === null || value === undefined ? null : String(value)
  );
}

/**
 * Lleva el esquema a la última versión.
 * @param {import('./driver').Db} db
 * @param {{ role?: 'hub'|'controller' }} [opts]
 * @returns {{ from:number, to:number, role:string, applied:number[] }}
 */
function migrate(db, { role = 'controller' } = {}) {
  if (!ROLES.has(role)) throw new Error(`migrate: rol inválido "${role}"`);
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  return db.tx(() => {
    const from = Number(readMeta(db, 'schema_version') || 0);
    if (from > LATEST_VERSION) {
      const err = new Error(`Esquema SQLite v${from} es más nuevo que este programa (v${LATEST_VERSION})`);
      err.code = 'SCHEMA_TOO_NEW';
      throw err;
    }
    const prevRole = readMeta(db, 'schema_role');
    const becameHub = role === 'hub' && prevRole !== 'hub';
    const applied = [];
    for (const m of MIGRATIONS) {
      if (m.version > from) {
        db.exec(m.common);
        if (role === 'hub' && m.hub) db.exec(m.hub);
        applied.push(m.version);
      } else if (becameHub && m.hub) {
        db.exec(m.hub);
      }
    }
    writeMeta(db, 'schema_version', LATEST_VERSION);
    // Un hub nunca vuelve a ser controller: no se borran sus tablas.
    if (prevRole !== 'hub') writeMeta(db, 'schema_role', role);
    return { from, to: LATEST_VERSION, role: prevRole === 'hub' ? 'hub' : role, applied };
  });
}

module.exports = { migrate, readMeta, writeMeta, LATEST_VERSION, MIGRATIONS };
