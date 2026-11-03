'use strict';
// Machine d'états des réservations, sans dépendance : testable sans base.
//
//   immediat : attente --pro accept--> a_payer --paiement--> payee --pro start--> en_cours
//              --pro finish--> fin_signalee --client confirm--> terminee (ou dispute --> litige)
//   devis    : demande_devis --(prix proposé)--> devis_propose --client accept--> a_payer ...

const STATES = [
  'attente', 'demande_devis', 'devis_propose', 'a_payer', 'payee',
  'en_cours', 'fin_signalee', 'terminee', 'annulee', 'refusee', 'expiree', 'litige',
];

const TRANSITIONS = {
  client: {
    attente: { cancel: 'annulee' },
    demande_devis: { cancel: 'annulee' },
    devis_propose: { accept: 'a_payer', refuse: 'refusee' },
    a_payer: { cancel: 'annulee' },
    payee: { cancel: 'annulee' }, // déclenche un remboursement
    fin_signalee: { confirm: 'terminee', dispute: 'litige' },
  },
  pro: {
    attente: { accept: 'a_payer', decline: 'refusee' },
    demande_devis: { quote: 'devis_propose', decline: 'refusee' },
    payee: { start: 'en_cours' },
    en_cours: { finish: 'fin_signalee' },
  },
};

const GROUPS = {
  en: ['attente', 'demande_devis', 'devis_propose', 'a_payer', 'payee', 'en_cours', 'fin_signalee', 'litige'],
  ter: ['terminee'],
  ann: ['annulee', 'refusee', 'expiree'],
};

// États où le client a déjà payé : une annulation doit déclencher un remboursement
const PAID = ['payee', 'en_cours', 'fin_signalee', 'terminee', 'litige'];
const ADMIN_CANCELLABLE = ['attente', 'demande_devis', 'devis_propose', 'a_payer', 'payee', 'en_cours'];

function nextState(actor, state, action) {
  const t = TRANSITIONS[actor] && TRANSITIONS[actor][state];
  return t && Object.hasOwn(t, action) ? t[action] : null;
}

module.exports = { STATES, TRANSITIONS, GROUPS, PAID, ADMIN_CANCELLABLE, nextState };
