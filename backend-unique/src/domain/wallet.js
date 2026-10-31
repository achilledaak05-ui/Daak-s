'use strict';
// Solde du prestataire : prestations confirmées moins retraits demandés, en cours ou virés.
// Un retrait demandé bloque déjà son montant côté prestataire (pas de double retrait).

function availableBalance({ confirmedNet, reservedWithdrawals }) {
  return confirmedNet - reservedWithdrawals;
}

function checkWithdrawal({ amount, available, minimum }) {
  if (!Number.isInteger(amount) || amount <= 0) throw new RangeError('Montant invalide');
  if (amount < minimum) throw new RangeError(`Retrait minimum : ${minimum} FCFA`);
  if (amount > available) throw new RangeError('Solde insuffisant');
  return true;
}

module.exports = { availableBalance, checkWithdrawal };
