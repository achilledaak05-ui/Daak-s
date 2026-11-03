'use strict';
const express = require('express');
const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const { q, tx } = require('../../db');
const { schemas } = require('../validation');
const { HttpError, asyncHandler } = require('../../errors');
const { hashPassword, verifyPassword, DUMMY_HASH } = require('../../security/password');
const { signAccess, newRefreshToken, hashRefresh, refreshExpiry, ACCESS_TTL_SECONDS } = require('../security/tokens');
const { audit } = require('../../services/audit');

const router = express.Router();

// 20 tentatives par 15 minutes et par IP sur les routes sensibles
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Trop de tentatives, réessayez plus tard' } },
});

const normalizeContact = (v) => v.trim().toLowerCase().replace(/\s/g, '');

async function issueSession(conn, user) {
  const refreshToken = newRefreshToken();
  await conn.q(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [user.id, hashRefresh(refreshToken), refreshExpiry()],
  );
  return { accessToken: signAccess(user), refreshToken, expiresIn: ACCESS_TTL_SECONDS };
}

router.post('/register', authLimiter, asyncHandler(async (req, res) => {
  const b = schemas.register.parse(req.body);
  const contact = normalizeContact(b.contact);
  const passwordHash = await hashPassword(b.password);
  let user;
  try {
    user = await tx(async (t) => {
      const r = await t.q(
        'INSERT INTO users (role, contact, password_hash, first_name, last_name, city, zone) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['client', contact, passwordHash, b.firstName, b.lastName, b.city, b.zone || null],
      );
      const session = await issueSession(t, { id: r.insertId, role: 'client' });
      return { id: r.insertId, session };
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      // Message volontairement générique : ne pas révéler si un compte existe
      throw new HttpError(400, 'registration_failed', 'Création impossible : vérifiez vos informations');
    }
    throw err;
  }
  await audit(user.id, 'register', 'user', user.id, req);
  res.status(201).json({ user: { id: user.id, role: 'client' }, ...user.session });
}));

router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  const b = schemas.login.parse(req.body);
  const contact = normalizeContact(b.contact);
  const rows = await q('SELECT id, role, status, password_hash FROM users WHERE contact = ?', [contact]);
  const u = rows[0];
  // Vérification du mot de passe dans tous les cas (même durée de réponse, compte absent inclus)
  const ok = await verifyPassword(b.password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok || u.role !== 'client' || u.status !== 'active') {
    await audit(u ? u.id : null, 'login_failed', 'user', u ? u.id : 'inconnu', req);
    throw new HttpError(401, 'invalid_credentials', 'Identifiant ou mot de passe incorrect');
  }
  const session = await tx((t) => issueSession(t, { id: u.id, role: u.role }));
  await audit(u.id, 'login', 'user', u.id, req);
  res.json({ user: { id: u.id, role: u.role }, ...session });
}));

// Rotation : un refresh token ne sert qu'une fois. Son réemploi révoque toutes les sessions.
router.post('/refresh', authLimiter, asyncHandler(async (req, res) => {
  const b = schemas.refresh.parse(req.body);
  const hash = hashRefresh(b.refreshToken);
  const result = await tx(async (t) => {
    const rows = await t.q('SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ? FOR UPDATE', [hash]);
    const row = rows[0];
    if (!row) return null;
    if (row.revoked_at) {
      await t.q('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [row.user_id]);
      return { reuse: true, userId: row.user_id };
    }
    if (new Date(row.expires_at) < new Date()) return null;
    await t.q('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ?', [row.id]);
    const users = await t.q("SELECT id, role FROM users WHERE id = ? AND role = 'client' AND status = 'active'", [row.user_id]);
    if (!users[0]) return null;
    return { session: await issueSession(t, users[0]), userId: users[0].id };
  });
  if (!result || !result.session) {
    if (result && result.reuse) await audit(result.userId, 'refresh_reuse_detected', 'user', result.userId, req);
    throw new HttpError(401, 'unauthorized', 'Session expirée ou invalide');
  }
  res.json(result.session);
}));

router.post('/logout', asyncHandler(async (req, res) => {
  const b = schemas.refresh.parse(req.body);
  await q('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = ? AND revoked_at IS NULL', [hashRefresh(b.refreshToken)]);
  res.status(204).end();
}));

module.exports = router;
