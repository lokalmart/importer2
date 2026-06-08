# Photo Import Flow

Flow foto otomatis:

1. User mencentang **Import foto setelah produk terbuat**.
2. Importer menjalankan schema, master data, dan `product.template`.
3. Frontend menghitung hasil `product.template`.
4. Jika `created + updated > 0`, frontend memulai fase foto.
5. Backend membaca `photo_import_queue` per batch.
6. Untuk setiap row:
   - cari produk berdasarkan `record_external_id`
   - download `image_url`
   - convert buffer ke base64
   - tulis ke `image_1920`

Status foto:

- `TARGET_CHECKING`
- `TARGET_NOT_FOUND`
- `DOWNLOADING`
- `WRITING`
- `DONE`
- `DOWNLOAD_FAILED`
- `ERROR`
- `SKIPPED`

## v1.0.3 - Retry Foto dan Wikimedia 429

Perbaikan penting:

- Foto bisa dijalankan ulang tanpa mengulang produk dengan tombol **Retry / Import Foto Saja**.
- Preflight sekarang mengenali target `product.image`, bukan hanya `product.template`.
- Download image memakai `User-Agent`, `Accept` header, retry otomatis, exponential backoff, dan delay antar foto.
- Untuk sumber seperti Wikimedia Commons, gunakan batch kecil 3-4 agar tidak terkena HTTP 429.
- HTTP 404 tetap tidak bisa diperbaiki otomatis karena URL file memang tidak ditemukan. Ganti dengan URL foto vendor/UMKM atau URL Commons yang valid.

Rekomendasi saat retry foto:

1. Upload XLSX patch berisi `photo_import_queue` saja.
2. Preview.
3. Set Batch Foto = 3 atau 4.
4. Klik **Retry / Import Foto Saja**.
5. Jika masih ada 429, jalankan ulang setelah beberapa menit.
