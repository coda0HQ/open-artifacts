import { type APIRequestContext, expect, test } from "@playwright/test";

interface CreatedArtifact {
  id: string;
  writeToken: string;
}

async function create(
  request: APIRequestContext,
  body: Record<string, unknown>,
): Promise<CreatedArtifact> {
  const response = await request.post("/api/artifacts", {
    data: { title: "Viewer behavior", favicon: "🔬", ...body },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as CreatedArtifact;
}

const toBase64 = (value: ArrayBuffer | Uint8Array): string =>
  Buffer.from(
    value instanceof Uint8Array ? value : new Uint8Array(value),
  ).toString("base64");

async function encrypt(plaintext: string, password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = 10_000;
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    content: toBase64(ciphertext),
    encrypted: {
      salt: toBase64(salt),
      iv: toBase64(iv),
      iterations,
    },
  };
}

test("version picker navigates snapshots and the theme bridge updates the frame", async ({
  page,
  request,
}) => {
  const artifact = await create(request, {
    content: '<main><h1 id="snapshot">Snapshot v1</h1></main>',
  });
  const updated = await request.put(`/api/artifacts/${artifact.id}`, {
    headers: { authorization: `Bearer ${artifact.writeToken}` },
    data: {
      baseVersion: 1,
      content: '<main><h1 id="snapshot">Snapshot v2</h1></main>',
    },
  });
  expect(updated.status()).toBe(200);

  await page.goto(`/a/${artifact.id}`);
  const picker = page.locator("#oa-version-select");
  await expect(picker).toHaveValue(/v=2$/);
  await picker.selectOption({ label: "v1" });
  await expect(page).toHaveURL(new RegExp(`/a/${artifact.id}\\?v=1$`));
  await expect(page.frameLocator("#oa-frame").locator("#snapshot")).toHaveText(
    "Snapshot v1",
  );

  const before = await page.locator("html").getAttribute("data-theme");
  await page.locator("#oa-theme-toggle").click();
  const after = before === "dark" ? "light" : "dark";
  await expect(page.locator("html")).toHaveAttribute("data-theme", after);
  await expect(page.frameLocator("#oa-frame").locator("html")).toHaveAttribute(
    "data-theme",
    after,
  );
});

test("comment resolution and filters update the actual drawer DOM", async ({
  page,
  request,
}) => {
  const artifact = await create(request, {
    content: '<main id="comment-target">Comments target text</main>',
  });

  await page.goto(`/a/${artifact.id}`);
  const frame = page.frameLocator("#oa-frame");
  await frame.locator("#comment-target").evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await frame.locator(".oa-cm-sel").click();
  await page.locator(".oa-cm-body").fill("Resolve this behavior test");
  await page.locator(".oa-cm-name").fill("Playwright");
  await page.locator(".oa-cm-send").click();

  await page.locator(".oa-cm-toggle").click();
  const item = page.locator(".oa-cm-item", {
    hasText: "Resolve this behavior test",
  });
  await expect(item).toBeVisible();
  await item.locator(".oa-cm-done").click();
  await expect(item).toBeHidden();
  await expect(page.locator("#oa-cm-head-count")).toHaveText("0");

  await page.locator(".oa-cm-filter-btn").click();
  await page.locator('[data-filter="done"]').click();
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute("data-done", "");
  await expect(item.locator(".oa-cm-done")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("password shell keeps focus, backs off failures, and decrypts into the sandbox", async ({
  page,
  request,
}) => {
  const password = "correct horse battery";
  const envelope = await encrypt(
    '<main><h1 id="secret-title">Decrypted safely</h1></main>',
    password,
  );
  const artifact = await create(request, envelope);

  await page.goto(`/a/${artifact.id}`);
  const input = page.locator("#oa-password");
  await expect(input).toBeFocused();
  await input.fill("wrong password");
  await page.locator("#oa-submit").click();
  await expect(page.locator("#oa-error")).toHaveText(
    "Password incorrect. Check it and try again.",
  );
  await expect(page.locator("#oa-submit")).toBeDisabled();
  await expect(page.locator("#oa-submit")).toBeEnabled({ timeout: 2_000 });

  await input.fill(password);
  await page.locator("#oa-submit").click();
  await expect(page.locator(".oa-unlock")).toBeHidden();
  await expect(
    page.frameLocator("#oa-frame").locator("#secret-title"),
  ).toHaveText("Decrypted safely");
});

test("Live Draft controls remain keyboard-usable at 360px in both themes and reduced motion", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const artifact = await create(request, {
    content: "<main><h1>Accessible published version</h1></main>",
  });
  const draft = await request.put(`/api/artifacts/${artifact.id}/live/draft`, {
    data: {
      protocolVersion: 1,
      expectedRevision: 0,
      baseVersion: 1,
      content: "<main><h1>Accessible Draft</h1></main>",
    },
  });
  expect(draft.status()).toBe(200);

  await page.goto(`/a/${artifact.id}`);
  const overflow = page.locator("#oa-header-more");
  await overflow.focus();
  await page.keyboard.press("Enter");
  await expect(overflow).toHaveAttribute("aria-expanded", "true");
  const toggle = page.locator(".oa-live-toggle");
  await expect(toggle).toBeVisible();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const checkpoint = page.locator("#oa-live-checkpoint");
  await expect(checkpoint).toBeVisible();
  await checkpoint.focus();
  await expect(checkpoint).toBeFocused();
  const bounds = await checkpoint.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.x ?? 0).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(360);
  expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(44);

  const contrast = async (theme: "light" | "dark") => {
    await page.locator("html").evaluate((element, value) => {
      element.setAttribute("data-theme", value);
    }, theme);
    return page.locator("#oa-live-publication-label").evaluate((element) => {
      const parse = (value: string) =>
        (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const luminance = (rgb: number[]) => {
        const channels = rgb.map((value) => {
          const normalized = value / 255;
          return normalized <= 0.03928
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return (
          0.2126 * (channels[0] ?? 0) +
          0.7152 * (channels[1] ?? 0) +
          0.0722 * (channels[2] ?? 0)
        );
      };
      const foreground = luminance(parse(getComputedStyle(element).color));
      const background = luminance(
        parse(
          getComputedStyle(element.parentElement?.parentElement ?? element)
            .backgroundColor,
        ),
      );
      return (
        (Math.max(foreground, background) + 0.05) /
        (Math.min(foreground, background) + 0.05)
      );
    });
  };
  expect(await contrast("light")).toBeGreaterThanOrEqual(4.5);
  expect(await contrast("dark")).toBeGreaterThanOrEqual(4.5);

  const animationName = await page
    .locator("#oa-live-status")
    .evaluate((status) => {
      const spinner = document.createElement("span");
      spinner.className = "oa-live-spin";
      status.appendChild(spinner);
      return getComputedStyle(spinner).animationName;
    });
  expect(animationName).toBe("none");
});
