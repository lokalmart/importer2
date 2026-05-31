# Lokalmart Web3 Odoo Importer - Vercel

Importer ini dibuat untuk menjalankan upload XLSX multi-sheet dari halaman web, lalu menulis data ke Odoo 18/Education via External API JSON-RPC.

## File penting

- `index.html` - Tampilan uploader/importer.
- `api/config-status.js` - Mengecek environment variable.
- `api/test-connection.js` - Test koneksi Odoo.
- `api/import-xlsx.js` - Endpoint upload XLSX dan import otomatis.
- `api/_odoo.js` - Core Odoo client dan importer.
- `.env.example` - Contoh environment variable.

## Environment variable Vercel

Masuk Vercel Project → Settings → Environment Variables, isi:

```bash
ODOO_URL=https://edu-lokalmart.odoo.com
ODOO_DB=edu-lokalmart
ODOO_USERNAME=email_login_odoo_anda
ODOO_API_KEY=api_key_odoo_baru
```

Gunakan API key baru. Jangan memasukkan API key ke HTML/JavaScript browser.

## Deploy

Cara paling mudah:

1. Upload semua file ini ke GitHub repository.
2. Hubungkan repository ke Vercel.
3. Tambahkan Environment Variables.
4. Redeploy.
5. Buka domain Vercel.
6. Klik `Test Connection`.
7. Upload workbook XLSX.
8. Jalankan `Dry Run`.
9. Jika aman, klik `Import Now`.

## Embed di Odoo Website

Buat page Odoo misalnya `/import-lokalmart`, lalu tempel iframe:

```xml
<section class="container py-4">
    <div class="row justify-content-center">
        <div class="col-12">
            <div style="border-radius:24px; overflow:hidden; border:1px solid rgba(0,0,0,.12); min-height:900px;">
                <iframe
                    src="https://NAMA-PROJECT-ANDA.vercel.app"
                    style="width:100%; height:920px; border:0;"
                    loading="lazy"
                    referrerpolicy="no-referrer-when-downgrade">
                </iframe>
            </div>
        </div>
    </div>
</section>
```

## Sheet yang didukung

- `01_MODELS_CHECK`
- `02_FIELDS`
- `03_SELECTIONS`
- `04_PARTNERS`
- `05_PRODUCTS`
- `06_STOCK_LOTS`
- `07_PROJECTS`
- `08_PROJECT_STAGES`
- `09_PROJECT_TAGS`
- `10_MILESTONES`
- `11_TASKS`
- `12_WEBSITE_PAGES` (dibaca sebagai rencana, tidak auto-write HTML)
- `13_QR_ID_REGISTRY` (dibaca sebagai registry, data utama tetap dari `x_lokal_id`)

## Catatan

- Custom field harus diawali `x_`.
- Relasi diselesaikan lewat External ID, bukan nama tampilan.
- Import dibuat idempotent: jika record sudah ada, sistem akan update/skip aman.
