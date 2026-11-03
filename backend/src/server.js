'use strict';
const config = require('./config');
const app = require('./app');
const { close } = require('./db');

const server = app.listen(config.port, () => {
  console.log(`Ouvrage API sur le port ${config.port} (${config.env}, paiements : ${config.paymentsMode})`);
});

// Render envoie SIGTERM avant d'arrêter l'instance : on termine les requêtes en cours
function shutdown() {
  server.close(async () => {
    await close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
