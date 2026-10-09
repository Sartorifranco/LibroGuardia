/** 1 nudo náutico = 1,852 km/h. La pantalla muestra km/h; el servidor guarda nudos. */
const KNOT_TO_KMH = 1.852;

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
};

export const knotsToKmh = (knots) => {
  const n = Number(knots);
  if (!Number.isFinite(n)) return 0;
  return round(n * KNOT_TO_KMH, 1);
};

export const kmhToKnots = (kmh) => {
  const n = Number(kmh);
  if (!Number.isFinite(n)) return 0;
  return round(n / KNOT_TO_KMH, 2);
};
