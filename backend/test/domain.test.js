'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { nextState, GROUPS, STATES } = require('../src/domain/bookings');
const { commissionFor } = require('../src/domain/pricing');
const { checkWithdrawal } = require('../src/domain/wallet');
const { pickPros } = require('../src/domain/distribution');
const { checkDocument } = require('../src/domain/documents');

test('machine d\'états : parcours immédiat complet', () => {
  assert.equal(nextState('pro', 'attente', 'accept'), 'a_payer');
  assert.equal(nextState('pro', 'payee', 'start'), 'en_cours');
  assert.equal(nextState('pro', 'en_cours', 'finish'), 'fin_signalee');
  assert.equal(nextState('client', 'fin_signalee', 'confirm'), 'terminee');
});

test('machine d\'états : devis', () => {
  assert.equal(nextState('pro', 'demande_devis', 'quote'), 'devis_propose');
  assert.equal(nextState('client', 'devis_propose', 'accept'), 'a_payer');
  assert.equal(nextState('client', 'devis_propose', 'refuse'), 'refusee');
});

test('machine d\'états : actions interdites', () => {
  assert.equal(nextState('client', 'en_cours', 'cancel'), null);
  assert.equal(nextState('client', 'a_payer', 'confirm'), null);
  assert.equal(nextState('pro', 'a_payer', 'start'), null);
  assert.equal(nextState('client', 'attente', 'toString'), null); // pas de fuite par le prototype
});

test('tous les états appartiennent à un groupe', () => {
  const grouped = new Set(Object.values(GROUPS).flat());
  for (const s of STATES) assert.ok(grouped.has(s), s);
});

test('commission en FCFA entiers', () => {
  assert.deepEqual(commissionFor(10000, 15), { commission: 1500, net: 8500 });
  assert.deepEqual(commissionFor(9999, 15), { commission: 1500, net: 8499 });
  assert.throws(() => commissionFor(100.5, 15), RangeError);
  assert.throws(() => commissionFor(100, 60), RangeError);
});

test('retraits', () => {
  assert.ok(checkWithdrawal({ amount: 5000, available: 5000, minimum: 1000 }));
  assert.throws(() => checkWithdrawal({ amount: 500, available: 5000, minimum: 1000 }), /minimum/);
  assert.throws(() => checkWithdrawal({ amount: 6000, available: 5000, minimum: 1000 }), /insuffisant/);
});

test('distribution : mieux notés d\'abord, sans renvoi', () => {
  const pool = [{ id: 1, rating: 3 }, { id: 2, rating: 5 }, { id: 3, rating: 4 }, { id: 4, rating: 5 }];
  assert.deepEqual(pickPros(pool, [], 3), [2, 4, 3]);
  assert.deepEqual(pickPros(pool, [2, 4], 3), [3, 1]);
});

test('pièces : type lu dans le contenu', () => {
  assert.equal(checkDocument(Buffer.from('%PDF-1.7 ...'), 'cni'), 'application/pdf');
  assert.equal(checkDocument(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'naiss'), 'image/jpeg');
  assert.throws(() => checkDocument(Buffer.from('<html>'), 'cni'), /Format/);
  assert.throws(() => checkDocument(Buffer.from('%PDF-'), 'passeport'), /inconnu/);
});
