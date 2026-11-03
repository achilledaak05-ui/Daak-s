'use strict';
// Journal d'audit : connexions, paiements, annulations, décisions de l'administration…
const { q } = require('../db');

async function audit(req, actorId, action, entity, entityId, meta = null) {
  await q(
    'INSERT INTO audit_log (actor_id, action, entity, entity_id, meta, ip) VALUES (?, ?, ?, ?, ?, ?)',
    [actorId || null, action, entity, String(entityId), meta ? JSON.stringify(meta) : null, req ? req.ip : null],
  );
}

module.exports = { audit };
