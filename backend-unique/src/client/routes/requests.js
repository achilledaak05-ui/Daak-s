'use strict';
// Demandes du client : il décrit son besoin, l'administration envoie les prestataires adaptés,
// le client choisit une offre, ce qui crée la réservation.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { q, tx } = require('../../db');
const { schemas, idParam } = require('../validation');
const { HttpError, asyncHandler } = require('../../errors');
const { requireAuth, requireRole } = require('../security/middleware');
const { commissionFor } = require('../../domain/pricing');
const { audit } = require('../../services/audit');
const { notifyUser } = require('../../services/notify');

const router = express.Router();
router.use(requireAuth, requireRole('client'));

const createLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Trop de demandes, réessayez plus tard' } } });

const OPEN = ['nouvelle', 'distribuee', 'proposee'];

async function loadOwned(t, id, clientId, lock = false) {
  const rows = await t.q(`SELECT * FROM requests WHERE id = ? AND client_id = ?${lock ? ' FOR UPDATE' : ''}`, [id, clientId]);
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Demande introuvable');
  return rows[0];
}

function present(r) {
  return {
    id: r.id, ref: r.ref, trade: r.trade, title: r.title, description: r.description,
    address: r.address, zone: r.zone, urgency: r.urgency, desiredAt: r.desired_at,
    status: r.status, createdAt: r.created_at,
  };
}

router.post('/', createLimiter, asyncHandler(async (req, res) => {
  const b = schemas.createRequest.parse(req.body);
  const id = await tx(async (t) => {
    const r = await t.q(
      `INSERT INTO requests (client_id, trade, title, description, address, zone, urgency, desired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, b.trade, b.title, b.description, b.address, b.zone, b.urgency,
        b.desiredAt ? new Date(b.desiredAt) : null],
    );
    await t.q("UPDATE requests SET ref = CONCAT('DEM-', id) WHERE id = ?", [r.insertId]);
    return r.insertId;
  });
  await audit(req.user.id, 'request_created', 'request', id, req, { trade: b.trade });
  const [created] = await q('SELECT * FROM requests WHERE id = ?', [id]);
  res.status(201).json(present(created));
}));

router.get('/', asyncHandler(async (req, res) => {
  const rows = await q('SELECT * FROM requests WHERE client_id = ? ORDER BY created_at DESC LIMIT 100', [req.user.id]);
  res.json({ items: rows.map(present) });
}));

// Détail : offres reçues. Aucune coordonnée de prestataire n'est exposée avant le choix.
router.get('/:id', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const [r] = await q('SELECT * FROM requests WHERE id = ? AND client_id = ?', [id, req.user.id]);
  if (!r) throw new HttpError(404, 'not_found', 'Demande introuvable');
  const offers = await q(
    `SELECT rp.pro_id, rp.price, rp.message, rp.status, u.first_name, u.last_name, pp.rating_sum, pp.rating_count
       FROM request_pros rp JOIN users u ON u.id = rp.pro_id JOIN pro_profiles pp ON pp.user_id = rp.pro_id
      WHERE rp.request_id = ? AND rp.status IN ('propose','accepte') ORDER BY rp.price`,
    [id],
  );
  res.json({
    ...present(r),
    offers: offers.map((o) => ({
      proId: o.pro_id,
      name: `${o.first_name} ${o.last_name.charAt(0)}.`,
      price: o.price,
      message: o.message,
      rating: o.rating_count ? Number((o.rating_sum / o.rating_count).toFixed(1)) : null,
      status: o.status,
    })),
  });
}));

router.post('/:id/cancel', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  await tx(async (t) => {
    const r = await loadOwned(t, id, req.user.id, true);
    if (!OPEN.includes(r.status)) throw new HttpError(409, 'invalid_state', 'Cette demande ne peut plus être annulée');
    await t.q("UPDATE requests SET status = 'annulee' WHERE id = ?", [id]);
    await t.q("UPDATE request_pros SET status = 'refuse' WHERE request_id = ? AND status IN ('envoye','propose')", [id]);
  });
  await audit(req.user.id, 'request_cancelled', 'request', id, req);
  res.status(204).end();
}));

// Choix d'une offre : crée la réservation avec le prix proposé ; le taux de commission est figé à ce moment
router.post('/:id/choose', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const b = schemas.chooseProposal.parse(req.body);
  const bookingId = await tx(async (t) => {
    const r = await loadOwned(t, id, req.user.id, true);
    if (r.status !== 'proposee') throw new HttpError(409, 'invalid_state', 'Aucune offre à choisir');
    const [offer] = await t.q(
      "SELECT pro_id, price FROM request_pros WHERE request_id = ? AND pro_id = ? AND status = 'propose' FOR UPDATE",
      [id, b.proId],
    );
    if (!offer || offer.price === null) throw new HttpError(404, 'not_found', 'Offre introuvable');
    const rateRows = await t.q('SELECT rate FROM commission_rates WHERE trade = ?', [r.trade]);
    const rate = rateRows[0] ? rateRows[0].rate : 15;
    commissionFor(offer.price, rate);
    const ins = await t.q(
      `INSERT INTO bookings (client_id, pro_id, request_id, trade, service, mode, status, address, description,
                             scheduled_at, price, commission_rate)
       VALUES (?, ?, ?, ?, ?, 'devis', 'a_payer', ?, ?, ?, ?, ?)`,
      [req.user.id, offer.pro_id, id, r.trade, r.title, r.address, r.description,
        r.desired_at, offer.price, rate],
    );
    await t.q("UPDATE bookings SET ref = CONCAT('DEV-', id) WHERE id = ?", [ins.insertId]);
    await t.q("UPDATE request_pros SET status = 'accepte' WHERE request_id = ? AND pro_id = ?", [id, offer.pro_id]);
    await t.q("UPDATE request_pros SET status = 'refuse' WHERE request_id = ? AND pro_id <> ? AND status IN ('envoye','propose')", [id, offer.pro_id]);
    await t.q("UPDATE requests SET status = 'choisie' WHERE id = ?", [id]);
    return ins.insertId;
  });
  await audit(req.user.id, 'request_offer_chosen', 'booking', bookingId, req, { request: id });
  const [chosen] = await q('SELECT pro_id FROM request_pros WHERE request_id = ? AND status = \'accepte\'', [id]);
  if (chosen) await notifyUser(chosen.pro_id, 'offer_chosen', 'Votre offre a été choisie', 'Le client a accepté votre prix : réservation à confirmer.');
  res.status(201).json({ bookingId });
}));

module.exports = router;
