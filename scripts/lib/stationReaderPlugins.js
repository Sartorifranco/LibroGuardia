/**
 * Plugins de lectura para door-reader-bridge.
 * Cada plugin traduce el frame crudo del hardware a un payload de /api/access/ingest,
 * sin cambiar la lógica de autorización en la nube.
 *
 * Compat: plugin "serial_dni" (default) = comportamiento histórico (raw → kiosk/ingest).
 */

const PLUGIN_IDS = ['serial_dni', 'zkteco', 'hikvision', 'suprema', 'hid'];

const stripBom = (value = '') => String(value || '').replace(/^\uFEFF/, '').trim();

/**
 * Prefijos universales que cualquier plugin entiende si el equipo/adaptador los envía.
 * CARD# / BIO# ya los entiende el backend; también aceptamos CARD: / BIO: / DNI:.
 */
const parseUniversalPrefix = (raw = '') => {
  const text = stripBom(raw);
  if (!text) return null;

  const bio = text.match(/^(?:BIO[#:=]|HUELLA[#:=]|FACE[#:=]|ROSTRO[#:=])\s*(.+)$/i);
  if (bio) {
    return {
      authMethod: 'biometric',
      biometricExternalId: String(bio[1] || '').trim(),
      rawData: `BIO#${String(bio[1] || '').trim()}`
    };
  }

  const card = text.match(/^(?:CARD[#:=]|RFID[#:=]|TARJETA[#:=]|CRED[#:=])\s*(.+)$/i);
  if (card) {
    return {
      authMethod: 'credential',
      credentialCode: String(card[1] || '').trim(),
      rawData: `CARD#${String(card[1] || '').trim()}`
    };
  }

  const dni = text.match(/^(?:DNI[#:=]|DOC[#:=]|DOCUMENT[#:=])\s*(.+)$/i);
  if (dni) {
    return {
      authMethod: 'dni',
      idNumber: String(dni[1] || '').trim(),
      rawData: String(dni[1] || '').trim()
    };
  }

  return null;
};

/** Extrae USER ID típico de líneas tipo "User=123" / "Pin=123" / "ID:123". */
const extractKeyedId = (raw = '') => {
  const text = stripBom(raw);
  const m = text.match(/(?:user(?:id)?|pin|uid|emp(?:id)?|person(?:id)?)\s*[=:#]\s*([A-Za-z0-9_-]+)/i);
  return m ? String(m[1]).trim() : '';
};

const asBiometric = (id, vendor) => {
  const biometricExternalId = String(id || '').trim();
  if (!biometricExternalId) return null;
  return {
    authMethod: 'biometric',
    biometricExternalId,
    rawData: `BIO#${biometricExternalId}`,
    vendor
  };
};

const asCredential = (code, vendor) => {
  const credentialCode = String(code || '').trim();
  if (!credentialCode) return null;
  return {
    authMethod: 'credential',
    credentialCode,
    rawData: `CARD#${credentialCode}`,
    vendor
  };
};

const asDniRaw = (raw, vendor) => {
  const rawData = stripBom(raw);
  if (!rawData) return null;
  return {
    authMethod: 'dni',
    rawData,
    vendor
  };
};

const plugins = {
  serial_dni: {
    id: 'serial_dni',
    brand: 'dni_generic',
    label: 'Lector de DNI (serie/USB)',
    parseFrame(raw) {
      const universal = parseUniversalPrefix(raw);
      if (universal) return { ...universal, vendor: 'dni_generic' };
      return asDniRaw(raw, 'dni_generic');
    }
  },
  zkteco: {
    id: 'zkteco',
    brand: 'zkteco',
    label: 'ZKTeco',
    parseFrame(raw) {
      const universal = parseUniversalPrefix(raw);
      if (universal) return { ...universal, vendor: 'zkteco' };
      const keyed = extractKeyedId(raw);
      if (keyed) return asBiometric(keyed, 'zkteco');
      // Línea numérica / alfanumérica corta = ID de usuario en el equipo
      const text = stripBom(raw);
      if (/^[A-Za-z0-9_-]{1,32}$/.test(text)) return asBiometric(text, 'zkteco');
      return asDniRaw(raw, 'zkteco');
    }
  },
  hikvision: {
    id: 'hikvision',
    brand: 'hikvision',
    label: 'Hikvision',
    parseFrame(raw) {
      const universal = parseUniversalPrefix(raw);
      if (universal) return { ...universal, vendor: 'hikvision' };
      const keyed = extractKeyedId(raw);
      if (keyed) return asBiometric(keyed, 'hikvision');
      const text = stripBom(raw);
      if (/^[A-Za-z0-9_-]{1,32}$/.test(text)) return asBiometric(text, 'hikvision');
      return asDniRaw(raw, 'hikvision');
    }
  },
  suprema: {
    id: 'suprema',
    brand: 'suprema',
    label: 'Suprema',
    parseFrame(raw) {
      const universal = parseUniversalPrefix(raw);
      if (universal) return { ...universal, vendor: 'suprema' };
      const keyed = extractKeyedId(raw);
      if (keyed) return asBiometric(keyed, 'suprema');
      const text = stripBom(raw);
      if (/^[A-Za-z0-9_-]{1,32}$/.test(text)) return asBiometric(text, 'suprema');
      return asDniRaw(raw, 'suprema');
    }
  },
  hid: {
    id: 'hid',
    brand: 'hid',
    label: 'HID (tarjeta)',
    parseFrame(raw) {
      const universal = parseUniversalPrefix(raw);
      if (universal) return { ...universal, vendor: 'hid' };
      const keyed = extractKeyedId(raw);
      if (keyed) return asCredential(keyed, 'hid');
      const text = stripBom(raw);
      // HID suele mandar el número de tarjeta en claro
      if (/^[A-Za-z0-9_-]{2,40}$/.test(text)) return asCredential(text, 'hid');
      return asCredential(text, 'hid');
    }
  }
};

const resolvePluginId = (value = '') => {
  const key = String(value || '').trim().toLowerCase();
  if (!key || key === 'dni' || key === 'dni_generic' || key === 'default') return 'serial_dni';
  if (PLUGIN_IDS.includes(key)) return key;
  // Alias de marca → plugin
  if (key === 'zk' || key === 'zkteco') return 'zkteco';
  if (key === 'hik' || key === 'hikvision') return 'hikvision';
  if (key === 'suprema') return 'suprema';
  if (key === 'hid' || key === 'hid_global') return 'hid';
  return 'serial_dni';
};

const getReaderPlugin = (idOrBrand = 'serial_dni') => {
  const id = resolvePluginId(idOrBrand);
  return plugins[id] || plugins.serial_dni;
};

/**
 * @returns {{ authMethod: string, rawData: string, vendor?: string, biometricExternalId?: string, credentialCode?: string, idNumber?: string } | null}
 */
const parseReaderFrame = (pluginIdOrBrand, rawFrame) => {
  const plugin = getReaderPlugin(pluginIdOrBrand);
  const parsed = plugin.parseFrame(rawFrame);
  if (!parsed || !String(parsed.rawData || '').trim()) return null;
  return {
    ...parsed,
    vendor: parsed.vendor || plugin.brand,
    pluginId: plugin.id
  };
};

/** Body listo para POST /api/access/ingest (+ doorId/readerId los agrega el bridge). */
const toIngestBody = (parsed, { doorId, readerId } = {}) => {
  if (!parsed) return null;
  const body = {
    doorId: doorId || undefined,
    readerId: readerId || undefined,
    authMethod: parsed.authMethod || undefined,
    rawData: parsed.rawData || undefined,
    vendor: parsed.vendor || undefined,
    brand: parsed.vendor || undefined
  };
  if (parsed.biometricExternalId) body.biometricExternalId = parsed.biometricExternalId;
  if (parsed.credentialCode) body.credentialCode = parsed.credentialCode;
  if (parsed.idNumber) body.idNumber = parsed.idNumber;
  return body;
};

module.exports = {
  PLUGIN_IDS,
  plugins,
  resolvePluginId,
  getReaderPlugin,
  parseReaderFrame,
  toIngestBody,
  parseUniversalPrefix
};
