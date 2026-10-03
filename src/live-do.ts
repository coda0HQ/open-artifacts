import { DurableObject } from "cloudflare:workers";

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
  watcher: string; // the CLI watcher session this poll belongs to ("", none)
};

// A poll must complete (an event or {type:'timeout'}) well before the edge
// drops an idle client connection. Cloudflare's edge kills an idle long-poll
// at ~127s with no response — a poll requested above this ceiling always dies
// mid-hold and the CLI sees "other side closed" (its retry loop), instead of
// completing with a timeout JSON. 60s is a comfortable margin under that
// cutoff; the route clamps any requested timeout to this value.
export const MAX_LIVE_POLL_MS = 60_000;
const DEFAULT_POLL_TIMEOUT_MS = MAX_LIVE_POLL_MS;
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
const TICKET_TTL_MS = 60_000; // one-time ticket expires after 60s
const GC_SWEEP_INTERVAL_MS = 1800_000; // 30m background GC alarm interval

export class LiveObject extends DurableObject<Record<string, unknown>> {
  // In-memory only; a missed wake after hibernation just re-polls.
  private waiters: PollWaiter[] = [];
  private schemaReady = false;

  // --- WebSocket (browser host chrome & agent CLI watcher) ---

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const isAgent = url.pathname.endsWith("/ws");
    if (isAgent) {
      const ticket = url.searchParams.get("ticket") ?? "";
      const valid = await this.checkTicket(ticket);
      if (!valid) {
        return new Response("invalid or expired ticket", { status: 401 });
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [isAgent ? "agent" : "browser"]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message),
      ) as Record<string, unknown>;
    } catch {
      return; // ignore malformed
    }
    if (typeof raw?.type !== "string") return;

    const tags = this.ctx.getTags(ws);
    if (tags.includes("agent")) {
      await this.handleAgentMessage(ws, raw);
      return;
    }

    const msg = raw as unknown as LiveEvent;
    if (!msg?.id) return;
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

  private async handleAgentMessage(
    ws: WebSocket,
    msg: Record<string, unknown>,
  ) {
    if (msg.type === "hb") {
      await this.ctx.storage.put("lastAgentSeen", Date.now());
      try {
        ws.send(JSON.stringify({ type: "hb" }));
      } catch {
        // socket closed
      }
      return;
    }
    if (msg.type === "ready") {
      const delivered = Array.isArray(msg.delivered)
        ? (msg.delivered as unknown[]).filter(
            (x): x is string => typeof x === "string",
          )
        : [];
      await this.syncToAgent(ws, delivered);
      return;
    }
    // Any other message type from an agent socket is ignored: the agent channel
    // only accepts ready and hb; events and signals cannot be injected.
  }

  private async syncToAgent(ws: WebSocket, delivered: string[]) {
    const skip = new Set(delivered);
    const now = Date.now();
    while (true) {
      const evt = await this.pickAvailable(null, now, skip);
      if (!evt) break;
      skip.add(evt.id);
      try {
        ws.send(JSON.stringify({ type: "event", event: evt }));
      } catch {
        break;
      }
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ) {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  // --- Agent (CLI) RPC ---

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
    watcher = "",
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
      // A watcher polls sequentially, so an in-flight poll is superseded the
      // moment that watcher's next poll lands — its previous poll's connection
      // died on the edge and the watch loop re-polled. Prune the superseded
      // waiter: left in place it would consume an event via flushWaiters and
      // drop it (its response is dead), the comment-loss behind the "other side
      // closed" retry loop. Resolve it (timeout) so its timer is cleared and
      // its promise doesn't dangle until the original timeout. Polls without a
      // watcher id keep the old behavior.
      if (watcher) {
        for (const stale of this.waiters) {
          if (stale.watcher === watcher) {
            clearTimeout(stale.timer);
            stale.resolve({ type: "timeout" });
          }
        }
        this.waiters = this.waiters.filter((w) => w.watcher !== watcher);
      }
      const waiter: PollWaiter = { resolve, types: want, skip, timer, watcher };
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
    this.broadcastAgents({ type: "cleared", id: eid });
    return { ok: true };
  }

  // --- Agent ticket for WebSocket upgrade ---

  async rpcMintTicket(): Promise<{ ok: true; ticket: string }> {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const ticket = `lt_${[...bytes]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}`;
    await this.ctx.storage.put(`ws_ticket_${ticket}`, Date.now());
    return { ok: true, ticket };
  }

  private async checkTicket(ticket: string): Promise<boolean> {
    if (!ticket) return false;
    const key = `ws_ticket_${ticket}`;
    const minted = await this.ctx.storage.get<number>(key);
    if (minted === undefined) return false;
    await this.ctx.storage.delete(key);
    return Date.now() - minted <= TICKET_TTL_MS;
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
    await this.pushToAgent(event);
    await this.scheduleGcAlarm();
  }

  private async pushToAgent(event: LiveEvent): Promise<void> {
    const agents = this.ctx.getWebSockets("agent");
    if (agents.length === 0) return;
    if (event.type === "comment") {
      for (const ws of agents) {
        try {
          ws.send(JSON.stringify({ type: "event", event }));
        } catch {
          // ignore dead socket
        }
      }
      await this.ctx.storage.sql.exec(
        `DELETE FROM pending WHERE id = ? AND type = ?`,
        event.id,
        event.type,
      );
      return;
    }
    // Generate, edit, and exit events are offered to the first connected agent
    // watcher and leased, matching pickAvailable's lease semantics so concurrent
    // watchers do not double-process the same event.
    const target = agents[0];
    try {
      target.send(JSON.stringify({ type: "event", event }));
      await this.ctx.storage.sql.exec(
        `UPDATE pending SET leased_until = ? WHERE id = ? AND type = ?`,
        Date.now() + LEASE_MS,
        event.id,
        event.type,
      );
    } catch {
      // send failed; runtime prunes dead sockets
    }
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
    this.broadcastAgents({ type: "cleared", id });
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
    // Broadcasts (ack/done/version) are delivered only to browser viewers;
    // agent sockets receive event pushes and cleared notifications instead.
    for (const ws of this.ctx.getWebSockets("browser")) {
      try {
        ws.send(data);
      } catch {
        // send failed; the runtime prunes dead sockets from getWebSockets()
      }
    }
  }

  private broadcastAgents(msg: Record<string, unknown>) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets("agent")) {
      try {
        ws.send(data);
      } catch {
        // dead socket
      }
    }
  }

  // --- Storage alarm GC ---

  async alarm(): Promise<void> {
    await this.ensureSchema();
    const sweptIds = await this.sweep(Date.now());
    for (const id of sweptIds) {
      this.broadcastAgents({ type: "cleared", id });
    }
    const hasRows = await this.hasSweepableRows();
    if (hasRows) {
      await this.ctx.storage.setAlarm(Date.now() + GC_SWEEP_INTERVAL_MS);
    }
  }

  private async scheduleGcAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + GC_SWEEP_INTERVAL_MS);
    }
  }

  private async sweep(now: number): Promise<string[]> {
    const cutoff = now - GC_AGE_MS;
    const agedRows = this.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM pending WHERE created_at < ?`,
        cutoff,
      )
      .toArray();
    const sweptIds = agedRows.map((r) => r.id);
    if (sweptIds.length > 0) {
      await this.ctx.storage.sql.exec(
        `DELETE FROM pending WHERE created_at < ?`,
        cutoff,
      );
    }
    const stashCutoff = now - STASH_GC_AGE_MS;
    await this.ctx.storage.sql.exec(
      `DELETE FROM stashed_edits WHERE updated_at < ?`,
      stashCutoff,
    );
    const tickets = await this.ctx.storage.list<number>({
      prefix: "ws_ticket_",
    });
    for (const [key, minted] of tickets) {
      if (now - minted > TICKET_TTL_MS) {
        await this.ctx.storage.delete(key);
      }
    }
    return sweptIds;
  }

  private async hasSweepableRows(): Promise<boolean> {
    const pCount =
      this.ctx.storage.sql
        .exec<{ c: number }>(`SELECT COUNT(*) AS c FROM pending`)
        .toArray()[0]?.c ?? 0;
    if (pCount > 0) return true;
    const sCount =
      this.ctx.storage.sql
        .exec<{ c: number }>(`SELECT COUNT(*) AS c FROM stashed_edits`)
        .toArray()[0]?.c ?? 0;
    return sCount > 0;
  }
}
