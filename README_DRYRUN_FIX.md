# Dry Run Relation Fix

Perbaikan ini menyelesaikan error dry run seperti:

`06_STOCK_LOTS: Relasi wajib tidak ditemukan: lokalmart_web3.product_sambal_bu_siti_lv5 (product.template)`

Penyebab: mode dry run sebelumnya tidak benar-benar membuat product.template di Odoo, sehingga External ID produk yang dibutuhkan oleh sheet `06_STOCK_LOTS` belum tersedia ketika divalidasi.

Solusi di versi ini:

- Dry run sekarang punya virtual registry untuk External ID dari record yang akan dibuat.
- Relasi antar sheet bisa divalidasi tanpa harus sudah ada di Odoo.
- Field, partner, product, project, stage, tag, milestone, task, dan stock.lot yang akan dibuat akan diberi virtual ID selama dry run.
- Jika domain pencarian memakai field `x_*` yang belum benar-benar dibuat, dry run tidak langsung gagal; sistem akan memberi warning dan lanjut validasi struktur.

Langkah:

1. Replace file project Vercel dengan isi ZIP ini.
2. Redeploy di Vercel.
3. Upload workbook yang sama.
4. Jalankan `Dry Run / Validasi` lagi.
5. Jika tidak ada error kritis, baru jalankan `Import Now`.
