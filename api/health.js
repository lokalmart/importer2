import { parseBody, makeOdooClient } from '../lib/odoo.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Use POST' });
  try {
    const client = await makeOdooClient(parseBody(req));
    const version = await client.execute('ir.module.module', 'search_count', [[['state','=','installed']]]).catch(() => null);
    return res.status(200).json({ ok:true, uid:client.uid, installed_modules_count:version, baseUrl:client.baseUrl, db:client.db });
  } catch (err) {
    return res.status(500).json({ ok:false, error:err.message || String(err) });
  }
}
