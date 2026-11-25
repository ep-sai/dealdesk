// netlify/functions/ingest.js
// Normale (synchrone) Funktion: nimmt das PDF von Power Automate an (bis 6 MB statt 256 KB),
// legt es kurz in Netlify Blobs ab und startet ingest-background nur mit dem Ablage-Schluessel.
// Antwortet nach 1-2 Sekunden, die eigentliche Arbeit macht ingest-background.
//
// Power Automate: URL auf https://sai-dealdesk.netlify.app/.netlify/functions/ingest umstellen,
// sonst nichts aendern (gleicher Header X-Webhook-Secret, gleicher Body).

const { getStore, connectLambda } = require("@netlify/blobs");

exports.handler = async (event) => {
  const secret = process.env.WEBHOOK_SECRET;
  const provided = event.headers["x-webhook-secret"] || event.headers["X-Webhook-Secret"];
  if (!secret || provided !== secret) return { statusCode: 401, body: "Unauthorized" };
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  let body;
  try { body = JSON.parse(event.body); } catch (e) { return { statusCode: 400, body: "Invalid JSON" }; }
  const { pdf_base64 } = body;
  const filename = (body.filename || "upload.pdf").trim();
  if (!pdf_base64) return { statusCode: 400, body: "Missing pdf_base64" };
  if (!/\.pdf$/i.test(filename)) { console.log("skip non-pdf"); return { statusCode: 200, body: "skipped" }; }

  // 1. PDF kurz zwischenspeichern (wird von ingest-background nach der Verarbeitung geloescht)
  connectLambda(event);
  const store = getStore("dealdesk-inbox");
  const key = Date.now() + "-" + Math.random().toString(36).slice(2, 10);
  const buf = Buffer.from(pdf_base64, "base64");
  await store.set(key, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  // 2. Background-Funktion nur mit dem Schluessel starten (kleiner Request, antwortet sofort 202)
  const siteUrl = process.env.URL || "https://sai-dealdesk.netlify.app";
  const res = await fetch(siteUrl + "/.netlify/functions/ingest-background", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": secret },
    body: JSON.stringify({ blob_key: key, filename })
  });
  if (res.status !== 202 && !res.ok) {
    await store.delete(key);
    console.error("background start failed", res.status);
    return { statusCode: 502, body: "Background start failed" };
  }

  console.log("queued", key);
  return { statusCode: 202, body: "queued" };
};
