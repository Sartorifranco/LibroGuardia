/**
 * Identidad de personas: tokens de nombre, score de match y DNI sospechosos.
 */

const { normalizePersonName } = require('./nameUtils');

/** Tokens: palabras >1 letra + iniciales de 1 letra (para no colapsar Marcos G / Marcos C). */
const tokenizePersonName = (value = '') => {
  const normalized = normalizePersonName(value);
  if (!normalized) return [];
  return normalized
    .split(/\s+/)
    .filter((token) => token.length >= 1)
    .filter((token) => /[a-z]/.test(token));
};

/**
 * Clave estable para agrupar. Incluye iniciales de 1 letra.
 * "Marcos G" → "g marcos" ; "Marcos C" → "c marcos"
 */
const buildNameKeyWithInitials = (value = '') => {
  const tokens = tokenizePersonName(value);
  if (!tokens.length) return '';
  return [...tokens].sort().join(' ');
};

const isInitial = (token = '') => String(token).length === 1;

const expandInitialMatch = (shortTok, longToks) => {
  if (!isInitial(shortTok)) return false;
  return longToks.some((t) => !isInitial(t) && t.startsWith(shortTok));
};

/**
 * Score 0..1 entre dos nombres (soporta orden invertido e iniciales).
 * Ej: "SARTORI Franco" vs "Franco S" → alto.
 * "Marcos G" vs "Marcos C" → bajo.
 */
const scorePersonNameMatch = (left = '', right = '') => {
  const a = tokenizePersonName(left);
  const b = tokenizePersonName(right);
  if (!a.length || !b.length) return 0;

  const scorePairing = (leftToks, rightToks) => {
    const usedRight = new Set();
    let matched = 0;
    let weight = 0;
    leftToks.forEach((lt) => {
      const w = isInitial(lt) ? 0.55 : 1;
      weight += w;
      let found = -1;
      for (let i = 0; i < rightToks.length; i += 1) {
        if (usedRight.has(i)) continue;
        const rt = rightToks[i];
        if (lt === rt) {
          found = i;
          break;
        }
        if (isInitial(lt) && expandInitialMatch(lt, [rt])) {
          found = i;
          break;
        }
        if (isInitial(rt) && expandInitialMatch(rt, [lt])) {
          found = i;
          break;
        }
      }
      if (found >= 0) {
        usedRight.add(found);
        matched += w;
      }
    });
    const denom = Math.max(weight, rightToks.reduce((s, t) => s + (isInitial(t) ? 0.55 : 1), 0));
    return denom ? matched / denom : 0;
  };

  const direct = scorePairing(a, b);
  const flipped = scorePairing(a, [...b].reverse());
  const flippedLeft = scorePairing([...a].reverse(), b);
  let score = Math.max(direct, flipped, flippedLeft);

  // Penalizar si solo comparten un nombre de pila y las iniciales de apellido chocan
  const aFull = a.filter((t) => !isInitial(t));
  const bFull = b.filter((t) => !isInitial(t));
  const aInit = a.filter(isInitial);
  const bInit = b.filter(isInitial);
  if (aInit.length && bInit.length) {
    const conflict = aInit.some((ai) => bInit.some((bi) => ai !== bi
      && !bFull.some((bf) => bf.startsWith(ai))
      && !aFull.some((af) => af.startsWith(bi))));
    if (conflict && aFull.filter((t) => bFull.includes(t)).length <= 1) {
      score = Math.min(score, 0.35);
    }
  }

  // Un solo token en común tipo "marcos" sin más evidencia
  const sharedFull = aFull.filter((t) => bFull.includes(t));
  if (sharedFull.length === 1 && aFull.length + bFull.length <= 3 && !aInit.length && !bInit.length) {
    if (aFull.length === 1 && bFull.length === 1) score = Math.min(score, 0.4);
  }

  return Number(Math.max(0, Math.min(1, score)).toFixed(3));
};

/** DNI que parece fecha YYYYMMDD reciente (ej. 20260716), no DNI real 20xxxxxxx. */
const looksLikeDateDni = (dni = '') => {
  const d = String(dni || '').replace(/\D/g, '');
  if (!/^(19|20)\d{6}$/.test(d)) return false;
  const year = Number(d.slice(0, 4));
  const month = Number(d.slice(4, 6));
  const day = Number(d.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // DNI argentinos reales empiezan con 20… (gente ~1960s); solo sospechar fechas “de carga”
  const currentYear = new Date().getFullYear();
  return year >= 2015 && year <= currentYear + 1;
};

const looksLikeSuspiciousDni = (dni = '') => {
  const d = String(dni || '').replace(/\D/g, '');
  if (!d) return false;
  if (looksLikeDateDni(d)) return true;
  if (/^(\d)\1{6,}$/.test(d)) return true; // 11111111
  if (d === '00000000' || d === '12345678') return true;
  return false;
};

module.exports = {
  tokenizePersonName,
  buildNameKeyWithInitials,
  scorePersonNameMatch,
  looksLikeDateDni,
  looksLikeSuspiciousDni,
  isInitial
};
