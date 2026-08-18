/**
 * Auto-detección de marca por IP — ejecuta en la estación (LAN).
 * Probes SECUENCIALES: Hikvision → BioStar 2 server → ZKTeco TCP 4370 (pasivo).
 * Corte temprano si hay confidence high.
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');
const {
  parseIsapiDeviceInfo,
  parseBiostarLoginSuccess,
  parseZktecoTcpFingerprint,
  isGenericHttpNoise
} = require('./hardwareDetectSignatures');

const HIK_TIMEOUT_MS = 2500;
const BIO_TIMEOUT_MS = 3000;
const ZK_TIMEOUT_MS = 2000;
const TOTAL_BUDGET_MS = 12000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const requestRaw = ({
  protocol = 'http',
  hostname,
  port,
  method = 'GET',
  path: reqPath = '/',
  headers = {},
  body = null,
  timeoutMs = 2500,
  rejectUnauthorized = true
} = {}) => new Promise((resolve) => {
  const lib = protocol === 'https' ? https : http;
  let settled = false;
  const done = (result) => {
    if (settled) return;
    settled = true;
    resolve(result);
  };

  const req = lib.request({
    hostname,
    port,
    method,
    path: reqPath,
    headers,
    timeout: timeoutMs,
    rejectUnauthorized
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const buf = Buffer.concat(chunks);
      done({
        ok: true,
        status: res.statusCode || 0,
        headers: res.headers || {},
        bodyText: buf.toString('utf8'),
        buffer: buf
      });
    });
  });
  req.on('timeout', () => {
    req.destroy();
    done({ ok: false, reason: 'timeout', status: 0, headers: {}, bodyText: '', buffer: Buffer.alloc(0) });
  });
  req.on('error', (err) => {
    done({
      ok: false,
      reason: err.code === 'ECONNREFUSED' ? 'refused' : (err.message || 'error'),
      status: 0,
      headers: {},
      bodyText: '',
      buffer: Buffer.alloc(0)
    });
  });
  if (body != null) req.write(body);
  req.end();
});

/** Digest auth (RFC 2617/7616 qop=auth MD5) — un retry tras 401. */
const buildDigestHeader = (wwwAuth, { method, uri, username, password }) => {
  const hdr = String(wwwAuth || '');
  if (!/digest/i.test(hdr)) return null;
  const pick = (name) => {
    const m = hdr.match(new RegExp(`${name}=(?:"([^"]+)"|([^,\\s]+))`, 'i'));
    return m ? (m[1] || m[2] || '') : '';
  };
  const realm = pick('realm');
  const nonce = pick('nonce');
  const qop = pick('qop');
  const opaque = pick('opaque');
  const algorithm = pick('algorithm') || 'MD5';
  if (!realm || !nonce) return null;
  const ha1 = crypto.createHash('md5')
    .update(`${username}:${realm}:${password}`)
    .digest('hex');
  const ha2 = crypto.createHash('md5')
    .update(`${method}:${uri}`)
    .digest('hex');
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  let response;
  if (qop) {
    response = crypto.createHash('md5')
      .update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop.split(',')[0].trim()}:${ha2}`)
      .digest('hex');
  } else {
    response = crypto.createHash('md5')
      .update(`${ha1}:${nonce}:${ha2}`)
      .digest('hex');
  }
  let out = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", algorithm=${algorithm}, response="${response}"`;
  if (qop) out += `, qop=${qop.split(',')[0].trim()}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) out += `, opaque="${opaque}"`;
  return out;
};

const probeHikvision = async ({ host, port, username, password, httpsPreferred }) => {
  const started = Date.now();
  const uri = '/ISAPI/System/deviceInfo';
  const attempts = httpsPreferred
    ? [{ protocol: 'https', port: port || 443 }, { protocol: 'http', port: port || 80 }]
    : [{ protocol: 'http', port: port || 80 }, { protocol: 'https', port: port || 443 }];

  for (const att of attempts) {
    const first = await requestRaw({
      protocol: att.protocol,
      hostname: host,
      port: att.port,
      method: 'GET',
      path: uri,
      timeoutMs: HIK_TIMEOUT_MS,
      rejectUnauthorized: false
    });
    if (!first.ok && first.reason === 'timeout') {
      return { vendor: 'hikvision', ok: false, reason: 'timeout', ms: Date.now() - started };
    }
    if (isGenericHttpNoise(first.bodyText, first.headers['content-type'])) {
      continue;
    }

    let res = first;
    if (first.status === 401) {
      const www = first.headers['www-authenticate'] || first.headers['WWW-Authenticate'] || '';
      const digest = buildDigestHeader(www, {
        method: 'GET',
        uri,
        username: username || 'admin',
        password: password || ''
      });
      const authHeader = digest
        || `Basic ${Buffer.from(`${username || 'admin'}:${password || ''}`).toString('base64')}`;
      res = await requestRaw({
        protocol: att.protocol,
        hostname: host,
        port: att.port,
        method: 'GET',
        path: uri,
        headers: { Authorization: authHeader },
        timeoutMs: HIK_TIMEOUT_MS,
        rejectUnauthorized: false
      });
      if (res.status === 401) {
        return {
          vendor: 'hikvision',
          ok: false,
          reason: 'auth_failed',
          ms: Date.now() - started
        };
      }
    }

    if (res.status >= 200 && res.status < 300) {
      const candidate = parseIsapiDeviceInfo(res.bodyText, res.headers['content-type']);
      if (candidate) {
        return {
          vendor: 'hikvision',
          ok: true,
          ms: Date.now() - started,
          candidate
        };
      }
    }
  }

  return { vendor: 'hikvision', ok: false, reason: 'no_match', ms: Date.now() - started };
};

const probeBiostarServer = async ({ host, port, username, password, httpsPreferred }) => {
  const started = Date.now();
  const bodyObj = {
    User: {
      login_id: String(username || 'admin'),
      password: String(password || '')
    }
  };
  const body = JSON.stringify(bodyObj);
  const ports = port
    ? [port]
    : (httpsPreferred ? [443, 8795, 80] : [443, 8795, 80]);

  for (const p of ports) {
    const protocol = p === 80 ? 'http' : 'https';
    const res = await requestRaw({
      protocol,
      hostname: host,
      port: p,
      method: 'POST',
      path: '/api/login',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      body,
      timeoutMs: BIO_TIMEOUT_MS,
      rejectUnauthorized: false
    });
    if (!res.ok && res.reason === 'timeout') continue;
    if (res.status === 401 || res.status === 403) {
      return { vendor: 'biostar', ok: false, reason: 'auth_failed', ms: Date.now() - started };
    }
    if (res.status >= 200 && res.status < 300) {
      const candidate = parseBiostarLoginSuccess({
        headers: res.headers,
        bodyText: res.bodyText
      });
      if (candidate) {
        return {
          vendor: 'biostar',
          ok: true,
          ms: Date.now() - started,
          candidate
        };
      }
    }
  }
  return { vendor: 'biostar', ok: false, reason: 'no_match', ms: Date.now() - started };
};

/**
 * ZKTeco TCP 4370 — pasivo/read-only.
 * Solo CMD_CONNECT (session handshake de lectura). Sin clear/reboot/user sync.
 * Cualquier error o basura → no_match, sin throw.
 */
const probeZktecoTcp = async ({ host, port } = {}) => {
  const started = Date.now();
  const targetPort = port || 4370;
  let socket = null;

  try {
    const buffer = await new Promise((resolve) => {
      let settled = false;
      const chunks = [];
      const finish = (buf) => {
        if (settled) return;
        settled = true;
        try { if (socket) socket.destroy(); } catch { /* ignore */ }
        resolve(buf);
      };

      socket = net.connect({ host, port: targetPort }, () => {
        // CMD_CONNECT = 1000, session=0, reply_id=0 — solo handshake de sesión
        const pkt = Buffer.alloc(8);
        pkt.writeUInt16LE(1000, 0);
        pkt.writeUInt16LE(0, 2);
        pkt.writeUInt16LE(0, 4);
        pkt.writeUInt16LE(0, 6);
        // checksum simple (suma 16-bit de words 0,2,4,6 estilo ZK)
        let sum = 0;
        for (let i = 0; i < 8; i += 2) sum += pkt.readUInt16LE(i);
        sum = (sum & 0xffff);
        pkt.writeUInt16LE((~sum + 1) & 0xffff, 2);
        try { socket.write(pkt); } catch { finish(Buffer.alloc(0)); }
      });
      socket.setTimeout(ZK_TIMEOUT_MS);
      socket.on('data', (c) => {
        chunks.push(c);
        if (Buffer.concat(chunks).length >= 8) finish(Buffer.concat(chunks));
      });
      socket.on('timeout', () => finish(Buffer.concat(chunks)));
      socket.on('error', () => finish(Buffer.alloc(0)));
      socket.on('close', () => finish(Buffer.concat(chunks)));
    });

    const candidate = parseZktecoTcpFingerprint(buffer);
    if (candidate) {
      return {
        vendor: 'zkteco',
        ok: true,
        ms: Date.now() - started,
        candidate,
        bestEffort: true
      };
    }
    return {
      vendor: 'zkteco',
      ok: false,
      reason: 'no_match',
      ms: Date.now() - started,
      bestEffort: true
    };
  } catch {
    return {
      vendor: 'zkteco',
      ok: false,
      reason: 'error',
      ms: Date.now() - started,
      bestEffort: true
    };
  } finally {
    try { if (socket) socket.destroy(); } catch { /* ignore */ }
  }
};

/**
 * Orquesta probes secuenciales con corte temprano ante confidence high.
 * @param {object} opts
 * @param {object} [deps] — inyectable en tests (probeHikvision / probeBiostarServer / probeZktecoTcp)
 */
const runHardwareAutoDetect = async (opts = {}, deps = {}) => {
  const host = String(opts.host || '').trim();
  if (!host) {
    return { status: 'failed', candidates: [], probes: [], error: 'host requerido' };
  }

  const hikFn = deps.probeHikvision || probeHikvision;
  const bioFn = deps.probeBiostarServer || probeBiostarServer;
  const zkFn = deps.probeZktecoTcp || probeZktecoTcp;

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const probes = [];
  const candidates = [];

  const remaining = () => Math.max(0, deadline - Date.now());

  if (remaining() > 200) {
    const hik = await hikFn(opts);
    probes.push({
      vendor: hik.vendor,
      ok: Boolean(hik.ok),
      reason: hik.reason || null,
      ms: hik.ms
    });
    if (hik.candidate) {
      candidates.push(hik.candidate);
      if (hik.candidate.confidence === 'high') {
        return { status: 'completed', candidates, probes, error: null };
      }
    }
  }

  if (remaining() > 200) {
    const bio = await bioFn(opts);
    probes.push({
      vendor: bio.vendor,
      ok: Boolean(bio.ok),
      reason: bio.reason || null,
      ms: bio.ms
    });
    if (bio.candidate) {
      candidates.push(bio.candidate);
      if (bio.candidate.confidence === 'high') {
        return { status: 'completed', candidates, probes, error: null };
      }
    }
  }

  if (remaining() > 200) {
    const zk = await zkFn(opts);
    probes.push({
      vendor: zk.vendor,
      ok: Boolean(zk.ok),
      reason: zk.reason || null,
      ms: zk.ms,
      bestEffort: true
    });
    if (zk.candidate) candidates.push(zk.candidate);
  }

  if (!candidates.length) {
    const authFails = probes.filter((p) => p.reason === 'auth_failed');
    return {
      status: 'unknown',
      candidates: [],
      probes,
      error: authFails.length && authFails.length === probes.filter((p) => ['hikvision', 'biostar'].includes(p.vendor)).length
        ? 'auth_failed_hint'
        : null
    };
  }

  return { status: 'completed', candidates, probes, error: null };
};

module.exports = {
  runHardwareAutoDetect,
  probeHikvision,
  probeBiostarServer,
  probeZktecoTcp,
  HIK_TIMEOUT_MS,
  BIO_TIMEOUT_MS,
  ZK_TIMEOUT_MS
};
