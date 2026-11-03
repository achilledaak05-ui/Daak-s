'use strict';
const { verifyAccess } = require('./tokens');
const { HttpError } = require('../../errors');

// Vérifie le jeton d'accès et place { id, role } dans req.user
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
  if (!match) return next(new HttpError(401, 'unauthorized', 'Connexion requise'));
  try {
    const claims = verifyAccess(match[1]);
    req.user = { id: Number(claims.sub), role: claims.role };
    return next();
  } catch (err) {
    return next(new HttpError(401, 'unauthorized', 'Session expirée ou invalide'));
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return next(new HttpError(403, 'forbidden', 'Accès refusé'));
    }
    return next();
  };
}

module.exports = { requireAuth, requireRole };
