'use strict';
// Notification signée du prestataire de paiement : seule source de vérité pour « payé ».
// En-tête X-Ouvrage-Signature : "t=<unix>,v1=<hmac-sha256 hex de `${t}.${corps brut}`>", valable 5 minutes.
const express = require('express');
const crypto = require('node:crypto');
const config = require('./config');
const { tx, q } = require('./db');
const { HttpError } = require('./errors');
const { z } = require('./lib/validation');
const { confirmPayment } = require('./services/bookingFlow');
const { audit } = require('./services/audit');
const { notify } = require('./services/notify');

const TOLERANCE_SECONDS = 300;
const sign = (secret, t, raw) => crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');

function verifySignature(secret, header, raw, now = Math.floor(Date.now() / 1000)) {
  if (typeof header !== 'string') return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.trim().split('=')).filter((kv) => kv.length === 2));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(now - t) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(sign(secret, t, raw), 'hex');
  const received = Buffer.from(parts.v1, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

const eventSchema = z.object({
  reference: z.string().min(16).max(64),
  status: z.enum(['success', 'failed']),
  amount: z.number().int().positive(),
}).strict();

const router = express.Router();

router.post('/payments', express.raw({ type: 'application/json', limit: '16kb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!verifySignature(config.webhookSecret, req.get('x-ouvrage-signature'), raw)) {
    await audit(req, null, 'webhook_signature_invalid', 'payment', 'inconnu');
    throw new HttpError(401, 'bad_signature', 'Signature invalide');
  }
  let body;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'bad_json', 'JSON invalide'); }
  const evt = eventSchema.parse(body);
  const [p] = await q('SELECT id, amount FROM payments WHERE reference = ?', [evt.reference]);
  let outcome = 'unknown';
  if (p) {
    outcome = await tx(async (t) => {
      if (evt.status === 'failed') {
        const r = await t.q("UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'", [p.id]);
        return r.affectedRows ? 'failed' : 'already_processed';
      }
      // Montant contrôlé contre celui enregistré, jamais contre la seule notification
      if (evt.amount !== Number(p.amount)) {
        await t.q("UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'", [p.id]);
        return 'amount_mismatch';
      }
      return confirmPayment(t, p.id);
    });
  }
  if (outcome === 'success') {
    const [b] = await q('SELECT b.client_id, b.pro_id, b.ref FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.id = ?', [p.id]);
    await notify(b.client_id, 'payment_received', 'Paiement confirmé', `Réservation ${b.ref}`);
    await notify(b.pro_id, 'booking_paid', `Réservation payée (${b.ref})`, 'Vous pouvez démarrer la prestation.');
  }
  await audit(req, null, `payment_${outcome}`, 'payment', evt.reference);
  res.json({ received: true, outcome });
});

module.exports = { router, verifySignature, sign };
