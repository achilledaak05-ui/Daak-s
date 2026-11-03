'use strict';
// Actions du prestataire sur une réservation, selon l'état. Sans dépendance : testable sans base.

const PRO_TRANSITIONS = {
  attente: { accept: 'a_payer', decline: 'refusee' },
  payee: { start: 'en_cours' },
  en_cours: { finish: 'fin_signalee' },
};

const GROUPS = {
  en: ['attente', 'a_payer', 'payee', 'en_cours', 'fin_signalee', 'litige'],
  ter: ['terminee'],
  ann: ['annulee', 'refusee', 'expiree'],
};

function proNext(state, action) {
  const t = PRO_TRANSITIONS[state];
  if (!t || !Object.prototype.hasOwnProperty.call(t, action)) return null;
  return t[action];
}

module.exports = { PRO_TRANSITIONS, GROUPS, proNext };
