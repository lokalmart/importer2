# Lokalmart Odoo Page Scanner + Importer V4

Versi V4 mengembalikan fitur import yang sempat hilang di V3.

## Fitur

- Test koneksi Odoo JSON-RPC
- Scan `website.page`, `website.menu`, `ir.ui.view`, dan `website.controller.page` jika ada
- Deteksi halaman target yang belum ada
- Upsert halaman `/scan` langsung ke Odoo
- Export hasil scan ke XLSX
- Import XLSX/JSON ke Odoo untuk model:
  - `website.page`
  - `ir.ui.view`
  - `website.menu`

## Struktur deploy

Pastikan root repository berisi:

```txt
api/odoo.js
public/index.html
package.json
README_DEPLOY.md
lokalmart_page_scan_direct_import_v3.xlsx
```

Jangan sampai masuk ke folder ganda seperti:

```txt
lokalmart_odoo_page_scanner_v4_package/public/index.html
```

Kalau memakai GitHub upload, buka isi folder hasil extract, lalu upload file/folder di dalamnya ke root repository.

## Cara pakai

1. Deploy ke Vercel.
2. Buka URL Vercel.
3. Isi Odoo URL, database, login admin, dan password/API key.
4. Klik **Test koneksi**.
5. Klik **Scan Semua Pages**.
6. Untuk membuat halaman scanner, klik **Upsert /scan**.
7. Untuk import file, klik **Import XLSX/JSON** lalu pilih file impor.

## Format XLSX import

Nama sheet harus mengandung salah satu teks berikut:

- `website.page`
- `ir.ui.view`
- `website.menu`

Contoh sheet yang diterima:

- `10_IMPORT_website.page_DIRECT`
- `50_IMPORT_website.page`
- `20_website.menu_IMPORT`
- `30_ir.ui.view_IMPORT`

Importer akan melakukan upsert:

- `website.page`: dicari dari `url`, lalu `key`
- `ir.ui.view`: dicari dari `key`, lalu `name`
- `website.menu`: dicari dari `url`, lalu `name`

Kolom `id` diabaikan oleh RPC importer karena itu biasanya External ID milik importer bawaan Odoo, bukan field database langsung.
