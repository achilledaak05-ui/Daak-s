'use strict';
// Accès MySQL : requêtes paramétrées uniquement, jamais de valeur utilisateur concaténée dans le SQL.
const mysql = require('mysql2/promise');

// Options de connexion à partir de DATABASE_URL (format Aiven : ...?ssl-mode=REQUIRED)
function connectionOptions(url, sslCa, extra = {}) {
  const u = new URL(url);
  const sslMode = (u.searchParams.get('ssl-mode') || '').toUpperCase();
  let ssl;
  if (sslCa) ssl = { ca: sslCa, rejectUnauthorized: true };
  else if (sslMode === 'REQUIRED' || sslMode === 'VERIFY_CA' || sslMode === 'VERIFY_IDENTITY') ssl = { rejectUnauthorized: true };
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    ssl,
    timezone: 'Z',
    dateStrings: false,
    decimalNumbers: true,
    supportBigNumbers: true,
    ...extra,
  };
}

let pool;
function getPool() {
  if (!pool) {
    const config = require('./config');
    pool = mysql.createPool({ ...connectionOptions(config.databaseUrl, config.dbSslCa), connectionLimit: 10, waitForConnections: true });
  }
  return pool;
}

async function q(sql, params = []) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

// Exécute `fn` dans une transaction ; `t.q` utilise la même connexion
async function tx(fn) {
  const conn = await getPool().getConnection();
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

async function close() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = { q, tx, close, connectionOptions };
