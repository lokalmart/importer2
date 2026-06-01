const { OdooClient, ImportLog } = require('./_odoo');

const DEFAULT_MODELS = [
  'ir.model',
  'ir.model.fields',
  'ir.model.fields.selection',
  'ir.model.data',
  'res.partner',
  'product.template',
  'product.product',
  'product.category',
  'stock.lot',
  'stock.quant',
  'stock.move',
  'stock.move.line',
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
  'pos.session',
  'pos.config',
  'account.analytic.line',
  'account.move',
  'account.move.line',
  'account.journal',
  'account.account',
  'website.page',
  'website.menu'
];

function parseModels(input) {
  if (!input) return DEFAULT_MODELS;
  return String(input)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
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
  try {
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
      name,
      label: def.string || name,
      type: def.type || '',
      required: !!def.required,
      readonly: !!def.readonly,
      store: def.store !== undefined ? !!def.store : null,
      relation: def.relation || '',
      selection: Array.isArray(def.selection)
        ? def.selection.map((s) => Array.isArray(s) ? `${s[0]}:${s[1]}` : String(s)).join(' | ')
        : '',
      help: def.help || '',
      sortable: def.sortable !== undefined ? !!def.sortable : null,
      exportable: def.exportable !== undefined ? !!def.exportable : null
    }));
  } catch (e) {
    return { error: e.message };
  }
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
      200
    );
  } catch (e) {
    return [];
  }
}

async function getModelData(odoo, model) {
  try {
    return await odoo.searchRead(
      'ir.model.data',
      [['model', '=', model]],
      ['module', 'name', 'model', 'res_id'],
      200
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
    const results = [];

    for (const model of models) {
      const modelInfo = await modelExists(odoo, model);

      if (!modelInfo) {
        log.warn('SCAN_STRUCTURE', `Model tidak tersedia: ${model}`);
        results.push({
          model,
          available: false,
          fields: [],
          custom_fields: [],
          external_ids: []
        });
        continue;
      }

      const fields = await getFields(odoo, model);
      const customFields = await getCustomFields(odoo, model);
      const externalIds = await getModelData(odoo, model);

      const requiredFields = Array.isArray(fields)
        ? fields.filter((f) => f.required).map((f) => f.name)
        : [];

      const readonlyFields = Array.isArray(fields)
        ? fields.filter((f) => f.readonly).map((f) => f.name)
        : [];

      const relationFields = Array.isArray(fields)
        ? fields.filter((f) => f.relation).map((f) => ({
            name: f.name,
            type: f.type,
            relation: f.relation
          }))
        : [];

      const selectionFields = Array.isArray(fields)
        ? fields.filter((f) => f.type === 'selection').map((f) => ({
            name: f.name,
            selection: f.selection
          }))
        : [];

      log.ok('SCAN_STRUCTURE', `Model terbaca: ${model}`);

      results.push({
        model,
        available: true,
        model_info: modelInfo,
        summary: {
          total_fields: Array.isArray(fields) ? fields.length : 0,
          total_custom_fields: customFields.length,
          total_external_ids: externalIds.length,
          required_fields: requiredFields,
          readonly_fields: readonlyFields,
          relation_fields: relationFields,
          selection_fields: selectionFields
        },
        fields,
        custom_fields: customFields,
        external_ids: externalIds
      });
    }

    res.status(200).json({
      ok: true,
      scanned_at: new Date().toISOString(),
      models,
      results,
      summary: log.summary(),
      logs: log.lines
    });
  } catch (e) {
    log.error('SCAN_STRUCTURE', e.message);
    res.status(400).json({
      ok: false,
      error: e.message,
      summary: log.summary(),
      logs: log.lines
    });
  }
};
