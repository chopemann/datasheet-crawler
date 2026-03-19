import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

function getArticleStore() {
  return getStore({ name: "articles", consistency: "strong" });
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default async (req: Request, context: Context) => {
  const store = getArticleStore();
  const url = new URL(req.url);
  const method = req.method;

  // GET /api/articles — list all
  if (method === "GET" && !url.searchParams.has("id")) {
    try {
      const { blobs } = await store.list();
      const articles: any[] = [];
      for (const blob of blobs) {
        const data = await store.get(blob.key, { type: "json" });
        if (data) articles.push(data);
      }
      // Sort by created_at descending
      articles.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      return Response.json({ articles, total: articles.length });
    } catch (e: any) {
      return Response.json({ articles: [], total: 0 });
    }
  }

  // GET /api/articles?id=xxx — get single
  if (method === "GET" && url.searchParams.has("id")) {
    const id = url.searchParams.get("id")!;
    const data = await store.get(id, { type: "json" });
    if (!data) return Response.json({ error: "Nicht gefunden" }, { status: 404 });
    return Response.json(data);
  }

  // POST /api/articles — create
  if (method === "POST") {
    const body = await req.json();
    if (!body.manufacturer || (!body.manufacturer_sku && !body.ean_gtin)) {
      return Response.json(
        { error: "Hersteller und mindestens SKU oder EAN erforderlich." },
        { status: 400 }
      );
    }

    const id = generateId();
    const now = new Date().toISOString();

    const article = {
      id,
      // Identification
      manufacturer: body.manufacturer || "",
      manufacturer_sku: body.manufacturer_sku || "",
      ean_gtin: body.ean_gtin || "",
      product_name: body.product_name || body.manufacturer_sku || body.ean_gtin || "",
      category: body.category || "",
      product_status: body.product_status || "",
      // Electrical
      vf_typ: null, vf_min: null, vf_max: null,
      if_typ: null, if_max: null,
      vr_max: null, pd_max: null, power_nominal: null,
      // Optical
      flux_typ: null, flux_min: null, efficacy: null,
      cct_k: null, cri_ra: null, cri_r9: null,
      viewing_angle: null, dom_wavelength: null, peak_wavelength: null, sdcm: null,
      // Thermal / Mechanical
      package_type: null, dim_l_mm: null, dim_w_mm: null, dim_h_mm: null,
      rth_js: null, tj_max: null, ts_max: null, weight_g: null,
      // Crawl status
      crawl_status: "queued",
      datasheet_url: null,
      datasheet_path: null,
      ai_model_used: null,
      ai_confidence: null,
      crawled_at: null,
      retry_count: 0,
      error_log: null,
      // Meta
      notes: body.notes || "",
      tags: body.tags || [],
      created_at: now,
      updated_at: now,
      created_by: body.created_by || "system",
    };

    await store.setJSON(id, article);
    return Response.json(article, { status: 201 });
  }

  // PATCH /api/articles?id=xxx — update
  if (method === "PATCH" && url.searchParams.has("id")) {
    const id = url.searchParams.get("id")!;
    const existing = await store.get(id, { type: "json" });
    if (!existing) return Response.json({ error: "Nicht gefunden" }, { status: 404 });
    const body = await req.json();
    const updated = { ...existing, ...body, id, updated_at: new Date().toISOString() };
    await store.setJSON(id, updated);
    return Response.json(updated);
  }

  // DELETE /api/articles?id=xxx
  if (method === "DELETE" && url.searchParams.has("id")) {
    const id = url.searchParams.get("id")!;
    await store.delete(id);
    // Also delete datasheet blob if exists
    try {
      const dsStore = getStore({ name: "datasheets", consistency: "strong" });
      await dsStore.delete(id);
    } catch {}
    return Response.json({ deleted: true });
  }

  return Response.json({ error: "Methode nicht unterstützt" }, { status: 405 });
};

export const config: Config = {
  path: "/api/articles",
};
