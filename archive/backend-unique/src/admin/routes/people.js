'use strict';
// Prestataires et clients : validation des dossiers, pièces (lecture tracée), suspension et réactivation
const express = require('express');
const { q, tx } = require('../../db');
const { schemas, idParam } = require('../validation');
const { HttpError, asyncHandler } = require('../../errors');
const { requireAdmin } = require('../security/middleware');
const { readDecrypted } = require('../../security/documents');
const { audit } = require('../../services/audit');
const { notifyUser } = require('../../services/notify');

const router = express.Router();
router.use(requireAdmin);

router.get('/pros', asyncHandler(async (req, res) => {
  const f = req.query.status;
  const where = f === 'suspendus' ? 'u.status = \'suspended\'' : ['attente', 'valide', 'refuse', 'complement'].includes(f) ? `pp.verification_status = '${f}'` : '1=1';
  const rows = await q(
    `SELECT u.id, u.first_name, u.last_name, u.city, u.contact, u.status, pp.verification_status, pp.rating_sum, pp.rating_count, pp.available,
            (SELECT GROUP_CONCAT(trade) FROM pro_trades WHERE user_id = u.id) AS trades
       FROM users u JOIN pro_profiles pp ON pp.user_id = u.id WHERE u.role = 'pro' AND ${where} ORDER BY u.id DESC LIMIT 200`,
  );
  res.json({ items: rows.map((r) => ({ id: r.id, name: `${r.first_name} ${r.last_name}`, city: r.city, contact: r.contact, status: r.status,
    verification: r.verification_status, available: !!r.available, trades: r.trades ? r.trades.split(',') : [], rating: r.rating_count ? Number((r.rating_sum / r.rating_count).toFixed(1)) : null })) });
}));

router.get('/pros/:id', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const [u] = await q(
    `SELECT u.id, u.first_name, u.last_name, u.city, u.contact, u.status, pp.bio, pp.base_price, pp.verification_status, pp.available
       FROM users u JOIN pro_profiles pp ON pp.user_id = u.id WHERE u.id = ? AND u.role = 'pro'`, [id]);
  if (!u) throw new HttpError(404, 'not_found', 'Prestataire introuvable');
  const trades = await q('SELECT trade FROM pro_trades WHERE user_id = ?', [id]);
  const zones = await q('SELECT zone FROM pro_zones WHERE user_id = ?', [id]);
  const docs = await q('SELECT id, kind, mime, size_bytes, created_at FROM pro_documents WHERE user_id = ? AND is_current = 1', [id]);
  await audit(req.user.id, 'pro_viewed', 'user', id, req);
  res.json({ id: u.id, name: `${u.first_name} ${u.last_name}`, city: u.city, contact: u.contact, status: u.status, bio: u.bio || '',
    basePrice: u.base_price, verification: u.verification_status, available: !!u.available,
    trades: trades.map((t) => t.trade), zones: zones.map((z) => z.zone),
    documents: docs.map((d) => ({ id: d.id, kind: d.kind, mime: d.mime, size: d.size_bytes, date: d.created_at })) });
}));

// Lecture d'une pièce : déchiffrement à la demande, chaque lecture est journalisée
router.get('/pros/:id/documents/:kind', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  if (!['cni', 'naiss', 'diplome'].includes(req.params.kind)) throw new HttpError(400, 'invalid', 'Type de pièce inconnu');
  const [d] = await q('SELECT storage_name, mime, sha256 FROM pro_documents WHERE user_id = ? AND kind = ? AND is_current = 1', [id, req.params.kind]);
  if (!d) throw new HttpError(404, 'not_found', 'Pièce introuvable');
  const plain = await readDecrypted(d.storage_name);
  await audit(req.user.id, 'document_read', 'user', id, req, { kind: req.params.kind });
  res.setHeader('Content-Type', d.mime);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'no-store');
  res.send(plain);
}));

// Décision sur un dossier : valider exige la carte d'identité et l'extrait de naissance
router.post('/pros/:id/decision', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const b = schemas.decision.parse(req.body);
  if (b.decision !== 'valide' && !b.motif) throw new HttpError(400, 'invalid', 'Indiquez un motif');
  await tx(async (t) => {
    const [p] = await t.q("SELECT user_id FROM pro_profiles pp JOIN users u ON u.id = pp.user_id WHERE pp.user_id = ? AND u.role = 'pro' FOR UPDATE", [id]);
    if (!p) throw new HttpError(404, 'not_found', 'Prestataire introuvable');
    if (b.decision === 'valide') {
      const docs = (await t.q('SELECT kind FROM pro_documents WHERE user_id = ? AND is_current = 1', [id])).map((d) => d.kind);
      if (!docs.includes('cni') || !docs.includes('naiss')) throw new HttpError(409, 'missing_documents', 'Carte d\'identité et extrait de naissance requis');
    }
    await t.q('UPDATE pro_profiles SET verification_status = ? WHERE user_id = ?', [b.decision, id]);
  });
  const texts = { valide: ['Profil validé', 'Votre profil est visible par les clients.'], refuse: ['Dossier refusé', b.motif], complement: ['Complément demandé', b.motif] };
  await notifyUser(id, `verification_${b.decision}`, texts[b.decision][0], texts[b.decision][1] || '');
  await audit(req.user.id, `verification_${b.decision}`, 'user', id, req, { motif: b.motif || null });
  res.json({ id, verification: b.decision });
}));

router.get('/clients', asyncHandler(async (req, res) => {
  const rows = await q("SELECT id, first_name, last_name, city, contact, status, created_at FROM users WHERE role = 'client' ORDER BY id DESC LIMIT 200");
  res.json({ items: rows.map((u) => ({ id: u.id, name: `${u.first_name} ${u.last_name}`, city: u.city, contact: u.contact, status: u.status, date: u.created_at })) });
}));

// Suspension : le compte ne peut plus se connecter, ses sessions sont révoquées, un prestataire ne reçoit plus de demandes
async function setStatus(req, res, status) {
  const id = idParam.parse(req.params.id);
  const b = status === 'suspended' ? schemas.motif.parse(req.body) : { motif: '' };
  const [u] = await q("SELECT id, role FROM users WHERE id = ? AND role IN ('client','pro')", [id]);
  if (!u) throw new HttpError(404, 'not_found', 'Compte introuvable');
  await tx(async (t) => {
    await t.q('UPDATE users SET status = ? WHERE id = ?', [status, id]);
    if (status === 'suspended') await t.q('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [id]);
  });
  if (status === 'suspended') await notifyUser(id, 'account_suspended', 'Compte suspendu', b.motif);
  await audit(req.user.id, status === 'suspended' ? 'account_suspended' : 'account_reactivated', 'user', id, req, { motif: b.motif || null });
  res.json({ id, status });
}
router.post('/users/:id/suspend', asyncHandler((req, res) => setStatus(req, res, 'suspended')));
router.post('/users/:id/reactivate', asyncHandler((req, res) => setStatus(req, res, 'active')));

module.exports = router;
