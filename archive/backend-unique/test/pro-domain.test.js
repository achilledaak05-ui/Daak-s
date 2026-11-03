'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { proNext, GROUPS } = require('../src/pro/domain/bookingStates');
const { availableBalance, checkWithdrawal } = require('../src/domain/wallet');

test('le prestataire accepte ou refuse une demande en attente uniquement', () => {
  assert.equal(proNext('attente', 'accept'), 'a_payer');
  assert.equal(proNext('attente', 'decline'), 'refusee');
  assert.equal(proNext('a_payer', 'accept'), null);
});

test('démarrer puis terminer les travaux suit l\'ordre du paiement', () => {
  assert.equal(proNext('payee', 'start'), 'en_cours');
  assert.equal(proNext('en_cours', 'finish'), 'fin_signalee');
  assert.equal(proNext('attente', 'start'), null);
  assert.equal(proNext('terminee', 'finish'), null);
});

test('les groupes du prestataire couvrent les états sans doublon', () => {
  const all = [...GROUPS.en, ...GROUPS.ter, ...GROUPS.ann];
  assert.equal(new Set(all).size, all.length);
});

test('solde disponible : retraits en attente déduits', () => {
  assert.equal(availableBalance({ confirmedNet: 42500, reservedWithdrawals: 40000 }), 2500);
});

test('retrait : minimum, solde et montant entier vérifiés', () => {
  assert.equal(checkWithdrawal({ amount: 2000, available: 2500, minimum: 1000 }), true);
  assert.throws(() => checkWithdrawal({ amount: 500, available: 2500, minimum: 1000 }), RangeError);
  assert.throws(() => checkWithdrawal({ amount: 3000, available: 2500, minimum: 1000 }), RangeError);
  assert.throws(() => checkWithdrawal({ amount: 1500.5, available: 2500, minimum: 1000 }), RangeError);
});
