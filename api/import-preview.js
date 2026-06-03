import * as XLSX from 'xlsx';
import { parseBody, makeOdooClient } from '../lib/odoo.js';

function decodeBase64DataUrl(s){
  s=String(s||'');
  const idx=s.indexOf(',');
  if(s.startsWith('data:') && idx>=0) s=s.slice(idx+1);
  return Buffer.from(s,'base64');
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
    const buf=decodeBase64DataUrl(body.fileBase64);
    if(!buf.length) return res.status(400).json({ok:false,error:'fileBase64 is required.'});
    const wb=XLSX.read(buf,{type:'buffer',cellDates:false});
    let client=null;
    if(body.baseUrl && body.db && body.login && body.password){ client=await makeOdooClient(body); }
    const issues=[]; const sheets=[];
    const modelMetaCache=new Map();
    async function fieldExists(model, field){
      if(!client) return true;
      if(!modelMetaCache.has(model)){
        try{ modelMetaCache.set(model, await client.fieldsGet(model)); }
        catch(err){ modelMetaCache.set(model, null); }
      }
      const meta=modelMetaCache.get(model);
      if(!meta) return false;
      const base=String(field).split('/')[0];
      return !!meta[base] || field.startsWith('_');
    }
    for(const name of wb.SheetNames){
      const rows=XLSX.utils.sheet_to_json(wb.Sheets[name],{defval:''});
      if(!rows.length){ sheets.push({sheet:name,rows:0,status:'empty'}); continue; }
      const headers=Object.keys(rows[0]);
      const hasModel=headers.includes('_model');
      const model=hasModel ? rows[0]._model : name;
      const hasAction=headers.includes('_action');
      const hasExternal=headers.includes('_external_id');
      const hasMatch=headers.includes('_match');
      if(!hasAction) issues.push({sheet:name,type:'missing_column',column:'_action'});
      if(!hasExternal) issues.push({sheet:name,type:'missing_column',column:'_external_id'});
      if(!hasMatch) issues.push({sheet:name,type:'missing_column',column:'_match'});
      if(!hasModel && name.startsWith('0')===false && !name.includes('.')) issues.push({sheet:name,type:'ambiguous_model',message:'Sheet has no _model and sheet name is not an Odoo model.'});
      if(client && model && !String(model).startsWith('0')){
        const info=await client.modelInfo(model).catch(()=>null);
        if(!info) issues.push({sheet:name,model,type:'model_missing_or_no_access'});
        for(const h of headers){
          if(h.startsWith('_')) continue;
          const ok=await fieldExists(model,h);
          if(!ok) issues.push({sheet:name,model,type:'field_missing',field:h});
        }
      }
      let missingKeyRows=0;
      for(let i=0;i<rows.length;i++){
        if(hasExternal && !rows[i]._external_id && hasMatch && !rows[i]._match) missingKeyRows++;
      }
      if(missingKeyRows) issues.push({sheet:name,type:'rows_without_external_or_match',count:missingKeyRows});
      sheets.push({sheet:name,model,rows:rows.length,columns:headers.length,status:'checked'});
    }
    return res.status(200).json({ok:true,sheets,issues,summary:{sheets:wb.SheetNames.length,issues:issues.length}});
  }catch(err){return res.status(500).json({ok:false,error:err.message||String(err)});}
}
