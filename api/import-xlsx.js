const XLSX = require('xlsx');
const { LokalmartImporter, ImportLog, toBool } = require('./_odoo');

module.exports = async function handler(req, res) {
  const log = new ImportLog();

  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method !== 'POST') {
      return res.status(405).json({
        ok: false,
        error: 'Method not allowed. Gunakan POST.',
        summary: { error: 1 },
        logs: [
          {
            level: 'error',
            sheet: 'SYSTEM',
            message: 'Method not allowed. Gunakan POST.'
          }
        ]
      });
    }

    const dryRun = toBool(req.body?.dryRun, true);

    let buffer = null;

    if (req.body?.fileBase64) {
      buffer = Buffer.from(req.body.fileBase64, 'base64');
    } else if (req.body?.file) {
      buffer = Buffer.from(req.body.file, 'base64');
    } else {
      throw new Error('File XLSX tidak ditemukan. Frontend harus mengirim fileBase64.');
    }

    const workbook = XLSX.read(buffer, {
      type: 'buffer',
      cellDates: false
    });

    const importer = new LokalmartImporter(workbook, { dryRun });
    const result = await importer.run();

    return res.status(200).json({
      ok: true,
      ...result
    });
  } catch (e) {
    log.error('SYSTEM', e.message);

    return res.status(200).json({
      ok: false,
      error: e.message,
      summary: log.summary(),
      logs: log.lines.length
        ? log.lines
        : [
            {
              level: 'error',
              sheet: 'SYSTEM',
              message: e.message
            }
          ]
    });
  }
};
