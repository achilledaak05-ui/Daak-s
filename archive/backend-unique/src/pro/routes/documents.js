'use strict';
// Pièces justificatives : envoi chiffré, type vérifié sur le contenu, historique conservé.
const express = require('express');
const multer = require('multer');
const { q, tx } = require('../../db');
const { asyncHandler } = require('../../errors');
const { requireAuth, requireRole } = require('../security/middleware');
const { checkDocument, MAX_BYTES } = require('../../domain/documents');
const { storeEncrypted } = require('../../security/documents');
const { audit } = require('../../services/audit');

const router = express.Router();
router.use(requireAuth, requireRole('pro'));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

router.post('/', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw new RangeError('Aucun fichier reçu');
  const kind = String(req.body.kind || '');
  const type = checkDocument(req.file.buffer, kind);
  const { createHash } = require('node:crypto');
  const sha256 = createHash('sha256').update(req.file.buffer).digest('hex');
  const storageName = await storeEncrypted(req.file.buffer);
  await tx(async (t) => {
    // Changer une pièce après validation remet le dossier en attente de nouvelle vérification
    await t.q('UPDATE pro_documents SET is_current = 0 WHERE user_id = ? AND kind = ?', [req.user.id, kind]);
    await t.q(
      'INSERT INTO pro_documents (user_id, kind, storage_name, mime, size_bytes, sha256, is_current) VALUES (?, ?, ?, ?, ?, ?, 1)',
      [req.user.id, kind, storageName, type.mime, req.file.size, sha256],
    );
    await t.q(
      "UPDATE pro_profiles SET verification_status = 'attente' WHERE user_id = ? AND verification_status = 'valide'",
      [req.user.id],
    );
  });
  await audit(req.user.id, 'document_uploaded', 'document', kind, req);
  res.status(201).json({ kind, mime: type.mime, size: req.file.size });
}));

router.get('/', asyncHandler(async (req, res) => {
  const rows = await q(
    'SELECT kind, mime, size_bytes, created_at FROM pro_documents WHERE user_id = ? AND is_current = 1 ORDER BY kind',
    [req.user.id],
  );
  res.json({ items: rows.map((d) => ({ kind: d.kind, mime: d.mime, size: d.size_bytes, date: d.created_at })) });
}));

module.exports = router;
