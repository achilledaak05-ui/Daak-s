'use strict';
// Copie l'application prestataire dans www/ (dossier lu par Capacitor).
// Source : ../../Ouvrage Prestataire.html à la racine du projet.
const fs = require('node:fs');
const path = require('node:path');

const source = path.join(__dirname, '..', '..', '..', 'Ouvrage Prestataire.html');
const target = path.join(__dirname, '..', 'www', 'index.html');

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
console.log(`Application prestataire copiée : ${target}`);
