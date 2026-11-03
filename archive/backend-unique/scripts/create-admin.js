'use strict';
// Crée un administrateur avec double authentification. À exécuter une seule fois, sur le serveur.
// Usage : npm run create-admin -- email@ouvrage.ci "Prénom" "Nom" "mot-de-passe-long"
const { q } = require('../src/db');
const { hashPassword } = require('../src/security/password');
const { newSecret, otpauthUri } = require('../src/admin/security/totp');
const { seal } = require('../src/admin/security/secrets');
const config = require('../src/config');

(async () => {
  const [contact, first, last, password] = process.argv.slice(2);
  if (!contact || !first || !last || !password || password.length < 12) {
    console.error('Usage : npm run create-admin -- <email> <prénom> <nom> <mot de passe (12 caractères min.)>');
    process.exit(1);
  }
  const secret = newSecret();
  const r = await q(
    "INSERT INTO users (role, contact, password_hash, first_name, last_name, city) VALUES ('admin', ?, ?, ?, ?, 'Abidjan')",
    [contact.trim().toLowerCase(), await hashPassword(password), first, last],
  );
  await q('INSERT INTO admin_mfa (user_id, totp_secret_enc) VALUES (?, ?)', [r.insertId, seal(secret, config.secretsKey)]);
  console.log('Administrateur créé (id ' + r.insertId + ').');
  console.log('Ajoutez ce compte dans une application d\'authentification (Google Authenticator, Authy…) :');
  console.log(otpauthUri(contact, secret));
  console.log('Ce lien ne sera plus affiché. Conservez-le en lieu sûr.');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
