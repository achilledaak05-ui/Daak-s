'use strict';
// Profil du client et annuaire public des prestataires vérifiés
const express = require('express');
const { q, tx } = require('../../db');
const { schemas, idParam } = require('../validation');
const { HttpError, asyncHandler } = require('../../errors');
const { requireAuth, requireRole } = require('../security/middleware');
const { verifyPassword } = require('../../security/password');
const { audit } = require('../../services/audit');

const router = express.Router();
const PAGE_SIZE = 20;
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// --- Profil du client connecté ---
router.get('/me', requireAuth, requireRole('client'), asyncHandler(async (req, res) => {
  const rows = await q(
    'SELECT id, contact, first_name, last_name, city, zone FROM users WHERE id = ? AND status = ?',
    [req.user.id, 'active'],
  );
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Compte introuvable');
  const u = rows[0];
  res.json({ id: u.id, contact: u.contact, firstName: u.first_name, lastName: u.last_name, city: u.city, zone: u.zone });
}));

router.patch('/me', requireAuth, requireRole('client'), asyncHandler(async (req, res) => {
  const b = schemas.patchMe.parse(req.body);
  const map = { firstName: 'first_name', lastName: 'last_name', city: 'city', zone: 'zone' };
  const sets = [];
  const values = [];
  for (const [k, col] of Object.entries(map)) {
    if (b[k] !== undefined) { sets.push(`${col} = ?`); values.push(b[k] || null); }
  }
  if (sets.length === 0) return res.status(204).end();
  await q(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND status = 'active'`, [...values, req.user.id]);
  res.status(204).end();
}));

// Suppression du compte (exigée par les stores) : anonymisation, sessions révoquées, historique conservé
router.delete('/me', requireAuth, requireRole('client'), asyncHandler(async (req, res) => {
  const b = schemas.deleteMe.parse(req.body);
  const rows = await q('SELECT password_hash FROM users WHERE id = ? AND status = ?', [req.user.id, 'active']);
  if (!rows[0] || !(await verifyPassword(b.password, rows[0].password_hash))) {
    throw new HttpError(403, 'forbidden', 'Mot de passe incorrect');
  }
  await tx(async (t) => {
    await t.q(
      `UPDATE users SET status = 'deleted', contact = CONCAT('supprime-', id, '@invalid.local'),
         first_name = 'Compte', last_name = 'supprimé', zone = NULL, password_hash = '!' WHERE id = ?`,
      [req.user.id],
    );
    await t.q('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [req.user.id]);
  });
  await audit(req.user.id, 'account_deleted', 'user', req.user.id, req);
  res.status(204).end();
}));

// --- Annuaire public : seuls les prestataires vérifiés, actifs et non suspendus ---
// Aucun contact, pièce ou donnée personnelle n'est exposé ici.
router.get('/pros', requireAuth, requireRole('client'), asyncHandler(async (req, res) => {
  const f = schemas.proSearch.parse(req.query);
  const filters = ["pp.verification_status = 'valide'", "u.status = 'active'"];
  const params = [];
  if (f.trade) {
    filters.push('EXISTS (SELECT 1 FROM pro_trades pt WHERE pt.user_id = u.id AND pt.trade = ?)');
    params.push(f.trade);
  }
  if (f.city) { filters.push('u.city = ?'); params.push(f.city); }
  if (f.q) {
    filters.push("(u.first_name LIKE ? ESCAPE '\\\\' OR u.last_name LIKE ? ESCAPE '\\\\')");
    const like = `%${escapeLike(f.q)}%`;
    params.push(like, like);
  }
  const rows = await q(
    `SELECT u.id, u.first_name, u.last_name, u.city, pp.base_price, pp.rating_sum, pp.rating_count,
            (SELECT GROUP_CONCAT(pt.trade) FROM pro_trades pt WHERE pt.user_id = u.id) AS trades
       FROM pro_profiles pp JOIN users u ON u.id = pp.user_id
      WHERE ${filters.join(' AND ')}
      ORDER BY pp.rating_sum / GREATEST(pp.rating_count, 1) DESC, u.id
      LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, (f.page - 1) * PAGE_SIZE],
  );
  res.json({
    page: f.page,
    items: rows.map((r) => ({
      id: r.id,
      name: `${r.first_name} ${r.last_name.charAt(0)}.`,
      city: r.city,
      trades: r.trades ? r.trades.split(',') : [],
      basePrice: r.base_price,
      rating: r.rating_count ? Number((r.rating_sum / r.rating_count).toFixed(1)) : null,
      ratingCount: r.rating_count,
    })),
  });
}));

router.get('/pros/:id', requireAuth, requireRole('client'), asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const rows = await q(
    `SELECT u.id, u.first_name, u.last_name, u.city, pp.bio, pp.base_price, pp.rating_sum, pp.rating_count
       FROM pro_profiles pp JOIN users u ON u.id = pp.user_id
      WHERE u.id = ? AND pp.verification_status = 'valide' AND u.status = 'active'`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Prestataire introuvable');
  const p = rows[0];
  const trades = await q('SELECT trade FROM pro_trades WHERE user_id = ? ORDER BY trade', [id]);
  const zones = await q('SELECT zone FROM pro_zones WHERE user_id = ? ORDER BY zone', [id]);
  const reviews = await q(
    `SELECT r.rating, r.comment, r.created_at, u.first_name, u.last_name
       FROM reviews r JOIN users u ON u.id = r.client_id
      WHERE r.pro_id = ? ORDER BY r.id DESC LIMIT 20`,
    [id],
  );
  res.json({
    id: p.id,
    name: `${p.first_name} ${p.last_name.charAt(0)}.`,
    city: p.city,
    bio: p.bio || '',
    basePrice: p.base_price,
    trades: trades.map((t) => t.trade),
    zones: zones.map((z) => z.zone),
    rating: p.rating_count ? Number((p.rating_sum / p.rating_count).toFixed(1)) : null,
    ratingCount: p.rating_count,
    reviews: reviews.map((r) => ({ rating: r.rating, comment: r.comment, author: `${r.first_name} ${r.last_name.charAt(0)}.`, date: r.created_at })),
  });
}));

module.exports = router;
