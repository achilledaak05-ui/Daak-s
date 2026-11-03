'use strict';
// Espace client : /api/v1/client
const express = require('express');
const crypto = require('node:crypto');
const { q, tx } = require('../../db');
const { HttpError, notFound, conflict } = require('../../errors');
const v = require('../../lib/validation');
const { hashPassword } = require('../../lib/password');
const { openSession } = require('../auth');
const { authRouter, notificationsRouter, bookingMessages, deleteAccount } = require('../shared');
const { requireAuth, limiter, shortName, rating, splitList, placeholders } = require('../../http');
const { GROUPS, nextState } = require('../../domain/bookings');
const { commissionFor } = require('../../domain/pricing');
const { confirmPayment, currentRate } = require('../../services/bookingFlow');
const { initiatePayment } = require('../../services/payments');
const { audit } = require('../../services/audit');
const { notify } = require('../../services/notify');

const { z } = v;
const schemas = {
  register: z.object({
    firstName: v.text(1, 80), lastName: v.text(1, 80), contact: v.contact, password: v.password,
    city: v.text(2, 80), zone: v.text(0, 120).optional(),
  }).strict(),
  patchMe: z.object({
    firstName: v.text(1, 80).optional(), lastName: v.text(1, 80).optional(),
    city: v.text(2, 80).optional(), zone: v.text(0, 120).optional(),
  }).strict(),
  proSearch: z.object({
    trade: z.enum(v.TRADES).optional(), city: v.text(1, 80).optional(), zone: v.text(1, 120).optional(),
    q: v.text(1, 80).optional(), page: z.coerce.number().int().min(1).max(1000).default(1),
  }).strict(),
  createBooking: z.object({
    proId: v.id, trade: z.enum(v.TRADES), service: v.text(2, 120), mode: z.enum(['immediat', 'devis']),
    scheduledAt: v.isoDate.optional(), address: v.text(3, 255), description: v.text(3, 2000),
  }).strict(),
  createRequest: z.object({
    trade: z.enum(v.TRADES), title: v.text(2, 120), description: v.text(10, 2000), address: v.text(3, 255),
    zone: v.text(1, 120), urgency: z.enum(['aujourdhui', 'semaine', 'libre']), desiredAt: v.isoDate.optional(),
  }).strict(),
  reason: z.object({ reason: v.text(3, 500) }).strict(),
  dispute: z.object({ type: z.enum(v.DISPUTE_TYPES), description: v.text(10, 3000) }).strict(),
  review: z.object({ rating: z.number().int().min(1).max(5), comment: v.text(3, 1000) }).strict(),
  choose: z.object({ proId: v.id }).strict(),
  payment: z.object({ method: z.enum(v.PAYMENT_METHODS) }).strict(),
};

const PAGE_SIZE = 20;
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const router = express.Router();

// ---------- Connexion ----------
router.use('/auth', authRouter('client', async (req, res) => {
  const b = schemas.register.parse(req.body);
  const hash = await hashPassword(b.password);
  let out;
  try {
    out = await tx(async (t) => {
      const r = await t.q("INSERT INTO users (role, contact, password_hash, first_name, last_name, city, zone) VALUES ('client', ?, ?, ?, ?, ?, ?)",
        [v.normalizeContact(b.contact), hash, b.firstName, b.lastName, b.city, b.zone || null]);
      return { id: r.insertId, session: await openSession(t, 'client', r.insertId) };
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'contact_taken', 'Un compte existe déjà avec cet email ou ce téléphone');
    throw err;
  }
  await audit(req, out.id, 'register', 'user', out.id, { space: 'client' });
  res.status(201).json({ user: { id: out.id, role: 'client' }, ...out.session });
}));

router.use(requireAuth('client'));

// ---------- Profil ----------
router.get('/me', async (req, res) => {
  const [u] = await q("SELECT id, contact, first_name, last_name, city, zone, created_at FROM users WHERE id = ? AND status = 'active'", [req.user.id]);
  if (!u) throw notFound('Compte');
  res.json({ id: u.id, contact: u.contact, firstName: u.first_name, lastName: u.last_name, city: u.city, zone: u.zone, createdAt: u.created_at });
});

router.patch('/me', async (req, res) => {
  const b = schemas.patchMe.parse(req.body);
  const cols = { firstName: 'first_name', lastName: 'last_name', city: 'city', zone: 'zone' };
  const sets = Object.keys(cols).filter((k) => b[k] !== undefined);
  if (sets.length) {
    await q(`UPDATE users SET ${sets.map((k) => `${cols[k]} = ?`).join(', ')} WHERE id = ?`,
      [...sets.map((k) => b[k] || null), req.user.id]);
  }
  res.status(204).end();
});

router.delete('/me', async (req, res) => {
  await deleteAccount(req);
  res.status(204).end();
});

router.use('/notifications', notificationsRouter());

// ---------- Annuaire des prestataires (vérifiés et actifs seulement, sans coordonnées) ----------
const PRO_COLS = `u.id, u.first_name, u.last_name, u.city, pp.base_price, pp.rating_sum, pp.rating_count, pp.available,
  (SELECT GROUP_CONCAT(pt.trade ORDER BY pt.trade) FROM pro_trades pt WHERE pt.user_id = u.id) AS trades`;
const presentPro = (r) => ({
  id: r.id, name: shortName(r.first_name, r.last_name), city: r.city, trades: splitList(r.trades),
  basePrice: Number(r.base_price), rating: rating(r.rating_sum, r.rating_count), ratingCount: r.rating_count, available: !!r.available,
});

router.get('/pros', async (req, res) => {
  const f = schemas.proSearch.parse(req.query);
  const where = ["pp.verification_status = 'valide'", "u.status = 'active'"];
  const params = [];
  if (f.trade) { where.push('EXISTS (SELECT 1 FROM pro_trades pt WHERE pt.user_id = u.id AND pt.trade = ?)'); params.push(f.trade); }
  if (f.zone) { where.push('EXISTS (SELECT 1 FROM pro_zones pz WHERE pz.user_id = u.id AND pz.zone = ?)'); params.push(f.zone); }
  if (f.city) { where.push('u.city = ?'); params.push(f.city); }
  if (f.q) {
    where.push("(u.first_name LIKE ? OR u.last_name LIKE ?)");
    params.push(`%${escapeLike(f.q)}%`, `%${escapeLike(f.q)}%`);
  }
  const rows = await q(
    `SELECT ${PRO_COLS} FROM pro_profiles pp JOIN users u ON u.id = pp.user_id WHERE ${where.join(' AND ')}
      ORDER BY pp.rating_sum / GREATEST(pp.rating_count, 1) DESC, u.id LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE + 1, (f.page - 1) * PAGE_SIZE],
  );
  res.json({ page: f.page, hasMore: rows.length > PAGE_SIZE, items: rows.slice(0, PAGE_SIZE).map(presentPro) });
});

router.get('/pros/:id', async (req, res) => {
  const id = v.id.parse(req.params.id);
  const [p] = await q(
    `SELECT ${PRO_COLS}, pp.bio FROM pro_profiles pp JOIN users u ON u.id = pp.user_id
      WHERE u.id = ? AND pp.verification_status = 'valide' AND u.status = 'active'`, [id]);
  if (!p) throw notFound('Prestataire');
  const zones = await q('SELECT zone FROM pro_zones WHERE user_id = ? ORDER BY zone', [id]);
  const reviews = await q(
    `SELECT r.rating, r.comment, r.created_at, u.first_name, u.last_name FROM reviews r JOIN users u ON u.id = r.client_id
      WHERE r.pro_id = ? ORDER BY r.id DESC LIMIT 20`, [id]);
  const [fav] = await q('SELECT 1 AS x FROM favorites WHERE user_id = ? AND pro_id = ?', [req.user.id, id]);
  res.json({
    ...presentPro(p), bio: p.bio || '', zones: zones.map((z2) => z2.zone), favorite: !!fav,
    reviews: reviews.map((r) => ({ rating: r.rating, comment: r.comment, author: shortName(r.first_name, r.last_name), date: r.created_at })),
  });
});

// ---------- Favoris ----------
router.get('/favorites', async (req, res) => {
  const rows = await q(
    `SELECT ${PRO_COLS} FROM favorites f JOIN pro_profiles pp ON pp.user_id = f.pro_id JOIN users u ON u.id = f.pro_id
      WHERE f.user_id = ? AND pp.verification_status = 'valide' AND u.status = 'active' ORDER BY f.created_at DESC`, [req.user.id]);
  res.json({ items: rows.map(presentPro) });
});

// PUT idempotent : ajouter deux fois le même favori ne crée pas de doublon
router.put('/favorites/:proId', async (req, res) => {
  const proId = v.id.parse(req.params.proId);
  const [ok] = await q(
    `SELECT 1 AS x FROM pro_profiles pp JOIN users u ON u.id = pp.user_id
      WHERE pp.user_id = ? AND pp.verification_status = 'valide' AND u.status = 'active'`, [proId]);
  if (!ok) throw notFound('Prestataire');
  await q('INSERT IGNORE INTO favorites (user_id, pro_id) VALUES (?, ?)', [req.user.id, proId]);
  res.status(204).end();
});

router.delete('/favorites/:proId', async (req, res) => {
  await q('DELETE FROM favorites WHERE user_id = ? AND pro_id = ?', [req.user.id, v.id.parse(req.params.proId)]);
  res.status(204).end();
});

// ---------- Demandes : le client décrit son besoin, l'administration l'envoie aux prestataires ----------
const OPEN_REQUESTS = ['nouvelle', 'distribuee', 'proposee'];
const presentRequest = (r) => ({
  id: r.id, ref: r.ref, trade: r.trade, title: r.title, description: r.description, address: r.address, zone: r.zone,
  urgency: r.urgency, desiredAt: r.desired_at, status: r.status, createdAt: r.created_at,
  offersCount: r.offers_count === undefined ? undefined : Number(r.offers_count),
});

async function ownedRequest(t, id, clientId, lock = false) {
  const [r] = await t.q(`SELECT * FROM requests WHERE id = ? AND client_id = ?${lock ? ' FOR UPDATE' : ''}`, [id, clientId]);
  if (!r) throw notFound('Demande');
  return r;
}

router.get('/requests', async (req, res) => {
  const rows = await q(
    `SELECT r.*, (SELECT COUNT(*) FROM request_pros rp WHERE rp.request_id = r.id AND rp.status = 'propose') AS offers_count
       FROM requests r WHERE r.client_id = ? ORDER BY r.created_at DESC LIMIT 100`, [req.user.id]);
  res.json({ items: rows.map(presentRequest) });
});

router.post('/requests', limiter(60 * 60 * 1000, 10, 'Trop de demandes, réessayez plus tard'), async (req, res) => {
  const b = schemas.createRequest.parse(req.body);
  const id = await tx(async (t) => {
    const r = await t.q(
      'INSERT INTO requests (client_id, trade, title, description, address, zone, urgency, desired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, b.trade, b.title, b.description, b.address, b.zone, b.urgency, b.desiredAt ? new Date(b.desiredAt) : null]);
    await t.q("UPDATE requests SET ref = CONCAT('DEM-', id) WHERE id = ?", [r.insertId]);
    return r.insertId;
  });
  await audit(req, req.user.id, 'request_created', 'request', id, { trade: b.trade });
  res.status(201).json(presentRequest(await ownedRequest({ q }, id, req.user.id)));
});

// Détail avec les offres reçues ; aucune coordonnée du prestataire avant le choix
router.get('/requests/:id', async (req, res) => {
  const r = await ownedRequest({ q }, v.id.parse(req.params.id), req.user.id);
  const offers = await q(
    `SELECT rp.pro_id, rp.price, rp.message, rp.status, u.first_name, u.last_name, pp.rating_sum, pp.rating_count
       FROM request_pros rp JOIN users u ON u.id = rp.pro_id JOIN pro_profiles pp ON pp.user_id = rp.pro_id
      WHERE rp.request_id = ? AND rp.status IN ('propose','accepte') ORDER BY rp.price`, [r.id]);
  res.json({
    ...presentRequest(r),
    offers: offers.map((o) => ({
      proId: o.pro_id, name: shortName(o.first_name, o.last_name), price: Number(o.price), message: o.message,
      rating: rating(o.rating_sum, o.rating_count), status: o.status,
    })),
  });
});

router.post('/requests/:id/cancel', async (req, res) => {
  const id = v.id.parse(req.params.id);
  await tx(async (t) => {
    const r = await ownedRequest(t, id, req.user.id, true);
    if (!OPEN_REQUESTS.includes(r.status)) throw conflict('Cette demande ne peut plus être annulée');
    await t.q("UPDATE requests SET status = 'annulee' WHERE id = ?", [id]);
    await t.q("UPDATE request_pros SET status = 'refuse' WHERE request_id = ? AND status IN ('envoye','propose')", [id]);
  });
  await audit(req, req.user.id, 'request_cancelled', 'request', id);
  res.json({ id, status: 'annulee' });
});

// Choisir une offre crée la réservation au prix proposé ; le taux de commission est figé à ce moment
router.post('/requests/:id/choose', async (req, res) => {
  const id = v.id.parse(req.params.id);
  const b = schemas.choose.parse(req.body);
  const bookingId = await tx(async (t) => {
    const r = await ownedRequest(t, id, req.user.id, true);
    if (r.status !== 'proposee') throw conflict('Aucune offre à choisir');
    const [offer] = await t.q("SELECT pro_id, price FROM request_pros WHERE request_id = ? AND pro_id = ? AND status = 'propose' FOR UPDATE", [id, b.proId]);
    if (!offer || offer.price === null) throw notFound('Offre');
    const rate = await currentRate(t, r.trade);
    commissionFor(Number(offer.price), rate);
    const ins = await t.q(
      `INSERT INTO bookings (client_id, pro_id, request_id, trade, service, mode, status, address, description, scheduled_at, price, commission_rate)
       VALUES (?, ?, ?, ?, ?, 'devis', 'a_payer', ?, ?, ?, ?, ?)`,
      [req.user.id, offer.pro_id, id, r.trade, r.title, r.address, r.description, r.desired_at, offer.price, rate]);
    await t.q("UPDATE bookings SET ref = CONCAT('DEV-', id) WHERE id = ?", [ins.insertId]);
    await t.q("UPDATE request_pros SET status = 'accepte' WHERE request_id = ? AND pro_id = ?", [id, offer.pro_id]);
    await t.q("UPDATE request_pros SET status = 'refuse' WHERE request_id = ? AND pro_id <> ? AND status IN ('envoye','propose')", [id, offer.pro_id]);
    await t.q("UPDATE requests SET status = 'choisie' WHERE id = ?", [id]);
    return ins.insertId;
  });
  await notify(b.proId, 'offer_chosen', 'Votre offre a été choisie', 'Le client a accepté votre prix : paiement en attente.');
  await audit(req, req.user.id, 'request_offer_chosen', 'booking', bookingId, { request: id });
  res.status(201).json({ bookingId });
});

// ---------- Réservations ----------
const BOOKING_COLS = `b.id, b.ref, b.trade, b.service, b.mode, b.status, b.address, b.description, b.scheduled_at, b.price,
  b.created_at, b.updated_at, b.pro_id, b.request_id, pu.first_name AS pro_first, pu.last_name AS pro_last,
  (SELECT p.status FROM payments p WHERE p.booking_id = b.id ORDER BY p.id DESC LIMIT 1) AS payment_status,
  EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id) AS reviewed`;
const presentBooking = (r) => ({
  id: r.id, ref: r.ref, trade: r.trade, service: r.service, mode: r.mode, status: r.status, address: r.address,
  description: r.description, scheduledAt: r.scheduled_at, price: r.price === null ? null : Number(r.price),
  proId: r.pro_id, proName: shortName(r.pro_first, r.pro_last), requestId: r.request_id,
  paymentStatus: r.payment_status || null, reviewed: !!r.reviewed, createdAt: r.created_at, updatedAt: r.updated_at,
});

async function loadBooking(id, clientId) {
  const [r] = await q(`SELECT ${BOOKING_COLS} FROM bookings b JOIN users pu ON pu.id = b.pro_id WHERE b.id = ? AND b.client_id = ?`, [id, clientId]);
  if (!r) throw notFound('Réservation');
  return presentBooking(r);
}

async function lockBooking(t, id, clientId) {
  const [b] = await t.q('SELECT * FROM bookings WHERE id = ? AND client_id = ? FOR UPDATE', [id, clientId]);
  if (!b) throw notFound('Réservation');
  return b;
}

router.get('/bookings', async (req, res) => {
  const { group } = v.common.group.parse(req.query);
  const states = GROUPS[group];
  const rows = await q(
    `SELECT ${BOOKING_COLS} FROM bookings b JOIN users pu ON pu.id = b.pro_id
      WHERE b.client_id = ? AND b.status IN (${placeholders(states)}) ORDER BY b.created_at DESC LIMIT 100`,
    [req.user.id, ...states]);
  res.json({ items: rows.map(presentBooking) });
});

// Réservation directe : le prix immédiat vient du profil du prestataire, jamais du client
router.post('/bookings', limiter(60 * 60 * 1000, 30, 'Trop de réservations, réessayez plus tard'), async (req, res) => {
  const b = schemas.createBooking.parse(req.body);
  const [pro] = await q(
    `SELECT pp.base_price FROM pro_profiles pp JOIN users u ON u.id = pp.user_id
      WHERE pp.user_id = ? AND pp.verification_status = 'valide' AND pp.available = 1 AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM pro_trades pt WHERE pt.user_id = pp.user_id AND pt.trade = ?)`, [b.proId, b.trade]);
  if (!pro) throw notFound('Prestataire disponible pour ce métier');
  if (b.mode === 'immediat' && !Number(pro.base_price)) throw conflict('Ce prestataire travaille sur devis uniquement', 'quote_only');
  const id = await tx(async (t) => {
    const r = await t.q(
      `INSERT INTO bookings (client_id, pro_id, trade, service, mode, status, address, description, scheduled_at, price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, b.proId, b.trade, b.service, b.mode, b.mode === 'devis' ? 'demande_devis' : 'attente', b.address,
        b.description, b.scheduledAt ? new Date(b.scheduledAt) : null, b.mode === 'immediat' ? pro.base_price : null]);
    await t.q("UPDATE bookings SET ref = CONCAT(IF(mode = 'devis', 'DEV', 'RES'), '-', id) WHERE id = ?", [r.insertId]);
    return r.insertId;
  });
  await notify(b.proId, 'booking_new', b.mode === 'devis' ? 'Nouvelle demande de devis' : 'Nouvelle réservation', `${b.service} : ${b.address}`);
  await audit(req, req.user.id, 'booking_created', 'booking', id, { mode: b.mode });
  res.status(201).json(await loadBooking(id, req.user.id));
});

router.get('/bookings/:id', async (req, res) => {
  res.json(await loadBooking(v.id.parse(req.params.id), req.user.id));
});

// Action du client, acceptée seulement si la machine d'états l'autorise
async function clientAction(req, action, extra = {}) {
  const id = v.id.parse(req.params.id);
  const result = await tx(async (t) => {
    const bk = await lockBooking(t, id, req.user.id);
    const next = nextState('client', bk.status, action);
    if (!next) throw conflict('Action impossible dans l\'état actuel', 'invalid_transition');
    if (action === 'accept') {
      if (bk.price === null) throw conflict('Aucun prix proposé', 'no_price');
      const rate = await currentRate(t, bk.trade);
      commissionFor(Number(bk.price), rate);
      await t.q('UPDATE bookings SET status = ?, commission_rate = ? WHERE id = ?', [next, rate, id]);
    } else {
      await t.q('UPDATE bookings SET status = ? WHERE id = ?', [next, id]);
    }
    if (action === 'dispute') {
      await t.q('INSERT INTO disputes (booking_id, opened_by, type, description) VALUES (?, ?, ?, ?)', [id, req.user.id, extra.type, extra.description]);
    }
    if (action === 'cancel' && bk.status === 'payee') {
      await t.q("UPDATE payments SET status = 'refund_pending' WHERE booking_id = ? AND status = 'success'", [id]);
    }
    return { from: bk.status, to: next, proId: bk.pro_id, ref: bk.ref };
  });
  const texts = {
    cancel: ['Réservation annulée par le client', extra.reason],
    accept: ['Devis accepté', 'Le client a accepté votre prix : paiement en attente.'],
    refuse: ['Devis refusé', ''],
    confirm: ['Prestation confirmée', 'Le montant est ajouté à votre solde.'],
    dispute: ['Litige ouvert', extra.type],
  };
  await notify(result.proId, `booking_${action}`, `${texts[action][0]} (${result.ref})`, texts[action][1]);
  await audit(req, req.user.id, `booking_${action}`, 'booking', id, { from: result.from, to: result.to, reason: extra.reason });
  return loadBooking(id, req.user.id);
}

router.post('/bookings/:id/cancel', async (req, res) => res.json(await clientAction(req, 'cancel', schemas.reason.parse(req.body))));
router.post('/bookings/:id/accept-quote', async (req, res) => res.json(await clientAction(req, 'accept')));
router.post('/bookings/:id/refuse-quote', async (req, res) => res.json(await clientAction(req, 'refuse')));
router.post('/bookings/:id/confirm', async (req, res) => res.json(await clientAction(req, 'confirm')));
router.post('/bookings/:id/dispute', async (req, res) => res.json(await clientAction(req, 'dispute', schemas.dispute.parse(req.body))));

// Avis : une seule fois, après une prestation terminée
router.post('/bookings/:id/review', async (req, res) => {
  const id = v.id.parse(req.params.id);
  const b = schemas.review.parse(req.body);
  await tx(async (t) => {
    const bk = await lockBooking(t, id, req.user.id);
    if (bk.status !== 'terminee') throw conflict('Un avis n\'est possible qu\'après la prestation');
    const [existing] = await t.q('SELECT id FROM reviews WHERE booking_id = ?', [id]);
    if (existing) throw conflict('Vous avez déjà laissé un avis', 'already_reviewed');
    await t.q('INSERT INTO reviews (booking_id, client_id, pro_id, rating, comment) VALUES (?, ?, ?, ?, ?)', [id, req.user.id, bk.pro_id, b.rating, b.comment]);
    await t.q('UPDATE pro_profiles SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE user_id = ?', [b.rating, bk.pro_id]);
  });
  await audit(req, req.user.id, 'review_created', 'booking', id);
  res.status(201).json(await loadBooking(id, req.user.id));
});

// Paiement : créé par le serveur. Le client ne peut jamais marquer lui-même une réservation « payée ».
router.post('/bookings/:id/payments', async (req, res) => {
  const id = v.id.parse(req.params.id);
  const b = schemas.payment.parse(req.body);
  const payment = await tx(async (t) => {
    const bk = await lockBooking(t, id, req.user.id);
    if (bk.status !== 'a_payer') throw conflict('Cette réservation n\'est pas à payer');
    if (bk.price === null || bk.commission_rate === null) throw conflict('Prix non confirmé', 'no_price');
    const [pending] = await t.q("SELECT id, reference, method, amount FROM payments WHERE booking_id = ? AND status = 'pending'", [id]);
    if (pending) return pending;
    const reference = crypto.randomBytes(16).toString('hex');
    const r = await t.q('INSERT INTO payments (booking_id, amount, method, reference) VALUES (?, ?, ?, ?)', [id, bk.price, b.method, reference]);
    return { id: r.insertId, reference, method: b.method, amount: Number(bk.price) };
  });
  const result = await initiatePayment(payment);
  let status = 'pending';
  if (result.status === 'success') {
    status = await tx((t) => confirmPayment(t, payment.id));
    const [bk] = await q('SELECT pro_id, ref FROM bookings WHERE id = ?', [id]);
    if (status === 'success') await notify(bk.pro_id, 'booking_paid', `Réservation payée (${bk.ref})`, 'Vous pouvez démarrer la prestation.');
  }
  await audit(req, req.user.id, 'payment_initiated', 'booking', id, { reference: payment.reference, method: payment.method, outcome: status });
  res.status(201).json({ paymentId: payment.id, reference: payment.reference, status, booking: await loadBooking(id, req.user.id) });
});

const msgs = bookingMessages('client_id');
router.get('/bookings/:id/messages', msgs.list);
router.post('/bookings/:id/messages', limiter(60 * 1000, 60, 'Trop de messages, patientez un instant'), msgs.send);

// ---------- Support ----------
router.get('/support/messages', async (req, res) => {
  const rows = await q('SELECT id, sender, body, created_at FROM support_messages WHERE user_id = ? ORDER BY id DESC LIMIT 100', [req.user.id]);
  res.json({ items: rows.reverse().map((m) => ({ id: m.id, sender: m.sender, body: m.body, date: m.created_at })) });
});

router.post('/support/messages', limiter(60 * 1000, 20, 'Trop de messages, patientez un instant'), async (req, res) => {
  const b = v.common.message.parse(req.body);
  const r = await q("INSERT INTO support_messages (user_id, sender, body) VALUES (?, 'client', ?)", [req.user.id, b.body]);
  res.status(201).json({ id: r.insertId });
});

module.exports = router;
