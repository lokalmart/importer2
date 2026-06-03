import { parseBody, makeOdooClient, modelListFrom } from '../lib/odoo.js';

const DEFAULT_MODELS = [
  'ir.ui.view','website.page','website.menu','ir.model','ir.model.fields','ir.model.data',
  'product.template','product.product','product.category','res.partner','project.project','project.task',
  'sale.order','sale.order.line','account.move','account.move.line','payment.provider','payment.transaction',
  'loyalty.program','loyalty.card','x_lm_koloni','x_lm_lokal_identity','x_lm_product_passport','x_lm_service','x_lm_survey','x_lm_program'
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Use POST' });

  try {
    const body = parseBody(req);
    const client = await makeOdooClient(body);
    const models = modelListFrom(body.modelList, DEFAULT_MODELS);
    const includeViews = body.includeViews !== false;
    const results = [];

    for (const model of models) {
      const row = { model, status:'pending', count:null, fields_count:0, required_fields:[], key_fields:[], views_count:0, views:[], external_ids_count:null, error:'' };
      try {
        const info = await client.modelInfo(model);
        if (!info) { row.status = 'missing_or_no_access'; results.push(row); continue; }
        row.status = 'ok';
        row.model_id = info.id;
        row.model_name = info.name;
        row.state = info.state;
        const meta = await client.fieldsGet(model);
        row.fields_count = Object.keys(meta).length;
        row.required_fields = Object.entries(meta).filter(([,f]) => f.required).map(([n]) => n).sort();
        row.key_fields = ['name','display_name','default_code','barcode','email','phone','url','key','code','state','active'].filter(f => meta[f]);
        row.count = await client.safeCount(model);

        if (includeViews) {
          const views = await client.execute('ir.ui.view','search_read',[[['model','=',model]]],{fields:['id','name','key','type','mode','inherit_id','priority','active'],limit:80}).catch(() => []);
          row.views_count = views.length;
          row.views = views;
        }
        row.external_ids_count = await client.safeCount('ir.model.data', [['model','=',model]]);
      } catch (err) {
        row.status = 'error'; row.error = err.message || String(err);
      }
      results.push(row);
    }

    return res.status(200).json({ ok:true, uid:client.uid, generated_at:new Date().toISOString(), results });
  } catch (err) {
    return res.status(500).json({ ok:false, error:err.message || String(err) });
  }
}
