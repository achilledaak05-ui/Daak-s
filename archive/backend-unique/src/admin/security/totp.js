'use strict';
// Double authentification TOTP (RFC 6238), sans dépendance : compatible Google Authenticator, Authy, etc.
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
  const clean = str.replace(/=+$/g, '').toUpperCase();
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new RangeError('Secret invalide');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function codeAt(secretBuf, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const offset = h[h.length - 1] & 0x0f;
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 1000000).padStart(6, '0');
}

function verifyTotp(secretB32, code, now = Date.now(), window = 1) {
  if (!/^\d{6}$/.test(String(code))) return false;
  const secret = base32Decode(secretB32);
  const counter = Math.floor(now / 1000 / 30);
  let ok = false;
  for (let w = -window; w <= window; w += 1) {
    const expected = codeAt(secret, counter + w);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) ok = true;
  }
  return ok;
}

function newSecret() { return base32Encode(crypto.randomBytes(20)); }

function otpauthUri(label, secretB32) {
  return `otpauth://totp/${encodeURIComponent('Ouvrage Admin:' + label)}?secret=${secretB32}&issuer=Ouvrage&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { verifyTotp, newSecret, otpauthUri, codeAt, base32Encode, base32Decode };
