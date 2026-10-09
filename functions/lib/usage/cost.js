'use strict';

const { FIRESTORE_PRICING_USD } = require('./pricing');

const roundUsd = (value) => Math.round((Number(value) || 0) * 10000) / 10000;

const billable = (count, free) => Math.max(0, (Number(count) || 0) - (Number(free) || 0));

/**
 * Costo del día después de descontar la cuota gratis diaria.
 * El almacenamiento es mensual: solo se suma si viene storageGiB (una vez, no por día).
 */
const estimateDayUsd = (ops = {}, pricing = FIRESTORE_PRICING_USD) => {
  const reads = billable(ops.reads, pricing.freeDaily.reads) * pricing.readsPer100k / 100000;
  const writes = billable(ops.writes, pricing.freeDaily.writes) * pricing.writesPer100k / 100000;
  const deletes = billable(ops.deletes, pricing.freeDaily.deletes) * pricing.deletesPer100k / 100000;
  return roundUsd(reads + writes + deletes);
};

const estimateStorageUsd = (storageGiB, pricing = FIRESTORE_PRICING_USD) => (
  roundUsd((Number(storageGiB) || 0) * pricing.storagePerGiBMonth)
);

const estimateFunctionsUsd = (invocations, pricing = FIRESTORE_PRICING_USD) => {
  const extra = billable(invocations, pricing.functions.freeInvocationsPerMonth);
  return roundUsd(extra * pricing.functions.usdPerMillionAfter / 1000000);
};

const budgetStatus = (projectedUsd, budgetUsd) => {
  const projected = Number(projectedUsd) || 0;
  const budget = Number(budgetUsd) || 0;
  if (budget > 0 && projected > budget) return 'over';
  if (budget > 0 && projected >= budget * 0.8) return 'warn';
  return 'ok';
};

module.exports = {
  roundUsd,
  billable,
  estimateDayUsd,
  estimateStorageUsd,
  estimateFunctionsUsd,
  budgetStatus
};
