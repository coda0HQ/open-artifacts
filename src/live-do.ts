import { DurableObject } from "cloudflare:workers";
import { D1QuotaLedger } from "./adapters/cloudflare/d1-quota-ledger";
import { DurableObjectRealtimeStore } from "./adapters/cloudflare/durable-object-realtime";
import type { Bindings } from "./api";
import { DraftService, type SaveDraftInput } from "./live/draft-service";
import type { LiveDraft } from "./ports/realtime-session-store";
import { Telemetry } from "./telemetry";

export interface LiveTrace {
  requestId: string;
  traceId: string;
  actorId: string;
  startedAt: string;
}

// LiveObject — the per-artifact coordination point for live editing.
//
// One LiveObject instance per artifact id (keyed by getByName(artifactId)). It
// holds the WebSocket channel to the viewing browser (host chrome, outside the
// sandboxed iframe) and the long-poll queue the authoring agent CLI drains.
//
// The three-party loop (one-shot edit-and-reload):
//   Browser (host) ── ws.send(generate/exit) ──▶ LiveObject
//   Agent (CLI)    ── rpc.poll()  ──▶ drains pendingEvents (blocks)
//   Agent          ◀── rpc.poll() returns one event (generate/comment/exit)
//   Agent          ── rpc.reply(id, ack)  ──▶ LiveObject broadcasts ack
//   Agent          ── rpc.reply(id, done) ──▶ LiveObject broadcasts done
//   LiveObject     ── ws.send(ack/done) ──▶ Browser (broadcasts)
//
// Persistence: the pending queue lives in the DO's SQLite storage
// (ctx.storage), so events survive hibernation. A user who submits `generate`
// while no agent is polling won't lose the event — it sits in SQLite until the
// agent connects or the entry ages out (GC). waiters and nextSeq stay
// in-memory (a missed wake after hibernation just means the agent re-polls).
//
// Hibernatable WebSockets: acceptWebSocket keeps the DO cheap when idle; a
// message wakes it. webSocketMessage/webSocketClose are the hibernation handlers.

export type LiveEvent = {
  type:
    | "generate"
    | "exit"
    | "comment"
    | "ack"
    | "done"
    | "error"
    | "edit"
    | "version";
  id: string;
  /** Best-effort base64 data-URL PNG of the picked content; omitted when capture fails. */
  screenshot?: string;
  [key: string]: unknown;
};

// Priority: terminal user actions first (a late exit shouldn't sit behind a
// generate), then an inline edit commit (the user's immediate curation
// action), then generate (a background described-change), then everything
// else. `generate` was demoted from 1 to 2 when `edit` was added — an edit
// the user just committed must beat an older generate still in flight.
function eventPriority(type: LiveEvent["type"]): number {
  if (type === "exit") return 0;
  if (type === "edit") return 1;
  if (type === "generate") return 2;
  return 3;
}

type QueueRow = {
  id: string;
  type: string;
  payload: string; // JSON
  seq: number;
  leased_until: number;
  created_at: number;
};

type PollWaiter = {
  resolve: (e: LiveEvent | { type: "timeout" }) => void;
  types: Set<LiveEvent["type"]> | null; // null = any
  skip: Set<string>; // event ids this poller must not be offered
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_POLL_TIMEOUT_MS = 270_000; // under undici's 300s header ceiling
const LEASE_MS = 30_000; // a poll holds an event for 30s before re-offering it
const GC_AGE_MS = 3600_000; // drop undelivered events after 1h
// Staged copy edits age out after a day. They differ from pending events: a
// stash is the user's curated work, kept across reloads for the whole session
// (an Apply can happen minutes after the last Save), so a 1h GC would drop
// it mid-flow — but a forgotten draft must not live forever either. The sweep
// rides the enqueue GC so no separate alarm wakes the DO.
const STASH_GC_AGE_MS = 86_400_000;
// A watcher heartbeats roughly every 20s; an agent that has not been seen
// within this window is treated as offline (the viewer's Connected indicator clears).
const AGENT_ACTIVE_WINDOW_MS = 60_000;

export class LiveObject extends DurableObject<Env> {
  // In-memory only; a missed wake after hibernation just re-polls.
  private waiters: PollWaiter[] = [];
  private schemaReady = false;
  private readonly draftService = new DraftService(
    new DurableObjectRealtimeStore(this.ctx.storage),
  );

  private telemetry(
    artifactId: string,
    trace: LiveTrace | undefined,
    route: "live_draft" | "checkpoint",
    method: string,
  ): Telemetry | null {
    if (!trace) return null;
    const bindings = this.env as Bindings;
    return new Telemetry(
      {
        ...trace,
        artifactId,
        route,
        method,
      },
      bindings.TELEMETRY_ENV ?? bindings.ENVIRONMENT ?? "production",
      bindings.METRICS,
      bindings.TELEMETRY_LOGS === "disabled" ||
        (bindings.ENVIRONMENT === "test" &&
          bindings.TELEMETRY_LOGS !== "enabled")
        ? () => {}
        : undefined,
    );
  }

  // --- WebSocket (browser host chrome) ---

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const artifactId = request.headers.get("x-oa-artifact-id");
    const sessionId = request.headers.get("x-oa-live-session");
    if (artifactId && sessionId) {
      server.serializeAttachment({ artifactId, sessionId });
    }
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    let msg: LiveEvent;
    try {
      msg = JSON.parse(
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message),
      ) as LiveEvent;
    } catch {
      return; // ignore malformed
    }
    if (!msg?.type || !msg?.id) return;
    // The browser channel may only enqueue user actions (generate, comment,
    // exit). Reply types (ack/done/error) and the publish signal (version)
    // are produced server-side — accepting them here would let a WS client
    // inject fake events into the agent's poll queue or fake reloads into
    // other viewers.
    if (
      msg.type !== "generate" &&
      msg.type !== "comment" &&
      msg.type !== "exit"
    ) {
      return;
    }

    if (msg.type === "exit") {
      // Browser session ended — drop the connection; agent will see exit.
      await this.enqueue(msg);
      try {
        ws.close();
      } catch {
        // already closed
      }
      return;
    }
    await this.enqueue(msg);
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ) {
    const attachment = ws.deserializeAttachment() as {
      artifactId?: string;
      sessionId?: string;
    } | null;
    if (attachment?.artifactId && attachment.sessionId) {
      await new D1QuotaLedger(this.env.DB)
        .release(
          `artifact:${attachment.artifactId}`,
          "live_sessions",
          `live:${attachment.sessionId}`,
          new Date().toISOString(),
        )
        .catch(() => false);
    }
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  // --- Agent (CLI) RPC ---

  async rpcGetDraft(
    artifactId: string,
    trace?: LiveTrace,
  ): Promise<LiveDraft | null> {
    const telemetry = this.telemetry(artifactId, trace, "live_draft", "GET");
    const startedAt = Date.now();
    const draft = await this.draftService.get(artifactId);
    telemetry?.info("live.do.draft_read.completed", {
      revision: draft?.revision ?? null,
      draftState: draft?.state ?? "missing",
      durationMs: Date.now() - startedAt,
    });
    return draft;
  }

  async rpcSaveDraft(input: SaveDraftInput, trace?: LiveTrace) {
    const telemetry = this.telemetry(
      input.artifactId,
      trace,
      "live_draft",
      "PUT",
    );
    const startedAt = Date.now();
    telemetry?.info("live.do.draft_save.started", {
      expectedRevision: input.expectedRevision,
      baseVersion: input.baseVersion,
    });
    const result = await this.draftService.save(input);
    telemetry?.info("live.do.draft_save.completed", {
      result: result.ok ? "success" : "conflict",
      revision: result.ok ? result.draft.revision : result.currentRevision,
      durationMs: Date.now() - startedAt,
    });
    telemetry?.metric("live_operation", {
      value: 1,
      durationMs: Date.now() - startedAt,
      route: "live_draft",
      operation: "draft_save",
      result: result.ok ? "success" : "conflict",
      status: result.ok ? 200 : 409,
    });
    return result;
  }

  async rpcMarkDraftCheckpointed(
    artifactId: string,
    revision: number,
    checkpointVersion: number,
    trace?: LiveTrace,
  ): Promise<boolean> {
    const marked = await this.draftService.markCheckpointed(
      artifactId,
      revision,
      checkpointVersion,
    );
    this.telemetry(artifactId, trace, "checkpoint", "POST")?.info(
      "live.do.draft_checkpointed",
      { revision, checkpointVersion, marked },
    );
    return marked;
  }

  async rpcMarkDraftConflict(
    artifactId: string,
    revision: number,
    trace?: LiveTrace,
  ): Promise<boolean> {
    const marked = await this.draftService.markConflict(artifactId, revision);
    this.telemetry(artifactId, trace, "checkpoint", "POST")?.warn(
      "live.do.draft_conflict",
      { revision, marked },
    );
    return marked;
  }

  // Block until a matching event arrives or timeout. Lease prevents
  // double-delivery: the row is marked leased for LEASE_MS; if the agent
  // never replies, a later poll can re-acquire it. excludeIds are ids the
  // watcher has already delivered this session — a lease-expired, unreplied
  // event must not be re-offered ahead of newer ones (the watch loop passes
  // its grow-only delivered set).
  async rpcPoll(
    types: LiveEvent["type"][] | null,
    timeoutMs: number = DEFAULT_POLL_TIMEOUT_MS,
    excludeIds: string[] = [],
  ): Promise<LiveEvent | { type: "timeout" }> {
    await this.ensureSchema();
    const want = types ? new Set(types) : null;
    const skip = new Set(excludeIds);
    const available = await this.pickAvailable(want, Date.now(), skip);
    if (available) return available;

    return new Promise<LiveEvent | { type: "timeout" }>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve({ type: "timeout" });
      }, timeoutMs);
      const waiter: PollWaiter = { resolve, types: want, skip, timer };
      this.waiters.push(waiter);
    });
  }

  // Agent replies to an event: `ack` = "picked up, working" (broadcast but
  // keep the row); `done` = "finished, republished" (broadcast + drop the row).
  async rpcReply(
    id: string,
    type: LiveEvent["type"],
    payload: Record<string, unknown> = {},
  ) {
    if (type === "done" || type === "error") {
      // A `done` that fulfills an `edit` event means the agent applied the
      // committed ops: clear that page's stash (the host's Apply pill empties
      // on the next refresh). An `error` reply leaves the stash intact so the
      // user can retry or discard. The row must be read BEFORE acknowledge
      // drops it.
      if (type === "done") {
        const row = await this.pendingRow(id);
        if (row && row.type === "edit") {
          const payloadOf = JSON.parse(row.payload) as { pageUrl?: string };
          if (typeof payloadOf.pageUrl === "string") {
            await this.rpcClearStash(payloadOf.pageUrl);
          }
        }
      }
      await this.acknowledge(id);
    }
    this.broadcast({ type, id, ...payload } as LiveEvent);
  }

  // Snapshot of the pending queue for ack-status polling. The agent CLI drains
  // this via GET /live/status to wait for its own `done` reply to clear an
  // event before polling the next (see waitForEventAck in artifact.mjs).
  // agentActive/lastAgentSeen are the watcher's presence: the watch loop
  // heartbeats (rpcHeartbeat) so the viewer's Live toggle can show whether an
  // agent is online before the user starts picking.
  async rpcStatus(): Promise<{
    pendingEvents: {
      id: string;
      type: string;
      leased_until: number;
      created_at: number;
    }[];
    agentActive: boolean;
    lastAgentSeen: number | null;
  }> {
    await this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec<{
        id: string;
        type: string;
        leased_until: number;
        created_at: number;
      }>(
        `SELECT id, type, leased_until, created_at FROM pending ORDER BY seq ASC`,
      )
      .toArray();
    const lastAgentSeen =
      (await this.ctx.storage.get<number>("lastAgentSeen")) ?? null;
    return {
      pendingEvents: rows,
      agentActive:
        lastAgentSeen !== null &&
        Date.now() - lastAgentSeen <= AGENT_ACTIVE_WINDOW_MS,
      lastAgentSeen,
    };
  }

  // Watcher presence: the CLI's `--watch` loop POSTs /live/heartbeat on a
  // fixed interval so the viewer can show an "agent connected" state. The
  // timestamp lives in DO KV storage, so it survives hibernation.
  async rpcHeartbeat(): Promise<void> {
    await this.ctx.storage.put("lastAgentSeen", Date.now());
  }

  // Publish signal for staying viewers: when a new version lands (ordinary
  // update or Live in-place replace), tell the connected browsers so the host
  // can reload the frame in place. Broadcast-only — never enqueued, so a CLI
  // poll never sees it; a viewer with no channel open simply misses it (a
  // manual reload still works, same as before).
  async rpcBroadcastVersion(version: number): Promise<void> {
    this.broadcast({ type: "version", id: "version", version });
  }

  // Drop queued exit rows so a stale exit from a prior session can't poison a
  // new --watch (pollOnce would otherwise re-offer it for up to the 1h GC).
  // Called by the agent CLI when it observes an exit (via pollOnce or the
  // /status ack-wait). Safe vs. the done-races-exit case: acknowledge (done/
  // error) still preserves exits - only an explicit consume clears them, and
  // only after the watcher has already seen one.
  async rpcConsumeExit(): Promise<void> {
    await this.ensureSchema();
    await this.ctx.storage.sql.exec(`DELETE FROM pending WHERE type = 'exit'`);
  }

  // Cancel a queued edit event before any agent picks it up (the host's
  // "Queued — click to cancel" pill). Only un-leased edit rows are
  // cancellable: once a watcher polled the event, the agent may already be
  // applying it — deleting the row would not stop the work, so refuse.
  async rpcCancelEvent(
    eid: string,
  ): Promise<
    { ok: true } | { ok: false; error: "not found" | "already picked up" }
  > {
    await this.ensureSchema();
    const row = await this.pendingRow(eid);
    if (row === null || row.type !== "edit") {
      return { ok: false, error: "not found" };
    }
    if (row.leased_until > Date.now()) {
      return { ok: false, error: "already picked up" };
    }
    await this.ctx.storage.sql.exec(
      `DELETE FROM pending WHERE id = ? AND type = 'edit'`,
      eid,
    );
    return { ok: true };
  }

  // --- inline copy-edit stash (impeccable-style manual edits) ---
  //
  // The browser stages text edits into `stashed_edits` (one row per picked
  // element, keyed by (page_url, ref)) instead of delivering them as events
  // immediately. The user fixes several texts, then clicks Apply once — the
  // host POSTs /live/edit-commit, which bundles every staged op for the page
  // into a SINGLE `edit` event for the agent to apply in one pass.

  async rpcStashEdit(entry: {
    pageUrl: string;
    ref: string;
    element: Record<string, unknown>;
    ops: Record<string, unknown>[];
  }): Promise<{ pendingCount: number }> {
    await this.ensureSchema();
    const now = Date.now();
    const existing = this.ctx.storage.sql
      .exec<{ id: string; ops: string }>(
        `SELECT id, ops FROM stashed_edits WHERE page_url = ? AND ref = ?`,
        entry.pageUrl,
        entry.ref,
      )
      .toArray()[0];
    let ops: Record<string, unknown>[];
    let id: string;
    if (existing) {
      // Merge by (pageUrl, ref): a re-edit replaces newText but keeps the
      // original originalText — that is the true source state the agent must
      // match, even if the user has since reworded the row twice. The op key
      // is (ref, originalText): ref alone can repeat across rows of one
      // element (two <p> rows without ids/classes both resolve to "p"), so
      // keying on ref alone would collapse them onto one op.
      id = existing.id;
      const keyOf = (o: Record<string, unknown>) =>
        `${String(o.ref)}|${String(o.originalText)}`;
      const old = JSON.parse(existing.ops) as Record<string, unknown>[];
      const fresh = new Map(entry.ops.map((o) => [keyOf(o), o]));
      ops = old.map((o) => {
        const next = fresh.get(keyOf(o));
        return next ? { ...o, newText: next.newText } : o;
      });
      for (const o of entry.ops) {
        if (!old.some((prev) => keyOf(prev) === keyOf(o))) {
          ops.push(o);
        }
      }
      await this.ctx.storage.sql.exec(
        `UPDATE stashed_edits SET element = ?, ops = ?, updated_at = ? WHERE page_url = ? AND ref = ?`,
        JSON.stringify(entry.element),
        JSON.stringify(ops),
        now,
        entry.pageUrl,
        entry.ref,
      );
    } else {
      id = `stash_${Math.random().toString(36).slice(2, 10)}`;
      ops = entry.ops;
      await this.ctx.storage.sql.exec(
        `INSERT INTO stashed_edits (id, page_url, ref, element, ops, staged_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        entry.pageUrl,
        entry.ref,
        JSON.stringify(entry.element),
        JSON.stringify(ops),
        now,
        now,
      );
    }
    const count = await this.stashOpCount(entry.pageUrl);
    return { pendingCount: count };
  }

  async rpcListStash(pageUrl: string | null = null): Promise<{
    pendingCount: number;
    entries: {
      id: string;
      pageUrl: string;
      ref: string;
      element: unknown;
      ops: unknown[];
      stagedAt: number;
    }[];
  }> {
    await this.ensureSchema();
    const rowType = {} as {
      id: string;
      page_url: string;
      ref: string;
      element: string;
      ops: string;
      staged_at: number;
    };
    const rows =
      pageUrl === null
        ? this.ctx.storage.sql
            .exec<typeof rowType>(
              `SELECT id, page_url, ref, element, ops, staged_at FROM stashed_edits ORDER BY staged_at ASC`,
            )
            .toArray()
        : this.ctx.storage.sql
            .exec<typeof rowType>(
              `SELECT id, page_url, ref, element, ops, staged_at FROM stashed_edits WHERE page_url = ? ORDER BY staged_at ASC`,
              pageUrl,
            )
            .toArray();
    const entries = rows.map((r) => ({
      id: r.id,
      pageUrl: r.page_url,
      ref: r.ref,
      element: JSON.parse(r.element),
      ops: JSON.parse(r.ops) as unknown[],
      stagedAt: r.staged_at,
    }));
    return {
      pendingCount: entries.reduce((n, e) => n + e.ops.length, 0),
      entries,
    };
  }

  async rpcClearStash(pageUrl: string | null = null): Promise<void> {
    await this.ensureSchema();
    if (pageUrl === null) {
      await this.ctx.storage.sql.exec(`DELETE FROM stashed_edits`);
    } else {
      await this.ctx.storage.sql.exec(
        `DELETE FROM stashed_edits WHERE page_url = ?`,
        pageUrl,
      );
    }
  }

  // Commit the page's staged edits as ONE `edit` event. The event id is minted
  // here (ev_ + random + time, mirroring the host's genId) so the browser and
  // the agent refer to the same id for the reply; enqueue dedupes by id+type,
  // and `edit` is a new type so ev_ ids never collide with generate's.
  async rpcCommitEdit(
    pageUrl: string,
  ): Promise<
    { ok: true; eventId: string } | { ok: false; error: "no stashed edits" }
  > {
    await this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec<{ id: string; element: string; ops: string }>(
        `SELECT id, element, ops FROM stashed_edits WHERE page_url = ? ORDER BY staged_at ASC`,
        pageUrl,
      )
      .toArray();
    if (rows.length === 0) return { ok: false, error: "no stashed edits" };
    const items = rows.map((r) => ({
      id: r.id,
      element: JSON.parse(r.element),
      ops: JSON.parse(r.ops),
    }));
    const eventId = `ev_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    await this.enqueue({
      type: "edit",
      id: eventId,
      pageUrl,
      items,
    } as LiveEvent);
    return { ok: true, eventId };
  }

  // --- internals ---

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS pending (
        id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        seq INTEGER NOT NULL,
        leased_until INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (id, type)
      )`,
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS pending_seq ON pending(seq)`);
    // Staged copy edits (impeccable-style manual edits): one row per picked
    // element on a page, merged by (page_url, ref). CREATE TABLE IF NOT EXISTS
    // is idempotent, so an existing deploy's DO gets the table on its next
    // wake without a migration.
    sql.exec(
      `CREATE TABLE IF NOT EXISTS stashed_edits (
        id TEXT NOT NULL,
        page_url TEXT NOT NULL,
        ref TEXT NOT NULL,
        element TEXT NOT NULL,
        ops TEXT NOT NULL,
        staged_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (page_url, ref)
      )`,
    );
    this.schemaReady = true;
  }

  // The pending row for an id, if any — used by rpcReply to decide whether a
  // `done` fulfills an edit event (and thus clears that page's stash).
  private async pendingRow(id: string): Promise<QueueRow | null> {
    await this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec<QueueRow>(
        `SELECT id, type, payload, seq, leased_until, created_at FROM pending WHERE id = ?`,
        id,
      )
      .toArray()[0];
    return row ?? null;
  }

  private async stashOpCount(pageUrl: string): Promise<number> {
    const rows = this.ctx.storage.sql
      .exec<{ ops: string }>(
        `SELECT ops FROM stashed_edits WHERE page_url = ?`,
        pageUrl,
      )
      .toArray();
    return rows.reduce(
      (n, r) => n + ((JSON.parse(r.ops) as unknown[]).length ?? 0),
      0,
    );
  }

  private async enqueue(event: LiveEvent): Promise<void> {
    await this.ensureSchema();
    // GC old undelivered events so a forgotten submit doesn't live forever.
    const cutoff = Date.now() - GC_AGE_MS;
    await this.ctx.storage.sql.exec(
      `DELETE FROM pending WHERE created_at < ?`,
      cutoff,
    );
    // Stale staged edits age out on the same sweep (see STASH_GC_AGE_MS): a
    // draft untouched for a day is abandoned; the user's Apply flow needs
    // minutes, not hours, so the longer window is safe.
    const stashCutoff = Date.now() - STASH_GC_AGE_MS;
    await this.ctx.storage.sql.exec(
      `DELETE FROM stashed_edits WHERE updated_at < ?`,
      stashCutoff,
    );
    // Dedupe by id+type.
    const exists =
      this.ctx.storage.sql
        .exec<{ c: number }>(
          `SELECT COUNT(*) AS c FROM pending WHERE id = ? AND type = ?`,
          event.id,
          event.type,
        )
        .toArray()[0]?.c ?? 0;
    if (exists > 0) return;
    const seq = Date.now(); // monotonic-ish; ties broken by created_at
    await this.ctx.storage.sql.exec(
      `INSERT INTO pending (id, type, payload, seq, leased_until, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
      event.id,
      event.type,
      JSON.stringify(event),
      seq,
      Date.now(),
    );
    await this.flushWaiters();
  }

  // Acknowledge a `done`/`error` reply: drop the fulfilled event row(s) for
  // this id, but preserve any queued `exit` — the agent's watch loop only
  // terminates on `exit`, and a `done` that races a user's Exit click must not
  // strand it (the row would sit until GC, the watcher hanging up to 1h).
  private async acknowledge(id: string): Promise<void> {
    await this.ctx.storage.sql.exec(
      `DELETE FROM pending WHERE id = ? AND type != 'exit'`,
      id,
    );
  }

  private async pickAvailable(
    want: Set<LiveEvent["type"]> | null,
    now: number,
    skip: Set<string> = new Set(),
  ): Promise<LiveEvent | null> {
    await this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec<QueueRow>(
        `SELECT id, type, payload, seq, leased_until, created_at FROM pending WHERE leased_until <= ? ORDER BY seq ASC`,
        now,
      )
      .toArray();
    // Sort in JS by priority then seq (priority is small; SQL ORDER BY can't
    // see the JS function). Terminal types (exit) first, then generate.
    const sorted = rows.sort(
      (a, b) =>
        eventPriority(a.type as LiveEvent["type"]) -
          eventPriority(b.type as LiveEvent["type"]) || a.seq - b.seq,
    );
    const winner = sorted.find(
      (r) =>
        (want === null || want.has(r.type as LiveEvent["type"])) &&
        !skip.has(r.id),
    );
    if (!winner) return null;
    await this.ctx.storage.sql.exec(
      `UPDATE pending SET leased_until = ? WHERE id = ? AND type = ?`,
      now + LEASE_MS,
      winner.id,
      winner.type,
    );
    let event: LiveEvent;
    try {
      event = JSON.parse(winner.payload) as LiveEvent;
    } catch {
      // corrupted row — drop it so it doesn't block the queue
      await this.ctx.storage.sql.exec(
        `DELETE FROM pending WHERE id = ? AND type = ?`,
        winner.id,
        winner.type,
      );
      return null;
    }
    // Comments are notifications, not edit jobs: the watcher has received
    // the payload once poll selects it, so keeping the row would replay old
    // comments after the lease expires. The comment itself remains in D1;
    // only this transient live-delivery row is consumed.
    if (event.type === "comment") {
      await this.ctx.storage.sql.exec(
        `DELETE FROM pending WHERE id = ? AND type = ?`,
        winner.id,
        winner.type,
      );
    }
    return event;
  }

  private async flushWaiters(): Promise<void> {
    if (this.waiters.length === 0) return;
    const now = Date.now();
    for (const waiter of [...this.waiters]) {
      const evt = await this.pickAvailable(waiter.types, now, waiter.skip);
      if (evt) {
        clearTimeout(waiter.timer);
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.resolve(evt);
      }
    }
  }

  private broadcast(msg: LiveEvent) {
    const data = JSON.stringify(msg);
    // ctx.getWebSockets() is runtime-tracked and survives hibernation (an
    // in-memory Set would reset and miss post-hibernate connections).
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // send failed; the runtime prunes dead sockets from getWebSockets()
      }
    }
  }
}
