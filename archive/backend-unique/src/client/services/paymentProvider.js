'use strict';
// Interface vers le prestataire de paiement (Mobile Money et cartes).
// Tant qu'aucun prestataire n'est contractualisé, les paiements sont désactivés : jamais de faux succès.

const { HttpError } = require('../../errors');

async function initiatePayment({ reference, amount, method }) {
  if (process.env.PAYMENT_PROVIDER !== 'enabled') {
    throw new HttpError(503, 'payments_unavailable', 'Les paiements ne sont pas encore activés');
  }
  // Intégration réelle à compléter avec le prestataire retenu (appel API sécurisé, retour d'un lien de paiement)
  throw new HttpError(503, 'payments_unavailable', 'Intégration du prestataire de paiement non configurée');
}

module.exports = { initiatePayment };
