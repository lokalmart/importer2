import * as XLSX from 'xlsx';
import { parseBody, makeOdooClient, modelListFrom, sendXlsx, xlsxDateName } from '../lib/odoo.js';

const DEFAULT_MODELS=['ir.ui.view','website.page','website.menu','product.template','res.partner','project.project','project.task','sale.order','account.move','x_lm_koloni','x_lm_lokal_identity','x_lm_product_passport','x_lm_service','x_lm_survey','x_lm_program'];
const CRITICAL_FIELDS={
  'website.page':['url','name','view_id'],
  'website.menu':['name','url'],
  'ir.ui.view':['name','type','key','arch_db'],
  'product.template':['name','list_price','categ_id'],
  'res.partner':['name','phone','email'],
  'project.project':['name'],
  'project.task':['name','project_id','stage_id'],
  'sale.order':['name','partner_id','state'],
  'account.move':['name','move_type','partner_id','state'],
  'x_lm_koloni':['x_name'],
  'x_lm_lokal_identity':['x_name'],
  'x_lm_product_passport':['x_name'],
  'x_lm_service':['x_name'],
  'x_lm_survey':['x_name'],
  'x_lm_program':['x_name']
};

function missing(v){ return v===undefined || v===null || v===false || v==='' || (Array.isArray(v)&&!v.length); }

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
    const models=modelListFrom(body.modelList, DEFAULT_MODELS);
    const limit=Math.max(1, Math.min(Number(body.limit||300), 1000));
    const summary=[]; const issues=[];
    for(const model of models){
      try{
        const info=await client.modelInfo(model);
        if(!info){ summary.push({model,status:'missing',count:0,score:0,note:'Model not found or no access'}); continue; }
        const meta=await client.fieldsGet(model);
        const critical=(CRITICAL_FIELDS[model]||['name']).filter(f=>meta[f]);
        const fields=['id','display_name',...critical];
        const rows=await client.execute(model,'search_read',[[]],{fields,limit});
        let missingCells=0; let checked=0;
        for(const rec of rows||[]){
          for(const f of critical){ checked++; if(missing(rec[f])){ missingCells++; issues.push({model,record_id:rec.id,display_name:rec.display_name||rec.name||'',field:f,issue:'missing_critical_field'}); } }
        }
        const score=checked ? Math.round(((checked-missingCells)/checked)*100) : 100;
        const viewCount=await client.safeCount('ir.ui.view', [['model','=',model]]);
        const xIdCount=await client.safeCount('ir.model.data', [['model','=',model]]);
        summary.push({model,status:'ok',count:(rows||[]).length,critical_fields:critical.join(','),missing_cells:missingCells,score,views:viewCount,external_ids:xIdCount});
      }catch(err){summary.push({model,status:'error',count:0,score:0,note:(err.message||String(err)).slice(0,1000)});}
    }
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{item:'Report',value:'Lokalmart Gap Report V9'},{item:'Generated',value:new Date().toISOString()},{item:'Limit',value:limit}]), '00_README');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), '01_SUMMARY');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(issues.length?issues:[{status:'OK',message:'No critical missing fields detected in sampled rows.'}]), '02_ISSUES');
    const buf=XLSX.write(wb,{bookType:'xlsx',type:'buffer',compression:true});
    return sendXlsx(res, buf, xlsxDateName('lokalmart_gap_report_v9'));
  }catch(err){return res.status(500).json({ok:false,error:err.message||String(err)});}
}
