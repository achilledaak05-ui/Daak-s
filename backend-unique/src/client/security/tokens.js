'use strict';
// Jetons de session : access token JWT court (15 min) + refresh token opaque, haché en base et roté à chaque usage.
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config');

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_DAYS = 30;
const ISSUER = 'ouvrage-api';
const AUDIENCE = 'ouvrage-client';

function signAccess(user) {
  return jwt.sign({ sub: String(user.id), role: user.role }, config.jwt.client, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TTL_SECONDS,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

function verifyAccess(token) {
  return jwt.verify(token, config.jwt.client, {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

function newRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function hashRefresh(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function refreshExpiry() {
  return new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 3600 * 1000);
}

module.exports = { signAccess, verifyAccess, newRefreshToken, hashRefresh, refreshExpiry, ACCESS_TTL_SECONDS };
