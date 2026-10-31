# Application cliente Ouvrage — iOS et Android

Enveloppe native (Capacitor) autour de l'application cliente. Même code pour les deux plateformes.

- Identifiant d'application : `com.ouvrage.client` (iOS et Android)
- Nom affiché : Ouvrage

## 1. Installer les outils

- Node.js 20 ou plus.
- Xcode (déjà installé) pour iOS. Ouvrir Xcode une fois, accepter la licence, puis installer CocoaPods : `sudo gem install cocoapods`.
- Android Studio (déjà installé) pour Android. Lors du premier lancement, installer le SDK Android proposé.

## 2. Préparer le projet

```bash
cd mobile/client
npm install
npx cap add ios       # crée le dossier ios/ (une seule fois)
npx cap add android   # crée le dossier android/ (une seule fois)
npm run sync          # copie l'application dans www/ et synchronise les projets natifs
```

À chaque modification de `Ouvrage Client.html`, relancer `npm run sync`.

## 3. Ouvrir et tester

```bash
npm run ios       # ouvre le projet dans Xcode
npm run android   # ouvre le projet dans Android Studio
```

- iOS : choisir un simulateur, puis Produit → Exécuter.
- Android : choisir un émulateur, puis Run.

## 4. Réglages à faire dans les projets natifs

**iOS — `ios/App/App/Info.plist`** : ajouter les textes affichés à l'utilisateur (Apple refuse l'app sans eux) :

- `NSLocationWhenInUseUsageDescription` : « Ouvrage utilise votre position pour vous proposer les prestataires proches. »
- `NSPhotoLibraryUsageDescription` : « Ouvrage accède à vos photos pour joindre une image à votre demande. »
- `NSCameraUsageDescription` : « Ouvrage utilise l'appareil photo pour joindre une photo à votre demande. » (si la caméra est utilisée)

**Android — `android/app/src/main/AndroidManifest.xml`** : pour la position, ajouter si besoin :

- `<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />`
- `<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />`

Ne demander une permission que lorsque la fonction est utilisée.

## 5. Icônes et écran de démarrage

- Icône source : 1024 × 1024 px, sans transparence pour iOS.
- Générer toutes les tailles : `npx @capacitor/assets generate --iconBackgroundColor "#000000" --splashBackgroundColor "#000000"` (avec `assets/icon.png` et `assets/splash.png` dans ce dossier).

## 6. Avant de soumettre aux stores

**Comptes**
- Apple Developer Program : 99 USD par an.
- Google Play Console : 25 USD, paiement unique.

**Contenu obligatoire**
- Politique de confidentialité publiée sur une URL publique (à rédiger avec le juriste).
- Suppression de compte : accessible dans l'application et via une page web. L'écran existe ; il doit être relié à la route `DELETE /v1/me`.
- Compte de test pour les relecteurs Apple et Google, avec identifiants fournis dans la fiche.
- Formulaire « Sécurité des données » (Google Play) et « Confidentialité » (App Store) rempli selon ce que l'app collecte.

**Points techniques à vérifier**
- L'application doit fonctionner avec le backend, pas avec des données locales. Un relecteur qui trouve une app de démonstration la refuse.
- Si une connexion Google est proposée, Apple impose aussi « Se connecter avec Apple ». La version actuelle n'a que des boutons qui affichent un message.
- Paiement de services réels (plomberie, travaux) : en principe hors achats intégrés Apple, mais à confirmer avec les consignes actuelles d'Apple (règle 3.1.3) avant soumission.

**Versions**
- Incrémenter le numéro de version à chaque envoi (`versionName` et `versionCode` côté Android ; `CFBundleShortVersionString` et `CFBundleVersion` côté iOS).
- Android : générer un bundle signé (`.aab`) depuis Android Studio, Build → Generate Signed Bundle. Conserver le fichier de signature : sans lui, impossible de mettre l'app à jour.
- iOS : Xcode → Product → Archive, puis Distribute App vers App Store Connect.

## 7. Ce qui n'est pas encore fait

- L'application cliente utilise encore le stockage local du navigateur. Elle appelle déjà l'API (`backend-unique/`, route `/v1`) ; le stockage local ne doit servir qu'à un cache avant publication.
- Les permissions de localisation, caméra et notifications push ne sont pas encore branchées.
- Pas encore de notifications push (Firebase pour Android, APNs pour iOS).
