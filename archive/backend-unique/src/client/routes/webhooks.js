'use strict';
// Notifications du prestataire de paiement. Seule source de vérité pour « payé ».
// Corps brut lu tel quel pour contrôler la signature HMAC avant tout traitement.
const express = require('express');
const config = require('../../config');
const { q, tx } = require('../../db');
const { schemas } = require('../validation');
const { HttpError, asyncHandler } = require('../../errors');
const { verifyWebhook } = require('../security/webhook');
const { audit } = require('../../services/audit');
const { notifyUser } = require('../../services/notify');

const router = express.Router();

router.post(
  '/payments',
  express.raw({ type: 'application/json', limit: '16kb' }),
  asyncHandler(async (req, res) => {
    const raw = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    if (!verifyWebhook(config.webhookSecret, req.get('x-ouvrage-signature'), raw)) {
      await audit(null, 'webhook_signature_invalid', 'payment', 'inconnu', req);
      throw new HttpError(401, 'bad_signature', 'Signature invalide');
    }
    let body;
    try { body = JSON.parse(raw); } catch (e) { throw new HttpError(400, 'bad_json', 'JSON invalide'); }
    const evt = schemas.paymentWebhook.parse(body);

    const outcome = await tx(async (t) => {
      const rows = await t.q(
        `SELECT p.id, p.booking_id, p.amount, p.status AS pstatus, b.status AS bstatus, b.price
           FROM payments p JOIN bookings b ON b.id = p.booking_id
          WHERE p.reference = ? FOR UPDATE`,
        [evt.reference],
      );
      const p = rows[0];
      if (!p) return 'unknown';
      if (p.pstatus !== 'pending') return 'already_processed'; // idempotence : rejeu sans effet

      if (evt.status === 'failed') {
        await t.q("UPDATE payments SET status = 'failed' WHERE id = ?", [p.id]);
        return 'failed';
      }
      // Montant contrôlé contre celui de la réservation, jamais contre la notification seule
      if (evt.amount !== p.amount || p.amount !== p.price) {
        await t.q("UPDATE payments SET status = 'failed' WHERE id = ?", [p.id]);
        return 'amount_mismatch';
      }
      await t.q("UPDATE payments SET status = 'success' WHERE id = ?", [p.id]);
      if (p.bstatus === 'a_payer') {
        await t.q("UPDATE bookings SET status = 'payee' WHERE id = ?", [p.booking_id]);
      }
      return 'success';
    });

    if (outcome === 'success') {
      const [owner] = await q(
        'SELECT b.client_id, b.ref FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.reference = ?',
        [evt.reference],
      );
      if (owner) await notifyUser(owner.client_id, 'payment_received', 'Paiement reçu', `Réservation ${owner.ref} : paiement confirmé.`);
    }
    await audit(null, `payment_${outcome}`, 'payment', evt.reference, req);
    res.json({ received: true, outcome: outcome === 'success' ? 'processed' : outcome });
  }),
);

module.exports = router;
