'use strict';
// Hachage des mots de passe avec scrypt (intégré à Node, sans dépendance native).
// Format stocké : scrypt$N$r$p$sel(base64)$hash(base64)

const crypto = require('node:crypto');

const N = 2 ** 15; // coût CPU/mémoire
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

function scryptAsync(password, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const costs = [Number(n), Number(r), Number(p)];
  // Paramètres lus depuis la base : on refuse tout coût absurde (déni de service)
  if (!costs.every(Number.isInteger) || costs[0] < 2 ** 10 || costs[0] > 2 ** 20 || costs[1] < 1 || costs[2] < 1) {
    return false;
  }
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    if (expected.length === 0) return false;
    const key = await scryptAsync(password, salt, expected.length, {
      N: costs[0], r: costs[1], p: costs[2], maxmem: 128 * costs[0] * costs[1] * 2,
    });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch (err) {
    return false;
  }
}

// Hachage factice pour égaliser le temps de réponse quand le compte n'existe pas
const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${Buffer.alloc(SALT_BYTES).toString('base64')}$${Buffer.alloc(KEYLEN).toString('base64')}`;

module.exports = { hashPassword, verifyPassword, DUMMY_HASH };
