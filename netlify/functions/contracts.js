// netlify/functions/contracts.js
// Einziger Zugriffspunkt der App auf Vertragsdaten. Default-deny: Entra-Token + Allowlist, Service-Key nur hier.
const { authenticate, resp } = require("../lib/auth");

const SB = () => process.env.SUPABASE_URL;
const KEY = () => process.env.SUPABASE_SERVICE_KEY;
const hdr = extra => Object.assign({ apikey: KEY(), Authorization: "Bearer " + KEY() }, extra || {});
const COLS = ["kunde","angebotsnr","angebotsdatum","vertragsbeginn","laufzeit","laufzeit_monate","verlaengerung","vertragsende_iso",
  "invest_brutto","invest_brutto_label","invest_rabatt_prozent","invest_final","invest_final_label","invest_rhythmus","invest","invest_label",
  "leistungen","notiz","pdf_url"];
const pick = row => { const o = {}; COLS.forEach(c => { if (row && row[c] !== undefined) o[c] = row[c]; }); return o; };
const FILE = /^[0-9]+_[A-Za-z0-9._-]{1,200}\.pdf$/i;
const UUID = /^[0-9a-f-]{36}$/i;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, { error: "Method not allowed" });
  if (!KEY()) return resp(500, { error: "Server nicht konfiguriert" });
  let user;
  try { user = await authenticate(event); } catch (e) { console.log("DENY", e.status || 500, e.message); return resp(e.status || 500, { error: e.message }); }
  let b; try { b = JSON.parse(event.body || "{}"); } catch (e) { return resp(400, { error: "Invalid JSON" }); }
  const a = b.action;
  console.log("AUDIT", JSON.stringify({ user: user.email, action: a, id: b.id || null, at: new Date().toISOString() }));
  try {
    if (a === "health") return resp(200, { data: { ok: true } });

    if (a === "list") {
      const r = await fetch(SB() + "/rest/v1/kunden?select=*&order=created_at.desc", { headers: hdr() });
      return r.ok ? resp(200, { data: await r.json() }) : resp(500, { error: "DB " + r.status });
    }
    if (a === "insert" || a === "update") {
      const row = pick(b.row);
      if (a === "update" && !UUID.test(b.id || "")) return resp(400, { error: "Bad id" });
      const url = SB() + "/rest/v1/kunden" + (a === "update" ? "?id=eq." + b.id : "");
      const r = await fetch(url, { method: a === "update" ? "PATCH" : "POST", headers: hdr({ "Content-Type": "application/json", Prefer: "return=minimal" }), body: JSON.stringify(a === "update" ? row : [row]) });
      return r.ok ? resp(200, { data: { ok: true } }) : resp(500, { error: "DB " + r.status + " " + (await r.text()).slice(0, 200) });
    }
    if (a === "delete") {
      if (!UUID.test(b.id || "")) return resp(400, { error: "Bad id" });
      const g = await (await fetch(SB() + "/rest/v1/kunden?select=pdf_url&id=eq." + b.id, { headers: hdr() })).json();
      const r = await fetch(SB() + "/rest/v1/kunden?id=eq." + b.id, { method: "DELETE", headers: hdr() });
      if (!r.ok) return resp(500, { error: "DB " + r.status });
      const f = g && g[0] && g[0].pdf_url;
      if (f && FILE.test(f)) await fetch(SB() + "/storage/v1/object/vertraege/" + f, { method: "DELETE", headers: hdr() });
      return resp(200, { data: { ok: true } });
    }
    if (a === "sign") {
      if (!FILE.test(b.path || "")) return resp(400, { error: "Bad path" });
      const r = await fetch(SB() + "/storage/v1/object/sign/vertraege/" + b.path, { method: "POST", headers: hdr({ "Content-Type": "application/json" }), body: JSON.stringify({ expiresIn: Math.min(parseInt(b.seconds) || 300, 3600) }) });
      const j = await r.json();
      if (!r.ok || !j.signedURL) return resp(404, { error: "PDF nicht gefunden" });
      return resp(200, { data: { signedUrl: SB() + "/storage/v1" + j.signedURL } });
    }
    if (a === "upload") {
      if (!FILE.test(b.filename || "") || !b.pdf_base64) return resp(400, { error: "Bad upload" });
      const r = await fetch(SB() + "/storage/v1/object/vertraege/" + b.filename, { method: "POST", headers: hdr({ "Content-Type": "application/pdf" }), body: Buffer.from(b.pdf_base64, "base64") });
      return r.ok ? resp(200, { data: { path: b.filename } }) : resp(500, { error: "Storage " + r.status });
    }
    if (a === "remove") {
      for (const p of (b.paths || [])) if (FILE.test(p)) await fetch(SB() + "/storage/v1/object/vertraege/" + p, { method: "DELETE", headers: hdr() });
      return resp(200, { data: { ok: true } });
    }
    return resp(400, { error: "Unknown action" });
  } catch (e) { console.error("contracts error", e.message); return resp(500, { error: "Serverfehler" }); }
};
