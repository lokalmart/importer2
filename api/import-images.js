/**
 * Lokalmart Image Import API V10
 *
 * Accepts JSON rows parsed in the browser from XLSX:
 * {
 *   baseUrl, db, login, password,
 *   createMissing: false,
 *   rows: [
 *     {
 *       model: "product.template",
 *       match_field: "default_code",
 *       match_value: "SKU001",
 *       target_field: "image_1920",
 *       image_url: "https://...",
 *       image_base64: "...",
 *       name: "Product Name"
 *     }
 *   ]
 * }
 */

const MAX_ROWS_PER_CALL = 25;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

function parseBody(req) {
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  return req.body || {};
}

async function jsonRpc(rpcUrl, service, rpcMethod, rpcArgs) {
  const response = await fetch(rpcUrl, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({
      jsonrpc:"2.0",
      method:"call",
      params:{ service, method:rpcMethod, args:rpcArgs },
      id:Date.now()
    })
  });

  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch(e) { throw new Error(`Odoo returned non-JSON: ${text.slice(0,800)}`); }

  if (!response.ok || payload.error) {
    throw new Error(payload.error?.data?.message || payload.error?.data?.debug || payload.error?.message || text);
  }
  return payload.result;
}

function makeExecute(rpcUrl, db, uid, password) {
  return async function execute(model, method, args = [], kwargs = {}) {
    return await jsonRpc(rpcUrl, "object", "execute_kw", [db, uid, password, model, method, args, kwargs || {}]);
  };
}

function stripDataPrefix(base64) {
  return String(base64 || "").replace(/^data:[^;]+;base64,/i, "").trim();
}

function normalizeRow(row) {
  const r = {};
  for (const [k,v] of Object.entries(row || {})) {
    r[String(k).trim()] = typeof v === "string" ? v.trim() : v;
  }

  const model = r.model || r._model || "product.template";
  const targetField = r.target_field || r.image_field || "image_1920";

  let matchField = r.match_field || "";
  let matchValue = r.match_value || "";

  if (!matchField || !matchValue) {
    if (r._external_id) { matchField = "_external_id"; matchValue = r._external_id; }
    else if (r.default_code) { matchField = "default_code"; matchValue = r.default_code; }
    else if (r.barcode) { matchField = "barcode"; matchValue = r.barcode; }
    else if (r.name) { matchField = "name"; matchValue = r.name; }
  }

  const imageUrl = r.image_url || r.photo_url || r.foto_url || r.image || "";
  const imageBase64 = r.image_base64 || r.image_1920 || r[targetField] || "";
  const imageFilename = r.image_filename || r.photo_filename || r.foto_filename || "";

  return {
    ...r,
    model,
    targetField,
    matchField,
    matchValue,
    imageUrl,
    imageBase64,
    imageFilename
  };
}

async function imageUrlToBase64(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error(`Invalid image_url: ${url}`);
  const response = await fetch(url, {
    method:"GET",
    headers:{ "User-Agent":"Lokalmart-Image-Importer/10.0" }
  });
  if (!response.ok) throw new Error(`Image fetch failed ${response.status} for ${url}`);

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) throw new Error(`URL is not an image: ${contentType || "unknown content-type"}`);

  const ab = await response.arrayBuffer();
  if (ab.byteLength > MAX_IMAGE_BYTES) throw new Error(`Image too large: ${ab.byteLength} bytes. Max ${MAX_IMAGE_BYTES}.`);

  return Buffer.from(ab).toString("base64");
}

async function findByExternalId(execute, xmlid) {
  const parts = String(xmlid || "").split(".");
  if (parts.length !== 2) return null;
  const rows = await execute("ir.model.data", "search_read", [[["module","=",parts[0]],["name","=",parts[1]]]], {
    fields:["model","res_id"],
    limit:1
  });
  return rows && rows.length ? rows[0] : null;
}

async function findRecord(execute, model, matchField, matchValue) {
  if (!matchField || !matchValue) return [];

  if (matchField === "_external_id" || matchField === "external_id" || matchField === "xmlid") {
    const row = await findByExternalId(execute, matchValue);
    if (!row) return [];
    return row.model === model ? [row.res_id] : [];
  }

  const domain = [[matchField, "=", matchValue]];
  return await execute(model, "search", [domain], { limit: 2 });
}

async function modelHasField(execute, model, field) {
  const meta = await execute(model, "fields_get", [[field]], { attributes:["type","string"] });
  return meta && meta[field];
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Use POST" });

  try {
    const body = parseBody(req);
    const { baseUrl, db, login, password, createMissing = false } = body;
    let rows = Array.isArray(body.rows) ? body.rows : [];

    if (!baseUrl || !db || !login || !password) return res.status(400).json({ ok:false, error:"Missing Odoo credentials." });
    if (!rows.length) return res.status(400).json({ ok:false, error:"No rows provided." });

    rows = rows.slice(0, MAX_ROWS_PER_CALL).map(normalizeRow);

    const rpcUrl = `${String(baseUrl).replace(/\/+$/,"")}/jsonrpc`;
    const uid = await jsonRpc(rpcUrl, "common", "authenticate", [db, login, password, {}]);
    if (!uid) return res.status(401).json({ ok:false, error:"Authentication failed." });

    const execute = makeExecute(rpcUrl, db, uid, password);

    const results = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const result = {
        row: i + 1,
        model: row.model,
        match: `${row.matchField}=${row.matchValue}`,
        target_field: row.targetField,
        status: "pending"
      };

      try {
        if (!row.model) throw new Error("Missing model.");
        if (!row.matchField || !row.matchValue) throw new Error("Missing match_field/match_value. Use default_code, barcode, name, or _external_id.");
        if (!row.imageUrl && !row.imageBase64) throw new Error("Missing image_url or image_base64.");
        const fieldMeta = await modelHasField(execute, row.model, row.targetField);
        if (!fieldMeta) throw new Error(`Field ${row.targetField} does not exist on ${row.model}.`);

        let ids = await findRecord(execute, row.model, row.matchField, row.matchValue);

        if ((!ids || !ids.length) && createMissing) {
          const vals = { name: row.name || row.matchValue };
          if (row.model === "product.template" && row.default_code) vals.default_code = row.default_code;
          if (row.barcode && fieldMeta.barcode) vals.barcode = row.barcode;
          const newId = await execute(row.model, "create", [vals]);
          ids = [newId];
          result.created = true;
        }

        if (!ids || !ids.length) throw new Error("No matching record found.");
        if (ids.length > 1) throw new Error("Multiple matching records found. Use a more specific match.");

        const base64 = row.imageBase64 ? stripDataPrefix(row.imageBase64) : await imageUrlToBase64(row.imageUrl);
        if (!base64) throw new Error("Image is empty.");
        if (Buffer.from(base64, "base64").byteLength > MAX_IMAGE_BYTES) throw new Error("Image base64 too large.");

        await execute(row.model, "write", [[ids[0]], { [row.targetField]: base64 }]);

        result.status = "updated";
        result.id = ids[0];
        result.bytes = Buffer.from(base64, "base64").byteLength;
      } catch (err) {
        result.status = "error";
        result.error = err.message || String(err);
      }

      results.push(result);
    }

    const summary = {
      total: results.length,
      updated: results.filter(r => r.status === "updated").length,
      error: results.filter(r => r.status === "error").length,
      created: results.filter(r => r.created).length
    };

    res.status(200).json({ ok:true, summary, results });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message || String(err) });
  }
}
