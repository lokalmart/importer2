import * as XLSX from 'xlsx';
import { parseBody, makeOdooClient, modelListFrom, defaultFieldsForExport, matchRule, externalIdFor, safeSheetName, xlsxDateName, sendXlsx } from '../lib/odoo.js';

const PROFILES = {
  portal: ['ir.ui.view','website.page','website.menu','res.users','res.partner','sale.order','account.move','payment.provider','payment.transaction','loyalty.program','loyalty.card'],
  website: ['website','website.page','website.menu','ir.ui.view','website.redirect','product.public.category','website.product.public.category'],
  products: ['product.category','product.template','product.product','product.pricelist','product.pricelist.item','res.partner'],
  projects: ['project.project','project.task','project.milestone','account.analytic.account','account.analytic.line','res.partner'],
  lokalmart: ['x_lm_koloni','x_lm_lokal_identity','x_lm_product_passport','x_lm_service','x_lm_survey','x_lm_program','x_lm_role_assignment'],
  all_small: ['ir.ui.view','website.page','website.menu','product.category','product.template','res.partner','project.project','project.task','sale.order','account.move','payment.transaction','loyalty.card']
};

function convertValue(v) {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.length === 2 && typeof v[1] === 'string' ? v[1] : v.join(',');
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s.length > 32000 ? s.slice(0, 32000) : v;
}

async function exportModel(client, model, { limit, includeArch }) {
  const info = await client.modelInfo(model);
  if (!info) return { status:{model,status:'missing',rows:0}, rows:[] };
  const meta = await client.fieldsGet(model);
  const fields = defaultFieldsForExport(model, meta, { includeArch });
  let rows;
  try {
    rows = await client.execute(model, 'search_read', [[]], { fields:['id', ...fields], limit });
  } catch (err) {
    const lighter = fields.filter(f => !['arch_db','arch_base','arch'].includes(f));
    rows = await client.execute(model, 'search_read', [[]], { fields:['id', ...lighter], limit });
  }
  const out = (rows || []).map(rec => {
    const r = { _model:model, _action:'upsert', _external_id:externalIdFor(model, rec), _match:matchRule(model), _legacy_id:rec.id };
    for (const f of fields) if (rec[f] !== undefined) r[f] = convertValue(rec[f]);
    return r;
  });
  return { status:{model,status:'ok',rows:out.length,fields:fields.length}, rows:out };
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS') return res.status(204).end();
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'Use POST'});
  try{
    const body=parseBody(req);
    const client=await makeOdooClient(body);
    const profile=body.profile || 'all_small';
    const limit=Math.max(1, Math.min(Number(body.limit||300), 1500));
    const includeArch=body.includeArch !== false;
    const models=modelListFrom(body.modelList, PROFILES[profile] || PROFILES.all_small);
    const wb=XLSX.utils.book_new();
    const used=new Set();
    const status=[];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{item:'Export',value:'Lokalmart Profile Export V9'},{item:'Profile',value:profile},{item:'Generated',value:new Date().toISOString()},{item:'Limit',value:limit}]), '00_README');
    for(const model of models){
      try{
        const ex=await exportModel(client, model, {limit, includeArch});
        status.push(ex.status);
        if(ex.rows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ex.rows), safeSheetName(model, used));
      }catch(err){ status.push({model,status:'error',rows:0,error:(err.message||String(err)).slice(0,1000)}); }
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(status), '01_STATUS');
    const buf=XLSX.write(wb,{bookType:'xlsx',type:'buffer',compression:true});
    return sendXlsx(res, buf, xlsxDateName(`lokalmart_${profile}_export_v9`));
  }catch(err){ return res.status(500).json({ok:false,error:err.message||String(err)}); }
}
