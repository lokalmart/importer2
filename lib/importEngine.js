const { nativeFieldsAndData, regularVals, parseBoolean } = require('./mapper');
const { simplifyError } = require('./errors');

async function importSheetBatch({ odoo, sheet, model, rows, mode = 'normal', options = {} }) {
  if (!model || model === 'photo_import_queue') throw new Error(`Model tidak valid untuk import data: ${model}`);
  if (!rows || !rows.length) return emptyReport(sheet, model);

  if (model === 'ir.model.fields') {
    return await importFieldsFast({ odoo, sheet, model, rows, options });
  }

  if (mode === 'super_fast') {
    return await importNativeLoad({ odoo, sheet, model, rows, options });
  }

  return await importRegularUpsert({ odoo, sheet, model, rows, options });
}

function emptyReport(sheet, model) {
  return { sheet, model, rows: 0, processed: 0, created: 0, updated: 0, skipped: 0, errors: [], warnings: [] };
}

async function importNativeLoad({ odoo, sheet, model, rows, options }) {
  const report = emptyReport(sheet, model);
  report.rows = rows.length;
  const cleanRows = rows.filter(r => String(r.skip || '').toLowerCase() !== 'true');
  report.skipped += rows.length - cleanRows.length;

  if (!cleanRows.length) return report;

  const { fields, data } = nativeFieldsAndData(cleanRows, { skipPhotoColumns: true });
  if (!fields.length || !data.length) return report;

  try {
    const result = await odoo.load(model, fields, data);
    const messages = Array.isArray(result.messages) ? result.messages : [];
    report.processed = cleanRows.length;
    if (messages.length) {
      for (const msg of messages) {
        const rowIndex = typeof msg.record === 'number' ? msg.record : undefined;
        const row = rowIndex !== undefined && cleanRows[rowIndex] ? cleanRows[rowIndex].__rownum : undefined;
        const text = msg.message || msg.type || JSON.stringify(msg);
        if (msg.type === 'warning') report.warnings.push({ row, message: text, raw: msg });
        else report.errors.push({ row, error: text, raw: msg });
      }
    }
    if (report.errors.length) {
      report.created = 0;
      report.updated = 0;
    } else {
      // Native load does not consistently tell created vs updated through XML-RPC.
      // Treat successful processed rows as upserted so frontend can proceed to photo phase.
      report.updated = cleanRows.length;
    }
    report.native = true;
    report.native_fields = fields;
    return report;
  } catch (err) {
    const simple = simplifyError(err);
    report.errors.push({ row: cleanRows[0] && cleanRows[0].__rownum, error: simple.message, detail: simple.detail });
    return report;
  }
}

async function importRegularUpsert({ odoo, sheet, model, rows, options }) {
  const report = emptyReport(sheet, model);
  report.rows = rows.length;
  let modelFields = {};
  try { modelFields = await odoo.fieldsGet(model); } catch (_) { modelFields = {}; }

  for (const row of rows) {
    if (String(row.skip || '').toLowerCase() === 'true') { report.skipped++; continue; }
    try {
      const xmlid = row._external_id;
      const { vals, relationLookups, m2mLookups, skipped } = regularVals(row, modelFields, { allowUnknownFields: false });
      for (const col of skipped) report.warnings.push({ row: row.__rownum, message: `Kolom ${col} dilewati karena field tidak ada di ${model}.` });

      for (const rel of relationLookups) {
        const target = await odoo.findExternalId(rel.xmlid);
        if (!target) throw new Error(`External ID relasi tidak ditemukan: ${rel.xmlid} untuk ${rel.field}`);
        vals[rel.field] = Number(target.res_id);
      }
      for (const rel of m2mLookups) {
        const ids = [];
        for (const xmlid of rel.xmlids) {
          const target = await odoo.findExternalId(xmlid);
          if (!target) throw new Error(`External ID relasi tidak ditemukan: ${xmlid} untuk ${rel.field}`);
          ids.push(Number(target.res_id));
        }
        vals[rel.field] = [[6, 0, ids]];
      }

      if (!Object.keys(vals).length) { report.skipped++; continue; }
      const existing = xmlid ? await odoo.findExternalId(xmlid) : null;
      if (existing && existing.model === model) {
        await odoo.write(model, [Number(existing.res_id)], vals);
        report.updated++;
      } else {
        const id = await odoo.create(model, vals);
        const resId = Array.isArray(id) ? id[0] : id;
        if (xmlid) await odoo.ensureExternalId(xmlid, model, resId, true);
        report.created++;
      }
      report.processed++;
    } catch (err) {
      const simple = simplifyError(err);
      report.errors.push({ row: row.__rownum, error: simple.message, detail: simple.detail, sample: row });
      if (!options.continueOnError) break;
    }
  }
  return report;
}

async function importFieldsFast({ odoo, sheet, model, rows, options }) {
  const report = emptyReport(sheet, model);
  report.rows = rows.length;

  const groups = new Map();
  for (const row of rows) {
    if (!row.model || !row.name) {
      report.errors.push({ row: row.__rownum, error: 'ir.model.fields row wajib punya model dan name.', sample: row });
      continue;
    }
    const key = row.model;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  for (const [targetModel, groupRows] of groups.entries()) {
    const names = groupRows.map(r => r.name).filter(Boolean);
    let existing = [];
    try {
      existing = await odoo.searchRead('ir.model.fields', [
        ['model', '=', targetModel],
        ['name', 'in', names]
      ], ['id', 'name', 'ttype', 'relation'], 0);
    } catch (err) {
      const simple = simplifyError(err);
      report.errors.push({ error: simple.message, detail: simple.detail });
      continue;
    }
    const byName = Object.fromEntries(existing.map(e => [e.name, e]));
    const toCreate = [];
    const xmlids = [];

    for (const row of groupRows) {
      const ex = byName[row.name];
      if (ex) {
        if (row.ttype && ex.ttype && String(row.ttype) !== String(ex.ttype)) {
          report.skipped++;
          report.warnings.push({ row: row.__rownum, message: `Field ${row.model}.${row.name} sudah ada dengan tipe ${ex.ttype}; XLSX meminta ${row.ttype}. Dilewati agar tidak error.` });
          continue;
        }
        if (row._external_id) {
          try { await odoo.ensureExternalId(row._external_id, 'ir.model.fields', ex.id, true); } catch (_) {}
        }
        report.updated++;
        report.processed++;
        continue;
      }

      const vals = {
        model: row.model,
        name: row.name,
        field_description: row.field_description || row.name,
        ttype: row.ttype || 'char',
        required: parseBoolean(row.required, false),
        readonly: parseBoolean(row.readonly, false),
        store: row.store === '' ? true : parseBoolean(row.store, true),
        index: parseBoolean(row.index, false),
        copied: row.copied === '' ? true : parseBoolean(row.copied, true),
        state: row.state || 'manual',
        help: row.help || ''
      };
      if (row.relation) vals.relation = row.relation;
      if (row.on_delete) vals.on_delete = row.on_delete;
      if (row.ondelete) vals.ondelete = row.ondelete;
      toCreate.push(vals);
      xmlids.push(row._external_id || '');
    }

    if (toCreate.length) {
      try {
        const created = await odoo.create('ir.model.fields', toCreate);
        const ids = Array.isArray(created) ? created : [created];
        for (let i = 0; i < ids.length; i++) {
          if (xmlids[i]) {
            try { await odoo.ensureExternalId(xmlids[i], 'ir.model.fields', ids[i], true); } catch (_) {}
          }
        }
        report.created += ids.length;
        report.processed += ids.length;
      } catch (err) {
        const simple = simplifyError(err);
        // Fall back to row-by-row to isolate the exact failing field.
        for (let i = 0; i < toCreate.length; i++) {
          try {
            const id = await odoo.create('ir.model.fields', toCreate[i]);
            if (xmlids[i]) await odoo.ensureExternalId(xmlids[i], 'ir.model.fields', id, true);
            report.created++;
            report.processed++;
          } catch (rowErr) {
            const s = simplifyError(rowErr);
            report.errors.push({ row: groupRows[i] && groupRows[i].__rownum, error: s.message, detail: s.detail, sample: groupRows[i] });
            if (!options.continueOnError) return report;
          }
        }
        if (!report.errors.length) report.warnings.push({ message: `Bulk create fields fallback sukses. Error awal: ${simple.message}` });
      }
    }
  }

  return report;
}

module.exports = { importSheetBatch };
