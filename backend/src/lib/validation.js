'use strict';
// Briques de validation communes. Les objets sont stricts : un champ inconnu est refusé.
const { z } = require('zod');

const TRADES = ['Plomberie', 'Électricité', 'Menuiserie', 'Peinture', 'Maçonnerie', 'Climatisation', 'Nettoyage', 'Autres services'];
const PAYMENT_METHODS = ['Wave', 'Orange Money', 'MTN Mobile Money', 'Moov Money', 'Carte Visa / Mastercard'];
const WITHDRAW_METHODS = ['Wave', 'Orange Money', 'MTN Mobile Money', 'Moov Money', 'Virement bancaire'];
const DISPUTE_TYPES = ['Prestation non conforme', 'Travaux non réalisés', 'Comportement du prestataire', 'Autre'];

const text = (min, max) => z.string().trim().min(min).max(max);
const contact = z.string().trim().max(190).refine(
  (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^\+?\d{8,15}$/.test(v.replace(/\s/g, '')),
  'Email ou téléphone invalide',
);
const password = z.string().min(8, 'Mot de passe trop court (8 caractères minimum)').max(128);
const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const money = z.number().int().min(0).max(10000000);
const isoDate = z.string().datetime({ offset: true });

const normalizeContact = (v) => v.trim().toLowerCase().replace(/\s/g, '');

const common = {
  login: z.object({ contact: text(3, 190), password: z.string().min(1).max(128), totp: z.string().trim().max(10).optional() }).strict(),
  refresh: z.object({ refreshToken: z.string().min(20).max(200) }).strict(),
  password: z.object({ password: z.string().min(1).max(128) }).strict(),
  message: z.object({ body: text(1, 2000) }).strict(),
  motif: z.object({ motif: text(3, 500) }).strict(),
  group: z.object({ group: z.enum(['en', 'ter', 'ann']).default('en') }),
};

module.exports = {
  z, text, contact, password, id, money, isoDate, common, normalizeContact,
  TRADES, PAYMENT_METHODS, WITHDRAW_METHODS, DISPUTE_TYPES,
};
