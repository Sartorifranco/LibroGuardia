'use strict';

/**
 * Precios de Firestore en southamerica-east1 (USD).
 * Verificados el 08/10/2026.
 * Fuente: https://cloud.google.com/firestore/pricing
 *
 * La cuota gratis de operaciones se reinicia a medianoche, hora del Pacífico.
 * Cloud Functions: 2 millones de invocaciones por mes gratis; después US$ 0,40 por millón.
 */
const PRICING_VERIFIED_ON = '2026-10-08';
const PRICING_SOURCE = 'https://cloud.google.com/firestore/pricing';

const FIRESTORE_PRICING_USD = {
  region: 'southamerica-east1',
  readsPer100k: 0.045,
  writesPer100k: 0.135,
  deletesPer100k: 0.015,
  storagePerGiBMonth: 0.135,
  freeDaily: {
    reads: 50000,
    writes: 20000,
    deletes: 20000
  },
  functions: {
    freeInvocationsPerMonth: 2000000,
    usdPerMillionAfter: 0.40
  }
};

module.exports = {
  PRICING_VERIFIED_ON,
  PRICING_SOURCE,
  FIRESTORE_PRICING_USD
};
