'use strict';
// Configuration lue une seule fois au démarrage. Le serveur refuse de démarrer si un secret manque.
require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');

function required(name, minLength = 1) {
  const value = process.env[name];
  if (!value || value.length < minLength) {
    throw new Error(`Variable d'environnement ${name} manquante ou trop courte (minimum ${minLength} caractères)`);
  }
  return value;
}

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

// Clé AES-256 dérivée de DATA_KEY : n'importe quelle chaîne aléatoire assez longue convient
const dataKey = crypto.createHash('sha256').update(`ouvrage-data:${required('DATA_KEY', 32)}`).digest();

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  // Render place le service derrière un proxy : l'IP réelle est dans X-Forwarded-For
  trustProxy: Number(process.env.TRUST_PROXY || (process.env.RENDER ? 1 : 0)),
  corsOrigins: list(process.env.CORS_ORIGINS || 'capacitor://localhost,https://localhost'),
  ipAllowlist: list(process.env.ADMIN_IP_ALLOWLIST),

  jwtSecret: required('JWT_SECRET', 32),
  dataKey,
  webhookSecret: required('PAYMENT_WEBHOOK_SECRET', 32),
  paymentsMode: process.env.PAYMENTS_MODE === 'sandbox' ? 'sandbox' : 'disabled',

  minWithdrawal: Number(process.env.MIN_WITHDRAWAL || 1000),
  distributionSize: Number(process.env.DISTRIBUTION_SIZE || 3),

  databaseUrl: required('DATABASE_URL'),
  dbSslCa: process.env.DB_SSL_CA ? process.env.DB_SSL_CA.replace(/\\n/g, '\n') : null,
};

module.exports = config;
