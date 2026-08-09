import type { RequestContext } from "../request-context";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "token",
  "writetoken",
  "apikey",
  "secret",
  "content",
  "body",
  "ciphertext",
  "idempotencykey",
]);
const SECRET_VALUE = /Bearer\s+[^\s"']+|\b(?:sk|wt|ch|dt)_[A-Za-z0-9_-]+/gi;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[^a-z]/g, "");
  return (
    SENSITIVE_KEYS.has(normalized) ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token")
  );
}

function scrubString(value: string): string {
  return value.replace(SECRET_VALUE, "[REDACTED]").slice(0, 4_096);
}

function sanitizeValue(
  value: unknown,
  depth: number,
  seen: Set<object>,
): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "bigint") return String(value);
  if (value instanceof Error) {
    return {
      name: scrubString(value.name),
      message: scrubString(value.message),
    };
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item) => sanitizeValue(item, depth + 1, seen));
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    output[key] = isSensitiveKey(key)
      ? "[REDACTED]"
      : sanitizeValue(item, depth + 1, seen);
  }
  seen.delete(value);
  return output;
}

export function sanitizeLogFields(fields: LogFields): LogFields {
  return sanitizeValue(fields, 0, new Set()) as LogFields;
}

export class StructuredLogger {
  constructor(
    private readonly context: RequestContext,
    private readonly environment: string,
    private readonly sink: LogSink = (line) => console.log(line),
    private readonly fixedFields: LogFields = {},
  ) {}

  child(fields: LogFields): StructuredLogger {
    return new StructuredLogger(this.context, this.environment, this.sink, {
      ...this.fixedFields,
      ...fields,
    });
  }

  debug(event: string, fields: LogFields = {}): void {
    this.write("debug", event, fields);
  }

  info(event: string, fields: LogFields = {}): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.write("error", event, fields);
  }

  private write(level: LogLevel, event: string, fields: LogFields): void {
    const record = sanitizeLogFields({
      timestamp: new Date().toISOString(),
      level,
      event: event.slice(0, 128),
      environment: this.environment.slice(0, 32),
      ...this.context,
      ...this.fixedFields,
      ...fields,
    });
    this.sink(JSON.stringify(record));
  }
}
