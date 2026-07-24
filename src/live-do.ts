import { DurableObject } from "cloudflare:workers";

// LiveObject — the per-artifact coordination point for live variant editing.
//
// One LiveObject instance per artifact id (keyed by getByName(artifactId)). It
// holds the WebSocket channel to the viewing browser (host chrome, outside the
// sandboxed iframe) and the long-poll queue the authoring agent CLI drains.
//
// The three-party loop:
//   Browser (host) ── ws.send(generate/accept/discard/exit) ──▶ LiveObject
//   Agent (CLI)    ── rpc.poll()  ──▶ drains pendingEvents (blocks)
//   Agent          ◀── rpc.poll() returns one event
//   Agent          ── rpc.reply(id, done/accept/discard, payload) ──▶ LiveObject
//   LiveObject     ── ws.send(done/accept/discard) ──▶ Browser (broadcasts)
//
// Minimal subset (no carbonize/journal/scaffold): in-memory state is fine. On
// hibernation the ws set survives (Cloudflare keeps the connections); the
// pendingEvents queue and poll waiters reset, which is acceptable — the agent
// re-polls and the browser re-sends if no ack arrives. Critical accept/discard
// are idempotent on the agent side (re-update is a no-op once applied).
//
// Hibernatable WebSockets: acceptWebSocket keeps the DO cheap when idle; a
// message wakes it. webSocketMessage/webSocketClose are the hibernation handlers.

export type LiveEvent = {
  type:
    | "generate"
    | "accept"
    | "discard"
    | "exit"
    | "done"
    | "complete"
    | "discarded"
    | "error";
  id: string;
  [key: string]: unknown;
};

// Priority: terminal user actions first (so a late accept isn't stuck behind a
// generate), then generate, then everything else. Mirrors impeccable-live's
// poll-lanes.mjs with a reduced set.
function eventPriority(type: LiveEvent["type"]): number {
  if (type === "accept" || type === "discard" || type === "exit") return 0;
  if (type === "generate") return 1;
  return 2;
}

type QueueEntry = { event: LiveEvent; seq: number; leasedUntil: number };
type PollWaiter = {
  resolve: (e: LiveEvent | { type: "timeout" }) => void;
  types: Set<LiveEvent["type"]> | null; // null = any
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_POLL_TIMEOUT_MS = 270_000; // under undici's 300s header ceiling
const LEASE_MS = 30_000; // a poll holds an event for 30s before re-offering it

export class LiveObject extends DurableObject {
  // In-memory; resets on hibernation. Acceptable for the minimal loop.
  private wsSet = new Set<WebSocket>();
  private pending: QueueEntry[] = [];
  private waiters: PollWaiter[] = [];
  private nextSeq = 1;

  // --- WebSocket (browser host chrome) ---

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
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

    if (msg.type === "exit") {
      // Browser session ended — drop the connection; agent will see exit.
      this.enqueue(msg);
      ws.close();
      return;
    }
    this.enqueue(msg);
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ) {
    this.wsSet.delete(ws);
    // With web_socket_auto_reply_to_close (compat date >= 2026-04-07) the
    // runtime auto-replies; close() is safe and a no-op there.
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  // --- Agent (CLI) RPC ---

  // Block until a matching event arrives or timeout. Lease prevents
  // double-delivery: the entry is marked leased for LEASE_MS; if the agent
  // never replies, a later poll can re-acquire it.
  async rpcPoll(
    types: LiveEvent["type"][] | null,
    timeoutMs: number = DEFAULT_POLL_TIMEOUT_MS,
  ): Promise<LiveEvent | { type: "timeout" }> {
    const want = types ? new Set(types) : null;
    const available = this.pickAvailable(want, Date.now());
    if (available) return available;

    return new Promise<LiveEvent | { type: "timeout" }>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve({ type: "timeout" });
      }, timeoutMs);
      const waiter: PollWaiter = { resolve, types: want, timer };
      this.waiters.push(waiter);
    });
  }

  // Agent replies to a generate/accept/discard: broadcast to all subscribed
  // browsers and drop the original event from the queue.
  async rpcReply(
    id: string,
    type: LiveEvent["type"],
    payload: Record<string, unknown> = {},
  ) {
    this.acknowledge(id);
    this.broadcast({ type, id, ...payload } as LiveEvent);
  }

  // --- internals ---

  private enqueue(event: LiveEvent) {
    // Dedupe by id+type so a re-send doesn't duplicate.
    if (
      this.pending.some(
        (e) => e.event.id === event.id && e.event.type === event.type,
      )
    ) {
      return;
    }
    this.pending.push({ event, seq: this.nextSeq++, leasedUntil: 0 });
    this.flushWaiters();
  }

  private acknowledge(id: string) {
    this.pending = this.pending.filter((e) => e.event.id !== id);
  }

  private pickAvailable(
    want: Set<LiveEvent["type"]> | null,
    now: number,
  ): LiveEvent | null {
    const candidates = this.pending
      .filter((e) => e.leasedUntil <= now)
      .filter((e) => want === null || want.has(e.event.type))
      .sort(
        (a, b) =>
          eventPriority(a.event.type) - eventPriority(b.event.type) ||
          a.seq - b.seq,
      );
    const winner = candidates[0];
    if (!winner) return null;
    winner.leasedUntil = now + LEASE_MS;
    return winner.event;
  }

  private flushWaiters() {
    if (this.waiters.length === 0) return;
    const now = Date.now();
    for (const waiter of [...this.waiters]) {
      const evt = this.pickAvailable(waiter.types, now);
      if (evt) {
        clearTimeout(waiter.timer);
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.resolve(evt);
      }
    }
  }

  private broadcast(msg: LiveEvent) {
    const data = JSON.stringify(msg);
    for (const ws of this.wsSet) {
      try {
        ws.send(data);
      } catch {
        this.wsSet.delete(ws);
      }
    }
  }
}
