const XLSX = require('xlsx');
const { LokalmartImporter, ImportLog, toBool } = require('./_odoo');

const SHEET_RUNNERS = {
  '01_MODELS_CHECK': 'processModelsCheck',
  '02_FIELDS': 'processFields',
  '03_SELECTIONS': 'processSelections',
  '04_PARTNERS': 'processPartners',
  '05_PRODUCTS': 'processProducts',
  '06_STOCK_LOTS': 'processStockLots',
  '07_PROJECTS': 'processProjects',
  '08_PROJECT_STAGES': 'processProjectStages',
  '09_PROJECT_TAGS': 'processProjectTags',
  '10_MILESTONES': 'processMilestones',
  '11_TASKS': 'processTasks',
  '12_WEBSITE_PAGES': 'processWebsitePages',
  '13_QR_ID_REGISTRY': 'processQrRegistry'
};

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
    const onlySheet = String(req.body?.onlySheet || '').trim();

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

    if (onlySheet) {
      const methodName = SHEET_RUNNERS[onlySheet];

      if (!methodName || typeof importer[methodName] !== 'function') {
        throw new Error(`Sheet tidak didukung importer: ${onlySheet}`);
      }

      importer.log.info('SYSTEM', `Mode bertahap: ${dryRun ? 'DRY RUN' : 'IMPORT NOW'} sheet ${onlySheet}`);

      await importer.odoo.authenticate();

      try {
        await importer[methodName]();
      } catch (e) {
        importer.log.error(onlySheet, `Sheet gagal: ${e.message}`);
      }

      importer.log.ok('SYSTEM', `Selesai memproses sheet ${onlySheet}`);

      return res.status(200).json({
        ok: true,
        sheet: onlySheet,
        summary: importer.log.summary(),
        logs: importer.log.lines
      });
    }

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
