'use strict';
// Passerelle de paiement (Mobile Money, cartes).
//   disabled : refus explicite (503), jamais de faux paiement réussi
//   sandbox  : le paiement est confirmé immédiatement, pour tester l'application de bout en bout
// Un vrai prestataire (CinetPay, PayDunya, Wave…) se branche ici ; il confirme ensuite via /api/v1/webhooks/payments.
const config = require('../config');
const { HttpError } = require('../errors');

async function initiatePayment({ reference, amount, method }) {
  if (config.paymentsMode === 'sandbox') return { status: 'success', reference, amount, method };
  throw new HttpError(503, 'payments_unavailable', 'Les paiements ne sont pas encore activés');
}

module.exports = { initiatePayment };
