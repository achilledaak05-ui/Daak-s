'use strict';
// Favoris du client : prestataires vérifiés enregistrés pour y revenir plus tard.
const express = require('express');
const { q } = require('../../db');
const { idParam } = require('../validation');
const { HttpError, asyncHandler } = require('../../errors');
const { requireAuth, requireRole } = require('../security/middleware');

const router = express.Router();
router.use(requireAuth, requireRole('client'));

router.get('/', asyncHandler(async (req, res) => {
  const rows = await q(
    `SELECT u.id, u.first_name, u.last_name, u.city, pp.base_price, pp.rating_sum, pp.rating_count,
            (SELECT GROUP_CONCAT(pt.trade) FROM pro_trades pt WHERE pt.user_id = u.id) AS trades
       FROM favorites f
       JOIN pro_profiles pp ON pp.user_id = f.pro_id
       JOIN users u ON u.id = f.pro_id
      WHERE f.user_id = ? AND pp.verification_status = 'valide' AND u.status = 'active'
      ORDER BY f.created_at DESC`,
    [req.user.id],
  );
  res.json({
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

router.post('/', asyncHandler(async (req, res) => {
  const proId = idParam.parse(String((req.body || {}).proId));
  const [ok] = await q(
    `SELECT 1 FROM pro_profiles pp JOIN users u ON u.id = pp.user_id
      WHERE pp.user_id = ? AND pp.verification_status = 'valide' AND u.status = 'active'`,
    [proId],
  );
  if (!ok) throw new HttpError(404, 'not_found', 'Prestataire introuvable');
  await q('INSERT IGNORE INTO favorites (user_id, pro_id) VALUES (?, ?)', [req.user.id, proId]);
  res.status(201).json({ ok: true });
}));

router.delete('/:proId', asyncHandler(async (req, res) => {
  const proId = idParam.parse(req.params.proId);
  await q('DELETE FROM favorites WHERE user_id = ? AND pro_id = ?', [req.user.id, proId]);
  res.status(204).end();
}));

module.exports = router;
