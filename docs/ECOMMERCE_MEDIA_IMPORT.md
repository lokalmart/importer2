# Import eCommerce Media / product.image

Untuk menambahkan lebih dari satu foto produk di Odoo eCommerce:

1. Import `product.template` sampai berhasil.
2. Import sheet `product.image` dengan kolom minimal:
   - `__action`
   - `_external_id`
   - `_model` = `product.image`
   - `name`
   - `product_tmpl_id_external_id`
3. Jalankan `photo_import_queue` dengan target:
   - `model` = `product.image`
   - `record_external_id` = external ID record `product.image`
   - `image_field` = `image_1920`

Contoh:

| __action | _external_id | _model | name | product_tmpl_id_external_id |
|---|---|---|---|---|
| upsert | lokalmart.media_produk_001_1 | product.image | Media 1 - Produk 001 | lokalmart.product_001 |

Kemudian di `photo_import_queue`:

| __action | _external_id | _model | model | record_external_id | image_url | image_field |
|---|---|---|---|---|---|---|
| upsert | lokalmart.photo_media_produk_001_1 | photo_import_queue | product.image | lokalmart.media_produk_001_1 | https://example.com/foto.jpg | image_1920 |
