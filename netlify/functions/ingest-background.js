// netlify/functions/ingest-background.js
// Background function (bis 15 Min Laufzeit, antwortet sofort 202).
// Power Automate sendet die PDF -> Speichern, Claude-Extraktion, DB-Eintrag, Slack-Alert (nur passender Channel).
const PROMPT = `Du analysierst ein Smile AI Angebotsdokument.
Antworte NUR mit validem JSON. Kein Markdown.

1. KUNDE: Nach "Angebotsempfaenger:" oder "Angebot fuer:". Nur Firmenname. Niemals "Smile AI GmbH" oder "Dr. Kaske GmbH".
2. ANGEBOTSNR & DATUM: Nach "Angebotsnummer:" und "Angebotsdatum:". Exakt kopieren.
3. LEISTUNGEN: Modulnamen 1:1 aus der linken Tabellenspalte. Kategoriezeilen weglassen.
4. INVEST: Kurz vor/nach "Details:" alle Euro-Betraege. Letzte/kleinste=invest_final. invest_rhythmus: "monatlich" oder "jaehrlich".
5. LAUFZEIT: Aus "bei X Monaten Laufzeit".
6. VERTRAGSBEGINN: Aus "Laufzeit des Vertrages beginnt...".

{"kunde":"","angebotsnr":"","angebotsdatum":"","vertragsbeginn":"","laufzeit":"","laufzeit_monate":12,"verlaengerung":"12 Monate","vertragsende_iso":null,"leistungen":[],"invest_brutto":0,"invest_brutto_label":"","invest_rabatt_prozent":null,"invest_final":0,"invest_final_label":"","invest_rhythmus":"jaehrlich","notiz":""}`;

const SB_URL = () => process.env.SUPABASE_URL;
// Server-Key (service_role) bevorzugt, Fallback auf bisherigen Key
const SB_KEY = () => process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const sbH = (extra) => Object.assign({ apikey: SB_KEY(), Authorization: "Bearer " + SB_KEY() }, extra || {});

exports.handler = async (event) => {
  const secret = process.env.WEBHOOK_SECRET;
  const provided = event.headers["x-webhook-secret"] || event.headers["X-Webhook-Secret"];
  if (!secret || provided !== secret) return { statusCode: 401, body: "Unauthorized" };
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  let body;
  try { body = JSON.parse(event.body); } catch (e) { return { statusCode: 400, body: "Invalid JSON" }; }
  const { pdf_base64, filename } = body;
  if (!pdf_base64) return { statusCode: 400, body: "Missing pdf_base64" };
  if (filename && !/\.pdf$/i.test(filename)) { console.log("skip non-pdf", filename); return { statusCode: 200, body: "skipped" }; }

  try { await process_(pdf_base64, (filename || "upload.pdf").trim()); }
  catch (e) { console.error("ingest failed:", e.message); }
  return { statusCode: 200, body: "done" };
};

async function process_(b64, filename) {
  // 1. Duplikat: gleiche Datei schon erfasst?
  const dup = await (await fetch(SB_URL() + "/rest/v1/kunden?select=id&notiz=like." + encodeURIComponent("*src:" + filename + "*"), { headers: sbH() })).json();
  if (Array.isArray(dup) && dup.length) { console.log("duplicate file", filename); return; }

  // 2. Claude-Extraktion
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6", max_tokens: 1500,
      messages: [{ role: "user", content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
        { type: "text", text: PROMPT } ] }]
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Claude " + r.status + " " + JSON.stringify(j).slice(0, 200));
  const txt = (j.content && j.content[0] && j.content[0].text) || "";
  const p = JSON.parse(txt.replace(/```json|```/g, "").trim());

  // 3. Duplikat nach Angebotsnummer
  if (p.angebotsnr) {
    const d2 = await (await fetch(SB_URL() + "/rest/v1/kunden?select=id&angebotsnr=eq." + encodeURIComponent(p.angebotsnr), { headers: sbH() })).json();
    if (Array.isArray(d2) && d2.length) { console.log("duplicate angebotsnr", p.angebotsnr); return; }
  }

  // 4. PDF in privaten Bucket
  const safeName = Date.now() + "_" + filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const up = await fetch(SB_URL() + "/storage/v1/object/vertraege/" + safeName, {
    method: "POST", headers: sbH({ "Content-Type": "application/pdf" }), body: Buffer.from(b64, "base64")
  });
  if (!up.ok) throw new Error("Storage " + up.status + " " + (await up.text()));

  // 5. DB-Eintrag
  const row = {
    kunde: p.kunde, angebotsnr: p.angebotsnr, angebotsdatum: p.angebotsdatum, vertragsbeginn: p.vertragsbeginn,
    laufzeit: p.laufzeit, laufzeit_monate: p.laufzeit_monate || 12, verlaengerung: p.verlaengerung || "12 Monate",
    vertragsende_iso: p.vertragsende_iso || null, invest_brutto: p.invest_brutto || null, invest_brutto_label: p.invest_brutto_label || null,
    invest_rabatt_prozent: p.invest_rabatt_prozent || null, invest_final: p.invest_final || null, invest_final_label: p.invest_final_label || null,
    invest_rhythmus: p.invest_rhythmus || "jaehrlich", invest: p.invest_final || null, invest_label: p.invest_final_label || null,
    leistungen: p.leistungen || [], pdf_url: safeName,
    notiz: ((p.notiz || "") + " src:" + filename + " auto-captured").trim()
  };
  const ins = await fetch(SB_URL() + "/rest/v1/kunden", {
    method: "POST", headers: sbH({ "Content-Type": "application/json", Prefer: "return=minimal" }), body: JSON.stringify([row])
  });
  if (!ins.ok) throw new Error("DB " + ins.status + " " + (await ins.text()));

  // 6. Slack: nur passender Kunden-Channel
  await slackNotify(p);
}

async function slackNotify(p) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !p.kunde) return;
  const H = { Authorization: "Bearer " + token };
  let channels = [], cursor = "";
  do {
    const j = await (await fetch("https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), { headers: H })).json();
    if (!j.ok) { console.error("slack list", j.error); return; }
    channels = channels.concat(j.channels.map(c => ({ id: c.id, name: c.name, is_private: c.is_private })));
    cursor = (j.response_metadata && j.response_metadata.next_cursor) || "";
  } while (cursor);
  const ch = matchChannel(p.kunde, channels);
  if (!ch) { console.log("no slack channel for", p.kunde); return; }
  if (!ch.is_private) await fetch("https://slack.com/api/conversations.join", { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, H), body: JSON.stringify({ channel: ch.id }) });
  const fmt = n => n ? Number(n).toLocaleString("de-DE") + " €" : "—";
  const link = "https://sai-dealdesk.netlify.app?search=" + encodeURIComponent(p.angebotsnr || p.kunde);
  const text = "🆕 *Neuer Vertrag in DealDesk!*\n• Kunde: *" + p.kunde + "*\n• Angebotsnr: " + (p.angebotsnr || "—") +
    "\n• Vertragsbeginn: " + (p.vertragsbeginn || "—") + "\n• Laufzeit: " + (p.laufzeit || "—") +
    "\n• Invest: " + fmt(p.invest_final) + " " + (p.invest_rhythmus === "monatlich" ? "mtl." : "p.a.") +
    "\n• Leistungen: " + ((p.leistungen || []).join(", ") || "—") + "\n🔗 <" + link + "|In DealDesk öffnen>";
  const s = await (await fetch("https://slack.com/api/chat.postMessage", { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, H), body: JSON.stringify({ channel: ch.id, text, unfurl_links: false }) })).json();
  if (!s.ok) console.error("slack send", s.error);
}

function matchChannel(kunde, channels) {
  const name = kunde.toLowerCase()
    .replace(/\b(gmbh|ag|se|inc|ltd|deutschland|pharma|arzneimittel|heilmittel|vital|ingelheim|vetmedica)\b|&\s*co\.?\s*kg|e\.v\.?|pütter/gi, "")
    .trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  let ch = channels.find(c => c.name === name);
  if (ch) return ch;
  ch = channels.find(c => c.name.indexOf(name) >= 0 || (name.indexOf(c.name) >= 0 && c.name.length >= 6));
  if (ch) return ch;
  const parts = name.split("-").filter(x => x.length >= 5);
  for (const x of parts) { ch = channels.find(c => c.name === x || c.name.indexOf(x) >= 0); if (ch) return ch; }
  return null;
}
