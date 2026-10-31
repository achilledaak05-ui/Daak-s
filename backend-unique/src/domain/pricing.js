'use strict';
// Calcul de commission en FCFA entiers (pas de décimales en XOF).
// Le taux est figé sur la réservation au moment où le prix est accepté.

const MAX_RATE = 50;

function commissionFor(priceFcfa, ratePct) {
  if (!Number.isInteger(priceFcfa) || priceFcfa < 0) {
    throw new RangeError('Prix invalide');
  }
  if (typeof ratePct !== 'number' || !(ratePct >= 0 && ratePct <= MAX_RATE)) {
    throw new RangeError('Taux de commission invalide');
  }
  const commission = Math.round((priceFcfa * ratePct) / 100);
  return { commission, net: priceFcfa - commission };
}

module.exports = { commissionFor, MAX_RATE };
