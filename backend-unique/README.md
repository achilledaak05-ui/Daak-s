# Backend unique Ouvrage

Un seul service Node.js (Express) et une seule base MySQL pour les trois applications :

| Application | Adresse de base | Routes | Secret JWT |
|---|---|---|---|
| Cliente (mobile) | `https://<domaine>/v1` | `/v1/auth`, `/v1/bookings`, `/v1/requests`, … | `JWT_SECRET` |
| Prestataire (mobile) | `https://<domaine>/pro/v1` | `/pro/v1/auth`, `/pro/v1/bookings`, `/pro/v1/wallet`, … | `JWT_SECRET_PRO` |
| Administration (web) | `https://<domaine>/api/v1` (API) et `https://<domaine>/admin/` (site) | `/api/v1/auth`, `/api/v1/admin/...` | `JWT_SECRET_ADMIN` |

Pages web servies par le backend : `/` (accueil), `/client/` (application cliente), `/prestataire/` (application prestataire), `/admin/` (administration). Les pages appellent l'API de leur propre domaine.

Les trois espaces partagent la base (utilisateurs, demandes, réservations, messages, notifications) mais restent séparés : un jeton d'un espace n'est accepté par aucun autre, et chaque espace a sa propre limite de débit. Les notifications de paiement arrivent sur `/v1/webhooks/payments`, signées en HMAC.

## Structure

```
src/
  app.js, server.js, config.js, db.js, errors.js   partagés
  security/password.js, documents.js               partagés
  services/audit.js, notify.js                     partagés
  domain/pricing, distribution, wallet, documents  partagés
  client/    routes, validation, domain/bookingStates, security/ (jetons, webhook), services/paymentProvider
  pro/       routes, validation, domain/bookingStates, security/ (jetons, vérification du profil)
  admin/     routes, validation, security/ (jetons, TOTP, secrets, filtre IP)
public/index.html          accueil avec les trois applications
public/client/index.html   application cliente (web)
public/prestataire/index.html  application prestataire (web)
public/admin/index.html    tableau de bord de l'administration
db/schema.sql              schéma complet (client, prestataire, administration)
scripts/create-admin.js    création du compte administrateur
test/                      tests de la logique métier et de la cryptographie
```

## Mise en route

Prérequis : Node.js 20 ou plus, MySQL 8.

```bash
cd backend-unique
npm install
cp .env.example .env          # puis remplir les valeurs
mysql -u root -p < db/schema.sql
npm test
npm start                     # http://localhost:3000/health
```

Créer le compte administrateur (une seule fois, sur le serveur) :

```bash
npm run create-admin -- vous@ouvrage.ci "Prénom" "Nom" "mot-de-passe-de-12-caractères-min"
```

Le lien `otpauth://` affiché doit être ajouté dans une application d'authentification : sans code TOTP, la connexion administrateur est impossible.

Générer les secrets (trois secrets JWT différents, deux clés de 32 octets) :

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT_SECRET, JWT_SECRET_PRO, JWT_SECRET_ADMIN, PAYMENT_WEBHOOK_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"      # DOC_ENCRYPTION_KEY, ADMIN_SECRETS_KEY
```

Le dossier `DOC_STORAGE_DIR` doit exister, hors du dossier public, accessible seulement par le service :

```bash
sudo mkdir -p /var/lib/ouvrage/documents && sudo chmod 700 /var/lib/ouvrage/documents
```

## Mise en production

- **HTTPS obligatoire** : terminer le TLS chez l'hébergeur ou un reverse proxy (Nginx, Caddy) qui écoute sur `127.0.0.1:3000`. Mettre `TRUST_PROXY=1` pour que les limites de débit et le filtre IP voient la vraie adresse.
- **Un seul service à déployer** : `npm start` sous systemd, utilisateur dédié (pas root).
- **Sauvegardes** : base MySQL et `DOC_STORAGE_DIR`, chiffrées.
- **Clés** : ne jamais committer `.env`. Les secrets d'un espace ne doivent pas servir ailleurs.
- **Filtre IP de l'administration** (optionnel) : `ADMIN_IP_ALLOWLIST`, appliqué au tableau de bord et à l'API admin.

## Sécurité

- Mots de passe en scrypt avec sel ; comparaison à temps constant.
- Jetons d'accès JWT HS256 (15 min pour clients et prestataires, 10 min pour l'administration), vérifiés avec émetteur, audience et algorithme imposés.
- Jetons de rafraîchissement hachés (SHA-256), à usage unique ; leur réemploi révoque les sessions de l'utilisateur. **Un jeton de rafraîchissement ne renouvelle que la session de son propre espace.**
- Connexion administrateur : mot de passe puis code TOTP ; secret TOTP chiffré (AES-256-GCM).
- Pièces des prestataires : type vérifié sur le contenu, chiffrées au repos, lecture réservée à l'administration et journalisée.
- Paiements : prix et commission fixés côté serveur ; notification acceptée seulement si signée, récente et au bon montant ; référence traitée une seule fois.
- Journal d'audit (`audit_log`) pour connexions, échecs, réservations, paiements, pièces, décisions et retraits.

## Ce qui a changé par rapport aux trois backends séparés

- `backend/`, `backend-pro/` et `backend-admin/` restent dans le dossier, sans être modifiés. Ce dossier les remplace.
- Une seule configuration, une seule connexion à la base, un seul schéma SQL.
- La route `/v1/admin` de l'ancien backend client (version provisoire) est supprimée : l'administration passe par `/api/v1/admin`, avec double authentification.
- Les jetons de rafraîchissement sont filtrés par espace (voir ci-dessus).
- L'application prestataire doit viser `http://<domaine>/pro` (et non plus le port 3100). Le fichier `Ouvrage Prestataire.html` est mis à jour en conséquence.

## État de la vérification

- Vérifié : syntaxe de tous les fichiers, chaque `require` interne résolu, chaque import nommé présent dans son module, tests unitaires de la logique métier et de la cryptographie.
- Non vérifié : démarrage du serveur, routes HTTP et base MySQL. Il faut lancer `npm install`, `npm test`, puis `npm start` avec une base de test avant la mise en production.
- À faire : tests d'intégration des routes, notifications push, chiffrement du numéro de réception des retraits, lecture des pièces côté administration déjà en place mais à tester avec de vraies pièces.
