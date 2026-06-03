export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Use POST" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { baseUrl, db, login, password, model, method, args = [], kwargs = {} } = body;
    if (!baseUrl || !db || !login || !password) return res.status(400).json({ ok:false, error:"Missing Odoo credentials" });

    const rpcUrl = `${String(baseUrl).replace(/\/+$/,"")}/jsonrpc`;

    async function jsonRpc(service, rpcMethod, rpcArgs) {
      const response = await fetch(rpcUrl, {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body:JSON.stringify({ jsonrpc:"2.0", method:"call", params:{ service, method:rpcMethod, args:rpcArgs }, id:Date.now() })
      });
      const text = await response.text();
      let payload;
      try { payload = JSON.parse(text); } catch(e) { throw new Error(`Odoo returned non-JSON: ${text.slice(0,800)}`); }
      if (!response.ok || payload.error) {
        throw new Error(payload.error?.data?.message || payload.error?.data?.debug || payload.error?.message || text);
      }
      return payload.result;
    }

    const uid = await jsonRpc("common", "authenticate", [db, login, password, {}]);
    if (!uid) return res.status(401).json({ ok:false, error:"Authentication failed" });

    if (!model || !method) return res.status(200).json({ ok:true, uid });

    const result = await jsonRpc("object", "execute_kw", [db, uid, password, model, method, args, kwargs || {}]);
    res.status(200).json({ ok:true, uid, result });
  } catch(e) {
    res.status(500).json({ ok:false, error:e.message || String(e) });
  }
}
