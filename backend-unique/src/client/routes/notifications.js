'use strict';
// Notifications du client (in-app)
const express = require('express');
const { q } = require('../../db');
const { asyncHandler } = require('../../errors');
const { requireAuth, requireRole } = require('../security/middleware');

const router = express.Router();
router.use(requireAuth, requireRole('client'));

router.get('/', asyncHandler(async (req, res) => {
  const rows = await q(
    'SELECT id, kind, title, body, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50',
    [req.user.id],
  );
  const [count] = await q('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
  res.json({
    unread: count.n,
    items: rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, read: !!n.read_at, date: n.created_at })),
  });
}));

router.post('/read', asyncHandler(async (req, res) => {
  await q('UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
  res.status(204).end();
}));

module.exports = router;
