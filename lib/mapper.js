const META_COLUMNS = new Set(['__rownum', '__action', '_model', 'import_note', 'note', 'debug', 'skip', 'priority']);
const PHOTO_COLUMNS = new Set(['image_url', 'photo_url', 'image_1920_url', 'product_image_url', 'main_image_url', 'image_alt', 'image_source_url', 'image_search_query']);

function isEmpty(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function parseBoolean(value, defaultValue = false) {
  if (value === true) return true;
  if (value === false) return false;
  if (value === undefined || value === null || value === '') return defaultValue;
  const s = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'ya', 'iya', 'benar', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'tidak', 'tdk', 'salah', 'off'].includes(s)) return false;
  return defaultValue;
}

function convertRegularScalar(v) {
  if (v === true || v === false) return v;
  if (isEmpty(v)) return '';
  const s = String(v).trim();
  if (/^(true|false|yes|no|ya|iya|tidak|tdk)$/i.test(s)) return parseBoolean(s, false);
  if (/^-?\d+(\.\d+)?$/.test(s) && !/^0\d+/.test(s)) return Number(s);
  return s;
}

// Native Odoo import via model.load(fields, data) follows the same spirit as Odoo's
// UI import: values are parsed from strings. Sending real JS booleans can trigger
// Odoo's boolean converter error: value.lower is not a function / bool has no lower.
// Therefore Super Fast mode must send strings for booleans, dates, selections, and
// even numbers are safest as strings. Empty values remain ''.
function convertNativeScalar(v) {
  if (isEmpty(v)) return '';
  if (v === true) return 'TRUE';
  if (v === false) return 'FALSE';
  const s = String(v).trim();
  if (/^(true|yes|ya|iya|benar|on)$/i.test(s)) return 'TRUE';
  if (/^(false|no|tidak|tdk|salah|off)$/i.test(s)) return 'FALSE';
  return s;
}

function nativeFieldsAndData(rows, options = {}) {
  const skipPhoto = options.skipPhotoColumns !== false;
  const fields = [];
  const data = [];

  for (const row of rows) {
    const out = {};
    for (const [rawKey, rawVal] of Object.entries(row)) {
      const key = String(rawKey || '').trim();
      if (!key || META_COLUMNS.has(key)) continue;
      if (key === '_external_id') {
        if (!isEmpty(rawVal)) out.id = String(rawVal).trim();
        continue;
      }
      if (skipPhoto && PHOTO_COLUMNS.has(key)) continue;
      if (isEmpty(rawVal)) continue;

      if (key.endsWith('_external_ids')) {
        const base = key.replace(/_external_ids$/, '');
        out[`${base}/id`] = String(rawVal).split(',').map(x => x.trim()).filter(Boolean).join(',');
        continue;
      }
      if (key.endsWith('_external_id')) {
        const base = key.replace(/_external_id$/, '');
        out[`${base}/id`] = String(rawVal).trim();
        continue;
      }
      out[key] = convertNativeScalar(rawVal);
    }
    for (const k of Object.keys(out)) if (!fields.includes(k)) fields.push(k);
    data.push(out);
  }

  const matrix = data.map(obj => fields.map(f => obj[f] ?? ''));
  return { fields, data: matrix, objects: data };
}

function regularVals(row, modelFields = {}, options = {}) {
  const vals = {};
  const relationLookups = [];
  const m2mLookups = [];
  const skipped = [];

  for (const [rawKey, rawVal] of Object.entries(row)) {
    const key = String(rawKey || '').trim();
    if (!key || META_COLUMNS.has(key) || key === '_external_id') continue;
    if (PHOTO_COLUMNS.has(key)) continue;
    if (isEmpty(rawVal)) continue;

    if (key.endsWith('_external_ids')) {
      const field = key.replace(/_external_ids$/, '');
      if (!modelFields[field] && !options.allowUnknownFields) { skipped.push(key); continue; }
      m2mLookups.push({ field, xmlids: String(rawVal).split(',').map(x => x.trim()).filter(Boolean) });
      continue;
    }
    if (key.endsWith('_external_id')) {
      const field = key.replace(/_external_id$/, '');
      if (!modelFields[field] && !options.allowUnknownFields) { skipped.push(key); continue; }
      relationLookups.push({ field, xmlid: String(rawVal).trim() });
      continue;
    }

    if (!modelFields[key] && !options.allowUnknownFields) { skipped.push(key); continue; }
    vals[key] = convertRegularScalar(rawVal);
  }
  return { vals, relationLookups, m2mLookups, skipped };
}

module.exports = { nativeFieldsAndData, regularVals, isEmpty, parseBoolean, convertNativeScalar, convertRegularScalar };
