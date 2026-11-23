// Prueft Microsoft-Entra-ID-Token (RS256) ohne externe Abhaengigkeiten.
// Default-deny: ohne gueltiges Token UND ohne Eintrag in ALLOWED_EMAILS / ALLOWED_DOMAINS kommt niemand durch.
const crypto = require("crypto");
const TENANT = process.env.ENTRA_TENANT_ID || "645a8199-b652-44c7-903a-9f33740ce3dd";
const CLIENT = process.env.ENTRA_CLIENT_ID || "a917e360-e8fa-4b2c-9c52-4b4f3de30022";
let jwksCache = { at: 0, keys: [] };

async function getKey(kid) {
  if (!jwksCache.keys.length || Date.now() - jwksCache.at > 3600e3 || !jwksCache.keys.find(k => k.kid === kid)) {
    const r = await fetch("https://login.microsoftonline.com/" + TENANT + "/discovery/v2.0/keys");
    if (!r.ok) throw new Error("jwks fetch failed");
    jwksCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  return jwksCache.keys.find(k => k.kid === kid);
}

const list = v => (v || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

// Gibt { email, name } zurueck oder wirft Error mit .status (401/403)
async function authenticate(event) {
  const h = event.headers.authorization || event.headers.Authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const fail = (s, m) => { const e = new Error(m); e.status = s; throw e; };
  const parts = token.split(".");
  if (parts.length !== 3) fail(401, "Nicht angemeldet");
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch (e) { fail(401, "Token ungueltig"); }
  if (header.alg !== "RS256") fail(401, "Token ungueltig");
  const jwk = await getKey(header.kid);
  if (!jwk) fail(401, "Token ungueltig");
  const ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]),
    crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"));
  if (!ok) fail(401, "Token ungueltig");
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now - 60) fail(401, "Token abgelaufen");
  if (payload.nbf && payload.nbf > now + 60) fail(401, "Token ungueltig");
  if (payload.aud !== CLIENT) fail(401, "Token ungueltig");
  if (payload.tid !== TENANT || payload.iss !== "https://login.microsoftonline.com/" + TENANT + "/v2.0") fail(401, "Token ungueltig");

  const email = (payload.preferred_username || payload.email || payload.upn || "").toLowerCase();
  const emails = list(process.env.ALLOWED_EMAILS), domains = list(process.env.ALLOWED_DOMAINS);
  const allowed = email && (emails.includes(email) || domains.includes(email.split("@")[1]));
  if (!allowed) fail(403, "Kein Zugriff");
  return { email, name: payload.name || email };
}

const H = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const resp = (s, b) => ({ statusCode: s, headers: H, body: JSON.stringify(b) });
module.exports = { authenticate, resp };
