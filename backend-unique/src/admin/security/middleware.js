'use strict';
const config = require('../../config');
const { verifyAccess } = require('./tokens');
const { HttpError } = require('../../errors');

// Filtre IP optionnel (liste ADMIN_IP_ALLOWLIST)
function ipAllowed(req, res, next) {
  if (config.ipAllowlist.length === 0 || config.ipAllowlist.includes(req.ip)) return next();
  return next(new HttpError(403, 'forbidden', 'Accès refusé'));
}

function requireAdmin(req, res, next) {
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(req.get('authorization') || '');
  if (!match) return next(new HttpError(401, 'unauthorized', 'Connexion requise'));
  try {
    const claims = verifyAccess(match[1]);
    if (claims.role !== 'admin') throw new Error('rôle');
    req.user = { id: Number(claims.sub), role: 'admin' };
    return next();
  } catch (err) {
    return next(new HttpError(401, 'unauthorized', 'Session expirée ou invalide'));
  }
}

module.exports = { ipAllowed, requireAdmin };
