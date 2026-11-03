'use strict';
// Chiffrement AES-256-GCM des données sensibles stockées en base (pièces, secrets TOTP, numéros de retrait).
// Format : iv (12 octets) | tag (16 octets) | contenu chiffré
const crypto = require('node:crypto');

function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

function decrypt(data, key) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  d.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([d.update(data.subarray(28)), d.final()]);
}

const sealText = (text, key) => encrypt(Buffer.from(text, 'utf8'), key).toString('base64');
const openText = (sealed, key) => decrypt(Buffer.from(sealed, 'base64'), key).toString('utf8');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url');

module.exports = { encrypt, decrypt, sealText, openText, sha256, randomToken };
