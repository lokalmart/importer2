const XLSX = require('xlsx');

function workbookFromBase64(fileBase64) {
  if (!fileBase64) throw new Error('fileBase64 wajib dikirim.');
  const clean = String(fileBase64).includes(',') ? String(fileBase64).split(',').pop() : String(fileBase64);
  const buf = Buffer.from(clean, 'base64');
  return XLSX.read(buf, { type: 'buffer', cellDates: false, raw: false, defval: '' });
}

function normalizeValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    // Keep boolean-looking text as text here.
    // Normal mode converts it later via convertRegularScalar(),
    // while Super Cepat/load() must receive strings such as 1/0 or TRUE/FALSE.
    return value.trim();
  }
  // Some XLSX libraries may still expose boolean cells as real booleans.
  // Keep them for regular mode; mapper.convertNativeScalar() will stringify them for load().
  return value;
}

function sheetRows(workbook, sheetName) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  return rows
    .map((row, idx) => {
      const clean = { __rownum: idx + 2 };
      for (const [k, v] of Object.entries(row)) {
        const key = String(k || '').trim();
        if (!key) continue;
        clean[key] = normalizeValue(v);
      }
      return clean;
    })
    .filter(row => Object.entries(row).some(([k, v]) => k !== '__rownum' && String(v ?? '').trim() !== ''));
}

function readWorkbook(fileBase64) {
  const workbook = workbookFromBase64(fileBase64);
  const sheets = workbook.SheetNames.map(name => ({ name, rows: sheetRows(workbook, name) }));
  return { workbook, sheets };
}

function inferModelFromSheet(sheetName, rows) {
  const first = rows && rows[0] ? rows[0] : {};
  return first._model || first.model_name || technicalSheetToModel(sheetName);
}

function technicalSheetToModel(sheetName) {
  const s = String(sheetName || '').trim();
  if (!s || s.startsWith('_') || s === 'README' || s === 'VALIDATION' || s === '00_import_order') return '';
  if (s === 'photo_import_queue' || s === '_photo_import_queue') return 'photo_import_queue';
  // Only real Odoo technical models use dot notation: product.template, res.partner, etc.
  // Notes/report sheets such as photo_retry_summary or photo_broken_404_needs_vendor
  // must be ignored, otherwise preflight incorrectly demands __action/_external_id/_model.
  if (s.includes('.')) return s;
  return '';
}

function isImportableSheet(sheetName, rows = []) {
  const model = technicalSheetToModel(sheetName);
  if (model) return true;
  const first = rows && rows[0] ? rows[0] : {};
  return Boolean(first._model || first.__action || first._external_id);
}

function getImportOrder(sheets) {
  const orderSheet = sheets.find(s => s.name === '00_import_order');
  if (!orderSheet || !orderSheet.rows.length) {
    return sheets.filter(s => technicalSheetToModel(s.name)).map(s => s.name);
  }
  const names = [];
  for (const row of orderSheet.rows) {
    const val = row.sheet || row.sheet_name || row.name || row.model || row._model;
    if (val) names.push(String(val).trim());
  }
  return names.length ? names : sheets.filter(s => technicalSheetToModel(s.name)).map(s => s.name);
}

function previewWorkbook(fileBase64) {
  const { sheets } = readWorkbook(fileBase64);
  const order = getImportOrder(sheets);
  const byName = Object.fromEntries(sheets.map(s => [s.name, s]));
  const ordered = [];
  for (const name of order) {
    const s = byName[name];
    if (!s) continue;
    ordered.push({
      sheet: s.name,
      model: inferModelFromSheet(s.name, s.rows),
      rows: s.rows.length,
      headers: s.rows[0] ? Object.keys(s.rows[0]).filter(k => k !== '__rownum') : [],
      sample: s.rows.slice(0, 3)
    });
  }
  for (const s of sheets) {
    if (!ordered.find(x => x.sheet === s.name) && technicalSheetToModel(s.name)) {
      ordered.push({ sheet: s.name, model: inferModelFromSheet(s.name, s.rows), rows: s.rows.length, headers: s.rows[0] ? Object.keys(s.rows[0]).filter(k => k !== '__rownum') : [], sample: s.rows.slice(0, 3) });
    }
  }
  return { sheets: ordered, total_rows: ordered.reduce((a, s) => a + s.rows, 0) };
}

function getRowsForSheet(fileBase64, sheetName, offset = 0, limit = 50) {
  const { sheets } = readWorkbook(fileBase64);
  const sheet = sheets.find(s => s.name === sheetName);
  if (!sheet) throw new Error(`Sheet tidak ditemukan: ${sheetName}`);
  const rows = sheet.rows.slice(offset, offset + limit);
  return { sheet: sheet.name, model: inferModelFromSheet(sheet.name, sheet.rows), rows, total: sheet.rows.length, offset, limit };
}

module.exports = { readWorkbook, previewWorkbook, getRowsForSheet, inferModelFromSheet, technicalSheetToModel, isImportableSheet, getImportOrder };
