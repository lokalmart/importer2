import * as XLSX from "xlsx";

/**
 * Lokalmart Odoo Full Autopsy Exporter V7
 * Exports selected Odoo models, website structure, field metadata, and automatic issue findings into XLSX.
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });

  const startedAt = new Date();
  const warnings = [];

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { baseUrl, db, login, password, modelList, limit = 1500, includeArch = true, includeAllFields = false } = body;

    if (!baseUrl || !db || !login || !password) {
      return res.status(400).json({ ok: false, error: "Missing baseUrl, db, login, or password/API key" });
    }

    const cleanBaseUrl = String(baseUrl).replace(/\/+$/, "");
    const rpcUrl = `${cleanBaseUrl}/jsonrpc`;

    async function jsonRpc(service, method, args) {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() })
      });
      const text = await response.text();
      let payload;
      try { payload = JSON.parse(text); }
      catch { throw new Error(`Odoo returned non-JSON response (${response.status}): ${text.slice(0, 800)}`); }
      if (!response.ok || payload.error) {
        const msg = payload.error?.data?.message || payload.error?.data?.debug || payload.error?.message || text;
        throw new Error(String(msg).slice(0, 5000));
      }
      return payload.result;
    }

    async function executeKw(model, method, args = [], kwargs = {}) {
      return await jsonRpc("object", "execute_kw", [db, uid, password, model, method, args, kwargs]);
    }

    const uid = await jsonRpc("common", "authenticate", [db, login, password, {}]);
    if (!uid) return res.status(401).json({ ok: false, error: "Authentication failed" });

    const wb = XLSX.utils.book_new();
    const fieldCache = {};
    const modelInfoCache = {};
    const dataByModel = {};

    function safeSheetName(name) {
      return String(name || "Sheet").replace(/[\\/?*\[\]:]/g, "_").slice(0, 31) || "Sheet";
    }

    function cell(v) {
      if (v === null || v === undefined) return "";
      if (Array.isArray(v)) return v.map(x => Array.isArray(x) ? x.join(" / ") : String(x)).join(", ");
      if (typeof v === "object") return JSON.stringify(v).slice(0, 32700);
      const s = String(v);
      return s.length > 32700 ? s.slice(0, 32700) : s;
    }

    function normalizeRows(rows) {
      return (rows || []).map(r => {
        const out = {};
        for (const [k, v] of Object.entries(r || {})) out[k] = cell(v);
        return out;
      });
    }

    function appendJsonSheet(name, rows) {
      const ws = XLSX.utils.json_to_sheet(normalizeRows(rows || []));
      XLSX.utils.book_append_sheet(wb, ws, safeSheetName(name));
    }

    function appendAoaSheet(name, rows) {
      const ws = XLSX.utils.aoa_to_sheet(rows.map(row => row.map(cell)));
      XLSX.utils.book_append_sheet(wb, ws, safeSheetName(name));
    }

    async function modelExists(model) {
      if (modelInfoCache[model] !== undefined) return modelInfoCache[model];
      try {
        const found = await executeKw("ir.model", "search_read", [[ ["model", "=", model] ]], { fields: ["id", "model", "name", "state"], limit: 1 });
        modelInfoCache[model] = found && found.length ? found[0] : null;
      } catch (err) {
        modelInfoCache[model] = null;
      }
      return modelInfoCache[model];
    }

    async function fieldsGet(model) {
      if (fieldCache[model]) return fieldCache[model];
      fieldCache[model] = await executeKw(model, "fields_get", [], {
        attributes: ["string", "type", "required", "readonly", "relation", "store", "selection"]
      });
      return fieldCache[model];
    }

    function existingFields(fieldMap, wanted) {
      return wanted.filter(f => fieldMap[f]);
    }

    async function safeSearchRead(model, wantedFields, domain = [], rowLimit = limit, order = "id asc") {
      const info = await modelExists(model);
      if (!info) {
        warnings.push({ model, level: "warning", issue: "Model tidak tersedia / tidak punya akses" });
        return [];
      }

      let fmap;
      try { fmap = await fieldsGet(model); }
      catch (err) {
        warnings.push({ model, level: "error", issue: "fields_get gagal", detail: err.message });
        return [];
      }

      let fields = includeAllFields ? Object.keys(fmap) : existingFields(fmap, wantedFields);
      if (!includeArch) fields = fields.filter(f => !["arch_db", "arch_base"].includes(f));
      if (!fields.length) fields = ["id"];
      if (!fields.includes("id") && fmap.id) fields.unshift("id");

      try {
        const rows = await executeKw(model, "search_read", [domain], { fields, limit: rowLimit, order: fmap.id ? order : undefined });
        return rows || [];
      } catch (err) {
        warnings.push({ model, level: "warning", issue: "search_read field lengkap gagal; retry minimal", detail: err.message });
        const minimal = ["id", "name", "display_name", "write_date", "create_date"].filter(f => fmap[f]);
        try {
          return await executeKw(model, "search_read", [domain], { fields: minimal.length ? minimal : ["id"], limit: rowLimit });
        } catch (err2) {
          warnings.push({ model, level: "error", issue: "search_read minimal gagal", detail: err2.message });
          return [];
        }
      }
    }

    const defaultModels = [
      "website.page",
      "website.menu",
      "ir.ui.view",
      "website",
      "website.redirect",
      "product.template",
      "product.product",
      "product.category",
      "res.partner",
      "crm.lead",
      "project.project",
      "project.task",
      "project.milestone",
      "account.analytic.account",
      "account.analytic.line",
      "slide.channel",
      "slide.slide",
      "knowledge.article",
      "calendar.event",
      "mail.activity.type",
      "ir.model",
      "ir.model.fields",
      "ir.model.data"
    ];

    const modelConfigs = {
      "website.page": ["id", "name", "url", "key", "type", "view_id", "website_id", "is_published", "website_published", "website_indexed", "header_visible", "footer_visible", "is_in_menu", "website_meta_title", "website_meta_description", "website_meta_keywords", "create_date", "write_date", "arch_db"],
      "website.menu": ["id", "name", "url", "page_id", "parent_id", "sequence", "website_id", "is_visible", "create_date", "write_date"],
      "ir.ui.view": ["id", "name", "key", "type", "mode", "active", "inherit_id", "website_id", "priority", "create_date", "write_date", "arch_db"],
      "website": ["id", "name", "domain", "company_id", "default_lang_id", "homepage_id", "create_date", "write_date"],
      "website.redirect": ["id", "name", "url_from", "url_to", "type", "website_id", "active", "create_date", "write_date"],
      "product.template": ["id", "name", "default_code", "barcode", "list_price", "standard_price", "categ_id", "type", "sale_ok", "purchase_ok", "website_published", "is_published", "website_url", "public_categ_ids", "description_sale", "description", "create_date", "write_date"],
      "product.product": ["id", "name", "default_code", "barcode", "product_tmpl_id", "list_price", "standard_price", "active", "create_date", "write_date"],
      "product.category": ["id", "name", "parent_id", "complete_name", "create_date", "write_date"],
      "res.partner": ["id", "name", "display_name", "email", "phone", "mobile", "website", "is_company", "company_type", "supplier_rank", "customer_rank", "street", "street2", "city", "zip", "state_id", "country_id", "vat", "category_id", "create_date", "write_date"],
      "crm.lead": ["id", "name", "type", "stage_id", "partner_id", "email_from", "phone", "mobile", "user_id", "team_id", "priority", "expected_revenue", "description", "create_date", "write_date"],
      "project.project": ["id", "name", "partner_id", "user_id", "privacy_visibility", "stage_id", "date_start", "date", "description", "create_date", "write_date"],
      "project.task": ["id", "name", "project_id", "stage_id", "user_ids", "partner_id", "priority", "date_deadline", "kanban_state", "description", "create_date", "write_date"],
      "project.milestone": ["id", "name", "project_id", "deadline", "is_reached", "create_date", "write_date"],
      "account.analytic.account": ["id", "name", "partner_id", "company_id", "active", "create_date", "write_date"],
      "account.analytic.line": ["id", "name", "date", "account_id", "project_id", "task_id", "partner_id", "unit_amount", "amount", "create_date", "write_date"],
      "slide.channel": ["id", "name", "description", "website_published", "is_published", "create_date", "write_date"],
      "slide.slide": ["id", "name", "channel_id", "slide_type", "website_published", "is_published", "description", "html_content", "create_date", "write_date"],
      "knowledge.article": ["id", "name", "body", "parent_id", "create_date", "write_date"],
      "calendar.event": ["id", "name", "start", "stop", "location", "description", "partner_ids", "create_date", "write_date"],
      "mail.activity.type": ["id", "name", "summary", "category", "delay_count", "delay_unit", "create_date", "write_date"],
      "ir.model": ["id", "name", "model", "state", "transient", "create_date", "write_date"],
      "ir.model.fields": ["id", "name", "model", "model_id", "field_description", "ttype", "relation", "required", "readonly", "store", "state", "create_date", "write_date"],
      "ir.model.data": ["id", "module", "name", "model", "res_id", "noupdate", "date_init", "date_update", "create_date", "write_date"]
    };

    const requestedModels = Array.isArray(modelList) && modelList.length
      ? modelList.map(x => String(x).trim()).filter(Boolean)
      : defaultModels;

    const summary = [];
    for (const model of requestedModels) {
      const wanted = modelConfigs[model] || ["id", "name", "display_name", "create_date", "write_date"];
      const rows = await safeSearchRead(model, wanted, [], Number(limit) || 1500);
      dataByModel[model] = rows;
      summary.push({ model, rows: rows.length, status: rows.length ? "OK" : "EMPTY_OR_NO_ACCESS" });
      appendJsonSheet(model, rows);
    }

    // Fields catalog for every requested model.
    const fieldsCatalog = [];
    for (const model of requestedModels) {
      try {
        const info = await modelExists(model);
        if (!info) continue;
        const f = await fieldsGet(model);
        for (const [name, meta] of Object.entries(f)) {
          fieldsCatalog.push({
            model,
            field: name,
            label: meta.string || "",
            type: meta.type || "",
            relation: meta.relation || "",
            required: !!meta.required,
            readonly: !!meta.readonly,
            store: !!meta.store
          });
        }
      } catch (err) {
        warnings.push({ model, level: "warning", issue: "fields catalog gagal", detail: err.message });
      }
    }

    // Automatic website issue detection.
    const issues = [];
    const pages = dataByModel["website.page"] || [];
    const menus = dataByModel["website.menu"] || [];
    const views = dataByModel["ir.ui.view"] || [];
    const products = dataByModel["product.template"] || [];
    const partners = dataByModel["res.partner"] || [];
    const tasks = dataByModel["project.task"] || [];

    const pageUrlSet = new Set(pages.map(p => String(p.url || "").replace(/\/+$/, "")).filter(Boolean));
    const urlCount = {};
    for (const p of pages) {
      const u = String(p.url || "").replace(/\/+$/, "") || "";
      if (!u) issues.push({ area: "website.page", severity: "high", item: p.name || p.id, issue: "Page tidak punya URL", recommendation: "Isi field url atau hapus page dummy." });
      urlCount[u] = (urlCount[u] || 0) + 1;
      const content = `${p.name || ""}\n${p.arch_db || ""}\n${p.website_meta_description || ""}`.toLowerCase();
      if (content.includes("yourcompany") || content.includes("lorem ipsum") || content.includes("+1 555")) {
        issues.push({ area: "website.page", severity: "medium", item: p.url || p.name || p.id, issue: "Terdeteksi placeholder bawaan", recommendation: "Ganti teks placeholder dengan konten Lokalmart asli." });
      }
    }
    for (const [url, count] of Object.entries(urlCount)) {
      if (url && count > 1) issues.push({ area: "website.page", severity: "high", item: url, issue: `URL duplikat ${count} kali`, recommendation: "Satukan/rename page agar tidak konflik routing." });
    }

    const requiredRoutes = ["/scan", "/cek-barcode", "/lokal-id", "/local-rewards", "/lokal-ojek", "/program", "/daftar-umkm", "/mitra", "/pusat-bantuan", "/tentang-kami", "/shop"];
    for (const route of requiredRoutes) {
      if (!pageUrlSet.has(route) && route !== "/shop") {
        issues.push({ area: "required-route", severity: "high", item: route, issue: "Route penting belum ditemukan sebagai website.page", recommendation: "Buat page atau redirect yang sesuai." });
      }
    }

    for (const m of menus) {
      const u = String(m.url || "").replace(/\/+$/, "") || "";
      if (u.startsWith("/") && !pageUrlSet.has(u) && !["/shop", "/contactus", "/forum"].includes(u)) {
        issues.push({ area: "website.menu", severity: "medium", item: `${m.name || "menu"} -> ${u}`, issue: "Menu mengarah ke route yang tidak ada di website.page", recommendation: "Buat page, ubah URL menu, atau jadikan redirect." });
      }
    }

    // Extract internal links from page/view content.
    const links = [];
    const hrefRe = /href=["'](\/[^"'#? ]+)/gi;
    function scanLinks(sourceModel, sourceName, html) {
      if (!html) return;
      let match;
      while ((match = hrefRe.exec(String(html))) !== null) {
        const target = String(match[1] || "").replace(/\/+$/, "") || "/";
        links.push({ source_model: sourceModel, source: sourceName, target, exists_as_page: pageUrlSet.has(target), status: pageUrlSet.has(target) || target === "/shop" ? "OK" : "MISSING_OR_CONTROLLER" });
      }
    }
    for (const p of pages) scanLinks("website.page", p.url || p.name || p.id, p.arch_db || "");
    for (const v of views) scanLinks("ir.ui.view", v.key || v.name || v.id, v.arch_db || "");
    for (const l of links) {
      if (l.status !== "OK") issues.push({ area: "internal-link", severity: "medium", item: `${l.source} -> ${l.target}`, issue: "Internal link mungkin 404", recommendation: "Pastikan target dibuat sebagai page/menu/route controller." });
    }

    for (const p of products) {
      const price = Number(p.list_price || 0);
      if (!p.name) issues.push({ area: "product", severity: "high", item: p.id, issue: "Produk tanpa nama", recommendation: "Isi nama produk." });
      if (price <= 1) issues.push({ area: "product", severity: "medium", item: p.name || p.id, issue: `Harga rendah/dummy: ${price}`, recommendation: "Gunakan harga nyata atau label pre-order/cek harga secara konsisten." });
      if (!p.categ_id) issues.push({ area: "product", severity: "medium", item: p.name || p.id, issue: "Produk tanpa kategori internal", recommendation: "Rapikan kategori produk." });
      if (!p.barcode && !p.default_code) issues.push({ area: "product", severity: "low", item: p.name || p.id, issue: "Produk tanpa barcode/default_code", recommendation: "Tambahkan kode produk untuk fitur scan." });
    }

    for (const partner of partners) {
      if (!partner.email && !partner.phone && !partner.mobile) {
        issues.push({ area: "partner", severity: "low", item: partner.name || partner.id, issue: "Partner tanpa kontak", recommendation: "Minimal isi nomor WA/HP untuk vendor/UMKM." });
      }
    }

    for (const t of tasks) {
      if (!t.project_id) issues.push({ area: "project.task", severity: "medium", item: t.name || t.id, issue: "Task tanpa project", recommendation: "Masukkan task ke project yang benar." });
      if (!t.stage_id) issues.push({ area: "project.task", severity: "low", item: t.name || t.id, issue: "Task tanpa stage", recommendation: "Rapikan workflow/stage project." });
    }

    appendAoaSheet("00_AUDIT_SUMMARY", [
      ["Lokalmart Odoo Full Autopsy V7"],
      ["Generated At", startedAt.toISOString()],
      ["Odoo URL", cleanBaseUrl],
      ["Database", db],
      ["UID", uid],
      ["Limit per model", limit],
      ["Include arch/html", includeArch ? "YES" : "NO"],
      ["Include all fields", includeAllFields ? "YES" : "NO"],
      [""],
      ["Model", "Rows", "Status"],
      ...summary.map(s => [s.model, s.rows, s.status])
    ]);
    appendJsonSheet("01_ISSUES_FOUND", issues);
    appendJsonSheet("02_LINKS_CHECK", links);
    appendJsonSheet("03_MODEL_FIELDS", fieldsCatalog);
    appendJsonSheet("04_WARNINGS", warnings);

    // Put summary sheets at the front by rebuilding workbook order.
    const priority = ["00_AUDIT_SUMMARY", "01_ISSUES_FOUND", "02_LINKS_CHECK", "03_MODEL_FIELDS", "04_WARNINGS"];
    wb.SheetNames.sort((a, b) => {
      const ia = priority.indexOf(a), ib = priority.indexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a.localeCompare(b);
    });

    const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true });
    const filename = `lokalmart_odoo_full_autopsy_${new Date().toISOString().slice(0,10)}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(out);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err), warnings });
  }
}
