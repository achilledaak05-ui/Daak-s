'use strict';
// Erreurs HTTP et gestionnaire central. Aucun détail interne n'est renvoyé au client.

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function errorHandler(err, req, res, _next) {
  if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: { code: 'payload_too_large', message: 'Requête trop volumineuse' } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'bad_json', message: 'JSON invalide' } });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  if (err.name === 'ZodError') {
    return res.status(400).json({
      error: {
        code: 'validation',
        message: 'Données invalides',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }
  // Journal interne sans données personnelles ni corps de requête
  console.error(new Date().toISOString(), req.method, req.path, err.code || '', err.message);
  return res.status(500).json({ error: { code: 'internal', message: 'Erreur interne' } });
}

module.exports = { HttpError, asyncHandler, errorHandler };
