const XLSX = require('xlsx');

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

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
  Object.entries(obj || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  });
  return out;
}

function normalizeHeader(h) {
  return String(h || '').trim();
}

function sheetRows(workbook, sheetName) {
  if (!workbook.Sheets[sheetName]) return [];
  return XLSX.utils
    .sheet_to_json(workbook.Sheets[sheetName], {
      defval: '',
      raw: false
    })
    .map((row) => {
      const out = {};
      Object.keys(row).forEach((k) => {
        out[normalizeHeader(k)] = row[k];
      });
      return out;
    });
}

function parseListCell(value) {
  if (isBlank(value)) return [];
  return String(value)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function splitExternalId(xmlid) {
  if (!xmlid || !String(xmlid).includes('.')) {
    throw new Error(`External ID tidak valid: ${xmlid}`);
  }

  const [module, ...rest] = String(xmlid).split('.');
  return {
    module,
    name: rest.join('.')
  };
}

class ImportLog {
  constructor() {
    this.lines = [];
  }

  push(level, sheet, message, meta = {}) {
    this.lines.push({
      time: new Date().toISOString(),
      level,
      sheet,
      message,
      meta
    });
  }

  info(sheet, message, meta) {
    this.push('info', sheet, message, meta);
  }

  ok(sheet, message, meta) {
    this.push('ok', sheet, message, meta);
  }

  warn(sheet, message, meta) {
    this.push('warn', sheet, message, meta);
  }

  error(sheet, message, meta) {
    this.push('error', sheet, message, meta);
  }

  summary() {
    return this.lines.reduce((a, l) => {
      a[l.level] = (a[l.level] || 0) + 1;
      return a;
    }, {});
  }
}

class OdooClient {
  constructor(config = {}, log = new ImportLog()) {
    this.log = log;
    this.uid = null;
    this.rpcId = 1;
  }

  get url() {
    return String(process.env.ODOO_URL || '').replace(/\/$/, '');
  }

  get db() {
    return process.env.ODOO_DB || '';
  }

  get username() {
    return process.env.ODOO_USERNAME || '';
  }

  get apiKey() {
    return process.env.ODOO_API_KEY || '';
  }

  ensureConfig() {
    const missing = [];
    if (!this.url) missing.push('ODOO_URL');
    if (!this.db) missing.push('ODOO_DB');
    if (!this.username) missing.push('ODOO_USERNAME');
    if (!this.apiKey) missing.push('ODOO_API_KEY');

    if (missing.length) {
      throw new Error(`Environment belum lengkap: ${missing.join(', ')}`);
    }
  }

  async jsonRpc(service, method, args) {
    this.ensureConfig();

    const payload = {
      jsonrpc: '2.0',
      method: 'call',
      params: {
        service,
        method,
        args
      },
      id: this.rpcId++
    };

    const res = await fetch(`${this.url}/jsonrpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`Odoo response bukan JSON: HTTP ${res.status} ${text.slice(0, 800)}`);
    }

    if (!res.ok) {
      throw new Error(`Odoo HTTP ${res.status}: ${text.slice(0, 800)}`);
    }

    if (data.error) {
      const msg =
        data.error?.data?.message ||
        data.error?.message ||
        JSON.stringify(data.error);

      throw new Error(`Odoo RPC error: ${msg}`);
    }

    return data.result;
  }

  async authenticate() {
    if (this.uid) return this.uid;

    this.log.info('AUTH', `Login ke Odoo ${this.url} db=${this.db} user=${this.username}`);

    const uid = await this.jsonRpc('common', 'login', [
      this.db,
      this.username,
      this.apiKey
    ]);

    if (!uid) {
      throw new Error('Login Odoo gagal. Periksa ODOO_DB, ODOO_USERNAME, dan ODOO_API_KEY.');
    }

    this.uid = uid;
    this.log.ok('AUTH', `Login sukses uid=${uid}`);
    return uid;
  }

  async executeKw(model, method, args = [], kwargs = {}) {
    await this.authenticate();

    return this.jsonRpc('object', 'execute_kw', [
      this.db,
      this.uid,
      this.apiKey,
      model,
      method,
      args,
      kwargs
    ]);
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

  async create(model, values) {
    return this.executeKw(model, 'create', [values]);
  }

  async write(model, ids, values) {
    return this.executeKw(model, 'write', [Array.isArray(ids) ? ids : [ids], values]);
  }
}

class LokalmartImporter {
  constructor(workbook, { dryRun = true } = {}) {
    this.workbook = workbook;
    this.dryRun = dryRun;
    this.log = new ImportLog();
    this.odoo = new OdooClient({}, this.log);

    this.cache = {
      model: new Map(),
      xmlid: new Map(),
      fields: new Map(),
      virtualFields: new Map()
    };

    this.virtualCounter = 1;
  }

  async run() {
    if (!this.workbook?.SheetNames?.length) {
      throw new Error('Workbook kosong atau tidak valid.');
    }

    this.log.info('SYSTEM', `Mode: ${this.dryRun ? 'DRY RUN / PREFLIGHT' : 'IMPORT NOW / SAFE IMPORT'}`);

    await this.odoo.authenticate();

    await this.runStep('01_MODELS_CHECK', () => this.processModelsCheck());
    await this.runStep('02_FIELDS', () => this.processFields());
    await this.runStep('03_SELECTIONS', () => this.processSelections());
    await this.runStep('04_PARTNERS', () => this.processPartners());
    await this.runStep('05_PRODUCTS', () => this.processProducts());
    await this.runStep('06_STOCK_LOTS', () => this.processStockLots());
    await this.runStep('07_PROJECTS', () => this.processProjects());
    await this.runStep('08_PROJECT_STAGES', () => this.processProjectStages());
    await this.runStep('09_PROJECT_TAGS', () => this.processProjectTags());
    await this.runStep('10_MILESTONES', () => this.processMilestones());
    await this.runStep('11_TASKS', () => this.processTasks());
    await this.runStep('12_WEBSITE_PAGES', () => this.processWebsitePages());
    await this.runStep('13_QR_ID_REGISTRY', () => this.processQrRegistry());

    this.log.ok('SYSTEM', 'Selesai. Importer tidak berhenti pada error baris; lihat summary dan log.');

    return {
      summary: this.log.summary(),
      logs: this.log.lines
    };
  }

  async runStep(sheet, fn) {
    try {
      await fn();
    } catch (e) {
      this.log.error(sheet, `Sheet gagal tetapi proses dilanjutkan: ${e.message}`);
    }
  }

  async runRow(sheet, rowNum, label, fn) {
    try {
      await fn();
    } catch (e) {
      this.log.error(sheet, `Row ${rowNum}${label ? ` (${label})` : ''} gagal: ${e.message}`);
    }
  }

  makeDryId(model, xmlid = '') {
    const safe = String(xmlid || `row_${this.virtualCounter++}`).replace(/[^a-zA-Z0-9_.-]/g, '_');
    return `__dryrun__:${model}:${safe}`;
  }

  isDryId(v) {
    return typeof v === 'string' && v.startsWith('__dryrun__:');
  }

  cacheXmlId(xmlid, model, resId) {
    if (isBlank(xmlid) || !resId) return;

    this.cache.xmlid.set(String(xmlid), resId);
    this.cache.xmlid.set(`${xmlid}|${model}`, resId);
  }

  dryRecord(xmlid, model, sheet, message) {
    const id = this.makeDryId(model, xmlid);
    this.cacheXmlId(xmlid, model, id);
    this.log.info(sheet, message, { virtual_id: id });
    return id;
  }

  async getModelId(model) {
    if (this.cache.model.has(model)) return this.cache.model.get(model);

    const rows = await this.odoo.searchRead(
      'ir.model',
      [['model', '=', model]],
      ['id', 'model', 'name'],
      1
    );

    if (!rows.length) {
      throw new Error(`Model tidak tersedia di Odoo: ${model}`);
    }

    this.cache.model.set(model, rows[0].id);
    return rows[0].id;
  }

  async modelExists(model) {
    try {
      await this.getModelId(model);
      return true;
    } catch (e) {
      return false;
    }
  }

  async getModelFields(model) {
    if (this.cache.fields.has(model)) return this.cache.fields.get(model);

    const fields = await this.odoo.executeKw(
      model,
      'fields_get',
      [],
      {
        attributes: [
          'string',
          'type',
          'selection',
          'readonly',
          'required',
          'relation',
          'store'
        ]
      }
    );

    this.cache.fields.set(model, fields || {});
    return fields || {};
  }

  registerVirtualField(model, fieldName, def = {}) {
    if (!this.cache.virtualFields.has(model)) {
      this.cache.virtualFields.set(model, new Map());
    }

    this.cache.virtualFields.get(model).set(fieldName, def);
  }

  async hasField(model, fieldName) {
    const fields = await this.getModelFields(model);
    const virtual = this.cache.virtualFields.get(model);
    return !!fields[fieldName] || !!virtual?.has(fieldName);
  }

  selectionAliases(model, field, value, allowed) {
    const raw = String(value).trim();
    const lower = raw.toLowerCase();

    const aliases = {
      'res.partner.x_lokal_member_type': {
        umkm: 'member',
        vendor: 'member',
        customer: 'public',
        pembeli: 'public',
        member_koperasi: 'koperasi',
        koperasi_outlet: 'koperasi',
        outlet: 'koperasi',
        umkm_premium: 'premium',
        staff: 'worker',
        kasir: 'worker',
        surveyor: 'worker'
      },
      'res.partner.x_lokal_role': {
        cashier: 'kasir',
        admin: 'worker',
        staff: 'worker',
        employee: 'worker',
        customer: 'public',
        pembeli: 'public',
        umkm: 'vendor'
      },
      'res.partner.x_lokal_verification_status': {
        active: 'verified',
        valid: 'verified',
        approve: 'verified',
        approved: 'verified',
        pending_review: 'pending',
        inactive: 'draft'
      },
      'product.template.x_lokal_tracking_level': {
        product: 'product',
        batch: 'batch',
        lot: 'batch',
        unit: 'unit',
        serial: 'unit'
      },
      'product.template.x_lokal_verification_status': {
        active: 'verified',
        valid: 'verified',
        approve: 'verified',
        approved: 'verified',
        pending_review: 'pending',
        inactive: 'draft'
      },
      'stock.lot.x_lokal_status': {
        available: 'active',
        active: 'active',
        sold: 'sold',
        terjual: 'sold',
        reserved: 'reserved',
        rusak: 'damaged',
        damaged: 'damaged'
      },
      'project.task.priority': {
        2: '1',
        high: '1',
        urgent: '1',
        normal: '0',
        low: '0'
      },
      'product.template.type': {
        product: 'consu',
        storable: 'consu',
        stockable: 'consu',
        goods: 'consu',
        barang: 'consu',
        consumable: 'consu',
        jasa: 'service'
      },
      'product.template.detailed_type': {
        consu: 'product',
        stockable: 'product',
        goods: 'product',
        barang: 'product',
        jasa: 'service'
      }
    };

    const key = `${model}.${field}`;
    const mapped = aliases[key]?.[lower];

    if (mapped && allowed.includes(mapped)) return mapped;

    if (allowed.includes(raw)) return raw;

    if (allowed.includes(lower)) return lower;

    return null;
  }

  async sanitizeValues(model, values, sheet, context = 'write') {
    const cleaned = compactObject(values);
    const fields = await this.getModelFields(model);
    const virtual = this.cache.virtualFields.get(model) || new Map();

    const out = {};

    for (const [field, value] of Object.entries(cleaned)) {
      const def = fields[field] || virtual.get(field);

      if (!def) {
        this.log.warn(sheet, `Field dilewati karena tidak ada di ${model}: ${field}`);
        continue;
      }

      if (!this.dryRun && this.isDryId(value)) {
        this.log.warn(sheet, `Field ${model}.${field} dilewati karena masih virtual dry-run.`);
        continue;
      }

      if (def.readonly && context === 'write' && field !== 'id') {
        this.log.warn(sheet, `Field readonly dilewati: ${model}.${field}`);
        continue;
      }

      if (def.type === 'selection' && !isBlank(value)) {
        const allowed = Array.isArray(def.selection)
          ? def.selection.map((x) => Array.isArray(x) ? String(x[0]) : String(x))
          : [];

        if (allowed.length) {
          const safe = this.selectionAliases(model, field, value, allowed);

          if (!safe) {
            this.log.warn(
              sheet,
              `Nilai selection tidak valid dan dilewati: ${model}.${field}='${value}'. Pilihan valid: ${allowed.join(', ')}`
            );
            continue;
          }

          if (String(value) !== String(safe)) {
            this.log.warn(sheet, `Selection disesuaikan: ${model}.${field} '${value}' → '${safe}'`);
          }

          out[field] = safe;
          continue;
        }
      }

      out[field] = value;
    }

    return out;
  }

  async createSafe(model, values, sheet, message) {
    const safe = await this.sanitizeValues(model, values, sheet, 'create');

    if (!Object.keys(safe).length) {
      this.log.warn(sheet, `Create ${model} dilewati karena tidak ada field valid.`);
      return null;
    }

    const id = await this.odoo.create(model, safe);
    this.log.ok(sheet, message, { id });
    return id;
  }

  async writeSafe(model, id, values, sheet, message) {
    if (!id || this.isDryId(id)) {
      this.log.info(sheet, `[dry-run] write ${model} ${id || ''}`);
      return;
    }

    const safe = await this.sanitizeValues(model, values, sheet, 'write');

    if (!Object.keys(safe).length) {
      this.log.warn(sheet, `Write ${model}:${id} dilewati karena tidak ada field valid.`);
      return;
    }

    await this.odoo.write(model, id, safe);
    this.log.ok(sheet, message, { id });
  }

  domainHasDryId(domain) {
    if (!Array.isArray(domain)) return false;

    for (const item of domain) {
      if (Array.isArray(item)) {
        if (this.domainHasDryId(item)) return true;
      } else if (this.isDryId(item)) {
        return true;
      }
    }

    return false;
  }

  async resolveXmlId(xmlid, expectedModel = null) {
    if (isBlank(xmlid)) return null;

    const key = expectedModel ? `${xmlid}|${expectedModel}` : String(xmlid);

    if (this.cache.xmlid.has(key)) return this.cache.xmlid.get(key);
    if (this.cache.xmlid.has(String(xmlid))) return this.cache.xmlid.get(String(xmlid));

    const { module, name } = splitExternalId(xmlid);

    const domain = [
      ['module', '=', module],
      ['name', '=', name]
    ];

    if (expectedModel) {
      domain.push(['model', '=', expectedModel]);
    }

    const rows = await this.odoo.searchRead(
      'ir.model.data',
      domain,
      ['id', 'model', 'res_id'],
      1
    );

    if (!rows.length) return null;

    this.cacheXmlId(xmlid, rows[0].model || expectedModel, rows[0].res_id);
    return rows[0].res_id;
  }

  async ensureXmlId(xmlid, model, resId, sheet) {
    if (isBlank(xmlid) || !resId) return;

    this.cacheXmlId(xmlid, model, resId);

    if (this.isDryId(resId)) return;

    const { module, name } = splitExternalId(xmlid);

    const rows = await this.odoo.searchRead(
      'ir.model.data',
      [
        ['module', '=', module],
        ['name', '=', name]
      ],
      ['id', 'model', 'res_id'],
      1
    );

    if (rows.length) {
      this.cacheXmlId(xmlid, rows[0].model, rows[0].res_id);
      return;
    }

    if (this.dryRun) {
      this.log.info(sheet, `[dry-run] create External ID ${xmlid}`);
      return;
    }

    await this.odoo.create('ir.model.data', {
      module,
      name,
      model,
      res_id: resId,
      noupdate: true
    });

    this.log.ok(sheet, `External ID dibuat: ${xmlid}`);
  }

  async findByXmlIdOrDomain(xmlid, model, domain, fields = ['id']) {
    if (!isBlank(xmlid)) {
      const id = await this.resolveXmlId(xmlid, model);
      if (id) return { id, source: 'xmlid' };
    }

    if (this.dryRun && this.domainHasDryId(domain)) return null;

    try {
      const rows = await this.odoo.searchRead(model, domain, fields, 1);
      return rows.length ? { id: rows[0].id, source: 'domain', row: rows[0] } : null;
    } catch (e) {
      this.log.warn('LOOKUP', `Lookup ${model} gagal, dianggap belum ada.`, {
        error: e.message,
        domain
      });
      return null;
    }
  }

  async m2o(xmlid, model, sheet, required = false) {
    if (isBlank(xmlid)) return null;

    const id = await this.resolveXmlId(xmlid, model);

    if (!id && required) {
      if (this.dryRun) {
        const dry = this.makeDryId(model, xmlid);
        this.cacheXmlId(xmlid, model, dry);
        this.log.warn(sheet, `[dry-run] relasi wajib belum ada di Odoo tetapi disimulasikan: ${xmlid}`);
        return dry;
      }

      throw new Error(`Relasi wajib tidak ditemukan: ${xmlid} (${model})`);
    }

    if (!id) {
      this.log.warn(sheet, `Relasi tidak ditemukan dan dikosongkan: ${xmlid} (${model})`);
    }

    return id || null;
  }

  async m2m(cell, model, sheet) {
    const ids = [];

    for (const xmlid of parseListCell(cell)) {
      const id = await this.resolveXmlId(xmlid, model);

      if (id) ids.push(id);
      else this.log.warn(sheet, `Many2many XMLID tidak ditemukan: ${xmlid}`);
    }

    return ids.length ? [[6, 0, ids]] : undefined;
  }

  async buildLookupDomain(model, preferredField, preferredValue, fallbackDomain) {
    if (!isBlank(preferredField) && !isBlank(preferredValue) && await this.hasField(model, preferredField)) {
      return [[preferredField, '=', preferredValue]];
    }

    return fallbackDomain;
  }

  async adaptProductType(row, sheet) {
    const fields = await this.getModelFields('product.template');

    const raw = row.type || row.detailed_type || 'consu';

    if (fields.type) return { type: raw };
    if (fields.detailed_type) return { detailed_type: raw };

    this.log.warn(sheet, 'product.template tidak punya field type/detailed_type; tipe produk dilewati.');
    return {};
  }

  async sanitizeBarcode(row, found, sheet) {
    const barcode = row.barcode;
    if (isBlank(barcode)) return null;

    if (this.dryRun) return barcode;

    const existingTemplates = await this.odoo.searchRead(
      'product.template',
      [['barcode', '=', barcode]],
      ['id', 'name', 'default_code', 'barcode'],
      5
    );

    const currentId = found?.id;

    const conflict = existingTemplates.find((p) => p.id !== currentId);

    if (conflict) {
      this.log.warn(
        sheet,
        `Barcode '${barcode}' sudah dipakai oleh produk '${conflict.name}'. Barcode untuk baris ini dilewati agar import tidak gagal.`
      );
      return null;
    }

    return barcode;
  }

  async processModelsCheck() {
    const sheet = '01_MODELS_CHECK';
    const rows = sheetRows(this.workbook, sheet);

    if (!rows.length) {
      this.log.info(sheet, 'Sheet kosong/tidak ada, dilewati.');
      return;
    }

    for (const [i, row] of rows.entries()) {
      await this.runRow(sheet, i + 2, row.model, async () => {
        const model = row.model || row.technical_model || row.name;
        if (isBlank(model)) return;

        const required = toBool(row.required, true);
        const exists = await this.modelExists(model);

        if (exists) {
          this.log.ok(sheet, `Model tersedia: ${model}`);
        } else if (required) {
          throw new Error(`Model wajib tidak tersedia: ${model}`);
        } else {
          this.log.warn(sheet, `Model opsional tidak tersedia: ${model}`);
        }
      });
    }
  }

  async processFields() {
    const sheet = '02_FIELDS';
    const rows = sheetRows(this.workbook, sheet);

    if (!rows.length) {
      this.log.info(sheet, 'Sheet kosong/tidak ada, dilewati.');
      return;
    }

    for (const [i, row] of rows.entries()) {
      await this.runRow(sheet, i + 2, row.name, async () => {
        const xmlid = row.external_id || row.id;
        const model = row.model || row['model_id/model'];
        const name = row.name;
        const ttype = row.ttype || row.field_type;

        if (isBlank(model) || isBlank(name) || isBlank(ttype)) {
          this.log.warn(sheet, `Row ${i + 2} dilewati: model/name/ttype kosong.`);
          return;
        }

        if (!String(name).startsWith('x_')) {
          throw new Error(`Custom field wajib diawali x_: ${name}`);
        }

        const modelId = await this.getModelId(model);

        const existing = await this.odoo.searchRead(
          'ir.model.fields',
          [
            ['model', '=', model],
            ['name', '=', name]
          ],
          ['id', 'ttype'],
          1
        );

        if (existing.length) {
          if (existing[0].ttype !== ttype) {
            throw new Error(`Field ${model}.${name} sudah ada tapi tipe ${existing[0].ttype}, bukan ${ttype}`);
          }

          this.registerVirtualField(model, name, { type: ttype });
          await this.ensureXmlId(xmlid, 'ir.model.fields', existing[0].id, sheet);
          this.log.ok(sheet, `Field sudah ada: ${model}.${name}`);
          return;
        }

        const values = compactObject({
          name,
          field_description: row.field_description || row.field_label || name,
          model_id: modelId,
          ttype,
          relation: row.relation,
          state: 'manual',
          store: toBool(row.store, true),
          required: toBool(row.required, false),
          readonly: toBool(row.readonly, false),
          index: toBool(row.index, false),
          copied: toBool(row.copied, true),
          help: row.help || row.notes
        });

        if (this.dryRun) {
          this.registerVirtualField(model, name, { type: ttype });
          this.dryRecord(xmlid, 'ir.model.fields', sheet, `[dry-run] create field ${model}.${name}`);
          return;
        }

        const id = await this.odoo.create('ir.model.fields', values);
        this.registerVirtualField(model, name, { type: ttype });
        this.cache.fields.delete(model);

        await this.ensureXmlId(xmlid, 'ir.model.fields', id, sheet);
        this.log.ok(sheet, `Field dibuat: ${model}.${name}`, { id });
      });
    }
  }

  async processSelections() {
    const sheet = '03_SELECTIONS';
    const rows = sheetRows(this.workbook, sheet);

    if (!rows.length) {
      this.log.info(sheet, 'Sheet kosong/tidak ada, dilewati.');
      return;
    }

    if (!await this.modelExists('ir.model.fields.selection')) {
      this.log.warn(sheet, 'Model ir.model.fields.selection tidak tersedia, dilewati.');
      return;
    }

    for (const [i, row] of rows.entries()) {
      await this.runRow(sheet, i + 2, row.value, async () => {
        const fieldXmlid = row.field_external_id || row['field_id/id'];
        const value = row.value;
        const label = row.label || row.name;

        if (isBlank(value) || isBlank(label)) return;

        let fieldId = null;

        if (!isBlank(fieldXmlid)) {
          fieldId = await this.resolveXmlId(fieldXmlid, 'ir.model.fields');
        }

        if (!fieldId && !isBlank(row.model) && !isBlank(row.field_name)) {
          const found = await this.odoo.searchRead(
            'ir.model.fields',
            [
              ['model', '=', row.model],
              ['name', '=', row.field_name]
            ],
            ['id'],
            1
          );

          fieldId = found[0]?.id || null;
        }

        if (!fieldId) {
          this.log.warn(sheet, `Field selection tidak ditemukan: ${fieldXmlid || `${row.model}.${row.field_name}`}`);
          return;
        }

        if (this.dryRun && this.isDryId(fieldId)) {
          this.log.info(sheet, `[dry-run] create selection ${value}`);
          return;
        }

        const exists = await this.odoo.searchRead(
          'ir.model.fields.selection',
          [
            ['field_id', '=', fieldId],
            ['value', '=', value]
          ],
          ['id'],
          1
        );

        if (exists.length) {
          this.log.ok(sheet, `Selection sudah ada: ${value}`);
          return;
        }

        if (this.dryRun) {
          this.log.info(sheet, `[dry-run] create selection ${value}`);
          return;
        }

        const id = await this.odoo.create('ir.model.fields.selection', {
          field_id: fieldId,
          value,
          name: label,
          sequence: toNumberOrNull(row.sequence) || 10
        });

        this.log.ok(sheet, `Selection dibuat: ${value}`, { id });
      });
    }
  }

  async processPartners() {
    const sheet = '04_PARTNERS';
    const rows = sheetRows(this.workbook, sheet);

    if (!rows.length) {
      this.log.info(sheet, 'Sheet kosong/tidak ada, dilewati.');
      return;
    }

    for (const [i, row] of rows.entries()) {
      await this.runRow(sheet, i + 2, row.name, async () => {
        const xmlid = row.external_id || row.id;
        const name = row.name;

        if (isBlank(name)) {
          this.log.warn(sheet, `Row ${i + 2} dilewati: name kosong.`);
          return;
        }

        const lokalId = row.x_lokal_id || row.lokal_id;

        const domain = await this.buildLookupDomain(
          'res.partner',
          'x_lokal_id',
          lokalId,
          [['name', '=', name]]
        );

        const found = await this.findByXmlIdOrDomain(
          xmlid,
          'res.partner',
          domain,
          ['id', 'name']
        );

        const values = compactObject({
          name,
          phone: row.phone,
          mobile: row.mobile || row.whatsapp,
          email: row.email,
          street: row.street,
          city: row.city,
          zip: row.zip,
          x_lokal_id: lokalId,
          x_lokal_role: row.x_lokal_role || row.role,
          x_lokal_member_type: row.x_lokal_member_type,
          x_lokal_points: toNumberOrNull(row.x_lokal_points),
          x_lokal_area: row.x_lokal_area || row.area,
          x_lokal_verification_status: row.x_lokal_verification_status
        });

        if (found) {
          if (this.dryRun) {
            this.log.info(sheet, `[dry-run] update partner ${name}`);
          } else {
            await this.writeSafe('res.partner', found.id, values, sheet, `Partner diupdate: ${name}`);
          }

          await this.ensureXmlId(xmlid, 'res.partner', found.id, sheet);
          return;
        }

        if (this.dryRun) {
          this.dryRecord(xmlid, 'res.partner', sheet, `[dry-run] create partner ${name}`);
          return;
        }

        const id = await this.createSafe('res.partner', values, sheet, `Partner dibuat: ${name}`);
        await this.ensureXmlId(xmlid, 'res.partner', id, sheet);
      });
    }
  }

  async processProducts() {
    const sheet = '05_PRODUCTS';
    const rows = sheetRows(this.workbook, sheet);

    if (!rows.length) {
      this.log.info(sheet, 'Sheet kosong/tidak ada, dilewati.');
      return;
    }

    for (const [i, row] of rows.entries()) {
      await this.runRow(sheet, i + 2, row.name, async () => {
        const xmlid = row.external_id || row.id;
        const name = row.name;

        if (isBlank(name)) {
          this.log.warn(sheet, `Row ${i + 2} dilewati: name kosong.`);
          return;
        }

        const lokalId = row.x_lokal_id || row.x_lokal_product_id || row.lokal_product_id;

        let domain = [['name', '=', name]];

        if (!isBlank(lokalId) && await this.hasField('product.template', 'x_lokal_id')) {
          domain = [['x_lokal_id', '=', lokalId]];
        } else if (!isBlank(row.default_code)) {
          domain = [['default_code', '=', row.default_code]];
        }

        const found = await this.findByXmlIdOrDomain(
          xmlid,
          'product.template',
          domain,
          ['id', 'name', 'default_code', 'barcode']
        );

        const vendorId = await this.m2o(
          row['x_lokal_vendor_partner_id/id'] || row.vendor_external_id,
          'res.partner',
          sheet,
          false
        );

        const productType = await this.adaptProductType(row, sheet);
        const safeBarcode = await this.sanitizeBarcode(row, found, sheet);

        const values = compactObject({
          name,
          default_code: row.default_code,
          barcode: safeBarcode,
          list_price: toNumberOrNull(row.list_price || row.price),
          standard_price: toNumberOrNull(row.standard_price || row.cost),
          sale_ok: toBool(row.sale_ok, true),
          purchase_ok: toBool(row.purchase_ok, true),
          ...productType,
          x_lokal_id: lokalId,
          x_lokal_tracking_level: row.x_lokal_tracking_level || row.tracking_level,
          x_lokal_passport_url: row.x_lokal_passport_url,
          x_lokal_vendor_partner_id: vendorId,
          x_lokal_origin_city: row.x_lokal_origin_city,
          x_lokal_origin_district: row.x_lokal_origin_district,
          x_lokal_verification_status: row.x_lokal_verification_status,
          x_lokal_story: row.x_lokal_story,
          x_lokal_proof_hash: row.x_lokal_proof_hash,
          x_lokal_public_visible: toBool(row.x_lokal_public_visible, true)
        });

        if (found) {
          if (this.dryRun) {
            this.log.info(sheet, `[dry-run] update product ${name}`);
          } else {
            await this.writeSafe('product.template', found.id, values, sheet, `Produk diupdate: ${name}`);
          }

          await this.ensureXmlId(xmlid, 'product.template', found.id, sheet);
          return;
        }

        if (this.dryRun) {
          this.dryRecord(xmlid, 'product.template', sheet, `[dry-run] create product ${name}`);
          return;
        }

        const id = await this.createSafe('product.template', values, sheet, `Produk dibuat: ${name}`);
        await this.ensureXmlId(xmlid, 'product.template', id, sheet);
      });
    }
  }

  async productVariantId(templateId) {
    if (this.dryRun && this.isDryId(templateId)) {
      return this.makeDryId('product.product', `variant_for_${templateId}`);
    }

    const rows = await this.odoo.searchRead(
      'product.product',
      [['product_tmpl_id', '=', templateId]],
      ['id'],
      1
    );

    if (!rows.length) {
      throw new Error(`product.product tidak ditemukan untuk template ${templateId}`);
    }

    return rows[0].id;
  }

  async processStockLots() {
    const sheet = '06_STOCK_LOTS';
    const rows = sheetRows(this.workbook, sheet);

    if (!rows.length) {
      this.log.info(sheet, 'Sheet kosong/tidak ada, dilewati.');
      return;
    }

    if (!await this.modelExists('stock.lot')) {
      this.log.warn(sheet, 'Model stock.lot tidak tersedia, dilewati.');
      return;
    }

    for (const [i, row] of rows.entries()) {
      await this.runRow(sheet, i + 2, row.name || row.x_lokal_batch_id || row.x_lokal_unit_id, async () => {
        const xmlid = row.external_id || row.id;
        const name = row.name || row.lot_name || row.x_lokal_batch_id || row.x_lokal_unit_id;

        if (isBlank(name)) {
          this.log.warn(sheet, `Row ${i + 2} dilewati: name kosong.`);
          return;
        }

        const tmplId = await this.m2o(
          row['product_tmpl_id/id'] || row.product_template_external_id,
          'product.template',
          sheet,
          true
        );

        const productId = await this.productVariantId(tmplId);

        const found = await this.findByXmlIdOrDomain(
          xmlid,
          'stock.lot',
          [
            ['name', '=', name],
            ['product_id', '=', productId]
          ],
          ['id', 'name']
        );

        const values = compactObject({
          name,
          product_id: productId,
          x_lokal_batch_id: row.x_lokal_batch_id,
          x_lokal_unit_id: row.x_lokal_unit_id,
          x_lokal_certificate_url: row.x_lokal_certificate_url,
          x_lokal_production_date: row.x_lokal_production_date,
          x_lokal_expiry_date: row.x_lokal_expiry_date,
          x_lokal_proof_hash: row.x_lokal_proof_hash,
          x_lokal_status: row.x_lokal_status
        });

        if (found) {
          if (this.dryRun) {
            this.log.info(sheet, `[dry-run] update stock.lot ${name}`);
          } else {
            await this.writeSafe('stock.lot', found.id, values, sheet, `Lot/Serial diupdate: ${name}`);
          }

          await this.ensureXmlId(xmlid, 'stock.lot', found.id, sheet);
          return;
        }

        if (this.dryRun) {
          this.dryRecord(xmlid, 'stock.lot', sheet, `[dry-run] create stock.lot ${name}`);
          return;
        }

        const id = await this.createSafe('stock.lot', values, sheet, `Lot/Serial dibuat: ${name}`);
        await this.ensureXmlId(xmlid, 'stock.lot', id, sheet);
      });
    }
  }

  async processProjects() {
    const sheet = '07_PROJECTS';
    const rows = sheetRows(this.workbook, sheet);

    if (!rows.length) {
      this.log.info(sheet, 'Sheet kosong/tidak ada, dilewati.');
      return;
    }

    if (!await this.modelExists('project.project')) {
      this.log.warn(sheet, 'Model project.project tidak tersedia, dilewati.');
      return;
    }

    for (const [i, row] of rows.entries()) {
      await this.runRow(sheet, i + 2, row.name, async () => {
        const xmlid = row.external_id || row.id;
        const name = row.name;
        if (isBlank(name)) return;

        const found = await this.findByXmlIdOrDomain(
          xmlid,
          'project.project',
          [['name', '=', name]],
          ['id', 'name']
        );

        const values = compactObject({
          name,
          active: toBool(row.active, true),
          allow_milestones: toBool(row.allow_milestones, true),
          label_tasks: row.label_tasks,
          description: row.description
        });

        if (found) {
          if (this.dryRun) {
            this.log.info(sheet, `[dry-run] update project ${name}`);
          } else {
            await this.writeSafe('project.project', found.id, values, sheet, `Project diupdate: ${name}`);
          }

          await this.ensureXmlId(xmlid, 'project.project', found.id, sheet);
          return;
        }

        if (this.dryRun) {
          this.dryRecord(xmlid, 'project.project', sheet, `[dry-run] create project ${name}`);
          return;
        }

        const id = await this.createSafe('project.project', values, sheet, `Project dibuat: ${name}`);
        await this.ensureXmlId(xmlid, 'project.project', id, sheet);
      });
    }
  }

  async processProjectStages() {
    const sheet = '08_PROJECT_STAGES';
    const rows = sheetRows(this.workbook, sheet);

    if (!rows.length) {
      this.log.info(sheet, 'Sheet kosong/tidak ada, dilewati.');
      return;
    }

    if (!await this.modelExists('project.task.type')) {
      this.log.warn(sheet, 'Model project.task.type tidak tersedia, dilewati.');
      return;
    }

    for (const [i, row] of rows.entries()) {
      await this.runRow(sheet, i + 2, row.name, async () => {
        const xmlid = row.external_id || row.id;
        const name = row.name;
        if (isBlank(name)) return;

        const found = await this.findByXmlIdOrDomain(
          xmlid,
          'project.task.type',
          [['name', '=', name]],
          ['id', 'name']
        );

        const values = compactObject({
          name,
          sequence: toNumberOrNull(row.sequence) || 10,
          fold: toBool(row.fold, false)
        });

        if (found) {
          if (this.dryRun) {
            this.log.info(sheet, `[dry-run] update stage ${name}`);
          } else {
            await this.writeSafe('project.task.type', found.id, values, sheet, `Stage diupdate: ${name}`);
          }

          await this.ensureXmlId(xmlid, 'project.task.type', found.id, sheet);
          return;
        }

        if (this.dryRun) {
          this.dryRecord(xmlid, 'project.task.type', sheet, `[dry-run] create stage ${name}`);
          return;
        }

        const id = await this.createSafe('project.task.type', values, sheet, `Stage dibuat: ${name}`);
        await this.ensureXmlId(xmlid, 'project.task.type', id, sheet);
      });
    }
  }

  async processProjectTags() {
    const sheet = '09_PROJECT_TAGS';
    const rows = sheetRows(this.workbook, sheet);

    if (!rows.length) {
      this.log.info(sheet, 'Sheet kosong/tidak ada, dilewati.');
      return;
    }

    if (!await this.modelExists('project.tags')) {
      this.log.warn(sheet, 'Model project.tags tidak tersedia, dilewati.');
      return;
    }

    for (const [i, row] of rows.entries()) {
      await this.runRow(sheet, i + 2, row.name, async () => {
        const xmlid = row.external_id || row.id;
        const name = row.name;
        if (isBlank(name)) return;

        const found = await this.findByXmlIdOrDomain(
          xmlid,
          'project.tags',
          [['name', '=', name]],
          ['id', 'name']
        );

        if (found) {
          await this.ensureXmlId(xmlid, 'project.tags', found.id, sheet);
          this.log.ok(sheet, `Tag sudah ada: ${name}`);
          return;
        }

        if (this.dryRun) {
          this.dryRecord(xmlid, 'project.tags', sheet, `[dry-run] create tag ${name}`);
          return;
        }

        const id = await this.odoo.create('project.tags', { name });
        await this.ensureXmlId(xmlid, 'project.tags', id, sheet);
        this.log.ok(sheet, `Tag dibuat: ${name}`, { id });
      });
    }
  }

  async processMilestones() {
    const sheet = '10_MILESTONES';
    const rows = sheetRows(this.workbook, sheet);

    if (!rows.length) {
      this.log.info(sheet, 'Sheet kosong/tidak ada, dilewati.');
      return;
    }

    if (!await this.modelExists('project.milestone')) {
      this.log.warn(sheet, 'Model project.milestone tidak tersedia, dilewati.');
      return;
    }

    for (const [i, row] of rows.entries()) {
      await this.runRow(sheet, i + 2, row.name, async () => {
        const xmlid = row.external_id || row.id;
        const name = row.name;
        if (isBlank(name)) return;

        const projectId = await this.m2o(
          row['project_id/id'] || row.project_external_id,
          'project.project',
          sheet,
          true
        );

        const found = await this.findByXmlIdOrDomain(
          xmlid,
          'project.milestone',
          [
            ['name', '=', name],
            ['project_id', '=', projectId]
          ],
          ['id', 'name']
        );

        const values = compactObject({
          name,
          project_id: projectId,
          deadline: row.deadline || row.date_deadline,
          is_reached: toBool(row.is_reached, false)
        });

        if (found) {
          if (this.dryRun) {
            this.log.info(sheet, `[dry-run] update milestone ${name}`);
          } else {
            await this.writeSafe('project.milestone', found.id, values, sheet, `Milestone diupdate: ${name}`);
          }

          await this.ensureXmlId(xmlid, 'project.milestone', found.id, sheet);
          return;
        }

        if (this.dryRun) {
          this.dryRecord(xmlid, 'project.milestone', sheet, `[dry-run] create milestone ${name}`);
          return;
        }

        const id = await this.createSafe('project.milestone', values, sheet, `Milestone dibuat: ${name}`);
        await this.ensureXmlId(xmlid, 'project.milestone', id, sheet);
      });
    }
  }

  async processTasks() {
    const sheet = '11_TASKS';
    const rows = sheetRows(this.workbook, sheet);

    if (!rows.length) {
      this.log.info(sheet, 'Sheet kosong/tidak ada, dilewati.');
      return;
    }

    if (!await this.modelExists('project.task')) {
      this.log.warn(sheet, 'Model project.task tidak tersedia, dilewati.');
      return;
    }

    for (const [i, row] of rows.entries()) {
      await this.runRow(sheet, i + 2, row.name, async () => {
        const xmlid = row.external_id || row.id;
        const name = row.name;

        if (isBlank(name)) {
          this.log.warn(sheet, `Row ${i + 2} dilewati: name kosong.`);
          return;
        }

        const projectId = await this.m2o(
          row['project_id/id'] || row.project_external_id,
          'project.project',
          sheet,
          true
        );

        const stageId = await this.m2o(row['stage_id/id'], 'project.task.type', sheet, false);
        const milestoneId = await this.m2o(row['milestone_id/id'], 'project.milestone', sheet, false);
        const tagCmd = await this.m2m(row['tag_ids/id'], 'project.tags', sheet);

        const found = await this.findByXmlIdOrDomain(
          xmlid,
          'project.task',
          [
            ['name', '=', name],
            ['project_id', '=', projectId]
          ],
          ['id', 'name']
        );

        const values = compactObject({
          name,
          project_id: projectId,
          stage_id: stageId,
          milestone_id: milestoneId,
          date_deadline: row.date_deadline,
          allocated_hours: toNumberOrNull(row.allocated_hours),
          priority: row.priority,
          sequence: toNumberOrNull(row.sequence),
          description: row.description
        });

        if (tagCmd) values.tag_ids = tagCmd;

        if (found) {
          if (this.dryRun) {
            this.log.info(sheet, `[dry-run] update task ${name}`);
          } else {
            await this.writeSafe('project.task', found.id, values, sheet, `Task diupdate: ${name}`);
          }

          await this.ensureXmlId(xmlid, 'project.task', found.id, sheet);
          return;
        }

        if (this.dryRun) {
          this.dryRecord(xmlid, 'project.task', sheet, `[dry-run] create task ${name}`);
          return;
        }

        const id = await this.createSafe('project.task', values, sheet, `Task dibuat: ${name}`);
        await this.ensureXmlId(xmlid, 'project.task', id, sheet);
      });
    }
  }
async processProjectBudgets() {
  const sheet = '14_PROJECT_BUDGETS';
  const rows = sheetRows(this.workbook, sheet);

  if (!rows.length) {
    this.log.info(sheet, 'Sheet kosong/tidak ada, dilewati.');
    return;
  }

  if (!await this.modelExists('project.project')) {
    this.log.warn(sheet, 'Model project.project tidak tersedia, dilewati.');
    return;
  }

  for (const [i, row] of rows.entries()) {
    await this.runRow(sheet, i + 2, row.name || row['project_id/id'], async () => {
      const projectXmlId = row['project_id/id'] || row.project_external_id;

      const projectId = await this.m2o(
        projectXmlId,
        'project.project',
        sheet,
        true
      );

      const values = compactObject({
        x_lokal_budget_planned_revenue: toNumberOrNull(row.x_lokal_budget_planned_revenue),
        x_lokal_budget_planned_cost: toNumberOrNull(row.x_lokal_budget_planned_cost),
        x_lokal_budget_reserved_cost: toNumberOrNull(row.x_lokal_budget_reserved_cost),
        x_lokal_budget_net_target: toNumberOrNull(row.x_lokal_budget_net_target),
        x_lokal_budget_status: row.x_lokal_budget_status,
        x_lokal_budget_notes: row.x_lokal_budget_notes
      });

      if (this.dryRun) {
        this.log.info(
          sheet,
          `[dry-run] update budget project ${projectXmlId}`,
          values
        );
        return;
      }

      await this.writeSafe(
        'project.project',
        projectId,
        values,
        sheet,
        `Budget project diupdate: ${projectXmlId}`
      );
    });
  }
}
  async processWebsitePages() {
    const sheet = '12_WEBSITE_PAGES';
    const rows = sheetRows(this.workbook, sheet);

    if (!rows.length) {
      this.log.info(sheet, 'Sheet kosong/tidak ada, dilewati.');
      return;
    }

    this.log.warn(sheet, 'Website page tidak ditulis otomatis agar tidak merusak view Odoo. Sheet dibaca sebagai rencana saja.');
  }

  async processQrRegistry() {
    const sheet = '13_QR_ID_REGISTRY';
    const rows = sheetRows(this.workbook, sheet);

    if (!rows.length) {
      this.log.info(sheet, 'Sheet kosong/tidak ada, dilewati.');
      return;
    }

    this.log.info(sheet, `QR registry terbaca ${rows.length} baris. Data utama tetap memakai x_lokal_id pada model terkait.`);
  }
}

async function testConnection() {
  const log = new ImportLog();
  const odoo = new OdooClient({}, log);

  await odoo.authenticate();

  const sample = await odoo.searchRead('res.partner', [], ['id', 'name'], 1);

  log.ok('AUTH', 'Koneksi Odoo OK dan res.partner bisa dibaca.', {
    sample: sample[0] || null
  });

  return {
    summary: log.summary(),
    logs: log.lines
  };
}

module.exports = {
  ImportLog,
  OdooClient,
  LokalmartImporter,
  testConnection,
  toBool
};
