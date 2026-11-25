// netlify/functions/ingest-background.js
// Background function (bis 15 Min Laufzeit, antwortet sofort 202).
// Wird von ingest.js mit { blob_key, filename } gestartet: holt das PDF aus Netlify Blobs,
// macht die Claude-Extraktion und schickt alles an die Smile DealDesk API (/api/v2/dealdesk/ingest).
// Das PDF wird danach aus Netlify Blobs geloescht (auch bei Fehlern).
// Kleine PDFs mit { pdf_base64, filename } direkt funktionieren weiterhin (Uebergang).
// Slack ist bewusst aus: Vertragsdaten sollen den getrennten Speicher nicht verlassen (siehe SBDT-14985).
//
// Umgebungsvariablen in Netlify:
//   WEBHOOK_SECRET           - wie bisher
//   ANTHROPIC_KEY            - wie bisher
//   DEV_DEALDESK_INGEST_KEY  - Key von Goran (als Secret markiert)
//   DEALDESK_INGEST_URL      - https://dev.api.app.smileai.co/api/v2/dealdesk/ingest

const { getStore, connectLambda } = require("@netlify/blobs");

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
  const filename = (body.filename || "upload.pdf").trim();
  if (!/\.pdf$/i.test(filename)) { console.log("skip non-pdf"); return { statusCode: 200, body: "skipped" }; }

  let store = null;
  try {
    let b64 = body.pdf_base64;
    if (body.blob_key) {
      connectLambda(event);
      store = getStore("dealdesk-inbox");
      const ab = await store.get(body.blob_key, { type: "arrayBuffer" });
      if (!ab) throw new Error("blob not found " + body.blob_key);
      b64 = Buffer.from(ab).toString("base64");
    }
    if (!b64) throw new Error("missing pdf");
    await process_(b64, filename);
  } catch (e) {
    console.error("ingest failed:", e.message);
  } finally {
    if (store && body.blob_key) {
      try { await store.delete(body.blob_key); } catch (e) { console.error("blob delete failed", body.blob_key); }
    }
  }
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
