import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findBrokenMarkdownLinks } from "./lib/docs-links.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const broken = findBrokenMarkdownLinks(root);
if (broken.length > 0) {
  for (const link of broken) {
    console.error(
      `${relative(root, link.file)}:${link.line}: missing ${link.target}`,
    );
  }
  process.exitCode = 1;
} else {
  console.log("Markdown local links verified");
}
