#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

const explicit = process.argv.slice(2).filter((arg) => arg !== "--");
const binaryExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".woff2",
  ".wasm",
  ".pdf",
  ".zip",
]);

function repositoryFiles() {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || "git ls-files failed");
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

const files = explicit.length > 0 ? explicit : repositoryFiles();
const patterns = [
  {
    name: "OpenAI API key",
    expression: new RegExp(
      ["(?<![A-Za-z0-9])", "sk", "-(?:proj-)?", "[A-Za-z0-9_-]{24,}"].join(""),
      "g",
    ),
  },
  {
    name: "GitHub token",
    expression: new RegExp(
      ["gh", "[pousr]_", "[A-Za-z0-9]{30,}"].join(""),
      "g",
    ),
  },
  {
    name: "AWS access key",
    expression: new RegExp(["AK", "IA", "[A-Z0-9]{16}"].join(""), "g"),
  },
  {
    name: "private key block",
    expression: new RegExp(
      ["-----BEGIN ", "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----"].join(""),
      "g",
    ),
  },
];

const findings = [];
for (const file of files) {
  const absolute = resolve(file);
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;
  if (binaryExtensions.has(extname(file).toLowerCase())) continue;
  const content = readFileSync(absolute, "utf8");
  for (const pattern of patterns) {
    pattern.expression.lastIndex = 0;
    if (pattern.expression.test(content))
      findings.push(`${file}: ${pattern.name}`);
  }
  if (/(?:manifest|recipe).*\.json$/i.test(file)) {
    try {
      const document = JSON.parse(content);
      const pending = [document];
      while (pending.length > 0) {
        const value = pending.pop();
        if (!value || typeof value !== "object") continue;
        for (const [key, child] of Object.entries(value)) {
          if (
            /^(?:writeToken|deleteToken|accessToken|apiKey|secret)$/i.test(key)
          ) {
            findings.push(`${file}: forbidden secret field ${key}`);
          }
          pending.push(child);
        }
      }
    } catch {
      // Syntax validation belongs to the manifest/recipe validators.
    }
  }
}

if (explicit.length === 0) {
  const exceptionsPath = resolve("docs/security/dependency-exceptions.json");
  const exceptions = JSON.parse(readFileSync(exceptionsPath, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  for (const exception of exceptions) {
    if (typeof exception.expires !== "string" || exception.expires < today) {
      findings.push(
        `docs/security/dependency-exceptions.json: expired or invalid exception ${exception.id ?? "unknown"}`,
      );
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(
    `Secret/dependency policy scan failed:\n${findings.join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Secret/dependency policy scan passed (${files.length} files).\n`,
  );
}
