export const REACT_MOUNT_ID: string;
export function assertPrecompilable(source: string): void;
export function bundleReactComponent(
  entryRealPath: string,
  source: string,
): { code: string; warnings: string[] };
