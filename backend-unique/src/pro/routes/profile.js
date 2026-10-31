'use strict';
// Profil du prestataire, métiers, zones, statut de vérification, avis reçus, suppression du compte
const express = require('express');
const { q, tx } = require('../../db');
const { schemas } = require('../validation');
const { HttpError, asyncHandler } = require('../../errors');
const { requireAuth, requireRole } = require('../security/middleware');
const { verifyPassword } = require('../../security/password');
const { audit } = require('../../services/audit');

const router = express.Router();
router.use(requireAuth, requireRole('pro'));

const rate = (sum, count) => (count ? Number((sum / count).toFixed(1)) : null);

router.get('/', asyncHandler(async (req, res) => {
  const [u] = await q(
    `SELECT u.id, u.contact, u.first_name, u.last_name, u.city, pp.bio, pp.base_price, pp.available,
            pp.verification_status, pp.rating_sum, pp.rating_count
       FROM users u JOIN pro_profiles pp ON pp.user_id = u.id WHERE u.id = ? AND u.status = 'active'`,
    [req.user.id],
  );
  if (!u) throw new HttpError(404, 'not_found', 'Compte introuvable');
  const trades = await q('SELECT trade FROM pro_trades WHERE user_id = ? ORDER BY trade', [u.id]);
  const zones = await q('SELECT zone FROM pro_zones WHERE user_id = ? ORDER BY zone', [u.id]);
  res.json({
    id: u.id, contact: u.contact, firstName: u.first_name, lastName: u.last_name, city: u.city,
    bio: u.bio || '', basePrice: u.base_price, available: !!u.available,
    verificationStatus: u.verification_status, trades: trades.map((t) => t.trade), zones: zones.map((z) => z.zone),
    rating: rate(u.rating_sum, u.rating_count), ratingCount: u.rating_count,
  });
}));

router.patch('/', asyncHandler(async (req, res) => {
  const b = schemas.patchMe.parse(req.body);
  await tx(async (t) => {
    if (b.city !== undefined) await t.q('UPDATE users SET city = ? WHERE id = ?', [b.city, req.user.id]);
    if (b.bio !== undefined) await t.q('UPDATE pro_profiles SET bio = ? WHERE user_id = ?', [b.bio || null, req.user.id]);
    if (b.basePrice !== undefined) await t.q('UPDATE pro_profiles SET base_price = ? WHERE user_id = ?', [b.basePrice, req.user.id]);
    if (b.available !== undefined) await t.q('UPDATE pro_profiles SET available = ? WHERE user_id = ?', [b.available ? 1 : 0, req.user.id]);
  });
  res.status(204).end();
}));

router.put('/trades', asyncHandler(async (req, res) => {
  const b = schemas.trades.parse(req.body);
  await tx(async (t) => {
    await t.q('DELETE FROM pro_trades WHERE user_id = ?', [req.user.id]);
    for (const trade of [...new Set(b.trades)]) await t.q('INSERT INTO pro_trades (user_id, trade) VALUES (?, ?)', [req.user.id, trade]);
  });
  res.status(204).end();
}));

router.put('/zones', asyncHandler(async (req, res) => {
  const b = schemas.zones.parse(req.body);
  await tx(async (t) => {
    await t.q('DELETE FROM pro_zones WHERE user_id = ?', [req.user.id]);
    for (const zone of [...new Set(b.zones)]) await t.q('INSERT INTO pro_zones (user_id, zone) VALUES (?, ?)', [req.user.id, zone]);
  });
  res.status(204).end();
}));

// Pièces requises pour la validation : carte d'identité et extrait de naissance (justificatif facultatif)
router.get('/verification', asyncHandler(async (req, res) => {
  const [p] = await q('SELECT verification_status FROM pro_profiles WHERE user_id = ?', [req.user.id]);
  const docs = await q('SELECT kind FROM pro_documents WHERE user_id = ? AND is_current = 1', [req.user.id]);
  const have = new Set(docs.map((d) => d.kind));
  const missing = ['cni', 'naiss'].filter((k) => !have.has(k));
  res.json({ status: p.verification_status, documents: { cni: have.has('cni'), naiss: have.has('naiss'), diplome: have.has('diplome') }, missing });
}));

router.get('/reviews', asyncHandler(async (req, res) => {
  const rows = await q(
    `SELECT r.rating, r.comment, r.created_at, u.first_name, u.last_name
       FROM reviews r JOIN users u ON u.id = r.client_id WHERE r.pro_id = ? ORDER BY r.id DESC LIMIT 50`,
    [req.user.id],
  );
  res.json({ items: rows.map((r) => ({ rating: r.rating, comment: r.comment, author: `${r.first_name} ${r.last_name.charAt(0)}.`, date: r.created_at })) });
}));

// Suppression : compte anonymisé, retiré de l'annuaire, sessions révoquées, historique conservé
router.delete('/', asyncHandler(async (req, res) => {
  const b = schemas.deleteMe.parse(req.body);
  const [u] = await q('SELECT password_hash FROM users WHERE id = ? AND status = ?', [req.user.id, 'active']);
  if (!u || !(await verifyPassword(b.password, u.password_hash))) throw new HttpError(403, 'forbidden', 'Mot de passe incorrect');
  await tx(async (t) => {
    await t.q("UPDATE users SET status = 'deleted', contact = CONCAT('supprime-', id, '@invalid.local'), first_name = 'Compte', last_name = 'supprimé', password_hash = '!' WHERE id = ?", [req.user.id]);
    await t.q("UPDATE pro_profiles SET available = 0, verification_status = 'refuse' WHERE user_id = ?", [req.user.id]);
    await t.q('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [req.user.id]);
  });
  await audit(req.user.id, 'account_deleted', 'user', req.user.id, req);
  res.status(204).end();
}));

module.exports = router;
