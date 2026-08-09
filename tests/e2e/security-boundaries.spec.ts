import { type APIRequestContext, expect, test } from "@playwright/test";

interface CreatedArtifact {
  id: string;
  writeToken: string;
}

async function createArtifact(
  request: APIRequestContext,
  content = '<main><h1 id="safe-title">Safe artifact</h1></main>',
): Promise<CreatedArtifact> {
  const response = await request.post("/api/artifacts", {
    data: { content, title: "Security boundary", favicon: "📊" },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as CreatedArtifact;
}

test("forged frame messages cannot turn the host into a request proxy", async ({
  page,
  request,
}) => {
  const artifact = await createArtifact(request);
  const observed: string[] = [];
  page.on("request", (outgoing) => observed.push(outgoing.url()));
  await page.goto(`/a/${artifact.id}`);
  await expect(
    page.frameLocator("#oa-frame").locator("#safe-title"),
  ).toBeVisible();

  await page.evaluate(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: {
          type: "oa:anchor:new",
          url: "/api/artifacts/victim",
          method: "DELETE",
          headers: { authorization: "Bearer forged" },
        },
      }),
    );
  });
  await expect(page.locator("#oa-cm-compose")).toBeHidden();
  expect(observed.some((url) => url.includes("/api/artifacts/victim"))).toBe(
    false,
  );
});

test("stored comment markup stays inert in the real host DOM", async ({
  page,
  request,
}) => {
  const first = await createArtifact(request);
  const injection = '<img src=x onerror="window.__oaCommentPwned=1">';
  const comment = await request.post(`/api/artifacts/${first.id}/comments`, {
    data: { body: injection, author: "attacker" },
  });
  expect(comment.status()).toBe(201);

  await page.goto(`/a/${first.id}`);
  await page.locator(".oa-cm-toggle").click();
  await expect(
    page.locator(".oa-cm-title", { hasText: injection }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, "__oaCommentPwned")),
  ).toBeUndefined();
});
