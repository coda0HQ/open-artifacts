const ID_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const ID_LENGTH = 12;

export function generateId(): string {
  const chars: string[] = [];
  while (chars.length < ID_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH * 2));
    for (const byte of bytes) {
      // Rejection sampling: 232 = 4 * 58 keeps the distribution uniform.
      if (byte >= 232) continue;
      chars.push(ID_ALPHABET[byte % ID_ALPHABET.length]);
      if (chars.length === ID_LENGTH) break;
    }
  }
  return chars.join("");
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function generateWriteToken(): string {
  return `wt_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function generateChannelToken(): string {
  return `ch_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function looksLikeChannelToken(value: string): boolean {
  return value.startsWith("ch_");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}
