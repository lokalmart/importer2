import * as XLSX from "xlsx";

/**
 * Lokalmart Migration-Safe Exporter V8
 *
 * Goal:
 * Export Odoo records as XLSX that can be re-imported by Lokalmart Universal Importer:
 * _model, _action, _external_id, _match, _legacy_id + safe field columns.
 *
 * This is not a full Odoo backup. It is a migration helper.
 */

const DEFAULT_MODELS = [
  "ir.model.fields",
  "ir.ui.view",
  "website.page",
  "website.menu",
  "product.category",
  "product.template",
  "res.partner",
  "project.project",
  "project.task",
  "project.milestone",
  "sale.order",
  "sale.order.line",
  "account.move",
  "account.move.line",
  "payment.provider",
  "payment.method",
  "payment.token",
  "payment.transaction",
  "loyalty.program",
  "loyalty.card",
  "loyalty.history",
  "slide.channel",
  "slide.slide",
  "knowledge.article"
];

const MATCH_PROFILES = {
  "website.page": ["url", "key", "name"],
  "website.menu": ["url", "name"],
  "ir.ui.view": ["key", "name"],
  "ir.model.fields": ["model_id", "name"],
  "product.template": ["default_code", "barcode", "name"],
  "product.product": ["default_code", "barcode"],
  "product.category": ["complete_name", "name"],
  "res.partner": ["email", "phone", "mobile", "name"],
  "project.project": ["name"],
  "project.task": ["name", "project_id"],
  "project.milestone": ["name", "project_id"],
  "sale.order": ["name"],
  "sale.order.line": ["order_id", "product_id", "name"],
  "account.move": ["name", "move_type"],
  "account.move.line": ["move_id", "name"],
  "payment.provider": ["code", "name"],
  "payment.method": ["code", "name"],
  "payment.token": ["provider_id", "partner_id", "name"],
  "payment.transaction": ["reference"],
  "loyalty.program": ["name"],
  "loyalty.card": ["code", "program_id", "partner_id"],
  "slide.channel": ["name"],
  "slide.slide": ["name", "channel_id"],
  "knowledge.article": ["name", "parent_id"]
};

const MODEL_PRIORITIES = {
  "ir.model": 1,
  "ir.model.fields": 2,
  "ir.ui.view": 3,
  "website.page": 4,
  "website.menu": 5,
  "res.partner": 10,
  "product.category": 11,
  "product.template": 12,
  "product.product": 13,
  "payment.provider": 14,
  "payment.method": 15,
  "loyalty.program": 16,
  "loyalty.card": 17,
  "project.project": 20,
  "project.milestone": 21,
  "project.task": 22,
  "sale.order": 30,
  "sale.order.line": 31,
  "account.move": 40,
  "account.move.line": 41,
  "slide.channel": 50,
  "slide.slide": 51,
  "knowledge.article": 60
};

const EXCLUDED_FIELDS = new Set([
  "id",
  "create_uid",
  "create_date",
  "write_uid",
  "write_date",
  "__last_update",
  "activity_ids",
  "message_ids",
  "message_follower_ids",
  "message_partner_ids",
  "message_attachment_count",
  "message_has_error",
  "message_has_error_counter",
  "message_has_sms_error",
  "message_is_follower",
  "message_needaction",
  "message_needaction_counter",
  "message_unread",
  "message_unread_counter",
  "access_token",
  "signup_token",
  "signup_url",
  "password",
  "new_password",
  "api_key",
  "session_token",
  "website_message_ids"
]);

const UNSAFE_MODELS = new Set([
  "ir.model.data",
  "ir.logging",
  "mail.message",
  "mail.mail",
  "ir.attachment",
  "res.config.settings"
]);

const ALLOWED_TYPES = new Set([
  "char",
  "text",
  "html",
  "selection",
  "date",
  "datetime",
  "integer",
  "float",
  "monetary",
  "boolean",
  "many2one",
  "many2many"
]);

function sanitizeSheetName(name, used) {
  let s = String(name || "sheet").replace(/[\\/*?:[\]]/g, "_").slice(0, 31);
  if (!s) s = "sheet";
  let base = s.slice(0, 28);
  let i = 1;
  while (used.has(s)) {
    s = `${base}_${i}`.slice(0, 31);
    i += 1;
  }
  used.add(s);
  return s;
}

function safeSlug(value, fallback = "record") {
  let s = String(value || fallback)
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  if (!s) s = fallback;
  if (/^\d/.test(s)) s = `x_${s}`;
  return s.slice(0, 90);
}

function safeCell(value, warnings, context) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") value = JSON.stringify(value);
  let s = String(value);
  if (s.length > 32000) {
    warnings.push({ type: "TRUNCATED_CELL", context, length: s.length, note: "Excel cell limit. Value truncated to 32000 characters." });
    s = s.slice(0, 32000);
  }
  return s;
}

function parseBody(req) {
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  return req.body || {};
}

async function jsonRpc(rpcUrl, service, rpcMethod, rpcArgs) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { service, method: rpcMethod, args: rpcArgs },
      id: Date.now()
    })
  });

  const text = await response.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new Error(`Odoo returned non-JSON response (${response.status}): ${text.slice(0, 800)}`);
  }

  if (!response.ok || payload.error) {
    const msg =
      payload.error?.data?.message ||
      payload.error?.data?.debug ||
      payload.error?.message ||
      text;
    throw new Error(String(msg).slice(0, 4000));
  }

  return payload.result;
}

function makeOdoo(rpcUrl, db, uid, password) {
  return async function execute(model, method, args = [], kwargs = {}) {
    return await jsonRpc(rpcUrl, "object", "execute_kw", [db, uid, password, model, method, args, kwargs || {}]);
  };
}

async function modelExists(execute, model) {
  const r = await execute("ir.model", "search_read", [[["model", "=", model]]], { fields: ["id", "model", "name"], limit: 1 });
  return r && r.length ? r[0] : null;
}

async function fieldsGet(execute, model) {
  return await execute(model, "fields_get", [], {
    attributes: ["string", "type", "required", "readonly", "relation", "store"]
  });
}

function modelDomain(model, exportMode) {
  if (model === "ir.model.fields") return [["state", "=", "manual"]];
  if (model === "ir.model") return [["state", "=", "manual"]];
  if (model === "ir.ui.view" && exportMode !== "full") {
    return [
      "|", "|", "|",
      ["key", "ilike", "lokalmart"],
      ["key", "ilike", "lm."],
      ["name", "ilike", "Lokalmart"],
      ["arch_db", "ilike", "lokalmart"]
    ];
  }
  if (model === "res.users") return [["share", "=", true]];
  return [];
}

function includeField(model, name, meta, includeArch) {
  if (!meta) return false;
  if (EXCLUDED_FIELDS.has(name)) return false;
  if (!ALLOWED_TYPES.has(meta.type)) return false;
  if (meta.type === "binary" || meta.type === "one2many") return false;
  if (!includeArch && (name === "arch_db" || name === "arch_base")) return false;

  // Avoid dangerous website/editor internals except in view/page exports.
  if ((name === "arch_db" || name === "arch_base") && !["ir.ui.view", "website.page"].includes(model)) return false;

  return true;
}

function getMatchFields(model, fieldsMeta) {
  const base = MATCH_PROFILES[model] || ["name"];
  return base.filter(f => fieldsMeta[f] || f.includes("_id"));
}

function normalizeExternalId(xml) {
  if (!xml) return "";
  if (xml.module && xml.name) return `${xml.module}.${xml.name}`;
  return "";
}

function generateExternalId(model, record, matchFields) {
  let candidate = "";

  for (const f of matchFields) {
    const v = record[f];
    if (v === undefined || v === null || v === false || v === "") continue;
    if (Array.isArray(v)) {
      candidate = v[1] || v[0] || "";
    } else {
      candidate = v;
    }
    if (candidate) break;
  }

  if (!candidate) candidate = record.display_name || record.name || record.id;
  const modelSlug = safeSlug(model.replace(/\./g, "_"), "model");
  const recordSlug = safeSlug(candidate, `id_${record.id}`);
  return `lokalmart_migration.${modelSlug}_${recordSlug}_${record.id}`;
}

async function xmlIdMapForRecords(execute, model, ids) {
  const map = new Map();
  if (!ids.length) return map;

  for (let i = 0; i < ids.length; i += 80) {
    const batch = ids.slice(i, i + 80);
    const rows = await execute("ir.model.data", "search_read", [[["model", "=", model], ["res_id", "in", batch]]], {
      fields: ["module", "name", "model", "res_id"],
      limit: batch.length * 3
    });

    for (const r of rows || []) {
      const xml = normalizeExternalId(r);
      if (xml && !map.has(r.res_id)) map.set(r.res_id, xml);
    }
  }

  return map;
}

async function relationXmlId(execute, relationModel, id, cache) {
  if (!relationModel || !id) return "";
  const key = `${relationModel}:${id}`;
  if (cache.has(key)) return cache.get(key);

  try {
    const rows = await execute("ir.model.data", "search_read", [[["model", "=", relationModel], ["res_id", "=", id]]], {
      fields: ["module", "name", "model", "res_id"],
      limit: 1
    });
    const xml = rows && rows.length ? normalizeExternalId(rows[0]) : "";
    cache.set(key, xml);
    return xml;
  } catch (err) {
    cache.set(key, "");
    return "";
  }
}

async function convertRow(execute, model, record, fieldsMeta, selectedFields, recordXml, relationCache, warnings) {
  const matchFields = getMatchFields(model, fieldsMeta);
  const externalId = recordXml || generateExternalId(model, record, matchFields);

  const out = {
    _model: model,
    _action: "upsert",
    _external_id: externalId,
    _match: matchFields.join(","),
    _legacy_id: record.id
  };

  for (const f of selectedFields) {
    const meta = fieldsMeta[f];
    const value = record[f];

    if (value === undefined || value === null || value === false || value === "") continue;

    if (meta.type === "many2one") {
      if (Array.isArray(value)) {
        const id = value[0];
        const display = value[1] || "";
        const xml = await relationXmlId(execute, meta.relation, id, relationCache);
        if (xml) out[`${f}/xmlid`] = xml;
        else out[f] = safeCell(display || id, warnings, `${model}.${record.id}.${f}`);
      } else if (typeof value === "number") {
        const xml = await relationXmlId(execute, meta.relation, value, relationCache);
        if (xml) out[`${f}/xmlid`] = xml;
        else out[`${f}/id`] = value;
      }
    } else if (meta.type === "many2many") {
      if (Array.isArray(value) && value.length) {
        const xmls = [];
        const ids = [];
        for (const id of value) {
          const xml = await relationXmlId(execute, meta.relation, id, relationCache);
          if (xml) xmls.push(xml);
          else ids.push(id);
        }
        if (xmls.length) out[`${f}/xmlid`] = xmls.join(", ");
        if (ids.length) out[`${f}/id`] = ids.join(", ");
      }
    } else if (meta.type === "boolean") {
      out[f] = value ? true : false;
    } else {
      out[f] = safeCell(value, warnings, `${model}.${record.id}.${f}`);
    }
  }

  return out;
}

async function exportModel(execute, model, options, global) {
  const { limit, includeArch, exportMode } = options;
  const { modelStatus, issues, relationCache } = global;

  if (UNSAFE_MODELS.has(model) && exportMode !== "full") {
    modelStatus.push({ model, status: "SKIPPED_UNSAFE", rows: 0, note: "Skipped in safe mode. Use full mode only for audit, not migration." });
    return [];
  }

  const info = await modelExists(execute, model);
  if (!info) {
    modelStatus.push({ model, status: "MISSING_OR_NO_ACCESS", rows: 0, note: "Model not installed or no access." });
    return [];
  }

  let fieldsMeta;
  try {
    fieldsMeta = await fieldsGet(execute, model);
  } catch (err) {
    modelStatus.push({ model, status: "FIELDS_ERROR", rows: 0, note: err.message });
    return [];
  }

  const selectedFields = Object.keys(fieldsMeta).filter(f => includeField(model, f, fieldsMeta[f], includeArch));

  // Always include display_name if available.
  if (fieldsMeta.display_name && !selectedFields.includes("display_name")) selectedFields.push("display_name");

  const domain = modelDomain(model, exportMode);

  let rows;
  try {
    rows = await execute(model, "search_read", [domain], {
      fields: ["id", ...selectedFields],
      limit: Number(limit) || 300
    });
  } catch (err) {
    // Some fields can still be invalid/read-protected. Try lighter export.
    const lighter = selectedFields.filter(f => !["arch_db", "arch_base"].includes(f));
    try {
      rows = await execute(model, "search_read", [domain], {
        fields: ["id", ...lighter],
        limit: Number(limit) || 300
      });
      issues.push({ model, type: "FALLBACK_FIELDS", message: err.message.slice(0, 700), fallback_fields: lighter.join(",") });
      selectedFields.length = 0;
      selectedFields.push(...lighter);
    } catch (err2) {
      modelStatus.push({ model, status: "SEARCH_READ_ERROR", rows: 0, note: err2.message.slice(0, 1000) });
      return [];
    }
  }

  const ids = (rows || []).map(r => r.id).filter(Boolean);
  const xmlMap = await xmlIdMapForRecords(execute, model, ids);

  const result = [];
  for (const rec of rows || []) {
    const xml = xmlMap.get(rec.id) || "";
    const out = await convertRow(execute, model, rec, fieldsMeta, selectedFields, xml, relationCache, issues);
    result.push(out);
  }

  modelStatus.push({
    model,
    status: "OK",
    rows: result.length,
    note: domain.length ? `domain=${JSON.stringify(domain)}` : ""
  });

  return result;
}

function addSheet(wb, name, rows, usedNames) {
  const sheetName = sanitizeSheetName(name, usedNames);
  const ws = Array.isArray(rows) && rows.length
    ? XLSX.utils.json_to_sheet(rows)
    : XLSX.utils.aoa_to_sheet([["No data"]]);

  const range = XLSX.utils.decode_range(ws["!ref"] || "A1:A1");
  ws["!cols"] = [];
  for (let C = range.s.c; C <= range.e.c; ++C) {
    ws["!cols"].push({ wch: C < 5 ? 22 : 38 });
  }

  XLSX.utils.book_append_sheet(wb, ws, sheetName);
}

function makeReadme(options, modelList) {
  return [
    { item: "Export Type", value: "Lokalmart Migration-Safe Export V8" },
    { item: "Generated At", value: new Date().toISOString() },
    { item: "Export Mode", value: options.exportMode },
    { item: "Limit Per Model", value: options.limit },
    { item: "Include QWeb/HTML Arch", value: options.includeArch ? "yes" : "no" },
    { item: "How to import", value: "Use Lokalmart Universal Importer. Sheets contain _model, _action, _external_id, _match." },
    { item: "Important", value: "This is not a full Odoo backup. It excludes binary files, chatter, passwords/tokens, and unsafe system data." },
    { item: "Model Count", value: modelList.length }
  ];
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });

  try {
    const body = parseBody(req);
    const {
      baseUrl,
      db,
      login,
      password,
      modelList,
      limit = 300,
      includeArch = true,
      exportMode = "safe"
    } = body;

    if (!baseUrl || !db || !login || !password) {
      return res.status(400).json({ ok: false, error: "Missing baseUrl/db/login/password" });
    }

    const cleanBaseUrl = String(baseUrl).replace(/\/+$/, "");
    const rpcUrl = `${cleanBaseUrl}/jsonrpc`;

    const uid = await jsonRpc(rpcUrl, "common", "authenticate", [db, login, password, {}]);
    if (!uid) return res.status(401).json({ ok: false, error: "Authentication failed." });

    const execute = makeOdoo(rpcUrl, db, uid, password);

    let models = Array.isArray(modelList)
      ? modelList
      : String(modelList || "").split(/\n|,/);

    models = models.map(x => String(x).trim()).filter(Boolean);
    if (!models.length) models = DEFAULT_MODELS;

    models = Array.from(new Set(models)).sort((a, b) => (MODEL_PRIORITIES[a] || 1000) - (MODEL_PRIORITIES[b] || 1000));

    const options = {
      limit: Math.max(1, Math.min(Number(limit) || 300, 1500)),
      includeArch: !!includeArch,
      exportMode: ["safe", "full"].includes(exportMode) ? exportMode : "safe"
    };

    const wb = XLSX.utils.book_new();
    const usedNames = new Set();

    const modelStatus = [];
    const issues = [];
    const relationCache = new Map();

    addSheet(wb, "00_README", makeReadme(options, models), usedNames);

    addSheet(wb, "01_IMPORT_SEQUENCE", models.map((m, i) => ({
      sequence: i + 1,
      model: m,
      priority: MODEL_PRIORITIES[m] || 1000,
      note: m === "ir.ui.view" ? "Import after custom fields and before website.page/menu when possible." : ""
    })), usedNames);

    addSheet(wb, "02_MATCH_RULES", Object.keys(MATCH_PROFILES).map(model => ({
      model,
      match: MATCH_PROFILES[model].join(","),
      note: "Generated rows use this _match unless model-specific data requires another strategy."
    })), usedNames);

    const exported = {};
    for (const model of models) {
      try {
        const rows = await exportModel(execute, model, options, { modelStatus, issues, relationCache });
        exported[model] = rows;
      } catch (err) {
        modelStatus.push({ model, status: "EXPORT_ERROR", rows: 0, note: err.message.slice(0, 1200) });
      }
    }

    addSheet(wb, "03_MODEL_STATUS", modelStatus, usedNames);
    addSheet(wb, "04_ISSUES_WARNINGS", issues.length ? issues : [{ status: "OK", message: "No exporter warnings." }], usedNames);

    for (const model of models) {
      const rows = exported[model] || [];
      if (rows.length) addSheet(wb, model, rows, usedNames);
    }

    addSheet(wb, "90_EXCLUDED_NOTES", [
      { item: "binary fields", reason: "Not migration-safe in XLSX. Use Odoo database+filestore backup for exact copy." },
      { item: "mail.message / chatter", reason: "Huge and context-dependent; excluded in safe mode." },
      { item: "ir.attachment", reason: "Binary documents/images require filestore strategy." },
      { item: "res.users passwords/tokens", reason: "Sensitive and not portable." },
      { item: "computed/system fields", reason: "Recomputed by Odoo; not safe to import directly." },
      { item: "numeric Odoo ids", reason: "Stored as _legacy_id for reference only; do not use as migration target ids." }
    ], usedNames);

    const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer", compression: true });
    const date = new Date().toISOString().slice(0, 10);
    const filename = `lokalmart_migration_safe_export_${date}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.status(200).send(buf);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
