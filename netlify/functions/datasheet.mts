import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return Response.json({ error: "id erforderlich" }, { status: 400 });

  const dsStore = getStore({ name: "datasheets", consistency: "strong" });
  const pdf = await dsStore.get(id, { type: "blob" });

  if (!pdf) return Response.json({ error: "Datenblatt nicht gefunden" }, { status: 404 });

  return new Response(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${id}.pdf"`,
    },
  });
};

export const config: Config = {
  path: "/api/datasheet",
};
