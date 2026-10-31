# Application prestataire Ouvrage — iOS et Android

Enveloppe native (Capacitor) autour de l'application prestataire. Même principe que l'application cliente (`mobile/client/`).

- Identifiant d'application : `com.ouvrage.prestataire` (iOS et Android)
- Nom affiché : Ouvrage Pro
- Backend utilisé : `backend-unique/`, route `/pro/v1` (API prestataire, séparée de l'API client)

## 1. Préparer le projet

```bash
cd mobile/prestataire
npm install
npx cap add ios       # une seule fois
npx cap add android   # une seule fois
npm run sync          # copie l'application dans www/ et synchronise les projets natifs
```

À chaque modification de `Ouvrage Prestataire.html`, relancer `npm run sync`.

## 2. Ouvrir et tester

```bash
npm run ios       # Xcode
npm run android   # Android Studio
```

## 3. Réglages natifs

**iOS — `ios/App/App/Info.plist`** :

- `NSCameraUsageDescription` : « Ouvrage Pro utilise l'appareil photo pour photographier vos pièces justificatives et vos réalisations. »
- `NSPhotoLibraryUsageDescription` : « Ouvrage Pro accède à vos photos pour joindre vos pièces justificatives et vos réalisations. »

**Android — `android/app/src/main/AndroidManifest.xml`** : l'accès aux fichiers est demandé par le sélecteur du système. Ne rien ajouter tant qu'une fonction n'en a pas besoin.

Pour la position : elle n'est pas demandée par l'application prestataire pour l'instant. Si une fonction de géolocalisation est ajoutée plus tard, il faudra ajouter les textes et les permissions correspondants.

## 4. Icônes et écran de démarrage

- Icône source 1024 × 1024 px, sans transparence pour iOS, dans `assets/icon.png`.
- Écran de démarrage dans `assets/splash.png`.
- Générer les tailles : `npx @capacitor/assets generate --iconBackgroundColor "#000000" --splashBackgroundColor "#000000"`.

## 5. Avant de soumettre aux stores

**Comptes** : Apple Developer Program (99 USD par an) et Google Play Console (25 USD, paiement unique).

**Contenu obligatoire** :
- Politique de confidentialité publiée sur une URL publique. Elle doit préciser que les pièces justificatives sont chiffrées et utilisées uniquement pour la vérification.
- Suppression de compte accessible dans l'application (l'écran existe : reliez-le à `DELETE /pro/v1/me` du backend).
- Compte de test pour les relecteurs, avec un dossier déjà validé, sinon ils ne verront aucune demande.
- Formulaire « Sécurité des données » (Google Play) et « Confidentialité » (App Store) rempli selon les données collectées : identité, pièces, coordonnées, paiements de retrait.

**Points techniques à vérifier** :
- L'application doit fonctionner avec le backend, pas avec des données locales.
- Le backend doit être en HTTPS, avec un domaine public. Renseigner ce domaine dans l'application (voir la liaison à l'API).
- Connexion Google ou Apple : si elle est proposée, Apple impose « Se connecter avec Apple ».

**Versions** : incrémenter `versionName`/`versionCode` (Android) et `CFBundleShortVersionString`/`CFBundleVersion` (iOS) à chaque envoi.

- Android : Build → Generate Signed Bundle (`.aab`). Conserver le fichier de signature : sans lui, impossible de mettre à jour l'application.
- iOS : Product → Archive, puis Distribute App vers App Store Connect.

## 6. Ce qui n'est pas encore fait

- Liaison de l'application à l'API prestataire (en cours).
- Notifications push (Firebase pour Android, APNs pour iOS).
