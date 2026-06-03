# Lokalmart Odoo Page Scanner V3

Scanner ini dibuat untuk memperbaiki masalah page `/scan` yang tidak muncul saat memakai XLSX biasa.

## Fungsi utama

1. Scan model `website.page`, `website.menu`, `ir.ui.view`, dan `website.controller.page` jika model tersedia.
2. Deteksi halaman yang belum ada, terutama `/scan`.
3. Membuat atau memperbarui `/scan` langsung lewat Odoo RPC dengan cara aman:
   - prioritas: update `website.page` berdasarkan `url`;
   - jika belum ada: create `website.page` langsung dengan `name`, `type`, `key`, `arch_db`, `url`;
   - fallback: create `ir.ui.view`, lalu create `website.page` dengan `view_id`.
4. Membuat menu `/scan` jika diperlukan.
5. Export hasil scan menjadi XLSX dari browser.

## Cara deploy ke Vercel

1. Upload folder ini ke GitHub atau Vercel.
2. Jalankan deploy Vercel.
3. Buka URL Vercel.
4. Isi:
   - Odoo URL: `https://edu-lokalmart.odoo.com`
   - Database: nama database Odoo Anda
   - Login: email admin Odoo
   - Password/API key: password atau API key
5. Klik `Test`.
6. Klik `Scan Semua Pages`.
7. Klik `Upsert /scan`.

## Catatan Odoo Online

External API Odoo bisa tergantung paket/izin. Jika login gagal dari Vercel, gunakan import XLSX `lokalmart_page_scan_direct_import_v3.xlsx` sebagai fallback, atau buat API key dari akun admin Odoo.

## Kenapa bukan hanya XLSX?

Halaman website Odoo bukan sekadar row menu. Page terkait dengan `website.page` dan `ir.ui.view`. Di banyak database Odoo, import XLSX yang hanya memisahkan view dan page bisa gagal silent karena external ID relasi `view_id` tidak cocok. V3 mencoba membuat record page langsung dengan field view turunan (`arch_db`, `key`, `type`) lalu fallback ke `ir.ui.view`.