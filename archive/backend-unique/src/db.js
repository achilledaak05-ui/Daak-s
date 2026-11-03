'use strict';
// Accès MySQL : requêtes paramétrées uniquement (jamais de concaténation de valeurs utilisateur).
const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  ssl: config.db.ssl,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: 'Z',
  decimalNumbers: true,
});

async function q(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

// Exécute plusieurs requêtes dans une transaction. `t.q` utilise la même connexion.
async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn({ q: async (sql, params = []) => (await conn.query(sql, params))[0] });
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { q, tx, pool };
