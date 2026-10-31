#!/usr/bin/env bash
# Génère les projets natifs iOS et Android des applications client et prestataire.
# À lancer sur votre Mac (Xcode et Android Studio installés). Ne pas lancer deux fois : les dossiers ios/ et android/ seraient recréés.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

generate() {
  local app="$1" label="$2" plist_lines="$3"
  echo "==> $label"
  cd "$HERE/$app"
  npm install
  npx cap add ios
  npx cap add android
  npm run sync
  if [ -n "$plist_lines" ]; then
    echo "$plist_lines" | while IFS='|' read -r key value; do
      [ -z "$key" ] && continue
      /usr/libexec/PlistBuddy -c "Add :$key string $value" ios/App/App/Info.plist 2>/dev/null \
        || /usr/libexec/PlistBuddy -c "Set :$key $value" ios/App/App/Info.plist
    done
  fi
  (cd ios/App && pod install)
  echo "    $label : projets générés dans $HERE/$app/ios et $HERE/$app/android"
}

generate client "Application cliente (com.ouvrage.client)" \
"NSLocationWhenInUseUsageDescription|Ouvrage utilise votre position pour vous proposer les prestataires proches."

generate prestataire "Application prestataire (com.ouvrage.prestataire)" \
"NSCameraUsageDescription|Ouvrage Pro utilise l'appareil photo pour photographier vos pièces justificatives et vos réalisations.
NSPhotoLibraryUsageDescription|Ouvrage Pro accède à vos photos pour joindre vos pièces justificatives et vos réalisations."

echo
echo "Terminé. Ouvrir les projets :"
echo "  cd $HERE/client && npm run ios      (Xcode)"
echo "  cd $HERE/client && npm run android  (Android Studio)"
echo "  cd $HERE/prestataire && npm run ios"
echo "  cd $HERE/prestataire && npm run android"
