'use strict';
const { verifyAccess } = require('./tokens');
const { HttpError } = require('../../errors');

function requireAuth(req, res, next) {
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(req.get('authorization') || '');
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
  return (req, res, next) => (req.user && req.user.role === role
    ? next() : next(new HttpError(403, 'forbidden', 'Accès refusé')));
}

module.exports = { requireAuth, requireRole };
