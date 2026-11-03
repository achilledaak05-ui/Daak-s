'use strict';
// Certaines actions exigent un compte prestataire validé par l'administration
const { q } = require('../../db');
const { HttpError } = require('../../errors');

async function requireVerified(req, res, next) {
  try {
    const [p] = await q("SELECT verification_status FROM pro_profiles WHERE user_id = ?", [req.user.id]);
    if (!p || p.verification_status !== 'valide') {
      return next(new HttpError(403, 'not_verified', 'Votre profil doit être validé par l\'administration'));
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireVerified };
