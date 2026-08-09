import { type APIRequestContext, expect, test } from "@playwright/test";

const authorization = { authorization: "Bearer sk_e2e" };

interface CreateResult {
  id: string;
  liveSupported: boolean;
}

interface LiveEvent {
  id: string;
  type: string;
  items?: Array<{ id?: string }>;
}

interface LiveStatus {
  pendingEvents: LiveEvent[];
}

async function createArtifact(
  request: APIRequestContext,
): Promise<CreateResult> {
  const response = await request.post("/api/artifacts", {
    headers: authorization,
    data: {
      title: "Playwright Live Artifact",
      favicon: "🧪",
      format: "html",
      content:
        '<main class="oa-prose"><h1 id="e2e-title">E2E Live Artifact</h1><p>The quick brown fox.</p></main>',
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as CreateResult;
}

async function liveStatus(
  request: APIRequestContext,
  artifactId: string,
): Promise<LiveStatus> {
  const response = await request.get(
    `/api/artifacts/${artifactId}/live/status`,
    { headers: authorization },
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as LiveStatus;
}

test("a real browser stages and applies an inline copy edit", async ({
  page,
  request,
}) => {
  const artifact = await createArtifact(request);
  expect(artifact.liveSupported).toBe(true);

  const heartbeat = await request.post(
    `/api/artifacts/${artifact.id}/live/heartbeat`,
    { headers: authorization },
  );
  expect(heartbeat.status()).toBe(200);

  await page.goto(`/a/${artifact.id}`);
  const liveToggle = page.locator(".oa-live-toggle");
  await expect(liveToggle).toBeVisible();
  await expect(page.locator("[data-live-connection]")).toHaveText("Connected");
  await liveToggle.click();
  await expect(liveToggle).toHaveAttribute("aria-expanded", "true");

  const frame = page.frameLocator("#oa-frame");
  await frame.locator("#e2e-title").click();
  await expect(page.locator(".oa-live-freeform")).toBeVisible();
  await page.locator(".oa-live-edit-chip").click();

  const editable = frame.locator('[contenteditable="true"]').first();
  await expect(editable).toBeVisible();
  await editable.fill("E2E EDITED TITLE");
  await page
    .locator("#oa-live-action-bar .oa-dock-btn--primary")
    .filter({ hasText: "Save" })
    .click();

  const apply = page.locator("#oa-live-apply");
  const label = apply.locator(".oa-dock-label");
  await expect(label).toHaveText("Apply copy edits (1)");
  await apply.click();
  await expect(label).toHaveText("Confirm apply?");
  await apply.click();

  await expect
    .poll(async () => {
      const status = await liveStatus(request, artifact.id);
      return status.pendingEvents.filter((event) => event.type === "edit")
        .length;
    })
    .toBe(1);

  const status = await liveStatus(request, artifact.id);
  const edit = status.pendingEvents.find((event) => event.type === "edit");
  expect(edit).toBeDefined();

  const reply = await request.post(`/api/artifacts/${artifact.id}/live/reply`, {
    headers: authorization,
    data: {
      id: edit?.id,
      type: "done",
      status: "done",
      appliedEntryIds: (edit?.items ?? [])
        .map((item) => item.id)
        .filter(Boolean),
      failed: [],
      files: ["e2e-fragments/body.html"],
      notes: ["Playwright copy edit applied"],
    },
  });
  expect(reply.status()).toBe(200);
  await expect(apply).toBeHidden();
});
