'use strict';
// Demandes reçues de l'administration : le prestataire fait une offre (prix) ou la décline.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { q, tx } = require('../../db');
const { schemas, idParam } = require('../validation');
const { HttpError, asyncHandler } = require('../../errors');
const { requireAuth, requireRole } = require('../security/middleware');
const { requireVerified } = require('../security/verified');
const { audit } = require('../../services/audit');
const { notifyUser } = require('../../services/notify');

const router = express.Router();
router.use(requireAuth, requireRole('pro'), requireVerified);
const offerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Trop d\'offres envoyées, réessayez plus tard' } } });

// Le nom du client n'est jamais montré avant la réservation ; l'adresse seulement une fois l'offre acceptée
router.get('/received', asyncHandler(async (req, res) => {
  const rows = await q(
    `SELECT r.id, r.ref, r.trade, r.title, r.description, r.zone, r.urgency, r.desired_at, r.status AS request_status,
            r.address, rp.status AS my_status, rp.price, rp.message, r.created_at
       FROM request_pros rp JOIN requests r ON r.id = rp.request_id
      WHERE rp.pro_id = ? AND rp.status IN ('envoye','propose','accepte')
      ORDER BY r.created_at DESC LIMIT 100`,
    [req.user.id],
  );
  res.json({
    items: rows.map((r) => ({
      id: r.id, ref: r.ref, trade: r.trade, title: r.title, description: r.description, zone: r.zone,
      urgency: r.urgency, desiredAt: r.desired_at, myStatus: r.my_status, price: r.price, message: r.message,
      address: r.my_status === 'accepte' ? r.address : null,
      createdAt: r.created_at,
    })),
  });
}));

router.post('/:id/offer', offerLimiter, asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const b = schemas.offer.parse(req.body);
  const owner = await tx(async (t) => {
    const [r] = await t.q('SELECT id, client_id, title, status FROM requests WHERE id = ? FOR UPDATE', [id]);
    if (!r) throw new HttpError(404, 'not_found', 'Demande introuvable');
    if (!['distribuee', 'proposee'].includes(r.status)) throw new HttpError(409, 'invalid_state', 'Cette demande n\'accepte plus d\'offres');
    const [rp] = await t.q('SELECT status FROM request_pros WHERE request_id = ? AND pro_id = ? FOR UPDATE', [id, req.user.id]);
    if (!rp || !['envoye', 'propose'].includes(rp.status)) throw new HttpError(404, 'not_found', 'Demande introuvable');
    await t.q("UPDATE request_pros SET status = 'propose', price = ?, message = ? WHERE request_id = ? AND pro_id = ?",
      [b.price, b.message || null, id, req.user.id]);
    await t.q("UPDATE requests SET status = 'proposee' WHERE id = ?", [id]);
    return r;
  });
  await notifyUser(owner.client_id, 'offer_received', 'Nouvelle offre reçue', `« ${owner.title} » : ${b.price} FCFA proposés.`);
  await audit(req.user.id, 'request_offer', 'request', id, req, { price: b.price });
  res.status(201).json({ ok: true });
}));

router.post('/:id/decline', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const result = await q(
    "UPDATE request_pros SET status = 'refuse' WHERE request_id = ? AND pro_id = ? AND status IN ('envoye','propose')",
    [id, req.user.id],
  );
  if (!result.affectedRows) throw new HttpError(404, 'not_found', 'Demande introuvable');
  await audit(req.user.id, 'request_declined', 'request', id, req);
  res.status(204).end();
}));

module.exports = router;
