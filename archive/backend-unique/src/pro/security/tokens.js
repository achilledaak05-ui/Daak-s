'use strict';
// Jetons du prestataire : audience et émetteur propres, secret propre (différent du client).
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config');

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_DAYS = 30;
const ISSUER = 'ouvrage-api-pro';
const AUDIENCE = 'ouvrage-pro-app';

const signAccess = (user) => jwt.sign({ sub: String(user.id), role: user.role }, config.jwt.pro, {
  algorithm: 'HS256', expiresIn: ACCESS_TTL_SECONDS, issuer: ISSUER, audience: AUDIENCE,
});
const verifyAccess = (token) => jwt.verify(token, config.jwt.pro, {
  algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE,
});
const newRefreshToken = () => crypto.randomBytes(48).toString('base64url');
const hashRefresh = (token) => crypto.createHash('sha256').update(token).digest('hex');
const refreshExpiry = () => new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 3600 * 1000);

module.exports = { signAccess, verifyAccess, newRefreshToken, hashRefresh, refreshExpiry, ACCESS_TTL_SECONDS };
