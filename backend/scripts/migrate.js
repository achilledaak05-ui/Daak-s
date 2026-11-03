'use strict';
// Applique les fichiers db/migrations/*.sql pas encore passés, dans l'ordre, une seule fois chacun.
// Lancé automatiquement par `npm start` (donc à chaque déploiement Render).
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { connectionOptions } = require('../src/db');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL manquante');
  const ca = process.env.DB_SSL_CA ? process.env.DB_SSL_CA.replace(/\\n/g, '\n') : null;
  const conn = await mysql.createConnection(connectionOptions(process.env.DATABASE_URL, ca, { multipleStatements: true }));
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(190) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`);
    // Verrou : deux instances qui démarrent en même temps n'appliquent pas deux fois la même migration
    const [[lock]] = await conn.query("SELECT GET_LOCK('ouvrage_migrations', 60) AS ok");
    if (!lock.ok) throw new Error('Verrou des migrations indisponible');
    const [done] = await conn.query('SELECT name FROM schema_migrations');
    const applied = new Set(done.map((r) => r.name));
    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      // Le DDL MySQL valide implicitement : une migration doit être écrite pour pouvoir être rejouée après correction
      await conn.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
      console.log(`Migration appliquée : ${file}`);
      count += 1;
    }
    if (!count) console.log('Base à jour, aucune migration à appliquer');
    await conn.query("SELECT RELEASE_LOCK('ouvrage_migrations')");
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(`Échec des migrations : ${err.message}`);
  process.exit(1);
});
