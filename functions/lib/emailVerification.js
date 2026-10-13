/**
 * Verificación del mail en el autorregistro (docs/VISITAS-DISENO.md §3.0).
 * El token viaja solo en el link del mail; en users/{id} se guarda su sha256.
 * Campos en users/{id}: emailVerified, emailVerifyTokenHash, emailVerifyExpiresAtMs, emailVerifySentAtMs.
 */

const crypto = require('crypto');
const { db, FieldValue } = require('../firestore');
const { getNotificationsConfig } = require('./notifications/config');
const emailChannel = require('./notifications/email');
const { resolveApiBaseUrl } = require('./lectores');

const VERIFY_TTL_MS = 48 * 60 * 60 * 1000;
const RESEND_MIN_MS = 2 * 60 * 1000;
const TOKEN_RE = /^[0-9a-f]{64}$/;

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const newVerification = (now = Date.now()) => {
  const token = crypto.randomBytes(32).toString('hex');
  return {
    token,
    fields: {
      emailVerified: false,
      emailVerifyTokenHash: hashToken(token),
      emailVerifyExpiresAtMs: now + VERIFY_TTL_MS,
      emailVerifySentAtMs: now
    }
  };
};

/** Origen de la app: APP_BASE_URL o el mismo host que sirve la API (sin /api). */
const resolveAppBaseUrl = (req) => {
  const fromEnv = String(process.env.APP_BASE_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  return resolveApiBaseUrl(req).replace(/\/api\/?$/, '');
};

const verificationLink = (req, token) => `${resolveAppBaseUrl(req)}/empleado/verificar/${token}`;

/**
 * Manda el mail con el link. Sin SMTP configurado no falla: avisa en el log y
 * el usuario queda sin verificar (un admin lo puede marcar verificado).
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
const sendVerificationEmail = async ({ req, to, nombre, token }) => {
  const config = await getNotificationsConfig();
  const smtp = config.smtp || {};
  if (!smtp.host || !smtp.from) {
    console.warn('emailVerification: SMTP sin configurar; la cuenta queda sin verificar hasta que un admin la marque.');
    return { sent: false, reason: 'smtp_incompleto' };
  }
  const link = verificationLink(req, token);
  const saludo = nombre ? `Hola ${nombre}:` : 'Hola:';
  const text = [
    saludo,
    '',
    'Para poder invitar visitas, confirmá tu mail entrando a este link:',
    link,
    '',
    'El link vence en 48 horas. Si no creaste una cuenta, ignorá este mensaje.'
  ].join('\n');
  try {
    const result = await emailChannel.sendNotification({
      to: [to],
      subject: 'Confirmá tu mail — MSS Guard',
      text
    }, { smtp });
    return result.sent ? { sent: true } : { sent: false, reason: result.reason || 'no_enviado' };
  } catch (err) {
    console.warn('emailVerification: no se pudo enviar el mail:', err.message);
    return { sent: false, reason: 'error_smtp' };
  }
};

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

/** Marca verificado el usuario del token. Token inválido, usado o vencido → error 400/410. */
const verifyEmailToken = async (rawToken, now = Date.now()) => {
  const token = String(rawToken || '').trim().toLowerCase();
  if (!TOKEN_RE.test(token)) throw httpError(400, 'El link de confirmación no es válido.', 'token_invalido');
  const snap = await db.collection('users').where('emailVerifyTokenHash', '==', hashToken(token)).limit(1).get();
  if (snap.empty) {
    throw httpError(400, 'El link de confirmación no es válido o ya se usó.', 'token_invalido');
  }
  const doc = snap.docs[0];
  const data = doc.data() || {};
  if (!(Number(data.emailVerifyExpiresAtMs) > now)) {
    throw httpError(410, 'El link de confirmación venció. Entrá a la app y pedí uno nuevo.', 'token_vencido');
  }
  await doc.ref.set({
    emailVerified: true,
    emailVerifyTokenHash: FieldValue.delete(),
    emailVerifyExpiresAtMs: FieldValue.delete(),
    emailVerifySentAtMs: FieldValue.delete(),
    emailVerifiedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return { userId: doc.id };
};

/** Nuevo token y reenvío (máximo uno cada 2 minutos). */
const resendVerification = async ({ req, userId, now = Date.now() }) => {
  const ref = db.collection('users').doc(String(userId));
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, 'Usuario no encontrado');
  const data = snap.data() || {};
  if (data.emailVerified !== false) throw httpError(400, 'Tu mail ya está confirmado.', 'ya_verificado');
  const last = Number(data.emailVerifySentAtMs) || 0;
  if (now - last < RESEND_MIN_MS) {
    const retryAfterSeconds = Math.ceil((RESEND_MIN_MS - (now - last)) / 1000);
    throw Object.assign(httpError(429, 'Ya te mandamos un mail hace un momento. Esperá 2 minutos y probá de nuevo.', 'muy_seguido'), { retryAfterSeconds });
  }
  const to = String(data.email || data.username || '').trim();
  if (!to.includes('@')) throw httpError(400, 'Tu usuario no tiene un mail cargado.');
  const { token, fields } = newVerification(now);
  await ref.set({ ...fields, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return sendVerificationEmail({ req, to, nombre: data.nombre, token });
};

module.exports = {
  VERIFY_TTL_MS,
  RESEND_MIN_MS,
  hashToken,
  newVerification,
  resolveAppBaseUrl,
  verificationLink,
  sendVerificationEmail,
  verifyEmailToken,
  resendVerification
};
