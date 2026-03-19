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
  const prompt = `You are a technical research assistant specialized in finding LED component datasheets.

Find the OFFICIAL ENGLISH datasheet (PDF) for this product:

Manufacturer: ${article.manufacturer}
${article.manufacturer_sku ? `Manufacturer SKU: ${article.manufacturer_sku}` : ""}
${article.ean_gtin ? `EAN/GTIN: ${article.ean_gtin}` : ""}
${article.product_name ? `Product name: ${article.product_name}` : ""}

STRICT RULES – follow in this order:
1. Search for "${searchTerms} datasheet PDF english"
2. The datasheet MUST be in ENGLISH. Never return a Japanese, Chinese, Korean or other non-English datasheet.
3. STRONGLY prefer the official manufacturer website (e.g. nichia.co.jp, osram.com, cree-led.com, lumileds.com, samsung.com/led, seoulsemicon.com)
4. Only if not available from the manufacturer: use Mouser, Digi-Key, Farnell, RS Components, or Octopart
5. The URL should point directly to a PDF file or a page that contains the English datasheet download
6. Verify the SKU/part number appears in the URL or page to ensure it's the correct product

Respond ONLY with a JSON object:
{"datasheet_url": "https://...", "source": "manufacturer|distributor|other", "confidence": 0.0-1.0}
If not found: {"datasheet_url": null, "source": null, "confidence": 0, "reason": "..."}`;

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
  const prompt = `You are an expert LED/electronics datasheet analyzer. Read the attached datasheet carefully and extract ALL technical specifications.

Product: ${article.manufacturer} ${article.manufacturer_sku || article.product_name}

INSTRUCTIONS:
- Return ONLY a JSON object with the fields below
- Use null for values not found in the datasheet
- Numbers only – do NOT include units in values (e.g. write 3.05, not "3.05 V")
- For ranges, extract min/typ/max separately
- Read ALL tables, graphs and footnotes – don't skip anything
- If multiple test conditions exist, prefer values at If=65mA or the "typical" test condition
- For CCT: extract all available CCT bins if the product comes in multiple color temperatures

{
  "product_name": "Full official product name from the datasheet",
  "product_series": "Product series/family name if mentioned",
  "product_status": "Active | Preview | NRND | EOL | Obsolete | null",
  "description": "One-line product description from the datasheet",

  "vf_typ": "Forward voltage typical [V]",
  "vf_min": "Forward voltage minimum [V]",
  "vf_max": "Forward voltage maximum [V]",
  "if_typ": "Forward current typical/test [mA]",
  "if_max": "Absolute maximum forward current [mA]",
  "if_pulse_max": "Maximum pulse current [mA]",
  "vr_max": "Maximum reverse voltage [V]",
  "pd_max": "Maximum power dissipation [W]",
  "power_nominal": "Nominal power (Vf × If) [W]",
  "esd_hbm": "ESD rating HBM [V]",

  "flux_typ": "Luminous flux typical [lm]",
  "flux_min": "Luminous flux minimum [lm]",
  "flux_max": "Luminous flux maximum [lm]",
  "flux_test_current_ma": "Test current for flux measurement [mA]",
  "efficacy": "Luminous efficacy [lm/W]",
  "cct_k": "Correlated color temperature [K] (integer)",
  "cct_options": "Available CCT options as comma-separated string, e.g. '2700,3000,3500,4000,5000,6500'",
  "cri_ra": "CRI Ra value",
  "cri_r9": "R9 value",
  "cri_min": "Minimum CRI (from binning)",
  "viewing_angle": "Half-intensity angle 2θ½ [degrees]",
  "dom_wavelength": "Dominant wavelength [nm]",
  "dom_wavelength_min": "Dominant wavelength min [nm]",
  "dom_wavelength_max": "Dominant wavelength max [nm]",
  "peak_wavelength": "Peak wavelength [nm]",
  "sdcm": "MacAdam ellipse steps (SDCM)",
  "spectrum_type": "e.g. Phosphor-converted white, Direct color, Full spectrum",

  "package_type": "Package designation, e.g. 5630, 3030, 2835, COB",
  "package_standard": "e.g. PLCC-2, PLCC-4, Chip-on-Board",
  "dim_l_mm": "Length [mm]",
  "dim_w_mm": "Width [mm]",
  "dim_h_mm": "Height [mm]",
  "lens_type": "Lens material/type, e.g. Silicone, Glass, Molded",
  "lead_type": "Lead/terminal type, e.g. SMD, Through-hole, Solder pad",
  "weight_g": "Weight [g]",
  "marking": "Top marking on the component",

  "rth_js": "Thermal resistance junction-solder [K/W]",
  "rth_ja": "Thermal resistance junction-ambient [K/W]",
  "tj_max": "Maximum junction temperature [°C]",
  "tj_typ": "Typical operating junction temperature [°C]",
  "ts_max": "Maximum solder point temperature [°C]",
  "ta_range_min": "Operating ambient temperature min [°C]",
  "ta_range_max": "Operating ambient temperature max [°C]",
  "storage_temp_min": "Storage temperature min [°C]",
  "storage_temp_max": "Storage temperature max [°C]",
  "reflow_profile": "Reflow soldering profile, e.g. 'JEDEC J-STD-020' or peak temp",
  "moisture_sensitivity": "MSL level, e.g. 'MSL 3'",

  "lifetime_l70_hours": "L70 lifetime at reference conditions [hours]",
  "lifetime_test_temp_c": "Temperature for L70 test [°C]",
  "lifetime_test_current_ma": "Current for L70 test [mA]",

  "rohs_compliant": "true/false/null",
  "reach_compliant": "true/false/null",
  "aec_q102": "AEC-Q102 qualified: true/false/null",
  "ul_listed": "UL listed: true/false/null",

  "datasheet_revision": "Datasheet version/revision if shown",
  "datasheet_date": "Datasheet date if shown",

  "confidence": "0.0-1.0 – how confident are you this is the correct datasheet for the requested product?"
}

Respond with ONLY the JSON object. No explanation, no markdown fences.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } }, { type: "text", text: prompt }] }] }),
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
      if (val !== null && val !== undefined && val !== "") {
        // Convert numeric strings to numbers where appropriate
        if (typeof val === "string" && /^-?\d+\.?\d*$/.test(val.trim())) {
          article[key] = parseFloat(val);
        } else if (typeof val === "boolean" || typeof val === "number") {
          article[key] = val;
        } else {
          article[key] = val;
        }
        fieldCount++;
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
