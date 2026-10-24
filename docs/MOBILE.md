# The mobile app

The full step-by-step is in **GETTING_STARTED.md, Part 5**. In short:

| Route | Effort | Result |
|---|---|---|
| A. Install from the browser | Deploy with https, then Add to Home Screen | An installed app with its own icon, fast, signed in for 30 days |
| B. Android APK (Capacitor) | Android Studio, 5 commands in `mobile/` | A real `.apk` you can install or publish |
| C. iPhone (Capacitor) | A Mac with Xcode | A real iOS app |

All three use the same screens and the same server. The packaged app calls your server at the address in `mobile/server-address.txt`.

## Native touches worth adding after the hackathon

| Feature | Plugin | Why |
|---|---|---|
| Push notifications for offers and payments | Push Notifications (Firebase) | Experts hear about a job instantly |
| Camera for the affidavit scan | Camera | Photograph the stamped copy in one tap |
| Fingerprint or face unlock | A biometric plugin | Open the app safely without a text code |
| Precise location for SOS | Geolocation | More reliable than the browser |
