'use strict';
// Routes identiques pour le client et le prestataire : connexion, notifications, messages, suppression du compte.
const express = require('express');
const { q, tx } = require('../db');
const { HttpError, notFound } = require('../errors');
const { common, normalizeContact, id: idSchema } = require('../lib/validation');
const { verifyPassword, DUMMY_HASH } = require('../lib/password');
const { openSession, refreshHandler, logoutHandler, revokeAll, ROLE } = require('./auth');
const { audit } = require('../services/audit');
const { limiter } = require('../http');

// /auth/login, /auth/refresh, /auth/logout (l'inscription est propre à chaque espace)
function authRouter(space, register) {
  const r = express.Router();
  const authLimit = limiter(15 * 60 * 1000, 20, 'Trop de tentatives, réessayez dans quelques minutes');
  if (register) r.post('/register', authLimit, register);
  r.post('/login', authLimit, async (req, res) => {
    const b = common.login.parse(req.body);
    const [u] = await q('SELECT id, role, status, password_hash FROM users WHERE contact = ?', [normalizeContact(b.contact)]);
    const ok = await verifyPassword(b.password, u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok || u.role !== ROLE[space] || u.status !== 'active') {
      await audit(req, u ? u.id : null, 'login_failed', 'user', u ? u.id : 'inconnu', { space });
      const suspended = u && ok && u.status === 'suspended';
      throw new HttpError(401, suspended ? 'account_suspended' : 'invalid_credentials',
        suspended ? 'Compte suspendu : contactez le support' : 'Identifiant ou mot de passe incorrect');
    }
    const session = await tx((t) => openSession(t, space, u.id));
    await audit(req, u.id, 'login', 'user', u.id, { space });
    res.json({ user: { id: u.id, role: u.role }, ...session });
  });
  r.post('/refresh', authLimit, refreshHandler(space));
  r.post('/logout', logoutHandler(space));
  return r;
}

function notificationsRouter() {
  const r = express.Router();
  r.get('/', async (req, res) => {
    const rows = await q('SELECT id, kind, title, body, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', [req.user.id]);
    const [c] = await q('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
    res.json({
      unread: Number(c.n),
      items: rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, read: !!n.read_at, date: n.created_at })),
    });
  });
  r.post('/read', async (req, res) => {
    await q('UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
    res.status(204).end();
  });
  return r;
}

// Messages d'une réservation : seul le client ou le prestataire de la réservation y a accès
function bookingMessages(ownerColumn) {
  const owned = async (req) => {
    const bookingId = idSchema.parse(req.params.id);
    const [b] = await q(`SELECT id FROM bookings WHERE id = ? AND ${ownerColumn} = ?`, [bookingId, req.user.id]);
    if (!b) throw notFound('Réservation');
    return bookingId;
  };
  return {
    list: async (req, res) => {
      const bookingId = await owned(req);
      const rows = await q('SELECT id, sender_id, body, created_at FROM messages WHERE booking_id = ? ORDER BY id DESC LIMIT 100', [bookingId]);
      res.json({ items: rows.reverse().map((m) => ({ id: m.id, mine: m.sender_id === req.user.id, body: m.body, date: m.created_at })) });
    },
    send: async (req, res) => {
      const bookingId = await owned(req);
      const b = common.message.parse(req.body);
      const r = await q('INSERT INTO messages (booking_id, sender_id, body) VALUES (?, ?, ?)', [bookingId, req.user.id, b.body]);
      res.status(201).json({ id: r.insertId });
    },
  };
}

// Suppression du compte : anonymisation, sessions révoquées, historique (réservations, avis) conservé
async function deleteAccount(req, extra) {
  const b = common.password.parse(req.body);
  const [u] = await q("SELECT password_hash FROM users WHERE id = ? AND status = 'active'", [req.user.id]);
  if (!u || !(await verifyPassword(b.password, u.password_hash))) throw new HttpError(403, 'forbidden', 'Mot de passe incorrect');
  await tx(async (t) => {
    await t.q(`UPDATE users SET status = 'deleted', contact = CONCAT('supprime-', id, '@invalid.local'),
                 first_name = 'Compte', last_name = 'supprimé', zone = NULL, password_hash = '!' WHERE id = ?`, [req.user.id]);
    if (extra) await extra(t);
    await revokeAll(t, req.user.id);
  });
  await audit(req, req.user.id, 'account_deleted', 'user', req.user.id);
}

module.exports = { authRouter, notificationsRouter, bookingMessages, deleteAccount };
