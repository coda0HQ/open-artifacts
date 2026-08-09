import { type APIRequestContext, expect, test } from "@playwright/test";

const authorization = { authorization: "Bearer sk_e2e" };

interface CreatedArtifact {
  id: string;
  version: number;
}

async function createArtifact(
  request: APIRequestContext,
): Promise<CreatedArtifact> {
  const response = await request.post("/api/artifacts", {
    headers: authorization,
    data: {
      title: "Live collaboration E2E",
      favicon: "📝",
      format: "html",
      content: '<main><h1 id="version-title">Published v1</h1></main>',
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as CreatedArtifact;
}

const saveDraft = (
  request: APIRequestContext,
  artifactId: string,
  expectedRevision: number,
  baseVersion: number,
  content: string,
) =>
  request.put(`/api/artifacts/${artifactId}/live/draft`, {
    headers: authorization,
    data: {
      protocolVersion: 1,
      expectedRevision,
      baseVersion,
      format: "html",
      content,
    },
  });

test("two editors conflict, reconnect recovers the Draft, and Checkpoint is immutable", async ({
  page,
  request,
}) => {
  const artifact = await createArtifact(request);
  const editorContents = [
    '<main><h1 id="version-title">Editor A Draft</h1></main>',
    '<main><h1 id="version-title">Editor B Draft</h1></main>',
  ];

  const attempts = await Promise.all(
    editorContents.map((content) =>
      saveDraft(request, artifact.id, 0, 1, content),
    ),
  );
  expect(attempts.map((response) => response.status()).sort()).toEqual([
    200, 409,
  ]);
  const winningIndex = attempts.findIndex(
    (response) => response.status() === 200,
  );
  const winningContent = editorContents[winningIndex];
  const losing = attempts.find((response) => response.status() === 409);
  expect(await losing?.json()).toMatchObject({
    code: "REVISION_CONFLICT",
    currentRevision: 1,
  });

  await page.goto(`/a/${artifact.id}`);
  await page.locator(".oa-live-toggle").click();
  await expect(page.locator("#oa-live-publication-label")).toHaveText(
    "Unsaved Draft r1",
  );
  await expect(page.locator("#oa-live-publication-detail")).toHaveText(
    "Based on published v1",
  );
  await expect(page.locator("#oa-live-checkpoint")).toBeVisible();

  // Closing the WebSocket and reloading reconstructs the state from Durable
  // Object storage; the draft is not merely an in-memory browser state.
  await page.locator("#oa-live-exit").click();
  await page.reload();
  await page.locator(".oa-live-toggle").click();
  await expect(page.locator("#oa-live-publication-label")).toHaveText(
    "Unsaved Draft r1",
  );

  await page.locator("#oa-live-checkpoint").click();
  await expect(page.locator("#oa-live-publication-label")).toHaveText(
    "Published v2",
  );
  await expect(page.locator("#oa-live-publication")).toBeFocused();
  await expect(
    page.frameLocator("#oa-frame").locator("#version-title"),
  ).toContainText(winningIndex === 0 ? "Editor A Draft" : "Editor B Draft");

  const historicalV1 = await request.get(
    `/api/artifacts/${artifact.id}/raw?v=1`,
  );
  expect(await historicalV1.text()).toContain("Published v1");
  const historicalV2 = await request.get(
    `/api/artifacts/${artifact.id}/raw?v=2`,
  );
  expect(await historicalV2.text()).toBe(winningContent);

  const secondDraft = '<main><h1 id="version-title">Preserve me</h1></main>';
  expect(
    (await saveDraft(request, artifact.id, 1, 2, secondDraft)).status(),
  ).toBe(200);
  const ordinary = await request.put(`/api/artifacts/${artifact.id}`, {
    headers: authorization,
    data: {
      baseVersion: 2,
      content: '<main><h1 id="version-title">Ordinary v3</h1></main>',
    },
  });
  expect(ordinary.status()).toBe(200);
  const staleCheckpoint = await request.post(
    `/api/artifacts/${artifact.id}/live/checkpoint`,
    {
      headers: {
        ...authorization,
        "idempotency-key": `e2e-stale-checkpoint-${artifact.id}`,
      },
      data: { protocolVersion: 1, expectedRevision: 2 },
    },
  );
  expect(staleCheckpoint.status()).toBe(409);
  expect(await staleCheckpoint.json()).toMatchObject({
    code: "CHECKPOINT_CONFLICT",
    currentVersion: 3,
  });

  await page.reload();
  await page.locator(".oa-live-toggle").click();
  await expect(page.locator("#oa-live-publication-label")).toHaveText(
    "Conflict — Draft r2 preserved",
  );
  await expect(page.locator("#oa-live-checkpoint")).toBeHidden();
  const preserved = await request.get(
    `/api/artifacts/${artifact.id}/live/draft`,
    { headers: authorization },
  );
  expect(await preserved.json()).toMatchObject({
    draft: { state: "conflict", payload: { content: secondDraft } },
  });
  expect(
    await (await request.get(`/api/artifacts/${artifact.id}/raw?v=2`)).text(),
  ).toBe(winningContent);
});
