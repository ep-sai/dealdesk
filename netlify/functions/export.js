// GET /api/export  (Header x-webhook-secret) -> kompletter Dump der Tabelle kunden als JSON.
// Power Automate ruft das woechentlich auf und legt die Datei in SharePoint ab (Backup, Free Plan hat keine).
exports.handler = async (event) => {
  const secret = process.env.WEBHOOK_SECRET;
  const provided = event.headers["x-webhook-secret"] || event.headers["X-Webhook-Secret"];
  if (!secret || provided !== secret) return { statusCode: 401, body: "Unauthorized" };
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  const r = await fetch(process.env.SUPABASE_URL + "/rest/v1/kunden?select=*&order=created_at.asc", { headers: { apikey: key, Authorization: "Bearer " + key } });
  const data = await r.json();
  if (!r.ok) return { statusCode: 500, body: JSON.stringify(data) };
  return { statusCode: 200, headers: { "Content-Type": "application/json", "Content-Disposition": "attachment; filename=dealdesk_backup.json" }, body: JSON.stringify({ exported_at: new Date().toISOString(), count: data.length, rows: data }) };
};
