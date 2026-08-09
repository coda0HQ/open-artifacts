export const CURRENT_SCHEMA_VERSION = 5;

export class SchemaCompatibilityError extends Error {
  readonly code = "SCHEMA_INCOMPATIBLE";

  constructor(
    readonly actualVersion: number,
    readonly expectedVersion: number = CURRENT_SCHEMA_VERSION,
  ) {
    super(
      `database schema ${actualVersion} is incompatible with application schema ${expectedVersion}; apply migrations before serving traffic`,
    );
    this.name = "SchemaCompatibilityError";
  }
}

export function assertSchemaCompatibility(
  actualVersion: number,
  expectedVersion: number = CURRENT_SCHEMA_VERSION,
): void {
  if (actualVersion !== expectedVersion) {
    throw new SchemaCompatibilityError(actualVersion, expectedVersion);
  }
}

export async function readSchemaVersion(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare("SELECT version FROM schema_meta WHERE singleton = 1")
      .first<{ version: number }>();
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}

export async function validateSchemaCompatibility(
  db: D1Database,
): Promise<void> {
  assertSchemaCompatibility(await readSchemaVersion(db));
}
