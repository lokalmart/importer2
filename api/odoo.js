/**
 * Vercel Serverless Function: Odoo JSON-RPC proxy for Lokalmart Page Scanner V3.
 * It does not store credentials. Each request carries baseUrl, db, login, password.
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { baseUrl, db, login, password, model, method, args = [], kwargs = {}, uid: providedUid } = body;

    if (!baseUrl || !db || !login || !password) {
      return res.status(400).json({ ok: false, error: "Missing baseUrl/db/login/password" });
    }

    const cleanBaseUrl = String(baseUrl).replace(/\/+$/, "");
    const rpcUrl = `${cleanBaseUrl}/jsonrpc`;

    async function jsonRpc(service, rpcMethod, rpcArgs) {
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
        throw new Error(`Odoo returned non-JSON response (${response.status}): ${text.slice(0, 500)}`);
      }

      if (!response.ok || payload.error) {
        const msg = payload.error?.data?.message || payload.error?.message || text;
        throw new Error(msg);
      }
      return payload.result;
    }

    const uid = providedUid || await jsonRpc("common", "authenticate", [db, login, password, {}]);
    if (!uid) return res.status(401).json({ ok: false, error: "Authentication failed. Check database, email/login, and API key/password." });

    if (!model || !method) {
      return res.status(200).json({ ok: true, uid, result: true });
    }

    const result = await jsonRpc("object", "execute_kw", [db, uid, password, model, method, args, kwargs || {}]);
    return res.status(200).json({ ok: true, uid, result });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err)
    });
  }
}