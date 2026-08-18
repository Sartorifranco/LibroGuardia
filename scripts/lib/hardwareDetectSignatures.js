/**
 * Parsers/firmas de respuestas de probes (sin red).
 * Usado por la estación y por tests unitarios.
 */

const stripXmlNs = (text = '') => String(text || '').replace(/xmlns="[^"]*"/g, '');

const pickXmlTag = (xml, tag) => {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
  const m = String(xml || '').match(re);
  return m ? String(m[1] || '').trim() : '';
};

const parseIsapiDeviceInfo = (bodyText = '', contentType = '') => {
  const raw = String(bodyText || '');
  const ct = String(contentType || '').toLowerCase();
  let model = '';
  let serial = '';
  let firmware = '';
  let manufacturer = '';

  if (ct.includes('json') || raw.trim().startsWith('{')) {
    try {
      const json = JSON.parse(raw);
      const info = json.DeviceInfo || json.deviceInfo || json;
      model = String(info.model || info.deviceName || info.deviceType || '').trim();
      serial = String(info.serialNumber || info.serialNo || '').trim();
      firmware = String(info.firmwareVersion || info.firmware || '').trim();
      manufacturer = String(info.manufacturer || info.deviceName || '').trim();
    } catch {
      return null;
    }
  } else {
    const xml = stripXmlNs(raw);
    if (!/<DeviceInfo\b/i.test(xml) && !/<model\b/i.test(xml) && !/ISAPI/i.test(xml)) {
      return null;
    }
    model = pickXmlTag(xml, 'model') || pickXmlTag(xml, 'deviceName');
    serial = pickXmlTag(xml, 'serialNumber');
    firmware = pickXmlTag(xml, 'firmwareVersion');
    manufacturer = pickXmlTag(xml, 'manufacturer') || pickXmlTag(xml, 'deviceName');
  }

  const looksHik = /hikvision/i.test(manufacturer)
    || /hikvision/i.test(raw)
    || Boolean(model || serial || firmware);
  if (!looksHik && !/<DeviceInfo\b/i.test(raw)) return null;

  return {
    brandId: 'hikvision',
    stationPlugin: 'hikvision',
    confidence: 'high',
    model: model || null,
    firmware: firmware || null,
    serial: serial || null,
    via: 'isapi_deviceInfo',
    notes: null,
    bestEffort: false
  };
};

const parseBiostarLoginSuccess = ({ headers = {}, bodyText = '' } = {}) => {
  const headerBag = Object.keys(headers || {}).find((k) => k.toLowerCase() === 'bs-session-id');
  const session = headerBag
    ? String(headers[headerBag] || '').trim()
    : '';
  let bodyOk = false;
  try {
    const json = JSON.parse(String(bodyText || '{}'));
    const code = json?.Response?.code ?? json?.code;
    bodyOk = code === '0' || code === 0 || Boolean(json?.User || json?.Session);
  } catch {
    bodyOk = /bs-session-id|session/i.test(String(bodyText || ''));
  }
  if (!session && !bodyOk) return null;

  return {
    brandId: 'suprema',
    stationPlugin: 'suprema',
    confidence: 'high',
    model: 'BioStar 2 server',
    firmware: null,
    serial: null,
    via: 'biostar2_server',
    notes: 'Servidor BioStar 2 (no terminal standalone).',
    bestEffort: false
  };
};

/**
 * Firma estructural mínima de respuesta ZK pull (TCP 4370).
 * Estricta: evita falsos positivos con basura en el puerto.
 * Formato típico: little-endian command/checksum/session/reply (8+ bytes).
 */
const parseZktecoTcpFingerprint = (buffer) => {
  try {
    if (!buffer || buffer.length < 8) return null;
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const command = buf.readUInt16LE(0);
    const sessionId = buf.readUInt16LE(4);
    const replyId = buf.readUInt16LE(6);
    // ACK_OK=2000, ACK_UNAUTH=2001, ACK_ERROR=2005, CMD_ACK variants; CONNECT reply often 2000
    const plausibleCmd = command === 2000
      || command === 2001
      || command === 2005
      || command === 1000
      || (command >= 1000 && command <= 2100);
    if (!plausibleCmd) return null;
    // reply_id en connect suele ser bajo; session no siempre 0
    if (replyId > 60000 && sessionId === 0 && command !== 2000) return null;

    return {
      brandId: 'zkteco',
      stationPlugin: 'zkteco',
      confidence: 'low',
      model: null,
      firmware: null,
      serial: null,
      via: 'tcp_4370_fingerprint',
      notes: 'Detección ZKTeco tentativa (TCP 4370, best-effort); confirmá en sitio.',
      bestEffort: true
    };
  } catch {
    return null;
  }
};

/** HTML genérico / página web cualquiera → no candidato. */
const isGenericHttpNoise = (bodyText = '', contentType = '') => {
  const ct = String(contentType || '').toLowerCase();
  const raw = String(bodyText || '');
  if (ct.includes('text/html') || /<!doctype html|<html[\s>]/i.test(raw)) return true;
  return false;
};

module.exports = {
  parseIsapiDeviceInfo,
  parseBiostarLoginSuccess,
  parseZktecoTcpFingerprint,
  isGenericHttpNoise
};
