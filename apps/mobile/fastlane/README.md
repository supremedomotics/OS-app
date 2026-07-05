# Fastlane — Supreme homeowner app delivery

Builds and uploads the Flutter app to the Play internal track / TestFlight. Wired into
`.github/workflows/clients.yml`, which only runs the upload lanes when the store signing
secrets are configured.

- Android: `PLAY_SERVICE_ACCOUNT_JSON` (Google Play service account)
- iOS: `APP_STORE_CONNECT_KEY` (App Store Connect API key)

Local dry-run: `cd apps/mobile && bundle exec fastlane android deploy`.
