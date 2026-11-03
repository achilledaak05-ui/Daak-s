'use strict';
// Double authentification TOTP (RFC 6238) : Google Authenticator, Authy, etc.
const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0; let value = 0; const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new RangeError('Secret invalide');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function codeAt(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1000000).padStart(6, '0');
}

// Tolère un décalage d'horloge de ±30 s
function verifyTotp(secretB32, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return false;
  const secret = base32Decode(secretB32);
  const counter = Math.floor(now / 30000);
  let ok = false;
  for (let w = -1; w <= 1; w += 1) {
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, counter + w)), Buffer.from(String(code)))) ok = true;
  }
  return ok;
}

const newSecret = () => base32Encode(crypto.randomBytes(20));
const otpauthUri = (label, secret) =>
  `otpauth://totp/${encodeURIComponent(`Ouvrage Admin:${label}`)}?secret=${secret}&issuer=Ouvrage&algorithm=SHA1&digits=6&period=30`;

module.exports = { verifyTotp, newSecret, otpauthUri, codeAt, base32Encode, base32Decode };
