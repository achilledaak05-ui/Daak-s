'use strict';
// Tableau de bord, rapports par zone, journal d'audit
const express = require('express');
const { q } = require('../../db');
const { schemas } = require('../validation');
const { asyncHandler } = require('../../errors');
const { requireAdmin } = require('../security/middleware');

const router = express.Router();
router.use(requireAdmin);

const NET = 'b.price - ROUND(b.price * COALESCE(b.commission_rate, 15) / 100)';

router.get('/dashboard', asyncHandler(async (req, res) => {
  const one = async (sql) => (await q(sql))[0];
  const [clients, prosActive, prosPending, reqOpen, reqTotal, missionsDone, paid, commissions, confirmedNet, payouts] = [
    await one("SELECT COUNT(*) AS n FROM users WHERE role = 'client' AND status = 'active'"),
    await one("SELECT COUNT(*) AS n FROM pro_profiles pp JOIN users u ON u.id = pp.user_id WHERE pp.verification_status = 'valide' AND u.status = 'active'"),
    await one("SELECT COUNT(*) AS n FROM pro_profiles WHERE verification_status = 'attente'"),
    await one("SELECT COUNT(*) AS n FROM requests WHERE status IN ('nouvelle','distribuee','proposee')"),
    await one('SELECT COUNT(*) AS n FROM requests'),
    await one("SELECT COUNT(*) AS n FROM bookings WHERE status = 'terminee'"),
    await one("SELECT COALESCE(SUM(price),0) AS n FROM bookings WHERE status IN ('payee','en_cours','fin_signalee','terminee')"),
    await one("SELECT COALESCE(SUM(ROUND(price * commission_rate / 100)),0) AS n FROM bookings WHERE status IN ('payee','en_cours','fin_signalee','terminee') AND commission_rate IS NOT NULL"),
    await one(`SELECT COALESCE(SUM(${NET}),0) AS n FROM bookings b WHERE b.status = 'terminee'`),
    await one("SELECT COALESCE(SUM(montant),0) AS n FROM withdrawals WHERE status = 'verse'"),
  ];
  const dues = Math.max(0, Number(confirmedNet.n) - Number(payouts.n));
  res.json({
    clients: clients.n, prosActive: prosActive.n, prosPending: prosPending.n,
    requestsOpen: reqOpen.n, requestsTotal: reqTotal.n, missionsDone: missionsDone.n,
    paid: Number(paid.n), commissions: Number(commissions.n), dues, payouts: Number(payouts.n),
  });
}));

router.get('/reports/zones', asyncHandler(async (req, res) => {
  const rows = await q(
    `SELECT r.zone, COUNT(DISTINCT r.id) AS demandes,
            COUNT(DISTINCT CASE WHEN b.status = 'terminee' THEN b.id END) AS terminees,
            COALESCE(SUM(CASE WHEN b.status IN ('payee','en_cours','fin_signalee','terminee') THEN b.price END), 0) AS chiffre
       FROM requests r LEFT JOIN bookings b ON b.request_id = r.id
      GROUP BY r.zone ORDER BY demandes DESC LIMIT 200`,
  );
  res.json({ items: rows.map((r) => ({ zone: r.zone, requests: r.demandes, completed: r.terminees, revenue: Number(r.chiffre) })) });
}));

router.get('/reports/zones.csv', asyncHandler(async (req, res) => {
  const rows = await q(
    `SELECT r.zone, COUNT(DISTINCT r.id) AS demandes, COUNT(DISTINCT CASE WHEN b.status = 'terminee' THEN b.id END) AS terminees,
            COALESCE(SUM(CASE WHEN b.status IN ('payee','en_cours','fin_signalee','terminee') THEN b.price END), 0) AS chiffre
       FROM requests r LEFT JOIN bookings b ON b.request_id = r.id GROUP BY r.zone ORDER BY r.zone LIMIT 1000`,
  );
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = ['Zone;Demandes;Missions terminées;Chiffre (FCFA)', ...rows.map((r) => [esc(r.zone), r.demandes, r.terminees, r.chiffre].join(';'))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="rapport-zones.csv"');
  res.send('﻿' + lines.join('\n'));
}));

router.get('/audit', asyncHandler(async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const rows = await q(
    'SELECT id, actor_id, action, entity, entity_id, meta, ip, created_at FROM audit_log ORDER BY id DESC LIMIT ?',
    [limit],
  );
  res.json({ items: rows.map((a) => ({ id: a.id, actor: a.actor_id, action: a.action, entity: a.entity, entityId: a.entity_id, ip: a.ip, date: a.created_at })) });
}));

module.exports = router;
