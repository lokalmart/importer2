# Lokalmart Importer V10 Image Import

Tambahan fitur untuk import foto produk/partner dari XLSX ke Odoo Online via API.

## Halaman baru

`/image-import.html`

## Format kolom XLSX

- `model` opsional, default `product.template`
- `default_code`
- `barcode`
- `name`
- `match_field`
- `match_value`
- `target_field` default `image_1920`
- `image_url`
- `image_filename`
- `image_base64`

## Catatan

Embedded images yang ditempel di Excel belum dibaca otomatis.
Gunakan URL publik, base64, atau pilih file gambar lokal dan cocokkan dengan `image_filename`.

## Cara pasang

Copy:

- `api/import-images.js`
- `public/image-import.html`

Pastikan `vercel.json` menambahkan maxDuration untuk `api/import-images.js`.
