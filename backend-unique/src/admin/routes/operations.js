'use strict';
// Opérations : demandes (distribution), réservations (annulation), litiges, remboursements
const express = require('express');
const { q, tx } = require('../../db');
const config = require('../../config');
const { schemas, idParam } = require('../validation');
const { HttpError, asyncHandler } = require('../../errors');
const { requireAdmin } = require('../security/middleware');
const { pickPros } = require('../../domain/distribution');
const { audit } = require('../../services/audit');
const { notifyUser } = require('../../services/notify');

const router = express.Router();
router.use(requireAdmin);

const PAID = ['payee', 'en_cours', 'fin_signalee', 'terminee'];
const CANCELLABLE = ['attente', 'demande_devis', 'devis_propose', 'a_payer', 'payee', 'en_cours'];

router.get('/requests', asyncHandler(async (req, res) => {
  const status = ['nouvelle', 'distribuee', 'proposee', 'choisie', 'annulee', 'expiree'].includes(req.query.status) ? req.query.status : 'nouvelle';
  const rows = await q(
    `SELECT r.id, r.ref, r.trade, r.title, r.description, r.address, r.zone, r.urgency, r.status, r.created_at,
            CONCAT(u.first_name, ' ', u.last_name) AS client,
            (SELECT GROUP_CONCAT(rp.pro_id) FROM request_pros rp WHERE rp.request_id = r.id) AS sent
       FROM requests r JOIN users u ON u.id = r.client_id WHERE r.status = ? ORDER BY r.created_at LIMIT 200`, [status]);
  res.json({ items: rows.map((r) => ({ id: r.id, ref: r.ref, trade: r.trade, title: r.title, description: r.description, address: r.address,
    zone: r.zone, urgency: r.urgency, status: r.status, client: r.client, sent: r.sent ? r.sent.split(',').map(Number) : [], date: r.created_at })) });
}));

// Choix des prestataires : vérifiés, actifs, disponibles, bon métier, bonne zone, les mieux notés d'abord
router.post('/requests/:id/distribute', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const [r] = await q('SELECT id, client_id, trade, zone, title, status FROM requests WHERE id = ?', [id]);
  if (!r) throw new HttpError(404, 'not_found', 'Demande introuvable');
  if (!['nouvelle', 'distribuee'].includes(r.status)) throw new HttpError(409, 'invalid_state', 'Cette demande ne peut pas être distribuée');
  const pool = await q(
    `SELECT u.id, (pp.rating_sum / GREATEST(pp.rating_count, 1)) AS rating
       FROM pro_profiles pp JOIN users u ON u.id = pp.user_id
      WHERE pp.verification_status = 'valide' AND pp.available = 1 AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM pro_trades pt WHERE pt.user_id = u.id AND pt.trade = ?)
        AND EXISTS (SELECT 1 FROM pro_zones pz WHERE pz.user_id = u.id AND pz.zone = ?)`,
    [r.trade, r.zone],
  );
  const already = (await q('SELECT pro_id FROM request_pros WHERE request_id = ?', [id])).map((x) => x.pro_id);
  const chosen = pickPros(pool.map((p) => ({ id: p.id, rating: Number(p.rating) || 0 })), already, config.distributionSize);
  if (chosen.length === 0) throw new HttpError(409, 'no_pros', 'Aucun prestataire disponible : la demande reste en file d\'attente');
  await tx(async (t) => {
    for (const proId of chosen) await t.q("INSERT INTO request_pros (request_id, pro_id, status) VALUES (?, ?, 'envoye')", [id, proId]);
    await t.q("UPDATE requests SET status = 'distribuee' WHERE id = ?", [id]);
  });
  await notifyUser(r.client_id, 'request_distributed', 'Votre demande est en cours', `« ${r.title} » a été envoyée à des prestataires.`);
  for (const proId of chosen) await notifyUser(proId, 'request_received', 'Nouvelle demande à traiter', r.title);
  await audit(req.user.id, 'request_distributed', 'request', id, req, { count: chosen.length });
  res.json({ sent: chosen.length });
}));

router.get('/bookings', asyncHandler(async (req, res) => {
  const { group } = schemas.group.parse(req.query);
  const states = { en: ['attente', 'demande_devis', 'devis_propose', 'a_payer', 'payee', 'en_cours', 'fin_signalee', 'litige'], ter: ['terminee'], ann: ['annulee', 'refusee', 'expiree'] }[group];
  const rows = await q(
    `SELECT b.id, b.ref, b.service, b.trade, b.status, b.price, b.mode, b.created_at, b.client_id, b.pro_id,
            CONCAT(cu.first_name, ' ', cu.last_name) AS client, CONCAT(pu.first_name, ' ', pu.last_name) AS pro,
            b.commission_rate,
            (SELECT p.status FROM payments p WHERE p.booking_id = b.id ORDER BY p.id DESC LIMIT 1) AS payment
       FROM bookings b JOIN users cu ON cu.id = b.client_id JOIN users pu ON pu.id = b.pro_id
      WHERE b.status IN (${states.map(() => '?').join(',')}) ORDER BY b.id DESC LIMIT 200`,
    states,
  );
  res.json({ items: rows.map((b) => ({ id: b.id, ref: b.ref, service: b.service, trade: b.trade, status: b.status, price: b.price, mode: b.mode,
    clientId: b.client_id, proId: b.pro_id, client: b.client, pro: b.pro, payment: b.payment || null, commissionRate: b.commission_rate === null ? null : Number(b.commission_rate), date: b.created_at })) });
}));

router.post('/requests/:id/cancel', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const b = schemas.motif.parse(req.body);
  const r = await q("UPDATE requests SET status = 'annulee' WHERE id = ? AND status IN ('nouvelle','distribuee','proposee')", [id]);
  if (!r.affectedRows) throw new HttpError(409, 'invalid_state', 'Cette demande ne peut plus être annulée');
  await q("UPDATE request_pros SET status = 'refuse' WHERE request_id = ? AND status IN ('envoye','propose')", [id]);
  await audit(req.user.id, 'request_cancelled_admin', 'request', id, req, { motif: b.motif });
  res.json({ id, status: 'annulee' });
}));

router.post('/bookings/:id/cancel', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const b = schemas.motif.parse(req.body);
  const bk = await tx(async (t) => {
    const [x] = await t.q('SELECT id, client_id, pro_id, status FROM bookings WHERE id = ? FOR UPDATE', [id]);
    if (!x) throw new HttpError(404, 'not_found', 'Réservation introuvable');
    if (!CANCELLABLE.includes(x.status)) throw new HttpError(409, 'invalid_state', 'Cette réservation ne peut plus être annulée');
    await t.q("UPDATE bookings SET status = 'annulee' WHERE id = ?", [id]);
    if (PAID.includes(x.status)) await t.q("UPDATE payments SET status = 'refund_pending' WHERE booking_id = ? AND status = 'success'", [id]);
    return x;
  });
  await notifyUser(bk.client_id, 'booking_cancelled', 'Réservation annulée par Ouvrage', b.motif);
  await notifyUser(bk.pro_id, 'booking_cancelled', 'Réservation annulée par Ouvrage', b.motif);
  await audit(req.user.id, 'booking_cancelled_admin', 'booking', id, req, { motif: b.motif });
  res.json({ id, status: 'annulee' });
}));

router.post('/payments/:bookingId/refunded', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.bookingId);
  const r = await q("UPDATE payments SET status = 'refunded' WHERE booking_id = ? AND status = 'refund_pending'", [id]);
  if (!r.affectedRows) throw new HttpError(409, 'invalid_state', 'Aucun remboursement en attente pour cette réservation');
  await audit(req.user.id, 'refund_done', 'booking', id, req);
  res.json({ id, refunded: true });
}));

router.get('/disputes', asyncHandler(async (req, res) => {
  const status = req.query.status === 'resolu' ? 'resolu' : 'ouvert';
  const rows = await q(
    `SELECT d.id, d.booking_id, d.type, d.description, d.status, d.decision, d.created_at, b.ref, b.status AS booking_status, b.client_id, b.pro_id,
            CONCAT(cu.first_name, ' ', cu.last_name) AS client, CONCAT(pu.first_name, ' ', pu.last_name) AS pro
       FROM disputes d JOIN bookings b ON b.id = d.booking_id JOIN users cu ON cu.id = b.client_id JOIN users pu ON pu.id = b.pro_id
      WHERE d.status = ? ORDER BY d.id LIMIT 200`, [status]);
  res.json({ items: rows.map((d) => ({ id: d.id, bookingId: d.booking_id, ref: d.ref, type: d.type, description: d.description, status: d.status,
    decision: d.decision, bookingStatus: d.booking_status, client: d.client, pro: d.pro, date: d.created_at })) });
}));

// Décision motivée : remboursement du client, ou prestation confirmée (le prestataire est crédité)
router.post('/disputes/:id/decide', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const b = schemas.dispute.parse(req.body);
  const info = await tx(async (t) => {
    const [d] = await t.q("SELECT id, booking_id FROM disputes WHERE id = ? AND status = 'ouvert' FOR UPDATE", [id]);
    if (!d) throw new HttpError(404, 'not_found', 'Litige introuvable ou déjà tranché');
    const [bk] = await t.q('SELECT id, client_id, pro_id, status FROM bookings WHERE id = ? FOR UPDATE', [d.booking_id]);
    if (b.decision === 'client') {
      if (!['litige', 'fin_signalee', 'en_cours', 'payee'].includes(bk.status)) throw new HttpError(409, 'invalid_state', 'État incompatible avec un remboursement');
      await t.q("UPDATE bookings SET status = 'annulee' WHERE id = ?", [bk.id]);
      if (PAID.includes(bk.status)) await t.q("UPDATE payments SET status = 'refund_pending' WHERE booking_id = ? AND status = 'success'", [bk.id]);
    } else {
      if (bk.status !== 'fin_signalee' && bk.status !== 'litige') throw new HttpError(409, 'invalid_state', 'La prestation doit être signalée terminée');
      await t.q("UPDATE bookings SET status = 'terminee' WHERE id = ?", [bk.id]);
    }
    await t.q("UPDATE disputes SET status = 'resolu', decision = ? WHERE id = ?", [b.decision === 'client' ? 'client' : 'pro', id]);
    return bk;
  });
  await notifyUser(info.client_id, 'dispute_decided', 'Litige tranché', b.motif);
  await notifyUser(info.pro_id, 'dispute_decided', 'Litige tranché', b.motif);
  await audit(req.user.id, 'dispute_decided', 'dispute', id, req, { decision: b.decision });
  res.json({ id, decision: b.decision });
}));

module.exports = router;
