'use strict';
// Finances : taux de commission par catégorie, retraits des prestataires, support clients
const express = require('express');
const { q, tx } = require('../../db');
const config = require('../../config');
const { schemas, idParam } = require('../validation');
const { HttpError, asyncHandler } = require('../../errors');
const { requireAdmin } = require('../security/middleware');
const { checkWithdrawal } = require('../../domain/wallet');
const { audit } = require('../../services/audit');
const { notifyUser } = require('../../services/notify');

const router = express.Router();
router.use(requireAdmin);

// Taux figé par réservation à l'acceptation : une modification ne touche jamais les missions déjà conclues
router.get('/rates', asyncHandler(async (req, res) => {
  const rows = await q('SELECT trade, rate, updated_at FROM commission_rates ORDER BY trade');
  res.json({ items: rows.map((r) => ({ trade: r.trade, rate: Number(r.rate), updated: r.updated_at })) });
}));

router.put('/rates', asyncHandler(async (req, res) => {
  const b = schemas.rates.parse(req.body);
  const changes = await tx(async (t) => {
    const out = [];
    for (const r of b.rates) {
      const [old] = await t.q('SELECT rate FROM commission_rates WHERE trade = ? FOR UPDATE', [r.trade]);
      const before = old ? Number(old.rate) : null;
      if (before === r.rate) continue;
      await t.q('INSERT INTO commission_rates (trade, rate) VALUES (?, ?) ON DUPLICATE KEY UPDATE rate = VALUES(rate)', [r.trade, r.rate]);
      out.push({ trade: r.trade, from: before, to: r.rate });
    }
    return out;
  });
  for (const c of changes) await audit(req.user.id, 'rate_changed', 'commission', c.trade, req, { from: c.from, to: c.to });
  res.json({ changed: changes.length });
}));

// Retraits : demande -> en cours de virement -> viré, ou rejeté avec motif
async function availableOf(t, proId) {
  const [c] = await t.q(`SELECT COALESCE(SUM(b.price - ROUND(COALESCE(b.price,0) * COALESCE(b.commission_rate,15) / 100)),0) AS net
                           FROM bookings b WHERE b.pro_id = ? AND b.status = 'terminee'`, [proId]);
  const [w] = await t.q("SELECT COALESCE(SUM(montant),0) AS n FROM withdrawals WHERE user_id = ? AND status IN ('en_cours','verse')", [proId]);
  return Number(c.net) - Number(w.n);
}

router.get('/withdrawals', asyncHandler(async (req, res) => {
  const status = ['demande', 'en_cours', 'verse', 'rejete'].includes(req.query.status) ? req.query.status : 'demande';
  const rows = await q(
    `SELECT w.id, w.ref, w.montant, w.moyen, w.numero, w.status, w.motif, w.created_at, u.first_name, u.last_name, u.id AS user_id
       FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status = ? ORDER BY w.id LIMIT 200`, [status]);
  res.json({ items: rows.map((w) => ({ id: w.id, ref: w.ref, amount: w.montant, method: w.moyen, number: w.numero, status: w.status,
    reason: w.motif, pro: `${w.first_name} ${w.last_name}`, proId: w.user_id, date: w.created_at })) });
}));

router.post('/withdrawals/:id/start', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const w = await tx(async (t) => {
    const [x] = await t.q("SELECT id, user_id, montant FROM withdrawals WHERE id = ? AND status = 'demande' FOR UPDATE", [id]);
    if (!x) throw new HttpError(409, 'invalid_state', 'Ce retrait ne peut pas être lancé');
    const available = await availableOf(t, x.user_id);
    checkWithdrawal({ amount: Number(x.montant), available, minimum: 0 });
    await t.q("UPDATE withdrawals SET status = 'en_cours' WHERE id = ?", [id]);
    return x;
  });
  await notifyUser(w.user_id, 'withdrawal_started', 'Retrait en cours de virement', `${w.montant} FCFA`);
  await audit(req.user.id, 'withdrawal_started', 'withdrawal', id, req);
  res.json({ id, status: 'en_cours' });
}));

router.post('/withdrawals/:id/paid', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const [x] = await q("SELECT user_id, montant FROM withdrawals WHERE id = ? AND status = 'en_cours'", [id]);
  if (!x) throw new HttpError(409, 'invalid_state', 'Ce retrait n\'est pas en cours de virement');
  await q("UPDATE withdrawals SET status = 'verse' WHERE id = ?", [id]);
  await notifyUser(x.user_id, 'withdrawal_paid', 'Retrait viré', `${x.montant} FCFA ont été envoyés.`);
  await audit(req.user.id, 'withdrawal_paid', 'withdrawal', id, req);
  res.json({ id, status: 'verse' });
}));

router.post('/withdrawals/:id/reject', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const b = schemas.motif.parse(req.body);
  const [x] = await q("SELECT user_id FROM withdrawals WHERE id = ? AND status IN ('demande','en_cours')", [id]);
  if (!x) throw new HttpError(409, 'invalid_state', 'Ce retrait ne peut pas être rejeté');
  await q("UPDATE withdrawals SET status = 'rejete', motif = ? WHERE id = ?", [b.motif, id]);
  await notifyUser(x.user_id, 'withdrawal_rejected', 'Retrait refusé', b.motif);
  await audit(req.user.id, 'withdrawal_rejected', 'withdrawal', id, req, { motif: b.motif });
  res.json({ id, status: 'rejete' });
}));

// Support : liste des clients ayant écrit, avec le dernier message
router.get('/support', asyncHandler(async (req, res) => {
  const rows = await q(
    `SELECT u.id, CONCAT(u.first_name, ' ', u.last_name) AS name,
            (SELECT body FROM support_messages s WHERE s.user_id = u.id ORDER BY s.id DESC LIMIT 1) AS last,
            (SELECT MAX(created_at) FROM support_messages s WHERE s.user_id = u.id) AS last_at
       FROM users u WHERE u.id IN (SELECT DISTINCT user_id FROM support_messages) ORDER BY last_at DESC LIMIT 200`);
  res.json({ items: rows.map((r) => ({ id: r.id, name: r.name, last: r.last, date: r.last_at })) });
}));

// Support : lire le fil d'un client et répondre
router.get('/support/:userId', asyncHandler(async (req, res) => {
  const userId = idParam.parse(req.params.userId);
  const rows = await q('SELECT id, sender, body, created_at FROM support_messages WHERE user_id = ? ORDER BY id DESC LIMIT 100', [userId]);
  res.json({ items: rows.reverse().map((m) => ({ id: m.id, sender: m.sender, body: m.body, date: m.created_at })) });
}));

router.post('/support/:userId/messages', asyncHandler(async (req, res) => {
  const userId = idParam.parse(req.params.userId);
  const b = schemas.message.parse(req.body);
  const [client] = await q("SELECT id FROM users WHERE id = ? AND role = 'client'", [userId]);
  if (!client) throw new HttpError(404, 'not_found', 'Client introuvable');
  await q("INSERT INTO support_messages (user_id, sender, body) VALUES (?, 'support', ?)", [userId, b.body]);
  await notifyUser(userId, 'support_reply', 'Réponse du support Ouvrage', b.body.slice(0, 200));
  await audit(req.user.id, 'support_reply', 'user', userId, req);
  res.status(201).json({ ok: true });
}));

module.exports = router;
