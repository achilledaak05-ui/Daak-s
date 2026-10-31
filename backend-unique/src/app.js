'use strict';
// Application unique. Trois espaces, séparés par leur adresse, leur secret JWT et leur limite de débit :
//   /v1        application cliente (+ notifications de paiement, signées)
//   /pro/v1    application prestataire
//   /api/v1    API de l'administration ; pages web sur /, /client/, /prestataire/ et /admin/
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { errorHandler, HttpError, asyncHandler } = require('./errors');
const { q } = require('./db');
const { ipAllowed } = require('./admin/security/middleware');
const webhooksRouter = require('./client/routes/webhooks');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

// En-têtes de sécurité pour l'API. La politique de contenu du tableau de bord est ajoutée plus bas, sur /admin.
app.use(helmet({ contentSecurityPolicy: false }));

// CORS réservé aux applications mobiles (origines listées). L'administration est sur la même origine : pas de CORS.
const mobileCors = cors({
  origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
});

const limiter = (limit) => rateLimit({
  windowMs: 60 * 1000,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Trop de requêtes' } },
});

// Santé du service : vérifie aussi la base, pour distinguer « serveur up » et « base injoignable »
app.get('/health', asyncHandler(async (req, res) => {
  try {
    await q('SELECT 1');
    res.json({ ok: true, db: 'up', services: ['client', 'prestataire', 'administration'] });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'down', services: ['client', 'prestataire', 'administration'] });
  }
}));

// Notifications de paiement : avant le parseur JSON, car la signature porte sur le corps brut
app.use('/v1/webhooks', webhooksRouter);

app.use(express.json({ limit: '100kb' }));

// ---- Application cliente ----
app.use('/v1', mobileCors, limiter(300));
app.use('/v1/auth', require('./client/routes/auth'));
app.use('/v1', require('./client/routes/users'));
app.use('/v1/bookings', require('./client/routes/bookings'));
app.use('/v1/requests', require('./client/routes/requests'));
app.use('/v1/favorites', require('./client/routes/favorites'));
app.use('/v1/notifications', require('./client/routes/notifications'));
app.use('/v1/support', require('./client/routes/support'));

// ---- Application prestataire ----
app.use('/pro/v1', mobileCors, limiter(300));
app.use('/pro/v1/auth', require('./pro/routes/auth'));
app.use('/pro/v1/me/documents', require('./pro/routes/documents'));
app.use('/pro/v1/me', require('./pro/routes/profile'));
app.use('/pro/v1/requests', require('./pro/routes/requests'));
app.use('/pro/v1/bookings', require('./pro/routes/bookings'));
app.use('/pro/v1/wallet', require('./pro/routes/wallet'));
app.use('/pro/v1/notifications', require('./pro/routes/notifications'));

// ---- Administration : API ----
app.use('/api/v1', ipAllowed, limiter(120));
app.use('/api/v1/auth', require('./admin/routes/auth'));
app.use('/api/v1/admin', require('./admin/routes/dashboard'));
app.use('/api/v1/admin', require('./admin/routes/operations'));
app.use('/api/v1/admin', require('./admin/routes/people'));
app.use('/api/v1/admin', require('./admin/routes/finance'));
app.use('/api/v1/admin/account', require('./admin/routes/account'));
app.use('/api', (req, res, next) => next(new HttpError(404, 'not_found', 'Route introuvable')));

// ---- Pages web : accueil, application cliente (/client/), application prestataire (/prestataire/), administration (/admin/) ----
// Les pages ont du JavaScript et du CSS inline : la politique de contenu les autorise, rien d'externe.
// Fichiers statiques seulement, sans liste de répertoires ni fichiers cachés.
const pageHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
});
app.use('/admin', ipAllowed); // le tableau de bord de l'administration reste derrière le filtre IP
app.use(pageHeaders, express.static(path.join(__dirname, '..', 'public'), {
  dotfiles: 'deny', index: 'index.html', maxAge: 0, etag: true,
}));

app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Route introuvable' } }));
app.use(errorHandler);

module.exports = app;
