'use strict';
// Réservations du prestataire : accepter ou refuser, démarrer, signaler la fin, échanger avec le client.
const express = require('express');
const { q, tx } = require('../../db');
const { idParam, schemas } = require('../validation');
const { HttpError, asyncHandler } = require('../../errors');
const { requireAuth, requireRole } = require('../security/middleware');
const { requireVerified } = require('../security/verified');
const { GROUPS, proNext } = require('../domain/bookingStates');
const { commissionFor } = require('../../domain/pricing');
const { audit } = require('../../services/audit');
const { notifyUser } = require('../../services/notify');

const router = express.Router();
router.use(requireAuth, requireRole('pro'), requireVerified);

const COLS = `b.id, b.ref, b.mode, b.service, b.trade, b.status, b.address, b.description, b.scheduled_at,
  b.price, b.commission_rate, b.created_at, b.client_id, cu.first_name AS client_first, cu.last_name AS client_last, cu.city AS client_city`;

const present = (r) => ({
  id: r.id, ref: r.ref, mode: r.mode, service: r.service, trade: r.trade, status: r.status,
  address: r.address, description: r.description, scheduledAt: r.scheduled_at, price: r.price,
  commissionRate: r.commission_rate === null ? null : Number(r.commission_rate),
  createdAt: r.created_at, clientName: `${r.client_first} ${r.client_last.charAt(0)}.`, clientCity: r.client_city,
});

router.get('/', asyncHandler(async (req, res) => {
  const { group } = schemas.bookingGroup.parse(req.query);
  const states = GROUPS[group];
  const rows = await q(
    `SELECT ${COLS} FROM bookings b JOIN users cu ON cu.id = b.client_id
      WHERE b.pro_id = ? AND b.status IN (${states.map(() => '?').join(',')}) ORDER BY b.created_at DESC LIMIT 100`,
    [req.user.id, ...states],
  );
  res.json({ items: rows.map(present) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const [r] = await q(`SELECT ${COLS} FROM bookings b JOIN users cu ON cu.id = b.client_id WHERE b.id = ? AND b.pro_id = ?`, [id, req.user.id]);
  if (!r) throw new HttpError(404, 'not_found', 'Réservation introuvable');
  res.json(present(r));
}));

// Action du prestataire : seulement si la machine d'états l'autorise
function action(name, notifyTitle) {
  return asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const result = await tx(async (t) => {
      const [b] = await t.q('SELECT id, client_id, status, trade, price FROM bookings WHERE id = ? AND pro_id = ? FOR UPDATE', [id, req.user.id]);
      if (!b) throw new HttpError(404, 'not_found', 'Réservation introuvable');
      const next = proNext(b.status, name);
      if (!next) throw new HttpError(409, 'invalid_transition', 'Action impossible dans l\'état actuel');
      if (name === 'accept') {
        if (b.price === null) throw new HttpError(409, 'no_price', 'Aucun prix défini');
        const [rate] = await t.q('SELECT rate FROM commission_rates WHERE trade = ?', [b.trade]);
        const r = rate ? rate.rate : 15;
        commissionFor(b.price, r); // vérifie les bornes avant d'écrire
        await t.q('UPDATE bookings SET status = ?, commission_rate = ? WHERE id = ?', [next, r, id]);
      } else {
        await t.q('UPDATE bookings SET status = ? WHERE id = ?', [next, id]);
      }
      return { client: b.client_id, next };
    });
    if (notifyTitle) await notifyUser(result.client, `booking_${name}`, notifyTitle, '');
    await audit(req.user.id, `booking_pro_${name}`, 'booking', id, req, { to: result.next });
    res.json({ id, status: result.next });
  });
}

router.post('/:id/accept', action('accept', 'Votre réservation est acceptée : à payer'));
router.post('/:id/decline', action('decline', 'Votre réservation a été refusée'));
router.post('/:id/start', action('start', 'Le prestataire a commencé les travaux'));
router.post('/:id/finish', action('finish', 'Confirmez la fin des travaux'));

router.get('/:id/messages', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const [own] = await q('SELECT id FROM bookings WHERE id = ? AND pro_id = ?', [id, req.user.id]);
  if (!own) throw new HttpError(404, 'not_found', 'Réservation introuvable');
  const rows = await q('SELECT id, sender_id, body, created_at FROM messages WHERE booking_id = ? ORDER BY id DESC LIMIT 100', [id]);
  res.json({ items: rows.reverse().map((m) => ({ id: m.id, mine: m.sender_id === req.user.id, body: m.body, date: m.created_at })) });
}));

router.post('/:id/messages', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const b = schemas.message.parse(req.body);
  const [own] = await q('SELECT id FROM bookings WHERE id = ? AND pro_id = ?', [id, req.user.id]);
  if (!own) throw new HttpError(404, 'not_found', 'Réservation introuvable');
  await q('INSERT INTO messages (booking_id, sender_id, body) VALUES (?, ?, ?)', [id, req.user.id, b.body]);
  res.status(201).json({ ok: true });
}));

module.exports = router;
