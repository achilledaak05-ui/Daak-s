'use strict';
// Configuration unique du backend (applications cliente et prestataire, administration).
// Chaque espace a son propre secret JWT : un jeton d'un espace n'est jamais accepté par un autre.
// Le démarrage échoue si une variable obligatoire manque ou si un secret est trop faible.
require('dotenv').config();

function required(name, minLength = 1) {
  const value = process.env[name];
  if (!value || value.length < minLength) {
    throw new Error(`Variable d'environnement ${name} manquante ou trop courte (minimum ${minLength} caractères)`);
  }
  return value;
}

// Clé de 32 octets, fournie en base64 (45 caractères environ)
function key32(name) {
  const k = Buffer.from(required(name, 40), 'base64');
  if (k.length !== 32) throw new Error(`${name} doit représenter 32 octets (base64)`);
  return k;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  trustProxy: Number(process.env.TRUST_PROXY || 0),
  corsOrigins: (process.env.CORS_ORIGINS || 'capacitor://localhost,https://localhost')
    .split(',').map((s) => s.trim()).filter(Boolean),

  // Un secret par espace : client, prestataire, administration
  jwt: {
    client: required('JWT_SECRET', 32),
    pro: required('JWT_SECRET_PRO', 32),
    admin: required('JWT_SECRET_ADMIN', 32),
  },
  webhookSecret: required('PAYMENT_WEBHOOK_SECRET', 32),

  // Pièces des prestataires (lues par l'administration) : même clé pour les deux espaces
  docKey: key32('DOC_ENCRYPTION_KEY'),
  docStorageDir: required('DOC_STORAGE_DIR'),
  // Secret TOTP de l'administration
  secretsKey: key32('ADMIN_SECRETS_KEY'),
  ipAllowlist: (process.env.ADMIN_IP_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),

  minWithdrawal: Number(process.env.MIN_WITHDRAWAL || 1000),
  distributionSize: Number(process.env.DISTRIBUTION_SIZE || 3),

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: required('DB_NAME'),
    // TLS exigé par la plupart des fournisseurs de MySQL managé : DB_SSL=true
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
  },
};

if (new Set(Object.values(config.jwt)).size !== 3) {
  throw new Error('Les trois secrets JWT (JWT_SECRET, JWT_SECRET_PRO, JWT_SECRET_ADMIN) doivent être différents');
}

module.exports = config;
