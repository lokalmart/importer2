const XLSX = require('xlsx');
const { LokalmartImporter, ImportLog, toBool } = require('./_odoo');

function getBase64FromBody(body = {}) {
  let raw = body.fileBase64 || body.file || body.fileDataUrl || '';
  if (!raw || typeof raw !== 'string') return '';
  raw = raw.trim();
  // Accept both pure base64 and data URL: data:...;base64,AAAA
  if (raw.includes(',')) raw = raw.split(',').pop();
  return raw.replace(/\s/g, '');
}

module.exports = async function handler(req, res) {
  const log = new ImportLog();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed. Gunakan POST.' });
    }
    const dryRun = toBool(req.body?.dryRun, true);
    const onlySheet = String(req.body?.onlySheet || '').trim();
    const fileBase64 = getBase64FromBody(req.body);
    if (!fileBase64) {
      throw new Error('File XLSX tidak ditemukan. Frontend harus mengirim fileBase64. Jika file sudah dipilih, ganti index.html dengan versi V11.');
    }
    const buffer = Buffer.from(fileBase64, 'base64');
    if (!buffer.length) throw new Error('fileBase64 kosong setelah decode. Pilih ulang file XLSX.');
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    if (!workbook.SheetNames || !workbook.SheetNames.length) throw new Error('Workbook kosong atau tidak valid.');
    const importer = new LokalmartImporter(workbook, { dryRun });
    const result = await importer.run({ onlySheet });
    return res.status(200).json({ ok: true, fileName: req.body?.fileName || '', onlySheet, ...result });
  } catch (e) {
    log.error('SYSTEM', e.message || String(e));
    return res.status(200).json({ ok: false, error: e.message || String(e), summary: log.summary(), logs: log.lines });
  }
};
