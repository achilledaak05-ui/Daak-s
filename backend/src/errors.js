'use strict';
// Format d'erreur unique pour toute l'API : { error: { code, message, fields? } }
const { ZodError } = require('zod');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const notFound = (what) => new HttpError(404, 'not_found', `${what} introuvable`);
const conflict = (message, code = 'invalid_state') => new HttpError(409, code, message);

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const field = issue && issue.path.length ? issue.path.join('.') : null;
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: field ? `Champ « ${field} » invalide : ${issue.message}` : 'Données invalides',
        fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }
  // Erreurs métier sans dépendance HTTP (domain/*) : traduites en 400
  if (err instanceof RangeError) return res.status(400).json({ error: { code: 'invalid', message: err.message } });
  if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'JSON invalide' } });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Requête trop volumineuse' } });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: { code: 'too_large', message: 'Fichier trop volumineux (5 Mo maximum)' } });
  console.error(err);
  return res.status(500).json({ error: { code: 'server_error', message: 'Erreur interne, réessayez plus tard' } });
}

module.exports = { HttpError, notFound, conflict, errorHandler };
