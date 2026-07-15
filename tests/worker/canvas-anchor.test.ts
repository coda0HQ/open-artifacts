import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { screenToWorld } from "../../src/anchor";

describe("screenToWorld", () => {
  it("inverts the plane transform to world coordinates", () => {
    // plane transform matrix(2,0,0,2,100,40): k=2, tx=100, ty=40.
    // A click at client (300,240) over a plane at the viewport origin → (100,100).
    expect(screenToWorld(300, 240, { left: 0, top: 0 }, 2, 100, 40)).toEqual({
      x: 100,
      y: 100,
    });
  });

  it("returns the same world point regardless of zoom", () => {
    // World (50,50) sits at screen 150 when k=1 and at screen 300 when k=4
    // (tx=ty=100); inverting each recovers the same world coordinates.
    expect(screenToWorld(150, 150, { left: 0, top: 0 }, 1, 100, 100)).toEqual({
      x: 50,
      y: 50,
    });
    expect(screenToWorld(300, 300, { left: 0, top: 0 }, 4, 100, 100)).toEqual({
      x: 50,
      y: 50,
    });
  });
});

describe("frame document carries the canvas pin runtime", () => {
  it("includes the counter-scaled pin CSS and the anchor render hook", async () => {
    const created = await exports.default.fetch(
      new Request("http://artifacts.test/api/artifacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "<h1>x</h1>",
          title: "Canvas",
          favicon: "📊",
        }),
      }),
    );
    const { id } = (await created.json()) as { id: string };
    const html = await (
      await exports.default.fetch(`http://artifacts.test/a/${id}/frame`)
    ).text();
    expect(html).toContain(".oa-cm-pin");
    expect(html).toContain("scale(calc(1/var(--k,1))) translate(-50%,-50%)");
    expect(html).toContain("__oaRenderMarkers");
  });
});
