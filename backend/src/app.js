'use strict';
// Application unique : API sous /api/v1/{client|pro|admin}, pages web servies sur la même origine.
//   /               accueil          /client/   application cliente
//   /prestataire/   application pro  /admin/    administration
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const config = require('./config');
const { q } = require('./db');
const { errorHandler, notFound } = require('./errors');
const { limiter } = require('./http');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

// Pages : scripts et styles inline autorisés (applications monofichier), rien d'externe hors polices Google
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'"],
      frameSrc: ["'self'", 'blob:'],
      objectSrc: ["'self'", 'blob:'],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: config.env === 'production' ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' },
}));

// Santé : utilisée par Render pour savoir si le service est prêt
app.get('/api/health', async (req, res) => {
  try {
    await q('SELECT 1');
    res.json({ ok: true, db: 'up' });
  } catch {
    res.status(503).json({ ok: false, db: 'down' });
  }
});

// Webhooks avant le parseur JSON : la signature porte sur le corps brut
app.use('/api/v1/webhooks', require('./webhooks').router);

// CORS seulement pour les applications mobiles (Capacitor) ; les pages web sont sur la même origine
const mobileCors = cors({
  origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
});

app.use('/api/v1', express.json({ limit: '100kb' }));
app.use('/api/v1/client', mobileCors, limiter(60 * 1000, 300), require('./spaces/client'));
app.use('/api/v1/pro', mobileCors, limiter(60 * 1000, 300), require('./spaces/pro'));
app.use('/api/v1/admin', limiter(60 * 1000, 300), require('./spaces/admin'));
app.use('/api', (req, res, next) => next(notFound('Route')));

// GSAP servi depuis node_modules : pas de CDN externe, version figée par package-lock
app.use('/vendor/gsap', express.static(path.join(path.dirname(require.resolve('gsap/package.json')), 'dist'), { maxAge: '7d', immutable: true }));

app.use(express.static(path.join(__dirname, '..', 'public'), { dotfiles: 'deny', index: 'index.html', maxAge: 0 }));

app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Page introuvable' } }));
app.use(errorHandler);

module.exports = app;
