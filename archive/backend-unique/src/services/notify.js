'use strict';
// Notifications in-app : enregistrées en base, relues par le client via GET /v1/notifications.
// (Les notifications push Firebase/APNs viendront s'ajouter ici.)
const { q } = require('../db');

async function notifyUser(userId, kind, title, body = '') {
  await q('INSERT INTO notifications (user_id, kind, title, body) VALUES (?, ?, ?, ?)',
    [userId, kind, title.slice(0, 160), body.slice(0, 500)]);
}

module.exports = { notifyUser };
