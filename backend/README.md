# Ouvrage — backend v2

Un seul service **Node.js (Express 5)** et une seule base **MySQL 8**. Il sert l'API des trois espaces et leurs pages web :

| Page | Adresse | API |
|---|---|---|
| Accueil | `/` | — |
| Application cliente | `/client/` | `/api/v1/client` |
| Application prestataire | `/prestataire/` | `/api/v1/pro` |
| Administration | `/admin/` | `/api/v1/admin` |

Les espaces partagent la base mais restent cloisonnés : un jeton émis pour un espace est refusé par les autres, et un compte client ne peut pas se connecter côté prestataire (ni l'inverse).

L'ancien backend (`backend-unique`) et l'app mobile Capacitor sont archivés dans `../archive/`.

## Démarrage local

Prérequis : Node.js 20+, MySQL 8.

```bash
cd backend
npm install
cp .env.example .env        # puis remplir les secrets (commande de génération dans le fichier)
mysql -u root -e "CREATE DATABASE ouvrage_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
# dans .env : DATABASE_URL=mysql://root:@127.0.0.1:3306/ouvrage_dev
npm start                   # applique les migrations puis démarre sur http://localhost:3000
npm run create-admin -- admin@ouvrage.ci "Prénom" "Nom" "mot-de-passe-12-caracteres-min"
```

Le script `create-admin` affiche un lien `otpauth://` et un secret à ajouter dans Google Authenticator ou Authy. Sans ce code, la connexion à l'administration est impossible.

Tests :

```bash
npm test                                                                  # logique métier et sécurité
TEST_DATABASE_URL=mysql://root:@127.0.0.1:3306/ouvrage_test npm test      # + parcours complet (la base est VIDÉE)
```

## Déploiement : Render + MySQL Aiven

1. **Aiven** (https://aiven.io) : créer un service *MySQL* (offre gratuite). Dans *Overview*, copier la **Service URI** (`mysql://avnadmin:…@….aivencloud.com:PORT/defaultdb?ssl-mode=REQUIRED`) et télécharger le **CA certificate**.
2. **GitHub** : pousser le dépôt.
3. **Render** : *New → Blueprint*, choisir le dépôt. Le fichier `render.yaml` à la racine crée le service `ouvrage`. Render demande ensuite :
   - `DATABASE_URL` : la Service URI d'Aiven ;
   - `DB_SSL_CA` : le contenu complet du fichier `ca.pem`, lignes `-----BEGIN/END CERTIFICATE-----` comprises.

   `JWT_SECRET`, `DATA_KEY` et `PAYMENT_WEBHOOK_SECRET` sont générés automatiquement.
4. À chaque déploiement, `npm start` applique les migrations en attente (`db/migrations/*.sql`), puis démarre le serveur. Render vérifie ensuite que tout répond sur `/api/health`.
5. Pour créer l'administrateur depuis ta machine, mets dans `backend/.env` les **mêmes** `DATABASE_URL`, `DB_SSL_CA` et `DATA_KEY` que sur Render, puis lance `npm run create-admin -- …`.

⚠️ **`DATA_KEY` ne doit jamais changer** une fois en production : elle chiffre les pièces d'identité, les secrets TOTP et les numéros de retrait. Si elle change, ces données deviennent illisibles.

Sur l'offre gratuite, Render met le service en veille après 15 minutes d'inactivité. La première requête suivante prend alors environ 30 secondes.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Connexion MySQL (`mysql://user:pass@host:port/base?ssl-mode=REQUIRED`) |
| `DB_SSL_CA` | Certificat CA du MySQL managé (Aiven) |
| `JWT_SECRET` | Signature des jetons d'accès (32 caractères minimum) |
| `DATA_KEY` | Chiffrement AES-256-GCM des données sensibles (32 caractères minimum) |
| `PAYMENT_WEBHOOK_SECRET` | Signature HMAC des notifications de paiement |
| `PAYMENTS_MODE` | `disabled` (défaut : paiements refusés) ou `sandbox` (paiement validé immédiatement, pour les tests) |
| `CORS_ORIGINS` | Origines des applications mobiles |
| `ADMIN_IP_ALLOWLIST` | Optionnel : IP autorisées sur l'API admin |
| `MIN_WITHDRAWAL` | Retrait minimum en FCFA (défaut 1000) |
| `DISTRIBUTION_SIZE` | Nombre de prestataires qui reçoivent chaque demande (défaut 3) |

## Structure

```
db/migrations/        schéma SQL versionné (appliqué une seule fois par fichier)
scripts/              migrate.js, create-admin.js
src/
  app.js, server.js, config.js, db.js, errors.js, http.js, webhooks.js
  lib/                mots de passe (scrypt), chiffrement, TOTP, jetons, validation
  domain/             règles métier pures : états des réservations, commission, portefeuille, distribution, pièces
  services/           audit, notifications, paiement
  spaces/client|pro|admin/   routes de chaque espace ; auth.js et shared.js sont communs
public/               pages web (client, prestataire, admin)
test/                 tests unitaires + parcours complet
```

## API

Toutes les réponses sont en JSON. Les erreurs ont toujours la forme `{ "error": { "code", "message", "fields?" } }`, avec un `message` en français affichable tel quel. Les montants sont en FCFA entiers et les dates en ISO 8601 UTC.

### Sessions (identiques dans les trois espaces)

- `POST /auth/login` `{ contact, password }` → `{ user: { id, role }, accessToken, refreshToken, expiresIn }`
- `POST /auth/refresh` `{ refreshToken }` → nouvelle paire de jetons. L'ancien refresh token est révoqué. Si un refresh token déjà utilisé est présenté à nouveau, toutes les sessions sont révoquées.
- `POST /auth/logout` `{ refreshToken }` → 204
- Toutes les autres routes demandent l'en-tête `Authorization: Bearer <accessToken>`. Le jeton dure 15 minutes (10 pour l'admin). Après un 401, appeler `/auth/refresh`, puis rejouer la requête.

### Client : `/api/v1/client`

| Méthode | Route | Corps / paramètres | Réponse |
|---|---|---|---|
| POST | `/auth/register` | `firstName, lastName, contact, password (8+), city, zone?` | 201 comme `/auth/login` |
| GET | `/me` | | `{ id, contact, firstName, lastName, city, zone, createdAt }` |
| PATCH | `/me` | `firstName?, lastName?, city?, zone?` | 204 |
| DELETE | `/me` | `{ password }` | 204 (compte anonymisé) |
| GET | `/notifications` | | `{ unread, items: [{ id, kind, title, body, read, date }] }` |
| POST | `/notifications/read` | | 204 |
| GET | `/pros` | `?trade&zone&city&q&page` | `{ page, hasMore, items: [Pro] }` |
| GET | `/pros/:id` | | `Pro + { bio, zones, favorite, reviews: [{ rating, comment, author, date }] }` |
| GET | `/favorites` | | `{ items: [Pro] }` |
| PUT | `/favorites/:proId` | | 204 (idempotent) |
| DELETE | `/favorites/:proId` | | 204 |
| GET | `/requests` | | `{ items: [Request] }` |
| POST | `/requests` | `trade, title, description (10+), address, zone, urgency (aujourdhui/semaine/libre), desiredAt?` | 201 `Request` |
| GET | `/requests/:id` | | `Request + { offers: [{ proId, name, price, message, rating, status }] }` |
| POST | `/requests/:id/cancel` | | `{ id, status }` |
| POST | `/requests/:id/choose` | `{ proId }` | 201 `{ bookingId }` |
| GET | `/bookings` | `?group=en/ter/ann` | `{ items: [Booking] }` |
| POST | `/bookings` | `proId, trade, service, mode (immediat/devis), address, description, scheduledAt?` | 201 `Booking` |
| GET | `/bookings/:id` | | `Booking` |
| POST | `/bookings/:id/cancel` | `{ reason }` (3+) | `Booking` |
| POST | `/bookings/:id/accept-quote` · `/refuse-quote` · `/confirm` | | `Booking` |
| POST | `/bookings/:id/dispute` | `{ type, description (10+) }` | `Booking` |
| POST | `/bookings/:id/review` | `{ rating 1-5, comment (3+) }` | 201 `Booking` |
| POST | `/bookings/:id/payments` | `{ method }` | 201 `{ paymentId, reference, status, booking }` |
| GET/POST | `/bookings/:id/messages` | POST `{ body }` | `{ items: [{ id, mine, body, date }] }` / 201 |
| GET/POST | `/support/messages` | POST `{ body }` | `{ items: [{ id, sender: client/support, body, date }] }` / 201 |

- `Pro` = `{ id, name, city, trades[], basePrice, rating, ratingCount, available }`
- `Request` = `{ id, ref, trade, title, description, address, zone, urgency, desiredAt, status, createdAt, offersCount }`. Valeurs de `status` : `nouvelle`, `distribuee`, `proposee`, `choisie`, `annulee`, `expiree`.
- `Booking` = `{ id, ref, trade, service, mode, status, address, description, scheduledAt, price, proId, proName, requestId, paymentStatus, reviewed, createdAt, updatedAt }`

### Prestataire : `/api/v1/pro`

| Méthode | Route | Corps / paramètres | Réponse |
|---|---|---|---|
| POST | `/auth/register` | `firstName, lastName, contact, password, city, trades[], zones[], bio?, basePrice?` | 201 |
| GET | `/me` | | `{ id, contact, firstName, lastName, city, bio, basePrice, available, verificationStatus, trades, zones, rating, ratingCount, createdAt }` |
| PATCH | `/me` | `city?, bio?, basePrice?, available?` | 204 |
| PUT | `/me/trades` · `/me/zones` | `{ trades: [] }` · `{ zones: [] }` | 204 |
| DELETE | `/me` | `{ password }` | 204 |
| GET | `/me/verification` | | `{ status, documents: { cni, naiss, diplome }, missing: [] }` |
| GET/POST | `/me/documents` | POST multipart : `kind` (cni/naiss/diplome) + `file` (JPEG/PNG/PDF, 5 Mo max) | `{ items }` / 201 |
| GET | `/me/reviews` | | `{ items: [{ rating, comment, author, date }] }` |
| GET | `/notifications` · POST `/notifications/read` | | comme côté client |
| GET | `/requests` ⚑ | | `{ items: [{ id, ref, trade, title, description, zone, urgency, desiredAt, requestStatus, myStatus, price, message, address, receivedAt }] }` |
| POST | `/requests/:id/offer` ⚑ | `{ price, message? }` | 201 |
| POST | `/requests/:id/decline` ⚑ | | 204 |
| GET | `/bookings` | `?group=en/ter/ann` | `{ items: [ProBooking] }` |
| GET | `/bookings/:id` | | `ProBooking` |
| POST | `/bookings/:id/accept` · `/decline` · `/start` · `/finish` | | `ProBooking` |
| POST | `/bookings/:id/quote` | `{ price }` (pour `demande_devis`) | `ProBooking` |
| GET/POST | `/bookings/:id/messages` | | comme côté client |
| GET | `/wallet` | | `{ earned, upcoming, pendingWithdrawals, withdrawn, available, completedMissions, minWithdrawal }` |
| GET/POST | `/wallet/withdrawals` | POST `{ amount, method, number }` | `{ items: [{ id, ref, amount, method, status, reason, date }] }` / 201 |

⚑ réservé aux profils validés : sinon 403 `not_verified`.
`ProBooking` = `{ id, ref, mode, service, trade, status, address, description, scheduledAt, price, commissionRate, net, clientName, clientCity, createdAt, updatedAt }`

### Administration : `/api/v1/admin`

Connexion en deux étapes. On envoie d'abord `POST /auth/login` avec `{ contact, password }`. Si le mot de passe est bon, la réponse est 401 avec le code `mfa_required`. On renvoie alors la même requête en ajoutant `totp`.

| Méthode | Route | Notes |
|---|---|---|
| GET | `/me` | administrateur connecté |
| POST | `/account/password` | `{ currentPassword, newPassword (12+) }`, ferme toutes les sessions admin |
| POST | `/account/totp/reset` | `{ password, totp }` → `{ otpauthUri, secret }` |
| GET | `/dashboard` | compteurs + `monthly: [{ month, paid, commissions }]` |
| GET | `/reports/zones` · `/reports/zones.csv` | |
| GET | `/audit?limit=` | journal |
| GET | `/requests?status=` | `nouvelle` par défaut |
| POST | `/requests/:id/distribute` | → `{ sent, pros }` |
| POST | `/requests/:id/cancel` | `{ motif }` |
| GET | `/bookings?group=en/ter/ann` | |
| POST | `/bookings/:id/cancel` | `{ motif }`, rembourse si déjà payé |
| GET | `/refunds` | paiements à rembourser ou remboursés |
| POST | `/bookings/:id/refunded` | confirme le remboursement |
| GET | `/disputes?status=ouvert/resolu` | |
| POST | `/disputes/:id/decide` | `{ decision: client/pro, motif }` |
| GET | `/pros?status=attente/valide/refuse/complement/suspendus/tous` | |
| GET | `/pros/:id` | détail et pièces (consultation journalisée) |
| GET | `/pros/:id/documents/:kind` | fichier déchiffré |
| POST | `/pros/:id/decision` | `{ decision: valide/refuse/complement, motif? }` |
| GET | `/clients` | |
| POST | `/users/:id/suspend` · `/reactivate` | suspend : `{ motif }` |
| GET/PUT | `/rates` | PUT `{ rates: [{ trade, rate }] }` ; GET contient aussi `history` |
| GET | `/withdrawals?status=demande/en_cours/verse/rejete` | numéro de réception déchiffré |
| POST | `/withdrawals/:id/start` · `/paid` · `/reject` | reject : `{ motif }` |
| GET | `/support` · `/support/:userId` | |
| POST | `/support/:userId/messages` | `{ body }` |

### Paiement

`POST /api/v1/webhooks/payments` reçoit les notifications du prestataire de paiement. L'en-tête `X-Ouvrage-Signature: t=<unix>,v1=<hmac-sha256(t + "." + corps)>` est obligatoire. Le corps attendu est `{ reference, status: success/failed, amount }`. Le montant est recontrôlé, et une notification rejouée reste sans effet.

### Cycle d'une réservation

```
immediat : attente ─pro accept→ a_payer ─paiement→ payee ─pro start→ en_cours ─pro finish→ fin_signalee ─client confirm→ terminee
devis    : demande_devis ─pro quote→ devis_propose ─client accept-quote→ a_payer → …
demande  : le client choisit une offre → réservation directement « a_payer »
litige   : fin_signalee ─client dispute→ litige ─admin decide→ terminee (pro) ou annulee + remboursement (client)
```
