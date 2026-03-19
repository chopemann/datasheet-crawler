import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

function getArticleStore() {
  return getStore({ name: "articles", consistency: "strong" });
}
function getDatasheetStore() {
  return getStore({ name: "datasheets", consistency: "strong" });
}

// -------------------------------------------------------------------
// 1. SEARCH: Ask AI to find the datasheet URL
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
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return { url: null, error: `API-Fehler ${response.status}: ${err}` };
    }

    const data = await response.json();

    // Extract text from response (may have multiple content blocks due to tool use)
    const textBlocks = data.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") || "";

    // Try to parse JSON from response
    const jsonMatch = textBlocks.match(/\{[\s\S]*?"datasheet_url"[\s\S]*?\}/);
    if (jsonMatch) {
      try {
        const result = JSON.parse(jsonMatch[0]);
        return { url: result.datasheet_url, error: null };
      } catch {
        return { url: null, error: "JSON-Parsing fehlgeschlagen: " + textBlocks.slice(0, 200) };
      }
    }

    // Fallback: look for any URL in the response
    const urlMatch = textBlocks.match(/https?:\/\/[^\s"'<>]+\.pdf[^\s"'<>]*/i);
    if (urlMatch) {
      return { url: urlMatch[0], error: null };
    }

    return { url: null, error: "Kein Datenblatt gefunden. KI-Antwort: " + textBlocks.slice(0, 300) };
  } catch (e: any) {
    return { url: null, error: `Suche fehlgeschlagen: ${e.message}` };
  }
}

// -------------------------------------------------------------------
// 2. DOWNLOAD: Fetch the PDF
// -------------------------------------------------------------------
async function downloadPdf(url: string): Promise<{ buffer: ArrayBuffer | null; error: string | null }> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 LUMITRONIX-Crawler/1.0" },
      redirect: "follow",
    });
    if (!resp.ok) return { buffer: null, error: `Download fehlgeschlagen: HTTP ${resp.status}` };
    const contentType = resp.headers.get("content-type") || "";
    // Accept PDF or octet-stream
    if (!contentType.includes("pdf") && !contentType.includes("octet-stream") && !url.toLowerCase().includes(".pdf")) {
      return { buffer: null, error: `Kein PDF: Content-Type ist ${contentType}` };
    }
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength < 500) return { buffer: null, error: "Datei zu klein, vermutlich kein gültiges PDF" };
    return { buffer, error: null };
  } catch (e: any) {
    return { buffer: null, error: `Download-Fehler: ${e.message}` };
  }
}

// -------------------------------------------------------------------
// 3. EXTRACT: Send PDF to AI and extract structured data
// -------------------------------------------------------------------
async function extractFromPdf(pdfBase64: string, article: any, apiKey: string, model: string): Promise<{ specs: any; confidence: number; error: string | null }> {
  const prompt = `Du bist ein LED-Datenblatt-Analysator. Lies das angehängte Datenblatt und extrahiere alle technischen Spezifikationen.

Gesucht wird: ${article.manufacturer} ${article.manufacturer_sku || article.product_name}

Extrahiere folgende Werte und gib sie als JSON zurück. Nutze NULL wenn ein Wert nicht im Datenblatt steht. Einheiten NICHT in die Werte schreiben, nur die Zahl.

{
  "product_name": "string – voller Produktname aus dem Datenblatt",
  "product_status": "Active|Preview|NRND|EOL|Obsolete oder null",
  "vf_typ": "Forward Voltage typisch in V",
  "vf_min": "Forward Voltage min in V",
  "vf_max": "Forward Voltage max in V",
  "if_typ": "Forward Current typisch in mA",
  "if_max": "Forward Current absolut max in mA",
  "vr_max": "Reverse Voltage max in V",
  "pd_max": "Max. Verlustleistung in W",
  "power_nominal": "Nennleistung in W",
  "flux_typ": "Lichtstrom typisch in lm",
  "flux_min": "Lichtstrom Minimum in lm",
  "efficacy": "Lichtausbeute in lm/W",
  "cct_k": "Farbtemperatur in Kelvin (ganzzahlig)",
  "cri_ra": "CRI Ra",
  "cri_r9": "R9-Wert",
  "viewing_angle": "Abstrahlwinkel 2θ½ in Grad",
  "dom_wavelength": "Dominante Wellenlänge in nm",
  "peak_wavelength": "Peak-Wellenlänge in nm",
  "sdcm": "MacAdam-Stufe",
  "package_type": "Package-Bezeichnung z.B. 5630, 3030, COB",
  "dim_l_mm": "Länge in mm",
  "dim_w_mm": "Breite in mm",
  "dim_h_mm": "Höhe in mm",
  "rth_js": "Thermischer Widerstand Junction-Solder in K/W",
  "tj_max": "Max. Junction-Temperatur in °C",
  "ts_max": "Max. Lötpunkt-Temperatur in °C",
  "weight_g": "Gewicht in g",
  "confidence": "0.0-1.0 – wie sicher bist du, dass dies das richtige Datenblatt ist?"
}

Antworte NUR mit dem JSON-Objekt. Keine Erklärung.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 2048,
        messages: [{
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
            },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return { specs: {}, confidence: 0, error: `Extraktions-API-Fehler ${response.status}: ${err}` };
    }

    const data = await response.json();
    const text = data.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") || "";

    // Parse JSON
    const jsonMatch = text.match(/\{[\s\S]+\}/);
    if (!jsonMatch) {
      return { specs: {}, confidence: 0, error: "Keine JSON-Antwort: " + text.slice(0, 200) };
    }

    const cleaned = jsonMatch[0].replace(/```json|```/g, "").trim();
    const specs = JSON.parse(cleaned);
    const confidence = typeof specs.confidence === "number" ? specs.confidence : 0.5;
    delete specs.confidence;

    return { specs, confidence, error: null };
  } catch (e: any) {
    return { specs: {}, confidence: 0, error: `Extraktion fehlgeschlagen: ${e.message}` };
  }
}

// -------------------------------------------------------------------
// MAIN: Background function entry point
// -------------------------------------------------------------------
export default async (req: Request, context: Context) => {
  const body = await req.json();
  const articleId = body.article_id;
  if (!articleId) return; // Background functions return 202 anyway

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY nicht konfiguriert");
    return;
  }

  // Model selection: default to Claude Sonnet
  const model = body.ai_model || "claude-sonnet-4-20250514";

  const store = getArticleStore();
  const dsStore = getDatasheetStore();

  // Load article
  const article = await store.get(articleId, { type: "json" });
  if (!article) {
    console.error("Artikel nicht gefunden:", articleId);
    return;
  }

  // Update status to "searching"
  article.crawl_status = "searching";
  article.ai_model_used = model;
  article.updated_at = new Date().toISOString();
  await store.setJSON(articleId, article);

  // === STEP 1: Search for datasheet ===
  console.log(`[Crawl] Suche Datenblatt für ${article.manufacturer} ${article.manufacturer_sku}`);
  const searchResult = await searchDatasheet(article, apiKey, model);

  if (!searchResult.url) {
    article.crawl_status = "failed";
    article.retry_count = (article.retry_count || 0) + 1;
    article.error_log = searchResult.error || "Kein Datenblatt gefunden";
    article.crawled_at = new Date().toISOString();
    article.updated_at = new Date().toISOString();
    await store.setJSON(articleId, article);
    console.log(`[Crawl] Fehlgeschlagen: ${searchResult.error}`);
    return;
  }

  console.log(`[Crawl] URL gefunden: ${searchResult.url}`);
  article.datasheet_url = searchResult.url;
  await store.setJSON(articleId, article);

  // === STEP 2: Download PDF ===
  const dlResult = await downloadPdf(searchResult.url);

  if (!dlResult.buffer) {
    // URL found but PDF download failed – still save URL
    article.crawl_status = "found";
    article.ai_confidence = 0.3;
    article.error_log = dlResult.error || "PDF-Download fehlgeschlagen";
    article.crawled_at = new Date().toISOString();
    article.updated_at = new Date().toISOString();
    await store.setJSON(articleId, article);
    console.log(`[Crawl] Download fehlgeschlagen: ${dlResult.error}`);
    return;
  }

  // Save PDF to blob storage
  const pdfBlob = new Blob([dlResult.buffer], { type: "application/pdf" });
  await dsStore.set(articleId, pdfBlob);
  article.datasheet_path = `datasheets/${articleId}`;
  console.log(`[Crawl] PDF gespeichert (${Math.round(dlResult.buffer.byteLength / 1024)} KB)`);

  // === STEP 3: Extract data from PDF ===
  const pdfBase64 = bufferToBase64(dlResult.buffer);
  const extractResult = await extractFromPdf(pdfBase64, article, apiKey, model);

  if (extractResult.error && !extractResult.specs) {
    article.crawl_status = "found";
    article.ai_confidence = 0.3;
    article.error_log = extractResult.error;
  } else {
    // Merge extracted specs into article
    const specs = extractResult.specs;
    for (const [key, val] of Object.entries(specs)) {
      if (val !== null && val !== undefined && val !== "" && key in article) {
        // Convert numeric strings to numbers
        const numVal = typeof val === "string" ? parseFloat(val) : val;
        if (typeof article[key] === "object" || article[key] === null) {
          article[key] = isNaN(numVal as number) ? val : numVal;
        }
      }
    }
    article.crawl_status = "found";
    article.ai_confidence = extractResult.confidence;
    article.error_log = extractResult.error || null;
  }

  article.crawled_at = new Date().toISOString();
  article.updated_at = new Date().toISOString();
  await store.setJSON(articleId, article);
  console.log(`[Crawl] Fertig! Konfidenz: ${article.ai_confidence}`);
};

export const config: Config = {
  path: "/api/crawl",
};

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
