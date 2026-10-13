/**
 * settings/visitas: quién puede invitar visitas (docs/VISITAS-DISENO.md §3.0).
 *  - dominiosAnfitrion: mails permitidos para invitar (default ['bacarsa.com.ar']).
 * Se cachea en memoria 5 min (tope de costo: no leer Firestore en cada request).
 */

const { db, FieldValue } = require('../firestore');

const SETTINGS_DOC = 'visitas';
const DEFAULT_DOMINIOS = Object.freeze(['bacarsa.com.ar']);
const CACHE_MS = 5 * 60 * 1000;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

let cache = null;

const normalizeDominios = (list) => {
  if (!Array.isArray(list)) return null;
  return [...new Set(list
    .map((d) => String(d || '').trim().toLowerCase().replace(/^@/, ''))
    .filter((d) => DOMAIN_RE.test(d)))];
};

const normalizeSettings = (raw = {}) => {
  const dominios = normalizeDominios(raw.dominiosAnfitrion);
  return { dominiosAnfitrion: dominios && dominios.length ? dominios : [...DEFAULT_DOMINIOS] };
};

const getVisitasSettings = async ({ now = Date.now() } = {}) => {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  const snap = await db.collection('settings').doc(SETTINGS_DOC).get();
  const value = normalizeSettings(snap.exists ? snap.data() : {});
  cache = { at: now, value };
  return value;
};

/** @returns {Promise<{ error: string }|{ settings: object }>} */
const saveVisitasSettings = async (input = {}) => {
  const dominios = normalizeDominios(input.dominiosAnfitrion);
  if (!dominios || !dominios.length) {
    return { error: 'Indicá al menos un dominio de mail válido (por ejemplo bacarsa.com.ar).' };
  }
  await db.collection('settings').doc(SETTINGS_DOC).set({
    dominiosAnfitrion: dominios,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  const value = normalizeSettings({ dominiosAnfitrion: dominios });
  cache = { at: Date.now(), value };
  return { settings: value };
};

const clearVisitasSettingsCache = () => { cache = null; };

const hostEmailOf = (user = {}) => {
  const candidates = [user.email, user.username, user.id];
  const found = candidates.map((v) => String(v || '').trim().toLowerCase()).find((v) => v.includes('@'));
  return found || '';
};

const isHostEmailAllowed = (email, dominios) => {
  const domain = String(email || '').split('@').pop();
  return Boolean(email && email.includes('@') && dominios.includes(domain));
};

const hostDomainMessage = (dominios) => {
  const list = dominios.map((d) => `@${d}`);
  const text = list.length > 1 ? `${list.slice(0, -1).join(', ')} o ${list[list.length - 1]}` : list[0];
  return `Solo el personal con mail ${text} puede invitar visitas.`;
};

const EMAIL_NOT_VERIFIED_MESSAGE = 'Confirmá tu mail para poder invitar visitas. Revisá tu correo.';

/**
 * Puede este usuario invitar/solicitar visitas? El admin queda exento.
 * `emailVerified: false` solo lo tienen los autorregistrados sin confirmar;
 * sin el campo (creados por admin) cuenta como verificado.
 * @returns {Promise<null|{ status: number, error: string, code: string }>}
 */
const checkVisitHost = async (user, { role } = {}) => {
  if ((role || user?.role) === 'admin') return null;
  const { dominiosAnfitrion } = await getVisitasSettings();
  if (!isHostEmailAllowed(hostEmailOf(user || {}), dominiosAnfitrion)) {
    return { status: 403, error: hostDomainMessage(dominiosAnfitrion), code: 'dominio_no_permitido' };
  }
  if (user && user.emailVerified === false) {
    return { status: 403, error: EMAIL_NOT_VERIFIED_MESSAGE, code: 'email_no_verificado' };
  }
  return null;
};

module.exports = {
  DEFAULT_DOMINIOS,
  CACHE_MS,
  EMAIL_NOT_VERIFIED_MESSAGE,
  getVisitasSettings,
  saveVisitasSettings,
  clearVisitasSettingsCache,
  hostEmailOf,
  isHostEmailAllowed,
  hostDomainMessage,
  checkVisitHost
};
