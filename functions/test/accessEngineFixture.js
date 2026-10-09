'use strict';

/**
 * Sitio de prueba para los tests del motor de acceso (no es un test: lo importan
 * accessEngine*.test.js). Fechas en hora de Argentina (UTC−3, sin horario de verano).
 * 2026-10-05 lun · 06 mar · 07 mié · 08 jue · 09 vie · 10 sáb · 11 dom · 12 lun (feriado)
 */

const { hashCredential } = require('../lib/accessEngine');

const ar = (ymd, hhmm = '00:00', ss = '00') => Date.parse(`${ymd}T${hhmm}:${ss}.000-03:00`);

const side = (zoneFrom, zoneTo, extra = {}) => ({ zoneFrom, zoneTo, ...extra });
const door = (id, extra = {}) => ({
  id,
  name: `Puerta ${id}`,
  sides: { in: side('exterior', 'planta'), out: side('planta', 'exterior') },
  readers: [{ id: `${id}-in`, side: 'in' }, { id: `${id}-out`, side: 'out' }],
  unlockSec: 3,
  heldOpenSec: 30,
  enabled: true,
  ...extra
});

/** Clave HMAC del sitio mientras se arma un bundle con clave (ver buildKeyedChunks). */
let CURRENT_KEY = null;

const cred = (type, raw, cardholderId, extra = {}) => ({
  type, valueHash: hashCredential(type, raw, CURRENT_KEY), cardholderId, status: 'active', ...extra
});

const ALL_DOORS = ['D1', 'D2', 'D5', 'D6', 'EA', 'EB', 'TA', 'TB'];

const buildChunks = (overrides = {}) => ({
  doors: {
    site: { tz: 'America/Argentina/Buenos_Aires' },
    policy: {
      tz: 'America/Argentina/Buenos_Aires',
      citacionWindowStrict: false,
      apbMode: 'off',
      apbResetMin: 0,
      ...(overrides.policy || {})
    },
    areas: [
      { id: 'exterior', exterior: true },
      { id: 'planta' },
      { id: 'oficinas' },
      { id: 'esclusa' }
    ],
    doors: [
      door('D1', { name: 'Portón' }),
      door('D2', { name: 'Oficinas', sides: { in: side('planta', 'oficinas'), out: side('oficinas', 'planta') } }),
      door('D3', { enabled: false }),
      door('D4', { lockdown: true }),
      door('D5', { sides: { in: side('exterior', 'planta') }, readers: [{ id: 'D5-in', side: 'in' }] }),
      door('D6', { name: 'Portón clientes', requireGuardApproval: true }),
      door('EA', { name: 'Estanco ext', sides: { in: side('exterior', 'esclusa'), out: side('esclusa', 'exterior') } }),
      door('EB', { name: 'Estanco int', sides: { in: side('esclusa', 'planta'), out: side('planta', 'esclusa') } }),
      door('TA', { name: 'Esclusa ext', sides: { in: side('exterior', 'esclusa'), out: side('esclusa', 'exterior', { requireRights: true }) } }),
      door('TB', { name: 'Esclusa int', sides: { in: side('esclusa', 'planta'), out: side('planta', 'esclusa', { requireRights: true }) } }),
      ...(overrides.extraDoors || [])
    ],
    interlockGroups: [
      { id: 'G1', doorIds: ['EA', 'EB'], mode: 'sensor' },
      { id: 'G2', doorIds: ['TA', 'TB'], mode: 'timed', outerDoorId: 'TA',
        timings: { outerCloseDelayMs: 5000, interDoorDelayMs: 2000, transitTimeoutMs: 120000 } }
    ],
    schedules: [
      { id: 'oficina', intervals: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }],
        holidaysSetId: 'default', holidayBehavior: 'deny' },
      { id: 'noche', intervals: [{ days: [1, 2, 3, 4, 5], from: '22:00', to: '06:00' }] },
      { id: 'turno_m', intervals: [{ days: [1, 2, 3, 4, 5], from: '06:00', to: '14:00' }],
        toleranceBeforeMin: 30, toleranceAfterMin: 15 },
      { id: 'vacio', intervals: [] }
    ],
    holidays: [{ date: '2026-10-12', setId: 'default', name: 'Diversidad cultural' }],
    accessGroups: [
      { id: 'grp_total', doors: '*', scheduleId: '24x7' },
      { id: 'grp_oficina', doors: ['D2'], scheduleId: 'oficina' },
      { id: 'grp_noche', doors: [{ doorId: 'D1', scheduleId: 'noche' }] }
    ]
  },
  'ch-00': {
    cardholders: [
      { id: 'ch_all', status: 'active', name: 'Total', accessAll: true },
      { id: 'ch_grp_total', status: 'active', name: 'Grupo total', accessLevels: ['grp_total'] },
      { id: 'ch_ofi', status: 'active', name: 'Oficina', accessLevels: ['grp_oficina'] },
      { id: 'ch_noche', status: 'active', name: 'Noche', accessLevels: ['grp_noche'] },
      { id: 'ch_direct', status: 'active', name: 'Directo',
        doors: ['D1', 'D5', 'D6', 'EA', 'EB', 'TA', 'TB'].map((doorId) => ({ doorId, scheduleId: '24x7' })) },
      { id: 'ch_turno', status: 'active', name: 'Turno', doors: [{ doorId: 'D1', scheduleId: '24x7' }], shiftScheduleId: 'turno_m' },
      { id: 'ch_sinturno', status: 'active', name: 'Sin turno', doors: [{ doorId: 'D1', scheduleId: '24x7' }], shiftScheduleId: 'vacio' },
      { id: 'ch_cit', status: 'active', name: 'Citado', doors: [{ doorId: 'D1', scheduleId: '24x7' }], requiresGrant: true },
      { id: 'ch_cit2', status: 'active', name: 'Citado 2' },
      { id: 'ch_temp', status: 'active', name: 'Temporal' },
      { id: 'ch_vis', status: 'active', name: 'Visita grant' },
      { id: 'ch_inact', status: 'inactive', name: 'Baja', accessAll: true },
      { id: 'ch_rev', status: 'active', name: 'Revocado', accessAll: true },
      { id: 'ch_vig', status: 'active', name: 'Vencido', accessAll: true, validTo: ar('2026-09-30', '23:59') },
      { id: 'ch_dup1', status: 'active', accessAll: true },
      { id: 'ch_dup2', status: 'active', accessAll: true }
    ],
    credentials: [
      cred('dni', '20000001', 'ch_all'),
      cred('card', 'AB 12 CD', 'ch_all'),
      cred('biostar', '1001', 'ch_all'),
      cred('dni', '20000002', 'ch_grp_total'),
      cred('dni', '20000003', 'ch_ofi'),
      cred('dni', '20000004', 'ch_noche'),
      cred('dni', '20000005', 'ch_direct'),
      cred('dni', '20000006', 'ch_turno'),
      cred('dni', '20000007', 'ch_sinturno'),
      cred('dni', '20000008', 'ch_cit'),
      cred('dni', '20000009', 'ch_cit2'),
      cred('dni', '20000010', 'ch_temp'),
      cred('dni', '20000011', 'ch_vis'),
      cred('dni', '20000012', 'ch_inact'),
      cred('dni', '20000013', 'ch_rev'),
      cred('dni', '20000014', 'ch_vig'),
      cred('dni', '30000001', 'ch_dup1'),
      cred('dni', '30000001', 'ch_dup2'),
      cred('dni', '20000015', 'ch_all', { status: 'revoked' }),
      cred('dni', '20000016', 'ch_all', { validTo: ar('2026-09-01') }),
      cred('dni', '20000017', 'ch_fantasma'),
      cred('qr', 'QR-ALL', 'ch_all')
    ]
  },
  'grants-20261008': {
    grants: [
      { id: 'g_cit', cardholderId: 'ch_cit', from: ar('2026-10-08', '08:00'), to: ar('2026-10-08', '12:00'),
        doors: '*', source: 'citacion', refId: 'auth_1' },
      { id: 'g_cit2', cardholderId: 'ch_cit2', from: ar('2026-10-08', '09:00'), to: ar('2026-10-08', '10:00'),
        doors: ['D2'], source: 'citacion', refId: 'auth_2' },
      { id: 'g_tmp', cardholderId: 'ch_temp', from: ar('2026-10-06'), to: ar('2026-10-09', '23:59', '59'),
        doors: ['D2'], source: 'temporal', refId: 'auth_3' },
      { id: 'g_vis', cardholderId: 'ch_vis', from: ar('2026-10-08', '08:00'), to: ar('2026-10-08', '23:59', '59'),
        doors: ['D2'], source: 'visita', refId: 'auth_4' }
    ]
  },
  passes: {
    passes: [
      { id: 'QR-P1', dni: '40111222', name: 'Visita 1', doors: ['D1', 'D2'],
        validFrom: ar('2026-10-08', '08:00'), validTo: ar('2026-10-08', '23:59', '59'), status: 'autorizada' },
      { id: 'p2', dni: '40333444', doors: ['D1'],
        validFrom: ar('2026-10-07', '08:00'), validTo: ar('2026-10-07', '23:59', '59'), status: 'autorizada' },
      { id: 'p3', dni: '40555666', doors: ['D1'],
        validFrom: ar('2026-10-08', '08:00'), validTo: ar('2026-10-08', '23:59', '59'), status: 'revocada' },
      { id: 'p4', dni: '40777888', doors: ['D1'],
        validFrom: ar('2026-10-07', '08:00'), validTo: ar('2026-10-07', '23:59', '59'), status: 'ingreso_registrado' },
      { id: 'p5', dni: '40999000', doors: ['D1'], maxUses: 1, uses: 1,
        validFrom: ar('2026-10-08', '08:00'), validTo: ar('2026-10-08', '23:59', '59'), status: 'autorizada' },
      { id: 'p6', dni: '40121212', doors: ['D1'],
        validFrom: '2026-10-08T11:00:00.000Z', validTo: '2026-10-09T02:59:59.000Z', status: 'autorizada' }
    ],
    // Claves revocadas (el edge las materializa en la tabla revocations).
    revoked: [
      'ch:ch_rev',
      `cred:dni:${hashCredential('dni', '20000018', CURRENT_KEY)}`,
      'p6',
      ...(overrides.revocations || [])
    ]
  }
});

// credencial del 20000018 existe pero está en la lista de revocaciones
const withRevokedCred = (chunks) => {
  chunks['ch-00'].credentials.push(cred('dni', '20000018', 'ch_all'));
  return chunks;
};

/**
 * El mismo sitio pero con clave de credenciales (como lo compila siteCompiler cuando existe
 * `sites/{s}/secrets/credentialKey`): valueHash = HMAC, pases con `dniHash` en vez de `dni`,
 * revocaciones con el hash HMAC y chunk `secrets`.
 */
const buildKeyedChunks = (key, overrides) => {
  const { credentialKeyId } = require('../lib/accessEngine');
  CURRENT_KEY = key;
  try {
    const chunks = withRevokedCred(buildChunks(overrides));
    chunks.passes.passes = chunks.passes.passes.map(({ dni, ...p }) => ({ ...p, dniHash: hashCredential('dni', dni, key) }));
    chunks.secrets = { secrets: { credentialKey: key, keyId: credentialKeyId(key), alg: 'HMAC-SHA256' } };
    return chunks;
  } finally {
    CURRENT_KEY = null;
  }
};

module.exports = { ar, buildChunks: (o) => withRevokedCred(buildChunks(o)), buildKeyedChunks, door, side, cred, ALL_DOORS };
