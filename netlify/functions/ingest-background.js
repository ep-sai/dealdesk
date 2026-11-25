// netlify/functions/ingest-background.js
// Background function (bis 15 Min Laufzeit, antwortet sofort 202).
// Power Automate sendet die PDF -> Claude-Extraktion -> Smile DealDesk API (/api/v2/dealdesk/ingest).
// Speichern, Duplikat-Pruefung (per Angebotsnummer) und PDF-Ablage uebernimmt jetzt die Smile-API.
// Slack ist bewusst aus: Vertragsdaten sollen den getrennten Speicher nicht verlassen (siehe SBDT-14985).
//
// Umgebungsvariablen in Netlify:
//   WEBHOOK_SECRET           - wie bisher (Header X-Webhook-Secret von Power Automate)
//   ANTHROPIC_KEY            - wie bisher
//   DEV_DEALDESK_INGEST_KEY  - Key von Goran (als Secret markiert)
//   DEALDESK_INGEST_URL      - https://dev.api.app.smileai.co/api/v2/dealdesk/ingest

const PROMPT = `Du analysierst ein Smile AI Angebotsdokument.
Antworte NUR mit validem JSON. Kein Markdown.

1. KUNDE: Nach "Angebotsempfaenger:" oder "Angebot fuer:". Nur Firmenname. Niemals "Smile AI GmbH" oder "Dr. Kaske GmbH".
2. ANGEBOTSNR & DATUM: Nach "Angebotsnummer:" und "Angebotsdatum:". Exakt kopieren.
3. LEISTUNGEN: Modulnamen 1:1 aus der linken Tabellenspalte. Kategoriezeilen weglassen.
4. INVEST: Kurz vor/nach "Details:" alle Euro-Betraege. Letzte/kleinste=invest_final. invest_rhythmus: "monatlich" oder "jaehrlich".
5. LAUFZEIT: Aus "bei X Monaten Laufzeit".
6. VERTRAGSBEGINN: Aus "Laufzeit des Vertrages beginnt...".

{"kunde":"","angebotsnr":"","angebotsdatum":"","vertragsbeginn":"","laufzeit":"","laufzeit_monate":12,"verlaengerung":"12 Monate","vertragsende_iso":null,"leistungen":[],"invest_brutto":0,"invest_brutto_label":"","invest_rabatt_prozent":null,"invest_final":0,"invest_final_label":"","invest_rhythmus":"jaehrlich","notiz":""}`;

const INGEST_URL = () => process.env.DEALDESK_INGEST_URL;
const INGEST_KEY = () => process.env.DEV_DEALDESK_INGEST_KEY;

exports.handler = async (event) => {
  const secret = process.env.WEBHOOK_SECRET;
  const provided = event.headers["x-webhook-secret"] || event.headers["X-Webhook-Secret"];
  if (!secret || provided !== secret) return { statusCode: 401, body: "Unauthorized" };
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  let body;
  try { body = JSON.parse(event.body); } catch (e) { return { statusCode: 400, body: "Invalid JSON" }; }
  const { pdf_base64, filename } = body;
  if (!pdf_base64) return { statusCode: 400, body: "Missing pdf_base64" };
  if (filename && !/\.pdf$/i.test(filename)) { console.log("skip non-pdf"); return { statusCode: 200, body: "skipped" }; }

  try { await process_(pdf_base64, (filename || "upload.pdf").trim()); }
  catch (e) { console.error("ingest failed:", e.message); }
  return { statusCode: 200, body: "done" };
};

async function process_(b64, filename) {
  if (!INGEST_URL() || !INGEST_KEY()) throw new Error("DEALDESK_INGEST_URL oder DEV_DEALDESK_INGEST_KEY fehlt");

  // 1. Claude-Extraktion (unveraendert)
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
  if (!r.ok) throw new Error("Claude " + r.status);
  const txt = (j.content && j.content[0] && j.content[0].text) || "";
  const p = JSON.parse(txt.replace(/```json|```/g, "").trim());

  // 2. Ohne Angebotsnummer kein Ingest (die API aktualisiert per Angebotsnummer statt Duplikate anzulegen)
  if (!p.angebotsnr) throw new Error("keine Angebotsnummer extrahiert");

  // 3. Felder auf das Format der Smile-API umstellen
  const data = {
    customer: p.kunde || null,
    offerNo: p.angebotsnr,
    offerDate: p.angebotsdatum || null,
    contractStart: p.vertragsbeginn || null,
    term: p.laufzeit || null,
    termMonths: p.laufzeit_monate || 12,
    renewal: p.verlaengerung || "12 Monate",
    contractEnd: p.vertragsende_iso || null,
    investGross: p.invest_brutto || null,
    discountPct: p.invest_rabatt_prozent || null,
    investFinal: p.invest_final || null,
    paymentRhythm: p.invest_rhythmus === "monatlich" ? "monatlich" : "jaehrlich",
    services: p.leistungen || [],
    note: ((p.notiz || "") + " src:" + filename).trim(),
    status: "auto_captured"
  };

  // 4. Multipart an die Smile-API: data (JSON) + file (PDF)
  const form = new FormData();
  form.append("data", JSON.stringify(data));
  form.append("file", new Blob([Buffer.from(b64, "base64")], { type: "application/pdf" }), filename);

  const res = await fetch(INGEST_URL(), { method: "POST", headers: { "X-Api-Key": INGEST_KEY() }, body: form });
  if (!res.ok) throw new Error("Smile ingest " + res.status + " " + (await res.text()).slice(0, 300));

  // Antwort enthaelt nur id, offerNo und ob eine Datei gespeichert wurde -> nur das loggen
  const out = await res.json().catch(() => ({}));
  console.log("ingested", out.id, out.offerNo, out.fileStored ?? out.file_stored ?? "");
}
