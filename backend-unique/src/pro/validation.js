'use strict';
const { z } = require('zod');

const text = (min, max) => z.string().trim().min(min).max(max);
const contact = z.string().trim().max(190).refine(
  (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^\+?\d{8,15}$/.test(v.replace(/\s/g, '')),
  'Email ou téléphone invalide',
);
const password = z.string().min(8, 'Mot de passe trop court').max(128);
const idParam = z.string().regex(/^\d{1,18}$/).transform(Number);
const TRADES = ['Plomberie', 'Électricité', 'Menuiserie', 'Peinture', 'Maçonnerie', 'Climatisation', 'Nettoyage', 'Autres services'];
const WITHDRAW_METHODS = ['Wave', 'Orange Money', 'MTN Mobile Money', 'Moov Money', 'Virement bancaire'];

const schemas = {
  register: z.object({
    firstName: text(1, 80),
    lastName: text(1, 80),
    contact,
    password,
    city: text(2, 80),
    trades: z.array(z.enum(TRADES)).min(1).max(8),
    zones: z.array(text(1, 120)).min(1).max(20),
    bio: text(0, 1000).optional(),
  }).strict(),
  login: z.object({ contact: z.string().trim().min(3).max(190), password: z.string().min(1).max(128) }).strict(),
  refresh: z.object({ refreshToken: z.string().min(20).max(200) }).strict(),
  patchMe: z.object({
    city: text(2, 80).optional(),
    bio: text(0, 1000).optional(),
    basePrice: z.number().int().min(0).max(10000000).optional(),
    available: z.boolean().optional(),
  }).strict(),
  trades: z.object({ trades: z.array(z.enum(TRADES)).min(1).max(8) }).strict(),
  zones: z.object({ zones: z.array(text(1, 120)).min(1).max(20) }).strict(),
  deleteMe: z.object({ password: z.string().min(1).max(128) }).strict(),
  offer: z.object({
    price: z.number().int().min(1).max(10000000),
    message: text(0, 1000).optional(),
  }).strict(),
  reason: z.object({ reason: text(3, 500).optional() }).strict(),
  message: z.object({ body: text(1, 2000) }).strict(),
  withdrawal: z.object({
    amount: z.number().int().min(1).max(10000000),
    method: z.enum(WITHDRAW_METHODS),
    number: text(6, 40),
  }).strict(),
  bookingGroup: z.object({ group: z.enum(['en', 'ter', 'ann']).default('en') }).strict(),
};

module.exports = { schemas, idParam, TRADES };
