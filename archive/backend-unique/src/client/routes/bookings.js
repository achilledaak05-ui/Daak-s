'use strict';
// Réservations du client : création, suivi, actions autorisées par la machine d'états, avis et messages.
// Règle générale : toute requête est filtrée sur client_id = utilisateur connecté (pas d'accès par simple identifiant).
const express = require('express');
const rateLimit = require('express-rate-limit');
const { q, tx } = require('../../db');
const { schemas, idParam } = require('../validation');
const { HttpError, asyncHandler } = require('../../errors');
const { requireAuth, requireRole } = require('../security/middleware');
const { GROUPS, clientNext, canCancel } = require('../domain/bookingStates');
const { commissionFor } = require('../../domain/pricing');
const { audit } = require('../../services/audit');
const { notifyUser } = require('../../services/notify');
const { initiatePayment } = require('../services/paymentProvider');
const crypto = require('node:crypto');

const router = express.Router();
router.use(requireAuth, requireRole('client'));

const createLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Trop de demandes, réessayez plus tard' } } });
const messageLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Trop de messages, patientez un instant' } } });

// Charge une réservation appartenant au client connecté, verrouillée si `lock` est vrai
async function loadOwned(t, id, clientId, lock = false) {
  const rows = await t.q(
    `SELECT * FROM bookings WHERE id = ? AND client_id = ?${lock ? ' FOR UPDATE' : ''}`,
    [id, clientId],
  );
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Réservation introuvable');
  return rows[0];
}

const BOOKING_COLUMNS = `b.id, b.ref, b.trade, b.service, b.mode, b.status, b.address, b.description,
  b.scheduled_at, b.price, b.created_at, b.updated_at, b.pro_id, pu.first_name AS pro_first, pu.last_name AS pro_last`;

function present(r) {
  return {
    id: r.id,
    ref: r.ref,
    trade: r.trade,
    service: r.service,
    mode: r.mode,
    status: r.status,
    address: r.address,
    description: r.description,
    scheduledAt: r.scheduled_at,
    price: r.price, // null tant que le prix n'est pas fixé
    proId: r.pro_id,
    proName: `${r.pro_first} ${r.pro_last.charAt(0)}.`,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Création : le prix immédiat vient du profil du prestataire, jamais du client
router.post('/', createLimiter, asyncHandler(async (req, res) => {
  const b = schemas.createBooking.parse(req.body);
  const pros = await q(
    `SELECT pp.base_price FROM pro_profiles pp JOIN users u ON u.id = pp.user_id
      WHERE pp.user_id = ? AND pp.verification_status = 'valide' AND pp.available = 1 AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM pro_trades pt WHERE pt.user_id = pp.user_id AND pt.trade = ?)`,
    [b.proId, b.trade],
  );
  if (!pros[0]) throw new HttpError(404, 'not_found', 'Prestataire indisponible pour ce métier');
  const price = b.mode === 'immediat' ? pros[0].base_price : null;
  const status = b.mode === 'devis' ? 'demande_devis' : 'attente';
  const id = await tx(async (t) => {
    const r = await t.q(
      `INSERT INTO bookings (client_id, pro_id, trade, service, mode, status, address, description, scheduled_at, price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, b.proId, b.trade, b.service, b.mode, status, b.address, b.description,
        b.scheduledAt ? new Date(b.scheduledAt) : null, price],
    );
    await t.q(
      "UPDATE bookings SET ref = CONCAT(IF(mode = 'devis', 'DEV', 'RES'), '-', id) WHERE id = ?",
      [r.insertId],
    );
    return r.insertId;
  });
  await audit(req.user.id, 'booking_created', 'booking', id, req, { mode: b.mode });
  await notifyUser(b.proId, 'booking_new', 'Nouvelle demande de réservation', `${b.service} : ${b.address}`);
  const [created] = await q(
    `SELECT ${BOOKING_COLUMNS} FROM bookings b JOIN users pu ON pu.id = b.pro_id WHERE b.id = ?`,
    [id],
  );
  res.status(201).json(present(created));
}));

router.get('/', asyncHandler(async (req, res) => {
  const { group } = schemas.bookingGroup.parse(req.query);
  const states = GROUPS[group];
  const rows = await q(
    `SELECT ${BOOKING_COLUMNS} FROM bookings b JOIN users pu ON pu.id = b.pro_id
      WHERE b.client_id = ? AND b.status IN (${states.map(() => '?').join(',')})
      ORDER BY b.created_at DESC LIMIT 100`,
    [req.user.id, ...states],
  );
  res.json({ items: rows.map(present) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const rows = await q(
    `SELECT ${BOOKING_COLUMNS} FROM bookings b JOIN users pu ON pu.id = b.pro_id
      WHERE b.id = ? AND b.client_id = ?`,
    [id, req.user.id],
  );
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Réservation introuvable');
  res.json(present(rows[0]));
}));

// Actions du client : chaque action n'est acceptée que si la machine d'états l'autorise
async function applyAction(req, res, action, extra = {}) {
  const id = idParam.parse(req.params.id);
  const result = await tx(async (t) => {
    const bk = await loadOwned(t, id, req.user.id, true);
    const next = clientNext(bk.status, action);
    if (!next) throw new HttpError(409, 'invalid_transition', 'Action impossible dans l\'état actuel');
    let commissionRate = bk.commission_rate;
    if (action === 'accept') {
      if (bk.price === null) throw new HttpError(409, 'no_price', 'Aucun prix proposé');
      // Le taux de commission est figé à l'acceptation du prix
      const rateRows = await t.q('SELECT rate FROM commission_rates WHERE trade = ?', [bk.trade]);
      commissionRate = rateRows[0] ? rateRows[0].rate : 15;
      commissionFor(bk.price, commissionRate);
      await t.q('UPDATE bookings SET status = ?, commission_rate = ? WHERE id = ?', [next, commissionRate, id]);
    } else {
      await t.q('UPDATE bookings SET status = ? WHERE id = ?', [next, id]);
    }
    if (action === 'dispute') {
      await t.q('INSERT INTO disputes (booking_id, opened_by, type, description) VALUES (?, ?, ?, ?)',
        [id, req.user.id, extra.type, extra.description]);
    }
    if (action === 'cancel' && bk.status === 'payee') {
      // Paiement déjà reçu : le remboursement est à traiter par l'administration
      await t.q("UPDATE payments SET status = 'refund_pending' WHERE booking_id = ? AND status = 'success'", [id]);
    }
    return { next, previous: bk.status };
  });
  await audit(req.user.id, `booking_${action}`, 'booking', id, req, { from: result.previous, to: result.next, reason: extra.reason });
  return res.json({ id, status: result.next });
}

router.post('/:id/cancel', asyncHandler(async (req, res) => {
  const b = schemas.reason.parse(req.body);
  return applyAction(req, res, 'cancel', { reason: b.reason });
}));
router.post('/:id/accept-quote', asyncHandler((req, res) => applyAction(req, res, 'accept')));
router.post('/:id/refuse-quote', asyncHandler((req, res) => applyAction(req, res, 'refuse')));
router.post('/:id/confirm', asyncHandler((req, res) => applyAction(req, res, 'confirm')));
router.post('/:id/dispute', asyncHandler(async (req, res) => {
  const b = schemas.dispute.parse(req.body);
  return applyAction(req, res, 'dispute', b);
}));

// Avis : une seule fois, après une prestation terminée ; met à jour la note du prestataire
router.post('/:id/review', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const b = schemas.review.parse(req.body);
  await tx(async (t) => {
    const bk = await loadOwned(t, id, req.user.id, true);
    if (bk.status !== 'terminee') throw new HttpError(409, 'invalid_state', 'Un avis n\'est possible qu\'après la prestation');
    const existing = await t.q('SELECT id FROM reviews WHERE booking_id = ?', [id]);
    if (existing[0]) throw new HttpError(409, 'already_reviewed', 'Vous avez déjà laissé un avis');
    await t.q('INSERT INTO reviews (booking_id, client_id, pro_id, rating, comment) VALUES (?, ?, ?, ?, ?)',
      [id, req.user.id, bk.pro_id, b.rating, b.comment]);
    await t.q('UPDATE pro_profiles SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE user_id = ?',
      [b.rating, bk.pro_id]);
  });
  await audit(req.user.id, 'review_created', 'booking', id, req);
  res.status(201).json({ ok: true });
}));

// Paiement : le serveur crée la demande de paiement. Le statut n'est JAMAIS marqué payé par le client.
router.post('/:id/payments', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const b = schemas.initiatePayment.parse(req.body);
  const payment = await tx(async (t) => {
    const bk = await loadOwned(t, id, req.user.id, true);
    if (bk.status !== 'a_payer') throw new HttpError(409, 'invalid_state', 'Cette réservation n\'est pas à payer');
    if (bk.price === null || bk.commission_rate === null) throw new HttpError(409, 'no_price', 'Prix non confirmé');
    const done = await t.q("SELECT id FROM payments WHERE booking_id = ? AND status = 'success'", [id]);
    if (done[0]) throw new HttpError(409, 'already_paid', 'Cette réservation est déjà payée');
    const pending = await t.q("SELECT id, reference, method, amount FROM payments WHERE booking_id = ? AND status = 'pending'", [id]);
    if (pending[0]) return pending[0];
    const reference = crypto.randomBytes(16).toString('hex');
    const r = await t.q('INSERT INTO payments (booking_id, amount, method, reference) VALUES (?, ?, ?, ?)',
      [id, bk.price, b.method, reference]);
    return { id: r.insertId, reference, method: b.method, amount: bk.price };
  });
  // Lève une erreur 503 tant que le prestataire de paiement n'est pas branché
  await initiatePayment({ reference: payment.reference, amount: payment.amount, method: payment.method });
  res.status(201).json({ paymentId: payment.id, reference: payment.reference, status: 'pending' });
}));

// Messages liés à la réservation (client et prestataire concerné uniquement)
router.get('/:id/messages', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  await loadOwned({ q }, id, req.user.id);
  const rows = await q(
    'SELECT id, sender_id, body, created_at FROM messages WHERE booking_id = ? ORDER BY id DESC LIMIT 100',
    [id],
  );
  res.json({ items: rows.reverse().map((m) => ({ id: m.id, mine: m.sender_id === req.user.id, body: m.body, date: m.created_at })) });
}));

router.post('/:id/messages', messageLimiter, asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const b = schemas.message.parse(req.body);
  await loadOwned({ q }, id, req.user.id);
  await q('INSERT INTO messages (booking_id, sender_id, body) VALUES (?, ?, ?)', [id, req.user.id, b.body]);
  res.status(201).json({ ok: true });
}));

module.exports = router;
