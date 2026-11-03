'use strict';
// Chiffrement AES-256-GCM des secrets stockés en base (secret TOTP)
const crypto = require('node:crypto');

function seal(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

function open(sealed, key) {
  const data = Buffer.from(sealed, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  d.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([d.update(data.subarray(28)), d.final()]).toString('utf8');
}

module.exports = { seal, open };
