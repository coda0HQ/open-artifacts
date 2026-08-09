#!/usr/bin/env node
// Open Artifacts publishing CLI. Zero dependencies; requires Node >= 22.
// This file is intentionally only the composition root and command dispatcher.

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  commandLogin,
  commandLogout,
  commandWhoami,
} from "./commands/auth.mjs";
import { commandBuild, commandValidate } from "./commands/build.mjs";
import { commandCredentials } from "./commands/credentials.mjs";
import { commandLive } from "./commands/live-session.mjs";
import {
  commandAck,
  commandAutoUpdate,
  commandInstallHook,
  commandList,
  commandStatus,
} from "./commands/manifest.mjs";
import { commandMigrate } from "./commands/migrate.mjs";
import {
  commandCreate,
  commandDelete,
  commandLiveCheckpoint,
  commandShow,
  commandUpdate,
} from "./commands/publication.mjs";
import {
  loadConfig,
  loadCredentials,
  mutateCredentials,
} from "./lib/cli-state.mjs";
import { request } from "./lib/transport.mjs";

export const HELP = `usage: artifact.mjs <command> [options]

commands:
  validate <recipe>    validate and compose a Recipe without writing output
  build <recipe>       write an explicit preview/export (requires --output)
  create <recipe>      build in memory and publish exactly once
  update <id> [recipe] build in memory and redeploy at the same URL; defaults
                       to the Recipe recorded in Manifest v2; --live saves a
                       revisioned draft without changing the published version
  migrate <id>         create a Recipe and fragments for a legacy artifact;
                       does not publish until update is run
  status               report artifacts whose watched files changed (exit 1 if stale)
  ack <id>             mark drift reviewed: advance the snapshot baseline without
                       republishing (offline; use when changes don't affect it)
  auto-update <id> on|off
                       toggle whether the Stop hook's automatic loop surfaces
                       this artifact (opt-in, off by default); "on" also installs
                       the Stop hook if needed and prints a confirmation
  list                 list artifacts in the manifest
  show <id>            print the current published content (decrypts locally
                       for encrypted artifacts using the stored password)
  delete <id>          delete an artifact from the server and manifest
  install-hook         add a Claude Code Stop hook that runs status --hook
  login [--provider google|github]
                       OAuth login via loopback callback; stores sk_ in
                       credentials.json (requires a SaaS instance)
  logout               remove the stored API key from credentials.json
  whoami               print the authenticated SaaS user for the current API key
  credentials rotate <id> [--grace <seconds>]
                       rotate the artifact write token; stores the new token
  credentials status <id>
                       list token IDs and lifecycle state (never raw tokens)
  credentials revoke <id> <credential-id>
                       revoke a lifecycle credential
  credentials recover <id>
                       manager-only recovery; stores a new write token
  live <id>            live editing: poll one event (stdout JSON, exit),
                       or --reply <eid> <status> --version <n> [--data <json>]
                       to ack (--data carries the canonical edit-result JSON)
  live <id> --watch    stay online for the session: poll, auto-ack each
                       generate/edit, print each event on stdout, exit on
                       "exit"; waits for each event's done reply (polls
                       /live/status) before polling the next (--ack-timeout=0
                       disables)
  live <id> --wait-ack <eid>
                       block until event <eid> leaves the pending queue
                       (polls /live/status) or the ack timeout elapses
  live checkpoint <id> atomically publish the current draft as a new immutable
                       version; retries use a stable idempotency key

options:
  --output <path>      (build) explicit preview/export output path
  --standalone         (build) wrap HTML for direct file:// preview
  --label <l>          (create/update) version label (max 60 bytes; note: CJK chars are 3 bytes each, so keep labels terse)
  --password <p>       encrypt client-side; server only stores ciphertext
  --api <url>          instance URL (default: OPEN_ARTIFACTS_URL or config)
  --token <t>          bearer token (overrides OPEN_ARTIFACTS_API_KEY and env)
  --visibility <v>     (create) private, org, or public (default private with sk_)
  --org <id>           (create) organization id for org-scoped artifacts
  --provider <name>    (login) google or github OAuth provider
  --port <n>           (login) loopback callback port (default: ephemeral)
  --grace <seconds>    (credentials rotate) old-token grace, 0-300 seconds
  --force              overwrite on version conflict
  --live               (update) save a revisioned Live draft; publish it with
                       live checkpoint <id>
  --v <n>              (show) view a specific version's content
  --hook               (status) emit Claude Code hook JSON instead of text
  --ack-timeout <ms>   (live --watch/--wait-ack) max wait for an event's done
                       reply before continuing; default 600000, 0 disables
  --ack-poll <ms>      (live --watch/--wait-ack) /live/status poll interval;
                       default 1000 (remote-Worker friendly)
  --data <json>        (live --reply) canonical edit-result JSON object,
                       merged into the reply body (status/appliedEntryIds/
                       failed/files/notes)

auth precedence for requests: --token > OPEN_ARTIFACTS_API_KEY > credentials.json apiKey >
OPEN_ARTIFACTS_TOKEN > config createToken
`;

export function parseCliArguments(args) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      standalone: { type: "boolean" },
      label: { type: "string" },
      password: { type: "string" },
      api: { type: "string" },
      token: { type: "string" },
      visibility: { type: "string" },
      org: { type: "string" },
      provider: { type: "string" },
      port: { type: "string" },
      grace: { type: "string" },
      force: { type: "boolean" },
      live: { type: "boolean" },
      hook: { type: "boolean" },
      v: { type: "string" },
      reply: { type: "string" },
      data: { type: "string" },
      types: { type: "string" },
      version: { type: "string" },
      watch: { type: "boolean" },
      "wait-ack": { type: "string" },
      "ack-timeout": { type: "string" },
      "ack-poll": { type: "string" },
      help: { type: "boolean" },
    },
  });
}

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}

export async function dispatch(
  command,
  rest,
  flags,
  scriptUrl = import.meta.url,
) {
  switch (command) {
    case "validate":
      commandValidate(
        required(rest[0], "validate requires a Recipe JSON path"),
      );
      return;
    case "build":
      commandBuild(
        required(rest[0], "build requires a Recipe JSON path"),
        flags,
      );
      return;
    case "create":
      await commandCreate(
        required(rest[0], "create requires a Recipe JSON path"),
        flags,
      );
      return;
    case "update":
      await commandUpdate(
        required(rest[0], "update requires an artifact id"),
        rest[1],
        flags,
        flags.live === true,
      );
      return;
    case "migrate":
      await commandMigrate(
        required(rest[0], "migrate requires an artifact id"),
        flags,
      );
      return;
    case "delete":
      await commandDelete(
        required(rest[0], "delete requires an artifact id"),
        flags,
      );
      return;
    case "status":
      await commandStatus(flags, scriptUrl);
      return;
    case "ack":
      commandAck(required(rest[0], "ack requires an artifact id"));
      return;
    case "auto-update":
      commandAutoUpdate(
        required(rest[0], "auto-update requires an artifact id"),
        required(rest[1], 'auto-update requires a mode: "on" or "off"'),
        scriptUrl,
      );
      return;
    case "list":
      commandList();
      return;
    case "show":
      await commandShow(
        required(rest[0], "show requires an artifact id"),
        flags,
      );
      return;
    case "install-hook":
      commandInstallHook(scriptUrl);
      return;
    case "login":
      await commandLogin(flags);
      return;
    case "logout":
      commandLogout();
      return;
    case "whoami":
      await commandWhoami(flags);
      return;
    case "credentials":
      await commandCredentials(rest, flags, {
        loadConfig,
        loadCredentials,
        mutateCredentials,
        request,
      });
      return;
    case "live":
      if (rest[0] === "checkpoint") {
        await commandLiveCheckpoint(
          required(rest[1], "live checkpoint requires an artifact id"),
          flags,
        );
      } else {
        await commandLive(rest, flags);
      }
      return;
    default:
      throw new Error(`unknown command: ${command}\n${HELP}`);
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values: flags, positionals } = parseCliArguments(args);
  const [command, ...rest] = positionals;
  if (flags.help || !command) {
    console.log(HELP);
    return;
  }
  await dispatch(command, rest, flags);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
