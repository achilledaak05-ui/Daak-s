'use strict';
// Notifications in-app, enregistrées en base et lues par GET /notifications
const { q } = require('../db');

async function notify(userId, kind, title, body = '') {
  await q('INSERT INTO notifications (user_id, kind, title, body) VALUES (?, ?, ?, ?)',
    [userId, kind, String(title).slice(0, 160), String(body || '').slice(0, 500)]);
}

module.exports = { notify };
