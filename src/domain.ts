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

// Anchor caps. Quote/context are code-point lengths (a selection is measured in
// characters); the whole-anchor cap is UTF-8 bytes so a multibyte quote that
// passes the code-point cap can still be rejected before it reaches storage.
export const MAX_COMMENT_QUOTE_LENGTH = 1000;
export const MAX_COMMENT_QUOTE_CONTEXT_LENGTH = 32;
export const MAX_ANCHOR_BYTES = 2 * 1024;
export const CURRENT_ANCHOR_VERSION = 1;

// A comment's anchor: null = unanchored (page-level; Phase-1 back-compat),
// "point" = a canvas world coordinate, "text" = a W3C-style quote selector.
// The viewer re-resolves the anchor at render time; the server stores it verbatim.
export type Anchor =
  | { mode: "point"; x: number; y: number; anchorVersion: number }
  | {
      mode: "text";
      quote: string;
      prefix: string;
      suffix: string;
      start: number;
      anchorVersion: number;
    };

export interface CommentMeta {
  id: string;
  artifactId: string;
  author: string | null;
  body: string;
  anchor: Anchor | null;
  /** Resolved / acknowledged — soft state, not deletion. */
  done: boolean;
  createdAt: string;
}

export interface CommentInput {
  author: string | null;
  body: string;
  anchor: Anchor | null;
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
  maxContentBytes: number = MAX_CONTENT_BYTES,
): Validated<CommonFields> {
  const { content, format, encrypted, label, description, title, favicon } =
    body;

  if (typeof content !== "string" || content.length === 0) {
    return invalid("content is required and must be a non-empty string");
  }
  if (contentByteLength(content) > maxContentBytes) {
    return invalid(`content exceeds the ${maxContentBytes} byte limit`, 413);
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
  maxContentBytes: number = MAX_CONTENT_BYTES,
): Validated<CreateInput> {
  const common = validateCommon(body, maxContentBytes);
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
  maxContentBytes: number = MAX_CONTENT_BYTES,
): Validated<UpdateInput> {
  const common = validateCommon(body, maxContentBytes);
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

// Anchor validation, mirroring validateEncryption's shape. Point coordinates
// are unbounded world px (a canvas point can be negative or large) so only
// finiteness is enforced; text selectors are length-capped, and the whole
// serialized anchor is byte-capped so a multibyte quote cannot slip past.
function validateAnchorVersion(raw: unknown): number | null {
  if (raw === undefined || raw === null) return CURRENT_ANCHOR_VERSION;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return null;
  return raw;
}

export function validateAnchor(raw: unknown): Validated<Anchor> {
  if (typeof raw !== "object" || raw === null)
    return invalid("anchor must be an object");
  const obj = raw as Record<string, unknown>;
  const anchorVersion = validateAnchorVersion(obj.anchorVersion);
  if (anchorVersion === null)
    return invalid("anchor.anchorVersion must be a positive integer");

  let value: Anchor;
  if (obj.mode === "point") {
    const { x, y } = obj;
    if (typeof x !== "number" || !Number.isFinite(x))
      return invalid("anchor.x must be a finite number");
    if (typeof y !== "number" || !Number.isFinite(y))
      return invalid("anchor.y must be a finite number");
    value = { mode: "point", x, y, anchorVersion };
  } else if (obj.mode === "text") {
    const { quote, prefix, suffix, start } = obj;
    if (typeof quote !== "string" || quote.length === 0)
      return invalid("anchor.quote is required");
    if ([...quote].length > MAX_COMMENT_QUOTE_LENGTH)
      return invalid(
        `anchor.quote exceeds ${MAX_COMMENT_QUOTE_LENGTH} characters`,
      );
    const ctx = (v: unknown): string | null => {
      if (v === undefined || v === null) return "";
      if (typeof v !== "string") return null;
      return [...v].length > MAX_COMMENT_QUOTE_CONTEXT_LENGTH ? null : v;
    };
    const parsedPrefix = ctx(prefix);
    const parsedSuffix = ctx(suffix);
    if (parsedPrefix === null || parsedSuffix === null)
      return invalid(
        `anchor.prefix/suffix must be strings of at most ${MAX_COMMENT_QUOTE_CONTEXT_LENGTH} characters`,
      );
    let parsedStart = 0;
    if (start !== undefined && start !== null) {
      if (typeof start !== "number" || !Number.isInteger(start) || start < 0)
        return invalid("anchor.start must be a non-negative integer");
      parsedStart = start;
    }
    value = {
      mode: "text",
      quote,
      prefix: parsedPrefix,
      suffix: parsedSuffix,
      start: parsedStart,
      anchorVersion,
    };
  } else {
    return invalid('anchor.mode must be "point" or "text"');
  }

  if (contentByteLength(JSON.stringify(value)) > MAX_ANCHOR_BYTES)
    return invalid(`anchor exceeds the ${MAX_ANCHOR_BYTES} byte limit`);
  return { ok: true, value };
}

// Comment authoring validation. `body` is required and size-capped in UTF-8
// bytes (matching the content cap convention); `author` is optional and
// length-capped; `anchor` is optional (null = unanchored). Open for Phase 1:
// posting is not token-gated, documented at the route.
export function validateComment(
  body: Record<string, unknown>,
): Validated<CommentInput> {
  const { body: text, author, anchor } = body;

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

  let parsedAnchor: Anchor | null = null;
  if (anchor !== undefined && anchor !== null) {
    const result = validateAnchor(anchor);
    if (!result.ok) return result;
    parsedAnchor = result.value;
  }

  return {
    ok: true,
    value: { author: parsedAuthor, body: text, anchor: parsedAnchor },
  };
}
