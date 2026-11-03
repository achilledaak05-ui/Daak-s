'use strict';
// Espace administration : /api/v1/admin. Connexion en deux étapes (mot de passe puis code TOTP).
const express = require('express');
const { q, tx } = require('../../db');
const config = require('../../config');
const { HttpError, notFound, conflict } = require('../../errors');
const v = require('../../lib/validation');
const { hashPassword, verifyPassword, DUMMY_HASH } = require('../../lib/password');
const { decrypt, sealText, openText } = require('../../lib/crypto');
const { verifyTotp, newSecret, otpauthUri } = require('../../lib/totp');
const { openSession, refreshHandler, logoutHandler, revokeAll } = require('../auth');
const { requireAuth, limiter, rating, splitList, placeholders } = require('../../http');
const { GROUPS, PAID, ADMIN_CANCELLABLE } = require('../../domain/bookings');
const { pickPros } = require('../../domain/distribution');
const { checkWithdrawal } = require('../../domain/wallet');
const { MAX_RATE } = require('../../domain/pricing');
const { KINDS, REQUIRED } = require('../../domain/documents');
const { audit } = require('../../services/audit');
const { notify } = require('../../services/notify');

const { z } = v;
const REQUEST_STATES = ['nouvelle', 'distribuee', 'proposee', 'choisie', 'annulee', 'expiree'];
const schemas = {
  changePassword: z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(12, 'Mot de passe administrateur : 12 caractères minimum').max(128) }).strict(),
  totpReset: z.object({ password: z.string().min(1).max(128), totp: z.string().trim().regex(/^\d{6}$/) }).strict(),
  decision: z.object({ decision: z.enum(['valide', 'refuse', 'complement']), motif: v.text(3, 500).optional() }).strict(),
  dispute: z.object({ decision: z.enum(['client', 'pro']), motif: v.text(3, 500) }).strict(),
  rates: z.object({ rates: z.array(z.object({ trade: z.enum(v.TRADES), rate: z.number().min(0).max(MAX_RATE) }).strict()).min(1).max(20) }).strict(),
  requestStatus: z.object({ status: z.enum(REQUEST_STATES).default('nouvelle') }),
  prosFilter: z.object({ status: z.enum(['attente', 'valide', 'refuse', 'complement', 'suspendus', 'tous']).default('tous') }),
  disputeStatus: z.object({ status: z.enum(['ouvert', 'resolu']).default('ouvert') }),
  withdrawalStatus: z.object({ status: z.enum(['demande', 'en_cours', 'verse', 'rejete']).default('demande') }),
  limit: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
};
const fullName = (first, last) => `${first} ${last}`;
const NET_SQL = 'b.price - ROUND(b.price * COALESCE(b.commission_rate, 15) / 100)';

const router = express.Router();

// Filtre IP optionnel (ADMIN_IP_ALLOWLIST)
router.use((req, res, next) => {
  if (config.ipAllowlist.length && !config.ipAllowlist.includes(req.ip)) throw new HttpError(403, 'forbidden', 'Accès refusé');
  next();
});

// ---------- Connexion ----------
const loginLimit = limiter(15 * 60 * 1000, 8, 'Trop de tentatives, réessayez dans 15 minutes');

// Étape 1 sans « totp » : 401 mfa_required si le mot de passe est bon. Étape 2 avec « totp » : session ouverte.
router.post('/auth/login', loginLimit, async (req, res) => {
  const b = v.common.login.parse(req.body);
  const [u] = await q(
    `SELECT u.id, u.role, u.status, u.password_hash, m.totp_secret_enc FROM users u
       LEFT JOIN admin_mfa m ON m.user_id = u.id WHERE u.contact = ?`, [v.normalizeContact(b.contact)]);
  const ok = await verifyPassword(b.password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok || u.role !== 'admin' || u.status !== 'active' || !u.totp_secret_enc) {
    await audit(req, u ? u.id : null, 'admin_login_failed', 'user', u ? u.id : 'inconnu');
    throw new HttpError(401, 'invalid_credentials', 'Identifiant, mot de passe ou code incorrect');
  }
  if (!b.totp) throw new HttpError(401, 'mfa_required', 'Code de double authentification requis');
  if (!verifyTotp(openText(u.totp_secret_enc, config.dataKey), b.totp)) {
    await audit(req, u.id, 'admin_mfa_failed', 'user', u.id);
    throw new HttpError(401, 'invalid_credentials', 'Identifiant, mot de passe ou code incorrect');
  }
  const session = await tx((t) => openSession(t, 'admin', u.id));
  await audit(req, u.id, 'admin_login', 'user', u.id);
  res.json({ user: { id: u.id, role: 'admin' }, ...session });
});
router.post('/auth/refresh', loginLimit, refreshHandler('admin'));
router.post('/auth/logout', logoutHandler('admin'));

router.use(requireAuth('admin'));

// ---------- Compte de l'administrateur connecté ----------
async function loadSelf(id) {
  const [u] = await q(
    `SELECT u.id, u.contact, u.first_name, u.last_name, u.password_hash, m.totp_secret_enc FROM users u
       LEFT JOIN admin_mfa m ON m.user_id = u.id WHERE u.id = ? AND u.role = 'admin' AND u.status = 'active'`, [id]);
  if (!u) throw new HttpError(401, 'unauthorized', 'Session expirée ou invalide');
  return u;
}

router.get('/me', async (req, res) => {
  const u = await loadSelf(req.user.id);
  res.json({ id: u.id, contact: u.contact, firstName: u.first_name, lastName: u.last_name });
});

router.post('/account/password', async (req, res) => {
  const b = schemas.changePassword.parse(req.body);
  const u = await loadSelf(req.user.id);
  if (!(await verifyPassword(b.currentPassword, u.password_hash))) {
    await audit(req, u.id, 'admin_password_failed', 'user', u.id);
    throw new HttpError(401, 'invalid_credentials', 'Mot de passe actuel incorrect');
  }
  const hash = await hashPassword(b.newPassword);
  await tx(async (t) => {
    await t.q('UPDATE users SET password_hash = ? WHERE id = ?', [hash, u.id]);
    await revokeAll(t, u.id, 'admin');
  });
  await audit(req, u.id, 'admin_password_changed', 'user', u.id);
  res.status(204).end();
});

// Nouveau secret TOTP : exige le mot de passe ET le code actuel ; toutes les sessions sont fermées
router.post('/account/totp/reset', async (req, res) => {
  const b = schemas.totpReset.parse(req.body);
  const u = await loadSelf(req.user.id);
  const okPw = await verifyPassword(b.password, u.password_hash);
  if (!okPw || !u.totp_secret_enc || !verifyTotp(openText(u.totp_secret_enc, config.dataKey), b.totp)) {
    await audit(req, u.id, 'admin_totp_reset_failed', 'user', u.id);
    throw new HttpError(401, 'invalid_credentials', 'Mot de passe ou code incorrect');
  }
  const secret = newSecret();
  await tx(async (t) => {
    await t.q('UPDATE admin_mfa SET totp_secret_enc = ?, enabled_at = NOW() WHERE user_id = ?', [sealText(secret, config.dataKey), u.id]);
    await revokeAll(t, u.id, 'admin');
  });
  await audit(req, u.id, 'admin_totp_reset', 'user', u.id);
  res.json({ otpauthUri: otpauthUri(u.contact, secret), secret });
});

// ---------- Tableau de bord, rapports, audit ----------
router.get('/dashboard', async (req, res) => {
  const [[users], [reqs], [bk], [money], [wd], [disp]] = await Promise.all([
    q(`SELECT SUM(role = 'client' AND status = 'active') AS clients,
              (SELECT COUNT(*) FROM pro_profiles pp JOIN users u2 ON u2.id = pp.user_id WHERE pp.verification_status = 'valide' AND u2.status = 'active') AS pros_active,
              (SELECT COUNT(*) FROM pro_profiles WHERE verification_status = 'attente') AS pros_pending
         FROM users`),
    q("SELECT COUNT(*) AS total, SUM(status IN ('nouvelle','distribuee','proposee')) AS open, SUM(status = 'nouvelle') AS to_distribute FROM requests"),
    q("SELECT SUM(status = 'terminee') AS done, SUM(status IN ('payee','en_cours','fin_signalee')) AS ongoing FROM bookings"),
    q(`SELECT COALESCE(SUM(price), 0) AS paid,
              COALESCE(SUM(ROUND(price * commission_rate / 100)), 0) AS commissions
         FROM bookings WHERE status IN (${placeholders(PAID)})`, PAID),
    q(`SELECT COALESCE(SUM(CASE WHEN status = 'verse' THEN amount END), 0) AS payouts,
              COALESCE(SUM(CASE WHEN status IN ('demande','en_cours') THEN amount END), 0) AS pending, SUM(status = 'demande') AS to_process
         FROM withdrawals`),
    q("SELECT COUNT(*) AS n FROM disputes WHERE status = 'ouvert'"),
  ]);
  const [earned] = await q(`SELECT COALESCE(SUM(${NET_SQL}), 0) AS n FROM bookings b WHERE b.status = 'terminee'`);
  // Revenus des 6 derniers mois, pour le graphique du tableau de bord
  const monthly = await q(
    `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COALESCE(SUM(price), 0) AS paid,
            COALESCE(SUM(ROUND(price * commission_rate / 100)), 0) AS commissions
       FROM bookings WHERE status IN (${placeholders(PAID)}) AND created_at >= DATE_SUB(UTC_DATE(), INTERVAL 6 MONTH)
      GROUP BY month ORDER BY month`, PAID);
  const n = (x) => Number(x || 0);
  res.json({
    clients: n(users.clients), prosActive: n(users.pros_active), prosPending: n(users.pros_pending),
    requestsTotal: n(reqs.total), requestsOpen: n(reqs.open), requestsToDistribute: n(reqs.to_distribute),
    missionsDone: n(bk.done), missionsOngoing: n(bk.ongoing), disputesOpen: n(disp.n),
    paid: n(money.paid), commissions: n(money.commissions), payouts: n(wd.payouts),
    withdrawalsPending: n(wd.pending), withdrawalsToProcess: n(wd.to_process),
    dues: Math.max(0, n(earned.n) - n(wd.payouts)), // net dû aux prestataires, pas encore versé
    monthly: monthly.map((m) => ({ month: m.month, paid: n(m.paid), commissions: n(m.commissions) })),
  });
});

const ZONES_SQL = `SELECT r.zone, COUNT(DISTINCT r.id) AS requests,
    COUNT(DISTINCT CASE WHEN b.status = 'terminee' THEN b.id END) AS completed,
    COALESCE(SUM(CASE WHEN b.status IN (${placeholders(PAID)}) THEN b.price END), 0) AS revenue
  FROM requests r LEFT JOIN bookings b ON b.request_id = r.id GROUP BY r.zone ORDER BY requests DESC LIMIT 500`;

router.get('/reports/zones', async (req, res) => {
  const rows = await q(ZONES_SQL, PAID);
  res.json({ items: rows.map((r) => ({ zone: r.zone, requests: Number(r.requests), completed: Number(r.completed), revenue: Number(r.revenue) })) });
});

router.get('/reports/zones.csv', async (req, res) => {
  const rows = await q(ZONES_SQL, PAID);
  // Neutralise les formules Excel (=, +, -, @) et échappe les guillemets
  const cell = (val) => `"${String(val).replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"`;
  const lines = ['Zone;Demandes;Missions terminées;Chiffre (FCFA)', ...rows.map((r) => [cell(r.zone), r.requests, r.completed, r.revenue].join(';'))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="rapport-zones.csv"');
  res.send(`﻿${lines.join('\n')}`);
});

router.get('/audit', async (req, res) => {
  const { limit } = schemas.limit.parse(req.query);
  const rows = await q(
    `SELECT a.id, a.actor_id, a.action, a.entity, a.entity_id, a.meta, a.ip, a.created_at, u.first_name, u.last_name, u.role
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT ?`, [limit]);
  res.json({
    items: rows.map((a) => ({
      id: a.id, actor: a.actor_id, actorName: a.first_name ? fullName(a.first_name, a.last_name) : null, actorRole: a.role || null,
      action: a.action, entity: a.entity, entityId: a.entity_id, meta: a.meta, ip: a.ip, date: a.created_at,
    })),
  });
});

// ---------- Demandes ----------
router.get('/requests', async (req, res) => {
  const { status } = schemas.requestStatus.parse(req.query);
  const rows = await q(
    `SELECT r.id, r.ref, r.trade, r.title, r.description, r.address, r.zone, r.urgency, r.desired_at, r.status, r.created_at, r.client_id,
            u.first_name, u.last_name,
            (SELECT GROUP_CONCAT(rp.pro_id) FROM request_pros rp WHERE rp.request_id = r.id) AS sent,
            (SELECT COUNT(*) FROM request_pros rp WHERE rp.request_id = r.id AND rp.status = 'propose') AS offers
       FROM requests r JOIN users u ON u.id = r.client_id WHERE r.status = ? ORDER BY r.created_at LIMIT 200`, [status]);
  res.json({
    items: rows.map((r) => ({
      id: r.id, ref: r.ref, trade: r.trade, title: r.title, description: r.description, address: r.address, zone: r.zone,
      urgency: r.urgency, desiredAt: r.desired_at, status: r.status, clientId: r.client_id, client: fullName(r.first_name, r.last_name),
      sent: splitList(r.sent).map(Number), offers: Number(r.offers), date: r.created_at,
    })),
  });
});

// Envoi aux prestataires vérifiés, actifs, disponibles, du bon métier et de la bonne zone, les mieux notés d'abord
router.post('/requests/:id/distribute', async (req, res) => {
  const id = v.id.parse(req.params.id);
  const { r, chosen } = await tx(async (t) => {
    const [x] = await t.q('SELECT id, client_id, trade, zone, title, status FROM requests WHERE id = ? FOR UPDATE', [id]);
    if (!x) throw notFound('Demande');
    if (!['nouvelle', 'distribuee', 'proposee'].includes(x.status)) throw conflict('Cette demande ne peut pas être distribuée');
    const pool = await t.q(
      `SELECT u.id, pp.rating_sum / GREATEST(pp.rating_count, 1) AS rating FROM pro_profiles pp JOIN users u ON u.id = pp.user_id
        WHERE pp.verification_status = 'valide' AND pp.available = 1 AND u.status = 'active'
          AND EXISTS (SELECT 1 FROM pro_trades pt WHERE pt.user_id = u.id AND pt.trade = ?)
          AND EXISTS (SELECT 1 FROM pro_zones pz WHERE pz.user_id = u.id AND pz.zone = ?)`, [x.trade, x.zone]);
    const already = (await t.q('SELECT pro_id FROM request_pros WHERE request_id = ?', [id])).map((p) => p.pro_id);
    const picked = pickPros(pool.map((p) => ({ id: p.id, rating: Number(p.rating) || 0 })), already, config.distributionSize);
    if (!picked.length) throw conflict('Aucun nouveau prestataire disponible pour ce métier dans cette zone', 'no_pros');
    for (const proId of picked) await t.q("INSERT INTO request_pros (request_id, pro_id) VALUES (?, ?)", [id, proId]);
    if (x.status === 'nouvelle') await t.q("UPDATE requests SET status = 'distribuee' WHERE id = ?", [id]);
    return { r: x, chosen: picked };
  });
  await notify(r.client_id, 'request_distributed', 'Votre demande est en cours', `« ${r.title} » a été envoyée à des prestataires.`);
  for (const proId of chosen) await notify(proId, 'request_received', 'Nouvelle demande à traiter', r.title);
  await audit(req, req.user.id, 'request_distributed', 'request', id, { pros: chosen });
  res.json({ sent: chosen.length, pros: chosen });
});

router.post('/requests/:id/cancel', async (req, res) => {
  const id = v.id.parse(req.params.id);
  const b = v.common.motif.parse(req.body);
  const r = await tx(async (t) => {
    const [x] = await t.q('SELECT client_id, title, status FROM requests WHERE id = ? FOR UPDATE', [id]);
    if (!x) throw notFound('Demande');
    if (!['nouvelle', 'distribuee', 'proposee'].includes(x.status)) throw conflict('Cette demande ne peut plus être annulée');
    await t.q("UPDATE requests SET status = 'annulee' WHERE id = ?", [id]);
    await t.q("UPDATE request_pros SET status = 'refuse' WHERE request_id = ? AND status IN ('envoye','propose')", [id]);
    return x;
  });
  await notify(r.client_id, 'request_cancelled', 'Demande annulée par Ouvrage', b.motif);
  await audit(req, req.user.id, 'request_cancelled_admin', 'request', id, { motif: b.motif });
  res.json({ id, status: 'annulee' });
});

// ---------- Réservations, remboursements, litiges ----------
router.get('/bookings', async (req, res) => {
  const { group } = v.common.group.parse(req.query);
  const states = GROUPS[group];
  const rows = await q(
    `SELECT b.id, b.ref, b.service, b.trade, b.status, b.price, b.mode, b.address, b.scheduled_at, b.created_at, b.client_id, b.pro_id, b.commission_rate,
            cu.first_name AS cf, cu.last_name AS cl, pu.first_name AS pf, pu.last_name AS pl,
            (SELECT p.status FROM payments p WHERE p.booking_id = b.id ORDER BY p.id DESC LIMIT 1) AS payment
       FROM bookings b JOIN users cu ON cu.id = b.client_id JOIN users pu ON pu.id = b.pro_id
      WHERE b.status IN (${placeholders(states)}) ORDER BY b.id DESC LIMIT 200`, states);
  res.json({
    items: rows.map((b) => ({
      id: b.id, ref: b.ref, service: b.service, trade: b.trade, status: b.status, mode: b.mode, address: b.address,
      price: b.price === null ? null : Number(b.price), commissionRate: b.commission_rate === null ? null : Number(b.commission_rate),
      clientId: b.client_id, proId: b.pro_id, client: fullName(b.cf, b.cl), pro: fullName(b.pf, b.pl),
      payment: b.payment || null, scheduledAt: b.scheduled_at, date: b.created_at,
    })),
  });
});

router.post('/bookings/:id/cancel', async (req, res) => {
  const id = v.id.parse(req.params.id);
  const b = v.common.motif.parse(req.body);
  const bk = await tx(async (t) => {
    const [x] = await t.q('SELECT id, client_id, pro_id, status FROM bookings WHERE id = ? FOR UPDATE', [id]);
    if (!x) throw notFound('Réservation');
    if (!ADMIN_CANCELLABLE.includes(x.status)) throw conflict('Cette réservation ne peut plus être annulée');
    await t.q("UPDATE bookings SET status = 'annulee' WHERE id = ?", [id]);
    if (PAID.includes(x.status)) await t.q("UPDATE payments SET status = 'refund_pending' WHERE booking_id = ? AND status = 'success'", [id]);
    return x;
  });
  await notify(bk.client_id, 'booking_cancelled', 'Réservation annulée par Ouvrage', b.motif);
  await notify(bk.pro_id, 'booking_cancelled', 'Réservation annulée par Ouvrage', b.motif);
  await audit(req, req.user.id, 'booking_cancelled_admin', 'booking', id, { motif: b.motif });
  res.json({ id, status: 'annulee' });
});

// Remboursements à effectuer (paiements en refund_pending)
router.get('/refunds', async (req, res) => {
  const rows = await q(
    `SELECT p.id, p.booking_id, p.amount, p.method, p.status, p.updated_at, b.ref, u.first_name, u.last_name
       FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN users u ON u.id = b.client_id
      WHERE p.status IN ('refund_pending','refunded') ORDER BY p.status = 'refunded', p.updated_at DESC LIMIT 200`);
  res.json({ items: rows.map((p) => ({ id: p.id, bookingId: p.booking_id, ref: p.ref, amount: Number(p.amount), method: p.method, status: p.status, client: fullName(p.first_name, p.last_name), date: p.updated_at })) });
});

router.post('/bookings/:id/refunded', async (req, res) => {
  const id = v.id.parse(req.params.id);
  const r = await q("UPDATE payments SET status = 'refunded' WHERE booking_id = ? AND status = 'refund_pending'", [id]);
  if (!r.affectedRows) throw conflict('Aucun remboursement en attente pour cette réservation');
  const [bk] = await q('SELECT client_id, ref FROM bookings WHERE id = ?', [id]);
  await notify(bk.client_id, 'refund_done', `Remboursement effectué (${bk.ref})`, '');
  await audit(req, req.user.id, 'refund_done', 'booking', id);
  res.json({ id, refunded: true });
});

router.get('/disputes', async (req, res) => {
  const { status } = schemas.disputeStatus.parse(req.query);
  const rows = await q(
    `SELECT d.id, d.booking_id, d.type, d.description, d.status, d.decision, d.motif, d.created_at, b.ref, b.price, b.service,
            b.status AS booking_status, cu.first_name AS cf, cu.last_name AS cl, pu.first_name AS pf, pu.last_name AS pl
       FROM disputes d JOIN bookings b ON b.id = d.booking_id JOIN users cu ON cu.id = b.client_id JOIN users pu ON pu.id = b.pro_id
      WHERE d.status = ? ORDER BY d.id LIMIT 200`, [status]);
  res.json({
    items: rows.map((d) => ({
      id: d.id, bookingId: d.booking_id, ref: d.ref, service: d.service, price: d.price === null ? null : Number(d.price),
      type: d.type, description: d.description, status: d.status, decision: d.decision, motif: d.motif,
      bookingStatus: d.booking_status, client: fullName(d.cf, d.cl), pro: fullName(d.pf, d.pl), date: d.created_at,
    })),
  });
});

// Décision motivée : en faveur du client (annulation + remboursement) ou du prestataire (prestation terminée)
router.post('/disputes/:id/decide', async (req, res) => {
  const id = v.id.parse(req.params.id);
  const b = schemas.dispute.parse(req.body);
  const bk = await tx(async (t) => {
    const [d] = await t.q("SELECT id, booking_id FROM disputes WHERE id = ? AND status = 'ouvert' FOR UPDATE", [id]);
    if (!d) throw notFound('Litige ouvert');
    const [x] = await t.q('SELECT id, client_id, pro_id, status FROM bookings WHERE id = ? FOR UPDATE', [d.booking_id]);
    if (b.decision === 'client') {
      await t.q("UPDATE bookings SET status = 'annulee' WHERE id = ?", [x.id]);
      await t.q("UPDATE payments SET status = 'refund_pending' WHERE booking_id = ? AND status = 'success'", [x.id]);
    } else {
      await t.q("UPDATE bookings SET status = 'terminee' WHERE id = ?", [x.id]);
    }
    await t.q("UPDATE disputes SET status = 'resolu', decision = ?, motif = ? WHERE id = ?", [b.decision, b.motif, id]);
    return x;
  });
  const title = b.decision === 'client' ? 'Litige tranché : client remboursé' : 'Litige tranché : prestation validée';
  await notify(bk.client_id, 'dispute_decided', title, b.motif);
  await notify(bk.pro_id, 'dispute_decided', title, b.motif);
  await audit(req, req.user.id, 'dispute_decided', 'dispute', id, { decision: b.decision, motif: b.motif });
  res.json({ id, decision: b.decision });
});

// ---------- Prestataires et clients ----------
router.get('/pros', async (req, res) => {
  const { status } = schemas.prosFilter.parse(req.query);
  let where = '1=1';
  const params = [];
  if (status === 'suspendus') where = "u.status = 'suspended'";
  else if (status !== 'tous') { where = "pp.verification_status = ? AND u.status <> 'deleted'"; params.push(status); }
  const rows = await q(
    `SELECT u.id, u.first_name, u.last_name, u.city, u.contact, u.status, u.created_at, pp.verification_status, pp.base_price,
            pp.rating_sum, pp.rating_count, pp.available,
            (SELECT GROUP_CONCAT(trade ORDER BY trade) FROM pro_trades WHERE user_id = u.id) AS trades,
            (SELECT GROUP_CONCAT(zone ORDER BY zone) FROM pro_zones WHERE user_id = u.id) AS zones,
            (SELECT GROUP_CONCAT(kind) FROM pro_documents WHERE user_id = u.id AND is_current = 1) AS docs,
            (SELECT COUNT(*) FROM bookings WHERE pro_id = u.id AND status = 'terminee') AS missions
       FROM users u JOIN pro_profiles pp ON pp.user_id = u.id WHERE u.role = 'pro' AND ${where} ORDER BY u.id DESC LIMIT 500`, params);
  res.json({
    items: rows.map((r) => ({
      id: r.id, name: fullName(r.first_name, r.last_name), city: r.city, contact: r.contact, status: r.status,
      verification: r.verification_status, available: !!r.available, basePrice: Number(r.base_price),
      trades: splitList(r.trades), zones: splitList(r.zones), documents: splitList(r.docs),
      rating: rating(r.rating_sum, r.rating_count), ratingCount: r.rating_count, missions: Number(r.missions), date: r.created_at,
    })),
  });
});

router.get('/pros/:id', async (req, res) => {
  const id = v.id.parse(req.params.id);
  const [u] = await q(
    `SELECT u.id, u.first_name, u.last_name, u.city, u.contact, u.status, u.created_at, pp.bio, pp.base_price, pp.verification_status,
            pp.available, pp.rating_sum, pp.rating_count
       FROM users u JOIN pro_profiles pp ON pp.user_id = u.id WHERE u.id = ? AND u.role = 'pro'`, [id]);
  if (!u) throw notFound('Prestataire');
  const [trades, zones, docs] = await Promise.all([
    q('SELECT trade FROM pro_trades WHERE user_id = ? ORDER BY trade', [id]),
    q('SELECT zone FROM pro_zones WHERE user_id = ? ORDER BY zone', [id]),
    q('SELECT id, kind, mime, size_bytes, created_at FROM pro_documents WHERE user_id = ? AND is_current = 1 ORDER BY kind', [id]),
  ]);
  await audit(req, req.user.id, 'pro_viewed', 'user', id);
  res.json({
    id: u.id, name: fullName(u.first_name, u.last_name), city: u.city, contact: u.contact, status: u.status, bio: u.bio || '',
    basePrice: Number(u.base_price), verification: u.verification_status, available: !!u.available,
    rating: rating(u.rating_sum, u.rating_count), ratingCount: u.rating_count, date: u.created_at,
    trades: trades.map((x) => x.trade), zones: zones.map((x) => x.zone),
    documents: docs.map((d) => ({ id: d.id, kind: d.kind, mime: d.mime, size: d.size_bytes, date: d.created_at })),
  });
});

// Lecture d'une pièce : déchiffrée à la demande, jamais mise en cache, chaque lecture est journalisée
router.get('/pros/:id/documents/:kind', async (req, res) => {
  const id = v.id.parse(req.params.id);
  const kind = v.z.enum(KINDS).parse(req.params.kind);
  const [d] = await q('SELECT mime, content_enc FROM pro_documents WHERE user_id = ? AND kind = ? AND is_current = 1', [id, kind]);
  if (!d) throw notFound('Pièce');
  await audit(req, req.user.id, 'document_read', 'user', id, { kind });
  res.setHeader('Content-Type', d.mime);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'no-store');
  res.send(decrypt(d.content_enc, config.dataKey));
});

router.post('/pros/:id/decision', async (req, res) => {
  const id = v.id.parse(req.params.id);
  const b = schemas.decision.parse(req.body);
  if (b.decision !== 'valide' && !b.motif) throw new HttpError(400, 'invalid', 'Indiquez un motif');
  await tx(async (t) => {
    const [p] = await t.q("SELECT pp.user_id FROM pro_profiles pp JOIN users u ON u.id = pp.user_id WHERE pp.user_id = ? AND u.role = 'pro' FOR UPDATE", [id]);
    if (!p) throw notFound('Prestataire');
    if (b.decision === 'valide') {
      const docs = (await t.q('SELECT kind FROM pro_documents WHERE user_id = ? AND is_current = 1', [id])).map((d) => d.kind);
      if (!REQUIRED.every((k) => docs.includes(k))) throw conflict('Carte d\'identité et extrait de naissance requis', 'missing_documents');
    }
    await t.q('UPDATE pro_profiles SET verification_status = ? WHERE user_id = ?', [b.decision, id]);
  });
  const texts = {
    valide: ['Profil validé 🎉', 'Votre profil est visible par les clients.'],
    refuse: ['Dossier refusé', b.motif],
    complement: ['Complément demandé', b.motif],
  };
  await notify(id, `verification_${b.decision}`, ...texts[b.decision]);
  await audit(req, req.user.id, `verification_${b.decision}`, 'user', id, { motif: b.motif || null });
  res.json({ id, verification: b.decision });
});

router.get('/clients', async (req, res) => {
  const rows = await q(
    `SELECT u.id, u.first_name, u.last_name, u.city, u.zone, u.contact, u.status, u.created_at,
            (SELECT COUNT(*) FROM bookings b WHERE b.client_id = u.id) AS bookings,
            (SELECT COUNT(*) FROM requests r WHERE r.client_id = u.id) AS requests
       FROM users u WHERE u.role = 'client' AND u.status <> 'deleted' ORDER BY u.id DESC LIMIT 500`);
  res.json({
    items: rows.map((u) => ({
      id: u.id, name: fullName(u.first_name, u.last_name), city: u.city, zone: u.zone, contact: u.contact, status: u.status,
      bookings: Number(u.bookings), requests: Number(u.requests), date: u.created_at,
    })),
  });
});

// Suspension : connexion impossible, sessions fermées ; un prestataire ne reçoit plus de demandes
async function setStatus(req, res, status) {
  const id = v.id.parse(req.params.id);
  const b = status === 'suspended' ? v.common.motif.parse(req.body) : { motif: null };
  const [u] = await q("SELECT id FROM users WHERE id = ? AND role IN ('client','pro') AND status <> 'deleted'", [id]);
  if (!u) throw notFound('Compte');
  await tx(async (t) => {
    await t.q('UPDATE users SET status = ? WHERE id = ?', [status, id]);
    if (status === 'suspended') await revokeAll(t, id);
  });
  if (status === 'suspended') await notify(id, 'account_suspended', 'Compte suspendu', b.motif);
  else await notify(id, 'account_reactivated', 'Compte réactivé', '');
  await audit(req, req.user.id, status === 'suspended' ? 'account_suspended' : 'account_reactivated', 'user', id, { motif: b.motif });
  res.json({ id, status });
}
router.post('/users/:id/suspend', (req, res) => setStatus(req, res, 'suspended'));
router.post('/users/:id/reactivate', (req, res) => setStatus(req, res, 'active'));

// ---------- Commissions ----------
// Le taux est figé sur chaque réservation : le modifier ne touche jamais les missions déjà conclues
router.get('/rates', async (req, res) => {
  const rows = await q('SELECT trade, rate, updated_at FROM commission_rates ORDER BY trade');
  const history = await q("SELECT entity_id AS trade, meta, created_at FROM audit_log WHERE action = 'rate_changed' ORDER BY id DESC LIMIT 50");
  res.json({
    items: rows.map((r) => ({ trade: r.trade, rate: Number(r.rate), updated: r.updated_at })),
    history: history.map((h) => ({ trade: h.trade, from: h.meta && h.meta.from, to: h.meta && h.meta.to, date: h.created_at })),
  });
});

router.put('/rates', async (req, res) => {
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
  for (const c of changes) await audit(req, req.user.id, 'rate_changed', 'commission', c.trade, { from: c.from, to: c.to });
  res.json({ changed: changes.length });
});

// ---------- Retraits : demande → en cours de virement → versé, ou rejeté avec motif ----------
router.get('/withdrawals', async (req, res) => {
  const { status } = schemas.withdrawalStatus.parse(req.query);
  const rows = await q(
    `SELECT w.id, w.ref, w.amount, w.method, w.number_enc, w.status, w.reason, w.created_at, u.id AS user_id, u.first_name, u.last_name
       FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status = ? ORDER BY w.id LIMIT 200`, [status]);
  res.json({
    items: rows.map((w) => ({
      id: w.id, ref: w.ref, amount: Number(w.amount), method: w.method, number: openText(w.number_enc, config.dataKey),
      status: w.status, reason: w.reason, proId: w.user_id, pro: fullName(w.first_name, w.last_name), date: w.created_at,
    })),
  });
});

router.post('/withdrawals/:id/start', async (req, res) => {
  const id = v.id.parse(req.params.id);
  const w = await tx(async (t) => {
    const [x] = await t.q("SELECT id, user_id, amount FROM withdrawals WHERE id = ? AND status = 'demande' FOR UPDATE", [id]);
    if (!x) throw conflict('Ce retrait ne peut pas être lancé');
    // Revérifie le solde : un litige tranché après la demande a pu le réduire
    const [c] = await t.q(`SELECT COALESCE(SUM(${NET_SQL}), 0) AS net FROM bookings b WHERE b.pro_id = ? AND b.status = 'terminee'`, [x.user_id]);
    const [o] = await t.q("SELECT COALESCE(SUM(amount), 0) AS n FROM withdrawals WHERE user_id = ? AND status IN ('en_cours','verse')", [x.user_id]);
    checkWithdrawal({ amount: Number(x.amount), available: Number(c.net) - Number(o.n), minimum: 0 });
    await t.q("UPDATE withdrawals SET status = 'en_cours' WHERE id = ?", [id]);
    return x;
  });
  await notify(w.user_id, 'withdrawal_started', 'Retrait en cours de virement', `${w.amount} FCFA`);
  await audit(req, req.user.id, 'withdrawal_started', 'withdrawal', id);
  res.json({ id, status: 'en_cours' });
});

router.post('/withdrawals/:id/paid', async (req, res) => {
  const id = v.id.parse(req.params.id);
  const [x] = await q("SELECT user_id, amount FROM withdrawals WHERE id = ? AND status = 'en_cours'", [id]);
  if (!x) throw conflict('Ce retrait n\'est pas en cours de virement');
  await q("UPDATE withdrawals SET status = 'verse' WHERE id = ? AND status = 'en_cours'", [id]);
  await notify(x.user_id, 'withdrawal_paid', 'Retrait versé', `${x.amount} FCFA ont été envoyés.`);
  await audit(req, req.user.id, 'withdrawal_paid', 'withdrawal', id);
  res.json({ id, status: 'verse' });
});

router.post('/withdrawals/:id/reject', async (req, res) => {
  const id = v.id.parse(req.params.id);
  const b = v.common.motif.parse(req.body);
  const r = await q("UPDATE withdrawals SET status = 'rejete', reason = ? WHERE id = ? AND status IN ('demande','en_cours')", [b.motif, id]);
  if (!r.affectedRows) throw conflict('Ce retrait ne peut pas être rejeté');
  const [x] = await q('SELECT user_id FROM withdrawals WHERE id = ?', [id]);
  await notify(x.user_id, 'withdrawal_rejected', 'Retrait refusé', b.motif);
  await audit(req, req.user.id, 'withdrawal_rejected', 'withdrawal', id, { motif: b.motif });
  res.json({ id, status: 'rejete' });
});

// ---------- Support ----------
router.get('/support', async (req, res) => {
  const rows = await q(
    `SELECT u.id, u.first_name, u.last_name, s.body AS last, s.sender AS last_sender, s.created_at AS last_at,
            (SELECT COUNT(*) FROM support_messages s2 WHERE s2.user_id = u.id) AS total
       FROM support_messages s JOIN users u ON u.id = s.user_id
      WHERE s.id = (SELECT MAX(id) FROM support_messages s3 WHERE s3.user_id = s.user_id)
      ORDER BY s.id DESC LIMIT 200`);
  res.json({
    items: rows.map((r) => ({
      id: r.id, name: fullName(r.first_name, r.last_name), last: r.last, awaitingReply: r.last_sender === 'client',
      messages: Number(r.total), date: r.last_at,
    })),
  });
});

router.get('/support/:userId', async (req, res) => {
  const userId = v.id.parse(req.params.userId);
  const rows = await q('SELECT id, sender, body, created_at FROM support_messages WHERE user_id = ? ORDER BY id DESC LIMIT 200', [userId]);
  res.json({ items: rows.reverse().map((m) => ({ id: m.id, sender: m.sender, body: m.body, date: m.created_at })) });
});

router.post('/support/:userId/messages', limiter(60 * 1000, 60), async (req, res) => {
  const userId = v.id.parse(req.params.userId);
  const b = v.common.message.parse(req.body);
  const [u] = await q("SELECT id FROM users WHERE id = ? AND role = 'client'", [userId]);
  if (!u) throw notFound('Client');
  const r = await q("INSERT INTO support_messages (user_id, sender, body) VALUES (?, 'support', ?)", [userId, b.body]);
  await notify(userId, 'support_reply', 'Réponse du support Ouvrage', b.body.slice(0, 200));
  await audit(req, req.user.id, 'support_reply', 'user', userId);
  res.status(201).json({ id: r.insertId });
});

module.exports = router;
