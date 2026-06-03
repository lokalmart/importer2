# Lokalmart Importer V8 Migration-Safe Export

Tambahan fitur untuk Vercel importer:

- `/migration.html` = UI export migration-safe.
- `/api/migration-safe.js` = server-side exporter XLSX.
- Tetap bisa mempertahankan importer/autopsy lama.

## Cara pasang

1. Copy `api/migration-safe.js` ke repo Anda.
2. Copy `public/migration.html` ke repo Anda.
3. Update `package.json` agar punya dependency `xlsx`.
4. Update `vercel.json` agar function `api/migration-safe.js` punya `maxDuration`.
5. Commit dan tunggu Vercel redeploy.
6. Buka `/migration.html`.

## Catatan

Migration-safe export bukan full backup. Untuk full backup tetap butuh backup database + filestore.
