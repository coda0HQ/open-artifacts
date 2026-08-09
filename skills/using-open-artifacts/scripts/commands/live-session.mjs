import { randomBytes } from "node:crypto";
import {
  loadConfig,
  loadCredentials,
  resolveAuthToken,
} from "../lib/cli-state.mjs";
import { waitForEventAck } from "../lib/live-ack.mjs";
import { deepestCause, request } from "../lib/transport.mjs";

function stripForAgent(event) {
  if (!event || typeof event !== "object" || !("screenshot" in event)) {
    return event;
  }
  const clean = { ...event };
  delete clean.screenshot;
  return clean;
}

export async function commandLive(rest, flags) {
  const config = loadConfig(flags);
  const id = rest[0];
  if (!id) {
    throw new Error(
      "usage: artifact.mjs live <id> [--reply <eid> <status> --version <n>]",
    );
  }
  const token = resolveAuthToken(flags);
  const sk = token?.startsWith("sk_") ? token : loadCredentials().apiKey;
  if (!sk?.startsWith("sk_")) {
    throw new Error(
      "not logged in; run the CLI's `login` command on a SaaS instance first",
    );
  }
  const base = `${config.apiUrl}/api/artifacts/${encodeURIComponent(id)}/live`;
  const replyId = flags.reply;
  if (replyId) {
    const status = rest[1] ?? "done";
    const version = flags.version;
    const body = { id: replyId, type: status, version };
    if (flags.data !== undefined) {
      try {
        const data = JSON.parse(flags.data);
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
          throw new Error("object required");
        }
        Object.assign(body, data);
      } catch {
        throw new Error(`--data must be a JSON object, got: ${flags.data}`);
      }
    }
    const { status: httpStatus, json } = await request(
      "POST",
      `${base}/reply`,
      body,
      sk,
    );
    if (httpStatus !== 200) {
      throw new Error(
        `live reply failed (${httpStatus}): ${json.error ?? "unknown"}`,
      );
    }
    console.log(JSON.stringify({ ok: true }));
    return;
  }

  const typesRaw = flags.types;
  const timeoutMs = Number(process.env.OPEN_ARTIFACTS_LIVE_TIMEOUT_MS);
  const timeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000;
  const watcherId = `w_${randomBytes(8).toString("hex")}`;
  const headers = {
    "content-type": "application/json",
    "Open-Artifacts-Protocol": "1",
    authorization: `Bearer ${sk}`,
  };
  const fetchJson = async (method, url, body) => {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      throw new Error(`cannot reach ${url}: ${deepestCause(cause)}`);
    }
    const text = await response.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: text.slice(0, 200) };
    }
    return { status: response.status, json };
  };
  const pollOnce = async (exclude = []) => {
    const params = new URLSearchParams({ timeout: String(timeout) });
    params.set("watcher", watcherId);
    if (typesRaw) params.set("types", typesRaw);
    if (exclude.length) params.set("exclude", exclude.join(","));
    const { status: httpStatus, json } = await fetchJson(
      "GET",
      `${base}/poll?${params}`,
    );
    if (httpStatus !== 200) {
      const error = Object.assign(
        new Error(
          `live poll failed (${httpStatus}): ${json.error ?? "unknown"}`,
        ),
        { status: httpStatus },
      );
      if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404) {
        error.message +=
          " — the artifact may not exist or this token is not authorized for it; verify the id and that you are logged in as its owner (`whoami`; references/auth.md)";
      }
      throw error;
    }
    return json;
  };
  const reply = async (eventId, type, version) => {
    const { status: httpStatus, json } = await fetchJson(
      "POST",
      `${base}/reply`,
      { id: eventId, type, version },
    );
    if (httpStatus !== 200) {
      throw new Error(
        `live reply failed (${httpStatus}): ${json.error ?? "unknown"}`,
      );
    }
    return json;
  };
  const fetchStatus = async () => {
    const { status: httpStatus, json } = await fetchJson(
      "GET",
      `${base}/status`,
    );
    if (httpStatus !== 200) {
      throw new Error(
        `live status failed (${httpStatus}): ${json.error ?? "unknown"}`,
      );
    }
    return json;
  };
  const consumeExit = async () => {
    try {
      await fetchJson("POST", `${base}/consume-exit`);
    } catch (error) {
      console.error(`[live watch] consume-exit failed: ${error.message}`);
    }
  };
  const parseMs = (raw, fallback, minimum = 0) => {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
  };
  const ackTimeoutMs = parseMs(flags["ack-timeout"], 600_000);
  const ackPollMs = parseMs(flags["ack-poll"], 1000, 1);
  const waitAckId = flags["wait-ack"];
  if (waitAckId) {
    const result = await waitForEventAck(fetchStatus, waitAckId, {
      pollIntervalMs: ackPollMs,
      maxWaitMs: ackTimeoutMs,
    });
    if (result !== "cleared") {
      throw new Error(
        result === "exit"
          ? `session exited before event ${waitAckId} was acknowledged`
          : `ack timeout waiting for event ${waitAckId}`,
      );
    }
    console.log(JSON.stringify({ ok: true, id: waitAckId }));
    return;
  }
  if (!flags.watch) {
    console.log(JSON.stringify(stripForAgent(await pollOnce())));
    return;
  }

  console.error("[live watch] online; waiting for events (Ctrl-C to stop)");
  const heartbeatMs = parseMs(
    process.env.OPEN_ARTIFACTS_LIVE_HEARTBEAT_MS,
    20_000,
    1,
  );
  const heartbeat = async () => {
    try {
      await fetchJson("POST", `${base}/heartbeat`);
    } catch {
      // Presence expires server-side after missed heartbeats.
    }
  };
  void heartbeat();
  const heartbeatTimer = setInterval(heartbeat, heartbeatMs);
  const delivered = new Set();
  let authWarned = false;
  while (true) {
    let event;
    try {
      event = await pollOnce([...delivered]);
    } catch (error) {
      const auth =
        error &&
        (error.status === 401 || error.status === 403 || error.status === 404);
      if (auth) {
        if (!authWarned) {
          authWarned = true;
          console.error(`[live watch] ${error.message}`);
        }
        console.error(
          "[live watch] poll rejected (401/403/404); retrying in 2s",
        );
      } else {
        console.error(`[live watch] ${error.message}; retrying in 2s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    if (event.type === "timeout") continue;
    delivered.add(event.id);
    console.log(JSON.stringify(stripForAgent(event)));
    if (event.type === "exit") {
      clearInterval(heartbeatTimer);
      await consumeExit();
      console.error("[live watch] session ended");
      break;
    }
    if (event.type === "generate" || event.type === "edit") {
      try {
        await reply(event.id, "ack");
      } catch (error) {
        console.error(`[live watch] ack failed: ${error.message}`);
      }
      if (ackTimeoutMs > 0) {
        const result = await waitForEventAck(fetchStatus, event.id, {
          pollIntervalMs: ackPollMs,
          maxWaitMs: ackTimeoutMs,
          knownIds: delivered,
        });
        if (result === "exit") {
          clearInterval(heartbeatTimer);
          await consumeExit();
          console.error("[live watch] session ended during edit");
          break;
        }
        if (result === "new") continue;
        if (result === "timeout") {
          console.error(
            `[live watch] ack timeout on event ${event.id}; continuing`,
          );
        }
      }
    }
  }
}
