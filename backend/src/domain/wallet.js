'use strict';
// Solde du prestataire = net des prestations terminées - retraits demandés, en cours ou versés.
// Un retrait demandé bloque immédiatement son montant (pas de double retrait).

function checkWithdrawal({ amount, available, minimum }) {
  if (!Number.isInteger(amount) || amount <= 0) throw new RangeError('Montant invalide');
  if (amount < minimum) throw new RangeError(`Retrait minimum : ${minimum} FCFA`);
  if (amount > available) throw new RangeError('Solde insuffisant');
  return true;
}

module.exports = { checkWithdrawal };
