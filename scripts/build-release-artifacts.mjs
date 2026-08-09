#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** @param {string | Buffer | Uint8Array} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} directory @param {string} root */
async function listFiles(directory, root = directory) {
  const output = [];
  for (const name of (await readdir(directory)).sort()) {
    const absolute = join(directory, name);
    const details = await stat(absolute);
    if (details.isDirectory())
      output.push(...(await listFiles(absolute, root)));
    else if (details.isFile())
      output.push(relative(root, absolute).split(sep).join("/"));
  }
  return output;
}

/** @param {string} root */
async function latestSchemaVersion(root) {
  const versions = (await readdir(join(root, "migrations")))
    .map((name) => Number(name.match(/^(\d+)_.*\.sql$/)?.[1] ?? -1))
    .filter((version) => Number.isInteger(version) && version >= 0);
  if (versions.length === 0) throw new Error("no numbered migrations found");
  return Math.max(...versions);
}

/** @param {string} root @param {string} commit */
function assertCommittedSource(root, commit) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (head.status !== 0 || head.stdout.trim() !== commit) {
    throw new Error("release commit must match the checked-out Git HEAD");
  }
  for (const arguments_ of [
    ["diff", "--quiet"],
    ["diff", "--cached", "--quiet"],
  ]) {
    const result = spawnSync("git", arguments_, { cwd: root });
    if (result.status !== 0) {
      throw new Error(
        "release artifacts cannot be built from modified tracked files",
      );
    }
  }
}

/**
 * @param {{
 *   root: string,
 *   bundleDirectory: string,
 *   outputDirectory: string,
 *   commit: string,
 *   sourceDateEpoch: number,
 *   requireClean?: boolean
 * }} input
 */
export async function buildReleaseArtifacts(input) {
  if (!/^[0-9a-f]{40}$/i.test(input.commit)) {
    throw new Error("release requires a full 40-character commit SHA");
  }
  if (!Number.isInteger(input.sourceDateEpoch) || input.sourceDateEpoch < 0) {
    throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer");
  }
  if (input.requireClean) assertCommittedSource(input.root, input.commit);

  const packageJson = JSON.parse(
    await readFile(join(input.root, "package.json"), "utf8"),
  );
  const lockfile = await readFile(join(input.root, "pnpm-lock.yaml"));
  const protocolCatalog = await readFile(
    join(input.root, "tests/snapshots/protocol/v1/catalog.json"),
  );
  const viewerRuntime = await readFile(
    join(input.root, "src/generated/viewer-runtime.ts"),
  );
  const bundlePaths = await listFiles(input.bundleDirectory);
  if (bundlePaths.length === 0) throw new Error("Worker bundle is empty");
  const bundleFiles = [];
  for (const path of bundlePaths) {
    const bytes = await readFile(join(input.bundleDirectory, path));
    bundleFiles.push({ path, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  const schemaVersion = await latestSchemaVersion(input.root);
  const builtAt = new Date(input.sourceDateEpoch * 1000).toISOString();
  const nodeVersion = (
    await readFile(join(input.root, ".node-version"), "utf8")
  ).trim();
  const manifest = {
    schemaVersion,
    commit: input.commit.toLowerCase(),
    builtAt,
    reproducible: true,
    sourceDateEpoch: input.sourceDateEpoch,
    package: { name: packageJson.name, version: packageJson.version },
    toolchain: {
      node: nodeVersion,
      pnpm: String(packageJson.packageManager).replace(/^pnpm@/, ""),
      wrangler: packageJson.devDependencies.wrangler,
    },
    inputs: {
      lockfileSha256: sha256(lockfile),
      protocolCatalogSha256: sha256(protocolCatalog),
      viewerRuntimeSha256: sha256(viewerRuntime),
    },
    bundle: { files: bundleFiles },
  };

  const dependencyComponents = Object.entries(packageJson.dependencies ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, version]) => ({
      type: "library",
      name,
      version: String(version),
      purl: `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(String(version))}`,
    }));
  const bundleComponents = bundleFiles.map((file) => ({
    type: "file",
    name: basename(file.path),
    properties: [{ name: "open-artifacts:bundle-path", value: file.path }],
    hashes: [{ alg: "SHA-256", content: file.sha256 }],
  }));
  const serial = input.commit.slice(0, 32).toLowerCase();
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${serial.slice(0, 8)}-${serial.slice(8, 12)}-${serial.slice(12, 16)}-${serial.slice(16, 20)}-${serial.slice(20)}`,
    version: 1,
    metadata: {
      timestamp: builtAt,
      component: {
        type: "application",
        name: packageJson.name,
        version: packageJson.version,
        properties: [
          {
            name: "open-artifacts:git-commit",
            value: input.commit.toLowerCase(),
          },
          {
            name: "open-artifacts:schema-version",
            value: String(schemaVersion),
          },
        ],
      },
    },
    components: [...dependencyComponents, ...bundleComponents],
  };
  const provenance = {
    _type: "https://in-toto.io/Statement/v1",
    subject: bundleFiles.map((file) => ({
      name: `worker/${file.path}`,
      digest: { sha256: file.sha256 },
    })),
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType:
          "https://github.com/open-artifacts-foundation/worker-release@v1",
        externalParameters: {
          commit: input.commit.toLowerCase(),
          schemaVersion,
          sourceDateEpoch: input.sourceDateEpoch,
        },
        resolvedDependencies: [
          { uri: "pnpm-lock.yaml", digest: { sha256: sha256(lockfile) } },
        ],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner" },
        metadata: { invocationId: input.commit.toLowerCase() },
      },
    },
  };

  await mkdir(input.outputDirectory, { recursive: true });
  const documents = {
    "provenance.json": `${JSON.stringify(provenance, null, 2)}\n`,
    "release-manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "sbom.cdx.json": `${JSON.stringify(sbom, null, 2)}\n`,
  };
  for (const [name, contents] of Object.entries(documents)) {
    await writeFile(join(input.outputDirectory, name), contents);
  }
  const checksums = [
    ...Object.entries(documents).map(([name, contents]) => ({
      name,
      digest: sha256(contents),
    })),
    ...bundleFiles.map((file) => ({
      name: `worker/${file.path}`,
      digest: file.sha256,
    })),
  ]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => `${entry.digest}  ${entry.name}`)
    .join("\n");
  await writeFile(join(input.outputDirectory, "SHA256SUMS"), `${checksums}\n`);
  return manifest;
}

/** @param {string[]} argv */
function parseArguments(argv) {
  const values = { requireClean: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--require-clean") {
      values.requireClean = true;
      continue;
    }
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`invalid release argument near ${flag ?? "end"}`);
    }
    values[flag.slice(2)] = value;
    index += 1;
  }
  for (const name of ["bundle", "out", "commit", "source-date-epoch"]) {
    if (!values[name]) throw new Error(`--${name} is required`);
  }
  return values;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const values = parseArguments(process.argv.slice(2));
    const manifest = await buildReleaseArtifacts({
      root: process.cwd(),
      bundleDirectory: String(values.bundle),
      outputDirectory: String(values.out),
      commit: String(values.commit),
      sourceDateEpoch: Number(values["source-date-epoch"]),
      requireClean: Boolean(values.requireClean),
    });
    process.stdout.write(
      `Release metadata: schema v${manifest.schemaVersion}, ${manifest.bundle.files.length} bundle files.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
