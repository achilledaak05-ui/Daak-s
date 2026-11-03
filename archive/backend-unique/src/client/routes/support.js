'use strict';
// Support : chaque client a un fil de messages avec l'équipe Ouvrage.
const express = require('express');
const { q } = require('../../db');
const { schemas } = require('../validation');
const { asyncHandler } = require('../../errors');
const { requireAuth, requireRole } = require('../security/middleware');

const router = express.Router();
router.use(requireAuth, requireRole('client'));

router.get('/messages', asyncHandler(async (req, res) => {
  const rows = await q(
    'SELECT id, sender, body, created_at FROM support_messages WHERE user_id = ? ORDER BY id DESC LIMIT 100',
    [req.user.id],
  );
  res.json({ items: rows.reverse().map((m) => ({ id: m.id, sender: m.sender, body: m.body, date: m.created_at })) });
}));

router.post('/messages', asyncHandler(async (req, res) => {
  const b = schemas.message.parse(req.body);
  await q("INSERT INTO support_messages (user_id, sender, body) VALUES (?, 'client', ?)", [req.user.id, b.body]);
  res.status(201).json({ ok: true });
}));

module.exports = router;
