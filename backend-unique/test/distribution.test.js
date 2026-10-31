'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickPros } = require('../src/domain/distribution');

const pool = [
  { id: 1, rating: 4.2 },
  { id: 2, rating: 4.9 },
  { id: 3, rating: 0 },
  { id: 4, rating: 4.9 },
];

test('les prestataires les mieux notés partent en premier, à égalité par identifiant', () => {
  assert.deepEqual(pickPros(pool, [], 3), [2, 4, 1]);
});

test('un prestataire déjà sollicité n\'est pas renvoyé', () => {
  assert.deepEqual(pickPros(pool, [2, 4], 3), [1, 3]);
});

test('le nombre envoyé ne dépasse jamais la limite demandée', () => {
  assert.equal(pickPros(pool, [], 2).length, 2);
  assert.deepEqual(pickPros([], [], 3), []);
});

test('une limite hors bornes est refusée', () => {
  assert.throws(() => pickPros(pool, [], 0), RangeError);
  assert.throws(() => pickPros(pool, [], 11), RangeError);
  assert.throws(() => pickPros(pool, [], 2.5), RangeError);
});
