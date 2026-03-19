import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

function getArticleStore() {
  return getStore({ name: "articles", consistency: "strong" });
}
function getDatasheetStore() {
  return getStore({ name: "datasheets", consistency: "strong" });
}

// -------------------------------------------------------------------
// PROGRESS LOG: writes live status into the article for the frontend
// -------------------------------------------------------------------
async function log(store: any, articleId: string, article: any, step: string, detail: string, status?: string) {
  const entry = { time: new Date().toISOString(), step, detail };
  if (!article.crawl_log) article.crawl_log = [];
  article.crawl_log.push(entry);
  if (status) article.crawl_status = status;
  article.updated_at = new Date().toISOString();
  await store.setJSON(articleId, article);
  console.log(`[Crawl] ${step}: ${detail}`);
}

// -------------------------------------------------------------------
// 1. SEARCH
// -------------------------------------------------------------------
async function searchDatasheet(article: any, apiKey: string, model: string): Promise<{ url: string | null; error: string | null }> {
  const searchTerms = [article.manufacturer, article.manufacturer_sku, article.ean_gtin].filter(Boolean).join(" ");
  const prompt = `Du bist ein technischer Recherche-Assistent. Finde das offizielle Datenblatt (PDF) für folgendes Produkt:

Hersteller: ${article.manufacturer}
${article.manufacturer_sku ? `Hersteller-SKU: ${article.manufacturer_sku}` : ""}
${article.ean_gtin ? `EAN/GTIN: ${article.ean_gtin}` : ""}
${article.product_name ? `Produktname: ${article.product_name}` : ""}

Anweisungen:
1. Suche nach "${searchTerms} datasheet PDF"
2. Bevorzuge die offizielle Herstellerseite
3. Alternativ: Distributor-Seiten (Mouser, Digi-Key, Farnell, RS Components)
4. Die URL muss direkt auf eine PDF-Datei zeigen oder eine Seite sein, die das Datenblatt enthält
5. Antworte NUR mit einem JSON-Objekt im Format: {"datasheet_url": "https://...", "source": "manufacturer|distributor|other", "confidence": 0.0-1.0}
6. Wenn du kein Datenblatt findest: {"datasheet_url": null, "source": null, "confidence": 0, "reason": "..."}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 1024, tools: [{ type: "web_search_20250305", name: "web_search" }], messages: [{ role: "user", content: prompt }] }),
    });
    if (!response.ok) { const err = await response.text(); return { url: null, error: `API-Fehler ${response.status}: ${err.slice(0, 300)}` }; }
    const data = await response.json();
    const textBlocks = data.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") || "";
    const jsonMatch = textBlocks.match(/\{[\s\S]*?"datasheet_url"[\s\S]*?\}/);
    if (jsonMatch) { try { return { url: JSON.parse(jsonMatch[0]).datasheet_url, error: null }; } catch { return { url: null, error: "JSON-Parsing fehlgeschlagen: " + textBlocks.slice(0, 200) }; } }
    const urlMatch = textBlocks.match(/https?:\/\/[^\s"'<>]+\.pdf[^\s"'<>]*/i);
    if (urlMatch) return { url: urlMatch[0], error: null };
    return { url: null, error: "Kein Datenblatt gefunden. KI-Antwort: " + textBlocks.slice(0, 300) };
  } catch (e: any) { return { url: null, error: `Suche fehlgeschlagen: ${e.message}` }; }
}

// -------------------------------------------------------------------
// 2. DOWNLOAD
// -------------------------------------------------------------------
async function downloadPdf(url: string): Promise<{ buffer: ArrayBuffer | null; error: string | null }> {
  try {
    const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 LUMITRONIX-Crawler/1.0" }, redirect: "follow" });
    if (!resp.ok) return { buffer: null, error: `Download fehlgeschlagen: HTTP ${resp.status}` };
    const ct = resp.headers.get("content-type") || "";
    if (!ct.includes("pdf") && !ct.includes("octet-stream") && !url.toLowerCase().includes(".pdf")) return { buffer: null, error: `Kein PDF: Content-Type ist ${ct}` };
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength < 500) return { buffer: null, error: "Datei zu klein, vermutlich kein gültiges PDF" };
    return { buffer, error: null };
  } catch (e: any) { return { buffer: null, error: `Download-Fehler: ${e.message}` }; }
}

// -------------------------------------------------------------------
// 3. EXTRACT
// -------------------------------------------------------------------
async function extractFromPdf(pdfBase64: string, article: any, apiKey: string, model: string): Promise<{ specs: any; confidence: number; error: string | null }> {
  const prompt = `Du bist ein LED-Datenblatt-Analysator. Lies das angehängte Datenblatt und extrahiere alle technischen Spezifikationen.
Gesucht wird: ${article.manufacturer} ${article.manufacturer_sku || article.product_name}
Extrahiere folgende Werte und gib sie als JSON zurück. Nutze NULL wenn ein Wert nicht im Datenblatt steht. Einheiten NICHT in die Werte schreiben, nur die Zahl.
{"product_name":"string","product_status":"Active|Preview|NRND|EOL|Obsolete oder null","vf_typ":"V","vf_min":"V","vf_max":"V","if_typ":"mA","if_max":"mA","vr_max":"V","pd_max":"W","power_nominal":"W","flux_typ":"lm","flux_min":"lm","efficacy":"lm/W","cct_k":"K ganzzahlig","cri_ra":"","cri_r9":"","viewing_angle":"°","dom_wavelength":"nm","peak_wavelength":"nm","sdcm":"","package_type":"z.B. 5630","dim_l_mm":"mm","dim_w_mm":"mm","dim_h_mm":"mm","rth_js":"K/W","tj_max":"°C","ts_max":"°C","weight_g":"g","confidence":"0.0-1.0"}
Antworte NUR mit dem JSON-Objekt. Keine Erklärung.`;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 2048, messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } }, { type: "text", text: prompt }] }] }),
    });
    if (!response.ok) { const err = await response.text(); return { specs: {}, confidence: 0, error: `API-Fehler ${response.status}: ${err.slice(0, 300)}` }; }
    const data = await response.json();
    const text = data.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") || "";
    const jsonMatch = text.match(/\{[\s\S]+\}/);
    if (!jsonMatch) return { specs: {}, confidence: 0, error: "Keine JSON-Antwort: " + text.slice(0, 200) };
    const specs = JSON.parse(jsonMatch[0].replace(/```json|```/g, "").trim());
    const confidence = typeof specs.confidence === "number" ? specs.confidence : 0.5;
    delete specs.confidence;
    return { specs, confidence, error: null };
  } catch (e: any) { return { specs: {}, confidence: 0, error: `Extraktion fehlgeschlagen: ${e.message}` }; }
}

// -------------------------------------------------------------------
// MAIN
// -------------------------------------------------------------------
export default async (req: Request, context: Context) => {
  const body = await req.json();
  const articleId = body.article_id;
  if (!articleId) return;

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) { console.error("ANTHROPIC_API_KEY nicht konfiguriert"); return; }

  const model = body.ai_model || "claude-sonnet-4-20250514";
  const store = getArticleStore();
  const dsStore = getDatasheetStore();

  const article = await store.get(articleId, { type: "json" });
  if (!article) { console.error("Artikel nicht gefunden:", articleId); return; }

  article.crawl_log = [];
  await log(store, articleId, article, "start", `Crawler gestartet · Modell: ${model}`, "searching");
  await log(store, articleId, article, "api_connect", "Verbinde mit Anthropic API und starte Web-Suche …");

  const searchResult = await searchDatasheet(article, apiKey, model);

  if (!searchResult.url) {
    await log(store, articleId, article, "search_failed", searchResult.error || "Kein Datenblatt gefunden", "failed");
    article.retry_count = (article.retry_count || 0) + 1;
    article.error_log = searchResult.error || "Kein Datenblatt gefunden";
    article.crawled_at = new Date().toISOString();
    await store.setJSON(articleId, article);
    return;
  }

  await log(store, articleId, article, "url_found", `Datenblatt gefunden: ${searchResult.url}`);
  article.datasheet_url = searchResult.url;

  await log(store, articleId, article, "downloading", "PDF wird heruntergeladen …");
  const dlResult = await downloadPdf(searchResult.url);

  if (!dlResult.buffer) {
    await log(store, articleId, article, "download_failed", dlResult.error || "PDF-Download fehlgeschlagen");
    article.crawl_status = "found"; article.ai_confidence = 0.3;
    article.error_log = dlResult.error; article.crawled_at = new Date().toISOString();
    await store.setJSON(articleId, article);
    return;
  }

  const sizeKB = Math.round(dlResult.buffer.byteLength / 1024);
  await log(store, articleId, article, "downloaded", `PDF heruntergeladen (${sizeKB} KB) und gespeichert`);

  const pdfBlob = new Blob([dlResult.buffer], { type: "application/pdf" });
  await dsStore.set(articleId, pdfBlob);
  article.datasheet_path = `datasheets/${articleId}`;

  await log(store, articleId, article, "extracting", "KI analysiert das Datenblatt …"); 

  const pdfBase64 = bufferToBase64(dlResult.buffer);
  const extractResult = await extractFromPdf(pdfBase64, article, apiKey, model);

  if (extractResult.error && Object.keys(extractResult.specs).length === 0) {
    await log(store, articleId, article, "extract_failed", extractResult.error || "Extraktion fehlgeschlagen");
    article.crawl_status = "found"; article.ai_confidence = 0.3; article.error_log = extractResult.error;
  } else {
    const specs = extractResult.specs;
    let fieldCount = 0;
    for (const [key, val] of Object.entries(specs)) {
      if (val !== null && val !== undefined && val !== "" && key in article) {
        const numVal = typeof val === "string" ? parseFloat(val) : val;
        if (typeof article[key] === "object" || article[key] === null) { article[key] = isNaN(numVal as number) ? val : numVal; fieldCount++; }
      }
    }
    article.crawl_status = "found"; article.ai_confidence = extractResult.confidence; article.error_log = extractResult.error || null;
    await log(store, articleId, article, "extracted", `${fieldCount} Felder extrahiert · Konfidenz: ${Math.round(extractResult.confidence * 100)}%`);
  }

  article.crawled_at = new Date().toISOString();
  article.ai_model_used = model;
  await log(store, articleId, article, "done", "Fertig!", "found");
};

// Background functions must NOT have a custom path - the -background suffix handles routing

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
