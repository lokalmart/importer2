# Lokalmart Importer Studio

Aplikasi Vercel untuk import XLSX ke Odoo dengan flow yang lebih intuitif:

1. Koneksi Odoo
2. Upload XLSX
3. Preview
4. Preflight
5. Import schema/custom fields
6. Import master data
7. Import produk
8. Import relasi supplier/attribute line
9. Import foto otomatis dari `photo_import_queue`
10. Laporan akhir

## Fitur utama

- Wizard UI dengan progress per fase.
- Mode **Super Cepat / Native-like** memakai `model.load(fields, data)` Odoo untuk batch import data.
- Import `ir.model.fields` diproses khusus agar field existing dengan tipe berbeda tidak menghentikan seluruh import.
- Import foto otomatis setelah `product.template` berhasil created/updated.
- Feedback foto: queued, done, failed, target missing.
- Batch size bisa diatur dari UI agar aman dari timeout Vercel.
- Log JSON bisa diunduh.

## Deploy ke Vercel

```bash
npm install
vercel dev
```

Lalu buka `http://localhost:3000`.

Untuk production:

```bash
vercel --prod
```

## Keamanan

Jangan commit password/API key Odoo ke GitHub. Masukkan kredensial hanya di UI saat import.

## Format XLSX utama

Setiap sheet data mengikuti standar Lokalmart:

- Sheet data memakai nama technical model, misalnya `product.template`, `res.partner`, `ir.model.fields`.
- Kolom wajib: `__action`, `_external_id`, `_model`.
- Many2one: `field_name_external_id`.
- Many2many: `field_name_external_ids`, isi beberapa external ID dipisah koma.
- Foto: pakai `photo_import_queue`.

## Format `photo_import_queue`

```text
__action
_external_id
_model
model
record_external_id
image_url
image_field
image_alt
image_note
priority
```

Contoh:

```text
__action: upsert
_external_id: lokalmart.photo_queue_001_nasi_jamblang
_model: photo_import_queue
model: product.template
record_external_id: lokalmart.product_001_nasi_jamblang_paket_ayam
image_url: https://example.com/nasi-jamblang.jpg
image_field: image_1920
image_alt: Nasi Jamblang Paket Ayam
image_note: Foto utama produk
priority: 10
```

Penting:

- `_external_id` adalah ID antrean foto.
- `record_external_id` adalah ID produk tujuan.
- `image_url` harus URL publik yang bisa dibuka tanpa login.

## Mode Super Cepat

Mode Super Cepat mengubah format XLSX Lokalmart menjadi format native import Odoo:

- `_external_id` menjadi kolom native `id`.
- `categ_id_external_id` menjadi `categ_id/id`.
- `public_categ_ids_external_ids` menjadi `public_categ_ids/id`.

Lalu data dikirim lewat `model.load(fields, data)`. Ini biasanya jauh lebih cepat daripada create/write satu baris per request.

## Catatan batasan

- Vercel Serverless tidak cocok untuk background job panjang tanpa storage. Karena itu aplikasi ini menjalankan import per batch dari frontend dan menerima feedback setelah setiap batch.
- Jika ingin job benar-benar background, tambahkan Redis/Vercel KV untuk menyimpan job state.
- `model.load()` mengikuti mekanisme import Odoo; jika ada field atau relasi salah, hasil error berasal dari Odoo.


## Panduan ChatGPT XLSX v0.3.4

App ini menyertakan panduan lengkap untuk membuat XLSX yang aman di `docs/CHATGPT_XLSX_GUIDE.txt` dan versi yang tampil di UI melalui `/docs/CHATGPT_XLSX_GUIDE.txt`.

Poin perbaikan penting v1.0.1:

- Mode Super Cepat mengirim boolean ke Odoo `load()` sebagai teks `TRUE` / `FALSE`, bukan boolean JavaScript mentah. Ini mencegah error Odoo: `AttributeError: 'bool' object has no attribute 'lower'`.
- Sheet `photo_import_queue` harus memakai `record_external_id` sebagai target produk dan `image_url` sebagai sumber foto.
- `ir.model.fields` akan skip field yang sudah ada dengan tipe berbeda, supaya tidak memicu error `Changing the type of a field is not yet supported`.
- UI sekarang memiliki panel “Panduan ChatGPT XLSX Lokalmart” dengan tombol tampilkan/buka/download TXT.


UPDATE v1.0.2 - Product Image / eCommerce Media
- Sheet product.image didukung pada fase relations.
- Untuk eCommerce Media, buat record product.image lebih dulu lalu photo_import_queue menulis ke product.image.image_1920.
- photo_import_queue harus memakai model dan record_external_id.
- Parser tidak lagi mengubah teks TRUE/FALSE menjadi boolean terlalu awal, untuk mencegah error Odoo load(): bool has no lower.
