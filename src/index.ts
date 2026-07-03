import { Hono } from "hono";
import type { AppContext } from "./api";
import { api, parseVersionParam, storeFrom } from "./api";
import {
  badVersionPage,
  notFoundPage,
  unlockShell,
  userContentHeaders,
  wrapDocument,
} from "./wrap";

const app = new Hono<AppContext>();

app.route("/api", api);

app.get("/a/:id", async (c) => {
  const store = storeFrom(c);
  const record = await store.get(c.req.param("id"));
  const htmlHeaders = (sandbox: boolean) =>
    userContentHeaders({ sandbox, contentType: "text/html; charset=utf-8" });

  if (record === null) {
    return new Response(notFoundPage(), {
      status: 404,
      headers: htmlHeaders(true),
    });
  }

  const version = parseVersionParam(c.req.query("v"), record.currentVersion);
  if (typeof version !== "number") {
    const page = version.status === 400 ? badVersionPage() : notFoundPage();
    return new Response(page, {
      status: version.status,
      headers: htmlHeaders(true),
    });
  }

  const content = await store.getContent(record.id, version);
  if (content === null) {
    return new Response(notFoundPage(), {
      status: 404,
      headers: htmlHeaders(true),
    });
  }

  if (content.encrypted !== null) {
    const page = unlockShell({
      title: record.title,
      favicon: record.favicon,
      format: record.format,
      envelope: { ...content.encrypted, ciphertext: content.body },
    });
    return new Response(page, { headers: htmlHeaders(false) });
  }

  const page = wrapDocument({
    title: record.title,
    favicon: record.favicon,
    format: record.format,
    content: content.body,
  });
  return new Response(page, { headers: htmlHeaders(true) });
});

app.get("/health", (c) => c.json({ ok: true }));

export default app;
