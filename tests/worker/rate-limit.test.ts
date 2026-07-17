import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/api";
import { COMMENT_RATE_LIMIT } from "../../src/domain";
import app from "../../src/index";
import { D1R2Store } from "../../src/store";

const BASE = "http://artifacts.test";

interface CreateResult {
  id: string;
}

async function createArtifact(): Promise<CreateResult> {
  const res = await exports.default.fetch(
    new Request(`${BASE}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "<h1>Hello</h1>",
        title: "Rate Limited",
        favicon: "📊",
      }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as CreateResult;
}

// The bucket keys on CF-Connecting-IP. Cloudflare's edge always sets it in
// production; workerd does not, so each test names its own client and thereby
// gets an isolated bucket.
async function postComment(
  id: string,
  ip: string,
  body = "hi",
  bindings: Bindings = env,
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${BASE}/api/artifacts/${id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ body }),
    }),
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function exhaust(
  id: string,
  ip: string,
  bindings: Bindings = env,
): Promise<void> {
  for (let i = 0; i < COMMENT_RATE_LIMIT.capacity; i++) {
    const res = await postComment(id, ip, `filler ${i}`, bindings);
    expect(res.status).toBe(201);
  }
}

describe("POST /comments rate limit", () => {
  it("accepts a full bucket and rejects the next write with 429", async () => {
    const { id } = await createArtifact();
    await exhaust(id, "203.0.113.1");

    const res = await postComment(id, "203.0.113.1", "one too many");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);

    // Rejected before the write: the flood never reaches D1.
    const list = await exports.default.fetch(
      `${BASE}/api/artifacts/${id}/comments`,
    );
    const { comments } = (await list.json()) as {
      comments: { body: string }[];
    };
    expect(comments).toHaveLength(COMMENT_RATE_LIMIT.capacity);
    expect(comments.some((c) => c.body === "one too many")).toBe(false);
  });

  it("buckets each client separately", async () => {
    const { id } = await createArtifact();
    await exhaust(id, "203.0.113.2");
    expect((await postComment(id, "203.0.113.2")).status).toBe(429);
    expect((await postComment(id, "198.51.100.9")).status).toBe(201);
  });

  it("buckets each artifact separately", async () => {
    const a = await createArtifact();
    const b = await createArtifact();
    await exhaust(a.id, "203.0.113.3");
    expect((await postComment(a.id, "203.0.113.3")).status).toBe(429);
    expect((await postComment(b.id, "203.0.113.3")).status).toBe(201);
  });

  it("throttles on a gated instance too", async () => {
    // CREATE_TOKEN gates creation, not commenting; /comments stays open even
    // there, so the bucket is the only bound on a gated instance as well.
    const gated: Bindings = { ...env, CREATE_TOKEN: "sekret-create" };
    const { id } = await createArtifact();
    await exhaust(id, "203.0.113.4", gated);
    expect(
      (await postComment(id, "203.0.113.4", "blocked", gated)).status,
    ).toBe(429);
  });

  it("does not throttle reads", async () => {
    const { id } = await createArtifact();
    await exhaust(id, "203.0.113.5");
    expect((await postComment(id, "203.0.113.5")).status).toBe(429);
    const res = await exports.default.fetch(
      new Request(`${BASE}/api/artifacts/${id}/comments`, {
        headers: { "CF-Connecting-IP": "203.0.113.5" },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("host chrome comment panel", () => {
  it("gives a throttled viewer something they can act on", async () => {
    // The panel's own guards are UX, not security — the bucket is
    // authoritative — but 429 is the one failure a viewer can respond to, so
    // it must not surface as a bare status code. Asserted against the served
    // chrome, this suite's idiom for the inlined viewer script.
    const { id } = await createArtifact();
    const html = await (await exports.default.fetch(`${BASE}/a/${id}`)).text();
    expect(html).toContain(
      "Too many comments just now. Try again in a moment.",
    );
  });
});

// Refill and pruning are time-dependent, so they are driven at the store layer
// where `now` is injectable — the route reads the real clock.
describe("D1R2Store.consumeToken", () => {
  const rule = { capacity: 3, refillPerSecond: 0.05 };
  const store = () => new D1R2Store(env.DB, env.CONTENT);

  it("spends the bucket, then refuses at empty", async () => {
    const s = store();
    const now = 1_000_000;
    for (let i = 0; i < rule.capacity; i++) {
      const r = await s.consumeToken("spend", rule, now);
      expect(r.allowed).toBe(true);
    }
    expect((await s.consumeToken("spend", rule, now)).allowed).toBe(false);
  });

  it("refills one token per refill interval", async () => {
    const s = store();
    const now = 2_000_000;
    for (let i = 0; i < rule.capacity; i++) {
      await s.consumeToken("refill", rule, now);
    }
    expect((await s.consumeToken("refill", rule, now)).allowed).toBe(false);

    // One token accrues after 1/refillPerSecond seconds — and only one.
    const later = now + (1 / rule.refillPerSecond) * 1000;
    expect((await s.consumeToken("refill", rule, later)).allowed).toBe(true);
    expect((await s.consumeToken("refill", rule, later)).allowed).toBe(false);
  });

  it("never banks more than a full bucket while idle", async () => {
    const s = store();
    const now = 3_000_000;
    await s.consumeToken("clamp", rule, now); // 1 spent, 2 left

    // Idle for less than a full refill, so the row survives the prune and the
    // refill arithmetic — not a fresh row — is what answers. Unclamped it would
    // bank 2 + 50 * 0.05 = 4.5 tokens; the bucket only ever holds 3, so a
    // fourth consecutive write must still be refused.
    const later = now + 50_000;
    for (let i = 0; i < rule.capacity; i++) {
      expect((await s.consumeToken("clamp", rule, later)).allowed).toBe(true);
    }
    expect((await s.consumeToken("clamp", rule, later)).allowed).toBe(false);
  });

  it("lets exactly one concurrent spender take the last token", async () => {
    const s = store();
    const now = 5_000_000;
    for (let i = 0; i < rule.capacity - 1; i++) {
      await s.consumeToken("race", rule, now);
    }
    // One token left, eight racers, one clock: if refill-and-spend were a read
    // then a write, several would read the same balance and all pass. Spending
    // in a single atomic statement is what makes this exactly one.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => s.consumeToken("race", rule, now)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(1);
  });

  it("prunes rows that have sat idle past a full refill", async () => {
    const s = store();
    const now = 4_000_000;
    await s.consumeToken("stale", rule, now);

    // A full refill takes capacity/refillPerSecond seconds; past that the row
    // is indistinguishable from a fresh bucket and carries no state.
    const afterFullRefill =
      now + (rule.capacity / rule.refillPerSecond) * 1000 + 1000;
    await s.consumeToken("active", rule, afterFullRefill);

    const rows = await env.DB.prepare(
      "SELECT bucket_key FROM rate_limits WHERE bucket_key IN ('stale', 'active')",
    ).all<{ bucket_key: string }>();
    expect(rows.results.map((r) => r.bucket_key)).toEqual(["active"]);
  });
});
