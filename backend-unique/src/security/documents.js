'use strict';
// Chiffrement des pièces au repos (AES-256-GCM). Chaque fichier : iv (12) | tag (16) | texte chiffré.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');

async function storeEncrypted(buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.docKey, iv);
  const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const name = crypto.randomBytes(24).toString('hex');
  await fs.mkdir(config.docStorageDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(config.docStorageDir, name), Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600 });
  return name;
}

async function readDecrypted(name) {
  if (!/^[a-f0-9]{48}$/.test(name)) throw new Error('Nom de fichier invalide');
  const data = await fs.readFile(path.join(config.docStorageDir, name));
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.docKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
}

module.exports = { storeEncrypted, readDecrypted };
