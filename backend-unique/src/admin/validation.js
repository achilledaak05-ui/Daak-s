'use strict';
const { z } = require('zod');

const text = (min, max) => z.string().trim().min(min).max(max);
const idParam = z.string().regex(/^\d{1,18}$/).transform(Number);
const TRADES = ['Plomberie', 'Électricité', 'Menuiserie', 'Peinture', 'Maçonnerie', 'Climatisation', 'Nettoyage', 'Autres services'];

const schemas = {
  login: z.object({
    contact: z.string().trim().min(3).max(190),
    password: z.string().min(1).max(128),
    totp: z.string().regex(/^\d{6}$/).optional(),
  }).strict(),
  refresh: z.object({ refreshToken: z.string().min(20).max(200) }).strict(),
  motif: z.object({ motif: text(3, 500) }).strict(),
  decision: z.object({
    decision: z.enum(['valide', 'refuse', 'complement']),
    motif: text(0, 500).optional(),
  }).strict(),
  dispute: z.object({
    decision: z.enum(['client', 'pro']),
    motif: text(5, 500),
  }).strict(),
  rates: z.object({
    rates: z.array(z.object({ trade: z.enum(TRADES), rate: z.number().min(0).max(50) }).strict()).min(1).max(8),
  }).strict(),
  message: z.object({ body: text(1, 2000) }).strict(),
  group: z.object({ group: z.enum(['en', 'ter', 'ann']).default('en') }).strict(),
  changePassword: z.object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(12, 'Mot de passe trop court (12 caractères minimum)').max(128),
  }).strict(),
  resetTotp: z.object({
    password: z.string().min(1).max(128),
    totp: z.string().regex(/^\d{6}$/),
  }).strict(),
};

module.exports = { schemas, idParam, TRADES };
