# Troubleshooting

## Foto tidak berjalan

Penyebab umum:

- `product.template` belum berhasil created/updated.
- Sheet `photo_import_queue` tidak ada.
- `record_external_id` berisi external ID antrean foto, bukan external ID produk.
- URL foto tidak publik.

## Error Changing the type of a field is not yet supported

Artinya field custom sudah ada di Odoo dengan tipe berbeda. Solusi:

- Lewati field tersebut.
- Buat nama field baru, misalnya `x_lm_delivery_label`.
- Atau hapus field lama manual di Odoo Studio jika aman.

## External ID relasi tidak ditemukan

Pastikan record induk sudah diimport lebih dulu dan urutan `00_import_order` benar.


## Error boolean pada Mode Super Cepat

Error:

```text
AttributeError: 'bool' object has no attribute 'lower'
```

Penyebab:
Mode Super Cepat memakai `load()` Odoo. Converter boolean Odoo mengharapkan string seperti `TRUE` atau `FALSE`, tetapi menerima boolean JavaScript `true/false`.

Solusi di v1.0.1:
Importer Studio otomatis mengubah boolean JS menjadi teks `TRUE` / `FALSE` saat mode Super Cepat.

Aturan XLSX:
ChatGPT tetap harus menulis boolean sebagai teks `TRUE` / `FALSE`, terutama untuk kolom seperti `sale_ok`, `purchase_ok`, `website_published`, `required`, `readonly`, `store`, `index`, dan `copied`.


## v1.0.4 - Photo-only retry patch

If you upload a workbook that only contains `photo_import_queue`, preflight should not demand `product.template` rows.
The app now ignores note/report sheets without dot-style Odoo model names, for example `photo_retry_summary` and `photo_broken_404_needs_vendor`.
Target existence for photo-only retry is checked against Odoo during the photo import phase.

Recommended photo retry XLSX structure:
- `README` optional
- `_photo_retry_summary` optional note sheet, ignored by importer
- `photo_import_queue` required
- `_photo_broken_404_needs_vendor` optional note sheet, ignored by importer
