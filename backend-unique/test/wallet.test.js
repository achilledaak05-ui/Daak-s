'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { availableBalance, checkWithdrawal } = require('../src/domain/wallet');

test('solde disponible : retraits déjà réservés déduits', () => {
  assert.equal(availableBalance({ confirmedNet: 42500, reservedWithdrawals: 40000 }), 2500);
});

test('retrait : minimum, solde et montant entier vérifiés', () => {
  assert.equal(checkWithdrawal({ amount: 2000, available: 2500, minimum: 1000 }), true);
  assert.throws(() => checkWithdrawal({ amount: 500, available: 2500, minimum: 1000 }), RangeError);
  assert.throws(() => checkWithdrawal({ amount: 3000, available: 2500, minimum: 1000 }), RangeError);
  assert.throws(() => checkWithdrawal({ amount: 1500.5, available: 2500, minimum: 1000 }), RangeError);
});
