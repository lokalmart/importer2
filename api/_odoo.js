const XLSX = require('xlsx');

function isBlank(v) { return v === undefined || v === null || String(v).trim() === ''; }
function toBool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  return ['true', '1', 'yes', 'y', 'ya', 'iya'].includes(s);
}
function toNumberOrNull(v) {
  if (isBlank(v)) return null;
  const n = Number(String(v).replace(/,/g, '.'));
  return Number.isFinite(n) ? n : null;
}
function compactObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}
function normalizeHeader(h) { return String(h || '').trim(); }
function sheetRows(workbook, sheetName) {
  if (!workbook.Sheets[sheetName]) return [];
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: false })
    .map((row) => {
      const out = {};
      for (const k of Object.keys(row)) out[normalizeHeader(k)] = row[k];
      return out;
    });
}
function parseListCell(value) {
  if (isBlank(value)) return [];
  return String(value).split(',').map((x) => x.trim()).filter(Boolean);
}
function splitExternalId(xmlid) {
  if (!xmlid || !String(xmlid).includes('.')) throw new Error(`External ID tidak valid: ${xmlid}`);
  const [module, ...rest] = String(xmlid).split('.');
  return { module, name: rest.join('.') };
}
function looksLikeModelSheet(sheet) { return /^[a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+$/.test(sheet); }

class ImportLog {
  constructor() { this.lines = []; this.warnCount = new Map(); }
  push(level, sheet, message, meta = {}) { this.lines.push({ time: new Date().toISOString(), level, sheet, message, meta }); }
  info(sheet, message, meta) { this.push('info', sheet, message, meta); }
  ok(sheet, message, meta) { this.push('ok', sheet, message, meta); }
  warn(sheet, message, meta) { this.push('warn', sheet, message, meta); }
  warnOnce(sheet, key, message, meta = {}, max = 3) {
    const k = `${sheet}:${key}:${message}`;
    const n = (this.warnCount.get(k) || 0) + 1;
    this.warnCount.set(k, n);
    if (n <= max) this.warn(sheet, message, meta);
  }
  error(sheet, message, meta) { this.push('error', sheet, message, meta); }
  summary() { return this.lines.reduce((a, l) => { a[l.level] = (a[l.level] || 0) + 1; return a; }, {}); }
}

class OdooClient {
  constructor(log = new ImportLog()) { this.log = log; this.uid = null; this.rpcId = 1; }
  get url() { return String(process.env.ODOO_URL || '').replace(/\/$/, ''); }
  get db() { return process.env.ODOO_DB || ''; }
  get username() { return process.env.ODOO_USERNAME || ''; }
  get apiKey() { return process.env.ODOO_API_KEY || ''; }
  ensureConfig() {
    const missing = [];
    if (!this.url) missing.push('ODOO_URL');
    if (!this.db) missing.push('ODOO_DB');
    if (!this.username) missing.push('ODOO_USERNAME');
    if (!this.apiKey) missing.push('ODOO_API_KEY');
    if (missing.length) throw new Error(`Environment belum lengkap: ${missing.join(', ')}`);
  }
  async jsonRpc(service, method, args) {
    this.ensureConfig();
    const payload = { jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: this.rpcId++ };
    const res = await fetch(`${this.url}/jsonrpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error(`Odoo response bukan JSON: HTTP ${res.status} ${text.slice(0, 800)}`); }
    if (!res.ok) throw new Error(`Odoo HTTP ${res.status}: ${text.slice(0, 800)}`);
    if (data.error) {
      const msg = data.error?.data?.message || data.error?.data?.debug || data.error?.message || JSON.stringify(data.error);
      throw new Error(`Odoo RPC error: ${msg}`);
    }
    return data.result;
  }
  async authenticate() {
    if (this.uid) return this.uid;
    this.log.info('AUTH', `Login ke Odoo ${this.url} db=${this.db} user=${this.username}`);
    const uid = await this.jsonRpc('common', 'login', [this.db, this.username, this.apiKey]);
    if (!uid) throw new Error('Login Odoo gagal. Periksa ODOO_DB, ODOO_USERNAME, dan ODOO_API_KEY.');
    this.uid = uid;
    this.log.ok('AUTH', `Login sukses uid=${uid}`);
    return uid;
  }
  async executeKw(model, method, args = [], kwargs = {}) {
    await this.authenticate();
    return this.jsonRpc('object', 'execute_kw', [this.db, this.uid, this.apiKey, model, method, args, kwargs]);
  }
  async searchRead(model, domain = [], fields = ['id'], limit = 0, order = '') {
    const kwargs = { fields };
    if (limit) kwargs.limit = limit;
    if (order) kwargs.order = order;
    return this.executeKw(model, 'search_read', [domain], kwargs);
  }
  async search(model, domain = [], limit = 0) {
    const kwargs = {};
    if (limit) kwargs.limit = limit;
    return this.executeKw(model, 'search', [domain], kwargs);
  }
  async create(model, values) { return this.executeKw(model, 'create', [values]); }
  async write(model, ids, values) { return this.executeKw(model, 'write', [Array.isArray(ids) ? ids : [ids], values]); }
}

const SHEET_MODEL_MAP = {
  '04_PARTNERS': 'res.partner',
  '05_PRODUCTS': 'product.template',
  '06_STOCK_LOTS': 'stock.lot',
  '07_PROJECTS': 'project.project',
  '08_PROJECT_STAGES': 'project.task.type',
  '09_PROJECT_TAGS': 'project.tags',
  '10_MILESTONES': 'project.milestone',
  '11_TASKS': 'project.task'
};
const META_SHEETS = new Set(['README', '_import_order', '_importer_rules', '_summary_check', '_accounting_category_notes', '_product_notes']);
const SILENT_HELPER_FIELDS = new Set([
  'index', '__action', 'action', '_external_id', 'external_id', 'id', 'import_note', 'notes',
  'image_url', 'photo_url', 'foto_url', 'file_name', 'image_filename', 'alt_text', 'source_page_url', 'license_note',
  'import_status', 'target_field', 'field', 'match_field', 'match_value', 'model', 'price_note'
]);

class LokalmartImporter {
  constructor(workbook, { dryRun = true } = {}) {
    this.workbook = workbook;
    this.dryRun = dryRun;
    this.log = new ImportLog();
    this.odoo = new OdooClient(this.log);
    this.cache = { model: new Map(), xmlid: new Map(), fields: new Map(), name: new Map() };
  }

  async run({ onlySheet = '' } = {}) {
    if (!this.workbook?.SheetNames?.length) throw new Error('Workbook kosong atau tidak valid.');
    this.log.info('SYSTEM', `Mode: ${this.dryRun ? 'DRY RUN / PREFLIGHT' : 'IMPORT NOW / SAFE IMPORT'}`);
    await this.odoo.authenticate();
    if (onlySheet) {
      await this.processSheet(onlySheet);
      this.log.ok('SYSTEM', `Selesai memproses sheet ${onlySheet}`);
      return { sheet: onlySheet, summary: this.log.summary(), logs: this.log.lines };
    }
    for (const sheet of this.workbook.SheetNames) await this.processSheet(sheet);
    this.log.ok('SYSTEM', 'Selesai. Importer tidak berhenti pada error baris; lihat summary dan log.');
    return { summary: this.log.summary(), logs: this.log.lines };
  }

  async processSheet(sheet) {
    if (!this.workbook.Sheets[sheet]) return;
    if (META_SHEETS.has(sheet) || sheet.startsWith('_')) return;
    try {
      if (sheet === '01_MODELS_CHECK') return await this.processModelsCheck(sheet);
      if (sheet === '02_FIELDS') return await this.processFields(sheet);
      if (sheet === '03_SELECTIONS') return await this.processSelections(sheet);
      const model = SHEET_MODEL_MAP[sheet] || (looksLikeModelSheet(sheet) ? sheet : null);
      if (!model) {
        this.log.warnOnce(sheet, 'unsupported-sheet', `Sheet dilewati karena bukan model Odoo/sheet-runner: ${sheet}`);
        return;
      }
      return await this.processGenericModelSheet(sheet, model);
    } catch (e) {
      this.log.error(sheet, `Sheet gagal tetapi proses dilanjutkan: ${e.message || String(e)}`);
    }
  }

  async runRow(sheet, rowNum, label, fn) {
    try { await fn(); } catch (e) { this.log.error(sheet, `Row ${rowNum}${label ? ` (${label})` : ''} gagal: ${e.message || String(e)}`); }
  }

  async getModelId(model) {
    if (this.cache.model.has(model)) return this.cache.model.get(model);
    const rows = await this.odoo.searchRead('ir.model', [['model', '=', model]], ['id', 'model', 'name'], 1);
    if (!rows.length) throw new Error(`Model tidak tersedia di Odoo: ${model}`);
    this.cache.model.set(model, rows[0].id);
    return rows[0].id;
  }
  async modelExists(model) { try { await this.getModelId(model); return true; } catch (e) { return false; } }
  async getModelFields(model) {
    if (this.cache.fields.has(model)) return this.cache.fields.get(model);
    const fields = await this.odoo.executeKw(model, 'fields_get', [], { attributes: ['string', 'type', 'selection', 'readonly', 'required', 'relation', 'store'] });
    this.cache.fields.set(model, fields || {});
    return fields || {};
  }

  async resolveXmlId(xmlid, expectedModel = null) {
    if (isBlank(xmlid)) return null;
    const key = expectedModel ? `${xmlid}|${expectedModel}` : String(xmlid);
    if (this.cache.xmlid.has(key)) return this.cache.xmlid.get(key);
    if (this.cache.xmlid.has(String(xmlid))) return this.cache.xmlid.get(String(xmlid));
    const { module, name } = splitExternalId(xmlid);
    const domain = [['module', '=', module], ['name', '=', name]];
    if (expectedModel) domain.push(['model', '=', expectedModel]);
    const rows = await this.odoo.searchRead('ir.model.data', domain, ['id', 'model', 'res_id'], 1);
    if (!rows.length) return null;
    this.cache.xmlid.set(String(xmlid), rows[0].res_id);
    this.cache.xmlid.set(`${xmlid}|${rows[0].model || expectedModel}`, rows[0].res_id);
    return rows[0].res_id;
  }
  async ensureXmlId(xmlid, model, resId, sheet) {
    if (isBlank(xmlid) || !resId || this.dryRun) return;
    const { module, name } = splitExternalId(xmlid);
    const rows = await this.odoo.searchRead('ir.model.data', [['module', '=', module], ['name', '=', name]], ['id', 'model', 'res_id'], 1);
    if (rows.length) return;
    await this.odoo.create('ir.model.data', { module, name, model, res_id: resId, noupdate: true });
    this.cache.xmlid.set(String(xmlid), resId);
  }
  async findByName(model, name) {
    if (isBlank(name)) return null;
    const key = `${model}|name|${name}`;
    if (this.cache.name.has(key)) return this.cache.name.get(key);
    const rows = await this.odoo.searchRead(model, [['name', '=', name]], ['id', 'name'], 1);
    const id = rows[0]?.id || null;
    if (id) this.cache.name.set(key, id);
    return id;
  }
  async resolveRelation(value, relationModel, sheet, required = false) {
    if (isBlank(value)) return null;
    let id = null;
    const s = String(value).trim();
    if (/^\d+$/.test(s)) id = Number(s);
    else if (s.includes('.')) id = await this.resolveXmlId(s, relationModel);
    else id = await this.findByName(relationModel, s);
    if (!id && required) throw new Error(`Relasi wajib tidak ditemukan: ${s} (${relationModel})`);
    if (!id) this.log.warnOnce(sheet, `missing-rel:${relationModel}:${s}`, `Relasi tidak ditemukan dan dikosongkan: ${s} (${relationModel})`);
    return id || null;
  }
  async relationCommand(cell, relationModel, sheet) {
    const ids = [];
    for (const item of parseListCell(cell)) {
      const id = await this.resolveRelation(item, relationModel, sheet, false);
      if (id) ids.push(id);
    }
    return ids.length ? [[6, 0, ids]] : undefined;
  }

  selectionAlias(model, field, value, allowed) {
    const raw = String(value).trim();
    const lower = raw.toLowerCase();
    const aliases = {
      'product.template.type': { product: 'consu', storable: 'consu', stockable: 'consu', goods: 'consu', barang: 'consu', consumable: 'consu', jasa: 'service' },
      'product.template.detailed_type': { consu: 'product', stockable: 'product', goods: 'product', barang: 'product', jasa: 'service' },
      'project.task.priority': { 2: '1', high: '1', urgent: '1', normal: '0', low: '0' }
    };
    const key = `${model}.${field}`;
    const mapped = aliases[key]?.[lower];
    if (mapped && allowed.includes(mapped)) return mapped;
    if (allowed.includes(raw)) return raw;
    if (allowed.includes(lower)) return lower;
    return null;
  }
  convertScalar(model, field, value, def, sheet) {
    if (isBlank(value)) return undefined;
    if (def.type === 'boolean') return toBool(value, false);
    if (['integer', 'monetary'].includes(def.type)) return toNumberOrNull(value);
    if (def.type === 'float') return toNumberOrNull(value);
    if (def.type === 'selection') {
      const allowed = Array.isArray(def.selection) ? def.selection.map((x) => Array.isArray(x) ? String(x[0]) : String(x)) : [];
      if (allowed.length) {
        const safe = this.selectionAlias(model, field, value, allowed);
        if (!safe) {
          this.log.warnOnce(sheet, `bad-selection:${model}.${field}:${value}`, `Nilai selection tidak valid dan dilewati: ${model}.${field}='${value}'. Pilihan valid: ${allowed.join(', ')}`);
          return undefined;
        }
        return safe;
      }
    }
    return value;
  }

  fieldCandidatesFromExternalKey(key, fields) {
    const candidates = [];
    if (key.endsWith('_id_external_id') || key.endsWith('_ids_external_id')) candidates.push(key.replace(/_external_id$/, ''));
    if (key.endsWith('_external_id')) {
      const base = key.replace(/_external_id$/, '');
      candidates.push(base);
      if (!base.endsWith('_id')) candidates.push(`${base}_id`);
      if (!base.endsWith('_ids')) candidates.push(`${base}_ids`);
    }
    if (key.endsWith('_external_ids')) {
      const base = key.replace(/_external_ids$/, '');
      candidates.push(`${base}_ids`, base);
    }
    return candidates.filter((c, i, a) => c && a.indexOf(c) === i && fields[c]);
  }
  async buildPayload(model, row, sheet, context = 'write') {
    const fields = await this.getModelFields(model);
    const out = {};
    const skipped = [];
    for (const [rawField, rawValue] of Object.entries(row || {})) {
      const field = normalizeHeader(rawField);
      const value = rawValue;
      if (SILENT_HELPER_FIELDS.has(field) || isBlank(value)) continue;

      if (field.includes('/')) {
        const [realField, marker] = field.split('/');
        const def = fields[realField];
        if (!def) { skipped.push(field); continue; }
        if (marker === 'id' && ['many2one', 'many2many'].includes(def.type)) {
          if (def.type === 'many2one') out[realField] = await this.resolveRelation(value, def.relation, sheet, !!def.required);
          else out[realField] = await this.relationCommand(value, def.relation, sheet);
        }
        continue;
      }

      const externalCandidates = this.fieldCandidatesFromExternalKey(field, fields);
      if (externalCandidates.length) {
        const realField = externalCandidates[0];
        const def = fields[realField];
        if (def.type === 'many2one') out[realField] = await this.resolveRelation(value, def.relation, sheet, !!def.required);
        else if (def.type === 'many2many') out[realField] = await this.relationCommand(value, def.relation, sheet);
        else out[realField] = value;
        continue;
      }

      const specialNameMap = { uom_name: 'uom_id', uom_po_name: 'uom_po_id', currency_name: 'currency_id', currency_id_name: 'currency_id', country_name: 'country_id', state_name: 'state_id' };
      if (specialNameMap[field] && fields[specialNameMap[field]]) {
        const realField = specialNameMap[field];
        out[realField] = await this.resolveRelation(value, fields[realField].relation, sheet, !!fields[realField].required);
        continue;
      }

      const def = fields[field];
      if (!def) { skipped.push(field); continue; }
      if (def.readonly && context === 'write' && field !== 'id') { skipped.push(`${field}:readonly`); continue; }
      if (def.type === 'many2one') out[field] = await this.resolveRelation(value, def.relation, sheet, !!def.required);
      else if (def.type === 'many2many') out[field] = await this.relationCommand(value, def.relation, sheet);
      else {
        const safe = this.convertScalar(model, field, value, def, sheet);
        if (safe !== undefined) out[field] = safe;
      }
    }
    if (skipped.length) {
      this.log.warnOnce(sheet, `skipped:${model}`, `Sebagian kolom dilewati pada ${model} karena bukan field valid/readonly.`, { skipped: skipped.slice(0, 20), count: skipped.length }, 1);
    }
    return compactObject(out);
  }

  async findExisting(model, row, payload) {
    const xmlid = row._external_id || row.external_id || (String(row.id || '').includes('.') ? row.id : '');
    if (!isBlank(xmlid)) {
      const id = await this.resolveXmlId(xmlid, model);
      if (id) return { id, source: 'xmlid' };
    }
    const tryDomains = [];
    if (payload.default_code) tryDomains.push([['default_code', '=', payload.default_code]]);
    if (payload.barcode) tryDomains.push([['barcode', '=', payload.barcode]]);
    if (payload.name) {
      if (model === 'product.supplierinfo' && payload.partner_id && payload.product_tmpl_id) tryDomains.push([['partner_id', '=', payload.partner_id], ['product_tmpl_id', '=', payload.product_tmpl_id]]);
      else tryDomains.push([['name', '=', payload.name]]);
    }
    if (model === 'product.attribute.value' && payload.attribute_id && payload.name) tryDomains.unshift([['attribute_id', '=', payload.attribute_id], ['name', '=', payload.name]]);
    if (model === 'product.template.attribute.line' && payload.product_tmpl_id && payload.attribute_id) tryDomains.unshift([['product_tmpl_id', '=', payload.product_tmpl_id], ['attribute_id', '=', payload.attribute_id]]);
    for (const domain of tryDomains) {
      try {
        const rows = await this.odoo.searchRead(model, domain, ['id'], 1);
        if (rows.length) return { id: rows[0].id, source: 'domain' };
      } catch (e) {}
    }
    return null;
  }

  async processGenericModelSheet(sheet, model) {
    const rows = sheetRows(this.workbook, sheet);
    if (!rows.length) { this.log.info(sheet, 'Sheet kosong/tidak ada, dilewati.'); return; }
    if (!await this.modelExists(model)) { this.log.warn(sheet, `Model tidak tersedia di Odoo, sheet dilewati: ${model}`); return; }
    let created = 0, updated = 0, skipped = 0;
    for (const [i, row] of rows.entries()) {
      await this.runRow(sheet, i + 2, row.name || row.default_code || row._external_id || row.external_id, async () => {
        const action = String(row.__action || row.action || 'upsert').trim().toLowerCase();
        if (['skip', 'ignore', 'no'].includes(action)) { skipped++; return; }
        const xmlid = row._external_id || row.external_id || (String(row.id || '').includes('.') ? row.id : '');
        const payload = await this.buildPayload(model, row, sheet, 'write');
        if (!Object.keys(payload).length) { skipped++; this.log.warnOnce(sheet, `empty-payload:${model}`, `Baris dilewati karena tidak ada field valid untuk ${model}.`, {}, 3); return; }
        const existing = action === 'create' ? null : await this.findExisting(model, row, payload);
        if (existing) {
          if (this.dryRun) this.log.info(sheet, `[dry-run] update ${model}`, { id: existing.id, source: existing.source });
          else await this.odoo.write(model, existing.id, payload);
          updated++;
          await this.ensureXmlId(xmlid, model, existing.id, sheet);
        } else {
          if (action === 'update') { skipped++; this.log.warn(sheet, `Update dilewati karena record tidak ditemukan: ${model} ${xmlid || payload.name || ''}`); return; }
          if (this.dryRun) {
            created++;
            this.log.info(sheet, `[dry-run] create ${model}`, { xmlid, payload_keys: Object.keys(payload) });
          } else {
            const id = await this.odoo.create(model, payload);
            created++;
            await this.ensureXmlId(xmlid, model, id, sheet);
          }
        }
      });
    }
    this.log.ok(sheet, `Selesai ${model}: created=${created}, updated=${updated}, skipped=${skipped}`);
  }

  async processModelsCheck(sheet = '01_MODELS_CHECK') {
    const rows = sheetRows(this.workbook, sheet);
    if (!rows.length) { this.log.info(sheet, 'Sheet kosong/tidak ada, dilewati.'); return; }
    for (const [i, row] of rows.entries()) {
      await this.runRow(sheet, i + 2, row.model, async () => {
        const model = row.model || row.technical_model || row.name;
        if (isBlank(model)) return;
        const required = toBool(row.required, true);
        const exists = await this.modelExists(model);
        if (exists) this.log.ok(sheet, `Model tersedia: ${model}`);
        else if (required) throw new Error(`Model wajib tidak tersedia: ${model}`);
        else this.log.warn(sheet, `Model opsional tidak tersedia: ${model}`);
      });
    }
  }

  async processFields(sheet = '02_FIELDS') {
    const rows = sheetRows(this.workbook, sheet);
    if (!rows.length) { this.log.info(sheet, 'Sheet kosong/tidak ada, dilewati.'); return; }
    for (const [i, row] of rows.entries()) {
      await this.runRow(sheet, i + 2, row.name, async () => {
        const xmlid = row._external_id || row.external_id || row.id;
        const model = row.model || row['model_id/model'];
        const name = row.name;
        const ttype = row.ttype || row.field_type;
        if (isBlank(model) || isBlank(name) || isBlank(ttype)) { this.log.warn(sheet, `Row ${i + 2} dilewati: model/name/ttype kosong.`); return; }
        if (!String(name).startsWith('x_')) throw new Error(`Custom field wajib diawali x_: ${name}`);
        if (!await this.modelExists(model)) { this.log.warn(sheet, `Model belum ada, field dilewati: ${model}.${name}`); return; }
        const existing = await this.odoo.searchRead('ir.model.fields', [['model', '=', model], ['name', '=', name]], ['id', 'ttype'], 1);
        if (existing.length) {
          await this.ensureXmlId(xmlid, 'ir.model.fields', existing[0].id, sheet);
          this.cache.fields.delete(model);
          this.log.ok(sheet, `Field sudah ada: ${model}.${name}`);
          return;
        }
        const modelId = await this.getModelId(model);
        const values = compactObject({ name, field_description: row.field_description || row.field_label || name, model_id: modelId, ttype, relation: row.relation, state: 'manual', store: toBool(row.store, true), required: toBool(row.required, false), readonly: toBool(row.readonly, false), copied: toBool(row.copied, true), help: row.help || row.notes });
        if (this.dryRun) { this.log.info(sheet, `[dry-run] create field ${model}.${name}`); return; }
        const id = await this.odoo.create('ir.model.fields', values);
        this.cache.fields.delete(model);
        await this.ensureXmlId(xmlid, 'ir.model.fields', id, sheet);
        this.log.ok(sheet, `Field dibuat: ${model}.${name}`, { id });
      });
    }
  }

  async processSelections(sheet = '03_SELECTIONS') {
    const rows = sheetRows(this.workbook, sheet);
    if (!rows.length) { this.log.info(sheet, 'Sheet kosong/tidak ada, dilewati.'); return; }
    if (!await this.modelExists('ir.model.fields.selection')) { this.log.warn(sheet, 'Model ir.model.fields.selection tidak tersedia, dilewati.'); return; }
    for (const [i, row] of rows.entries()) {
      await this.runRow(sheet, i + 2, row.value, async () => {
        const value = row.value;
        const label = row.name || row.label;
        if (isBlank(value) || isBlank(label)) return;
        let fieldId = null;
        const fieldXmlid = row.field_external_id || row['field_id/id'];
        if (!isBlank(fieldXmlid)) fieldId = await this.resolveXmlId(fieldXmlid, 'ir.model.fields');
        if (!fieldId && !isBlank(row.model) && !isBlank(row.field_name)) {
          const found = await this.odoo.searchRead('ir.model.fields', [['model', '=', row.model], ['name', '=', row.field_name]], ['id'], 1);
          fieldId = found[0]?.id || null;
        }
        if (!fieldId) { this.log.warn(sheet, `Field selection tidak ditemukan: ${fieldXmlid || `${row.model}.${row.field_name}`}`); return; }
        const exists = await this.odoo.searchRead('ir.model.fields.selection', [['field_id', '=', fieldId], ['value', '=', value]], ['id'], 1);
        if (exists.length) { this.log.ok(sheet, `Selection sudah ada: ${value}`); return; }
        if (this.dryRun) { this.log.info(sheet, `[dry-run] create selection ${value}`); return; }
        const id = await this.odoo.create('ir.model.fields.selection', { field_id: fieldId, value, name: label, sequence: toNumberOrNull(row.sequence) || 10 });
        this.log.ok(sheet, `Selection dibuat: ${value}`, { id });
      });
    }
  }
}

module.exports = { LokalmartImporter, ImportLog, OdooClient, toBool, toNumberOrNull, sheetRows };
