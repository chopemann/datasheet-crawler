# LUMITRONIX Datenblatt-Crawler

KI-gestützter Webcrawler, der anhand von Hersteller-SKU, EAN und Herstellername automatisch Datenblätter findet, herunterlädt und strukturiert auswertet.

## Architektur

```
Frontend (Netlify Static)     → public/index.html
API-Endpunkte (Functions)     → netlify/functions/articles.mts
KI-Crawl (Background Fn)     → netlify/functions/crawl-background.mts
PDF-Auslieferung (Function)   → netlify/functions/datasheet.mts
Datenspeicher (Netlify Blobs) → articles + datasheets stores
```

## Deployment

### 1. Git-Repository erstellen

```bash
cd datasheet-crawler
git init
git add .
git commit -m "Initial: Datenblatt-Crawler v1"
```

Repository auf GitHub/GitLab pushen.

### 2. Netlify verbinden

1. [app.netlify.com](https://app.netlify.com) → "Add new site" → "Import an existing project"
2. Git-Provider auswählen und Repository verbinden
3. Build-Einstellungen werden automatisch aus `netlify.toml` gelesen:
   - **Publish directory:** `public`
   - **Functions directory:** `netlify/functions`

### 3. Umgebungsvariable setzen

In Netlify: **Site configuration → Environment variables → Add a variable**

| Variable | Wert | Beschreibung |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Dein Anthropic API Key |

**Wichtig:** Der Key muss `web_search` und `document`-Uploads unterstützen (Claude API mit diesen Features).

### 4. Fertig

Nach dem Deploy ist die App erreichbar unter: `https://dein-site-name.netlify.app`

## Funktionsweise

### Artikel anlegen
Hersteller + mindestens SKU oder EAN eingeben → "Hinzufügen & Suchen"

### KI-Crawl
1. **Suche:** Claude nutzt `web_search`, um das offizielle Datenblatt (PDF) zu finden
2. **Download:** PDF wird heruntergeladen und in Netlify Blobs gespeichert
3. **Extraktion:** Claude liest das PDF und extrahiert 30+ technische Spezifikationen als JSON
4. **Speicherung:** Strukturierte Daten werden in der Artikel-Datenbank gespeichert

### KI-Modell
Standard: Claude Sonnet 4. Einstellbar über die Einstellungen-Seite. Weitere Modelle (GPT-4o, Gemini) können in der Background Function ergänzt werden.

## Tabellenstruktur (46 Felder)

| Gruppe | Felder |
|---|---|
| Identifikation | id, manufacturer, manufacturer_sku, ean_gtin, product_name, category, product_status |
| Elektrisch | vf_typ/min/max, if_typ/max, vr_max, pd_max, power_nominal |
| Optisch | flux_typ/min, efficacy, cct_k, cri_ra, cri_r9, viewing_angle, dom/peak_wavelength, sdcm |
| Thermisch/Mechanisch | package_type, dim_l/w/h_mm, rth_js, tj_max, ts_max, weight_g |
| Crawl-Status | crawl_status, datasheet_url/path, ai_model_used, ai_confidence, crawled_at, retry_count, error_log |
| Metadaten | notes, tags, created_at, updated_at, created_by |

## Lokale Entwicklung

```bash
npm install
npx netlify dev
```

Öffnet `http://localhost:8888`. Netlify Functions und Blobs funktionieren lokal.

## Nächste Schritte (v2)

- CSV/Excel-Import für Massendaten
- Batch-Crawl mit Warteschlange
- Fabric Space als Backend für relationale Datenbank
- Vergleichsansicht für Produkt-Spezifikationen
- Export als XLSX/CSV
