'use strict';
// Choix des prestataires à qui envoyer une demande. Sans dépendance : testable sans base.
// `pool` vient de la base : prestataires déjà filtrés (vérifiés, actifs, disponibles, bon métier, bonne zone).

function pickPros(pool, alreadySent, limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new RangeError('Nombre de prestataires invalide (1 à 10)');
  }
  const sent = new Set(alreadySent);
  return pool
    .filter((p) => !sent.has(p.id))
    .sort((a, b) => (b.rating || 0) - (a.rating || 0) || a.id - b.id)
    .slice(0, limit)
    .map((p) => p.id);
}

module.exports = { pickPros };
