'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { clientNext, canCancel, GROUPS, STATES } = require('../src/client/domain/bookingStates');
const { commissionFor } = require('../src/domain/pricing');

test('le client peut accepter ou refuser un devis proposé uniquement', () => {
  assert.equal(clientNext('devis_propose', 'accept'), 'a_payer');
  assert.equal(clientNext('devis_propose', 'refuse'), 'refusee');
  assert.equal(clientNext('attente', 'accept'), null);
});

test('la confirmation et le litige ne sont possibles qu\'après fin signalée', () => {
  assert.equal(clientNext('fin_signalee', 'confirm'), 'terminee');
  assert.equal(clientNext('fin_signalee', 'dispute'), 'litige');
  assert.equal(clientNext('en_cours', 'confirm'), null);
  assert.equal(clientNext('terminee', 'cancel'), null);
});

test('une réservation terminée, annulée ou en litige ne peut plus être annulée', () => {
  assert.equal(canCancel('terminee'), false);
  assert.equal(canCancel('annulee'), false);
  assert.equal(canCancel('litige'), false);
  assert.equal(canCancel('attente'), true);
});

test('les groupes couvrent tous les états connus, sans doublon', () => {
  const all = [...GROUPS.en, ...GROUPS.ter, ...GROUPS.ann];
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual([...all].sort(), [...STATES].sort());
});

test('commission : arrondi en FCFA entiers, net complémentaire', () => {
  assert.deepEqual(commissionFor(50000, 15), { commission: 7500, net: 42500 });
  assert.deepEqual(commissionFor(20000, 12), { commission: 2400, net: 17600 });
  assert.deepEqual(commissionFor(1001, 15), { commission: 150, net: 851 });
});

test('commission : refuse prix négatif, décimal ou taux hors bornes', () => {
  assert.throws(() => commissionFor(-1, 15), RangeError);
  assert.throws(() => commissionFor(10.5, 15), RangeError);
  assert.throws(() => commissionFor(1000, 51), RangeError);
  assert.throws(() => commissionFor(1000, -1), RangeError);
  assert.throws(() => commissionFor(1000, '15'), RangeError);
});
