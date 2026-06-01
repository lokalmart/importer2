const XLSX = require('xlsx');
const { OdooClient, ImportLog } = require('./_odoo');

const DEFAULT_MODELS = [
  'res.partner',
  'product.template',
  'product.product',
  'product.category',
  'stock.lot',
  'stock.quant',
  'stock.location',
  'stock.picking',
  'sale.order',
  'sale.order.line',
  'project.project',
  'project.task',
  'project.task.type',
  'project.tags',
  'project.milestone',
  'pos.order',
  'pos.order.line',
  'account.analytic.line',
  'account.move',
  'account.move.line',
  'account.journal',
  'account.account',
  'website.page'
];

function parseModels(input) {
  if (!input) return DEFAULT_MODELS;
  return String(input)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function safeSheetName(name) {
  return String(name)
    .replace(/[\[\]\:\*\?\/\\]/g, '_')
    .slice(0, 31);
}

async function modelExists(odoo, model) {
  const rows = await odoo.searchRead(
    'ir.model',
    [['model', '=', model]],
    ['id', 'model', 'name', 'modules'],
    1
  );
  return rows[0] || null;
}

async function getFields(odoo, model) {
  const fields = await odoo.executeKw(
    model,
    'fields_get',
    [],
    {
      attributes: [
        'string',
        'type',
        'required',
        'readonly',
        'store',
        'relation',
        'selection',
        'help',
        'sortable',
        'exportable'
      ]
    }
  );

  return Object.entries(fields || {}).map(([name, def]) => ({
    model,
    field_name: name,
    field_label: def.string || name,
    field_type: def.type || '',
    required: !!def.required,
    readonly: !!def.readonly,
    store: def.store !== undefined ? !!def.store : '',
    relation: def.relation || '',
    selection: Array.isArray(def.selection)
      ? def.selection.map((s) => Array.isArray(s) ? `${s[0]}:${s[1]}` : String(s)).join(' | ')
      : '',
    help: def.help || '',
    sortable: def.sortable !== undefined ? !!def.sortable : '',
    exportable: def.exportable !== undefined ? !!def.exportable : ''
  }));
}

async function getCustomFields(odoo, model) {
  try {
    return await odoo.searchRead(
      'ir.model.fields',
      [['model', '=', model], ['name', 'ilike', 'x_']],
      [
        'id',
        'name',
        'field_description',
        'ttype',
        'relation',
        'required',
        'readonly',
        'store',
        'state'
      ],
      500
    );
  } catch (e) {
    return [];
  }
}

async function getExternalIds(odoo, model) {
  try {
    return await odoo.searchRead(
      'ir.model.data',
      [['model', '=', model]],
      ['module', 'name', 'model', 'res_id'],
      500
    );
  } catch (e) {
    return [];
  }
}

module.exports = async function handler(req, res) {
  const log = new ImportLog();

  try {
    const odoo = new OdooClient({}, log);
    await odoo.authenticate();

    const models = parseModels(req.query.models);
    const wb = XLSX.utils.book_new();

    const manifest = [
      {
        key: 'export_type',
        value: 'odoo_structure_scan'
      },
      {
        key: 'exported_at',
        value: new Date().toISOString()
      },
      {
        key: 'odoo_url',
        value: process.env.ODOO_URL || ''
      },
      {
        key: 'odoo_db',
        value: process.env.ODOO_DB || ''
      },
      {
        key: 'models',
        value: models.join(', ')
      }
    ];

    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(manifest),
      '00_MANIFEST'
    );

    const modelSummary = [];
    const allFields = [];
    const allCustomFields = [];
    const allExternalIds = [];

    for (const model of models) {
      const info = await modelExists(odoo, model);

      if (!info) {
        modelSummary.push({
          model,
          available: false,
          model_name: '',
          modules: '',
          total_fields: 0,
          total_custom_fields: 0,
          total_external_ids: 0
        });
        continue;
      }

      const fields = await getFields(odoo, model);
      const customFields = await getCustomFields(odoo, model);
      const externalIds = await getExternalIds(odoo, model);

      fields.forEach((f) => allFields.push(f));

      customFields.forEach((f) => {
        allCustomFields.push({
          model,
          field_id: f.id,
          name: f.name,
          field_description: f.field_description,
          ttype: f.ttype,
          relation: f.relation,
          required: f.required,
          readonly: f.readonly,
          store: f.store,
          state: f.state
        });
      });

      externalIds.forEach((x) => {
        allExternalIds.push({
          model,
          external_id: `${x.module}.${x.name}`,
          module: x.module,
          name: x.name,
          res_id: x.res_id
        });
      });

      modelSummary.push({
        model,
        available: true,
        model_name: info.name,
        modules: info.modules,
        total_fields: fields.length,
        total_custom_fields: customFields.length,
        total_external_ids: externalIds.length
      });
    }

    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(modelSummary),
      '01_MODEL_SUMMARY'
    );

    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(allFields),
      '02_ALL_FIELDS'
    );

    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(allCustomFields),
      '03_CUSTOM_FIELDS'
    );

    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(allExternalIds),
      '04_EXTERNAL_IDS'
    );

    for (const model of models) {
      const info = await modelExists(odoo, model);
      if (!info) continue;

      const fields = await getFields(odoo, model);
      const sheetName = safeSheetName(model);
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(fields),
        sheetName
      );
    }

    const buffer = XLSX.write(wb, {
      bookType: 'xlsx',
      type: 'buffer'
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=\"odoo_structure_scan_lokalmart.xlsx\"'
    );

    res.status(200).send(buffer);
  } catch (e) {
    log.error('EXPORT_STRUCTURE', e.message);
    res.status(400).json({
      ok: false,
      error: e.message,
      summary: log.summary(),
      logs: log.lines
    });
  }
};
