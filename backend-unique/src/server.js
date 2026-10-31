'use strict';
const config = require('./config');
const app = require('./app');
const { pool } = require('./db');

const server = app.listen(config.port, () => {
  console.log(`Ouvrage API à l'écoute sur le port ${config.port} (${config.env})`);
});

// Arrêt propre : on termine les requêtes en cours, puis on ferme la base
function shutdown(signal) {
  console.log(`${signal} reçu, arrêt en cours…`);
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
