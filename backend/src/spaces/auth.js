'use strict';
// Sessions communes aux trois espaces : jeton d'accès court + refresh token opaque, roté à chaque usage.
// Un refresh token déjà utilisé qui revient = vol probable : toutes les sessions de l'espace sont révoquées.
const { SPACES, signAccess } = require('../lib/tokens');
const { sha256, randomToken } = require('../lib/crypto');
const { HttpError } = require('../errors');
const { common } = require('../lib/validation');
const { q, tx } = require('../db');
const { audit } = require('../services/audit');

async function openSession(t, space, userId) {
  const refreshToken = randomToken();
  await t.q('INSERT INTO sessions (user_id, space, token_hash, expires_at) VALUES (?, ?, ?, ?)',
    [userId, space, sha256(refreshToken), new Date(Date.now() + SPACES[space].refreshTtlMs)]);
  return { accessToken: signAccess(space, userId), refreshToken, expiresIn: SPACES[space].accessTtl };
}

// Rôle attendu pour chaque espace : un compte client ne peut pas ouvrir l'espace prestataire, etc.
const ROLE = { client: 'client', pro: 'pro', admin: 'admin' };

function refreshHandler(space) {
  return async (req, res) => {
    const b = common.refresh.parse(req.body);
    const out = await tx(async (t) => {
      const [row] = await t.q('SELECT id, user_id, space, expires_at, revoked_at FROM sessions WHERE token_hash = ? FOR UPDATE',
        [sha256(b.refreshToken)]);
      if (!row || row.space !== space) return null;
      if (row.revoked_at) {
        await t.q('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND space = ? AND revoked_at IS NULL', [row.user_id, space]);
        return { reuse: row.user_id };
      }
      if (new Date(row.expires_at) < new Date()) return null;
      await t.q('UPDATE sessions SET revoked_at = NOW() WHERE id = ?', [row.id]);
      const [u] = await t.q("SELECT id FROM users WHERE id = ? AND role = ? AND status = 'active'", [row.user_id, ROLE[space]]);
      return u ? { session: await openSession(t, space, u.id) } : null;
    });
    if (!out || !out.session) {
      if (out && out.reuse) await audit(req, out.reuse, 'refresh_reuse_detected', 'user', out.reuse, { space });
      throw new HttpError(401, 'unauthorized', 'Session expirée ou invalide');
    }
    res.json(out.session);
  };
}

function logoutHandler(space) {
  return async (req, res) => {
    const b = common.refresh.parse(req.body);
    await q('UPDATE sessions SET revoked_at = NOW() WHERE token_hash = ? AND space = ? AND revoked_at IS NULL', [sha256(b.refreshToken), space]);
    res.status(204).end();
  };
}

async function revokeAll(t, userId, space = null) {
  if (space) await t.q('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND space = ? AND revoked_at IS NULL', [userId, space]);
  else await t.q('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [userId]);
}

module.exports = { openSession, refreshHandler, logoutHandler, revokeAll, ROLE };
