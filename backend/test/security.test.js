'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.JWT_SECRET ||= 'x'.repeat(40);
process.env.DATA_KEY ||= 'y'.repeat(40);
process.env.PAYMENT_WEBHOOK_SECRET ||= 'z'.repeat(40);
process.env.DATABASE_URL ||= 'mysql://u:p@127.0.0.1:3306/db';

const { hashPassword, verifyPassword } = require('../src/lib/password');
const { encrypt, decrypt, sealText, openText } = require('../src/lib/crypto');
const { verifyTotp, codeAt, base32Decode, newSecret } = require('../src/lib/totp');
const { signAccess, verifyAccess } = require('../src/lib/tokens');
const { verifySignature, sign } = require('../src/webhooks');
const { connectionOptions } = require('../src/db');

test('mots de passe scrypt', async () => {
  const h = await hashPassword('correct horse');
  assert.ok(await verifyPassword('correct horse', h));
  assert.ok(!(await verifyPassword('wrong', h)));
  assert.ok(!(await verifyPassword('x', 'scrypt$999999999$8$1$AA==$AA==')));
});

test('chiffrement AES-GCM : aller-retour et altération détectée', () => {
  const key = crypto.randomBytes(32);
  const data = Buffer.from('pièce confidentielle');
  const enc = encrypt(data, key);
  assert.deepEqual(decrypt(enc, key), data);
  enc[enc.length - 1] ^= 1;
  assert.throws(() => decrypt(enc, key));
  assert.equal(openText(sealText('0700000000', key), key), '0700000000');
});

test('TOTP RFC 6238', () => {
  const secret = newSecret();
  const now = Date.now();
  assert.ok(verifyTotp(secret, codeAt(base32Decode(secret), Math.floor(now / 30000)), now));
  assert.ok(!verifyTotp(secret, '000000x', now));
});

test('jetons : un jeton client n\'ouvre pas l\'espace admin', () => {
  const t = signAccess('client', 42);
  assert.equal(verifyAccess('client', t).sub, '42');
  assert.throws(() => verifyAccess('admin', t));
  assert.throws(() => verifyAccess('pro', t));
});

test('signature des webhooks', () => {
  const secret = 's'.repeat(40);
  const raw = '{"a":1}';
  const t = Math.floor(Date.now() / 1000);
  assert.ok(verifySignature(secret, `t=${t},v1=${sign(secret, t, raw)}`, raw));
  assert.ok(!verifySignature(secret, `t=${t},v1=${sign(secret, t, raw)}`, '{"a":2}'));
  assert.ok(!verifySignature(secret, `t=${t - 1000},v1=${sign(secret, t - 1000, raw)}`, raw)); // rejeu
});

test('DATABASE_URL au format Aiven', () => {
  const o = connectionOptions('mysql://avnadmin:p%40ss@db.aivencloud.com:12345/defaultdb?ssl-mode=REQUIRED', null);
  assert.equal(o.host, 'db.aivencloud.com');
  assert.equal(o.port, 12345);
  assert.equal(o.password, 'p@ss');
  assert.equal(o.database, 'defaultdb');
  assert.deepEqual(o.ssl, { rejectUnauthorized: true });
  assert.equal(connectionOptions('mysql://root:@localhost/x', null).ssl, undefined);
});
