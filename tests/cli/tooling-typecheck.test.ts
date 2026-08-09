import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function readCliProject() {
  const configPath = join(root, "tsconfig.cli.json");
  const source = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(source.error).toBeUndefined();
  return ts.parseJsonConfigFileContent(source.config, ts.sys, root);
}

describe("CLI TypeScript project", () => {
  it("checks every executable MJS source", () => {
    const project = readCliProject();

    expect(project.options.allowJs).toBe(true);
    expect(project.options.checkJs).toBe(true);

    const files = project.fileNames.map((path) => path.replaceAll("\\", "/"));
    expect(
      files.some((path) =>
        path.endsWith("/skills/using-open-artifacts/scripts/artifact.mjs"),
      ),
    ).toBe(true);
    expect(
      files.some((path) =>
        path.endsWith("/skills/using-open-artifacts/scripts/lib/compose.mjs"),
      ),
    ).toBe(true);
  });

  it("rejects a bad call using the CLI project settings", () => {
    const project = readCliProject();
    const directory = mkdtempSync(join(tmpdir(), "oa-cli-typecheck-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "bad-call.mjs");
    writeFileSync(
      sourcePath,
      '/** @param {number} value */\nexport function twice(value) { return value * 2; }\ntwice("not-a-number");\n',
    );

    const program = ts.createProgram({
      rootNames: [sourcePath],
      options: { ...project.options, noEmit: true },
    });
    const messages = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      );

    expect(messages.some((message) => message.includes("not assignable"))).toBe(
      true,
    );
  });
});
