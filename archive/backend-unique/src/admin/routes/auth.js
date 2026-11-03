'use strict';
// Connexion en deux étapes : mot de passe, puis code de double authentification (TOTP).
const express = require('express');
const rateLimit = require('express-rate-limit');
const { q, tx } = require('../../db');
const config = require('../../config');
const { schemas } = require('../validation');
const { HttpError, asyncHandler } = require('../../errors');
const { verifyPassword, DUMMY_HASH } = require('../../security/password');
const { verifyTotp } = require('../security/totp');
const { open } = require('../security/secrets');
const { signAccess, newRefreshToken, hashRefresh, refreshExpiry, ACCESS_TTL_SECONDS } = require('../security/tokens');
const { audit } = require('../../services/audit');

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Trop de tentatives, réessayez plus tard' } } });

async function session(t, userId) {
  const refreshToken = newRefreshToken();
  await t.q('INSERT INTO admin_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)', [userId, hashRefresh(refreshToken), refreshExpiry()]);
  return { accessToken: signAccess({ id: userId }), refreshToken, expiresIn: ACCESS_TTL_SECONDS };
}

router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const b = schemas.login.parse(req.body);
  const [u] = await q(
    `SELECT u.id, u.role, u.status, u.password_hash, m.totp_secret_enc
       FROM users u LEFT JOIN admin_mfa m ON m.user_id = u.id WHERE u.contact = ?`,
    [b.contact.trim().toLowerCase().replace(/\s/g, '')],
  );
  const ok = await verifyPassword(b.password, u ? u.password_hash : DUMMY_HASH);
  const isAdmin = !!u && u.role === 'admin' && u.status === 'active' && !!u.totp_secret_enc;
  if (!isAdmin || !ok) {
    await audit(u ? u.id : null, 'admin_login_failed', 'user', u ? u.id : 'inconnu', req);
    throw new HttpError(401, 'invalid_credentials', 'Identifiant, mot de passe ou code incorrect');
  }
  if (!b.totp) return res.status(401).json({ error: { code: 'mfa_required', message: 'Code de double authentification requis' } });
  const secret = open(u.totp_secret_enc, config.secretsKey);
  if (!verifyTotp(secret, b.totp)) {
    await audit(u.id, 'admin_mfa_failed', 'user', u.id, req);
    throw new HttpError(401, 'invalid_credentials', 'Identifiant, mot de passe ou code incorrect');
  }
  const s = await tx((t) => session(t, u.id));
  await audit(u.id, 'admin_login', 'user', u.id, req);
  res.json({ user: { id: u.id, role: 'admin' }, ...s });
}));

router.post('/refresh', loginLimiter, asyncHandler(async (req, res) => {
  const b = schemas.refresh.parse(req.body);
  const out = await tx(async (t) => {
    const [row] = await t.q('SELECT id, user_id, expires_at, revoked_at FROM admin_sessions WHERE token_hash = ? FOR UPDATE', [hashRefresh(b.refreshToken)]);
    if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) {
      if (row && row.revoked_at) await t.q('UPDATE admin_sessions SET revoked_at = NOW() WHERE user_id = ?', [row.user_id]);
      return null;
    }
    await t.q('UPDATE admin_sessions SET revoked_at = NOW() WHERE id = ?', [row.id]);
    const [u] = await t.q("SELECT id FROM users WHERE id = ? AND role = 'admin' AND status = 'active'", [row.user_id]);
    return u ? session(t, u.id) : null;
  });
  if (!out) throw new HttpError(401, 'unauthorized', 'Session expirée ou invalide');
  res.json(out);
}));

router.post('/logout', asyncHandler(async (req, res) => {
  const b = schemas.refresh.parse(req.body);
  await q('UPDATE admin_sessions SET revoked_at = NOW() WHERE token_hash = ? AND revoked_at IS NULL', [hashRefresh(b.refreshToken)]);
  res.status(204).end();
}));

module.exports = router;
