'use strict';
// Vérification de la signature des notifications du prestataire de paiement.
// En-tête attendu : "t=<unix>,v1=<hmac-sha256 hex de `${t}.${corps}`>"
// Protection contre le rejeu : la date doit être récente (tolérance de 5 minutes).

const crypto = require('node:crypto');

const TOLERANCE_SECONDS = 300;

function sign(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

function verifyWebhook(secret, header, rawBody, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof header !== 'string' || typeof rawBody !== 'string') return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => kv.trim().split('=')).filter((kv) => kv.length === 2),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1) return false;
  if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(sign(secret, t, rawBody), 'hex');
  const received = Buffer.from(v1, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

module.exports = { verifyWebhook, sign, TOLERANCE_SECONDS };
