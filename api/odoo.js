const { sendJson, readJsonBody } = require('../lib/http');
const { OdooClient } = require('../lib/odooClient');
const { previewWorkbook, getRowsForSheet } = require('../lib/xlsxParser');
const { preflightWorkbook } = require('../lib/preflight');
const { importSheetBatch } = require('../lib/importEngine');
const { importPhotoBatch } = require('../lib/photoImporter');
const { simplifyError } = require('../lib/errors');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Gunakan POST.' });
  }

  try {
    const body = await readJsonBody(req);
    const action = body.action;
    const target = body.target || {};
    const payload = body.payload || {};

    if (action === 'preview_xlsx') {
      return sendJson(res, 200, { ok: true, ...previewWorkbook(payload.fileBase64) });
    }

    if (action === 'preflight_xlsx') {
      return sendJson(res, 200, { ok: true, preflight: preflightWorkbook(payload.fileBase64) });
    }

    if (action === 'test_connection') {
      const odoo = new OdooClient(target);
      const uid = await odoo.authenticate();
      let version = null;
      try { version = await odoo.version(); } catch (_) {}
      return sendJson(res, 200, { ok: true, uid, version });
    }

    if (action === 'import_sheet_batch' || action === 'import_native_sheet_batch') {
      const odoo = new OdooClient(target);
      await odoo.authenticate();
      const { sheet, model, rows, total, offset, limit } = getRowsForSheet(payload.fileBase64, payload.sheet, payload.offset || 0, payload.limit || 50);
      const report = await importSheetBatch({
        odoo,
        sheet,
        model: payload.model || model,
        rows,
        mode: action === 'import_native_sheet_batch' ? 'super_fast' : (payload.mode || 'normal'),
        options: payload.options || {}
      });
      return sendJson(res, 200, { ok: true, sheet, model: payload.model || model, total, offset, limit, next_offset: offset + rows.length, done: offset + rows.length >= total, report });
    }

    if (action === 'import_product_images_batch') {
      const odoo = new OdooClient(target);
      await odoo.authenticate();
      const { sheet, rows, total, offset, limit } = getRowsForSheet(payload.fileBase64, payload.sheet || 'photo_import_queue', payload.offset || 0, payload.limit || 10);
      const report = await importPhotoBatch({ odoo, sheet, rows, options: payload.options || {} });
      return sendJson(res, 200, { ok: true, sheet, total, offset, limit, next_offset: offset + rows.length, done: offset + rows.length >= total, report });
    }

    return sendJson(res, 400, { ok: false, error: `Action tidak dikenal: ${action}` });
  } catch (err) {
    const simple = simplifyError(err);
    return sendJson(res, 500, { ok: false, error: simple.message, detail: simple.detail });
  }
};
