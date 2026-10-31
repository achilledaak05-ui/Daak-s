'use strict';
// Portefeuille : solde disponible, demandes de retrait, historique. Le solde est calculé côté serveur.
const express = require('express');
const { q, tx } = require('../../db');
const { schemas } = require('../validation');
const { asyncHandler, HttpError } = require('../../errors');
const { requireAuth, requireRole } = require('../security/middleware');
const { requireVerified } = require('../security/verified');
const { availableBalance, checkWithdrawal } = require('../../domain/wallet');
const config = require('../../config');
const { audit } = require('../../services/audit');

const router = express.Router();
router.use(requireAuth, requireRole('pro'), requireVerified);

// Net d'une prestation confirmée : prix moins commission figée à l'acceptation
const NET_SQL = 'COALESCE(b.price,0) - ROUND(COALESCE(b.price,0) * COALESCE(b.commission_rate,15) / 100)';

async function balances(userId, t = { q }) {
  const [c] = await t.q(`SELECT COALESCE(SUM(${NET_SQL}),0) AS net FROM bookings b WHERE b.pro_id = ? AND b.status = 'terminee'`, [userId]);
  const [w] = await t.q(
    `SELECT COALESCE(SUM(CASE WHEN status IN ('demande','en_cours') THEN montant ELSE 0 END),0) AS pending,
            COALESCE(SUM(CASE WHEN status = 'verse' THEN montant ELSE 0 END),0) AS withdrawn
       FROM withdrawals WHERE user_id = ?`, [userId]);
  const confirmedNet = Number(c.net);
  const reserved = Number(w.pending) + Number(w.withdrawn);
  return { confirmedNet, pending: Number(w.pending), withdrawn: Number(w.withdrawn), available: availableBalance({ confirmedNet, reservedWithdrawals: reserved }) };
}

router.get('/', asyncHandler(async (req, res) => {
  res.json(await balances(req.user.id));
}));

router.get('/withdrawals', asyncHandler(async (req, res) => {
  const rows = await q('SELECT id, ref, montant, moyen, status, motif, created_at FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 100', [req.user.id]);
  res.json({ items: rows.map((r) => ({ id: r.id, ref: r.ref, amount: r.montant, method: r.moyen, status: r.status, reason: r.motif, date: r.created_at })) });
}));

// Le solde est vérifié et le retrait enregistré dans une même transaction, ligne du profil verrouillée
router.post('/withdrawals', asyncHandler(async (req, res) => {
  const b = schemas.withdrawal.parse(req.body);
  const id = await tx(async (t) => {
    await t.q('SELECT user_id FROM pro_profiles WHERE user_id = ? FOR UPDATE', [req.user.id]);
    const bal = await balances(req.user.id, t);
    checkWithdrawal({ amount: b.amount, available: bal.available, minimum: config.minWithdrawal });
    const r = await t.q("INSERT INTO withdrawals (user_id, montant, moyen, numero, status) VALUES (?, ?, ?, ?, 'demande')",
      [req.user.id, b.amount, b.method, b.number]);
    await t.q("UPDATE withdrawals SET ref = CONCAT('RET-', id) WHERE id = ?", [r.insertId]);
    return r.insertId;
  });
  await audit(req.user.id, 'withdrawal_requested', 'withdrawal', id, req, { amount: b.amount });
  res.status(201).json({ id });
}));

module.exports = router;
