export type ArtifactFormat = "html" | "markdown";

export const MAX_CONTENT_BYTES = 4 * 1024 * 1024;
export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_LABEL_LENGTH = 60;
export const MIN_KDF_ITERATIONS = 1_000;
export const MAX_KDF_ITERATIONS = 10_000_000;

export interface EncryptionParams {
  salt: string;
  iv: string;
  iterations: number;
}

export interface CreateInput {
  content: string;
  format: ArtifactFormat;
  title: string;
  description: string;
  favicon: string;
  label: string | null;
  encrypted: EncryptionParams | null;
}

export interface UpdateInput {
  content: string;
  format: ArtifactFormat | null;
  title: string | null;
  description: string | null;
  favicon: string | null;
  label: string | null;
  encrypted: EncryptionParams | null;
  baseVersion: number | null;
  force: boolean;
}

export interface ArtifactMeta {
  id: string;
  title: string;
  description: string;
  favicon: string;
  format: ArtifactFormat;
  encrypted: boolean;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface VersionMeta {
  version: number;
  label: string | null;
  title: string;
  description: string;
  favicon: string;
  format: ArtifactFormat;
  encrypted: boolean;
  size: number;
  createdAt: string;
}

// Comments live outside the sandboxed artifact body (in the surrounding chrome)
// and persist to D1 so a thread survives disconnects and reaches future viewers.
export const MAX_COMMENT_BODY_BYTES = 8 * 1024;
export const MAX_COMMENT_AUTHOR_LENGTH = 200;

export interface CommentMeta {
  id: string;
  artifactId: string;
  author: string | null;
  body: string;
  createdAt: string;
}

export interface CommentInput {
  author: string | null;
  body: string;
}

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; status: 400 | 413 };

const invalid = (
  error: string,
  status: 400 | 413 = 400,
): { ok: false; error: string; status: 400 | 413 } => ({
  ok: false,
  error,
  status,
});

const EMOJI_GRAPHEME = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function isEmojiFavicon(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const segments = [
    ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value),
  ];
  if (segments.length < 1 || segments.length > 2) return false;
  return segments.every((s) => EMOJI_GRAPHEME.test(s.segment));
}

export function contentByteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

export function extractTitle(
  content: string,
  format: ArtifactFormat,
): string | null {
  if (format === "html") {
    const match = content.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = match?.[1].trim();
    return title ? title : null;
  }
  const heading = content.match(/^#\s+(.+)$/m);
  const title = heading?.[1].trim();
  return title ? title : null;
}

function validateEncryption(raw: unknown): Validated<EncryptionParams> {
  if (typeof raw !== "object" || raw === null)
    return invalid("encrypted must be an object");
  const { salt, iv, iterations } = raw as Record<string, unknown>;
  if (typeof salt !== "string" || !BASE64.test(salt) || salt.length % 4 !== 0) {
    return invalid("encrypted.salt must be base64");
  }
  if (typeof iv !== "string" || !BASE64.test(iv) || iv.length % 4 !== 0) {
    return invalid("encrypted.iv must be base64");
  }
  if (
    typeof iterations !== "number" ||
    !Number.isInteger(iterations) ||
    iterations < MIN_KDF_ITERATIONS ||
    iterations > MAX_KDF_ITERATIONS
  ) {
    return invalid(
      `encrypted.iterations must be an integer between ${MIN_KDF_ITERATIONS} and ${MAX_KDF_ITERATIONS}`,
    );
  }
  return { ok: true, value: { salt, iv, iterations } };
}

interface CommonFields {
  content: string;
  format: ArtifactFormat;
  encrypted: EncryptionParams | null;
  label: string | null;
  description: string | null;
  title: string | null;
  favicon: string | null;
}

function validateCommon(
  body: Record<string, unknown>,
): Validated<CommonFields> {
  const { content, format, encrypted, label, description, title, favicon } =
    body;

  if (typeof content !== "string" || content.length === 0) {
    return invalid("content is required and must be a non-empty string");
  }
  if (contentByteLength(content) > MAX_CONTENT_BYTES) {
    return invalid(`content exceeds the ${MAX_CONTENT_BYTES} byte limit`, 413);
  }

  let parsedFormat: ArtifactFormat = "html";
  if (format !== undefined) {
    if (format !== "html" && format !== "markdown") {
      return invalid('format must be "html" or "markdown"');
    }
    parsedFormat = format;
  }

  let parsedEncrypted: EncryptionParams | null = null;
  if (encrypted !== undefined && encrypted !== null) {
    const result = validateEncryption(encrypted);
    if (!result.ok) return result;
    if (!BASE64.test(content) || content.length % 4 !== 0) {
      return invalid("content must be base64 ciphertext when encrypted");
    }
    parsedEncrypted = result.value;
  }

  if (label !== undefined && label !== null) {
    if (typeof label !== "string" || label.length > MAX_LABEL_LENGTH) {
      return invalid(
        `label must be a string of at most ${MAX_LABEL_LENGTH} characters`,
      );
    }
  }
  if (description !== undefined && description !== null) {
    if (
      typeof description !== "string" ||
      description.length > MAX_DESCRIPTION_LENGTH
    ) {
      return invalid(
        `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
      );
    }
  }
  if (title !== undefined && title !== null) {
    if (
      typeof title !== "string" ||
      title.length === 0 ||
      title.length > MAX_TITLE_LENGTH
    ) {
      return invalid(
        `title must be a non-empty string of at most ${MAX_TITLE_LENGTH} characters`,
      );
    }
  }
  if (
    favicon !== undefined &&
    favicon !== null &&
    !isEmojiFavicon(favicon as string)
  ) {
    return invalid("favicon must be one or two emoji");
  }

  return {
    ok: true,
    value: {
      content,
      format: parsedFormat,
      encrypted: parsedEncrypted,
      label: (label as string | undefined) ?? null,
      description: (description as string | undefined) ?? null,
      title: (title as string | undefined) ?? null,
      favicon: (favicon as string | undefined) ?? null,
    },
  };
}

export function validateCreate(
  body: Record<string, unknown>,
): Validated<CreateInput> {
  const common = validateCommon(body);
  if (!common.ok) return common;
  const { content, format, encrypted, label, description } = common.value;

  const favicon = common.value.favicon;
  if (favicon === null)
    return invalid("favicon is required (one or two emoji)");

  let title = common.value.title;
  if (title === null && encrypted === null)
    title = extractTitle(content, format);
  if (title === null) {
    return invalid(
      "title is required (or include a <title> tag / markdown heading in the content)",
    );
  }

  return {
    ok: true,
    value: {
      content,
      format,
      title,
      description: description ?? "",
      favicon,
      label,
      encrypted,
    },
  };
}

export function validateUpdate(
  body: Record<string, unknown>,
): Validated<UpdateInput> {
  const common = validateCommon(body);
  if (!common.ok) return common;

  const { baseVersion, force } = body;
  let parsedBase: number | null = null;
  if (baseVersion !== undefined && baseVersion !== null) {
    if (
      typeof baseVersion !== "number" ||
      !Number.isInteger(baseVersion) ||
      baseVersion < 1
    ) {
      return invalid("baseVersion must be a positive integer");
    }
    parsedBase = baseVersion;
  }
  if (force !== undefined && typeof force !== "boolean") {
    return invalid("force must be a boolean");
  }

  return {
    ok: true,
    value: {
      content: common.value.content,
      format: body.format === undefined ? null : common.value.format,
      title: common.value.title,
      description: common.value.description,
      favicon: common.value.favicon,
      label: common.value.label,
      encrypted: common.value.encrypted,
      baseVersion: parsedBase,
      force: force === true,
    },
  };
}

// Comment authoring validation. `body` is required and size-capped in UTF-8
// bytes (matching the content cap convention); `author` is optional and
// length-capped. Open for Phase 1: posting is not token-gated, documented at
// the route. Moderation/deletion is out of scope here (see issue #5).
export function validateComment(
  body: Record<string, unknown>,
): Validated<CommentInput> {
  const { body: text, author } = body;

  if (typeof text !== "string" || text.length === 0) {
    return invalid("body is required and must be a non-empty string");
  }
  if (contentByteLength(text) > MAX_COMMENT_BODY_BYTES) {
    return invalid(
      `body exceeds the ${MAX_COMMENT_BODY_BYTES} byte limit`,
      413,
    );
  }

  let parsedAuthor: string | null = null;
  if (author !== undefined && author !== null) {
    if (
      typeof author !== "string" ||
      author.length > MAX_COMMENT_AUTHOR_LENGTH
    ) {
      return invalid(
        `author must be a string of at most ${MAX_COMMENT_AUTHOR_LENGTH} characters`,
      );
    }
    parsedAuthor = author;
  }

  return { ok: true, value: { author: parsedAuthor, body: text } };
}
