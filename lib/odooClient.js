const xmlrpc = require('xmlrpc');

function normalizeUrl(url) {
  if (!url) throw new Error('Target Odoo URL wajib diisi.');
  return String(url).replace(/\/+$/, '');
}

class OdooClient {
  constructor(target) {
    this.url = normalizeUrl(target.url);
    this.db = target.db;
    this.username = target.username;
    this.password = target.password || target.apiKey;
    if (!this.db || !this.username || !this.password) {
      throw new Error('Target Odoo wajib punya url, db, username, dan password/API key.');
    }
    this.common = xmlrpc.createClient({ url: `${this.url}/xmlrpc/2/common` });
    this.object = xmlrpc.createClient({ url: `${this.url}/xmlrpc/2/object` });
    this.uid = null;
  }

  async call(client, method, params) {
    return await new Promise((resolve, reject) => {
      client.methodCall(method, params, (err, value) => {
        if (err) return reject(err);
        resolve(value);
      });
    });
  }

  async authenticate() {
    if (this.uid) return this.uid;
    const uid = await this.call(this.common, 'authenticate', [this.db, this.username, this.password, {}]);
    if (!uid) throw new Error('Login Odoo gagal. Periksa database, username, dan password/API key.');
    this.uid = uid;
    return uid;
  }

  async execute(model, method, args = [], kwargs = {}) {
    const uid = await this.authenticate();
    return await this.call(this.object, 'execute_kw', [this.db, uid, this.password, model, method, args, kwargs]);
  }

  async version() {
    return await this.call(this.common, 'version', []);
  }

  async fieldsGet(model) {
    return await this.execute(model, 'fields_get', [], { attributes: ['string', 'type', 'relation', 'required', 'readonly', 'store'] });
  }

  async searchRead(model, domain, fields = ['id'], limit = 0) {
    const kwargs = { fields };
    if (limit) kwargs.limit = limit;
    return await this.execute(model, 'search_read', [domain], kwargs);
  }

  async search(model, domain, limit = 0) {
    const kwargs = {};
    if (limit) kwargs.limit = limit;
    return await this.execute(model, 'search', [domain], kwargs);
  }

  async read(model, ids, fields) {
    return await this.execute(model, 'read', [ids], { fields });
  }

  async create(model, vals) {
    return await this.execute(model, 'create', [vals]);
  }

  async write(model, ids, vals) {
    return await this.execute(model, 'write', [ids, vals]);
  }

  async load(model, fields, rows) {
    return await this.execute(model, 'load', [fields, rows]);
  }

  async findExternalId(xmlid) {
    if (!xmlid) return null;
    const [module, name] = splitXmlId(xmlid);
    if (!module || !name) return null;
    const found = await this.searchRead('ir.model.data', [
      ['module', '=', module],
      ['name', '=', name]
    ], ['id', 'model', 'res_id', 'module', 'name'], 1);
    return found && found[0] ? found[0] : null;
  }

  async ensureExternalId(xmlid, model, resId, noupdate = true) {
    const [module, name] = splitXmlId(xmlid);
    if (!module || !name) throw new Error(`External ID tidak valid: ${xmlid}`);
    const existing = await this.findExternalId(xmlid);
    if (existing) {
      if (existing.model === model && Number(existing.res_id) === Number(resId)) return existing.id;
      await this.write('ir.model.data', [existing.id], { model, res_id: Number(resId), noupdate });
      return existing.id;
    }
    return await this.create('ir.model.data', { module, name, model, res_id: Number(resId), noupdate });
  }
}

function splitXmlId(xmlid) {
  const text = String(xmlid || '').trim();
  const i = text.indexOf('.');
  if (i <= 0 || i === text.length - 1) return [null, null];
  return [text.slice(0, i), text.slice(i + 1)];
}

module.exports = { OdooClient, splitXmlId };
