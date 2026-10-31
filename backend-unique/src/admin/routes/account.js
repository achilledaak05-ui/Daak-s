'use strict';
// Compte de l'administrateur connecté : changer son mot de passe, réinitialiser son code TOTP.
// Les deux actions exigent le mot de passe actuel, révoquent toutes les sessions admin, et sont journalisées.
const express = require('express');
const config = require('../../config');
const { q, tx } = require('../../db');
const { schemas } = require('../validation');
const { HttpError, asyncHandler } = require('../../errors');
const { requireAdmin } = require('../security/middleware');
const { hashPassword, verifyPassword } = require('../../security/password');
const { verifyTotp, newSecret, otpauthUri } = require('../security/totp');
const { seal, open } = require('../security/secrets');
const { audit } = require('../../services/audit');

const router = express.Router();
router.use(requireAdmin);

async function loadAdmin(id) {
  const [u] = await q(
    `SELECT u.id, u.contact, u.password_hash, m.totp_secret_enc
       FROM users u LEFT JOIN admin_mfa m ON m.user_id = u.id
      WHERE u.id = ? AND u.role = 'admin' AND u.status = 'active'`,
    [id],
  );
  if (!u) throw new HttpError(401, 'unauthorized', 'Session expirée ou invalide');
  return u;
}

router.post('/password', asyncHandler(async (req, res) => {
  const b = schemas.changePassword.parse(req.body);
  const u = await loadAdmin(req.user.id);
  if (!(await verifyPassword(b.currentPassword, u.password_hash))) {
    await audit(u.id, 'admin_password_failed', 'user', u.id, req);
    throw new HttpError(401, 'invalid_credentials', 'Mot de passe actuel incorrect');
  }
  const hash = await hashPassword(b.newPassword);
  await tx(async (t) => {
    await t.q('UPDATE users SET password_hash = ? WHERE id = ?', [hash, u.id]);
    await t.q('UPDATE admin_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [u.id]);
  });
  await audit(u.id, 'admin_password_changed', 'user', u.id, req);
  res.status(204).end();
}));

// Nouveau secret TOTP : l'ancien cesse de fonctionner. Le lien otpauth:// n'est renvoyé qu'une fois.
router.post('/totp/reset', asyncHandler(async (req, res) => {
  const b = schemas.resetTotp.parse(req.body);
  const u = await loadAdmin(req.user.id);
  const passwordOk = await verifyPassword(b.password, u.password_hash);
  const totpOk = !!u.totp_secret_enc && verifyTotp(open(u.totp_secret_enc, config.secretsKey), b.totp);
  if (!passwordOk || !totpOk) {
    await audit(u.id, 'admin_totp_reset_failed', 'user', u.id, req);
    throw new HttpError(401, 'invalid_credentials', 'Mot de passe ou code incorrect');
  }
  const secret = newSecret();
  await tx(async (t) => {
    await t.q('UPDATE admin_mfa SET totp_secret_enc = ?, enabled_at = NOW() WHERE user_id = ?', [seal(secret, config.secretsKey), u.id]);
    await t.q('UPDATE admin_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [u.id]);
  });
  await audit(u.id, 'admin_totp_reset', 'user', u.id, req);
  res.json({ otpauthUri: otpauthUri(u.contact, secret) });
}));

module.exports = router;
