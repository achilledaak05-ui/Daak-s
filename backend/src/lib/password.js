'use strict';
// Mots de passe hachés avec scrypt (intégré à Node). Format : scrypt$N$r$p$sel$hash (base64)
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const N = 2 ** 15; const R = 8; const P = 1; const KEYLEN = 64;
const opts = (n, r, p) => ({ N: n, r, p, maxmem: 256 * n * r });

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, opts(N, R, P));
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  // Coûts lus en base : on refuse les valeurs absurdes (déni de service)
  if (![n, r, p].every(Number.isInteger) || n < 2 ** 10 || n > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 4) return false;
  const expected = Buffer.from(parts[5], 'base64');
  if (!expected.length) return false;
  try {
    const key = await scrypt(password, Buffer.from(parts[4], 'base64'), expected.length, opts(n, r, p));
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// Hachage factice : même temps de réponse quand le compte n'existe pas
const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEYLEN).toString('base64')}`;

module.exports = { hashPassword, verifyPassword, DUMMY_HASH };
