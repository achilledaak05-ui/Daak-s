'use strict';
// Espace prestataire : /api/v1/pro
const express = require('express');
const multer = require('multer');
const { q, tx } = require('../../db');
const config = require('../../config');
const { HttpError, notFound, conflict } = require('../../errors');
const v = require('../../lib/validation');
const { hashPassword } = require('../../lib/password');
const { encrypt, sealText, sha256 } = require('../../lib/crypto');
const { openSession } = require('../auth');
const { authRouter, notificationsRouter, bookingMessages, deleteAccount } = require('../shared');
const { requireAuth, requireVerifiedPro, limiter, shortName, rating, placeholders } = require('../../http');
const { GROUPS, nextState } = require('../../domain/bookings');
const { commissionFor } = require('../../domain/pricing');
const { checkWithdrawal } = require('../../domain/wallet');
const { checkDocument, MAX_BYTES, KINDS, REQUIRED } = require('../../domain/documents');
const { currentRate } = require('../../services/bookingFlow');
const { audit } = require('../../services/audit');
const { notify } = require('../../services/notify');

const { z } = v;
const trades = z.array(z.enum(v.TRADES)).min(1).max(8);
const zones = z.array(v.text(1, 120)).min(1).max(20);
const schemas = {
  register: z.object({
    firstName: v.text(1, 80), lastName: v.text(1, 80), contact: v.contact, password: v.password,
    city: v.text(2, 80), trades, zones, bio: v.text(0, 1000).optional(), basePrice: v.money.optional(),
  }).strict(),
  patchMe: z.object({
    city: v.text(2, 80).optional(), bio: v.text(0, 1000).optional(), basePrice: v.money.optional(), available: z.boolean().optional(),
  }).strict(),
  trades: z.object({ trades }).strict(),
  zones: z.object({ zones }).strict(),
  offer: z.object({ price: z.number().int().min(1).max(10000000), message: v.text(0, 1000).optional() }).strict(),
  quote: z.object({ price: z.number().int().min(1).max(10000000) }).strict(),
  withdrawal: z.object({ amount: z.number().int().min(1).max(10000000), method: z.enum(v.WITHDRAW_METHODS), number: v.text(6, 40) }).strict(),
};

const router = express.Router();

// ---------- Connexion ----------
router.use('/auth', authRouter('pro', async (req, res) => {
  const b = schemas.register.parse(req.body);
  const hash = await hashPassword(b.password);
  let out;
  try {
    out = await tx(async (t) => {
      const r = await t.q("INSERT INTO users (role, contact, password_hash, first_name, last_name, city) VALUES ('pro', ?, ?, ?, ?, ?)",
        [v.normalizeContact(b.contact), hash, b.firstName, b.lastName, b.city]);
      const id = r.insertId;
      await t.q('INSERT INTO pro_profiles (user_id, bio, base_price) VALUES (?, ?, ?)', [id, b.bio || null, b.basePrice || 0]);
      for (const trade of new Set(b.trades)) await t.q('INSERT INTO pro_trades (user_id, trade) VALUES (?, ?)', [id, trade]);
      for (const zone of new Set(b.zones)) await t.q('INSERT INTO pro_zones (user_id, zone) VALUES (?, ?)', [id, zone]);
      return { id, session: await openSession(t, 'pro', id) };
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'contact_taken', 'Un compte existe déjà avec cet email ou ce téléphone');
    throw err;
  }
  await audit(req, out.id, 'register', 'user', out.id, { space: 'pro' });
  res.status(201).json({ user: { id: out.id, role: 'pro' }, ...out.session });
}));

router.use(requireAuth('pro'));

// ---------- Profil (accessible avant validation, pour compléter le dossier) ----------
router.get('/me', async (req, res) => {
  const [u] = await q(
    `SELECT u.id, u.contact, u.first_name, u.last_name, u.city, u.created_at, pp.bio, pp.base_price, pp.available,
            pp.verification_status, pp.rating_sum, pp.rating_count
       FROM users u JOIN pro_profiles pp ON pp.user_id = u.id WHERE u.id = ? AND u.status = 'active'`, [req.user.id]);
  if (!u) throw notFound('Compte');
  const tr = await q('SELECT trade FROM pro_trades WHERE user_id = ? ORDER BY trade', [u.id]);
  const zn = await q('SELECT zone FROM pro_zones WHERE user_id = ? ORDER BY zone', [u.id]);
  res.json({
    id: u.id, contact: u.contact, firstName: u.first_name, lastName: u.last_name, city: u.city, bio: u.bio || '',
    basePrice: Number(u.base_price), available: !!u.available, verificationStatus: u.verification_status,
    trades: tr.map((x) => x.trade), zones: zn.map((x) => x.zone),
    rating: rating(u.rating_sum, u.rating_count), ratingCount: u.rating_count, createdAt: u.created_at,
  });
});

router.patch('/me', async (req, res) => {
  const b = schemas.patchMe.parse(req.body);
  await tx(async (t) => {
    if (b.city !== undefined) await t.q('UPDATE users SET city = ? WHERE id = ?', [b.city, req.user.id]);
    if (b.bio !== undefined) await t.q('UPDATE pro_profiles SET bio = ? WHERE user_id = ?', [b.bio || null, req.user.id]);
    if (b.basePrice !== undefined) await t.q('UPDATE pro_profiles SET base_price = ? WHERE user_id = ?', [b.basePrice, req.user.id]);
    if (b.available !== undefined) await t.q('UPDATE pro_profiles SET available = ? WHERE user_id = ?', [b.available ? 1 : 0, req.user.id]);
  });
  res.status(204).end();
});

router.put('/me/trades', async (req, res) => {
  const b = schemas.trades.parse(req.body);
  await tx(async (t) => {
    await t.q('DELETE FROM pro_trades WHERE user_id = ?', [req.user.id]);
    for (const trade of new Set(b.trades)) await t.q('INSERT INTO pro_trades (user_id, trade) VALUES (?, ?)', [req.user.id, trade]);
  });
  res.status(204).end();
});

router.put('/me/zones', async (req, res) => {
  const b = schemas.zones.parse(req.body);
  await tx(async (t) => {
    await t.q('DELETE FROM pro_zones WHERE user_id = ?', [req.user.id]);
    for (const zone of new Set(b.zones)) await t.q('INSERT INTO pro_zones (user_id, zone) VALUES (?, ?)', [req.user.id, zone]);
  });
  res.status(204).end();
});

router.delete('/me', async (req, res) => {
  await deleteAccount(req, (t) => t.q("UPDATE pro_profiles SET available = 0, verification_status = 'refuse' WHERE user_id = ?", [req.user.id]));
  res.status(204).end();
});

// Dossier de vérification : carte d'identité et extrait de naissance obligatoires, diplôme facultatif
router.get('/me/verification', async (req, res) => {
  const [p] = await q('SELECT verification_status FROM pro_profiles WHERE user_id = ?', [req.user.id]);
  const docs = await q('SELECT kind FROM pro_documents WHERE user_id = ? AND is_current = 1', [req.user.id]);
  const have = new Set(docs.map((d) => d.kind));
  res.json({
    status: p.verification_status,
    documents: Object.fromEntries(KINDS.map((k) => [k, have.has(k)])),
    missing: REQUIRED.filter((k) => !have.has(k)),
  });
});

router.get('/me/documents', async (req, res) => {
  const rows = await q('SELECT kind, mime, size_bytes, created_at FROM pro_documents WHERE user_id = ? AND is_current = 1 ORDER BY kind', [req.user.id]);
  res.json({ items: rows.map((d) => ({ kind: d.kind, mime: d.mime, size: d.size_bytes, date: d.created_at })) });
});

// Envoi d'une pièce (multipart : champs « kind » et « file »), chiffrée avant d'être stockée
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 2 } });
router.post('/me/documents', limiter(60 * 60 * 1000, 30, 'Trop d\'envois, réessayez plus tard'), upload.single('file'), async (req, res) => {
  if (!req.file) throw new RangeError('Aucun fichier reçu (champ « file »)');
  const kind = String((req.body && req.body.kind) || '');
  const mime = checkDocument(req.file.buffer, kind);
  await tx(async (t) => {
    await t.q('UPDATE pro_documents SET is_current = 0 WHERE user_id = ? AND kind = ?', [req.user.id, kind]);
    await t.q('INSERT INTO pro_documents (user_id, kind, mime, size_bytes, sha256, content_enc) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, kind, mime, req.file.size, sha256(req.file.buffer), encrypt(req.file.buffer, config.dataKey)]);
    // Changer une pièce après validation remet le dossier en vérification
    await t.q("UPDATE pro_profiles SET verification_status = 'attente' WHERE user_id = ? AND verification_status IN ('valide','complement')", [req.user.id]);
  });
  await audit(req, req.user.id, 'document_uploaded', 'document', kind);
  res.status(201).json({ kind, mime, size: req.file.size });
});

router.get('/me/reviews', async (req, res) => {
  const rows = await q(
    `SELECT r.rating, r.comment, r.created_at, u.first_name, u.last_name FROM reviews r JOIN users u ON u.id = r.client_id
      WHERE r.pro_id = ? ORDER BY r.id DESC LIMIT 50`, [req.user.id]);
  res.json({ items: rows.map((r) => ({ rating: r.rating, comment: r.comment, author: shortName(r.first_name, r.last_name), date: r.created_at })) });
});

router.use('/notifications', notificationsRouter());

// ---------- Demandes : profil validé obligatoire pour en recevoir et y répondre ----------
router.use('/requests', requireVerifiedPro);

// Demandes reçues de l'administration. Le nom du client n'est jamais montré ; l'adresse seulement si l'offre est retenue.
router.get('/requests', async (req, res) => {
  const rows = await q(
    `SELECT r.id, r.ref, r.trade, r.title, r.description, r.zone, r.urgency, r.desired_at, r.status AS request_status,
            r.address, rp.status AS my_status, rp.price, rp.message, rp.sent_at, r.created_at
       FROM request_pros rp JOIN requests r ON r.id = rp.request_id
      WHERE rp.pro_id = ? AND rp.status IN ('envoye','propose','accepte') ORDER BY rp.sent_at DESC LIMIT 100`, [req.user.id]);
  res.json({
    items: rows.map((r) => ({
      id: r.id, ref: r.ref, trade: r.trade, title: r.title, description: r.description, zone: r.zone, urgency: r.urgency,
      desiredAt: r.desired_at, requestStatus: r.request_status, myStatus: r.my_status,
      price: r.price === null ? null : Number(r.price), message: r.message,
      address: r.my_status === 'accepte' ? r.address : null, receivedAt: r.sent_at, createdAt: r.created_at,
    })),
  });
});

router.post('/requests/:id/offer', limiter(60 * 60 * 1000, 60, 'Trop d\'offres envoyées, réessayez plus tard'), async (req, res) => {
  const id = v.id.parse(req.params.id);
  const b = schemas.offer.parse(req.body);
  const r = await tx(async (t) => {
    const [x] = await t.q('SELECT id, client_id, title, status FROM requests WHERE id = ? FOR UPDATE', [id]);
    if (!x) throw notFound('Demande');
    if (!['distribuee', 'proposee'].includes(x.status)) throw conflict('Cette demande n\'accepte plus d\'offres');
    const [rp] = await t.q('SELECT status FROM request_pros WHERE request_id = ? AND pro_id = ? FOR UPDATE', [id, req.user.id]);
    if (!rp || !['envoye', 'propose'].includes(rp.status)) throw notFound('Demande');
    await t.q("UPDATE request_pros SET status = 'propose', price = ?, message = ? WHERE request_id = ? AND pro_id = ?", [b.price, b.message || null, id, req.user.id]);
    await t.q("UPDATE requests SET status = 'proposee' WHERE id = ?", [id]);
    return x;
  });
  await notify(r.client_id, 'offer_received', 'Nouvelle offre reçue', `« ${r.title} » : ${b.price} FCFA proposés.`);
  await audit(req, req.user.id, 'request_offer', 'request', id, { price: b.price });
  res.status(201).json({ id, myStatus: 'propose', price: b.price });
});

router.post('/requests/:id/decline', async (req, res) => {
  const id = v.id.parse(req.params.id);
  const r = await q("UPDATE request_pros SET status = 'refuse' WHERE request_id = ? AND pro_id = ? AND status IN ('envoye','propose')", [id, req.user.id]);
  if (!r.affectedRows) throw notFound('Demande');
  await audit(req, req.user.id, 'request_declined', 'request', id);
  res.status(204).end();
});

// ---------- Réservations ----------
const BOOKING_COLS = `b.id, b.ref, b.mode, b.service, b.trade, b.status, b.address, b.description, b.scheduled_at,
  b.price, b.commission_rate, b.created_at, b.updated_at, b.client_id, cu.first_name AS client_first, cu.last_name AS client_last, cu.city AS client_city`;
const presentBooking = (r) => {
  const price = r.price === null ? null : Number(r.price);
  const rate = r.commission_rate === null ? null : Number(r.commission_rate);
  return {
    id: r.id, ref: r.ref, mode: r.mode, service: r.service, trade: r.trade, status: r.status, address: r.address,
    description: r.description, scheduledAt: r.scheduled_at, price, commissionRate: rate,
    net: price !== null && rate !== null ? commissionFor(price, rate).net : null,
    clientName: shortName(r.client_first, r.client_last), clientCity: r.client_city, createdAt: r.created_at, updatedAt: r.updated_at,
  };
};

async function loadBooking(id, proId) {
  const [r] = await q(`SELECT ${BOOKING_COLS} FROM bookings b JOIN users cu ON cu.id = b.client_id WHERE b.id = ? AND b.pro_id = ?`, [id, proId]);
  if (!r) throw notFound('Réservation');
  return presentBooking(r);
}

router.get('/bookings', async (req, res) => {
  const { group } = v.common.group.parse(req.query);
  const states = GROUPS[group];
  const rows = await q(
    `SELECT ${BOOKING_COLS} FROM bookings b JOIN users cu ON cu.id = b.client_id
      WHERE b.pro_id = ? AND b.status IN (${placeholders(states)}) ORDER BY b.created_at DESC LIMIT 100`, [req.user.id, ...states]);
  res.json({ items: rows.map(presentBooking) });
});

router.get('/bookings/:id', async (req, res) => res.json(await loadBooking(v.id.parse(req.params.id), req.user.id)));

const NOTICES = {
  accept: 'Réservation acceptée : vous pouvez payer',
  decline: 'Réservation refusée par le prestataire',
  quote: 'Devis reçu : à accepter ou refuser',
  start: 'Le prestataire a commencé les travaux',
  finish: 'Travaux terminés : confirmez la prestation',
};

function proAction(action) {
  return async (req, res) => {
    const id = v.id.parse(req.params.id);
    const body = action === 'quote' ? schemas.quote.parse(req.body) : {};
    const result = await tx(async (t) => {
      const [b] = await t.q('SELECT id, ref, client_id, status, trade, price FROM bookings WHERE id = ? AND pro_id = ? FOR UPDATE', [id, req.user.id]);
      if (!b) throw notFound('Réservation');
      const next = nextState('pro', b.status, action);
      if (!next) throw conflict('Action impossible dans l\'état actuel', 'invalid_transition');
      if (action === 'accept') {
        if (b.price === null) throw conflict('Aucun prix défini', 'no_price');
        const rate = await currentRate(t, b.trade);
        commissionFor(Number(b.price), rate);
        await t.q('UPDATE bookings SET status = ?, commission_rate = ? WHERE id = ?', [next, rate, id]);
      } else if (action === 'quote') {
        await t.q('UPDATE bookings SET status = ?, price = ? WHERE id = ?', [next, body.price, id]);
      } else {
        await t.q('UPDATE bookings SET status = ? WHERE id = ?', [next, id]);
      }
      return { clientId: b.client_id, ref: b.ref, from: b.status, to: next };
    });
    await notify(result.clientId, `booking_${action}`, `${NOTICES[action]} (${result.ref})`, action === 'quote' ? `${body.price} FCFA` : '');
    await audit(req, req.user.id, `booking_pro_${action}`, 'booking', id, { from: result.from, to: result.to });
    res.json(await loadBooking(id, req.user.id));
  };
}

for (const action of ['accept', 'decline', 'quote', 'start', 'finish']) router.post(`/bookings/:id/${action}`, proAction(action));

const msgs = bookingMessages('pro_id');
router.get('/bookings/:id/messages', msgs.list);
router.post('/bookings/:id/messages', limiter(60 * 1000, 60, 'Trop de messages, patientez un instant'), msgs.send);

// ---------- Portefeuille (calculé côté serveur) ----------
const NET_SQL = 'b.price - ROUND(b.price * COALESCE(b.commission_rate, 15) / 100)';

async function balances(t, userId) {
  const [c] = await t.q(`SELECT COALESCE(SUM(${NET_SQL}), 0) AS net, COUNT(*) AS n FROM bookings b WHERE b.pro_id = ? AND b.status = 'terminee'`, [userId]);
  const [p] = await t.q(`SELECT COALESCE(SUM(${NET_SQL}), 0) AS net FROM bookings b WHERE b.pro_id = ? AND b.status IN ('payee','en_cours','fin_signalee','litige')`, [userId]);
  const [w] = await t.q(
    `SELECT COALESCE(SUM(CASE WHEN status IN ('demande','en_cours') THEN amount END), 0) AS pending,
            COALESCE(SUM(CASE WHEN status = 'verse' THEN amount END), 0) AS withdrawn
       FROM withdrawals WHERE user_id = ?`, [userId]);
  const earned = Number(c.net);
  const pending = Number(w.pending);
  const withdrawn = Number(w.withdrawn);
  return {
    earned, // net des prestations terminées
    upcoming: Number(p.net), // net des prestations payées, pas encore confirmées
    pendingWithdrawals: pending,
    withdrawn,
    available: earned - pending - withdrawn,
    completedMissions: Number(c.n),
    minWithdrawal: config.minWithdrawal,
  };
}

router.get('/wallet', async (req, res) => res.json(await balances({ q }, req.user.id)));

router.get('/wallet/withdrawals', async (req, res) => {
  const rows = await q('SELECT id, ref, amount, method, status, reason, created_at FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 100', [req.user.id]);
  res.json({ items: rows.map((r) => ({ id: r.id, ref: r.ref, amount: Number(r.amount), method: r.method, status: r.status, reason: r.reason, date: r.created_at })) });
});

// Solde vérifié et retrait enregistré dans la même transaction, profil verrouillé (pas de double retrait)
router.post('/wallet/withdrawals', limiter(60 * 60 * 1000, 10, 'Trop de demandes de retrait'), async (req, res) => {
  const b = schemas.withdrawal.parse(req.body);
  const id = await tx(async (t) => {
    await t.q('SELECT user_id FROM pro_profiles WHERE user_id = ? FOR UPDATE', [req.user.id]);
    const bal = await balances(t, req.user.id);
    checkWithdrawal({ amount: b.amount, available: bal.available, minimum: config.minWithdrawal });
    const r = await t.q("INSERT INTO withdrawals (user_id, amount, method, number_enc) VALUES (?, ?, ?, ?)",
      [req.user.id, b.amount, b.method, sealText(b.number, config.dataKey)]);
    await t.q("UPDATE withdrawals SET ref = CONCAT('RET-', id) WHERE id = ?", [r.insertId]);
    return r.insertId;
  });
  await audit(req, req.user.id, 'withdrawal_requested', 'withdrawal', id, { amount: b.amount });
  res.status(201).json({ id, ref: `RET-${id}`, status: 'demande' });
});

module.exports = router;
