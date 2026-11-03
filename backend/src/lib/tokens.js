'use strict';
// Jetons d'accès JWT courts, un « audience » par espace : un jeton client n'ouvre jamais l'espace pro ou admin.
const jwt = require('jsonwebtoken');
const config = require('../config');

const ISSUER = 'ouvrage-api';
const SPACES = {
  client: { accessTtl: 15 * 60, refreshTtlMs: 30 * 24 * 3600 * 1000 },
  pro: { accessTtl: 15 * 60, refreshTtlMs: 30 * 24 * 3600 * 1000 },
  admin: { accessTtl: 10 * 60, refreshTtlMs: 8 * 3600 * 1000 },
};

function signAccess(space, userId) {
  return jwt.sign({ sub: String(userId), space }, config.jwtSecret, {
    algorithm: 'HS256', expiresIn: SPACES[space].accessTtl, issuer: ISSUER, audience: `ouvrage-${space}`,
  });
}

function verifyAccess(space, token) {
  const claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], issuer: ISSUER, audience: `ouvrage-${space}` });
  if (claims.space !== space) throw new Error('espace');
  return claims;
}

module.exports = { SPACES, signAccess, verifyAccess };
