'use strict';
// Effets d'un paiement confirmé, partagés par le mode sandbox et la notification signée du prestataire.
// À appeler dans une transaction, paiement verrouillé
async function confirmPayment(t, paymentId) {
  const [p] = await t.q(
    `SELECT p.id, p.booking_id, p.amount, p.status, b.status AS bstatus, b.price
       FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.id = ? FOR UPDATE`,
    [paymentId],
  );
  if (!p) return 'unknown';
  if (p.status !== 'pending') return 'already_processed';
  if (p.amount !== p.price) {
    await t.q("UPDATE payments SET status = 'failed' WHERE id = ?", [p.id]);
    return 'amount_mismatch';
  }
  // Réservation annulée pendant le paiement : l'argent reçu est à rembourser
  if (p.bstatus !== 'a_payer') {
    await t.q("UPDATE payments SET status = 'refund_pending' WHERE id = ?", [p.id]);
    return 'refund_needed';
  }
  await t.q("UPDATE payments SET status = 'success' WHERE id = ?", [p.id]);
  await t.q("UPDATE bookings SET status = 'payee' WHERE id = ?", [p.booking_id]);
  return 'success';
}

// Taux de commission courant d'un métier (figé ensuite sur la réservation)
async function currentRate(t, trade) {
  const [r] = await t.q('SELECT rate FROM commission_rates WHERE trade = ?', [trade]);
  return r ? Number(r.rate) : 15;
}

module.exports = { confirmPayment, currentRate };
