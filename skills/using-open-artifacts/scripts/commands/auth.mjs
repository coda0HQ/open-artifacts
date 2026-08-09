import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import {
  loadConfig,
  loadCredentials,
  mutateCredentials,
  resolveAuthToken,
} from "../lib/cli-state.mjs";
import { request } from "../lib/transport.mjs";

const execFileAsync = promisify(execFile);

export function buildCliLoginUrl(apiUrl, provider, redirectUri) {
  const loginPath =
    provider === "google" || provider === "github"
      ? `/auth/${provider}/login`
      : "/login";
  const params = new URLSearchParams({ cli: "1", redirect_uri: redirectUri });
  return `${apiUrl.replace(/\/+$/, "")}${loginPath}?${params}`;
}

export async function openBrowser(url) {
  if (process.env.OPEN_ARTIFACTS_NO_BROWSER === "1") {
    console.error(`open: ${url}`);
    return;
  }
  const platform = process.platform;
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  await execFileAsync(command, args);
}

export async function startOAuthCallbackServer(preferredPort) {
  return new Promise((resolve, reject) => {
    /** @type {(code: string) => void} */
    let resolveCode = () => {};
    /** @type {Promise<string>} */
    const codePromise = new Promise((resolveCodePromise) => {
      resolveCode = resolveCodePromise;
    });
    const server = createServer((request_, response) => {
      const url = new URL(request_.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        response.writeHead(404);
        response.end();
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        response.writeHead(400, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("missing code");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body><p>Login complete. You can close this tab.</p></body></html>",
      );
      server.close();
      resolveCode(code);
    });
    server.on("error", reject);
    server.listen(preferredPort ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not bind loopback callback server"));
        return;
      }
      resolve({
        port: address.port,
        code: codePromise,
        close: () => server.close(),
      });
    });
  });
}

export async function commandLogin(flags) {
  const config = loadConfig(flags);
  const provider = flags.provider ?? null;
  if (provider !== null && provider !== "google" && provider !== "github") {
    throw new Error('login --provider must be "google" or "github" when set');
  }
  const preferredPort = flags.port ? Number(flags.port) : undefined;
  if (preferredPort !== undefined && !Number.isInteger(preferredPort)) {
    throw new Error("login --port must be an integer");
  }
  const callback = await startOAuthCallbackServer(preferredPort);
  const redirectUri = `http://127.0.0.1:${callback.port}/callback`;
  const loginUrl = buildCliLoginUrl(config.apiUrl, provider, redirectUri);
  console.error(
    "login requires a SaaS instance with OAuth and /api/keys/exchange enabled",
  );
  console.error(`opening ${loginUrl}`);
  await openBrowser(loginUrl);
  const loginTimeoutMs = Number(process.env.OPEN_ARTIFACTS_LOGIN_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(loginTimeoutMs) && loginTimeoutMs > 0
      ? loginTimeoutMs
      : 10 * 60 * 1000;
  let timeoutId;
  let code;
  try {
    code = await Promise.race([
      callback.code,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () =>
            reject(new Error("login timed out waiting for browser callback")),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    callback.close();
    throw error instanceof Error ? error : new Error("login cancelled");
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
  const { status, json } = await request(
    "POST",
    `${config.apiUrl}/api/keys/exchange`,
    { code },
  );
  if (status !== 200 && status !== 201) {
    throw new Error(
      `login failed (${status}): ${json.error ?? "exchange endpoint unavailable on this instance"}`,
    );
  }
  const apiKey = json.apiKey ?? json.key;
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error(
      "login failed: exchange response did not include an apiKey",
    );
  }
  mutateCredentials((credentials) => {
    credentials.apiKey = apiKey;
  });
  console.error("logged in; API key stored in credentials.json");
}

export function commandLogout() {
  mutateCredentials((credentials) => {
    delete credentials.apiKey;
  });
  console.error("logged out; removed stored API key");
}

export async function commandWhoami(flags) {
  const config = loadConfig(flags);
  const token = resolveAuthToken(flags);
  const sk = token?.startsWith("sk_") ? token : loadCredentials().apiKey;
  if (!sk?.startsWith("sk_")) {
    throw new Error(
      "not logged in; run the CLI's `login` command on a SaaS instance first",
    );
  }
  const { status, json } = await request(
    "GET",
    `${config.apiUrl}/api/me`,
    undefined,
    sk,
  );
  if (status !== 200) {
    throw new Error(
      `whoami failed (${status}): ${json.error ?? "unknown error"}`,
    );
  }
  console.log(json.login ?? json.email ?? json.id ?? "unknown");
}
