'use strict';
// Commission en FCFA entiers (pas de décimales en XOF). Le taux est figé quand le prix est accepté.
const MAX_RATE = 50;
const DEFAULT_RATE = 15;

function commissionFor(price, rate) {
  if (!Number.isInteger(price) || price < 0) throw new RangeError('Prix invalide');
  if (typeof rate !== 'number' || !(rate >= 0 && rate <= MAX_RATE)) throw new RangeError('Taux de commission invalide');
  const commission = Math.round((price * rate) / 100);
  return { commission, net: price - commission };
}

module.exports = { commissionFor, MAX_RATE, DEFAULT_RATE };
