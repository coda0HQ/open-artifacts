import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".artifacts",
  ".wrangler",
  "node_modules",
  "playwright-report",
  "test-results",
  "vendor",
]);

function markdownFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        files.push(...markdownFiles(resolve(directory, entry.name)));
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(resolve(directory, entry.name));
    }
  }
  return files;
}

function localTarget(raw) {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1);
  } else {
    target = target.split(/\s+["']/)[0];
  }
  if (
    target === "" ||
    target.startsWith("#") ||
    target.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(target)
  ) {
    return null;
  }
  return decodeURIComponent(target.split("#")[0].split("?")[0]);
}

export function findBrokenMarkdownLinks(root) {
  const broken = [];
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const file of markdownFiles(root)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(pattern)) {
      const target = localTarget(match[1]);
      if (!target) continue;
      let destination = resolve(dirname(file), target);
      if (existsSync(destination) && statSync(destination).isDirectory()) {
        destination = resolve(destination, "README.md");
      }
      if (!existsSync(destination)) {
        const line = source.slice(0, match.index).split("\n").length;
        broken.push({ file, line, target });
      }
    }
  }
  return broken;
}
