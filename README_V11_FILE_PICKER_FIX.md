# Lokalmart Importer2 V11 — Fix XLSX belum dipilih

Masalah yang diperbaiki:

- Tombol import mengirim request tanpa `fileBase64`, sehingga backend menjawab: `File XLSX tidak ditemukan. Frontend harus mengirim fileBase64.`
- File yang sama dipilih ulang tetapi event `change` tidak terpanggil.
- Backend hanya menerima pure base64; sekarang juga aman menerima data URL base64.

## Cara pasang tanpa script

Ganti file di repo GitHub `lokalmart/importer2`:

1. Ganti `index.html` dengan file `index.html` dari paket ini.
2. Ganti `api/import-xlsx.js` dengan file `api/import-xlsx.js` dari paket ini.
3. Pastikan `api/_odoo.js` memakai versi patched dari paket ini juga.
4. Commit dan redeploy Vercel.

## Cara pakai setelah deploy

1. Buka halaman importer.
2. Pilih `01_lokalmart_fields_preimport_v10_sheet_runner.xlsx`.
3. Pastikan status `fileBase64 siap = Ya`.
4. Klik `Dry Run Sheet Terpilih` untuk `02_FIELDS`.
5. Kalau aman, klik `Import Sheet Terpilih`.
6. Pilih sheet `03_SELECTIONS`, dry run, lalu import.

Jangan lanjut ke file produk sebelum schema scan ulang setelah import fields.
