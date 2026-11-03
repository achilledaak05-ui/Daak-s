'use strict';
// Jetons de l'administration : durée courte (10 min), audience et secret propres.
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config');

const ACCESS_TTL_SECONDS = 10 * 60;
const REFRESH_TTL_HOURS = 8;
const ISSUER = 'ouvrage-api-admin';
const AUDIENCE = 'ouvrage-admin-web';

const signAccess = (user) => jwt.sign({ sub: String(user.id), role: 'admin' }, config.jwt.admin, {
  algorithm: 'HS256', expiresIn: ACCESS_TTL_SECONDS, issuer: ISSUER, audience: AUDIENCE,
});
const verifyAccess = (token) => jwt.verify(token, config.jwt.admin, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
const newRefreshToken = () => crypto.randomBytes(48).toString('base64url');
const hashRefresh = (t) => crypto.createHash('sha256').update(t).digest('hex');
const refreshExpiry = () => new Date(Date.now() + REFRESH_TTL_HOURS * 3600 * 1000);

module.exports = { signAccess, verifyAccess, newRefreshToken, hashRefresh, refreshExpiry, ACCESS_TTL_SECONDS };
