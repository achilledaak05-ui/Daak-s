'use strict';
// Création d'un compte administrateur avec double authentification.
//   npm run create-admin -- admin@ouvrage.ci "Prénom" "Nom" "mot-de-passe-de-12-caractères"
// En production : lancer en local avec DATABASE_URL / DB_SSL_CA / DATA_KEY de Render dans .env
require('dotenv').config({ quiet: true });
const { q, tx, close } = require('../src/db');
const config = require('../src/config');
const { hashPassword } = require('../src/lib/password');
const { sealText } = require('../src/lib/crypto');
const { newSecret, otpauthUri } = require('../src/lib/totp');
const { normalizeContact } = require('../src/lib/validation');

async function main() {
  const [contactRaw, firstName, lastName, password] = process.argv.slice(2);
  if (!contactRaw || !firstName || !lastName || !password) {
    throw new Error('Usage : npm run create-admin -- <email> <prénom> <nom> <mot de passe (12 caractères min.)>');
  }
  if (password.length < 12) throw new Error('Mot de passe administrateur : 12 caractères minimum');
  const contact = normalizeContact(contactRaw);
  const [exists] = await q('SELECT id FROM users WHERE contact = ?', [contact]);
  if (exists) throw new Error('Un compte existe déjà avec ce contact');
  const secret = newSecret();
  const hash = await hashPassword(password);
  await tx(async (t) => {
    const r = await t.q("INSERT INTO users (role, contact, password_hash, first_name, last_name, city) VALUES ('admin', ?, ?, ?, ?, 'Abidjan')",
      [contact, hash, firstName, lastName]);
    await t.q('INSERT INTO admin_mfa (user_id, totp_secret_enc) VALUES (?, ?)', [r.insertId, sealText(secret, config.dataKey)]);
  });
  console.log('Administrateur créé.');
  console.log('Ajoutez ce compte dans votre application d\'authentification (Google Authenticator, Authy…) :');
  console.log(`  Lien   : ${otpauthUri(contact, secret)}`);
  console.log(`  Secret : ${secret}`);
}

main()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(close);
