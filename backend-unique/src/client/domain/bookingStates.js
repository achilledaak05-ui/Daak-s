'use strict';
// Machine d'états des réservations. Sans dépendance : testable indépendamment de la base.

const STATES = [
  'attente', 'demande_devis', 'devis_propose', 'a_payer', 'payee',
  'en_cours', 'fin_signalee', 'terminee', 'annulee', 'refusee', 'expiree', 'litige',
];

// Actions possibles pour le client, selon l'état courant
const CLIENT_TRANSITIONS = {
  attente: { cancel: 'annulee' },
  demande_devis: { cancel: 'annulee' },
  devis_propose: { accept: 'a_payer', refuse: 'refusee' },
  a_payer: { cancel: 'annulee' },
  payee: { cancel: 'annulee' }, // déclenche un remboursement (voir routes/bookings.js)
  fin_signalee: { confirm: 'terminee', dispute: 'litige' },
};

// Groupes affichés dans l'application
const GROUPS = {
  en: ['attente', 'demande_devis', 'devis_propose', 'a_payer', 'payee', 'en_cours', 'fin_signalee', 'litige'],
  ter: ['terminee'],
  ann: ['annulee', 'refusee', 'expiree'],
};

function clientNext(state, action) {
  const t = CLIENT_TRANSITIONS[state];
  if (!t || !Object.prototype.hasOwnProperty.call(t, action)) return null;
  return t[action];
}

function canCancel(state) {
  return clientNext(state, 'cancel') !== null;
}

module.exports = { STATES, GROUPS, clientNext, canCancel };
