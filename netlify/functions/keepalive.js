// Scheduled (siehe netlify.toml): haelt das Supabase-Projekt aktiv (Free Plan pausiert nach 7 Tagen Inaktivitaet).
exports.handler = async () => {
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  const r = await fetch(process.env.SUPABASE_URL + "/rest/v1/kunden?select=id&limit=1", { headers: { apikey: key, Authorization: "Bearer " + key } });
  console.log("keepalive status", r.status);
  return { statusCode: r.ok ? 200 : 500, body: "status " + r.status };
};
