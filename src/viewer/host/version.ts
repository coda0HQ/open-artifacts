import type { VersionMeta } from "../../domain";

export interface VersionOption {
  version: number;
  label: string;
  title: string | null;
  target: string;
  selected: boolean;
}

export function versionOptions(
  versions: readonly VersionMeta[],
  currentVersion: number,
  requestUrl: string,
): VersionOption[] {
  const base = new URL(requestUrl, "https://placeholder.local");
  return versions.map((version) => {
    const target = new URL(base);
    target.searchParams.set("v", String(version.version));
    return {
      version: version.version,
      label: `v${version.version}`,
      title: version.label || null,
      target: `${target.pathname}?${target.searchParams.toString()}`,
      selected: version.version === currentVersion,
    };
  });
}

export function selectedVersionTarget(
  options: readonly VersionOption[],
  rawVersion: string,
): string | null {
  const version = Number(rawVersion);
  if (!Number.isInteger(version)) return null;
  return options.find((option) => option.version === version)?.target ?? null;
}
