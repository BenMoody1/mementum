# MeMentum

Treadmill tracker for Android. The web app lives in `www/` (same code as the
GitHub Pages version); Capacitor wraps it as a native app in `android/`.

Every push to `main` builds a signed APK and publishes it under **Releases**.

## One-off setup

1. Create a new GitHub repository and upload everything in this folder
   (including the hidden `.github` folder).
2. In the repo: **Settings > Secrets and variables > Actions > New repository secret**.
   Add the three secrets from `SIGNING-SECRETS.txt` (kept separately, never in the repo):
   `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`.
3. **Actions** tab > *Build Android APK* > **Run workflow**.
4. When it finishes (about 5 minutes), open **Releases** on your phone,
   download `MeMentum-1.0.N.apk` and install it (allow "install unknown apps"
   for your browser when asked).

## Updating

Change files in `www/` (or anywhere), commit to `main`, wait for the build,
install the new APK over the old one. Your data is kept because every build
is signed with the same key.

**Back up `mementum-release.p12` and its password somewhere safe.** If it's
lost, future builds can't update the installed app, and uninstalling wipes
the app's data.
