'use strict';
// Vérification réelle du type de fichier : on lit les premiers octets, jamais l'extension ou le type déclaré.
const MAX_BYTES = 5 * 1024 * 1024;
const KINDS = ['cni', 'naiss', 'diplome'];

function sniffType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length >= 4 && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return { ext: 'png', mime: 'image/png' };
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return { ext: 'pdf', mime: 'application/pdf' };
  return null;
}

function checkDocument(buf, kind) {
  if (!KINDS.includes(kind)) throw new RangeError('Type de pièce inconnu');
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new RangeError('Fichier vide');
  if (buf.length > MAX_BYTES) throw new RangeError('Fichier trop volumineux (5 Mo maximum)');
  const type = sniffType(buf);
  if (!type) throw new RangeError('Format non accepté : JPEG, PNG ou PDF uniquement');
  return type;
}

module.exports = { checkDocument, sniffType, MAX_BYTES, KINDS };
