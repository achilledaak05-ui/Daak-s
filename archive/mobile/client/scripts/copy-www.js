'use strict';
// Copie l'application cliente dans www/ (dossier lu par Capacitor).
// Source : ../../Ouvrage Client.html à la racine du projet.
const fs = require('node:fs');
const path = require('node:path');

const source = path.join(__dirname, '..', '..', '..', 'Ouvrage Client.html');
const target = path.join(__dirname, '..', 'www', 'index.html');

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
console.log(`Application copiée : ${target}`);
