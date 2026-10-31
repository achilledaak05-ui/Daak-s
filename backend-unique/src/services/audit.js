'use strict';
// Journal d'audit : toute action sensible (connexion, paiement, annulation, suppression) est tracée.
const { q } = require('../db');

async function audit(actorId, action, entity, entityId, req, meta = null) {
  await q(
    'INSERT INTO audit_log (actor_id, action, entity, entity_id, meta, ip) VALUES (?, ?, ?, ?, ?, ?)',
    [actorId || null, action, entity, String(entityId), meta ? JSON.stringify(meta) : null, req ? req.ip : null],
  );
}

module.exports = { audit };
