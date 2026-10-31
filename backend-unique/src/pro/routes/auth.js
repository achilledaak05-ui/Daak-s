'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { q, tx } = require('../../db');
const { schemas } = require('../validation');
const { HttpError, asyncHandler } = require('../../errors');
const { hashPassword, verifyPassword, DUMMY_HASH } = require('../../security/password');
const { signAccess, newRefreshToken, hashRefresh, refreshExpiry, ACCESS_TTL_SECONDS } = require('../security/tokens');
const { audit } = require('../../services/audit');

const router = express.Router();
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Trop de tentatives, réessayez plus tard' } } });
const normalizeContact = (v) => v.trim().toLowerCase().replace(/\s/g, '');

async function issueSession(t, user) {
  const refreshToken = newRefreshToken();
  await t.q('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [user.id, hashRefresh(refreshToken), refreshExpiry()]);
  return { accessToken: signAccess(user), refreshToken, expiresIn: ACCESS_TTL_SECONDS };
}

router.post('/register', authLimiter, asyncHandler(async (req, res) => {
  const b = schemas.register.parse(req.body);
  const contact = normalizeContact(b.contact);
  const passwordHash = await hashPassword(b.password);
  let session;
  let id;
  try {
    ({ id, session } = await tx(async (t) => {
      const r = await t.q('INSERT INTO users (role, contact, password_hash, first_name, last_name, city) VALUES (?, ?, ?, ?, ?, ?)',
        ['pro', contact, passwordHash, b.firstName, b.lastName, b.city]);
      await t.q("INSERT INTO pro_profiles (user_id, bio, base_price, verification_status, available) VALUES (?, ?, 0, 'attente', 1)",
        [r.insertId, b.bio || null]);
      for (const trade of [...new Set(b.trades)]) await t.q('INSERT INTO pro_trades (user_id, trade) VALUES (?, ?)', [r.insertId, trade]);
      for (const zone of [...new Set(b.zones)]) await t.q('INSERT INTO pro_zones (user_id, zone) VALUES (?, ?)', [r.insertId, zone]);
      return { id: r.insertId, session: await issueSession(t, { id: r.insertId, role: 'pro' }) };
    }));
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new HttpError(400, 'registration_failed', 'Création impossible : vérifiez vos informations');
    throw err;
  }
  await audit(id, 'pro_register', 'user', id, req);
  res.status(201).json({ user: { id, role: 'pro' }, ...session });
}));

router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  const b = schemas.login.parse(req.body);
  const [u] = await q('SELECT id, role, status, password_hash FROM users WHERE contact = ?', [normalizeContact(b.contact)]);
  const ok = await verifyPassword(b.password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok || u.role !== 'pro' || u.status !== 'active') {
    await audit(u ? u.id : null, 'login_failed', 'user', u ? u.id : 'inconnu', req);
    throw new HttpError(401, 'invalid_credentials', 'Identifiant ou mot de passe incorrect');
  }
  const session = await tx((t) => issueSession(t, { id: u.id, role: u.role }));
  await audit(u.id, 'login', 'user', u.id, req);
  res.json({ user: { id: u.id, role: u.role }, ...session });
}));

router.post('/refresh', authLimiter, asyncHandler(async (req, res) => {
  const b = schemas.refresh.parse(req.body);
  const result = await tx(async (t) => {
    const [row] = await t.q('SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ? FOR UPDATE', [hashRefresh(b.refreshToken)]);
    if (!row) return null;
    if (row.revoked_at) {
      await t.q('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [row.user_id]);
      return { reuse: true, userId: row.user_id };
    }
    if (new Date(row.expires_at) < new Date()) return null;
    await t.q('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ?', [row.id]);
    const [user] = await t.q("SELECT id, role FROM users WHERE id = ? AND role = 'pro' AND status = 'active'", [row.user_id]);
    if (!user) return null;
    return { session: await issueSession(t, user), userId: user.id };
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
