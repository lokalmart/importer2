export function parseBody(req) {
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body || {};
}

export function cleanBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

export async function jsonRpc(rpcUrl, service, rpcMethod, rpcArgs) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { service, method: rpcMethod, args: rpcArgs },
      id: Date.now()
    })
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new Error(`Odoo returned non-JSON response (${response.status}): ${text.slice(0, 1000)}`);
  }

  if (!response.ok || payload.error) {
    const msg = payload.error?.data?.message || payload.error?.data?.debug || payload.error?.message || text;
    throw new Error(String(msg).slice(0, 4000));
  }
  return payload.result;
}

export async function makeOdooClient({ baseUrl, db, login, password }) {
  const clean = cleanBaseUrl(baseUrl);
  if (!clean || !db || !login || !password) throw new Error('Missing baseUrl, db, login, or password/API key.');
  const rpcUrl = `${clean}/jsonrpc`;
  const uid = await jsonRpc(rpcUrl, 'common', 'authenticate', [db, login, password, {}]);
  if (!uid) throw new Error('Authentication failed. Check database, login, and password/API key.');

  async function execute(model, method, args = [], kwargs = {}) {
    return await jsonRpc(rpcUrl, 'object', 'execute_kw', [db, uid, password, model, method, args, kwargs || {}]);
  }

  async function modelInfo(model) {
    const rows = await execute('ir.model', 'search_read', [[['model', '=', model]]], { fields: ['id', 'model', 'name', 'state'], limit: 1 });
    return rows?.[0] || null;
  }

  async function fieldsGet(model) {
    return await execute(model, 'fields_get', [], { attributes: ['string','type','required','readonly','relation','store','selection'] });
  }

  async function safeCount(model, domain = []) {
    try { return await execute(model, 'search_count', [domain]); }
    catch (err) { return null; }
  }

  return { baseUrl: clean, db, login, uid, execute, modelInfo, fieldsGet, safeCount };
}

export function modelListFrom(input, fallback = []) {
  let models = Array.isArray(input) ? input : String(input || '').split(/\n|,/);
  models = models.map(x => String(x).trim()).filter(Boolean);
  return models.length ? Array.from(new Set(models)) : fallback;
}

export function safeSheetName(name, used = new Set()) {
  let s = String(name || 'sheet').replace(/[\\/*?:[\]]/g, '_').slice(0, 31) || 'sheet';
  const base = s.slice(0, 27);
  let i = 1;
  while (used.has(s)) s = `${base}_${i++}`.slice(0, 31);
  used.add(s);
  return s;
}

export function xlsxDateName(prefix) {
  return `${prefix}_${new Date().toISOString().slice(0, 10)}.xlsx`;
}

export function sendXlsx(res, buf, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(buf);
}

export const SAFE_FIELD_TYPES = new Set(['char','text','html','selection','date','datetime','integer','float','monetary','boolean','many2one','many2many']);

export const NOISE_FIELDS = new Set([
  'id','create_uid','create_date','write_uid','write_date','__last_update',
  'message_ids','message_follower_ids','message_partner_ids','message_attachment_count',
  'message_has_error','message_has_error_counter','message_has_sms_error','message_is_follower',
  'message_needaction','message_needaction_counter','message_unread','message_unread_counter',
  'activity_ids','website_message_ids','access_token','signup_token','signup_url','password','new_password','api_key'
]);

export function defaultFieldsForExport(model, meta, { includeArch = true } = {}) {
  return Object.entries(meta || {}).filter(([name, f]) => {
    if (NOISE_FIELDS.has(name)) return false;
    if (!SAFE_FIELD_TYPES.has(f.type)) return false;
    if (!includeArch && ['arch_db','arch_base','arch'].includes(name)) return false;
    if (f.type === 'html' && !['ir.ui.view','website.page','knowledge.article','slide.slide'].includes(model)) return false;
    return true;
  }).map(([name]) => name).slice(0, 120);
}

export function matchRule(model) {
  const rules = {
    'ir.ui.view': 'key,name',
    'website.page': 'url,key,name',
    'website.menu': 'url,name',
    'ir.model.fields': 'model_id,name',
    'product.template': 'default_code,barcode,name',
    'product.product': 'default_code,barcode',
    'product.category': 'complete_name,name',
    'res.partner': 'email,phone,mobile,name',
    'project.project': 'name',
    'project.task': 'name,project_id',
    'sale.order': 'name',
    'account.move': 'name,move_type',
    'loyalty.card': 'code,program_id,partner_id'
  };
  return rules[model] || 'name,display_name';
}

export function externalIdFor(model, rec) {
  const candidate = rec.default_code || rec.barcode || rec.url || rec.key || rec.code || rec.name || rec.display_name || rec.id;
  const slug = String(candidate || rec.id || 'record')
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 80) || `id_${rec.id}`;
  return `lokalmart_migration.${model.replace(/\./g, '_')}_${slug}_${rec.id}`;
}
