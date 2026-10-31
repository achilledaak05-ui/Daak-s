'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkDocument } = require('../src/domain/documents');

test('accepte un JPEG, un PNG et un PDF reconnus à leurs octets', () => {
  assert.equal(checkDocument(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]), 'cni').mime, 'image/jpeg');
  assert.equal(checkDocument(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]), 'naiss').mime, 'image/png');
  assert.equal(checkDocument(Buffer.from('%PDF-1.4'), 'diplome').mime, 'application/pdf');
});

test('refuse un exécutable ou un texte renommé en image', () => {
  assert.throws(() => checkDocument(Buffer.from('MZ\x90\x00'), 'cni'), RangeError);
  assert.throws(() => checkDocument(Buffer.from('<html>'), 'cni'), RangeError);
});

test('refuse un type de pièce inconnu, un fichier vide ou trop lourd', () => {
  assert.throws(() => checkDocument(Buffer.from('%PDF'), 'autre'), RangeError);
  assert.throws(() => checkDocument(Buffer.alloc(0), 'cni'), RangeError);
  assert.throws(() => checkDocument(Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(5 * 1024 * 1024)]), 'cni'), RangeError);
});
