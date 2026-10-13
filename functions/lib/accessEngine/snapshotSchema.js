'use strict';

/**
 * Contrato del snapshot compilado por sitio (Etapa 2, docs/ETAPA2-DISENO.md §2–§3).
 *
 * La nube (T2, `functions/lib/siteCompiler`) compila la configuración en chunks;
 * el edge (T3) los guarda en SQLite. El motor (`decide`) nunca lee los chunks
 * directamente: usa la interfaz de búsqueda `SnapLookup` (abajo), con dos
 * implementaciones de semántica idéntica:
 *   - en memoria: `memorySnapshot.js` (nube, vista previa, tests);
 *   - SQLite: `scripts/edge/lib/db/sqliteSnapshot.js` (edge, T3).
 * Los casos dorados (test/accessEngine*.test.js) corren contra ambas.
 *
 * Instantes: ms epoch (el edge también acepta ISO / {_seconds} y los pasa a ms).
 * Fechas de día (feriados): 'YYYY-MM-DD' en la zona del sitio. Los valores de
 * credencial NUNCA viajan en claro: solo `valueHash = hashCredential(type, raw, key)`
 * (HMAC-SHA256 con la clave del sitio; sha256 pelado si el sitio no tiene clave).
 * Pases de visita: con clave viajan con `dniHash` (= hashCredential('dni', dni, key))
 * en lugar del `dni` en claro; sin clave, con `dni` normalizado. Su `id` es el contenido del QR.
 *
 * ─────────────────────────────── Chunks ───────────────────────────────
 *   'doors'            → { site, policy, doors, interlockGroups, areas, schedules, holidays, accessGroups }
 *   'ch-00' … 'ch-63'  → { bucket?, cardholders (con credentials anidadas), credentials? }
 *   'grants-YYYYMMDD'  → { date?, grants }                       (D-1 a D+7)
 *   'passes'           → { passes, revoked }                     (revoked = lista de claves revocadas)
 *   'operators'        → { operators:[{username, hash, passwordVersion, perms, posts}] }   (solo hub)
 *   'secrets'          → { secrets:{credentialKey, keyId, alg} }   (TODO fase 2: cifrado a la clave pública de cada equipo)
 * También se acepta como nombre un tipo de entidad suelto (body = array, o el objeto policy).
 *
 * ─────────────────────────────── Tipos ────────────────────────────────
 *
 * @typedef {'SEGURA'|'DESBLOQUEADA'|'ABIERTA_AUT'|'RETENIDA'|'FORZADA'|'FALLA'} DoorStateName
 *
 * @typedef {Object} DoorSide
 * @property {string|null} zoneFrom   área de la que se sale al cruzar por este lado
 * @property {string|null} zoneTo     área a la que se entra
 * @property {boolean} [enabled=true]
 * @property {boolean} [requireRights]  default: lado 'in' → true, lado 'out' → false (egreso libre)
 *
 * @typedef {Object} Door
 * @property {string} id
 * @property {string} [name]
 * @property {string} [controllerId]   equipo que la decide (el edge materializa rights solo para sus puertas)
 * @property {{in?: DoorSide, out?: DoorSide}|Array<'in'|'out'>} sides   forma array = lados sin áreas (sin APB)
 * @property {{id:string, side:'in'|'out'}[]} [readers]
 * @property {number} [unlockSec=3]
 * @property {number} [heldOpenSec=30]
 * @property {boolean} [requireGuardApproval=false]   D16 → decision 'needs_approval' en modo scan
 * @property {boolean} [sensorsRequired=true]         interlock 'sensor': exige DPS cerrado + bond trabado
 * @property {boolean} [enabled=true]
 * @property {boolean} [lockdown=false]
 *
 * @typedef {Object} InterlockTimings
 * @property {number} [outerCloseDelayMs=5000]
 * @property {number} [interDoorDelayMs=2000]
 * @property {number} [transitTimeoutMs=120000]
 *
 * @typedef {Object} InterlockGroup
 * @property {string} id
 * @property {string[]} doorIds
 * @property {'sensor'|'timed'} mode     'sensor' obligatorio en producción (D5/D17); 'timed' banco
 * @property {string} [outerDoorId]      requerido en 'timed'
 * @property {InterlockTimings} [timings]
 *
 * @typedef {Object} Area
 * @property {string} id
 * @property {string} [name]
 * @property {boolean} [exterior]   true = fuera del predio (el egreso de visita cierra el pase)
 *
 * @typedef {Object} ScheduleInterval
 * @property {number[]} days   0=domingo … 6=sábado (día en que EMPIEZA el intervalo)
 * @property {string} from     'HH:MM'
 * @property {string} to       'HH:MM' ('24:00' admitido); to <= from → cruza medianoche
 *
 * @typedef {Object} Schedule
 * @property {string} id               '24x7' es implícito (siempre válido) si el chunk no lo trae
 * @property {string} [tz]             default policy.tz
 * @property {boolean} [always]        true = 24x7
 * @property {ScheduleInterval[]} intervals
 * @property {number} [toleranceBeforeMin=0]
 * @property {number} [toleranceAfterMin=0]
 * @property {string} [holidaysSetId]  sin valor = cualquier calendario de feriados
 * @property {'deny'|'allow'|'ignore'} [holidayBehavior='ignore']
 *
 * @typedef {{date:string, setId?:string}|string} Holiday   también {setId:[fechas]} ('default' → '')
 *
 * @typedef {Object} AccessGroup
 * @property {string} id                 'grp_total' = { doors:'*' }
 * @property {'*'|Array<string|{doorId:string, scheduleId?:string}>} doors   '*' = todas (incluidas futuras)
 * @property {string} [scheduleId='24x7'] horario del grupo (una entrada puede pisarlo)
 *
 * @typedef {Object} Cardholder
 * @property {string} id
 * @property {'active'|'inactive'|'suspended'} status
 * @property {string} [name]
 * @property {number|null} [validFrom]
 * @property {number|null} [validTo]
 * @property {boolean} [accessAll]           D7: todas las puertas, incluidas futuras (NO genera filas de rights)
 * @property {string} [accessAllScheduleId='24x7']
 * @property {Array<string|{groupId:string, scheduleId?:string, validFrom?:number, validTo?:number}>} [accessLevels]
 * @property {Array<string|{doorId:string, scheduleId?:string, validFrom?:number, validTo?:number}>} [doors]  puertas directas
 * @property {string[]} [allowedDoorIds]     legado: puertas directas 24x7 (se migra a `doors`)
 * @property {string|null} [shiftScheduleId] turno de nómina (restringe los derechos estáticos)
 * @property {boolean} [requiresGrant]       citación obligatoria: los derechos estáticos solo definen puertas
 * @property {Credential[]} [credentials]    anidadas (sin cardholderId)
 *
 * @typedef {Object} Credential
 * @property {'dni'|'card'|'qr'|'biostar'|'pin'} type
 * @property {string} valueHash     hashCredential(type, raw)
 * @property {string} [cardholderId] obligatorio si va suelta en `credentials`
 * @property {'active'|'revoked'|'lost'|'suspended'} [status='active']
 * @property {number|null} [validFrom]
 * @property {number|null} [validTo]
 *
 * @typedef {Object} Grant
 * @property {string} id
 * @property {string} cardholderId
 * @property {number} from
 * @property {number} to
 * @property {string[]|'*'} doors   '*' = todas; con requiresGrant se intersecta con sus derechos estáticos
 * @property {'citacion'|'temporal'|'visita'} source
 * @property {string} [refId]       id de origen (authorization/visita); es el id que ve el motor
 *
 * @typedef {Object} VisitorPass
 * @property {string} id            = contenido del QR
 * @property {string} [dni]         normalizado (solo dígitos); solo si el sitio no tiene clave
 * @property {string} [dniHash]     hashCredential('dni', dni, key); con clave del sitio
 * @property {string} [cardholderId]
 * @property {string} [name]
 * @property {string[]} doors
 * @property {number|string} validFrom      inicio según la duración (lib/visitDuration.js)
 * @property {number|string} validTo        fin según la duración
 * @property {'pendiente'|'autorizada'|'ingreso_registrado'|'egreso_registrado'|'cancelada'|'revocada'} [status]
 * @property {'un_ingreso'|'horas'|'dia'|'mes'} [duracion]
 * @property {string} [scheduleId]   horario del sitio (solo 'mes'): la hora tiene que caer adentro
 * @property {number} [maxUses]      solo 'un_ingreso' (1); sin maxUses entra varias veces alternando
 * @property {number} [uses]
 *
 * Claves de revocación (passes.revoked): 'pass:<id>' o '<id>' pelado (= pase),
 * 'cred:<type>:<hash>', 'ch:<cardholderId>', 'grant:<refId>'.
 *
 * @typedef {Object} Policy
 * @property {string} [tz]                     default site.tz o 'America/Argentina/Buenos_Aires'
 * @property {boolean} [citacionWindowStrict]   false = la citación vale todo el día (aviso si fuera de hora)
 * @property {'off'|'soft'|'hard'} [apbMode]
 * @property {number} [apbResetMin]             0 = sin reseteo por tiempo
 *
 * ─────────────────────── Interfaz SnapLookup ──────────────────────────
 * Todas síncronas (node:sqlite y better-sqlite3 son síncronos).
 *
 * @typedef {Object} RightRow
 * @property {string} doorId
 * @property {'direct'|'group'|'citacion'|'temporal'|'visita'|string} source   otra fuente = grant temporal
 * @property {string|null} refId       id del grupo / del origen del grant; null en directas
 * @property {string|null} scheduleId  '24x7' por defecto en directas/grupos; null en grants (vale from/to)
 * @property {number|null} validFrom
 * @property {number|null} validTo
 *
 * @typedef {Credential & {duplicate?:boolean, cardholderIds?:string[]}} CredentialMatch
 *   status 'duplicate' → el mismo hash en más de una persona (→ dni_duplicado)
 *
 * @typedef {Object} SnapLookup
 * @property {(type:string, valueHash:string) => CredentialMatch|null} findCredential
 * @property {(id:string) => Cardholder|null} cardholder
 * @property {(cardholderId:string, doorId:string) => RightRow[]} rightsFor   directas + grupos + grants; SIN accessAll
 * @property {(id:string) => Schedule|null} schedule                          '24x7' siempre existe
 * @property {(dateYmd:string, setId?:string|null) => boolean} isHoliday       setId null = cualquier calendario
 * @property {(id:string) => Door|null} door
 * @property {(doorId:string) => InterlockGroup|null} interlockGroup         el primero (por id) de interlockGroups
 * @property {(doorId:string) => InterlockGroup[]} [interlockGroups]          todos los estancos de la puerta, por id;
 *                                                                            el motor los evalúa todos (cualquiera niega)
 * @property {(qrIdOrDni:string) => VisitorPass|null} pass                    por id (QR) o por dni (validTo más tardío)
 * @property {(key:string) => boolean} isRevoked
 * @property {() => Policy} policy
 * @property {() => {tz?:string}} [site]
 * @property {() => (string|null)} [credentialKey]                             clave HMAC del sitio (chunk 'secrets')
 * @property {(id:string) => Area|null} [area]                                 opcional (el edge aún no lo tiene)
 */

const crypto = require('node:crypto');

const CREDENTIAL_TYPES = ['dni', 'card', 'qr', 'biostar', 'pin'];
const DOOR_STATES = ['SEGURA', 'DESBLOQUEADA', 'ABIERTA_AUT', 'RETENIDA', 'FORZADA', 'FALLA'];
const DEFAULT_TZ = 'America/Argentina/Buenos_Aires';
/** Misma persona, misma puerta y lado: segunda lectura dentro de esta ventana no es otro paso. */
const DEFAULT_REPEAT_WINDOW_SEC = 15;
const DEFAULT_POLICY = Object.freeze({
  tz: DEFAULT_TZ,
  citacionWindowStrict: false,
  apbMode: 'off',
  apbResetMin: 0,
  repeatWindowSec: DEFAULT_REPEAT_WINDOW_SEC
});
const SCHEDULE_24X7 = Object.freeze({ id: '24x7', builtin: true, always: true });

/**
 * Normalización de cada tipo de credencial antes del hash.
 * - dni: copia EXACTA de `normalizeDni` de functions/lib/normalize.js:
 *   `String(dni || '').replace(/\D/g, '')` — solo dígitos, NO quita ceros a la izquierda.
 * - card: sin espacios ni guiones, en mayúsculas (hex/decimal de tarjeta).
 * - qr, biostar, pin: trim.
 */
const normalizeCredentialValue = (type, raw) => {
  const value = String(raw == null ? '' : raw);
  switch (type) {
    case 'dni': return value.replace(/\D/g, '');
    case 'card': return value.replace(/[\s-]/g, '').toUpperCase();
    case 'qr':
    case 'biostar':
    case 'pin':
      return value.trim();
    default:
      throw new TypeError(`Tipo de credencial desconocido: ${type}`);
  }
};

/**
 * Clave de credenciales del sitio -> Buffer. Buffer/Uint8Array se usan tal cual;
 * un string se interpreta como base64 (así se guarda en
 * `sites/{siteId}/secrets/credentialKey` y viaja en el chunk `secrets`).
 */
const credentialKeyBytes = (key) => {
  if (key == null || key === '') return null;
  if (Buffer.isBuffer(key)) return key.length ? key : null;
  if (key instanceof Uint8Array) return key.length ? Buffer.from(key) : null;
  const buf = Buffer.from(String(key), 'base64');
  return buf.length ? buf : null;
};

/**
 * Hash hex de `${type}:${valorNormalizado}`. El prefijo de tipo evita que un
 * mismo número como DNI y como tarjeta colisionen. null si el valor queda vacío.
 *  - con `key` (clave por sitio, decisión del dueño): HMAC-SHA256; un DNI no se
 *    puede adivinar por fuerza bruta sin la clave;
 *  - sin `key`: sha256 pelado (compatibilidad con snapshots y tests previos).
 */
const hashCredential = (type, rawValue, key = null) => {
  const normalized = normalizeCredentialValue(type, rawValue);
  if (!normalized) return null;
  const keyBytes = credentialKeyBytes(key);
  if (keyBytes) return crypto.createHmac('sha256', keyBytes).update(`${type}:${normalized}`, 'utf8').digest('hex');
  return crypto.createHash('sha256').update(`${type}:${normalized}`, 'utf8').digest('hex');
};

/** Huella pública de la clave (no secreta): detecta un cambio de clave sin exponerla. */
const credentialKeyId = (key) => {
  const keyBytes = credentialKeyBytes(key);
  if (!keyBytes) return null;
  return crypto.createHash('sha256').update(keyBytes).digest('hex').slice(0, 16);
};

// ───────────────────────────── Validación ─────────────────────────────

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isTime = (v) => isNum(v) || (isStr(v) && Number.isFinite(Date.parse(v)))
  || (v && typeof v === 'object' && Number.isFinite(Number(v._seconds ?? v.seconds)));
const isOptTime = (v) => v == null || isTime(v);
const isDoorList = (v) => v === '*' || (Array.isArray(v) && v.every((d) => isStr(d) || isStr(d?.doorId) || isStr(d?.id)));

const validateCredential = (c, err, nested) => {
  if (!CREDENTIAL_TYPES.includes(c.type)) err(`type inválido "${c.type}"`);
  if (!/^[0-9a-f]{64}$/.test(c.valueHash || '')) err('valueHash debe ser sha256 hex');
  if (!nested && !isStr(c.cardholderId)) err('cardholderId requerido');
  if (Object.prototype.hasOwnProperty.call(c, 'value')) err('el valor en claro no puede viajar en el snapshot');
  if (!isOptTime(c.validFrom) || !isOptTime(c.validTo)) err('validFrom/validTo inválidos');
};

const validators = {
  doors(d, err) {
    if (!isStr(d.id)) err('id requerido');
    if (Array.isArray(d.sides)) {
      if (d.sides.some((s) => s !== 'in' && s !== 'out')) err('sides inválido');
    } else if (!d.sides || typeof d.sides !== 'object') err('sides requerido');
    else {
      for (const k of Object.keys(d.sides)) {
        if (k !== 'in' && k !== 'out') err(`lado inválido "${k}"`);
      }
    }
    if (d.readers != null) {
      if (!Array.isArray(d.readers)) err('readers debe ser array');
      else d.readers.forEach((r) => {
        if (!isStr(r?.id)) err('reader.id requerido');
        if (r?.side !== 'in' && r?.side !== 'out') err(`reader ${r?.id}: side inválido`);
      });
    }
    if (d.unlockSec != null && !(isNum(d.unlockSec) && d.unlockSec > 0)) err('unlockSec inválido');
    if (d.heldOpenSec != null && !(isNum(d.heldOpenSec) && d.heldOpenSec > 0)) err('heldOpenSec inválido');
    if (d.repeatWindowSec != null && !(isNum(d.repeatWindowSec) && d.repeatWindowSec >= 0)) err('repeatWindowSec inválido');
  },
  interlockGroups(g, err) {
    if (!isStr(g.id)) err('id requerido');
    if (!Array.isArray(g.doorIds) || g.doorIds.length < 2) err('doorIds requiere ≥2 puertas');
    if (g.mode !== 'sensor' && g.mode !== 'timed') err('mode debe ser sensor|timed');
    if (g.mode === 'timed' && (!isStr(g.outerDoorId) || !g.doorIds?.includes(g.outerDoorId))) {
      err('timed requiere outerDoorId dentro de doorIds');
    }
  },
  areas(a, err) { if (!isStr(a.id)) err('id requerido'); },
  schedules(s, err) {
    if (!isStr(s.id)) err('id requerido');
    if (s.always) return;
    if (!Array.isArray(s.intervals)) { err('intervals requerido'); return; }
    s.intervals.forEach((iv, i) => {
      if (!Array.isArray(iv?.days) || iv.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        err(`intervals[${i}].days inválido`);
      }
      if (!HHMM.test(iv?.from || '') || !HHMM.test(iv?.to || '')) err(`intervals[${i}] from/to HH:MM`);
    });
    if (s.holidayBehavior != null && !['deny', 'allow', 'ignore'].includes(s.holidayBehavior)) {
      err('holidayBehavior inválido');
    }
  },
  holidays(h, err) {
    if (typeof h === 'string') { if (!YMD.test(h)) err('fecha YYYY-MM-DD'); return; }
    if (!YMD.test(h?.date || '')) err('date YYYY-MM-DD requerido');
  },
  accessGroups(g, err) {
    if (!isStr(g.id)) err('id requerido');
    if (!isDoorList(g.doors ?? g.doorIds)) err("doors debe ser '*' o lista de puertas");
  },
  cardholders(c, err) {
    if (!isStr(c.id)) err('id requerido');
    if (c.status != null && !isStr(c.status)) err('status inválido');
    if (!isOptTime(c.validFrom) || !isOptTime(c.validTo)) err('validFrom/validTo inválidos');
    if (c.accessLevels != null && !Array.isArray(c.accessLevels)) err('accessLevels debe ser array');
    if (c.doors != null && !isDoorList(c.doors)) err('doors debe ser lista de puertas');
    if (c.credentials != null) {
      if (!Array.isArray(c.credentials)) err('credentials debe ser array');
      else c.credentials.forEach((cr, i) => validateCredential(cr || {}, (m) => err(`credentials[${i}]: ${m}`), true));
    }
  },
  credentials(c, err) { validateCredential(c, err, false); },
  grants(g, err) {
    if (!isStr(g.id)) err('id requerido');
    if (!isStr(g.cardholderId)) err('cardholderId requerido');
    if (!isTime(g.from) || !isTime(g.to)) err('from/to inválidos');
    else if (isNum(g.from) && isNum(g.to) && g.to < g.from) err('to < from');
    if (!isDoorList(g.doors)) err("doors debe ser array o '*'");
    if (!['citacion', 'temporal', 'visita'].includes(g.source)) err('source inválido');
  },
  passes(p, err) {
    if (!isStr(p.id)) err('id (QR) requerido');
    if (p.dni != null && !/^\d+$/.test(String(p.dni))) err('dni debe venir normalizado (solo dígitos)');
    if (p.dniHash != null && !/^[0-9a-f]{64}$/.test(String(p.dniHash))) err('dniHash debe ser hex de 64');
    if (!Array.isArray(p.doors)) err('doors requerido');
    if (!isTime(p.validFrom) || !isTime(p.validTo)) err('validFrom/validTo requeridos');
    if (p.scheduleId != null && !isStr(p.scheduleId)) err('scheduleId inválido');
  },
  revoked(r, err) { if (!isStr(typeof r === 'string' ? r : r?.id)) err('clave requerida'); },
  policy(p, err) {
    if (p.tz != null && !isStr(p.tz)) err('tz inválido');
    if (p.apbMode != null && !['off', 'soft', 'hard'].includes(p.apbMode)) err('apbMode inválido');
    if (p.apbResetMin != null && !(isNum(p.apbResetMin) && p.apbResetMin >= 0)) err('apbResetMin inválido');
    if (p.repeatWindowSec != null && !(isNum(p.repeatWindowSec) && p.repeatWindowSec >= 0)) err('repeatWindowSec inválido');
  },
  site(s, err) { if (s.tz != null && !isStr(s.tz)) err('tz inválido'); },
  operators(o, err) {
    if (!isStr(o.username)) err('username requerido');
    if (!isStr(o.hash)) err('hash (bcrypt) requerido');
    if (Object.prototype.hasOwnProperty.call(o, 'password')) err('la contraseña en claro no puede viajar');
    if (o.perms != null && !Array.isArray(o.perms)) err('perms debe ser array');
    if (o.posts != null && !Array.isArray(o.posts)) err('posts debe ser array');
  },
  secrets(s, err) {
    if (s.credentialKey != null && !isStr(s.credentialKey)) err('credentialKey debe ser base64');
  }
};

const ENTITY_KINDS = Object.keys(validators);
const OBJECT_KINDS = new Set(['policy', 'site', 'secrets']);
const META_KEYS = { bucket: (v) => Number.isInteger(v), date: (v) => YMD.test(String(v || '')) };

/** Claves admitidas por nombre de chunk compuesto. */
const chunkLayout = (name) => {
  if (name === 'doors') return ['site', 'policy', 'doors', 'interlockGroups', 'areas', 'schedules', 'holidays', 'accessGroups'];
  if (/^ch-\d{2}$/.test(name)) return ['bucket', 'cardholders', 'credentials'];
  if (/^grants-\d{8}$/.test(name)) return ['date', 'grants'];
  if (name === 'passes') return ['passes', 'revoked'];
  if (name === 'operators') return ['operators'];
  if (name === 'secrets') return ['secrets'];
  if (ENTITY_KINDS.includes(name)) return [name];
  return null;
};

const validateList = (kind, list, errors) => {
  if (META_KEYS[kind]) {
    if (!META_KEYS[kind](list)) errors.push(`${kind}: inválido`);
    return;
  }
  if (OBJECT_KINDS.has(kind)) {
    if (!list || typeof list !== 'object' || Array.isArray(list)) {
      errors.push(`${kind}: debe ser objeto`);
      return;
    }
    validators[kind](list, (m) => errors.push(`${kind}: ${m}`));
    return;
  }
  if (kind === 'holidays' && list && typeof list === 'object' && !Array.isArray(list)) {
    for (const [setId, dates] of Object.entries(list)) {
      if (!Array.isArray(dates)) errors.push(`holidays.${setId}: debe ser array`);
      else dates.forEach((d) => validators.holidays(d, (m) => errors.push(`holidays.${setId}: ${m}`)));
    }
    return;
  }
  if (!Array.isArray(list)) {
    errors.push(`${kind}: debe ser array`);
    return;
  }
  list.forEach((item, i) => {
    const primitiveOk = (kind === 'revoked' || kind === 'holidays') && typeof item === 'string';
    if (!primitiveOk && (item == null || typeof item !== 'object')) {
      errors.push(`${kind}[${i}]: no es objeto`);
      return;
    }
    validators[kind](item, (m) => errors.push(`${kind}[${i}]: ${m}`));
  });
};

/**
 * Valida el body de un chunk.
 * @param {string} name   'doors' | 'ch-NN' | 'grants-YYYYMMDD' | 'passes' | tipo de entidad suelto
 * @param {object|Array} body
 * @returns {{ok:boolean, errors:string[]}}
 */
const validateSnapshotChunk = (name, body) => {
  const errors = [];
  const key = String(name || '');
  const layout = chunkLayout(key);
  if (!layout) return { ok: false, errors: [`chunk desconocido "${name}"`] };
  const loose = Array.isArray(body) || (OBJECT_KINDS.has(key) && body && !body[key]);
  if (loose) {
    if (!ENTITY_KINDS.includes(key)) errors.push(`chunk "${key}" requiere objeto con claves ${layout.join(', ')}`);
    else validateList(key, body, errors);
    return { ok: errors.length === 0, errors };
  }
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body debe ser objeto'] };
  for (const k of Object.keys(body)) {
    if (!layout.includes(k)) errors.push(`clave "${k}" no admitida en chunk "${key}"`);
  }
  for (const k of layout) {
    if (body[k] != null) validateList(k, body[k], errors);
  }
  return { ok: errors.length === 0, errors };
};

module.exports = {
  CREDENTIAL_TYPES,
  DOOR_STATES,
  DEFAULT_TZ,
  DEFAULT_POLICY,
  DEFAULT_REPEAT_WINDOW_SEC,
  SCHEDULE_24X7,
  ENTITY_KINDS,
  chunkLayout,
  normalizeCredentialValue,
  credentialKeyBytes,
  credentialKeyId,
  hashCredential,
  validateSnapshotChunk
};
