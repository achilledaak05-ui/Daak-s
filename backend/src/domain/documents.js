'use strict';
// Le type d'un fichier est lu dans ses premiers octets, jamais dans son nom ou son type déclaré.
const MAX_BYTES = 5 * 1024 * 1024;
const KINDS = ['cni', 'naiss', 'diplome'];
const REQUIRED = ['cni', 'naiss'];

function sniffType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

function checkDocument(buf, kind) {
  if (!KINDS.includes(kind)) throw new RangeError('Type de pièce inconnu');
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new RangeError('Fichier vide');
  if (buf.length > MAX_BYTES) throw new RangeError('Fichier trop volumineux (5 Mo maximum)');
  const mime = sniffType(buf);
  if (!mime) throw new RangeError('Format non accepté : JPEG, PNG ou PDF uniquement');
  return mime;
}

module.exports = { checkDocument, sniffType, MAX_BYTES, KINDS, REQUIRED };
