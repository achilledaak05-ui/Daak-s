'use strict';
// Toutes les entrées passent par ces schémas. Les objets sont stricts : champ inconnu = refus.
const { z } = require('zod');

const text = (min, max) => z.string().trim().min(min).max(max);
const contact = z.string().trim().max(190).refine(
  (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^\+?\d{8,15}$/.test(v.replace(/\s/g, '')),
  'Email ou téléphone invalide',
);
const password = z.string().min(8, 'Mot de passe trop court').max(128);
const idParam = z.string().regex(/^\d{1,18}$/).transform(Number);
const TRADES = ['Plomberie', 'Électricité', 'Menuiserie', 'Peinture', 'Maçonnerie', 'Climatisation', 'Nettoyage', 'Autres services'];
const METHODS = ['Wave', 'Orange Money', 'MTN Mobile Money', 'Moov Money', 'Carte Visa / Mastercard'];
const DISPUTE_TYPES = ['Prestation non conforme', 'Travaux non réalisés', 'Comportement du prestataire', 'Autre'];

const schemas = {
  register: z.object({
    firstName: text(1, 80),
    lastName: text(1, 80),
    contact,
    password,
    city: text(2, 80),
    zone: text(0, 120).optional(),
  }).strict(),

  login: z.object({
    contact: z.string().trim().min(3).max(190),
    password: z.string().min(1).max(128),
  }).strict(),

  refresh: z.object({ refreshToken: z.string().min(20).max(200) }).strict(),

  patchMe: z.object({
    firstName: text(1, 80).optional(),
    lastName: text(1, 80).optional(),
    city: text(2, 80).optional(),
    zone: text(0, 120).optional(),
  }).strict(),

  deleteMe: z.object({ password: z.string().min(1).max(128) }).strict(),

  proSearch: z.object({
    trade: z.enum(TRADES).optional(),
    city: text(1, 80).optional(),
    q: text(1, 80).optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
  }).strict(),

  createBooking: z.object({
    proId: z.number().int().positive(),
    trade: z.enum(TRADES),
    service: text(2, 120),
    mode: z.enum(['immediat', 'devis']),
    scheduledAt: z.string().datetime({ offset: true }).optional(),
    address: text(3, 255),
    description: text(3, 2000),
  }).strict(),

  bookingGroup: z.object({
    group: z.enum(['en', 'ter', 'ann']).default('en'),
  }).strict(),

  reason: z.object({ reason: text(3, 500) }).strict(),

  dispute: z.object({
    type: z.enum(DISPUTE_TYPES),
    description: text(10, 3000),
  }).strict(),

  review: z.object({
    rating: z.number().int().min(1).max(5),
    comment: text(3, 1000),
  }).strict(),

  message: z.object({ body: text(1, 2000) }).strict(),

  // Demande : le client décrit son besoin, sans choisir de prestataire
  createRequest: z.object({
    trade: z.enum(TRADES),
    title: text(2, 120),
    description: text(10, 2000),
    address: text(3, 255),
    zone: text(1, 120),
    urgency: z.enum(['aujourdhui', 'semaine', 'libre']),
    desiredAt: z.string().datetime({ offset: true }).optional(),
  }).strict(),

  chooseProposal: z.object({ proId: z.number().int().positive() }).strict(),

  initiatePayment: z.object({ method: z.enum(METHODS) }).strict(),

  // Notification du prestataire de paiement (le montant est recontrôlé côté serveur)
  paymentWebhook: z.object({
    reference: z.string().min(16).max(64),
    status: z.enum(['success', 'failed']),
    amount: z.number().int().positive(),
  }).strict(),
};

module.exports = { schemas, idParam, TRADES, METHODS, DISPUTE_TYPES };
