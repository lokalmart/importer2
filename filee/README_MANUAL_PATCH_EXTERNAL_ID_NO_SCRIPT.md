# Lokalmart Importer2 — Manual Patch `*_external_id` Resolver (NO SCRIPT)

Tujuan patch ini: kolom bantu XLSX seperti `model_id_external_id`, `categ_id_external_id`, `parent_external_id`, `public_categ_ids_external_id`, dan sejenisnya **tidak dikirim mentah ke Odoo**.

Importer akan menerjemahkan kolom itu menjadi field relasi asli Odoo:

- `model_id_external_id` -> `model_id`
- `categ_id_external_id` -> `categ_id`
- `parent_external_id` -> `parent_id` jika `parent_id` ada di model
- `public_categ_ids_external_id` -> `public_categ_ids`

Lalu nilai seperti `product.model_product_category` akan di-resolve dari `ir.model.data` menjadi ID asli Odoo.

---

## File yang diedit

Edit file:

```text
api/_odoo.js
```

Jangan ubah `api/import-xlsx.js`, karena endpoint itu hanya memanggil core importer di `_odoo.js`.

---

## Langkah 1 — Tambahkan helper methods di dalam class `LokalmartImporter`

Cari method ini di `api/_odoo.js`:

```js
async sanitizeValues(model, values, sheet, context = 'write') {
```

Tepat **sebelum** method itu, paste isi file:

```text
insert_inside_LokalmartImporter_before_sanitizeValues.js
```

---

## Langkah 2 — Ganti method `sanitizeValues`

Ganti seluruh method lama:

```js
async sanitizeValues(model, values, sheet, context = 'write') {
  ...
}
```

Dengan isi file:

```text
replace_sanitizeValues_method.js
```

Pastikan hanya 1 method `sanitizeValues` yang tersisa.

---

## Langkah 3 — Commit manual

```bash
git add api/_odoo.js
git commit -m "Add manual external_id resolver for XLSX imports"
git push
```

Lalu redeploy Vercel.

---

## Tes cepat

Setelah deploy, coba import lagi sheet `ir.model.fields` yang punya kolom:

```text
model_id_external_id = product.model_product_category
```

Log yang benar seharusnya tidak lagi warning:

```text
model_id_external_id: Field tidak ada pada model
```

Sebagai gantinya, log bisa menampilkan info/warn resolver, lalu payload yang dikirim ke Odoo berisi:

```text
model_id = 450
```

---

## Catatan

Patch ini sengaja tidak memakai script otomatis dan tidak membuat custom field palsu di Odoo. `model_id_external_id` tetap menjadi kolom bantu importer, bukan field Odoo.
