const { normalizeIdNumber, parseScanData } = require('../dniParser');
const { db } = require('../firestore');
const { buildNameTokens } = require('./nameUtils');

const CREDENTIAL_PREFIX = /^(CARD|CRED|TARJETA|RFID)[:#\s-]*/i;

const detectAuthMethod = (rawData = '') => {
  const trimmed = String(rawData || '').trim();
  if (!trimmed) return { method: null, payload: '' };

  if (CREDENTIAL_PREFIX.test(trimmed)) {
    return {
      method: 'credential',
      payload: trimmed.replace(CREDENTIAL_PREFIX, '').trim()
    };
  }

  if (/^[0-9A-Fa-f]{6,16}$/.test(trimmed) && trimmed.length <= 16) {
    return { method: 'credential', payload: trimmed.toUpperCase() };
  }

  const parsed = parseScanData(trimmed);
  if (parsed.idNumber || parsed.format === 'pdf417' || parsed.format === 'mrz') {
    return { method: 'dni', payload: trimmed, parsed };
  }

  if (parsed.name) {
    return { method: 'dni', payload: trimmed, parsed };
  }

  return { method: 'credential', payload: trimmed };
};

const doorAllowsMethod = (door, method) => {
  const methods = door?.authMethods || ['dni'];
  if (method === 'manual') return methods.includes('manual') || door?.manualOpenAllowed !== false;
  return methods.includes(method);
};

const findPersonByCredential = async (credentialCode = '') => {
  const code = String(credentialCode || '').trim().toUpperCase();
  if (!code) return null;

  const authSnap = await db.collection('authorizations')
    .where('active', '==', true)
    .where('credentialCode', '==', code)
    .limit(1)
    .get();

  if (!authSnap.empty) {
    const auth = { id: authSnap.docs[0].id, ...authSnap.docs[0].data() };
    if (auth.personId) {
      const personSnap = await db.collection('people').doc(auth.personId).get();
      if (personSnap.exists) {
        return {
          person: { id: personSnap.id, ...personSnap.data() },
          authorization: auth,
          method: 'credential'
        };
      }
    }
    return {
      person: null,
      authorization: auth,
      method: 'credential',
      displayName: auth.name || code
    };
  }

  const peopleSnap = await db.collection('people')
    .where('accessCard', '==', code)
    .limit(1)
    .get();

  if (!peopleSnap.empty) {
    return {
      person: { id: peopleSnap.docs[0].id, ...peopleSnap.docs[0].data() },
      authorization: null,
      method: 'credential'
    };
  }

  return null;
};

const resolveScanContext = async ({ rawData, door }) => {
  const detected = detectAuthMethod(rawData);
  if (!detected.method) {
    return { ok: false, message: 'Datos de acceso vacíos' };
  }

  if (!doorAllowsMethod(door, detected.method)) {
    return {
      ok: false,
      message: `Método ${detected.method} no habilitado en ${door?.name || 'esta puerta'}`
    };
  }

  if (detected.method === 'face') {
    return {
      ok: false,
      message: 'Reconocimiento facial: configure el lector y endpoint dedicado (próximamente)'
    };
  }

  if (detected.method === 'credential') {
    const match = await findPersonByCredential(detected.payload);
    if (!match) {
      return { ok: false, message: 'Credencial no reconocida', authMethod: 'credential' };
    }
    return {
      ok: true,
      authMethod: 'credential',
      credentialCode: detected.payload,
      person: match.person,
      authorization: match.authorization,
      displayName: match.person?.name || match.person?.nombre || match.displayName || detected.payload,
      idNumber: match.person?.dniNormalized || match.person?.idNumberNormalized || '',
      parsed: null
    };
  }

  const parsed = detected.parsed || parseScanData(detected.payload);
  const idNumber = normalizeIdNumber(parsed.idNumber);
  const name = parsed.name
    || [parsed.lastName, parsed.firstName].filter(Boolean).join(' ').trim();

  return {
    ok: true,
    authMethod: 'dni',
    parsed,
    idNumber,
    firstName: parsed.firstName || '',
    lastName: parsed.lastName || '',
    displayName: name,
    nameKey: buildNameTokens(name)
  };
};

module.exports = {
  detectAuthMethod,
  doorAllowsMethod,
  findPersonByCredential,
  resolveScanContext
};
