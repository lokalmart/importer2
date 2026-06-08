const { readWorkbook, inferModelFromSheet, technicalSheetToModel, isImportableSheet, getImportOrder } = require('./xlsxParser');

function preflightWorkbook(fileBase64) {
  const { sheets } = readWorkbook(fileBase64);
  const order = getImportOrder(sheets);
  const sheetMap = Object.fromEntries(sheets.map(s => [s.name, s]));
  const errors = [];
  const warnings = [];
  const info = [];
  const productIds = new Set();
  const imageIds = new Set();
  const photoTargetIds = new Set();

  for (const s of sheets) {
    const m = inferModelFromSheet(s.name, s.rows);
    if (m === 'product.template') {
      for (const row of s.rows) if (row._external_id) productIds.add(String(row._external_id).trim());
    }
    if (m === 'product.image') {
      for (const row of s.rows) if (row._external_id) imageIds.add(String(row._external_id).trim());
    }
  }
  for (const id of productIds) photoTargetIds.add(id);
  for (const id of imageIds) photoTargetIds.add(id);

  for (const sheetName of order) {
    const s = sheetMap[sheetName];
    if (!s) continue;
    if (!isImportableSheet(s.name, s.rows)) continue;
    const model = inferModelFromSheet(s.name, s.rows);
    if (!technicalSheetToModel(s.name) && !model) continue;
    if (!s.rows.length) {
      warnings.push({ sheet: s.name, message: 'Sheet kosong.' });
      continue;
    }
    if (model !== 'photo_import_queue') {
      const headers = Object.keys(s.rows[0] || {});
      for (const required of ['__action', '_external_id', '_model']) {
        if (!headers.includes(required)) errors.push({ sheet: s.name, message: `Kolom wajib hilang: ${required}` });
      }
    }

    // Jika XLSX parser menemukan boolean asli, mode Super Cepat akan mengubahnya
    // menjadi teks TRUE/FALSE sebelum Odoo load(). Tetap beri warning agar pembuat
    // XLSX tahu bahwa sel boolean sebaiknya ditulis sebagai teks sejak awal.
    for (const row of s.rows) {
      for (const [key, value] of Object.entries(row)) {
        if (key === '__rownum') continue;
        if (typeof value === 'boolean') {
          warnings.push({ sheet: s.name, row: row.__rownum, message: `Nilai boolean terdeteksi pada kolom ${key}. Mode Super Cepat akan mengonversi ke teks TRUE/FALSE untuk mencegah error bool has no lower.` });
        }
      }
    }

    if (model === 'product.template') {
      for (const row of s.rows) {
        if (!row.name) errors.push({ sheet: s.name, row: row.__rownum, message: 'product.template wajib punya name.' });
        if (!row._external_id) errors.push({ sheet: s.name, row: row.__rownum, message: 'product.template wajib punya _external_id.' });
      }
    }

    if (model === 'ir.model.fields') {
      for (const row of s.rows) {
        if (!row.model) errors.push({ sheet: s.name, row: row.__rownum, message: 'ir.model.fields wajib punya model.' });
        if (!row.name) errors.push({ sheet: s.name, row: row.__rownum, message: 'ir.model.fields wajib punya name.' });
        if (row.name && !String(row.name).startsWith('x_')) warnings.push({ sheet: s.name, row: row.__rownum, message: 'Custom field Odoo Online sebaiknya prefix x_.' });
        if (row.ttype === 'many2one' && !row.relation) errors.push({ sheet: s.name, row: row.__rownum, message: 'Many2one wajib punya relation.' });
      }
    }

    if (model === 'photo_import_queue') {
      for (const row of s.rows) {
        const target = row.record_external_id || row.product_tmpl_id_external_id || row.target_external_id;
        const image = row.image_url || row.photo_url || row.image_1920_url || row.product_image_url || row.main_image_url;
        if (!target) errors.push({ sheet: s.name, row: row.__rownum, message: 'photo_import_queue wajib punya record_external_id.' });
        if (!image) errors.push({ sheet: s.name, row: row.__rownum, message: 'photo_import_queue wajib punya image_url.' });
        // In full product imports, target IDs should exist in workbook product.template/product.image.
        // In photo-only retry patches, workbook intentionally contains only photo_import_queue;
        // target existence is checked against Odoo during import, so do not raise noisy warnings.
        if (target && photoTargetIds.size > 0 && !photoTargetIds.has(String(target).trim())) warnings.push({ sheet: s.name, row: row.__rownum, message: `Target foto belum ada di workbook product.template/product.image: ${target}` });
      }
    }
  }

  info.push({ message: `${productIds.size} external ID product.template ditemukan di workbook.` });
  info.push({ message: `${imageIds.size} external ID product.image ditemukan di workbook.` });
  return { ok: errors.length === 0, errors, warnings, info };
}

module.exports = { preflightWorkbook };
