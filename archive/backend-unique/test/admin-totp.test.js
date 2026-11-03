'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyTotp, newSecret, codeAt, base32Decode, base32Encode } = require('../src/admin/security/totp');

test('base32 : aller-retour exact', () => {
  const buf = Buffer.from('ouvrage-test-123');
  assert.deepEqual(base32Decode(base32Encode(buf)), buf);
});

test('TOTP RFC 6238 : vecteur de test (secret ASCII « 12345678901234567890 », temps 59 s)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  // Le RFC donne 94287082 pour 8 chiffres ; sur 6 chiffres le code est les 6 derniers
  assert.equal(verifyTotp(secret, '287082', 59 * 1000, 0), true);
});

test('TOTP : code courant accepté, code d\'une autre période refusé', () => {
  const secret = newSecret();
  const now = Date.now();
  const current = codeAt(base32Decode(secret), Math.floor(now / 30000));
  assert.equal(verifyTotp(secret, current, now, 0), true);
  assert.equal(verifyTotp(secret, '000000', now, 0), current === '000000');
  assert.equal(verifyTotp(secret, 'abcdef', now, 1), false);
});
