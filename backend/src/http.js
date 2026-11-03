'use strict';
// Outils HTTP communs aux trois espaces : authentification, limites de débit, mise en forme.
const rateLimit = require('express-rate-limit');
const { HttpError } = require('./errors');
const { verifyAccess } = require('./lib/tokens');
const { q } = require('./db');

// Vérifie le jeton d'accès de l'espace ; req.user = { id, space }
function requireAuth(space) {
  return (req, res, next) => {
    const m = /^Bearer ([A-Za-z0-9._-]+)$/.exec(req.get('authorization') || '');
    if (!m) return next(new HttpError(401, 'unauthorized', 'Connexion requise'));
    try {
      const claims = verifyAccess(space, m[1]);
      req.user = { id: Number(claims.sub), space };
      return next();
    } catch {
      return next(new HttpError(401, 'unauthorized', 'Session expirée ou invalide'));
    }
  };
}

// Certaines actions du prestataire exigent un profil validé par l'administration
async function requireVerifiedPro(req, res, next) {
  const [p] = await q('SELECT verification_status FROM pro_profiles WHERE user_id = ?', [req.user.id]);
  if (!p || p.verification_status !== 'valide') {
    throw new HttpError(403, 'not_verified', 'Votre profil doit être validé par l\'administration');
  }
  next();
}

function limiter(windowMs, limit, message = 'Trop de requêtes, réessayez plus tard') {
  return rateLimit({
    windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: { code: 'rate_limited', message } },
  });
}

// « Awa K. » : le nom complet n'est jamais montré à l'autre partie
const shortName = (first, last) => `${first} ${String(last || '').charAt(0)}.`.trim();
const rating = (sum, count) => (count ? Number((sum / count).toFixed(1)) : null);
const splitList = (v) => (v ? String(v).split(',') : []);
const placeholders = (arr) => arr.map(() => '?').join(',');

module.exports = { requireAuth, requireVerifiedPro, limiter, shortName, rating, splitList, placeholders };
