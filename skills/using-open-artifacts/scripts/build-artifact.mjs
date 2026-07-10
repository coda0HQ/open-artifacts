#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { composeRecipe } from "./lib/compose.mjs";
import { loadRecipe } from "./lib/recipe.mjs";
import { validateBuild } from "./lib/validate.mjs";

export function buildArtifactRecipe(recipePath, options = {}) {
  const loaded = loadRecipe(recipePath, {
    projectRoot: options.projectRoot ?? process.cwd(),
  });
  const composed = composeRecipe(loaded, {
    standalone: options.standalone === true,
  });
  const validation = validateBuild(loaded, composed);
  return { loaded, ...composed, validation };
}

function assertOutputIsSafe(result, outputPath) {
  const absolute = resolve(outputPath);
  if (absolute === result.loaded.realPath) {
    throw new Error("preview output cannot overwrite the recipe");
  }
  if (existsSync(absolute)) {
    const real = realpathSync(absolute);
    const outputStat = statSync(real);
    const protectedFiles = [
      {
        path: result.loaded.realPath,
        message: "preview output cannot overwrite the recipe",
      },
      ...result.loaded.descriptors.map((descriptor) => ({
        path: descriptor.real,
        message: "preview output cannot overwrite a fragment",
      })),
    ];
    for (const protectedFile of protectedFiles) {
      const protectedStat = statSync(protectedFile.path);
      if (
        real === protectedFile.path ||
        (outputStat.dev === protectedStat.dev &&
          outputStat.ino === protectedStat.ino)
      ) {
        throw new Error(protectedFile.message);
      }
    }
  } else if (
    result.loaded.descriptors.some(
      (descriptor) => descriptor.absolute === absolute,
    )
  ) {
    throw new Error("preview output cannot overwrite a fragment");
  }
  return absolute;
}

export function writeArtifactPreview(result, outputPath) {
  const output = assertOutputIsSafe(result, outputPath);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, result.content);
  return output;
}

export function recipeBuildSummary(result) {
  return {
    recipe: result.loaded.projectPath,
    strategy: result.plan.strategy,
    format: result.loaded.recipe.artifact.format,
    canvas: result.loaded.recipe.artifact.canvas,
    fragments: result.plan.fragments.length,
    inputBytes: result.plan.aggregateBytes,
    outputBytes: result.validation.bytes,
    recipeHash: `sha256:${result.loaded.recipeHash}`,
    inputHash: `sha256:${result.inputHash}`,
    outputHash: `sha256:${result.outputHash}`,
  };
}

function printSummary(result) {
  console.log(JSON.stringify(recipeBuildSummary(result), null, 2));
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      standalone: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const [command, recipePath] = positionals;
  if (values.help || !command) {
    console.log(`usage: build-artifact.mjs <validate|build> <recipe.json> [options]

commands:
  validate <recipe>             validate and compose without writing
  build <recipe> --output <p>   write an explicit preview/export

options:
  --output, -o <path>           required for build
  --standalone                  wrap HTML output for file:// preview`);
    return;
  }
  if (!recipePath) throw new Error(`${command} requires a recipe path`);
  if (command !== "validate" && command !== "build") {
    throw new Error(`unknown command: ${command}`);
  }
  const result = buildArtifactRecipe(recipePath, {
    standalone: command === "build" && values.standalone === true,
  });
  if (command === "build") {
    if (!values.output) throw new Error("build requires --output <path>");
    const output = writeArtifactPreview(result, values.output);
    console.error(
      `built ${relative(process.cwd(), output) || output} (${Buffer.byteLength(result.content)} bytes)`,
    );
  }
  printSummary(result);
}

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
