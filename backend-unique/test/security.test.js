'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../src/security/password');
const { verifyWebhook, sign } = require('../src/client/security/webhook');

const SECRET = 'un-secret-de-test-d-au-moins-32-caracteres';

test('mot de passe : le bon mot de passe est accepté, un mauvais est refusé', async () => {
  const h = await hashPassword('motdepasse1');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(await verifyPassword('motdepasse1', h), true);
  assert.equal(await verifyPassword('motdepasse2', h), false);
});

test('mot de passe : deux hachages du même mot de passe diffèrent (sel aléatoire)', async () => {
  const a = await hashPassword('motdepasse1');
  const b = await hashPassword('motdepasse1');
  assert.notEqual(a, b);
});

test('mot de passe : un hachage malformé ou absent ne valide jamais', async () => {
  assert.equal(await verifyPassword('x', undefined), false);
  assert.equal(await verifyPassword('x', 'pas-un-hash'), false);
  assert.equal(await verifyPassword('x', 'scrypt$a$b$c$d$e'), false);
});

test('webhook : une signature correcte et récente est acceptée', () => {
  const now = 1_700_000_000;
  const body = '{"reference":"abc12345","status":"success","amount":15000}';
  const header = `t=${now},v1=${sign(SECRET, now, body)}`;
  assert.equal(verifyWebhook(SECRET, header, body, now), true);
});

test('webhook : corps modifié, mauvaise clé ou signature absente sont refusés', () => {
  const now = 1_700_000_000;
  const body = '{"amount":15000}';
  const header = `t=${now},v1=${sign(SECRET, now, body)}`;
  assert.equal(verifyWebhook(SECRET, header, '{"amount":1}', now), false);
  assert.equal(verifyWebhook('autre-secret-de-test-au-moins-32-car', header, body, now), false);
  assert.equal(verifyWebhook(SECRET, `t=${now}`, body, now), false);
});

test('webhook : une notification trop ancienne (rejeu) est refusée', () => {
  const sent = 1_700_000_000;
  const body = '{"amount":15000}';
  const header = `t=${sent},v1=${sign(SECRET, sent, body)}`;
  assert.equal(verifyWebhook(SECRET, header, body, sent + 301), false);
  assert.equal(verifyWebhook(SECRET, header, body, sent + 299), true);
});
